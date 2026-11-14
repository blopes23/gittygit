//! Code hosts with pull/merge requests: GitHub (github.rs) and GitLab (here, gitlab.com or a
//! self-hosted server set in the profile). Both answer the frontend in the same shapes, so the
//! pull request list, view and actions don't care which one a repository lives on.
//!
//! Requests go through macOS's own `curl`; tokens are read from the Keychain and handed to curl
//! on stdin with the headers, never in argv.

use crate::git::{self, R};
use crate::github::{self, PullRequest, PullRequests};
use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};

// ---------------------------------------------------------------- HTTP

/// One HTTPS request; `headers` are "Name: value" lines (they may hold a token). A JSON body
/// (never secret) goes through a private temporary file. Returns (HTTP status, body).
pub fn request(method: &str, url: &str, headers: &str, json: Option<&Value>) -> R<(u16, String)> {
    let mut headers = headers.to_string();
    let body_file = match json {
        Some(v) => {
            use std::os::unix::fs::OpenOptionsExt;
            static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let f = std::env::temp_dir().join(format!("gittygit-api-{}-{n}.json", std::process::id()));
            let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&f).map_err(|e| e.to_string())?;
            file.write_all(v.to_string().as_bytes()).map_err(|e| e.to_string())?;
            headers.push_str("Content-Type: application/json\n");
            Some(f)
        }
        None => None,
    };
    let data = body_file.as_ref().map(|f| format!("@{}", f.display()));
    let mut args = vec!["-sS", "--max-time", "20", "-X", method, "-H", "@-", "-w", "\n%{http_code}"];
    if let Some(d) = &data {
        args.extend(["--data-binary", d.as_str()]);
    }
    args.push(url);
    let child = Command::new("/usr/bin/curl")
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to run curl: {e}"));
    let out = child.and_then(|mut child| {
        child.stdin.take().expect("piped").write_all(headers.as_bytes()).map_err(|e| e.to_string())?;
        child.wait_with_output().map_err(|e| e.to_string())
    });
    if let Some(f) = body_file {
        let _ = std::fs::remove_file(f);
    }
    let out = out?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let (body, code) = text.rsplit_once('\n').ok_or("unexpected curl output")?;
    Ok((code.trim().parse().unwrap_or(0), body.to_string()))
}

// ---------------------------------------------------------------- tokens

/// Tests and the dev bridge (GITTYGIT_CONFIG_DIR set) keep tokens in a file, not the Keychain.
fn test_store() -> Option<std::path::PathBuf> {
    std::env::var_os("GITTYGIT_CONFIG_DIR").map(|d| std::path::PathBuf::from(d).join("tokens.json"))
}

pub fn secret_get(service: &str, account: &str) -> Option<String> {
    if let Some(p) = test_store() {
        let map: std::collections::HashMap<String, String> = serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()?;
        return map.get(&format!("{service}/{account}")).cloned();
    }
    security_framework::passwords::get_generic_password(service, account).ok().and_then(|b| String::from_utf8(b).ok())
}

/// Save (or with an empty value, remove) a token.
pub fn secret_set(service: &str, account: &str, token: &str) -> R<()> {
    let token = token.trim();
    if token.contains(char::is_whitespace) {
        return Err("a token can't contain spaces".into());
    }
    if let Some(p) = test_store() {
        let mut map: std::collections::HashMap<String, String> =
            std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        let key = format!("{service}/{account}");
        if token.is_empty() {
            map.remove(&key);
        } else {
            map.insert(key, token.into());
        }
        return std::fs::write(p, serde_json::to_string(&map).unwrap()).map_err(|e| e.to_string());
    }
    use security_framework::passwords::{delete_generic_password, set_generic_password};
    if token.is_empty() {
        let _ = delete_generic_password(service, account);
        return Ok(());
    }
    set_generic_password(service, account, token.as_bytes()).map_err(|e| format!("couldn't save to the Keychain: {e}"))
}

const GITLAB_SERVICE: &str = "dev.gittygit.gitlab";

pub fn gitlab_token(profile: &str, host: &str) -> Option<String> {
    secret_get(GITLAB_SERVICE, &format!("{profile}@{host}"))
}

pub fn set_gitlab_token(profile: &str, host: &str, token: &str) -> R<()> {
    secret_set(GITLAB_SERVICE, &format!("{profile}@{host}"), token)
}

