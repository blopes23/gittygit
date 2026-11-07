//! Optional local AI (Ollama) that drafts commit messages and pull request descriptions.
//!
//! Requests go to the Ollama address set in Settings (localhost by default) through macOS's own
//! `curl`, like the GitHub requests; the diff is sent nowhere else. Large changes are trimmed to
//! a budget first: a local model reads ~500 tokens/s, so a whole 200k-token branch would take
//! minutes and overflow its context.

use crate::git::{self, R};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::Mutex;

/// The curl process of the generation in progress, so Stop can end it.
static RUNNING: Mutex<Option<u32>> = Mutex::new(None);

fn check_url(url: &str) -> R<String> {
    let url = url.trim().trim_end_matches('/');
    if !(url.starts_with("http://") || url.starts_with("https://")) || url.contains(char::is_whitespace) {
        return Err(format!("{url} isn't an http(s) address"));
    }
    Ok(url.to_string())
}

/// Models installed in Ollama ("gemma4:26b", …); an error when it isn't reachable.
pub fn models(url: &str) -> R<Vec<String>> {
    let url = check_url(url)?;
    let out = Command::new("/usr/bin/curl")
        .args(["-sS", "--max-time", "3", &format!("{url}/api/tags")])
        .output()
        .map_err(|e| format!("failed to run curl: {e}"))?;
    if !out.status.success() {
        return Err(format!("Ollama isn't reachable at {url}"));
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|_| format!("{url} doesn't look like Ollama"))?;
    let mut names: Vec<String> = v["models"].as_array().into_iter().flatten().filter_map(|m| m["name"].as_str().map(String::from)).collect();
    names.sort();
    Ok(names)
}

/// Streams a completion, calling `on_text` with each piece; returns the whole text.
pub fn generate(url: &str, model: &str, prompt: &str, on_text: impl Fn(&str)) -> R<String> {
    let url = check_url(url)?;
    let body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "stream": true,
        // Thinking models would otherwise spend most of the time on hidden reasoning.
        "think": false,
        "keep_alive": "15m",
        "options": { "num_ctx": 16384, "temperature": 0.2 },
    });
    let mut child = Command::new("/usr/bin/curl")
        .args(["-sS", "-N", "--max-time", "600", "-H", "Content-Type: application/json", "--data-binary", "@-", &format!("{url}/api/generate")])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to run curl: {e}"))?;
    *RUNNING.lock().unwrap() = Some(child.id());
    child.stdin.take().expect("piped").write_all(body.to_string().as_bytes()).map_err(|e| e.to_string())?;
    let mut text = String::new();
    let mut error = None;
    for line in BufReader::new(child.stdout.take().expect("piped")).lines() {
        let Ok(line) = line else { break };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        if let Some(e) = v["error"].as_str() {
            error = Some(e.to_string());
            break;
        }
        if let Some(piece) = v["response"].as_str().filter(|p| !p.is_empty()) {
            text.push_str(piece);
            on_text(piece);
        }
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let stopped = RUNNING.lock().unwrap().take().is_none();
    if let Some(e) = error {
        return Err(format!("Ollama: {e}"));
    }
    if stopped {
        return Err("stopped".into());
    }
    if !out.status.success() && text.is_empty() {
        let msg = String::from_utf8_lossy(&out.stderr);
        return Err(if msg.contains("Couldn't connect") || msg.contains("Failed to connect") {
            format!("Ollama isn't running at {url} (open the Ollama app)")
        } else {
            msg.trim().to_string()
        });
    }
    Ok(text)
}

/// Ends the generation in progress, if any.
pub fn stop() {
    if let Some(pid) = RUNNING.lock().unwrap().take() {
        unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    }
}

// ---------------------------------------------------------------- what the model reads

/// Files whose contents say nothing a reader needs (lockfiles, minified or generated output).
fn is_noise(path: &str) -> bool {
    const LOCKS: [&str; 9] = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "Gemfile.lock", "composer.lock", "poetry.lock", "go.sum", "bun.lockb"];
    let name = path.rsplit('/').next().unwrap_or(path);
    LOCKS.contains(&name)
        || [".min.js", ".min.css", ".map", ".snap"].iter().any(|s| name.ends_with(s))
        || ["dist/", "build/", "vendor/", "node_modules/"].iter().any(|d| path.starts_with(d) || path.contains(&format!("/{d}")))
}

