//! Working-tree watcher.
//! Changes are batched and surfaced to the UI as a single `repo-changed` event.
//!
//! A batch ends after 400 ms without events, or 1.5 s after it started so a long stream of
//! writes (a build, `npm install`) still refreshes regularly. Batches whose working-tree paths
//! are all ignored by git (`git check-ignore`, so nested .gitignore files, info/exclude and the
//! global excludes all apply) don't trigger a refresh.

use crate::git::{self, Ctx};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const QUIET: Duration = Duration::from_millis(400);
const MAX_WAIT: Duration = Duration::from_millis(1500);
/// Past this many changed paths, skip the ignore check and just refresh.
const MAX_PATHS: usize = 20_000;

pub struct RepoWatcher {
    _watcher: RecommendedWatcher,
}

/// Git's own churn that never changes what the UI shows.
fn noise(rel: &Path) -> bool {
    let s = rel.to_string_lossy();
    s.starts_with(".git/objects/") || s.starts_with(".git/logs/") || s.ends_with(".lock") || s.ends_with(".DS_Store")
}

/// Does this batch of changed paths (absolute) warrant a refresh?
pub fn relevant(root: &Path, paths: &HashSet<PathBuf>) -> bool {
    if paths.len() > MAX_PATHS {
        return true;
    }
    // FSEvents reports canonical paths (/private/tmp/...), the repo root may be a symlinked one.
    let canon = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let mut work = vec![];
    for p in paths {
        let Some(rel) = p.strip_prefix(&canon).or_else(|_| p.strip_prefix(root)).ok() else { return true };
        if rel.as_os_str().is_empty() || noise(rel) {
            continue;
        }
        if rel.starts_with(".git") {
            return true; // HEAD, refs, index, merge/rebase state
        }
        work.push(rel.to_string_lossy().into_owned());
    }
    if work.is_empty() {
        return false;
    }
    let input = work.join("\0") + "\0";
    let root_s = root.to_string_lossy();
    // Exit 0: some paths ignored (listed), 1: none ignored. Anything else: refresh to be safe.
    match git::spawn(&root_s, &["check-ignore", "--stdin", "-z"], &Ctx::default(), &[], Some(input.as_bytes())) {
        Ok(out) if out.code == 0 => out.stdout.split('\0').filter(|s| !s.is_empty()).count() < work.len(),
        _ => true,
    }
}

/// Watch `root` and call `on_change` once per relevant batch of changes.
pub fn watch(root: PathBuf, on_change: impl Fn() + Send + 'static) -> notify::Result<RepoWatcher> {
    let (tx, rx) = channel::<Vec<PathBuf>>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            let _ = tx.send(ev.paths);
        }
    })?;
    watcher.watch(&root, RecursiveMode::Recursive)?;

    // Dropping the watcher drops `tx`, which ends this thread.
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let start = Instant::now();
            let mut batch: HashSet<PathBuf> = first.into_iter().collect();
            loop {
                let left = MAX_WAIT.saturating_sub(start.elapsed());
                if left.is_zero() {
                    break;
                }
                match rx.recv_timeout(QUIET.min(left)) {
                    Ok(paths) => {
                        if batch.len() <= MAX_PATHS {
                            batch.extend(paths);
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            if relevant(&root, &batch) {
                on_change();
            }
        }
    });
    Ok(RepoWatcher { _watcher: watcher })
}

pub fn start(app: AppHandle, root: PathBuf) -> notify::Result<RepoWatcher> {
    let name = root.to_string_lossy().to_string();
    watch(root, move || {
        let _ = app.emit("repo-changed", name.clone());
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn repo() -> PathBuf {
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("gittygit-watch-{}-{n}", std::process::id()));
        std::fs::create_dir_all(dir.join("dist/nested")).unwrap();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        let r = dir.to_string_lossy().into_owned();
        git::run(&r, &["init", "-q"]).unwrap();
        std::fs::write(dir.join(".gitignore"), "dist/\n*.log\n").unwrap();
        std::fs::write(dir.join("src/.gitignore"), "gen/\n").unwrap();
        dir
    }

    fn set(root: &Path, rels: &[&str]) -> HashSet<PathBuf> {
        rels.iter().map(|r| root.canonicalize().unwrap().join(r)).collect()
    }

    #[test]
    fn ignored_batches_are_skipped() {
        let root = repo();
        assert!(!relevant(&root, &set(&root, &["dist/app.js", "dist/nested/x.map", "debug.log", "src/gen/a.ts"])));
        assert!(relevant(&root, &set(&root, &["dist/app.js", "src/main.ts"])));
        assert!(relevant(&root, &set(&root, &[".git/HEAD"])));
        assert!(!relevant(&root, &set(&root, &[".git/objects/ab/cdef", ".git/index.lock"])));
        assert!(relevant(&root, &[PathBuf::from("/elsewhere/file")].into_iter().collect()));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn steady_writes_still_refresh() {
        let root = repo();
        let hits = Arc::new(Mutex::new(vec![]));
        let h = hits.clone();
        let _w = watch(root.clone(), move || h.lock().unwrap().push(Instant::now())).unwrap();
        std::thread::sleep(Duration::from_millis(500));
        // Ignored writes alone: no refresh.
        for i in 0..5 {
            std::fs::write(root.join(format!("dist/out{i}.js")), "x").unwrap();
            std::thread::sleep(Duration::from_millis(100));
        }
        std::thread::sleep(Duration::from_millis(2500));
        assert_eq!(hits.lock().unwrap().len(), 0, "ignored writes triggered a refresh");
        // A tracked file written every 100 ms for 4 s: the 400 ms quiet window never elapses,
        // but the 1.5 s cap still lets refreshes through while it's going on.
        let start = Instant::now();
        let mut i = 0;
        while start.elapsed() < Duration::from_secs(4) {
            std::fs::write(root.join("src/main.ts"), format!("{i}")).unwrap();
            i += 1;
            std::thread::sleep(Duration::from_millis(100));
        }
        let during = hits.lock().unwrap().iter().filter(|t| t.duration_since(start) < Duration::from_secs(4)).count();
        assert!(during >= 2, "only {during} refreshes during 4 s of writes");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
