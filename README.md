# Gittygit

A GitKraken-style Git client for macOS on Apple silicon, built with **Tauri 2** (Rust + WKWebView).
See [GITKRAKEN-ANALYSIS.md](GITKRAKEN-ANALYSIS.md) for the reverse-engineering notes it is based on.

## Features
- **Profiles** (e.g. Work / Personal), each with its own SSH key, git author and set of repository tabs
  - fetch / pull / push / clone use only the profile's key (`ssh -i <key> -o IdentitiesOnly=yes`), commits use its name/email
  - switch with the profile menu or ⌘⇧1…9; tabs ⌘1…9, ⌘T open, ⌘W close
  - "Test connection" shows which account a key logs in as; "Add to keychain…" stores a key's passphrase once
  - expected remote owners per profile: warns when a repo is opened or pushed under the wrong profile
  - optional per-repo "use profile in terminal git" writes `core.sshCommand` + `user.*` to that repo's `.git/config`
  - stored in `~/Library/Application Support/dev.gittygit.desktop/profiles.json` (key paths only, never key contents)
- Commit graph of all branches (lane layout in Rust, virtualized rows, branch/tag pills, WIP node)
- Sidebar: local / remote branches with ahead/behind, tags, stashes
- Pull into a branch without checking it out (right-click → "Pull … (fast-forward)", works on multi-selection too)
- Multi-select local branches (⌘-click, ⇧-click, ⌘A) and delete them in one go (⌫ or right-click); unmerged ones get a single force-delete prompt
- Working tree: stage / unstage / discard per file or all, commit, amend
- Commit details with changed files; unified diff viewer
- Toolbar: pull, push (sets upstream on first push), fetch, branch, stash, pop, open in Terminal/Finder
- Context menus: checkout, merge, rebase, cherry-pick, revert, reset soft/mixed/hard, tag, delete branch
- Live refresh via FSEvents (`notify`) when files or refs change
- Find commits by message, author or SHA (⌘F); ⌘O open; ⌘R refresh; ⌘↵ commit

## Build
Requires Rust (`rustup`, host `aarch64-apple-darwin`) and Node.

```bash
npm install
npm run build        # → src-tauri/target/release/bundle/{macos,dmg}
npm run dev          # live development window
```

UI development without the webview: build the debug binary (`cargo build` in `src-tauri`) and run
`node scripts/ui-bridge.mjs src src-tauri/target/debug/gittygit /path/to/repo` — it serves the
frontend on http://localhost:5178 backed by the real Rust code (debug-only `--rpc` mode).

Open a repo from the command line: `Gittygit.app/Contents/MacOS/gittygit /path/to/repo`.

`npm run build` signs the update archive, so it needs the updater key (`~/.tauri/gittygit.key`)
and its password (Keychain item `gittygit-updater-key-password`).

The app is ad-hoc signed. On another Mac, open it once, then System Settings → Privacy & Security →
"Open Anyway" (or sign/notarize with an Apple Developer ID — see the release workflow).

## Releases & auto-update
Installed copies check `https://github.com/blopes23/gittygit/releases/latest/download/latest.json`
on launch and every 6 hours (also Gittygit → Check for Updates…). Updates are only installed if
their signature matches the public key built into the app.

To publish a release:
```bash
npm run bump 0.2.0
git commit -am "Release v0.2.0" && git tag v0.2.0 && git push origin main v0.2.0
```
The `Release` GitHub Action builds a universal (Apple silicon + Intel) app and publishes the
`.dmg`, the signed update archive and `latest.json`.

One-time setup — repository secrets (Settings → Secrets and variables → Actions):
- `TAURI_SIGNING_PRIVATE_KEY` — contents of `~/.tauri/gittygit.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — `security find-generic-password -s gittygit-updater-key-password -w`

Keep `~/.tauri/gittygit.key` backed up: without it, installed copies can't receive updates.
