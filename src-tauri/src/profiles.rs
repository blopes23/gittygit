//! Profiles: named identities (SSH key + git author) that own a set of repository tabs.
//!
//! Stored as JSON in the app's config folder. Only the *path* of a private key is
//! kept — key material is never read or copied; ssh reads it itself.

use crate::git::{self, Ctx, R};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub color: String,
    /// Private key path; empty means "ssh defaults / ssh-agent".
    pub ssh_key: String,
    pub git_name: String,
    pub git_email: String,
    /// Expected remote owners, e.g. "github.com/acme" or just "acme".
    pub remote_owners: Vec<String>,
    /// Repository roots shown as tabs, in order.
    pub tabs: Vec<String>,
    pub active_tab: usize,
    /// Repos whose .git/config mirrors this profile, so terminal git uses it too.
    pub terminal_repos: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct Store {
    pub active: String,
    pub profiles: Vec<Profile>,
    /// True when no profiles file existed yet (first launch).
    #[serde(skip_deserializing)]
    pub fresh: bool,
}

impl Store {
    pub fn get(&self, id: &str) -> R<&Profile> {
        self.profiles.iter().find(|p| p.id == id).ok_or_else(|| format!("unknown profile {id}"))
    }

    /// The profile, provided `repo` is one of its tabs. Guards against running a
    /// command with the wrong identity.
    pub fn for_repo(&self, id: &str, repo: &str) -> R<&Profile> {
        let p = self.get(id)?;
        if p.tabs.iter().any(|t| t == repo) {
            Ok(p)
        } else {
            Err(format!("{repo} is not part of the {} profile", p.name))
        }
    }
}

pub fn config_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("GITTYGIT_CONFIG_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    home.join("Library/Application Support/dev.gittygit.desktop")
}

fn store_path() -> PathBuf {
    config_dir().join("profiles.json")
}

fn default_store() -> Store {
    Store {
        active: "personal".into(),
        profiles: vec![Profile {
            id: "personal".into(),
            name: "Personal".into(),
            color: "#a46ff0".into(),
            ..Default::default()
        }],
        fresh: false,
    }
}

pub fn load() -> Store {
    let path = store_path();
    let mut store = match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<Store>(&text) {
            Ok(s) => s,
            Err(_) => {
                // Keep the unreadable file instead of silently overwriting it.
                let _ = std::fs::rename(&path, path.with_extension("json.bak"));
                default_store()
            }
        },
        Err(_) => Store { fresh: true, ..default_store() },
    };
    if store.profiles.is_empty() {
        store.profiles = default_store().profiles;
    }
    if store.get(&store.active).is_err() {
        store.active = store.profiles[0].id.clone();
    }
    store
}

pub fn validate(store: &Store) -> R<()> {
    if store.profiles.is_empty() {
        return Err("at least one profile is required".into());
    }
    for (i, p) in store.profiles.iter().enumerate() {
        if p.id.is_empty() || p.name.trim().is_empty() {
            return Err("every profile needs a name".into());
        }
        if store.profiles[..i].iter().any(|q| q.id == p.id) {
            return Err(format!("duplicate profile id {}", p.id));
        }
        if !p.ssh_key.is_empty() && !Path::new(&p.ssh_key).is_file() {
            return Err(format!("SSH key not found for {}: {}", p.name, p.ssh_key));
        }
        for repo in &p.tabs {
            if let Some(q) = store.profiles[..i].iter().find(|q| q.tabs.contains(repo)) {
                return Err(format!("{repo} is in both {} and {}", q.name, p.name));
            }
        }
    }
    store.get(&store.active).map(|_| ())
}