/// A bare host name ("gitlab.com", "git.acme.io:8443"), lowercased; empty means gitlab.com.
pub fn gitlab_host(h: &str) -> R<String> {
    let h = h.trim().trim_start_matches("https://").trim_end_matches('/').to_lowercase();
    if h.is_empty() {
        return Ok("gitlab.com".into());
    }
    if !h.chars().all(|c| c.is_ascii_alphanumeric() || ".-:".contains(c)) || h.starts_with('-') {
        return Err(format!("{h} isn't a host name (like gitlab.com or git.acme.io)"));
    }
    Ok(h)
}

// ---------------------------------------------------------------- which host

pub enum Forge {
    GitHub,
    GitLab { host: String, path: String },
}

/// Host and path of a remote URL (https, ssh:// or scp-like).
fn host_path(url: &str) -> Option<(String, String)> {
    let (host, path) = if let Some(rest) = url.strip_prefix("https://").or_else(|| url.strip_prefix("ssh://")).or_else(|| url.strip_prefix("http://")) {
        let (hostpart, path) = rest.split_once('/')?;
        let host = hostpart.rsplit('@').next()?;
        // ssh://git@host:2222/… is a port; https://host:8443/… too (kept for the API).
        (if url.starts_with("ssh://") { host.split(':').next()? } else { host }, path)
    } else {
        let (hostpart, path) = url.split_once(':')?;
        (hostpart.rsplit('@').next()?, path)
    };
    let path = path.trim_matches('/').trim_end_matches(".git").to_string();
    (!path.is_empty() && path.contains('/')).then(|| (host.to_lowercase(), path))
}

/// The code host of a repository's `remote`: GitHub, or GitLab when the remote is on gitlab.com
/// or the profile's GitLab server.
pub fn forge(repo: &str, remote: &str, gitlab: &str) -> R<Forge> {
    let url = git::remote_urls(repo).into_iter().find(|(n, _)| n == remote).map(|(_, u)| u).ok_or("no such remote")?;
    if github::slug(&url).is_some() {
        return Ok(Forge::GitHub);
    }
    let gitlab = gitlab_host(gitlab).unwrap_or_else(|_| "gitlab.com".into());
    match host_path(&url) {
        Some((host, path)) if host == "gitlab.com" || host == gitlab || host.split(':').next() == gitlab.split(':').next() => {
            Ok(Forge::GitLab { host: if host == "gitlab.com" { host } else { gitlab }, path })
        }
        _ => Err("not a GitHub or GitLab repository".into()),
    }
}

// ---------------------------------------------------------------- GitLab

struct Lab {
    api: String,
    project: String,
    host: String,
    token: Option<String>,
}

impl Lab {
    fn new(host: &str, path: &str, profile: &str) -> Lab {
        Lab {
            api: format!("https://{host}/api/v4"),
            project: path.replace('/', "%2F"),
            host: host.into(),
            token: gitlab_token(profile, host),
        }
    }

    fn call(&self, method: &str, path: &str, json: Option<&Value>) -> R<(u16, String)> {
        let mut headers = String::from("Accept: application/json\nUser-Agent: Gittygit\n");
        if let Some(t) = &self.token {
            headers.push_str(&format!("PRIVATE-TOKEN: {t}\n"));
        }
        request(method, &format!("{}{path}", self.api), &headers, json)
    }

    fn get(&self, path: &str) -> R<Value> {
        let (code, body) = self.call("GET", path, None)?;
        if code != 200 {
            return Err(self.error(code, &body));
        }
        serde_json::from_str(&body).map_err(|e| e.to_string())
    }

    fn mr(&self, iid: u64) -> String {
        format!("/projects/{}/merge_requests/{iid}", self.project)
    }

    fn error(&self, code: u16, body: &str) -> String {
        let v: Value = serde_json::from_str(body).unwrap_or_default();
        let msg = match &v["message"] {
            Value::String(s) => s.clone(),
            Value::Null => v["error"].as_str().unwrap_or("").to_string(),
            other => other.to_string(),
        };
        match code {
            401 if self.token.is_some() => format!("{} rejected the saved token (expired or revoked?). Update it in Profiles.", self.host),
            401 | 404 if self.token.is_none() => format!("Private project: add a GitLab token for {} in Profiles.", self.host),
            403 => format!("The token isn't allowed to do this{}. It needs the \"api\" scope and at least Developer access.", if msg.is_empty() { String::new() } else { format!(" ({msg})") }),
            404 => "The token has no access to this project.".into(),
            429 => format!("{}'s rate limit was reached. Try again in a minute.", self.host),
            _ if !msg.is_empty() => msg,
            c => format!("{} answered {c}", self.host),
        }
    }
}

const FAILED: [&str; 2] = ["failed", "canceled"];

