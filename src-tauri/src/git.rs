//! Thin wrapper around the git CLI.
//!
//! A single engine: the user's own git binary, run off the main thread with
//! prompts disabled and output forced to English so it can be parsed.

use serde::Serialize;
use std::path::Path;
use std::process::Command;
use std::sync::OnceLock;

const US: char = '\u{1f}'; // field separator
const RS: char = '\u{1e}'; // record separator

pub type R<T> = Result<T, String>;

pub fn git_bin() -> &'static str {
    static BIN: OnceLock<String> = OnceLock::new();
    BIN.get_or_init(|| {
        for c in ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"] {
            if Path::new(c).exists() {
                return c.to_string();
            }
        }
        "git".to_string()
    })
}

/// GUI apps launched from Finder get a minimal PATH; hooks and credential
/// helpers usually live in Homebrew prefixes.
fn gui_path() -> String {
    let base = std::env::var("PATH").unwrap_or_default();
    format!("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:{base}")
}

/// Per-profile settings applied to a git invocation.
#[derive(Default, Clone)]
pub struct Ctx {
    /// Full `GIT_SSH_COMMAND` (selects the profile's SSH key).
    pub ssh_command: Option<String>,
    /// (user.name, user.email) for commits made through the app.
    pub identity: Option<(String, String)>,
}

/// Run git in `cwd` (passed with `-C`) and return stdout when the exit code is in `ok_codes`.
pub fn exec(cwd: &str, args: &[&str], ok_codes: &[i32], ctx: &Ctx) -> R<String> {
    exec_with(cwd, args, ok_codes, ctx, &[], None)
}

/// `exec` with extra environment variables and optional stdin.
pub fn exec_with(cwd: &str, args: &[&str], ok_codes: &[i32], ctx: &Ctx, env: &[(&str, &str)], stdin: Option<&[u8]>) -> R<String> {
    let out = spawn(cwd, args, ctx, env, stdin)?;
    if ok_codes.contains(&out.code) {
        return Ok(out.stdout);
    }
    let msg = if out.stderr.trim().is_empty() { out.stdout.trim() } else { out.stderr.trim() };
    Err(if msg.is_empty() { format!("git exited with {}", out.code) } else { msg.to_string() })
}

