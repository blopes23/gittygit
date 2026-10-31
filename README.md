# Gittygit

A fast, native-feeling Git client for macOS (Apple silicon and Intel), built with **Tauri 2** (Rust + WKWebView).

## Features
- **Profiles** (e.g. Work / Personal), each with its own SSH key, git author and set of repository tabs
  - fetch / pull / push / clone use only the profile's key (`ssh -i <key> -o IdentitiesOnly=yes`), commits use its name/email
  - switch with the profile menu or ⌘⇧1…9; tabs ⌘1…9, ⌘T open, ⌘W close
  - "Test connection" shows which account a key logs in as; "Add to keychain…" stores a key's passphrase once
  - expected remote owners per profile: warns when a repo is opened or pushed under the wrong profile
  - optional per-repo "use profile in terminal git" writes `core.sshCommand` + `user.*` to that repo's `.git/config`
  - stored in `~/Library/Application Support/dev.gittygit.desktop/profiles.json` (key paths only, never key contents)
- Commit graph of all branches (lane layout in Rust, virtualized rows, branch/tag pills, WIP node); older history loads in pages of 5000 as you scroll; the graph column fits the lanes on screen (drag its header edge to set a width, double-click to reset) and narrow windows hide the Author column
- Sidebar: local / remote branches with ahead/behind, tags, stashes
- Pull into a branch without checking it out (right-click → "Pull … (fast-forward)", works on multi-selection too)
- Multi-select local branches (⌘-click, ⇧-click, ⌘A) and delete them in one go (⌫ or right-click); unmerged ones get a single force-delete prompt
- Working tree: stage / unstage / discard per file or all, commit, amend
- Partial staging: stage, unstage or discard single hunks, or pick individual lines (click the diff gutter, ⇧-click for a range)
- Conflict resolution for merges, rebases, cherry-picks, reverts and stash pops: side-by-side ours/theirs per
  conflict with ours / theirs / both / hand-edited results, keep-or-delete for deleted files, whole-version pick for
  binaries, and a banner to continue, skip (rebase) or abort the operation
- Commit details with changed files; diff viewer with inline or side-by-side layout, changed-word highlights and syntax colours ([highlight.js](https://highlightjs.org), BSD-3); big diffs render only the visible rows
- Select several commits (⌘-click, ⇧-click) to compare two of them, or cherry-pick, revert or squash them together
- Compare any two commits or branches, or a commit with the working tree: commits on each side and the files that differ
- Add a file, its extension or its folder to .gitignore from the file's right-click menu
- File history (follows renames) and blame, from a file's right-click menu or the diff header; click a commit to see its change
- Interactive rebase (right-click a commit → "Interactive rebase … from here"): reorder, reword, squash, fixup, drop
- Force push with lease (offered when a push is rejected after an amend/rebase; refuses to overwrite commits you haven't integrated)
- Undo (toast button or ⌘Z) for branch/tag/stash/remote-branch deletes, resets, discards, amends and rebases
- Toolbar: pull, push (sets upstream on first push), fetch, branch, stash, pop, open in Terminal/Finder
- Pull with merge, rebase or fast-forward only (Pull ▾); when branches diverge and nothing is set, it asks once per repository
- Background fetch of the open repository (every 5 min by default; Settings, ⌘,), with a warning dot instead of popups when it fails
- Push or delete tags on the remote; tags that aren't pushed yet are marked "local"
- Rename branches (optionally on the remote too), track or stop tracking a remote branch
- HTTPS sign-in failures offer to switch the remote to SSH or store an access token in git's credential store
- Recover lost commits (Gittygit → Recover Lost Commits…): recent HEAD/branch history from the reflog, plus a deep scan for dropped stashes and deleted work; preview, recreate as a branch or reset to it
- Command palette (⌘K): fuzzy-search actions, branches, tabs and profiles
- GitHub pull requests: open PRs with CI status in the sidebar, PR badges on branches, create a PR (opens GitHub's compare page), check out any PR by number; an optional per-profile token (stored in the Keychain) adds private repositories
- Gittygit → Copy Diagnostics for bug reports; errors are logged to `~/Library/Logs/Gittygit/` with paths and tokens masked
- Context menus: checkout, merge, rebase, cherry-pick, revert, reset soft/mixed/hard, tag, delete branch
- Live refresh via FSEvents (`notify`) when files or refs change; changes git ignores (build output, `node_modules`) don't trigger it, and the commit graph is only reloaded when refs or HEAD move
- Find commits by message, author or SHA (⌘F); ↵ with no match searches the whole history; ⌘O open; ⌘R refresh; ⌘↵ commit
- Slow repositories get an opt-in to write git's commit-graph file (faster graph, file history and blame)

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

The `CI` action runs on every push to `main`: Rust tests, then a release-identical compile that
saves the Rust build cache. Release runs (triggered by tags) can only restore caches from `main`,
so a release is fastest when CI for that commit has finished first.

One-time setup — repository secrets (Settings → Secrets and variables → Actions):
- `TAURI_SIGNING_PRIVATE_KEY` — contents of `~/.tauri/gittygit.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — `security find-generic-password -s gittygit-updater-key-password -w`

- `APPLE_CERTIFICATE` — `base64 -i ~/.tauri/gittygit-signing.p12`
- `APPLE_CERTIFICATE_PASSWORD` — `security find-generic-password -s gittygit-signing-p12-password -w`
- `APPLE_SIGNING_IDENTITY` — `Gittygit Self-Signed`

The last three give every build the same code-signing identity, so macOS keeps folder-access
permissions (Desktop, Documents…) across updates instead of asking again. Local builds use the
same certificate from the login keychain.

Release notes ("What's new" in the app) are generated from the commit messages since the
previous tag: each commit subject becomes a bullet, `- ` lines in its body become sub-bullets.

Back up `~/.tauri/gittygit.key`, `~/.tauri/gittygit-signing.p12` and both Keychain passwords:
without the update key installed copies can't receive updates, and a new signing certificate
makes macOS ask for folder access once more.

## License
[MIT](LICENSE): free to use, copy, modify and share, as long as the copyright notice stays with the code.
