# How GitKraken Desktop works — static evidence

Target: `/Applications/GitKraken.app` (GitKraken Desktop **12.6.0**, `com.axosoft.gitkraken`).
Method: REA (`analyze_javascript_application`) on `Contents/Resources/app.asar`, a second REA pass on the
extracted first-party `src/` tree, and direct reads of the Mach-O / plist / shipped bundles.
Everything here is **static** — nothing was executed or observed at runtime.

## REA evidence records

| Evidence ID | What it is |
|---|---|
| `ev_383f221c832b70e66691385f6097ccc7f59fdab832956def16483489ee50de32` | Full app.asar graph (asar sha256 `4daf5e68…9702`). 46,652 entries. `integrity_policy=record-and-continue` because unpacked native binaries (git, nodegit.node, spawn server…) were re-signed after packing → ASAR integrity hashes no longer match (normal for notarized Electron apps). Semantic analysis of `src/main/static/*.bundle.js` **not started** (result budget used up by node_modules). |
| `ev_1cc2da62218a0cf5ee38eff06e849500f83f757caa682ebf57da0779ac11f421` | Second pass on first-party code only (`package.json` + `src/**/*.js,html`): 155 JS files parsed, 85 modules, 1,166 findings. Coverage: **partial** (semantic families truncated). |
| `ev_22903987…4ab` | Feature trace seed `nodegit` → **no-match** (minified webpack ids; not evidence of absence). |

## Findings

| # | Claim | Evidence | Type |
|---|---|---|---|
| 1 | Electron app, Electron **41.10.7** / Chrome 146, arm64-only main binary. | `Electron Framework` strings `Chrome/146.0.7680.216 Electron/41.10.7`; `lipo -archs MacOS/GitKraken` → `arm64`; `NSPrincipalClass = AtomApplication` | observed |
| 2 | Signed by *Axosoft, LLC (T7QVVUTZQ8)*, hardened runtime, with JIT + unsigned-executable-memory entitlements (V8). | `codesign -dv` flags `0x10000(runtime)`; entitlements `cs.allow-jit`, `cs.allow-unsigned-executable-memory` | observed |
| 3 | Main process entry is `src/main/static/main.bundle.js` (webpack, ~7 MB + lazy chunks). | `package.json` `"main"`; REA node `electron-main:package-entrypoint:src/main/static/main.bundle.js` | observed |
| 4 | Main window runs with **full Node.js in the renderer**: `contextIsolation:false, nodeIntegration:true, nodeIntegrationInWorker:true`, `titleBarStyle:"hidden"` on macOS, min 950×675. | `919.main.bundle.js` @21044 | observed |
| 5 | Splash window is a frameless transparent BrowserWindow with JS disabled. | `main.bundle.js` @3762604 (`webPreferences:{javascript:!1,webgl:!1}`) | observed |
| 6 | Renderer entry points: `main` (UI), `requestHandler` (a second renderer that hosts git/network work), `worker`, `webview`, `splash`, `eula`, `upgrades`. | `src/render/static/entryPoints/*`; `requestHandler/index.js` calls `require('../../../requestHandler/main').start()` | observed |
| 7 | IPC is thin and main-process-centric: `window-command`, `update-url-changed`, `reload-window`, `quit`, `log`, `retrieveLocalStorage`, `request-handler-initialized`, `set-access-token-cookie`, … | `ipcMain.on/once/handle("…")` literals in `src/main/static/*.js`; REA summary: 21 IPC ops, 5 literal channels, 0 paired main handlers in the analysed slice | observed / partial |
| 8 | **Git engine #1 — libgit2 via nodegit** (`@axosoft/nodegit`, arm64 `.node` exporting 1,864 `git_*` symbols such as `git_revwalk_next`, `git_graph_ahead_behind`). Used for reads: `Commit.lookup` ×28, `Revwalk` ×7, `Reference.lookup`, `Diff.indexToWorkdir`, `Blame.file`, `Cred.*`… | `nm -gU nodegit.node`; API-name counts in `render.bundle.js` + `requestHandler.bundle.js` | observed |
| 9 | **Git engine #2 — bundled git CLI 2.54.0** (`app.asar.unpacked/git`) with `GIT_EXEC_PATH`/`GIT_TEMPLATE_DIR` pointed at it. Used for `fetch`, `status --porcelain`, `stash push/apply/drop`, `worktree *`, `submodule *`, `rebase`, `rev-list`, `for-each-ref`, `commit`. | `getPackagedGitRuntimeEnvironment` in `main.bundle.js` @1016023; arg-array literals in bundles | observed |
| 10 | CLI git processes are launched through a **Rust spawn server** (`@axosoft/node-spawn-server`, arm64 executable) rather than `child_process` directly; stderr is line-parsed and hook output is framed with `_GKC_HOOK_END_`. | `getNodeSpawnServerPath` in `requestHandler.bundle.js` @252243; Rust std paths in binary | observed; *purpose (avoiding fork cost from Electron) is inferred* |
| 11 | File-system watching via **`nsfw`** native addon. | `require("nsfw")` in `render.bundle.js` @3783458; `nsfw.node` in unpacked | observed |
| 12 | Other natives: `find-git-repositories` (repo scan), `node-pty` (integrated terminal, separate `pty-host` bundle), `native-keymap`, `get-cwd-of-process`, `msgpackr-extract`, `rust-socket-bridge`. | `app.asar.unpacked/node_modules/**/*.node`; REA native-addon nodes | observed |
| 13 | UI is **React + Redux** (`redux/` folder, `createStore`), with Monaco for diff/editor and a virtualized commit graph (`@axosoft/react-virtualized`, `GraphRow` ×121, `GraphContainer`, `graphZone*` column model from `@gitkraken/gitkraken-components`). | string counts in `render.bundle.js`; `src/render/static/monaco/*` | observed |
| 14 | Telemetry/crash: Sentry (`__SENTRY_IPC__` context bridge, `@sentry/electron`) and OpenTelemetry. | REA `context_bridge_apis`, IPC `IPCChannel.*` | observed |
| 15 | Updates via Squirrel.Mac (`Squirrel.framework`) against `release.gitkraken.com`. | `Frameworks/`; `entryPoints/main/index.js` | observed |

## Gaps / unknowns
* REA semantic coverage of the 7 MB main bundle and 12 MB renderer bundle is partial — IPC pairings and data-flow are not complete.
* Exactly which operations go through libgit2 vs. CLI at runtime was not observed (no runtime capture).
* Cloud features (Workspaces, Launchpad, AI) were not traced.

## How this maps onto Gittygit (the Tauri rebuild)

| GitKraken | Gittygit |
|---|---|
| Electron 41 + Chromium (~400 MB app) | Tauri 2 + system WKWebView (single small arm64 binary) |
| Renderer with `nodeIntegration:true` | Isolated webview; only typed Rust commands exposed (`git_run` allow-lists subcommands) |
| nodegit + bundled git via Rust spawn server | Rust backend runs the user's `git` off the main thread, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0` |
| `nsfw` watcher | `notify` crate (FSEvents), debounced → `repo-changed` event |
| React virtualized `GraphRow` | Lane layout computed in Rust (`graph.rs`), virtualized rows with per-row SVG in vanilla JS |
| WIP node, branch pills, left sidebar, right detail/commit panel, diff view | Same layout and interactions |