/// Exit code and both output streams of one git run.
pub struct Output {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Run git and return its raw result, whatever the exit code.
pub fn spawn(cwd: &str, args: &[&str], ctx: &Ctx, env: &[(&str, &str)], stdin: Option<&[u8]>) -> R<Output> {
    let mut cmd = Command::new(git_bin());
    cmd.arg("-C").arg(cwd);
    if let Some((name, email)) = &ctx.identity {
        cmd.arg("-c").arg(format!("user.name={name}")).arg("-c").arg(format!("user.email={email}"));
    }
    cmd.args(args)
        .env("PATH", gui_path())
        // The UI matches on git's messages (e.g. "non-fast-forward", "not fully merged"),
        // so force untranslated output regardless of the user's locale.
        .env("LC_ALL", "en_US.UTF-8")
        .env("LANGUAGE", "en")
        .env("GIT_TERMINAL_PROMPT", "0")
        // Continuing a merge/rebase/cherry-pick would open an editor for the prepared
        // message; accept it as-is (there is no terminal to edit in).
        .env("GIT_EDITOR", "true")
        .env("GIT_OPTIONAL_LOCKS", "0");
    match &ctx.ssh_command {
        Some(ssh) => {
            cmd.env("GIT_SSH_COMMAND", ssh);
        }
        None if std::env::var_os("GIT_SSH_COMMAND").is_none() => {
            cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
        }
        None => {}
    }
    cmd.envs(env.iter().copied());
    let out = match stdin {
        None => cmd.output(),
        Some(input) => {
            use std::io::Write;
            use std::process::Stdio;
            let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("failed to run git: {e}"))?;
            child.stdin.take().expect("piped stdin").write_all(input).map_err(|e| e.to_string())?;
            child.wait_with_output()
        }
    }
    .map_err(|e| format!("failed to run git: {e}"))?;
    Ok(Output {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

pub fn run_codes(repo: &str, args: &[&str], ok_codes: &[i32]) -> R<String> {
    exec(repo, args, ok_codes, &Ctx::default())
}

pub fn run(repo: &str, args: &[&str]) -> R<String> {
    run_codes(repo, args, &[0])
}

/// Remote URLs of a repository (`git remote -v`, fetch side, de-duplicated).
pub fn remote_urls(repo: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for line in run(repo, &["remote", "-v"]).unwrap_or_default().lines() {
        let mut it = line.split_whitespace();
        if let (Some(name), Some(url)) = (it.next(), it.next()) {
            if !out.iter().any(|(n, _)| n == name) {
                out.push((name.to_string(), url.to_string()));
            }
        }
    }
    out
}

// ---------------------------------------------------------------- log

pub struct RawCommit {
    pub sha: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub refs: Vec<String>,
    pub subject: String,
}

pub fn log(repo: &str, limit: usize) -> R<Vec<RawCommit>> {
    let n = format!("-n{limit}");
    let fmt = "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1e";
    // Empty repos have no HEAD; treat as no commits.
    let out = match run(repo, &["log", "--exclude=refs/stash", "--all", "--topo-order", &n, fmt]) {
        Ok(o) => o,
        Err(e) if e.contains("does not have any commits") || e.contains("bad default revision") => String::new(),
        Err(e) => return Err(e),
    };
    Ok(out
        .split(RS)
        .filter_map(|rec| {
            let rec = rec.trim_start_matches('\n');
            if rec.is_empty() {
                return None;
            }
            let f: Vec<&str> = rec.split(US).collect();
            if f.len() < 7 {
                return None;
            }
            Some(RawCommit {
                sha: f[0].to_string(),
                parents: f[1].split_whitespace().map(String::from).collect(),
                author: f[2].to_string(),
                email: f[3].to_string(),
                time: f[4].parse().unwrap_or(0),
                refs: f[5].split(", ").filter(|s| !s.is_empty()).map(String::from).collect(),
                subject: f[6].to_string(),
            })
        })
        .collect())
}

pub fn head(repo: &str) -> (Option<String>, Option<String>) {
    let sha = run(repo, &["rev-parse", "--verify", "-q", "HEAD"]).ok().map(|s| s.trim().to_string());
    let branch = run(repo, &["symbolic-ref", "--short", "-q", "HEAD"]).ok().map(|s| s.trim().to_string());
    (sha.filter(|s| !s.is_empty()), branch.filter(|s| !s.is_empty()))
}

/// Whether git's commit-graph file exists (single file or split chain). It makes `--topo-order`
/// over all branches, `log -- <path>` and blame much faster on big repositories.
pub fn has_commit_graph(repo: &str) -> bool {
    ["objects/info/commit-graph", "objects/info/commit-graphs/commit-graph-chain"].iter().any(|p| {
        run(repo, &["rev-parse", "--git-path", p]).map(|g| Path::new(repo).join(g.trim()).is_file()).unwrap_or(false)
    })
}

#[derive(Serialize, Debug, PartialEq)]
pub struct SearchHit {
    pub sha: String,
    /// Index in the graph's commit order (`log --all --topo-order`), so the UI knows how much
    /// history to load before it can show this commit.
    pub pos: usize,
}

/// Commits whose message, author name/email or hash matches `query` (case-insensitive, literal).
pub fn search(repo: &str, query: &str, max: usize) -> R<Vec<SearchHit>> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let n = format!("-n{max}");
    let base = ["log", "--exclude=refs/stash", "--all", "-i", "-F", "--format=%H", n.as_str()];
    let mut shas: Vec<String> = vec![];
    for filter in [format!("--grep={q}"), format!("--author={q}")] {
        let mut args = base.to_vec();
        args.push(&filter);
        shas.extend(run(repo, &args)?.lines().map(String::from));
    }
    if q.len() >= 4 && q.bytes().all(|b| b.is_ascii_hexdigit()) {
        if let Ok(full) = run(repo, &["rev-parse", "-q", "--verify", &format!("{q}^{{commit}}")]) {
            shas.push(full.trim().to_string());
        }
    }
    if shas.is_empty() {
        return Ok(vec![]);
    }
    let order = run(repo, &["log", "--exclude=refs/stash", "--all", "--topo-order", "--format=%H"])?;
    let wanted: std::collections::HashSet<&str> = shas.iter().map(String::as_str).collect();
    let mut hits: Vec<SearchHit> = order
        .lines()
        .enumerate()
        .filter(|(_, sha)| wanted.contains(sha))
        .map(|(pos, sha)| SearchHit { sha: sha.to_string(), pos })
        .collect();
    hits.truncate(max);
    Ok(hits)
}

// ---------------------------------------------------------------- change detection

/// Fingerprint of everything the commit graph depends on: every ref (stash included) and HEAD.
/// The working tree's own changes don't affect it, so most file saves leave it unchanged.
pub fn graph_key(repo: &str, dirty: bool) -> R<String> {
    use std::hash::{Hash, Hasher};
    let refs = run(repo, &["for-each-ref", "--format=%(objectname) %(refname)"])?;
    let head = run(repo, &["rev-parse", "-q", "--verify", "--symbolic-full-name", "HEAD"]).unwrap_or_default();
    let sha = run(repo, &["rev-parse", "-q", "--verify", "HEAD"]).unwrap_or_default();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (refs, head, sha, dirty).hash(&mut h);
    Ok(format!("{:016x}", h.finish()))
}

// ---------------------------------------------------------------- status

#[derive(Serialize, Clone)]
pub struct FileChange {
    pub path: String,
    pub status: String,
    pub orig: Option<String>,
    /// For conflicted files: git's two-letter state (UU, AA, DU, UD, AU, UA, DD).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict: Option<String>,
}

#[derive(Serialize, Default)]
pub struct Status {
    pub staged: Vec<FileChange>,
    pub unstaged: Vec<FileChange>,
    pub conflicted: Vec<FileChange>,
}

pub fn status(repo: &str) -> R<Status> {
    let out = run(repo, &["status", "--porcelain=v1", "-z", "--untracked-files=all"])?;
    let mut st = Status::default();
    let mut it = out.split('\0');
    while let Some(entry) = it.next() {
        if entry.len() < 4 {
            continue;
        }
        let x = &entry[0..1];
        let y = &entry[1..2];
        let path = entry[3..].to_string();
        let orig = if x == "R" || x == "C" { it.next().map(String::from) } else { None };
        let xy = &entry[0..2];
        if matches!(xy, "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU") {
            st.conflicted.push(FileChange { path, status: "U".into(), orig, conflict: Some(xy.to_string()) });
            continue;
        }
        if xy == "??" {
            st.unstaged.push(FileChange { path, status: "?".into(), orig: None, conflict: None });
            continue;
        }
        if x != " " {
            st.staged.push(FileChange { path: path.clone(), status: x.into(), orig: orig.clone(), conflict: None });
        }
        if y != " " {
            st.unstaged.push(FileChange { path, status: y.into(), orig: None, conflict: None });
        }
    }
    Ok(st)
}

// ---------------------------------------------------------------- refs

#[derive(Serialize)]
pub struct Branch {
    pub name: String,
    pub sha: String,
    pub upstream: String,
    /// Remote name and remote-side ref of the upstream (e.g. "origin", "refs/heads/main").
    pub upstream_remote: String,
    pub upstream_ref: String,
    pub ahead: u32,
    pub behind: u32,
    pub current: bool,
}

#[derive(Serialize)]
pub struct SimpleRef {
    pub name: String,
    pub sha: String,
}

#[derive(Serialize)]
pub struct Stash {
    pub index: usize,
    pub sha: String,
    pub message: String,
}

#[derive(Serialize)]
pub struct Refs {
    pub branches: Vec<Branch>,
    pub remotes: Vec<SimpleRef>,
    pub tags: Vec<SimpleRef>,
    pub stashes: Vec<Stash>,
    pub remote_names: Vec<String>,
}

fn parse_track(t: &str) -> (u32, u32) {
    // "[ahead 2, behind 1]" | "[ahead 2]" | "[gone]" | ""
    let mut a = 0;
    let mut b = 0;
    for part in t.trim_matches(|c| c == '[' || c == ']').split(", ") {
        if let Some(n) = part.strip_prefix("ahead ") {
            a = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            b = n.parse().unwrap_or(0);
        }
    }
    (a, b)
}

pub fn refs(repo: &str) -> R<Refs> {
    let out = run(
        repo,
        &[
            "for-each-ref",
            "--format=%(refname)%1f%(objectname)%1f%(*objectname)%1f%(upstream:short)%1f%(upstream:track)%1f%(HEAD)%1f%(upstream:remotename)%1f%(upstream:remoteref)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
    )?;
    let mut r = Refs { branches: vec![], remotes: vec![], tags: vec![], stashes: vec![], remote_names: vec![] };
    for line in out.lines() {
        let f: Vec<&str> = line.split(US).collect();
        if f.len() < 8 {
            continue;
        }
        let (refname, sha, peeled) = (f[0], f[1], f[2]);
        if let Some(name) = refname.strip_prefix("refs/heads/") {
            let (ahead, behind) = parse_track(f[4]);
            r.branches.push(Branch {
                name: name.into(),
                sha: sha.into(),
                upstream: f[3].into(),
                upstream_remote: f[6].into(),
                upstream_ref: f[7].into(),
                ahead,
                behind,
                current: f[5] == "*",
            });
        } else if let Some(name) = refname.strip_prefix("refs/remotes/") {
            if name.ends_with("/HEAD") {
                continue;
            }
            r.remotes.push(SimpleRef { name: name.into(), sha: sha.into() });
        } else if let Some(name) = refname.strip_prefix("refs/tags/") {
            let target = if peeled.is_empty() { sha } else { peeled };
            r.tags.push(SimpleRef { name: name.into(), sha: target.into() });
        }
    }
    if let Ok(out) = run(repo, &["stash", "list", "--format=%H%x1f%gs"]) {
        for (i, line) in out.lines().enumerate() {
            let mut f = line.splitn(2, US);
            let sha = f.next().unwrap_or_default().to_string();
            let message = f.next().unwrap_or_default().to_string();
            r.stashes.push(Stash { index: i, sha, message });
        }
    }
    if let Ok(out) = run(repo, &["remote"]) {
        r.remote_names = out.lines().map(String::from).collect();
    }
    Ok(r)
}

// ---------------------------------------------------------------- commit details

#[derive(Serialize)]
pub struct CommitDetail {
    pub sha: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub committer: String,
    pub commit_time: i64,
    pub message: String,
    pub files: Vec<FileChange>,
    /// Signature check (`%G?`): "G" good, "U" good but untrusted key, "B" bad, "X"/"Y" expired,
    /// "R" revoked key, "E" can't be checked; None when the commit isn't signed.
    pub signature: Option<String>,
    pub signer: String,
}

pub fn commit(repo: &str, sha: &str) -> R<CommitDetail> {
    let out = run(repo, &["show", "-s", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%B", sha])?;
    let f: Vec<&str> = out.splitn(8, US).collect();
    if f.len() < 8 {
        return Err("unexpected git show output".into());
    }
    let parents: Vec<String> = f[1].split_whitespace().map(String::from).collect();
    let mut args = vec!["diff-tree", "-r", "-z", "--name-status", "-M", "--no-commit-id"];
    let range;
    if let Some(p) = parents.first() {
        range = [p.as_str(), sha];
        args.extend_from_slice(&range);
    } else {
        args.push("--root");
        args.push(sha);
    }
    let files = parse_name_status(&run(repo, &args)?);
    let sig = run(repo, &["show", "-s", "--format=%G?%x1f%GS", sha]).unwrap_or_default();
    let (status, signer) = sig.trim_end().split_once(US).unwrap_or(("N", ""));
    Ok(CommitDetail {
        signature: (status != "N" && !status.is_empty()).then(|| status.to_string()),
        signer: signer.to_string(),
        sha: f[0].into(),
        parents,
        author: f[2].into(),
        email: f[3].into(),
        time: f[4].parse().unwrap_or(0),
        committer: f[5].into(),
        commit_time: f[6].parse().unwrap_or(0),
        message: f[7].trim_end().into(),
        files,
    })
}

/// `--name-status -z` output (with renames/copies carrying two paths) as file changes.
fn parse_name_status(out: &str) -> Vec<FileChange> {
    let mut files = vec![];
    let mut it = out.split('\0').filter(|s| !s.is_empty());
    while let Some(st) = it.next() {
        let code = &st[0..1];
        if code == "R" || code == "C" {
            let orig = it.next().map(String::from);
            if let Some(p) = it.next() {
                files.push(FileChange { path: p.into(), status: code.into(), orig, conflict: None });
            }
        } else if let Some(p) = it.next() {
            files.push(FileChange { path: p.into(), status: code.into(), orig: None, conflict: None });
        }
    }
    files
}

// ---------------------------------------------------------------- compare

/// A revision from the UI (sha, branch or tag), checked to name a commit and not to be an option.
fn commit_rev(repo: &str, rev: &str) -> R<String> {
    if rev.is_empty() || rev.starts_with('-') {
        return Err(format!("bad revision {rev}"));
    }
    run(repo, &["rev-parse", "-q", "--verify", &format!("{rev}^{{commit}}")])
        .map(|s| s.trim().to_string())
        .map_err(|_| format!("{rev} is not a commit"))
}

#[derive(Serialize)]
pub struct LogEntry {
    pub sha: String,
    pub subject: String,
    pub author: String,
    pub email: String,
    pub time: i64,
}

#[derive(Serialize)]
pub struct Compare {
    /// Commits reachable from A but not B, and the other way round (newest first, capped).
    pub only_a: Vec<LogEntry>,
    pub only_b: Vec<LogEntry>,
    pub files: Vec<FileChange>,
}

fn log_range(repo: &str, range: &str, max: usize) -> R<Vec<LogEntry>> {
    let n = format!("-n{max}");
    let out = run(repo, &["log", &n, "--format=%H%x1f%s%x1f%an%x1f%ae%x1f%at", range])?;
    Ok(out
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split(US).collect();
            (f.len() == 5).then(|| LogEntry {
                sha: f[0].into(),
                subject: f[1].into(),
                author: f[2].into(),
                email: f[3].into(),
                time: f[4].parse().unwrap_or(0),
            })
        })
        .collect())
}

/// Compare two commits (or a commit with the working tree when `b` is None): the commits on
/// each side and the files that differ.
pub fn compare(repo: &str, a: &str, b: Option<&str>) -> R<Compare> {
    let a = commit_rev(repo, a)?;
    let b_sha = match b {
        Some(b) => Some(commit_rev(repo, b)?),
        None => None,
    };
    let b_rev = b_sha.clone().unwrap_or_else(|| "HEAD".into());
    let mut args = vec!["diff", "--name-status", "-z", "-M", a.as_str()];
    if let Some(b) = &b_sha {
        args.push(b);
    }
    Ok(Compare {
        only_a: log_range(repo, &format!("{b_rev}..{a}"), 300)?,
        only_b: log_range(repo, &format!("{a}..{b_rev}"), 300)?,
        files: parse_name_status(&run(repo, &args)?),
    })
}

// ---------------------------------------------------------------- submodules, LFS, worktrees

#[derive(Serialize, Debug)]
pub struct Submodule {
    pub path: String,
    pub sha: String,
    /// "ok", "changed" (checked-out commit differs from the recorded one), "uninitialized", "conflict".
    pub state: String,
    pub url: String,
}

pub fn submodules(repo: &str) -> R<Vec<Submodule>> {
    if !Path::new(repo).join(".gitmodules").is_file() {
        return Ok(vec![]);
    }
    let urls = run_codes(repo, &["config", "-f", ".gitmodules", "--get-regexp", r"^submodule\..*\.url$"], &[0, 1]).unwrap_or_default();
    let paths = run_codes(repo, &["config", "-f", ".gitmodules", "--get-regexp", r"^submodule\..*\.path$"], &[0, 1]).unwrap_or_default();
    let url_for = |path: &str| {
        let name = paths.lines().find_map(|l| l.split_once(' ').filter(|(_, p)| *p == path).map(|(k, _)| k.trim_end_matches(".path").to_string()))?;
        urls.lines().find_map(|l| l.split_once(' ').filter(|(k, _)| k.trim_end_matches(".url") == name).map(|(_, u)| u.to_string()))
    };
    let out = run(repo, &["submodule", "status"])?;
    Ok(out
        .lines()
        .filter_map(|l| {
            let state = match l.chars().next()? {
                '-' => "uninitialized",
                '+' => "changed",
                'U' => "conflict",
                _ => "ok",
            };
            let mut it = l[1..].split_whitespace();
            let sha = it.next()?.to_string();
            let path = it.next()?.to_string();
            Some(Submodule { url: url_for(&path).unwrap_or_default(), path, sha, state: state.into() })
        })
        .collect())
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Lfs {
    /// .gitattributes routes files through the LFS filter.
    pub used: bool,
    /// git-lfs is installed (`git lfs version` works).
    pub installed: bool,
}

pub fn lfs(repo: &str) -> Lfs {
    let used = std::fs::read_to_string(Path::new(repo).join(".gitattributes")).map(|t| t.contains("filter=lfs")).unwrap_or(false);
    Lfs { used, installed: used && run(repo, &["lfs", "version"]).is_ok() }
}

#[derive(Serialize, Debug, Default)]
pub struct Worktree {
    pub path: String,
    pub head: String,
    /// Branch checked out there (short name), empty when detached.
    pub branch: String,
    pub bare: bool,
    pub locked: bool,
    /// The folder is gone; `git worktree prune` cleans it up.
    pub prunable: bool,
    /// The worktree this repository tab is.
    pub current: bool,
}

pub fn worktrees(repo: &str) -> R<Vec<Worktree>> {
    let here = run(repo, &["rev-parse", "--show-toplevel"]).map(|s| s.trim().to_string()).unwrap_or_default();
    let out = run(repo, &["worktree", "list", "--porcelain"])?;
    let mut list = vec![];
    for block in out.split("\n\n").filter(|b| !b.trim().is_empty()) {
        let mut w = Worktree::default();
        for line in block.lines() {
            let (k, v) = line.split_once(' ').unwrap_or((line, ""));
            match k {
                "worktree" => w.path = v.into(),
                "HEAD" => w.head = v.into(),
                "branch" => w.branch = v.trim_start_matches("refs/heads/").into(),
                "bare" => w.bare = true,
                "locked" => w.locked = true,
                "prunable" => w.prunable = true,
                _ => {}
            }
        }
        // Compare resolved paths: /tmp vs /private/tmp and the like.
        let canon = |p: &str| std::fs::canonicalize(p).map(|c| c.to_string_lossy().into_owned()).unwrap_or_else(|_| p.to_string());
        w.current = canon(&w.path) == canon(&here);
        list.push(w);
    }
    Ok(list)
}

// ---------------------------------------------------------------- recovery

#[derive(Serialize)]
pub struct ReflogEntry {
    pub sha: String,
    /// Which ref moved, e.g. "HEAD@{3}" or "refs/heads/main@{1}".
    pub selector: String,
    /// What git recorded, e.g. "commit: Fix x", "reset: moving to HEAD~2", "rebase (finish): …".
    pub action: String,
    pub time: i64,
    pub subject: String,
    pub author: String,
}

/// Where HEAD and every branch have pointed recently (`git log -g --all`), newest first.
pub fn reflog(repo: &str, max: usize) -> R<Vec<ReflogEntry>> {
    let n = format!("-n{max}");
    let out = run_codes(repo, &["log", "-g", "--all", &n, "--date=unix", "--format=%H%x1f%gD%x1f%gs%x1f%gd%x1f%s%x1f%an"], &[0, 128])?;
    let mut list: Vec<ReflogEntry> = out
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split(US).collect();
            if f.len() < 6 {
                return None;
            }
            // With --date=unix, %gd renders as "ref@{<seconds>}".
            let time = f[3].rsplit_once("@{").and_then(|(_, t)| t.trim_end_matches('}').parse().ok()).unwrap_or(0);
            Some(ReflogEntry { sha: f[0].into(), selector: f[1].into(), action: f[2].into(), time, subject: f[4].into(), author: f[5].into() })
        })
        .collect();
    list.sort_by(|a, b| b.time.cmp(&a.time));
    Ok(list)
}

/// Commits nothing points to any more, not even the reflog (dropped stashes, commits from
/// deleted branches whose reflog is gone), newest first. Slower: runs `git fsck`.
pub fn unreachable(repo: &str, max: usize) -> R<Vec<LogEntry>> {
    let out = run_codes(repo, &["fsck", "--unreachable", "--no-reflogs", "--no-progress"], &[0, 1, 2])?;
    let shas: Vec<&str> = out.lines().filter_map(|l| l.strip_prefix("unreachable commit ")).map(str::trim).collect();
    if shas.is_empty() {
        return Ok(vec![]);
    }
    let mut args = vec!["log", "--no-walk=unsorted", "--format=%H%x1f%s%x1f%an%x1f%ae%x1f%ct"];
    args.extend(shas.iter().copied());
    let mut list: Vec<LogEntry> = run(repo, &args)?
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split(US).collect();
            (f.len() == 5).then(|| LogEntry { sha: f[0].into(), subject: f[1].into(), author: f[2].into(), email: f[3].into(), time: f[4].parse().unwrap_or(0) })
        })
        .collect();
    list.sort_by(|a, b| b.time.cmp(&a.time));
    list.truncate(max);
    Ok(list)
}

