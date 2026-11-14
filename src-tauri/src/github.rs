//! GitHub pull requests for the sidebar, branch badges and the pull request view.
//!
//! Requests go through macOS's own `curl` (forge.rs); an optional per-profile token is read
//! from the Keychain and handed to curl on stdin, never in argv.
//! Without a token, public repositories still work within GitHub's anonymous rate limit.

use crate::git::{self, R};
use serde::Serialize;

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

pub fn get_token(profile: &str) -> Option<String> {
    crate::forge::secret_get(SERVICE, profile)
}

/// Save (or with an empty token, remove) a profile's GitHub token.
pub fn set_token(profile: &str, token: &str) -> R<()> {
    crate::forge::secret_set(SERVICE, profile, token)
}

// ---------------------------------------------------------------- API

/// GET an api.github.com path; returns (HTTP status, body).
fn api_get(path: &str, token: Option<&str>) -> R<(u16, String)> {
    api_send("GET", path, token, None)
}

/// Any api.github.com request (the token travels with the headers on curl's stdin).
fn api_send(method: &str, path: &str, token: Option<&str>, json: Option<&serde_json::Value>) -> R<(u16, String)> {
    let mut headers = String::from("Accept: application/vnd.github+json\nX-GitHub-Api-Version: 2022-11-28\nUser-Agent: Gittygit\n");
    if let Some(t) = token {
        headers.push_str(&format!("Authorization: Bearer {t}\n"));
    }
    crate::forge::request(method, &format!("https://api.github.com{path}"), &headers, json)
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
    /// "github" | "gitlab", and the host the web pages live on.
    pub forge: String,
    pub host: String,
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
    Ok(PullRequests { slug, authed: token.is_some(), prs, forge: "github".into(), host: "github.com".into() })
}

// ---------------------------------------------------------------- one pull request

fn repo_slug(repo: &str, remote: &str) -> R<String> {
    let url = git::remote_urls(repo).into_iter().find(|(n, _)| n == remote).map(|(_, u)| u).ok_or("no such remote")?;
    slug(&url).ok_or_else(|| "not a GitHub repository".into())
}

/// GitHub's own explanation from an error response, if it gave one.
fn gh_message(body: &str) -> String {
    let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
    let mut msg = v["message"].as_str().unwrap_or("").to_string();
    if let Some(errs) = v["errors"].as_array() {
        let more: Vec<&str> = errs.iter().filter_map(|e| e["message"].as_str().or_else(|| e.as_str())).collect();
        if !more.is_empty() {
            msg = format!("{msg}: {}", more.join("; "));
        }
    }
    msg
}

fn api_error(code: u16, body: &str, authed: bool) -> String {
    let msg = gh_message(body);
    match code {
        401 => "GitHub rejected the saved token (expired or revoked?). Update it in Profiles.".into(),
        403 if msg.contains("rate limit") => "GitHub's rate limit was reached. Add a token in Profiles to raise it.".into(),
        403 | 404 if !authed => "Add a GitHub token in Profiles to do this.".into(),
        403 | 404 => format!("The token isn't allowed to do this ({}). It needs \"Pull requests: read and write\" (and \"Contents\" to merge).", if msg.is_empty() { code.to_string() } else { msg }),
        _ if !msg.is_empty() => msg,
        c => format!("GitHub answered {c}"),
    }
}