/// GitLab's pipeline status as the list's "success" | "failure" | "pending".
fn pipeline_state(status: &str) -> Option<String> {
    match status {
        "" => None,
        "success" => Some("success".into()),
        s if FAILED.contains(&s) => Some("failure".into()),
        "skipped" | "manual" => None,
        _ => Some("pending".into()),
    }
}

fn s(v: &Value, path: &[&str]) -> String {
    path.iter().fold(v, |v, k| &v[*k]).as_str().unwrap_or_default().to_string()
}

fn gl_list(host: &str, path: &str, profile: &str) -> R<PullRequests> {
    let lab = Lab::new(host, path, profile);
    let list = lab.get(&format!("/projects/{}/merge_requests?state=opened&per_page=50&order_by=updated_at", lab.project))?;
    let project_id = lab.get(&format!("/projects/{}", lab.project)).ok().and_then(|p| p["id"].as_u64());
    let mut prs: Vec<PullRequest> = list
        .as_array()
        .into_iter()
        .flatten()
        .map(|m| PullRequest {
            number: m["iid"].as_u64().unwrap_or(0),
            title: s(m, &["title"]),
            author: s(m, &["author", "username"]),
            head_ref: s(m, &["source_branch"]),
            // A fork's merge request: anything but this project's path marks it as one.
            head_repo: if project_id.is_some() && m["source_project_id"].as_u64() != project_id { "fork".into() } else { path.into() },
            head_sha: s(m, &["sha"]),
            base_ref: s(m, &["target_branch"]),
            draft: m["draft"].as_bool().or(m["work_in_progress"].as_bool()).unwrap_or(false),
            url: s(m, &["web_url"]),
            checks: None,
        })
        .collect();
    // Pipeline status for the 15 most recently updated, fetched in parallel.
    let handles: Vec<_> = prs
        .iter()
        .take(15)
        .map(|p| {
            let (host, path, profile, iid) = (host.to_string(), path.to_string(), profile.to_string(), p.number);
            std::thread::spawn(move || {
                let lab = Lab::new(&host, &path, &profile);
                lab.get(&lab.mr(iid)).ok().and_then(|m| pipeline_state(&s(&m, &["head_pipeline", "status"])))
            })
        })
        .collect();
    for (p, h) in prs.iter_mut().zip(handles) {
        p.checks = h.join().ok().flatten();
    }
    Ok(PullRequests { slug: path.into(), authed: lab.token.is_some(), prs, forge: "gitlab".into(), host: host.into() })
}