/// The remote's default branch name (from refs/remotes/<remote>/HEAD, else main/master).
pub fn default_branch(repo: &str, remote: &str) -> String {
    if let Ok(r) = run(repo, &["symbolic-ref", "--short", &format!("refs/remotes/{remote}/HEAD")]) {
        if let Some((_, b)) = r.trim().split_once('/') {
            return b.to_string();
        }
    }
    for b in ["main", "master"] {
        if run(repo, &["rev-parse", "-q", "--verify", &format!("refs/remotes/{remote}/{b}")]).is_ok() {
            return b.into();
        }
    }
    "main".into()
}

/// Append a pattern to the repository's root .gitignore (created if needed), once.
pub fn add_to_gitignore(repo: &str, pattern: &str) -> R<bool> {
    let pattern = pattern.trim();
    if pattern.is_empty() || pattern.contains(['\n', '\r', '\0']) {
        return Err("bad pattern".into());
    }
    let path = Path::new(repo).join(".gitignore");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    if text.lines().any(|l| l.trim() == pattern) {
        return Ok(false);
    }
    let sep = if text.is_empty() || text.ends_with('\n') { "" } else { "\n" };
    std::fs::write(&path, format!("{text}{sep}{pattern}\n")).map_err(|e| e.to_string())?;
    Ok(true)
}

// ---------------------------------------------------------------- diffs