pub fn save(store: &Store) -> R<()> {
    validate(store)?;
    let path = store_path();
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

// ------------------------------------------------------------------ git environment

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// ssh command line for a key. `batch` is for the app (never prompt, fail fast);
/// the terminal variant may prompt for a passphrase.
pub fn ssh_command(key: &str, batch: bool) -> String {
    let mut c = String::from("ssh");
    if !key.is_empty() {
        // IdentitiesOnly stops ssh offering agent keys first (which would pick the wrong account).
        c.push_str(&format!(" -i {} -o IdentitiesOnly=yes", shell_quote(key)));
    }
    if batch {
        c.push_str(" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15");
    }
    c
}

pub fn ctx(p: &Profile) -> Ctx {
    Ctx {
        ssh_command: (!p.ssh_key.is_empty()).then(|| ssh_command(&p.ssh_key, true)),
        identity: (!p.git_name.trim().is_empty() && !p.git_email.trim().is_empty())
            .then(|| (p.git_name.trim().to_string(), p.git_email.trim().to_string())),
    }
}

// ------------------------------------------------------------------ wrong-profile guard

#[derive(Serialize, Debug, PartialEq)]
pub struct RemoteInfo {
    pub name: String,
    pub url: String,
    pub host: String,
    pub owner: String,
    pub https: bool,
}

/// Split a remote URL into (host, owner, is_https). Local paths return None.
pub fn parse_remote(url: &str) -> Option<(String, String, bool)> {
    let lower = url.to_lowercase();
    let scheme = ["https://", "http://", "ssh://", "git://"].iter().find(|s| lower.starts_with(**s));
    let (host, path, https) = match scheme {
        Some(s) => {
            let rest = &url[s.len()..];
            let (hostpart, path) = rest.split_once('/')?;
            let host = hostpart.rsplit('@').next()?.split(':').next()?;
            (host, path, s.starts_with("http"))
        }
        // scp-like: [user@]host:owner/repo
        None if !url.starts_with('/') && !url.starts_with('.') && url.contains(':') => {
            let (hostpart, path) = url.split_once(':')?;
            (hostpart.rsplit('@').next()?, path, false)
        }
        None => return None,
    };
    let owner = path.trim_start_matches('/').split('/').next().filter(|o| !o.is_empty())?;
    Some((host.to_lowercase(), owner.to_lowercase(), https))
}

pub fn owner_matches(pattern: &str, host: &str, owner: &str) -> bool {
    let p = pattern.trim().trim_end_matches('/').to_lowercase();
    if p.is_empty() {
        return false;
    }
    if p.contains('/') {
        p == format!("{host}/{owner}")
    } else {
        p == owner || p == host
    }
}

#[derive(Serialize, Debug)]
pub struct RepoCheck {
    pub remotes: Vec<RemoteInfo>,
    /// The profile lists expected owners.
    pub owners_configured: bool,
    /// No owners configured, no remotes, or at least one remote matches.
    pub matches: bool,
    /// Another profile whose expected owners match this repo's remotes.
    pub suggested: Option<(String, String)>,
    /// Another profile that already has this repo as a tab.
    pub owned_by: Option<(String, String)>,
    pub any_https: bool,
}

pub fn check_repo(store: &Store, profile_id: &str, repo: &str) -> R<RepoCheck> {
    let profile = store.get(profile_id)?;
    let remotes: Vec<RemoteInfo> = git::remote_urls(repo)
        .into_iter()
        .filter_map(|(name, url)| {
            let (host, owner, https) = parse_remote(&url)?;
            Some(RemoteInfo { name, url, host, owner, https })
        })
        .collect();
    let profile_matches = |p: &Profile| {
        remotes.iter().any(|r| p.remote_owners.iter().any(|pat| owner_matches(pat, &r.host, &r.owner)))
    };
    let owners_configured = profile.remote_owners.iter().any(|o| !o.trim().is_empty());
    let matches = !owners_configured || remotes.is_empty() || profile_matches(profile);
    let suggested = if matches {
        None
    } else {
        store.profiles.iter().find(|p| p.id != profile_id && profile_matches(p)).map(|p| (p.id.clone(), p.name.clone()))
    };
    let owned_by = store
        .profiles
        .iter()
        .find(|p| p.id != profile_id && p.tabs.iter().any(|t| t == repo))
        .map(|p| (p.id.clone(), p.name.clone()));
    let any_https = remotes.iter().any(|r| r.https);
    Ok(RepoCheck { remotes, owners_configured, matches, suggested, owned_by, any_https })
}

// ------------------------------------------------------------------ SSH helpers

#[derive(Serialize)]
pub struct SshKey {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub comment: String,
}

/// Private keys in ~/.ssh that have a matching .pub file.
pub fn list_keys() -> Vec<SshKey> {
    let dir = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default().join(".ssh");
    let mut keys: Vec<SshKey> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let pub_path = e.path();
            if pub_path.extension()? != "pub" {
                return None;
            }
            let private = pub_path.with_extension("");
            if !private.is_file() {
                return None;
            }
            let text = std::fs::read_to_string(&pub_path).ok()?;
            let mut parts = text.split_whitespace();
            let kind = parts.next().unwrap_or_default().trim_start_matches("ssh-").to_string();
            let comment = parts.nth(1).unwrap_or_default().to_string();
            Some(SshKey {
                name: private.file_name()?.to_string_lossy().into_owned(),
                path: private.to_string_lossy().into_owned(),
                kind,
                comment,
            })
        })
        .collect();
    keys.sort_by(|a, b| a.name.cmp(&b.name));
    keys
}

#[derive(Serialize)]
pub struct SshTest {
    pub ok: bool,
    pub message: String,
}

