//! Thin wrapper around the git CLI.
//!
//! GitKraken ships its own git (app.asar.unpacked/git) and drives it through a
//! Rust spawn server, with libgit2 (nodegit) for hot read paths. We keep a single
//! engine: the user's git binary, run off the main thread with prompts disabled.

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
    let out = cmd.output().map_err(|e| format!("failed to run git: {e}"))?;
    let code = out.status.code().unwrap_or(-1);
    if ok_codes.contains(&code) {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let msg = if err.is_empty() {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            err
        };
        Err(if msg.is_empty() { format!("git exited with {code}") } else { msg })
    }
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

// ---------------------------------------------------------------- status

#[derive(Serialize, Clone)]
pub struct FileChange {
    pub path: String,
    pub status: String,
    pub orig: Option<String>,
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
            st.conflicted.push(FileChange { path, status: "U".into(), orig });
            continue;
        }
        if xy == "??" {
            st.unstaged.push(FileChange { path, status: "?".into(), orig: None });
            continue;
        }
        if x != " " {
            st.staged.push(FileChange { path: path.clone(), status: x.into(), orig: orig.clone() });
        }
        if y != " " {
            st.unstaged.push(FileChange { path, status: y.into(), orig: None });
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
    let names = run(repo, &args)?;
    let mut files = vec![];
    let mut it = names.split('\0').filter(|s| !s.is_empty());
    while let Some(st) = it.next() {
        let code = &st[0..1];
        if code == "R" || code == "C" {
            let orig = it.next().map(String::from);
            if let Some(p) = it.next() {
                files.push(FileChange { path: p.into(), status: code.into(), orig });
            }
        } else if let Some(p) = it.next() {
            files.push(FileChange { path: p.into(), status: code.into(), orig: None });
        }
    }
    Ok(CommitDetail {
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

// ---------------------------------------------------------------- diffs

pub fn diff(repo: &str, path: &str, mode: &str, sha: Option<&str>, untracked: bool) -> R<String> {
    match mode {
        "unstaged" if untracked => run_codes(repo, &["diff", "--no-color", "--no-index", "--", "/dev/null", path], &[0, 1]),
        "unstaged" => run(repo, &["diff", "--no-color", "--", path]),
        "staged" => run(repo, &["diff", "--no-color", "--cached", "--", path]),
        "commit" => {
            let sha = sha.ok_or("missing sha")?;
            let first_parent = run(repo, &["rev-parse", "-q", "--verify", &format!("{sha}^1")]).ok();
            match first_parent {
                Some(p) => run(repo, &["diff", "--no-color", "-M", p.trim(), sha, "--", path]),
                None => run(repo, &["show", "--no-color", "--format=", sha, "--", path]),
            }
        }
        _ => Err(format!("unknown diff mode {mode}")),
    }
}
