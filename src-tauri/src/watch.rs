//! Working-tree watcher (GitKraken uses the `nsfw` native addon for this).
//! Changes are debounced and surfaced to the UI as a single `repo-changed` event.

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub struct RepoWatcher {
    _watcher: RecommendedWatcher,
}

fn relevant(p: &Path) -> bool {
    let s = p.to_string_lossy();
    !(s.contains("/.git/objects/")
        || s.contains("/.git/logs/")
        || s.ends_with(".lock")
        || s.contains("/node_modules/")
        || s.contains("/target/")
        || s.ends_with(".DS_Store"))
}

pub fn start(app: AppHandle, root: PathBuf) -> notify::Result<RepoWatcher> {
    let (tx, rx) = channel::<()>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if ev.paths.iter().any(|p| relevant(p)) {
                let _ = tx.send(());
            }
        }
    })?;
    watcher.watch(&root, RecursiveMode::Recursive)?;

    // Dropping the watcher drops `tx`, which ends this thread.
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            loop {
                match rx.recv_timeout(Duration::from_millis(400)) {
                    Ok(()) => continue,
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            let _ = app.emit("repo-changed", root.to_string_lossy().to_string());
        }
    });
    Ok(RepoWatcher { _watcher: watcher })
}