/// The merge request in the same shape as GitHub's pull request detail (see github::pr_detail).
fn gl_detail(host: &str, path: &str, profile: &str, iid: u64) -> R<Value> {
    let lab = Lab::new(host, path, profile);
    let m = lab.get(&lab.mr(iid))?;
    let mr = lab.mr(iid);
    let (notes, project, approvals) = std::thread::scope(|sc| {
        let n = sc.spawn(|| lab.get(&format!("{mr}/notes?sort=asc&order_by=created_at&per_page=100")));
        let p = sc.spawn(|| lab.get(&format!("/projects/{}", lab.project)));
        let a = sc.spawn(|| lab.get(&format!("{mr}/approvals")));
        (n.join().ok().and_then(Result::ok), p.join().ok().and_then(Result::ok), a.join().ok().and_then(Result::ok))
    });
    let project = project.unwrap_or_default();
    let pipeline = m["head_pipeline"]["id"].as_u64();
    let jobs = pipeline
        .and_then(|id| lab.get(&format!("/projects/{}/pipelines/{id}/jobs?per_page=100", lab.project)).ok())
        .unwrap_or_default();
    let checks: Vec<Value> = jobs
        .as_array()
        .into_iter()
        .flatten()
        .map(|j| {
            let st = s(j, &["status"]);
            let (status, conclusion) = match st.as_str() {
                "success" => ("completed", "success"),
                "failed" if j["allow_failure"].as_bool() == Some(true) => ("completed", "neutral"),
                "failed" => ("completed", "failure"),
                "canceled" => ("completed", "cancelled"),
                "skipped" | "manual" => ("completed", "skipped"),
                _ => ("in_progress", ""),
            };
            json!({ "name": format!("{} · {}", s(j, &["stage"]), s(j, &["name"])), "status": status, "conclusion": conclusion, "url": j["web_url"] })
        })
        .collect();
    let mut timeline: Vec<Value> = vec![];
    for n in notes.as_ref().and_then(Value::as_array).into_iter().flatten() {
        let body = s(n, &["body"]);
        let author = s(n, &["author", "username"]);
        if n["system"].as_bool() != Some(true) {
            timeline.push(json!({ "kind": "comment", "author": author, "body": body, "at": n["created_at"] }));
        } else if body == "approved this merge request" {
            timeline.push(json!({ "kind": "review", "author": author, "state": "APPROVED", "body": "", "at": n["created_at"] }));
        } else if body.starts_with("requested changes") {
            timeline.push(json!({ "kind": "review", "author": author, "state": "CHANGES_REQUESTED", "body": "", "at": n["created_at"] }));
        }
    }
    let (state, merged) = match s(&m, &["state"]).as_str() {
        "opened" => ("open", false),
        "merged" => ("closed", true),
        _ => ("closed", false),
    };
    let status = m["detailed_merge_status"].as_str().unwrap_or("");
    let mergeable_state = match status {
        "mergeable" => Value::from("clean"),
        "conflict" | "broken_status" => "dirty".into(),
        "need_rebase" => "behind".into(),
        "draft_status" => "draft".into(),
        "checking" | "unchecked" | "preparing" | "" => Value::Null,
        _ => "blocked".into(),
    };
    let squash_option = project["squash_option"].as_str().unwrap_or("default_off");
    let mut methods = vec![];
    if squash_option != "always" {
        methods.push("merge");
    }
    if squash_option != "never" {
        methods.push("squash");
    }
    let approved_by: Vec<String> = approvals.as_ref().and_then(|a| a["approved_by"].as_array().cloned()).unwrap_or_default().iter().map(|a| s(a, &["user", "username"])).collect();
    let fork = m["source_project_id"] != m["target_project_id"];
    Ok(json!({
        "forge": "gitlab",
        "number": iid,
        "title": m["title"],
        "body": m["description"],
        "author": s(&m, &["author", "username"]),
        "state": state,
        "merged": merged,
        "draft": m["draft"].as_bool().unwrap_or(false),
        "url": m["web_url"],
        "head_ref": s(&m, &["source_branch"]),
        "head_repo": if fork { "fork".to_string() } else { path.to_string() },
        "head_sha": s(&m, &["sha"]),
        "base_ref": s(&m, &["target_branch"]),
        "slug": path,
        "mergeable": status == "mergeable",
        "mergeable_state": mergeable_state,
        "additions": Value::Null,
        "deletions": Value::Null,
        "changed_files": m["changes_count"].as_str().and_then(|c| c.trim_end_matches('+').parse::<u64>().ok()),
        "commits": Value::Null,
        "created_at": m["created_at"],
        "requested": m["reviewers"].as_array().into_iter().flatten().map(|u| s(u, &["username"])).collect::<Vec<_>>(),
        "approved_by": approved_by,
        "labels": m["labels"],
        "checks": checks,
        "timeline": timeline,
        "merge_methods": methods,
        "delete_branch_on_merge": m["force_remove_source_branch"].as_bool().or(project["remove_source_branch_after_merge"].as_bool()).unwrap_or(false),
        "authed": lab.token.is_some(),
        "fetch_ref": format!("merge-requests/{iid}/head"),
        // gitlab.com shows comments only to signed-in users, even on public projects.
        "timeline_hidden": notes.is_none(),
        // GitLab's free tier has no review verdict besides approving.
        "actions": ["approve", "comment", "merge", "close"],
    }))
}

fn gl_action(host: &str, path: &str, profile: &str, iid: u64, action: &str, body: &str, method: &str, delete_branch: bool) -> R<String> {
    let lab = Lab::new(host, path, profile);
    if lab.token.is_none() {
        return Err(format!("Add a GitLab token for {host} in Profiles to act on merge requests."));
    }
    let mr = lab.mr(iid);
    let send = |m: &str, p: String, v: Value, ok: &[u16]| -> R<Value> {
        let (code, b) = lab.call(m, &p, Some(&v))?;
        if !ok.contains(&code) {
            return Err(lab.error(code, &b));
        }
        Ok(serde_json::from_str(&b).unwrap_or_default())
    };
    let note = |text: &str| send("POST", format!("{mr}/notes"), json!({ "body": text }), &[201]);
    match action {
        "approve" => {
            send("POST", format!("{mr}/approve"), json!({}), &[201, 200])?;
            if !body.trim().is_empty() {
                note(body)?;
            }
            Ok(format!("Approved !{iid}"))
        }
        "comment" => {
            if body.trim().is_empty() {
                return Err("The comment is empty.".into());
            }
            note(body)?;
            Ok(format!("Commented on !{iid}"))
        }
        "merge" => {
            let m = lab.get(&mr)?;
            let mut req = json!({ "sha": m["sha"], "squash": method == "squash", "should_remove_source_branch": delete_branch });
            if !body.trim().is_empty() {
                req[if method == "squash" { "squash_commit_message" } else { "merge_commit_message" }] = body.trim().into();
            }
            send("PUT", format!("{mr}/merge"), req, &[200])?;
            Ok(format!("Merged !{iid} into {}{}", s(&m, &["target_branch"]), if delete_branch { format!(" and deleted {}", s(&m, &["source_branch"])) } else { String::new() }))
        }
        "close" => {
            send("PUT", mr, json!({ "state_event": "close" }), &[200])?;
            Ok(format!("Closed !{iid}"))
        }
        a => Err(format!("GitLab merge requests can't \"{a}\"")),
    }
}

