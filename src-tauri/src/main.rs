#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod git;
mod graph;
mod profiles;
mod updater;
mod watch;

use git::R;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, MenuItemKind};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
struct AppState {
    watcher: Mutex<Option<watch::RepoWatcher>>,
}

#[derive(Serialize)]
struct RepoInfo {
    root: String,
    name: String,
}

#[derive(Serialize)]
struct GraphPayload {
    rows: Vec<graph::Row>,
    max_lanes: usize,
    head_sha: Option<String>,
    head_branch: Option<String>,
    dirty: bool,
}

#[tauri::command(async)]
fn pick_repo(app: AppHandle) -> R<Option<String>> {
    pick_path(app, "folder".into(), "Open a Git repository".into())
}

/// Native folder/file picker. `kind` is "folder" or "file".
#[tauri::command(async)]
fn pick_path(app: AppHandle, kind: String, title: String) -> R<Option<String>> {
    let dlg = app.dialog().file().set_title(title);
    let picked = if kind == "file" { dlg.blocking_pick_file() } else { dlg.blocking_pick_folder() };
    match picked {
        None => Ok(None),
        Some(p) => Ok(Some(p.into_path().map_err(|e| e.to_string())?.to_string_lossy().into_owned())),
    }
}

fn resolve(path: &str) -> R<RepoInfo> {
    let root = git::run(path, &["rev-parse", "--show-toplevel"])
        .map_err(|_| format!("{path} is not inside a Git repository"))?
        .trim()
        .to_string();
    let name = PathBuf::from(&root)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.clone());
    Ok(RepoInfo { root, name })
}

/// Normalise any path inside a repository to its root.
#[tauri::command(async)]
fn resolve_repo(path: String) -> R<RepoInfo> {
    resolve(&path)
}

/// Watch the active tab's working tree.
#[tauri::command(async)]
fn watch_repo(app: AppHandle, state: State<AppState>, path: String) -> R<()> {
    *state.watcher.lock().unwrap() = watch::start(app, PathBuf::from(&path)).ok();
    Ok(())
}

// ------------------------------------------------------------------ profiles

#[tauri::command(async)]
fn get_profiles() -> profiles::Store {
    profiles::load()
}

#[tauri::command(async)]
fn save_profiles(store: profiles::Store) -> R<()> {
    profiles::save(&store)
}

#[tauri::command(async)]
fn check_repo(profile_id: String, repo: String) -> R<profiles::RepoCheck> {
    profiles::check_repo(&profiles::load(), &profile_id, &repo)
}

#[tauri::command(async)]
fn list_ssh_keys() -> Vec<profiles::SshKey> {
    profiles::list_keys()
}

#[tauri::command(async)]
fn test_ssh(key: String, host: String) -> profiles::SshTest {
    profiles::test_ssh(&key, &host)
}

#[tauri::command(async)]
fn set_terminal_config(profile_id: String, repo: String, enabled: bool) -> R<()> {
    let store = profiles::load();
    profiles::apply_terminal_config(store.for_repo(&profile_id, &repo)?, &repo, enabled)
}

#[tauri::command(async)]
fn add_key_to_keychain(key: String) -> R<()> {
    profiles::add_key_to_keychain(&key)
}

/// Clone with the profile's SSH key into `parent/<name>`.
#[tauri::command(async)]
fn clone_repo(profile_id: String, url: String, parent: String) -> R<RepoInfo> {
    let store = profiles::load();
    let profile = store.get(&profile_id)?;
    let name = url
        .trim_end_matches('/')
        .rsplit(|c| c == '/' || c == ':')
        .next()
        .unwrap_or("repo")
        .trim_end_matches(".git")
        .to_string();
    if name.is_empty() {
        return Err("could not derive a folder name from the URL".into());
    }
    let dest = PathBuf::from(&parent).join(&name);
    if dest.exists() {
        return Err(format!("{} already exists", dest.display()));
    }
    let dest_s = dest.to_string_lossy().into_owned();
    git::exec(&parent, &["clone", "--", url.trim(), &dest_s], &[0], &profiles::ctx(profile))?;
    resolve(&dest_s)
}

/// Repository passed on the command line (`gittygit /path/to/repo`), like `gitkraken -p`.
#[tauri::command]
fn initial_repo() -> Option<String> {
    std::env::args().skip(1).find(|a| !a.starts_with('-') && std::path::Path::new(a).is_dir())
}

#[tauri::command(async)]
fn init_repo(path: String) -> R<()> {
    git::run(&path, &["init"]).map(|_| ())
}

