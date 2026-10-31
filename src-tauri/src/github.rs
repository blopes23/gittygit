//! GitHub pull requests for the sidebar and branch badges.
//!
//! Requests go through macOS's own `curl` (no extra HTTP stack in the app); an optional
//! per-profile token is read from the Keychain and handed to curl on stdin, never in argv.
//! Without a token, public repositories still work within GitHub's anonymous rate limit.

use crate::git::{self, R};
use serde::Serialize;
use std::io::Write;
use std::process::{Command, Stdio};

const SERVICE: &str = "dev.gittygit.github";

/// "owner/repo" for a github.com remote URL (https, ssh:// or scp-like), if it is one.
pub fn slug(url: &str) -> Option<String> {
    let (host, path) = if let Some(rest) = url.strip_prefix("https://").or_else(|| url.strip_prefix("ssh://")) {
        let (hostpart, path) = rest.split_once('/')?;
        (hostpart.rsplit('@').next()?.split(':').next()?, path)
    } else {
        let (hostpart, path) = url.split_once(':')?;
        (hostpart.rsplit('@').next()?, path)
    };
    if !host.eq_ignore_ascii_case("github.com") {
        return None;
    }
    let mut parts = path.trim_matches('/').trim_end_matches(".git").split('/');
    let (owner, repo) = (parts.next()?, parts.next()?);
    if owner.is_empty() || repo.is_empty() || parts.next().is_some() {
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

// ---------------------------------------------------------------- token storage

/// Tests and the dev bridge (GITTYGIT_CONFIG_DIR set) keep tokens in a file, not the Keychain.
fn test_store() -> Option<std::path::PathBuf> {
    std::env::var_os("GITTYGIT_CONFIG_DIR").map(|d| std::path::PathBuf::from(d).join("github-tokens.json"))
}

pub fn get_token(profile: &str) -> Option<String> {
    if let Some(p) = test_store() {
        let map: std::collections::HashMap<String, String> = serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()?;
        return map.get(profile).cloned();
    }
    security_framework::passwords::get_generic_password(SERVICE, profile).ok().and_then(|b| String::from_utf8(b).ok())
}

/// Save (or with an empty token, remove) a profile's GitHub token.
pub fn set_token(profile: &str, token: &str) -> R<()> {
    let token = token.trim();
    if token.contains(char::is_whitespace) {
        return Err("a token can't contain spaces".into());
    }
    if let Some(p) = test_store() {
        let mut map: std::collections::HashMap<String, String> =
            std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        if token.is_empty() {
            map.remove(profile);
        } else {
            map.insert(profile.into(), token.into());
        }
        return std::fs::write(p, serde_json::to_string(&map).unwrap()).map_err(|e| e.to_string());
    }
    use security_framework::passwords::{delete_generic_password, set_generic_password};
    if token.is_empty() {
        let _ = delete_generic_password(SERVICE, profile);
        return Ok(());
    }
    set_generic_password(SERVICE, profile, token.as_bytes()).map_err(|e| format!("couldn't save to the Keychain: {e}"))
}

// ---------------------------------------------------------------- API

/// GET an api.github.com path; returns (HTTP status, body).
fn api_get(path: &str, token: Option<&str>) -> R<(u16, String)> {
    let mut headers = String::from("Accept: application/vnd.github+json\nX-GitHub-Api-Version: 2022-11-28\nUser-Agent: Gittygit\n");
    if let Some(t) = token {
        headers.push_str(&format!("Authorization: Bearer {t}\n"));
    }
    let url = format!("https://api.github.com{path}");
    let mut child = Command::new("/usr/bin/curl")
        .args(["-sS", "--max-time", "15", "-H", "@-", "-w", "\n%{http_code}", &url])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to run curl: {e}"))?;
    child.stdin.take().expect("piped").write_all(headers.as_bytes()).map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let (body, code) = text.rsplit_once('\n').ok_or("unexpected curl output")?;
    Ok((code.trim().parse().unwrap_or(0), body.to_string()))
}

#[derive(Serialize, Clone)]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub author: String,
    pub head_ref: String,
    /// "owner/repo" the head branch lives in (differs from the base repo for forks).
    pub head_repo: String,
    pub head_sha: String,
    pub base_ref: String,
    pub draft: bool,
    pub url: String,
    /// "success" | "failure" | "pending", or None when the commit has no checks.
    pub checks: Option<String>,
}

#[derive(Serialize)]
pub struct PullRequests {
    pub slug: String,
    pub authed: bool,
    pub prs: Vec<PullRequest>,
}

fn s(v: &serde_json::Value, path: &[&str]) -> String {
    path.iter().fold(v, |v, k| &v[*k]).as_str().unwrap_or_default().to_string()
}

/// Summarise a commit's check runs: any failure wins, then anything still running.
fn checks(slug: &str, sha: &str, token: Option<&str>) -> Option<String> {
    let (code, body) = api_get(&format!("/repos/{slug}/commits/{sha}/check-runs?per_page=100"), token).ok()?;
    if code != 200 {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(&body).ok()?;
    let runs = v["check_runs"].as_array()?;
    if runs.is_empty() {
        return None;
    }
    let failed = runs.iter().any(|r| matches!(r["conclusion"].as_str(), Some("failure" | "cancelled" | "timed_out" | "action_required")));
    let pending = runs.iter().any(|r| r["status"].as_str() != Some("completed"));
    Some(if failed { "failure" } else if pending { "pending" } else { "success" }.into())
}

/// Open pull requests of the repository's GitHub remote (`remote`, usually origin), with
/// CI status for the most recent ones.
pub fn pull_requests(repo: &str, remote: &str, profile: &str) -> R<PullRequests> {
    let url = git::remote_urls(repo).into_iter().find(|(n, _)| n == remote).map(|(_, u)| u).ok_or("no such remote")?;
    let slug = slug(&url).ok_or("not a GitHub repository")?;
    let token = get_token(profile);
    let (code, body) = api_get(&format!("/repos/{slug}/pulls?state=open&per_page=50&sort=updated&direction=desc"), token.as_deref())?;
    match code {
        200 => {}
        401 => return Err("GitHub rejected the saved token (expired or revoked?). Update it in Profiles.".into()),
        403 | 429 => return Err("GitHub's rate limit was reached. Add a token in Profiles to raise it.".into()),
        404 => return Err(if token.is_some() { "The token has no access to this repository.".into() } else { "Private repository: add a GitHub token in Profiles to see its pull requests.".into() }),
        c => return Err(format!("GitHub answered {c}")),
    }
    let list: Vec<serde_json::Value> = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let mut prs: Vec<PullRequest> = list
        .iter()
        .map(|p| PullRequest {
            number: p["number"].as_u64().unwrap_or(0),
            title: s(p, &["title"]),
            author: s(p, &["user", "login"]),
            head_ref: s(p, &["head", "ref"]),
            head_repo: s(p, &["head", "repo", "full_name"]),
            head_sha: s(p, &["head", "sha"]),
            base_ref: s(p, &["base", "ref"]),
            draft: p["draft"].as_bool().unwrap_or(false),
            url: s(p, &["html_url"]),
            checks: None,
        })
        .collect();
    // CI status for the 15 most recently updated, fetched in parallel.
    let t = token.clone();
    let handles: Vec<_> = prs
        .iter()
        .take(15)
        .map(|p| {
            let (slug, sha, t) = (slug.clone(), p.head_sha.clone(), t.clone());
            std::thread::spawn(move || checks(&slug, &sha, t.as_deref()))
        })
        .collect();
    for (p, h) in prs.iter_mut().zip(handles) {
        p.checks = h.join().ok().flatten();
    }
    Ok(PullRequests { slug, authed: token.is_some(), prs })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_github_slugs() {
        assert_eq!(slug("git@github.com:blopes23/gittygit.git").as_deref(), Some("blopes23/gittygit"));
        assert_eq!(slug("https://github.com/acme/app").as_deref(), Some("acme/app"));
        assert_eq!(slug("https://bob@github.com/acme/app.git/").as_deref(), Some("acme/app"));
        assert_eq!(slug("ssh://git@github.com/acme/app.git").as_deref(), Some("acme/app"));
        assert_eq!(slug("git@gitlab.com:acme/app.git"), None);
        assert_eq!(slug("../local.git"), None);
    }
}