// ---------------------------------------------------------------- one entry point per call

pub fn pull_requests(repo: &str, remote: &str, profile: &str, gitlab: &str) -> R<PullRequests> {
    match forge(repo, remote, gitlab)? {
        Forge::GitHub => github::pull_requests(repo, remote, profile),
        Forge::GitLab { host, path } => gl_list(&host, &path, profile),
    }
}

pub fn pr_detail(repo: &str, remote: &str, profile: &str, gitlab: &str, number: u64) -> R<Value> {
    match forge(repo, remote, gitlab)? {
        Forge::GitHub => github::pr_detail(repo, remote, profile, number),
        Forge::GitLab { host, path } => gl_detail(&host, &path, profile, number),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn pr_action(repo: &str, remote: &str, profile: &str, gitlab: &str, number: u64, action: &str, body: &str, method: &str, delete_branch: bool) -> R<String> {
    match forge(repo, remote, gitlab)? {
        Forge::GitHub => github::pr_action(repo, remote, profile, number, action, body, method, delete_branch),
        Forge::GitLab { host, path } => gl_action(&host, &path, profile, number, action, body, method, delete_branch),
    }
}

/// Who a token signs in as ("Signed in as …"), to check it in Profiles. `token` empty = the saved one.
pub fn whoami(forge: &str, host: &str, profile: &str, token: &str) -> R<String> {
    let token = token.trim();
    match forge {
        "github" => {
            let saved = github::get_token(profile);
            let t = if token.is_empty() { saved.ok_or("No GitHub token saved yet.")? } else { token.to_string() };
            let (code, body) = request("GET", "https://api.github.com/user", &format!("Accept: application/vnd.github+json\nUser-Agent: Gittygit\nAuthorization: Bearer {t}\n"), None)?;
            let v: Value = serde_json::from_str(&body).unwrap_or_default();
            match code {
                200 => Ok(s(&v, &["login"])),
                401 => Err("GitHub doesn't accept this token (mistyped, expired or revoked).".into()),
                c => Err(format!("GitHub answered {c}")),
            }
        }
        "gitlab" => {
            let host = gitlab_host(host)?;
            let t = if token.is_empty() { gitlab_token(profile, &host).ok_or(format!("No token saved for {host} yet."))? } else { token.to_string() };
            let (code, body) = request("GET", &format!("https://{host}/api/v4/user"), &format!("Accept: application/json\nUser-Agent: Gittygit\nPRIVATE-TOKEN: {t}\n"), None)?;
            let v: Value = serde_json::from_str(&body).unwrap_or_default();
            match code {
                200 => Ok(s(&v, &["username"])),
                401 => Err(format!("{host} doesn't accept this token (mistyped, expired or revoked).")),
                c => Err(format!("{host} answered {c}")),
            }
        }
        f => Err(format!("unknown host type {f}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_hosts() {
        assert_eq!(host_path("git@gitlab.com:acme/web/app.git"), Some(("gitlab.com".into(), "acme/web/app".into())));
        assert_eq!(host_path("https://gitlab.acme.io/acme/app"), Some(("gitlab.acme.io".into(), "acme/app".into())));
        assert_eq!(host_path("ssh://git@gitlab.acme.io:2222/acme/app.git"), Some(("gitlab.acme.io".into(), "acme/app".into())));
        assert_eq!(host_path("../local.git"), None);
        assert_eq!(gitlab_host("").unwrap(), "gitlab.com");
        assert_eq!(gitlab_host("https://Git.Acme.io/").unwrap(), "git.acme.io");
        assert!(gitlab_host("evil.com/x?y").is_err());
        assert_eq!(pipeline_state("running").as_deref(), Some("pending"));
        assert_eq!(pipeline_state("canceled").as_deref(), Some("failure"));
    }
}