#[tauri::command(async)]
fn get_graph(repo: String, limit: Option<usize>) -> R<GraphPayload> {
    let st = git::status(&repo)?;
    let dirty = is_dirty(&st, &git::repo_state(&repo));
    build_graph(&repo, limit.unwrap_or(5000), dirty)
}

/// A merge/rebase in progress keeps the WIP row so it can be continued or aborted,
/// even when resolving left the working tree identical to HEAD.
fn is_dirty(st: &git::Status, op: &git::RepoState) -> bool {
    !(st.staged.is_empty() && st.unstaged.is_empty() && st.conflicted.is_empty()) || op.kind.is_some()
}

fn build_graph(repo: &str, limit: usize, dirty: bool) -> R<GraphPayload> {
    let mut commits = git::log(repo, limit)?;
    let (head_sha, head_branch) = git::head(repo);
    if dirty {
        // Synthetic work-in-progress node on top of HEAD, like GitKraken's "// WIP" row.
        commits.insert(
            0,
            git::RawCommit {
                sha: "WIP".into(),
                parents: head_sha.clone().into_iter().collect(),
                author: String::new(),
                email: String::new(),
                time: 0,
                refs: vec![],
                subject: String::new(),
            },
        );
    }
    let (rows, max_lanes) = graph::layout(commits);
    Ok(GraphPayload { rows, max_lanes, head_sha, head_branch, dirty })
}

#[derive(Serialize)]
struct Snapshot {
    /// Identifies the graph below; pass it back as `known_key` to skip rebuilding an unchanged graph.
    key: String,
    /// None when `known_key` still matches (the caller keeps its graph).
    graph: Option<GraphPayload>,
    status: git::Status,
    refs: git::Refs,
    op: git::RepoState,
}

/// Everything a refresh needs in one call. The commit graph (the expensive part: `git log` of
/// thousands of commits plus layout) is only rebuilt when refs, HEAD or the WIP row changed.
#[tauri::command(async)]
fn get_snapshot(repo: String, known_key: Option<String>) -> R<Snapshot> {
    let status = git::status(&repo)?;
    let op = git::repo_state(&repo);
    let dirty = is_dirty(&status, &op);
    let key = git::graph_key(&repo, dirty)?;
    let graph = if known_key.as_deref() == Some(key.as_str()) { None } else { Some(build_graph(&repo, 5000, dirty)?) };
    Ok(Snapshot { key, graph, status, refs: git::refs(&repo)?, op })
}

/// Fast-forward several local branches from their upstreams, one fetch per remote.
#[tauri::command(async)]
fn fast_forward(profile_id: String, repo: String, branches: Vec<git::FfBranch>) -> R<Vec<git::FfResult>> {
    let store = profiles::load();
    let profile = store.for_repo(&profile_id, &repo)?;
    git::fast_forward(&repo, &branches, &profiles::ctx(profile))
}

#[tauri::command(async)]
fn get_status(repo: String) -> R<git::Status> {
    git::status(&repo)
}

#[tauri::command(async)]
fn get_refs(repo: String) -> R<git::Refs> {
    git::refs(&repo)
}

#[tauri::command(async)]
fn get_commit(repo: String, sha: String) -> R<git::CommitDetail> {
    git::commit(&repo, &sha)
}

#[tauri::command(async)]
fn get_diff(repo: String, path: String, mode: String, sha: Option<String>, untracked: Option<bool>) -> R<String> {
    git::diff(&repo, &path, &mode, sha.as_deref(), untracked.unwrap_or(false))
}

/// Mutating git operations, run with the profile's SSH key and identity.
/// Only subcommands the UI actually issues are allowed, and only on the profile's repos.
#[tauri::command(async)]
fn git_run(profile_id: String, repo: String, args: Vec<String>) -> R<String> {
    const ALLOWED: &[&str] = &[
        "add", "apply", "branch", "checkout", "cherry-pick", "clean", "commit", "fetch", "merge", "pull", "push",
        "rebase", "reset", "restore", "rev-parse", "revert", "rm", "stash", "switch", "tag",
    ];
    let sub = args.first().map(String::as_str).unwrap_or_default();
    if !ALLOWED.contains(&sub) {
        return Err(format!("git {sub} is not allowed"));
    }
    let store = profiles::load();
    let profile = store.for_repo(&profile_id, &repo)?;
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    git::exec(&repo, &argv, &[0], &profiles::ctx(profile))
}

#[tauri::command(async)]
fn get_repo_state(repo: String) -> git::RepoState {
    git::repo_state(&repo)
}

#[tauri::command(async)]
fn read_conflict(repo: String, path: String) -> R<git::ConflictFile> {
    git::read_conflict(&repo, &path)
}