/// Everything the pull request view shows: description, merge state, reviews, comments, checks.
pub fn pr_detail(repo: &str, remote: &str, profile: &str, number: u64) -> R<serde_json::Value> {
    let slug = repo_slug(repo, remote)?;
    let token = get_token(profile);
    let get = |path: String| {
        let t = token.clone();
        std::thread::spawn(move || api_get(&path, t.as_deref()))
    };
    let base = format!("/repos/{slug}");
    let (pr, reviews, comments, info) = (
        get(format!("{base}/pulls/{number}")),
        get(format!("{base}/pulls/{number}/reviews?per_page=100")),
        get(format!("{base}/issues/{number}/comments?per_page=100")),
        get(base.clone()),
    );
    let (code, body) = pr.join().map_err(|_| "request failed")??;
    if code != 200 {
        return Err(api_error(code, &body, token.is_some()));
    }
    let p: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let list = |h: std::thread::JoinHandle<R<(u16, String)>>| -> Vec<serde_json::Value> {
        match h.join() {
            Ok(Ok((200, b))) => serde_json::from_str(&b).unwrap_or_default(),
            _ => vec![],
        }
    };
    let info: serde_json::Value = match info.join() {
        Ok(Ok((200, b))) => serde_json::from_str(&b).unwrap_or_default(),
        _ => serde_json::Value::Null,
    };
    let head_sha = s(&p, &["head", "sha"]);
    let runs: Vec<serde_json::Value> = api_get(&format!("{base}/commits/{head_sha}/check-runs?per_page=100"), token.as_deref())
        .ok()
        .filter(|(c, _)| *c == 200)
        .and_then(|(_, b)| serde_json::from_str::<serde_json::Value>(&b).ok())
        .and_then(|v| v["check_runs"].as_array().cloned())
        .unwrap_or_default();
    let who = |v: &serde_json::Value| s(v, &["user", "login"]);
    let mut timeline: Vec<serde_json::Value> = list(reviews)
        .iter()
        .filter(|r| r["state"] != "PENDING")
        .map(|r| serde_json::json!({ "kind": "review", "author": who(r), "state": r["state"], "body": r["body"], "at": r["submitted_at"] }))
        .chain(list(comments).iter().map(|c| serde_json::json!({ "kind": "comment", "author": who(c), "body": c["body"], "at": c["created_at"] })))
        .collect();
    timeline.sort_by(|a, b| a["at"].as_str().cmp(&b["at"].as_str()));
    let methods: Vec<&str> = [("merge", "allow_merge_commit"), ("squash", "allow_squash_merge"), ("rebase", "allow_rebase_merge")]
        .iter()
        .filter(|(_, k)| info[*k].as_bool().unwrap_or(true))
        .map(|(m, _)| *m)
        .collect();
    Ok(serde_json::json!({
        "forge": "github",
        "fetch_ref": format!("pull/{number}/head"),
        "actions": ["approve", "request_changes", "comment", "merge", "close"],
        "approved_by": [],
        "number": number,
        "title": p["title"],
        "body": p["body"],
        "author": who(&p),
        "state": p["state"],
        "merged": p["merged"],
        "draft": p["draft"],
        "url": p["html_url"],
        "head_ref": s(&p, &["head", "ref"]),
        "head_repo": s(&p, &["head", "repo", "full_name"]),
        "head_sha": head_sha,
        "base_ref": s(&p, &["base", "ref"]),
        "slug": slug,
        // null while GitHub is still computing it
        "mergeable": p["mergeable"],
        "mergeable_state": p["mergeable_state"],
        "additions": p["additions"],
        "deletions": p["deletions"],
        "changed_files": p["changed_files"],
        "commits": p["commits"],
        "created_at": p["created_at"],
        "requested": p["requested_reviewers"].as_array().into_iter().flatten().map(|u| s(u, &["login"])).collect::<Vec<_>>(),
        "labels": p["labels"].as_array().into_iter().flatten().map(|l| s(l, &["name"])).collect::<Vec<_>>(),
        "checks": runs.iter().map(|r| serde_json::json!({ "name": r["name"], "status": r["status"], "conclusion": r["conclusion"], "url": r["html_url"] })).collect::<Vec<_>>(),
        "timeline": timeline,
        "merge_methods": methods,
        "delete_branch_on_merge": info["delete_branch_on_merge"].as_bool().unwrap_or(false),
        "authed": token.is_some(),
    }))
}

/// Acts on a pull request: "approve", "request_changes", "comment" (a review or plain comment),
/// "merge" (with `method` merge/squash/rebase, optionally deleting the branch) or "close".
/// Returns what happened, for the toast.
pub fn pr_action(repo: &str, remote: &str, profile: &str, number: u64, action: &str, body: &str, method: &str, delete_branch: bool) -> R<String> {
    let slug = repo_slug(repo, remote)?;
    let token = get_token(profile).ok_or("Add a GitHub token in Profiles to act on pull requests.")?;
    let t = Some(token.as_str());
    let base = format!("/repos/{slug}");
    let send = |method: &str, path: String, json: serde_json::Value, ok: &[u16]| -> R<serde_json::Value> {
        let (code, b) = api_send(method, &path, t, Some(&json))?;
        if !ok.contains(&code) {
            return Err(api_error(code, &b, true));
        }
        Ok(serde_json::from_str(&b).unwrap_or_default())
    };
    match action {
        "approve" | "request_changes" => {
            if action == "request_changes" && body.trim().is_empty() {
                return Err("Say what needs to change.".into());
            }
            let event = if action == "approve" { "APPROVE" } else { "REQUEST_CHANGES" };
            send("POST", format!("{base}/pulls/{number}/reviews"), serde_json::json!({ "event": event, "body": body }), &[200])?;
            Ok(if action == "approve" { format!("Approved #{number}") } else { format!("Requested changes on #{number}") })
        }
        "comment" => {
            if body.trim().is_empty() {
                return Err("The comment is empty.".into());
            }
            send("POST", format!("{base}/issues/{number}/comments"), serde_json::json!({ "body": body }), &[201])?;
            Ok(format!("Commented on #{number}"))
        }
        "merge" => {
            if !["merge", "squash", "rebase"].contains(&method) {
                return Err(format!("unknown merge method {method}"));
            }
            let (code, b) = api_get(&format!("{base}/pulls/{number}"), t)?;
            if code != 200 {
                return Err(api_error(code, &b, true));
            }
            let p: serde_json::Value = serde_json::from_str(&b).unwrap_or_default();
            let mut req = serde_json::json!({ "merge_method": method, "sha": p["head"]["sha"] });
            if method != "rebase" && !body.trim().is_empty() {
                req["commit_title"] = body.trim().into();
            }
            send("PUT", format!("{base}/pulls/{number}/merge"), req, &[200])?;
            let mut msg = format!("Merged #{number} into {}", s(&p, &["base", "ref"]));
            let head_ref = s(&p, &["head", "ref"]);
            if delete_branch && s(&p, &["head", "repo", "full_name"]) == slug {
                let (code, b) = api_send("DELETE", &format!("{base}/git/refs/heads/{head_ref}"), t, None)?;
                msg += &match code {
                    204 | 422 => format!(" and deleted {head_ref} on GitHub"),
                    _ => format!(" (couldn't delete {head_ref}: {})", api_error(code, &b, true)),
                };
            }
            Ok(msg)
        }
        "close" => {
            send("PATCH", format!("{base}/pulls/{number}"), serde_json::json!({ "state": "closed" }), &[200])?;
            Ok(format!("Closed #{number}"))
        }
        a => Err(format!("unknown action {a}")),
    }
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