/// Diff of one file. Modes: "unstaged", "staged", "commit" (`sha` vs its first parent) and
/// "range" (`sha` vs `sha2`, or vs the working tree when `sha2` is None).
pub fn diff(repo: &str, path: &str, mode: &str, sha: Option<&str>, sha2: Option<&str>, untracked: bool) -> R<String> {
    match mode {
        "range" => {
            let a = commit_rev(repo, sha.ok_or("missing sha")?)?;
            let b = match sha2 {
                Some(b) => Some(commit_rev(repo, b)?),
                None => None,
            };
            let mut args = vec!["diff", "--no-color", "--submodule=log", "-M", a.as_str()];
            if let Some(b) = &b {
                args.push(b);
            }
            args.extend(["--", path]);
            run(repo, &args)
        }
        "unstaged" if untracked => run_codes(repo, &["diff", "--no-color", "--no-index", "--", "/dev/null", path], &[0, 1]),
        "unstaged" => run(repo, &["diff", "--no-color", "--submodule=log", "--", path]),
        "staged" => run(repo, &["diff", "--no-color", "--submodule=log", "--cached", "--", path]),
        "commit" => {
            let sha = sha.ok_or("missing sha")?;
            let first_parent = run(repo, &["rev-parse", "-q", "--verify", &format!("{sha}^1")]).ok();
            match first_parent {
                Some(p) => run(repo, &["diff", "--no-color", "--submodule=log", "-M", p.trim(), sha, "--", path]),
                None => run(repo, &["show", "--no-color", "--format=", sha, "--", path]),
            }
        }
        _ => Err(format!("unknown diff mode {mode}")),
    }
}

// ---------------------------------------------------------------- merge / rebase state & conflicts

#[derive(Serialize, Default)]
pub struct RepoState {
    /// "merge" | "rebase" | "cherry-pick" | "revert" while one is in progress.
    pub kind: Option<String>,
    /// What is being applied: merged branch, commit being replayed/picked.
    pub incoming: Option<String>,
    /// Rebase: what the branch is being rebased onto.
    pub onto: Option<String>,
    /// Rebase: branch being rebased.
    pub head_name: Option<String>,
    /// Rebase progress (current, total).
    pub step: Option<(u32, u32)>,
    /// Prepared commit message (merge).
    pub message: Option<String>,
    /// A bisect in progress (independent of the operations above).
    pub bisect: Option<Bisect>,
}

#[derive(Serialize, Default, Debug)]
pub struct Bisect {
    pub bad: Option<String>,
    pub good: Vec<String>,
    /// Commits still to test and roughly how many steps that takes (once good and bad are known).
    pub remaining: Option<u32>,
    pub steps: Option<u32>,
    /// The first bad commit, once bisect has narrowed it down.
    pub found: Option<String>,
}

fn bisect_state(repo: &str, git_dir: &Path) -> Option<Bisect> {
    if !git_dir.join("BISECT_START").is_file() {
        return None;
    }
    let mut b = Bisect {
        bad: run(repo, &["rev-parse", "-q", "--verify", "refs/bisect/bad"]).ok().map(|s| s.trim().to_string()),
        good: run(repo, &["for-each-ref", "--format=%(objectname)", "refs/bisect/good-*"]).unwrap_or_default().lines().map(String::from).collect(),
        ..Default::default()
    };
    if let (Some(bad), false) = (&b.bad, b.good.is_empty()) {
        let mut args = vec!["rev-list", "--bisect-vars", bad.as_str(), "--not"];
        args.extend(b.good.iter().map(String::as_str));
        let vars = run(repo, &args).unwrap_or_default();
        let var = |k: &str| vars.lines().find_map(|l| l.strip_prefix(&format!("{k}="))).map(|v| v.trim_matches('\'').to_string());
        b.remaining = var("bisect_nr").and_then(|v| v.parse().ok());
        b.steps = var("bisect_steps").and_then(|v| v.parse().ok());
        if var("bisect_all").as_deref() == Some("1") {
            b.found = Some(bad.clone());
        }
    }
    Some(b)
}

fn ref_label(repo: &str, sha: &str) -> String {
    let names = run(repo, &["for-each-ref", "--points-at", sha, "--format=%(refname:short)", "refs/heads", "refs/remotes"])
        .unwrap_or_default();
    match names.lines().next() {
        Some(n) if !n.is_empty() => n.to_string(),
        _ => run(repo, &["log", "-1", "--format=%h %s", sha]).map(|s| s.trim().to_string()).unwrap_or_else(|_| sha.chars().take(7).collect()),
    }
}

pub fn repo_state(repo: &str) -> RepoState {
    let Ok(git_dir) = run(repo, &["rev-parse", "--absolute-git-dir"]) else { return RepoState::default() };
    let g = Path::new(git_dir.trim()).to_path_buf();
    RepoState { bisect: bisect_state(repo, &g), ..operation_state(repo, &g) }
}

fn operation_state(repo: &str, g: &Path) -> RepoState {
    let read = |p: &str| std::fs::read_to_string(g.join(p)).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let commit_line = |sha: &str| run(repo, &["log", "-1", "--format=%h %s", sha]).ok().map(|s| s.trim().to_string());

    let rebase_dir = ["rebase-merge", "rebase-apply"].into_iter().find(|d| g.join(d).is_dir());
    if let Some(d) = rebase_dir {
        let num = |f: &str| read(&format!("{d}/{f}")).and_then(|v| v.parse::<u32>().ok());
        let step = if d == "rebase-merge" { num("msgnum").zip(num("end")) } else { num("next").zip(num("last")) };
        return RepoState {
            kind: Some("rebase".into()),
            incoming: read("REBASE_HEAD").and_then(|sha| commit_line(&sha)),
            onto: read(&format!("{d}/onto")).map(|sha| ref_label(repo, &sha)),
            head_name: read(&format!("{d}/head-name")).map(|h| h.trim_start_matches("refs/heads/").to_string()),
            step,
            message: None,
            bisect: None,
        };
    }
    if let Some(sha) = read("MERGE_HEAD") {
        let message = read("MERGE_MSG");
        // "Merge branch 'x' into y" / "Merge remote-tracking branch 'origin/x'" → x
        let named = message.as_deref().and_then(|m| m.lines().next()).and_then(|l| l.split('\'').nth(1)).map(String::from);
        return RepoState {
            kind: Some("merge".into()),
            incoming: named.or_else(|| Some(ref_label(repo, sha.lines().next().unwrap_or_default()))),
            message,
            ..Default::default()
        };
    }
    for (file, kind) in [("CHERRY_PICK_HEAD", "cherry-pick"), ("REVERT_HEAD", "revert")] {
        if let Some(sha) = read(file) {
            return RepoState { kind: Some(kind.into()), incoming: commit_line(&sha), ..Default::default() };
        }
    }
    RepoState::default()
}

fn conflicted_paths(repo: &str) -> Vec<String> {
    run(repo, &["diff", "--name-only", "--diff-filter=U", "-z"])
        .unwrap_or_default()
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(String::from)
        .collect()
}

/// Only files git currently reports as conflicted may be read or written this way.
fn conflict_path(repo: &str, path: &str) -> R<std::path::PathBuf> {
    if !conflicted_paths(repo).iter().any(|p| p == path) {
        return Err(format!("{path} is not in conflict"));
    }
    Ok(Path::new(repo).join(path))
}

#[derive(Serialize)]
pub struct ConflictFile {
    pub exists: bool,
    pub binary: bool,
    pub text: Option<String>,
}

pub fn read_conflict(repo: &str, path: &str) -> R<ConflictFile> {
    let full = conflict_path(repo, path)?;
    if !full.is_file() {
        return Ok(ConflictFile { exists: false, binary: false, text: None });
    }
    let bytes = std::fs::read(&full).map_err(|e| e.to_string())?;
    if bytes.len() > 5 * 1024 * 1024 || bytes.contains(&0) {
        return Ok(ConflictFile { exists: true, binary: true, text: None });
    }
    match String::from_utf8(bytes) {
        Ok(text) => Ok(ConflictFile { exists: true, binary: false, text: Some(text) }),
        Err(_) => Ok(ConflictFile { exists: true, binary: true, text: None }),
    }
}

pub fn write_conflict(repo: &str, path: &str, content: &str) -> R<()> {
    let full = conflict_path(repo, path)?;
    std::fs::write(full, content).map_err(|e| e.to_string())
}


// ---------------------------------------------------------------- fast-forward without checkout