/// Write the resolved content of a conflicted file and stage it.
#[tauri::command(async)]
fn resolve_conflict(profile_id: String, repo: String, path: String, content: String) -> R<()> {
    let store = profiles::load();
    let profile = store.for_repo(&profile_id, &repo)?;
    git::write_conflict(&repo, &path, &content)?;
    git::exec(&repo, &["add", "--", &path], &[0], &profiles::ctx(profile)).map(|_| ())
}

/// Stage, unstage or discard selected hunks/lines (a patch built by the diff view).
#[tauri::command(async)]
fn apply_patch(profile_id: String, repo: String, patch: String, mode: String) -> R<()> {
    let store = profiles::load();
    let profile = store.for_repo(&profile_id, &repo)?;
    git::apply_patch(&repo, &patch, &mode, &profiles::ctx(profile))
}

#[tauri::command(async)]
fn file_history(repo: String, path: String) -> R<Vec<git::HistoryEntry>> {
    git::file_history(&repo, &path, 1000)
}

#[tauri::command(async)]
fn blame(repo: String, path: String, rev: Option<String>) -> R<git::Blame> {
    git::blame(&repo, &path, rev.as_deref().filter(|r| !r.is_empty()))
}

#[tauri::command(async)]
fn rebase_plan(repo: String, base: String) -> R<git::RebasePlan> {
    git::rebase_plan(&repo, &base)
}

#[tauri::command(async)]
fn interactive_rebase(profile_id: String, repo: String, base: String, steps: Vec<git::RebaseStep>) -> R<String> {
    let store = profiles::load();
    let profile = store.for_repo(&profile_id, &repo)?;
    git::interactive_rebase(&repo, &base, &steps, &profiles::ctx(profile))
}

/// Save the working-tree content of `paths` (and optionally the index) before a discard.
#[tauri::command(async)]
fn snapshot_files(repo: String, paths: Vec<String>, index: Option<bool>) -> R<git::Snapshot> {
    git::snapshot(&repo, &paths, index.unwrap_or(false))
}

#[tauri::command(async)]
fn restore_files(profile_id: String, repo: String, snapshot: git::Snapshot) -> R<()> {
    let store = profiles::load();
    let profile = store.for_repo(&profile_id, &repo)?;
    git::restore(&repo, &snapshot, &profiles::ctx(profile))
}