/// A unified diff cut to about `budget` bytes: every file keeps its header and an equal share
/// of lines, so a few huge files can't push all the others out.
fn trim_diff(diff: &str, budget: usize) -> String {
    let mut files: Vec<&str> = vec![];
    let mut start = None;
    for (i, _) in diff.match_indices("diff --git ") {
        if i == 0 || diff.as_bytes()[i - 1] == b'\n' {
            if let Some(s) = start {
                files.push(&diff[s..i]);
            }
            start = Some(i);
        }
    }
    if let Some(s) = start {
        files.push(&diff[s..]);
    }
    let files: Vec<String> = files
        .into_iter()
        .map(|f| {
            let path = f.lines().next().and_then(|l| l.rsplit(" b/").next()).unwrap_or("");
            if is_noise(path) {
                format!("{}\n(contents omitted)\n", f.lines().next().unwrap_or(""))
            } else {
                f.to_string()
            }
        })
        .collect();
    let total: usize = files.iter().map(String::len).sum();
    if total <= budget {
        return files.concat();
    }
    let share = (budget / files.len().max(1)).max(400);
    let mut out = String::new();
    for (i, f) in files.iter().enumerate() {
        if out.len() + 200 > budget {
            out.push_str(&format!("({} more files not shown; see the file list)\n", files.len() - i));
            break;
        }
        if f.len() <= share {
            out.push_str(f);
            continue;
        }
        let mut cut = share.min(f.len());
        while !f.is_char_boundary(cut) {
            cut -= 1;
        }
        let kept = &f[..f[..cut].rfind('\n').map_or(cut, |n| n + 1)];
        out.push_str(kept);
        out.push_str(&format!("… ({} more lines in this file)\n", f[kept.len()..].lines().count()));
    }
    out
}

/// Numstat lines ("12  3  src/x.ts"), capped so thousands of files stay readable.
fn file_list(repo: &str, range: &[&str]) -> R<String> {
    let mut args = vec!["diff", "--numstat", "-M"];
    args.extend_from_slice(range);
    let out = git::run(repo, &args)?;
    let lines: Vec<&str> = out.lines().collect();
    let mut s: String = lines.iter().take(MAX_FILES).map(|l| format!("{}\n", l.replace('\t', "  "))).collect();
    if lines.len() > MAX_FILES {
        s.push_str(&format!("… and {} more files\n", lines.len() - MAX_FILES));
    }
    Ok(s)
}

// Bytes of diff (~4 per token). With the file list and commits, a pull request stays under
// ~12k tokens, inside the 16k context and ~20 s of reading on an M3 Pro.
const COMMIT_BUDGET: usize = 20_000;
const PR_BUDGET: usize = 30_000;
const MAX_FILES: usize = 150;

/// What to write a commit message from: the branch, its recent messages (for their style),
/// the staged files and their trimmed diff.
pub fn commit_context(repo: &str) -> R<String> {
    let staged = git::run(repo, &["diff", "--cached", "--name-only"])?;
    if staged.trim().is_empty() {
        return Err("Stage the changes to describe first.".into());
    }
    let branch = git::run(repo, &["branch", "--show-current"]).unwrap_or_default();
    let recent = git::run(repo, &["log", "-12", "--no-merges", "--format=%s"]).unwrap_or_default();
    let diff = git::run(repo, &["diff", "--cached", "-M", "--no-color", "-U2"])?;
    Ok(format!(
        "Branch: {}\n\nRecent commit messages in this repository:\n{}\nStaged files (added/removed lines):\n{}\nDiff:\n{}",
        branch.trim(),
        recent,
        file_list(repo, &["--cached"])?,
        trim_diff(&diff, COMMIT_BUDGET)
    ))
}

/// What to write a pull request from: the branch's commits, files and trimmed diff since it
/// left `base` (the branch the pull request goes into), as GitHub's compare page shows them.
pub fn pr_context(repo: &str, branch: &str, base: &str) -> R<String> {
    let fork = git::run(repo, &["merge-base", base, branch]).map_err(|_| format!("{branch} and {base} have no common history"))?;
    let fork = fork.trim();
    let commits = git::run(repo, &["log", "-60", "--no-merges", "--format=- %s", &format!("{fork}..{branch}")])?;
    if commits.trim().is_empty() {
        return Err(format!("{branch} has no commits that aren't in {base}."));
    }
    let diff = git::run(repo, &["diff", "-M", "--no-color", "-U2", fork, branch])?;
    Ok(format!(
        "Branch: {branch}\nInto: {base}\n\nCommits:\n{commits}\nChanged files (added/removed lines):\n{}\nDiff:\n{}",
        file_list(repo, &[fork, branch])?,
        trim_diff(&diff, PR_BUDGET)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diffs_are_trimmed_fairly() {
        let file = |name: &str, lines: usize| {
            let body: String = (0..lines).map(|i| format!("+line {i}\n")).collect();
            format!("diff --git a/{name} b/{name}\n--- a/{name}\n+++ b/{name}\n@@ -0,0 +1,{lines} @@\n{body}")
        };
        let diff = file("small.rs", 3) + &file("package-lock.json", 5000) + &file("huge.rs", 5000);
        let out = trim_diff(&diff, 4000);
        assert!(out.len() < 4500);
        assert!(out.contains("+line 2\n"), "small files stay whole");
        assert!(out.contains("package-lock.json\n(contents omitted)"));
        assert!(out.contains("more lines in this file"));
        assert_eq!(trim_diff(&file("a", 2), 4000), file("a", 2));
        assert!(check_url("file:///etc/passwd").is_err());
        assert!(check_url("http://localhost:11434/").unwrap().ends_with("11434"));
    }
}