/// `ssh -T git@host` with the profile's key. Git hosts reply with the account the key
/// belongs to (e.g. GitHub: "Hi <user>! You've successfully authenticated").
pub fn test_ssh(key: &str, host: &str) -> SshTest {
    let host = host.trim();
    let host = host.rsplit('@').next().unwrap_or(host);
    let mut cmd = Command::new("ssh");
    cmd.arg("-T");
    if !key.is_empty() {
        cmd.args(["-i", key, "-o", "IdentitiesOnly=yes"]);
    }
    cmd.args(["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10"])
        .arg(format!("git@{host}"))
        .env("LC_ALL", "en_US.UTF-8");
    match cmd.output() {
        Err(e) => SshTest { ok: false, message: format!("could not run ssh: {e}") },
        Ok(out) => {
            let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
            let message = text
                .lines()
                .filter(|l| !l.starts_with("Warning: Permanently added"))
                .collect::<Vec<_>>()
                .join("\n")
                .trim()
                .to_string();
            let lower = message.to_lowercase();
            let ok = lower.contains("successfully authenticated")
                || lower.contains("welcome to gitlab")
                || lower.contains("authenticated via ssh key")
                || lower.contains("logged in as");
            SshTest { ok, message }
        }
    }
}

/// Mirror (or remove) the profile's key and identity in a repo's local .git/config,
/// so plain `git` in a terminal behaves like the app.
pub fn apply_terminal_config(p: &Profile, repo: &str, enabled: bool) -> R<()> {
    let set = |k: &str, v: &str| git::run(repo, &["config", "--local", k, v]).map(|_| ());
    let unset = |k: &str| git::run_codes(repo, &["config", "--local", "--unset", k], &[0, 5]).map(|_| ());
    if enabled && !p.ssh_key.is_empty() {
        set("core.sshCommand", &ssh_command(&p.ssh_key, false))?;
    } else {
        unset("core.sshCommand")?;
    }
    if enabled && !p.git_name.trim().is_empty() && !p.git_email.trim().is_empty() {
        set("user.name", p.git_name.trim())?;
        set("user.email", p.git_email.trim())?;
    } else {
        unset("user.name")?;
        unset("user.email")?;
    }
    Ok(())
}

/// Open Terminal running `ssh-add --apple-use-keychain <key>` so the user can type the
/// passphrase once; afterwards ssh-agent supplies it and the app works in batch mode.
pub fn add_key_to_keychain(key: &str) -> R<()> {
    let script = format!(
        "tell application \"Terminal\"\nactivate\ndo script \"ssh-add --apple-use-keychain {}\"\nend tell",
        shell_quote(key).replace('\\', "\\\\").replace('"', "\\\"")
    );
    Command::new("osascript").arg("-e").arg(script).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_remote_urls() {
        assert_eq!(parse_remote("git@github.com:Acme/app.git"), Some(("github.com".into(), "acme".into(), false)));
        assert_eq!(parse_remote("https://github.com/bruno/site"), Some(("github.com".into(), "bruno".into(), true)));
        assert_eq!(parse_remote("ssh://git@gitlab.com:2222/team/x.git"), Some(("gitlab.com".into(), "team".into(), false)));
        assert_eq!(parse_remote("https://user@bitbucket.org/org/r.git"), Some(("bitbucket.org".into(), "org".into(), true)));
        assert_eq!(parse_remote("/srv/git/repo.git"), None);
    }

    #[test]
    fn owner_patterns() {
        assert!(owner_matches("github.com/acme", "github.com", "acme"));
        assert!(owner_matches("Acme", "github.com", "acme"));
        assert!(owner_matches("gitlab.company.io", "gitlab.company.io", "team"));
        assert!(!owner_matches("github.com/acme", "github.com", "bruno"));
        assert!(!owner_matches("", "github.com", "acme"));
    }

    #[test]
    fn ssh_command_quotes_and_isolates_key() {
        let c = ssh_command("/Users/me/.ssh/id work", true);
        assert!(c.contains("-i '/Users/me/.ssh/id work' -o IdentitiesOnly=yes"));
        assert!(c.contains("BatchMode=yes"));
        assert_eq!(ssh_command("", false), "ssh");
    }

    #[test]
    fn rejects_repo_in_two_profiles() {
        let mut s = default_store();
        s.profiles[0].tabs.push("/r".into());
        s.profiles.push(Profile { id: "work".into(), name: "Work".into(), tabs: vec!["/r".into()], ..Default::default() });
        assert!(validate(&s).unwrap_err().contains("both"));
        assert!(s.for_repo("work", "/x").is_err());
        assert!(s.for_repo("work", "/r").is_ok());
    }
}