#[derive(serde::Deserialize, Clone)]
pub struct FfBranch {
    pub name: String,
    pub remote: String,
    /// Upstream ref on the remote, e.g. "refs/heads/main".
    pub remote_ref: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct FfResult {
    pub name: String,
    /// "updated" | "current" | "diverged" | "checked-out" | "failed"
    pub outcome: String,
    pub detail: String,
}

fn ff_result(name: &str, outcome: &str, detail: &str) -> FfResult {
    FfResult { name: name.into(), outcome: outcome.into(), detail: detail.into() }
}

/// Outcome per local branch from `git fetch -v` ref lines:
/// " <flag> <summary> <from> -> <to> [(reason)]" where flag ' ' = fast-forward, '=' = up to date,
/// '!' = rejected. (Plain text rather than --porcelain, which needs git 2.41.)
pub fn parse_fetch_lines(stderr: &str, branches: &[FfBranch]) -> Vec<FfResult> {
    let mut out = vec![];
    for line in stderr.lines() {
        let Some(rest) = line.strip_prefix(' ') else { continue };
        let mut chars = rest.chars();
        let flag = chars.next().unwrap_or(' ');
        let Some((_, right)) = chars.as_str().split_once(" -> ") else { continue };
        let (to, reason) = match right.split_once("  (") {
            Some((t, r)) => (t.trim(), r.trim_end_matches(')').to_string()),
            None => (right.trim(), String::new()),
        };
        let Some(b) = branches.iter().find(|b| b.name == to || format!("refs/heads/{}", b.name) == to) else { continue };
        out.push(match flag {
            '=' => ff_result(&b.name, "current", ""),
            ' ' | '+' | '*' => ff_result(&b.name, "updated", ""),
            '!' if reason.contains("non-fast-forward") => ff_result(&b.name, "diverged", &reason),
            _ => ff_result(&b.name, "failed", if reason.is_empty() { line.trim() } else { &reason }),
        });
    }
    out
}

/// Update local branches from their upstreams without checking them out: one `git fetch` per
/// remote with a `<remote-ref>:refs/heads/<branch>` refspec per branch (fast-forwards only).
pub fn fast_forward(repo: &str, branches: &[FfBranch], ctx: &Ctx) -> R<Vec<FfResult>> {
    let mut results = vec![];
    let mut remotes: Vec<&str> = branches.iter().map(|b| b.remote.as_str()).collect();
    remotes.sort_unstable();
    remotes.dedup();
    for remote in remotes {
        let mut todo: Vec<FfBranch> = branches.iter().filter(|b| b.remote == remote).cloned().collect();
        // A fatal error about one branch (checked out elsewhere, upstream gone) aborts the whole
        // fetch; set that branch aside and retry the rest.
        while !todo.is_empty() {
            let specs: Vec<String> = todo.iter().map(|b| format!("{}:refs/heads/{}", b.remote_ref, b.name)).collect();
            let mut args = vec!["fetch", "-v", "--no-tags", remote];
            args.extend(specs.iter().map(String::as_str));
            let out = spawn(repo, &args, ctx, &[], None)?;
            let fatal = out.stderr.lines().find(|l| l.starts_with("fatal:")).map(str::to_string);
            if let Some(f) = fatal {
                let culprit = todo.iter().position(|b| {
                    f.contains(&format!("'refs/heads/{}'", b.name)) || f.contains(&format!("remote ref {}", b.remote_ref))
                });
                match culprit {
                    Some(i) => {
                        let b = todo.remove(i);
                        let outcome = if f.contains("checked out") { "checked-out" } else { "failed" };
                        let detail = if f.contains("couldn't find remote ref") { format!("{} no longer exists on {remote}", b.remote_ref) } else { f.trim_start_matches("fatal: ").to_string() };
                        results.push(ff_result(&b.name, outcome, &detail));
                        continue;
                    }
                    None => {
                        let detail = out.stderr.trim().to_string();
                        results.extend(todo.iter().map(|b| ff_result(&b.name, "failed", &detail)));
                        break;
                    }
                }
            }
            let parsed = parse_fetch_lines(&out.stderr, &todo);
            for b in &todo {
                match parsed.iter().find(|r| r.name == b.name) {
                    Some(r) => results.push(ff_result(&r.name, &r.outcome, &r.detail)),
                    None => results.push(ff_result(&b.name, "failed", out.stderr.trim())),
                }
            }
            break;
        }
    }
    Ok(results)
}

// ---------------------------------------------------------------- remotes: tags, HTTPS auth

/// Tag names present on `remote` (`git ls-remote --tags --refs`; one network round trip).
pub fn remote_tags(repo: &str, remote: &str, ctx: &Ctx) -> R<Vec<String>> {
    let out = exec(repo, &["ls-remote", "--tags", "--refs", remote], &[0], ctx)?;
    Ok(out.lines().filter_map(|l| l.split_once("\trefs/tags/").map(|(_, t)| t.to_string())).collect())
}

/// "https://host/owner/repo(.git)" (optionally with "user@") -> "git@host:owner/repo.git".
pub fn https_to_ssh(url: &str) -> Option<String> {
    let rest = url.trim().strip_prefix("https://")?;
    let rest = rest.split_once('@').map_or(rest, |(_, r)| r);
    let (host, path) = rest.split_once('/')?;
    let path = path.trim_end_matches('/').trim_end_matches(".git");
    if host.is_empty() || path.split('/').filter(|p| !p.is_empty()).count() < 2 || host.contains(':') {
        return None;
    }
    Some(format!("git@{host}:{path}.git"))
}

/// Hand an HTTPS token to git's own credential store (`git credential approve`, normally the
/// macOS Keychain helper). The token goes over stdin only; the app never keeps it.
pub fn store_credential(repo: &str, host: &str, username: &str, token: &str) -> R<()> {
    if [host, username, token].iter().any(|v| v.is_empty() || v.contains('\n') || v.contains('\0')) {
        return Err("host, username and token are required".into());
    }
    let helper = run_codes(repo, &["config", "--get-all", "credential.helper"], &[0, 1])?;
    if helper.trim().is_empty() {
        return Err("git has no credential helper configured, so it can't remember a token. Switch the remote to SSH instead.".into());
    }
    let input = format!("protocol=https\nhost={host}\nusername={username}\npassword={token}\n\n");
    exec_with(repo, &["credential", "approve"], &[0], &Ctx::default(), &[], Some(input.as_bytes())).map(|_| ())
}

// ---------------------------------------------------------------- partial staging

/// Apply a patch built from selected hunks/lines: "stage" to the index, "unstage" (reverse,
/// index) or "discard" (reverse, working tree). `--recount` lets the UI skip header counts.
pub fn apply_patch(repo: &str, patch: &str, mode: &str, ctx: &Ctx) -> R<()> {
    let args: &[&str] = match mode {
        "stage" => &["apply", "--cached", "--recount", "--whitespace=nowarn", "-"],
        "unstage" => &["apply", "--cached", "--reverse", "--recount", "--whitespace=nowarn", "-"],
        "discard" => &["apply", "--reverse", "--recount", "--whitespace=nowarn", "-"],
        _ => return Err(format!("unknown patch mode {mode}")),
    };
    exec_with(repo, args, &[0], ctx, &[], Some(patch.as_bytes())).map(|_| ())
}

// ---------------------------------------------------------------- file history & blame

#[derive(Serialize)]
pub struct HistoryEntry {
    pub sha: String,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub subject: String,
    /// The file's path in this commit (differs from the requested path before a rename).
    pub path: String,
    pub status: String,
}

pub fn file_history(repo: &str, path: &str, limit: usize) -> R<Vec<HistoryEntry>> {
    let n = format!("-n{limit}");
    let out = run(
        repo,
        &["-c", "core.quotePath=false", "log", "--follow", &n, "--format=%x1e%H%x1f%an%x1f%ae%x1f%at%x1f%s", "--name-status", "--", path],
    )?;
    let mut cur = path.to_string();
    let mut list = vec![];
    for rec in out.split(RS).filter(|r| !r.trim().is_empty()) {
        let mut lines = rec.lines();
        let f: Vec<&str> = lines.next().unwrap_or_default().split(US).collect();
        if f.len() < 5 {
            continue;
        }
        // "M\tpath" or "R100\told\tnew"; merges list nothing, so they keep the newer path.
        let parts: Vec<&str> = lines.filter(|l| l.contains('\t')).last().map(|l| l.split('\t').collect()).unwrap_or_default();
        let status: String = parts.first().map(|p| p.chars().take(1).collect()).unwrap_or_default();
        if let Some(p) = parts.last() {
            cur = p.to_string();
        }
        list.push(HistoryEntry {
            sha: f[0].into(),
            author: f[1].into(),
            email: f[2].into(),
            time: f[3].parse().unwrap_or(0),
            subject: f[4].into(),
            path: cur.clone(),
            status,
        });
        // Older commits (before a rename) live under the old name.
        if parts.len() == 3 {
            cur = parts[1].to_string();
        }
    }
    Ok(list)
}

#[derive(Serialize, Clone, Default)]
pub struct BlameCommit {
    pub sha: String,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub summary: String,
}

#[derive(Serialize, Default)]
pub struct Blame {
    pub commits: Vec<BlameCommit>,
    /// Per line: index into `commits`.
    pub owner: Vec<usize>,
    pub text: Vec<String>,
}

fn is_sha(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `git blame --porcelain` at `rev` (working tree when None).
pub fn blame(repo: &str, path: &str, rev: Option<&str>) -> R<Blame> {
    let mut args = vec!["blame", "--porcelain"];
    if let Some(r) = rev {
        args.push(r);
    }
    args.extend(["--", path]);
    let out = run(repo, &args)?;
    let mut b = Blame::default();
    let mut index = std::collections::HashMap::new();
    let mut cur = 0usize;
    for line in out.lines() {
        if let Some(t) = line.strip_prefix('\t') {
            b.owner.push(cur);
            b.text.push(t.to_string());
            continue;
        }
        let (key, val) = line.split_once(' ').unwrap_or((line, ""));
        if is_sha(key) {
            cur = *index.entry(key.to_string()).or_insert_with(|| {
                b.commits.push(BlameCommit { sha: key.to_string(), ..Default::default() });
                b.commits.len() - 1
            });
            continue;
        }
        let c = &mut b.commits[cur];
        match key {
            "author" => c.author = val.to_string(),
            "author-mail" => c.email = val.trim_matches(|ch| ch == '<' || ch == '>').to_string(),
            "author-time" => c.time = val.parse().unwrap_or(0),
            "summary" => c.summary = val.to_string(),
            _ => {}
        }
    }
    Ok(b)
}

// ---------------------------------------------------------------- interactive rebase

#[derive(Serialize)]
pub struct RebaseCommit {
    pub sha: String,
    pub author: String,
    pub time: i64,
    pub message: String,
}

#[derive(Serialize)]
pub struct RebasePlan {
    /// Oldest first, as in git's todo list.
    pub commits: Vec<RebaseCommit>,
    pub has_merges: bool,
}

pub fn rebase_plan(repo: &str, base: &str) -> R<RebasePlan> {
    if run(repo, &["merge-base", "--is-ancestor", base, "HEAD"]).is_err() {
        return Err("That commit isn't part of the current branch's history.".into());
    }
    let range = format!("{base}..HEAD");
    let out = run(repo, &["log", "--reverse", "--no-merges", "--format=%H%x1f%an%x1f%at%x1f%B%x1e", &range])?;
    let commits = out
        .split(RS)
        .filter_map(|rec| {
            let f: Vec<&str> = rec.trim_start_matches('\n').splitn(4, US).collect();
            (f.len() == 4).then(|| RebaseCommit {
                sha: f[0].into(),
                author: f[1].into(),
                time: f[2].parse().unwrap_or(0),
                message: f[3].trim_end().into(),
            })
        })
        .collect();
    let has_merges = !run(repo, &["rev-list", "--merges", "-n1", &range])?.trim().is_empty();
    Ok(RebasePlan { commits, has_merges })
}

#[derive(serde::Deserialize)]
pub struct RebaseStep {
    pub action: String,
    pub sha: String,
    pub message: Option<String>,
}

/// Run `git rebase -i <base>` with a todo list prepared by the UI (GIT_SEQUENCE_EDITOR copies it
/// in). Rewords become `pick` + `exec git commit --amend -F <file>`, so new messages need no editor.
pub fn interactive_rebase(repo: &str, base: &str, steps: &[RebaseStep], ctx: &Ctx) -> R<String> {
    let plan = rebase_plan(repo, base)?;
    if plan.has_merges {
        return Err("The range contains merge commits; interactive rebase here would flatten them.".into());
    }
    let mut want: Vec<&str> = plan.commits.iter().map(|c| c.sha.as_str()).collect();
    let mut got: Vec<&str> = steps.iter().map(|s| s.sha.as_str()).collect();
    want.sort_unstable();
    got.sort_unstable();
    if want != got {
        return Err("The branch changed since the rebase was planned; open it again.".into());
    }
    match steps.iter().find(|s| s.action != "drop") {
        Some(s) if s.action == "squash" || s.action == "fixup" => {
            return Err("The oldest kept commit can't be squashed: there's nothing before it to squash into.".into())
        }
        None => return Err("Every commit is dropped; use a reset instead.".into()),
        _ => {}
    }
    let git_dir = run(repo, &["rev-parse", "--absolute-git-dir"])?.trim().to_string();
    let dir = Path::new(&git_dir).join("gittygit-rebase");
    let dir_s = dir.to_string_lossy().into_owned();
    if dir_s.contains('\'') {
        return Err("unsupported repository path".into());
    }
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut todo = String::new();
    for (i, s) in steps.iter().enumerate() {
        if !is_sha(&s.sha) {
            return Err(format!("bad commit id {}", s.sha));
        }
        match s.action.as_str() {
            "pick" | "squash" | "fixup" | "drop" => todo.push_str(&format!("{} {}\n", s.action, s.sha)),
            "reword" => {
                let msg = s.message.as_deref().map(str::trim).filter(|m| !m.is_empty()).ok_or("A reworded commit needs a message.")?;
                let file = dir.join(format!("msg-{i}"));
                std::fs::write(&file, format!("{msg}\n")).map_err(|e| e.to_string())?;
                todo.push_str(&format!("pick {}\nexec git commit --amend --allow-empty --no-verify -q -F '{}'\n", s.sha, file.to_string_lossy()));
            }
            a => return Err(format!("unknown rebase action {a}")),
        }
    }
    let todo_path = dir.join("todo");
    std::fs::write(&todo_path, todo).map_err(|e| e.to_string())?;
    let editor = format!("cp '{}'", todo_path.to_string_lossy());
    exec_with(repo, &["rebase", "-i", base], &[0], ctx, &[("GIT_SEQUENCE_EDITOR", &editor)], None)
}

// ---------------------------------------------------------------- undo snapshots

/// Working-tree content of one file, stored as a git blob so a discard can be undone.
#[derive(Serialize, serde::Deserialize)]
pub struct FileSnap {
    pub path: String,
    /// None: the file didn't exist (restoring deletes it).
    pub blob: Option<String>,
    pub mode: Option<u32>,
}

#[derive(Serialize, serde::Deserialize)]
pub struct Snapshot {
    pub files: Vec<FileSnap>,
    /// Index tree (`git write-tree`) when the whole index should come back too.
    pub index: Option<String>,
}

fn safe_rel(path: &str) -> R<()> {
    let p = Path::new(path);
    if path.is_empty() || p.is_absolute() || p.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
        return Err(format!("bad path {path}"));
    }
    Ok(())
}

pub fn snapshot(repo: &str, paths: &[String], with_index: bool) -> R<Snapshot> {
    use std::os::unix::fs::PermissionsExt;
    let mut files = vec![];
    for path in paths {
        safe_rel(path)?;
        let full = Path::new(repo).join(path);
        let meta = std::fs::symlink_metadata(&full).ok().filter(|m| m.is_file());
        let blob = match &meta {
            Some(_) => Some(run(repo, &["hash-object", "-w", "--no-filters", "--", path])?.trim().to_string()),
            None => None,
        };
        files.push(FileSnap { path: path.clone(), blob, mode: meta.map(|m| m.permissions().mode()) });
    }
    // write-tree fails while conflicts are unresolved; then only the files come back.
    let index = if with_index { run(repo, &["write-tree"]).ok().map(|s| s.trim().to_string()) } else { None };
    Ok(Snapshot { files, index })
}

pub fn restore(repo: &str, snap: &Snapshot, ctx: &Ctx) -> R<()> {
    use std::os::unix::fs::PermissionsExt;
    if let Some(tree) = &snap.index {
        if !is_sha(tree) {
            return Err("bad tree id".into());
        }
        exec(repo, &["read-tree", tree], &[0], ctx)?;
    }
    for f in &snap.files {
        safe_rel(&f.path)?;
        let full = Path::new(repo).join(&f.path);
        match &f.blob {
            None => {
                if full.is_file() {
                    std::fs::remove_file(&full).map_err(|e| e.to_string())?;
                }
            }
            Some(blob) => {
                if !is_sha(blob) {
                    return Err("bad blob id".into());
                }
                let mut cmd = Command::new(git_bin());
                let out = cmd.arg("-C").arg(repo).args(["cat-file", "blob", blob]).output().map_err(|e| e.to_string())?;
                if !out.status.success() {
                    return Err(format!("snapshot of {} is gone", f.path));
                }
                if let Some(dir) = full.parent() {
                    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                }
                std::fs::write(&full, &out.stdout).map_err(|e| e.to_string())?;
                if let Some(mode) = f.mode {
                    let _ = std::fs::set_permissions(&full, std::fs::Permissions::from_mode(mode));
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> String {
        let dir = std::env::temp_dir().join(format!("gittygit-test-{}-{}", std::process::id(), rand_suffix()));
        std::fs::create_dir_all(&dir).unwrap();
        let r = dir.to_string_lossy().into_owned();
        run(&r, &["init", "-q", "-b", "main"]).unwrap();
        run(&r, &["config", "user.name", "T"]).unwrap();
        run(&r, &["config", "user.email", "t@example.com"]).unwrap();
        r
    }

    fn rand_suffix() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    }

    fn commit(r: &str, file: &str, text: &str, msg: &str) -> String {
        std::fs::write(Path::new(r).join(file), text).unwrap();
        run(r, &["add", "-A"]).unwrap();
        run(r, &["commit", "-q", "-m", msg]).unwrap();
        run(r, &["rev-parse", "HEAD"]).unwrap().trim().to_string()
    }

    #[test]
    fn rebase_blame_history_snapshot() {
        let r = repo();
        let a = commit(&r, "f", "1\n", "A");
        let b = commit(&r, "f", "1\n2\n", "B");
        let c = commit(&r, "g", "x\n", "C");
        let d = commit(&r, "f", "1\n2\n3\n", "D");

        let plan = rebase_plan(&r, &a).unwrap();
        assert_eq!(plan.commits.iter().map(|c| c.sha.as_str()).collect::<Vec<_>>(), [&b, &c, &d]);
        assert!(!plan.has_merges);

        let hist = file_history(&r, "f", 10).unwrap();
        assert_eq!(hist.iter().map(|h| h.subject.as_str()).collect::<Vec<_>>(), ["D", "B", "A"]);

        let bl = blame(&r, "f", None).unwrap();
        assert_eq!(bl.text, ["1", "2", "3"]);
        assert_eq!(bl.commits[bl.owner[2]].summary, "D");

        let step = |action: &str, sha: &str, message: Option<&str>| RebaseStep {
            action: action.into(),
            sha: sha.into(),
            message: message.map(String::from),
        };
        let bad = interactive_rebase(&r, &a, &[step("fixup", &b, None), step("pick", &c, None), step("pick", &d, None)], &Ctx::default());
        assert!(bad.is_err());
        interactive_rebase(
            &r,
            &a,
            &[step("reword", &b, Some("B renamed\n\nbody")), step("drop", &c, None), step("fixup", &d, None)],
            &Ctx::default(),
        )
        .unwrap();
        let log = run(&r, &["log", "--format=%B%x1e", &format!("{a}..HEAD")]).unwrap();
        assert_eq!(log.split('\u{1e}').filter(|s| !s.trim().is_empty()).count(), 1);
        assert!(log.starts_with("B renamed\n\nbody"));
        assert_eq!(std::fs::read_to_string(Path::new(&r).join("f")).unwrap(), "1\n2\n3\n");
        assert!(!Path::new(&r).join("g").exists());

        // Discard + undo restores the working-tree bytes and a deleted untracked file.
        std::fs::write(Path::new(&r).join("f"), "changed\n").unwrap();
        std::fs::write(Path::new(&r).join("new.txt"), "untracked\n").unwrap();
        let snap = snapshot(&r, &["f".into(), "new.txt".into()], true).unwrap();
        run(&r, &["checkout", "--", "f"]).unwrap();
        std::fs::remove_file(Path::new(&r).join("new.txt")).unwrap();
        restore(&r, &snap, &Ctx::default()).unwrap();
        assert_eq!(std::fs::read_to_string(Path::new(&r).join("f")).unwrap(), "changed\n");
        assert_eq!(std::fs::read_to_string(Path::new(&r).join("new.txt")).unwrap(), "untracked\n");
        assert!(snapshot(&r, &["../x".into()], false).is_err());

        // Stage one hunk through a patch.
        let patch = run(&r, &["diff", "--", "f"]).unwrap();
        apply_patch(&r, &patch, "stage", &Ctx::default()).unwrap();
        assert!(run(&r, &["diff", "--cached", "--", "f"]).unwrap().contains("+changed"));
        apply_patch(&r, &patch, "unstage", &Ctx::default()).unwrap();
        assert!(run(&r, &["diff", "--cached"]).unwrap().is_empty());
        std::fs::remove_dir_all(&r).unwrap();
    }

    #[test]
    fn graph_key_tracks_refs_not_edits() {
        let r = repo();
        commit(&r, "f", "1\n", "A");
        let k1 = graph_key(&r, false).unwrap();
        std::fs::write(Path::new(&r).join("f"), "edited\n").unwrap();
        assert_eq!(graph_key(&r, false).unwrap(), k1, "a file edit changed the key");
        assert_ne!(graph_key(&r, true).unwrap(), k1, "the WIP row must change the key");
        run(&r, &["branch", "topic"]).unwrap();
        let k2 = graph_key(&r, false).unwrap();
        assert_ne!(k2, k1);
        run(&r, &["switch", "-q", "topic"]).unwrap();
        assert_ne!(graph_key(&r, false).unwrap(), k2, "switching branch must change the key");
        run(&r, &["stash", "-q"]).unwrap();
        assert_ne!(graph_key(&r, false).unwrap(), k2, "a stash must change the key");
        std::fs::remove_dir_all(&r).unwrap();
    }

    #[test]
    fn parses_fetch_output() {
        let b = |n: &str| FfBranch { name: n.into(), remote: "origin".into(), remote_ref: format!("refs/heads/{n}") };
        let branches = [b("main"), b("dev"), b("old"), b("x")];
        let err = "From github.com:o/r\n = [up to date]      main       -> main\n   1a2b3c4..5d6e7f8  dev        -> dev\n ! [rejected]        old        -> old  (non-fast-forward)\n";
        let got = parse_fetch_lines(err, &branches);
        assert_eq!(got, vec![
            ff_result("main", "current", ""),
            ff_result("dev", "updated", ""),
            ff_result("old", "diverged", "non-fast-forward"),
        ]);
    }

    #[test]
    fn fast_forwards_several_branches_in_one_fetch() {
        let base = std::env::temp_dir().join(format!("gittygit-ff-{}-{}", std::process::id(), rand_suffix()));
        std::fs::create_dir_all(&base).unwrap();
        let b = base.to_string_lossy().into_owned();
        run(&b, &["init", "-q", "--bare", "-b", "main", "remote.git"]).unwrap();
        let up = repo();
        run(&up, &["remote", "add", "origin", &format!("{b}/remote.git")]).unwrap();
        commit(&up, "f", "1\n", "A");
        for br in ["ahead", "same", "diverge"] {
            run(&up, &["branch", br]).unwrap();
        }
        run(&up, &["push", "-q", "origin", "--all"]).unwrap();
        run(&b, &["clone", "-q", &format!("{b}/remote.git"), "local"]).unwrap();
        let local = format!("{b}/local");
        run(&local, &["config", "user.name", "T"]).unwrap();
        run(&local, &["config", "user.email", "t@example.com"]).unwrap();
        for br in ["ahead", "same", "diverge"] {
            run(&local, &["branch", br, &format!("origin/{br}")]).unwrap();
        }
        // Upstream moves "ahead" and "diverge"; locally "diverge" gets its own commit.
        for br in ["ahead", "diverge"] {
            run(&up, &["switch", "-q", br]).unwrap();
            commit(&up, "f", &format!("{br}\n"), br);
        }
        run(&up, &["push", "-q", "origin", "--all"]).unwrap();
        run(&local, &["switch", "-q", "diverge"]).unwrap();
        commit(&local, "g", "local\n", "local work");
        run(&local, &["switch", "-q", "main"]).unwrap();

        let ff = |n: &str| FfBranch { name: n.into(), remote: "origin".into(), remote_ref: format!("refs/heads/{n}") };
        let mut res = fast_forward(&local, &[ff("ahead"), ff("same"), ff("diverge"), ff("gone")], &Ctx::default()).unwrap();
        res.sort_by(|a, b| a.name.cmp(&b.name));
        let outcomes: Vec<(&str, &str)> = res.iter().map(|r| (r.name.as_str(), r.outcome.as_str())).collect();
        assert_eq!(outcomes, [("ahead", "updated"), ("diverge", "diverged"), ("gone", "failed"), ("same", "current")]);
        assert_eq!(run(&local, &["rev-parse", "ahead"]).unwrap(), run(&up, &["rev-parse", "ahead"]).unwrap());
        // The current branch is refused by git; reported, the rest unaffected.
        let res = fast_forward(&local, &[ff("main"), ff("ahead")], &Ctx::default()).unwrap();
        assert_eq!(res.iter().find(|r| r.name == "main").unwrap().outcome, "checked-out");
        assert_eq!(res.iter().find(|r| r.name == "ahead").unwrap().outcome, "current");
        std::fs::remove_dir_all(&base).unwrap();
        std::fs::remove_dir_all(&up).unwrap();
    }

    #[test]
    fn searches_all_history_with_positions() {
        let r = repo();
        let a = commit(&r, "f", "1\n", "Fix login bug");
        commit(&r, "f", "2\n", "Add feature\n\nalso touches LOGIN page");
        let c = commit(&r, "f", "3\n", "Unrelated");
        let hits = search(&r, "login", 50).unwrap();
        // Newest first, positions in graph order; the body match counts too.
        assert_eq!(hits.iter().map(|h| h.pos).collect::<Vec<_>>(), [1, 2]);
        assert_eq!(hits[1].sha, a);
        assert_eq!(search(&r, "example.com", 50).unwrap().len(), 3, "author email match");
        assert_eq!(search(&r, &c[..8], 50).unwrap(), vec![SearchHit { sha: c.clone(), pos: 0 }]);
        assert!(search(&r, "  ", 50).unwrap().is_empty());
        assert!(search(&r, "[unclosed", 50).unwrap().is_empty(), "patterns are literal");
        assert!(!has_commit_graph(&r));
        run(&r, &["commit-graph", "write", "--reachable"]).unwrap();
        assert!(has_commit_graph(&r));
        std::fs::remove_dir_all(&r).unwrap();
    }

    #[test]
    fn converts_https_remotes_to_ssh() {
        assert_eq!(https_to_ssh("https://github.com/acme/app.git").as_deref(), Some("git@github.com:acme/app.git"));
        assert_eq!(https_to_ssh("https://bob@gitlab.com/group/sub/app").as_deref(), Some("git@gitlab.com:group/sub/app.git"));
        assert_eq!(https_to_ssh("https://github.com/acme/"), None);
        assert_eq!(https_to_ssh("git@github.com:acme/app.git"), None);
        assert_eq!(https_to_ssh("https://host:8443/a/b"), None, "custom ports need a manual URL");
    }

    #[test]
    fn stores_https_token_with_git_credential_helper() {
        let r = repo();
        let file = Path::new(&r).join("creds");
        // Reset inherited helpers (the user's Keychain) and use a throwaway file store.
        run(&r, &["config", "credential.helper", ""]).unwrap();
        run(&r, &["config", "--add", "credential.helper", &format!("store --file {}", file.display())]).unwrap();
        store_credential(&r, "git.example.com", "bob", "tok-123").unwrap();
        let out = exec_with(&r, &["credential", "fill"], &[0], &Ctx::default(), &[], Some(b"protocol=https\nhost=git.example.com\nusername=bob\n\n")).unwrap();
        assert!(out.contains("password=tok-123"), "{out}");
        assert!(store_credential(&r, "git.example.com", "bob", "a\nb").is_err());
        std::fs::remove_dir_all(&r).unwrap();
    }

    #[test]
    fn lists_remote_tags() {
        let up = repo();
        commit(&up, "f", "1\n", "A");
        run(&up, &["tag", "v1"]).unwrap();
        run(&up, &["tag", "-a", "v2", "-m", "annotated"]).unwrap();
        let local = repo();
        let mut tags = remote_tags(&local, &up, &Ctx::default()).unwrap();
        tags.sort();
        assert_eq!(tags, ["v1", "v2"]);
        std::fs::remove_dir_all(&up).unwrap();
        std::fs::remove_dir_all(&local).unwrap();
    }

    #[test]
    fn compares_revisions_and_working_tree() {
        let r = repo();
        let a = commit(&r, "f", "1\n", "A");
        run(&r, &["switch", "-q", "-c", "topic"]).unwrap();
        commit(&r, "g", "x\n", "topic work");
        run(&r, &["switch", "-q", "main"]).unwrap();
        commit(&r, "f", "2\n", "main work");
        let c = compare(&r, "topic", Some("main")).unwrap();
        assert_eq!(c.only_a.iter().map(|e| e.subject.as_str()).collect::<Vec<_>>(), ["topic work"]);
        assert_eq!(c.only_b.iter().map(|e| e.subject.as_str()).collect::<Vec<_>>(), ["main work"]);
        let mut files: Vec<String> = c.files.iter().map(|f| format!("{}{}", f.status, f.path)).collect();
        files.sort();
        assert_eq!(files, ["Dg", "Mf"]);
        std::fs::write(Path::new(&r).join("f"), "3\n").unwrap();
        let w = compare(&r, &a, None).unwrap();
        assert_eq!(w.only_b.len(), 1, "HEAD is one commit after A");
        assert!(diff(&r, "f", "range", Some(&a), None, false).unwrap().contains("+3"));
        assert!(compare(&r, "--output=x", None).is_err(), "options are not revisions");
        assert!(add_to_gitignore(&r, "*.log").unwrap());
        assert!(!add_to_gitignore(&r, "*.log").unwrap(), "already present");
        assert!(add_to_gitignore(&r, "a\nb").is_err());
        assert_eq!(std::fs::read_to_string(Path::new(&r).join(".gitignore")).unwrap(), "*.log\n");
        std::fs::remove_dir_all(&r).unwrap();
    }

    #[test]
    fn finds_lost_commits() {
        let r = repo();
        commit(&r, "f", "1\n", "A");
        let b = commit(&r, "f", "2\n", "B");
        run(&r, &["reset", "-q", "--hard", "HEAD~1"]).unwrap();
        let log = reflog(&r, 50).unwrap();
        assert!(log.iter().any(|e| e.sha == b && e.action.starts_with("commit")), "reset-away commit is in the reflog");
        assert!(log[0].action.starts_with("reset"), "newest first: {}", log[0].action);
        assert!(log.iter().all(|e| e.time > 0));
        // A dropped stash is only found by the deep scan.
        std::fs::write(Path::new(&r).join("f"), "wip\n").unwrap();
        run(&r, &["stash", "-q"]).unwrap();
        let stash = run(&r, &["rev-parse", "stash@{0}"]).unwrap().trim().to_string();
        run(&r, &["stash", "drop", "-q"]).unwrap();
        assert!(unreachable(&r, 50).unwrap().iter().any(|e| e.sha == stash));
        assert_eq!(default_branch(&r, "origin"), "main");
        std::fs::remove_dir_all(&r).unwrap();
    }

    #[test]
    fn submodules_worktrees_lfs_signing_bisect() {
        let lib = repo();
        commit(&lib, "lib.txt", "v1\n", "lib v1");
        let r = repo();
        commit(&r, "f", "1\n", "A");
        run(&r, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", &lib, "vendor/lib"]).unwrap();
        run(&r, &["commit", "-qm", "add submodule"]).unwrap();
        let subs = submodules(&r).unwrap();
        assert_eq!(subs.len(), 1);
        assert_eq!((subs[0].path.as_str(), subs[0].state.as_str()), ("vendor/lib", "ok"));
        assert_eq!(subs[0].url, lib);
        // Move the submodule: the diff shows commit summaries, not a raw hash line.
        commit(&lib, "lib.txt", "v2\n", "lib v2");
        run(&format!("{r}/vendor/lib"), &["-c", "protocol.file.allow=always", "pull", "-q"]).unwrap();
        assert_eq!(submodules(&r).unwrap()[0].state, "changed");
        assert!(diff(&r, "vendor/lib", "unstaged", None, None, false).unwrap().contains("> lib v2"));

        assert_eq!(lfs(&r), Lfs { used: false, installed: false });
        std::fs::write(Path::new(&r).join(".gitattributes"), "*.psd filter=lfs diff=lfs merge=lfs -text\n").unwrap();
        assert!(lfs(&r).used);

        let wt = format!("{r}-wt");
        run(&r, &["worktree", "add", "-q", "-b", "side", &wt]).unwrap();
        let wts = worktrees(&r).unwrap();
        assert_eq!(wts.len(), 2);
        assert!(wts[0].current && !wts[1].current);
        assert_eq!(wts[1].branch, "side");
        run(&r, &["worktree", "remove", &wt]).unwrap();

        // SSH-signed commit verifies as good with an allowed-signers file.
        let key = format!("{r}/.signing-key");
        let kg = std::process::Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-C", "t@example.com", "-f", &key]).status().unwrap();
        assert!(kg.success());
        let pubkey = std::fs::read_to_string(format!("{key}.pub")).unwrap();
        std::fs::write(format!("{r}/.allowed"), format!("t@example.com {pubkey}")).unwrap();
        let signing = [
            ("gpg.format", "ssh".to_string()),
            ("gpg.ssh.program", "ssh-keygen".to_string()),
            ("user.signingkey", format!("{key}.pub")),
            ("gpg.ssh.allowedSignersFile", format!("{r}/.allowed")),
        ];
        for (k, v) in signing {
            run(&r, &["config", k, &v]).unwrap();
        }
        run(&r, &["commit", "-q", "-S", "--allow-empty", "-m", "signed"]).unwrap();
        let head = run(&r, &["rev-parse", "HEAD"]).unwrap();
        let c = super::commit(&r, head.trim()).unwrap();
        assert_eq!(c.signature.as_deref(), Some("G"));
        assert!(super::commit(&r, &format!("{}^", head.trim())).unwrap().signature.is_none());

        // Bisect: 6 commits, the 4th introduces "bug".
        let b = repo();
        let mut shas = vec![];
        for i in 0..6 {
            shas.push(commit(&b, "f", &format!("{} {i}\n", if i >= 3 { "bug" } else { "ok" }), &format!("c{i}")));
        }
        run(&b, &["bisect", "start"]).unwrap();
        run(&b, &["bisect", "bad", &shas[5]]).unwrap();
        run(&b, &["bisect", "good", &shas[0]]).unwrap();
        let st = repo_state(&b).bisect.unwrap();
        assert!(st.remaining.is_some() && st.found.is_none());
        for _ in 0..5 {
            let st = repo_state(&b).bisect.unwrap();
            if st.found.is_some() {
                break;
            }
            let bug = std::fs::read_to_string(Path::new(&b).join("f")).unwrap().starts_with("bug");
            run(&b, &["bisect", if bug { "bad" } else { "good" }]).unwrap();
        }
        assert_eq!(repo_state(&b).bisect.unwrap().found.as_deref(), Some(shas[3].as_str()));
        run(&b, &["bisect", "reset"]).unwrap();
        assert!(repo_state(&b).bisect.is_none());
        for d in [&lib, &r, &b] {
            std::fs::remove_dir_all(d).unwrap();
        }
    }
}