#[tauri::command(async)]
fn reveal(repo: String, target: String, path: Option<String>) -> R<()> {
    let mut cmd = std::process::Command::new("open");
    match target.as_str() {
        "terminal" => cmd.args(["-a", "Terminal", &repo]),
        "finder" => cmd.arg(&repo),
        // Open a file in the repo with its default app (e.g. your code editor).
        "file" => {
            let rel = path.ok_or("missing path")?;
            let full = PathBuf::from(&repo).join(&rel);
            if rel.contains("..") || !full.is_file() {
                return Err(format!("{rel} not found"));
            }
            cmd.arg(full)
        }
        _ => return Err("unknown target".into()),
    };
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Debug-only: `gittygit --rpc <command> '<json args>'` runs one backend command and
/// prints its JSON result, so the UI can be exercised in a plain browser during development.
#[cfg(debug_assertions)]
fn rpc(cmd: &str, args: &str) -> Result<serde_json::Value, String> {
    use serde_json::{json, to_value, Value};
    let a: Value = serde_json::from_str(args).map_err(|e| e.to_string())?;
    // Accept both snake_case and the camelCase keys the frontend sends.
    let get = |k: &str| {
        let camel: String = k
            .split('_')
            .enumerate()
            .map(|(i, w)| if i == 0 { w.to_string() } else { w[..1].to_uppercase() + &w[1..] })
            .collect();
        a.get(k).or_else(|| a.get(&camel)).cloned()
    };
    let s = |k: &str| get(k).and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
    let repo = s("repo");
    let v = match cmd {
        "initial_repo" => json!(null),
        "resolve_repo" => to_value(resolve_repo(s("path"))?).unwrap(),
        "watch_repo" => json!(null),
        "get_profiles" => to_value(get_profiles()).unwrap(),
        "save_profiles" => {
            let store = serde_json::from_value(get("store").unwrap_or_default()).map_err(|e| e.to_string())?;
            json!(save_profiles(store)?)
        }
        "check_repo" => to_value(check_repo(s("profile_id"), repo)?).unwrap(),
        "list_ssh_keys" => to_value(list_ssh_keys()).unwrap(),
        "test_ssh" => to_value(test_ssh(s("key"), s("host"))).unwrap(),
        "set_terminal_config" => {
            json!(set_terminal_config(s("profile_id"), repo, get("enabled").and_then(|v| v.as_bool()).unwrap_or(false))?)
        }
        "clone_repo" => to_value(clone_repo(s("profile_id"), s("url"), s("parent"))?).unwrap(),
        "get_repo_state" => to_value(get_repo_state(repo)).unwrap(),
        "read_conflict" => to_value(read_conflict(repo, s("path"))?).unwrap(),
        "resolve_conflict" => json!(resolve_conflict(s("profile_id"), repo, s("path"), s("content"))?),
        "get_graph" => to_value(get_graph(repo, None)?).unwrap(),
        "get_snapshot" => {
            let known = Some(s("known_key")).filter(|k| !k.is_empty());
            to_value(get_snapshot(repo, known)?).unwrap()
        }
        "fast_forward" => {
            let branches = serde_json::from_value(get("branches").unwrap_or_default()).map_err(|e| e.to_string())?;
            to_value(fast_forward(s("profile_id"), repo, branches)?).unwrap()
        }
        "get_status" => to_value(get_status(repo)?).unwrap(),
        "get_refs" => to_value(get_refs(repo)?).unwrap(),
        "get_commit" => to_value(get_commit(repo, s("sha"))?).unwrap(),
        "get_diff" => {
            let sha = Some(s("sha")).filter(|x| !x.is_empty());
            json!(get_diff(repo, s("path"), s("mode"), sha, get("untracked").and_then(|v| v.as_bool()))?)
        }
        "apply_patch" => json!(apply_patch(s("profile_id"), repo, s("patch"), s("mode"))?),
        "file_history" => to_value(file_history(repo, s("path"))?).unwrap(),
        "blame" => to_value(blame(repo, s("path"), Some(s("rev")))?).unwrap(),
        "rebase_plan" => to_value(rebase_plan(repo, s("base"))?).unwrap(),
        "interactive_rebase" => {
            let steps = serde_json::from_value(get("steps").unwrap_or_default()).map_err(|e| e.to_string())?;
            json!(interactive_rebase(s("profile_id"), repo, s("base"), steps)?)
        }
        "snapshot_files" => {
            let paths = serde_json::from_value(get("paths").unwrap_or_default()).map_err(|e| e.to_string())?;
            to_value(snapshot_files(repo, paths, get("index").and_then(|v| v.as_bool()))?).unwrap()
        }
        "restore_files" => {
            let snap = serde_json::from_value(get("snapshot").unwrap_or_default()).map_err(|e| e.to_string())?;
            json!(restore_files(s("profile_id"), repo, snap)?)
        }
        "git_run" => {
            let argv = serde_json::from_value(get("args").unwrap_or_default()).map_err(|e| e.to_string())?;
            json!(git_run(s("profile_id"), repo, argv)?)
        }
        _ => return Err(format!("unknown command {cmd}")),
    };
    Ok(v)
}

fn main() {
    #[cfg(debug_assertions)]
    {
        let argv: Vec<String> = std::env::args().collect();
        if argv.get(1).map(String::as_str) == Some("--rpc") {
            let out = rpc(&argv[2], argv.get(3).map(String::as_str).unwrap_or("{}"));
            match out {
                Ok(v) => println!("{}", serde_json::json!({ "ok": v })),
                Err(e) => println!("{}", serde_json::json!({ "err": e })),
            }
            return;
        }
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
        .manage(updater::Pending::default())
        .setup(|app| {
            // Default macOS menu (keeps Edit → Copy/Paste etc.) plus "Check for Updates…".
            let menu = Menu::default(app.handle())?;
            if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.first() {
                let item = MenuItem::with_id(app, "check-updates", "Check for Updates…", true, None::<&str>)?;
                app_menu.insert(&item, 1)?;
            }
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                if event.id() == "check-updates" {
                    let _ = app.emit("menu-check-updates", ());
                }
            });
            #[cfg(debug_assertions)]
            updater::test_auto_update(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pick_repo,
            pick_path,
            resolve_repo,
            watch_repo,
            initial_repo,
            init_repo,
            get_profiles,
            save_profiles,
            check_repo,
            list_ssh_keys,
            test_ssh,
            set_terminal_config,
            add_key_to_keychain,
            clone_repo,
            get_graph,
            get_snapshot,
            fast_forward,
            get_status,
            get_refs,
            get_commit,
            get_diff,
            git_run,
            get_repo_state,
            read_conflict,
            resolve_conflict,
            apply_patch,
            file_history,
            blame,
            rebase_plan,
            interactive_rebase,
            snapshot_files,
            restore_files,
            reveal,
            updater::check_update,
            updater::install_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running Gittygit");
}
