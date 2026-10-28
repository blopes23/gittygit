'use strict';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// ------------------------------------------------------------------ constants

const ROW_H = 28;
const LANE_W = 16;
const LANE_X0 = 12;
const PALETTE = ['#4fb3d9', '#a46ff0', '#5fc78a', '#ef9a5b', '#ef6b73', '#e6c062', '#4fd1c5', '#f472b6', '#94a3b8', '#84cc16'];
const laneColor = (i) => PALETTE[i % PALETTE.length];

const sv = (d) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  repo: sv('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>'),
  branch: sv('<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>'),
  pull: sv('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>'),
  push: sv('<path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M5 3h14"/>'),
  fetch: sv('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
  stash: sv('<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M12 3v8"/><path d="m8 7 4 4 4-4"/>'),
  pop: sv('<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M12 11V3"/><path d="m8 7 4-4 4 4"/>'),
  terminal: sv('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>'),
  folder: sv('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  file: sv('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'),
  cloud: sv('<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z"/>'),
  tag: sv('<path d="M12 2H2v10l9.29 9.29a1 1 0 0 0 1.41 0l8.59-8.59a1 1 0 0 0 0-1.41z"/><circle cx="7" cy="7" r="1.5"/>'),
  laptop: sv('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M2 20h20"/>'),
  check: sv('<path d="M20 6 9 17l-5-5"/>'),
  logo: sv('<circle cx="6" cy="5" r="2.5"/><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 7.5v9"/><path d="M6 9.5c0 2.5 4 2.5 9.5 2.5"/>'),
};
const icon = (n) => `<span class="i">${ICONS[n] || ''}</span>`;

// ------------------------------------------------------------------ state

const S = {
  repo: null,
  name: '',
  graph: null,
  rows: [],
  index: new Map(),
  refs: null,
  status: null,
  selected: null,
  file: null, // file whose diff is open
  commitCache: new Map(),
  matches: [],
  matchSet: new Set(),
  matchPos: -1,
  graphW: 80,
  sbClosed: new Set(load('kl.sbClosed', [])),
  sbSel: new Set(), // multi-selected local branch names
  sbAnchor: null, // anchor for shift-click ranges
  busy: 0,
  lineSel: new Set(), // picked diff lines ("hunk:line")
  lineAnchor: null,
  undo: null, // last undoable action, see offerUndo()
};

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

// ------------------------------------------------------------------ helpers

function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    if (!el.firstChild) el.innerHTML = ICONS[el.dataset.icon] || '';
  });
}

function toast(msg, kind = '', action = null) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.className = 'mini';
    b.textContent = action.label;
    b.addEventListener('click', () => {
      el.remove();
      action.fn();
    });
    el.appendChild(b);
  }
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), action ? 15000 : kind === 'err' ? 9000 : 3500);
}

async function busy(fn) {
  S.busy++;
  $('#spinner').hidden = false;
  document.querySelectorAll('.act').forEach((b) => (b.disabled = true));
  try {
    return await fn();
  } finally {
    if (--S.busy === 0) {
      $('#spinner').hidden = true;
      document.querySelectorAll('.act').forEach((b) => (b.disabled = false));
    }
  }
}

/** Explain auth failures in terms of the active profile's SSH key. */
function explainGitError(msg) {
  const p = activeProfile();
  if (/Permission denied \(publickey\)|Could not read from remote repository/.test(msg)) {
    const hint = p.ssh_key
      ? `Profile “${p.name}” uses ${p.ssh_key}. Check it has access to this repo (Profiles → Test connection). If the key has a passphrase, use “Add to keychain…” once.`
      : `Profile “${p.name}” has no SSH key — ssh tried its defaults. Pick a key in Profiles.`;
    return `${msg}\n\n${hint}`;
  }
  if (/stale info|remote ref updated since checkout/.test(msg))
    return `${msg}\n\nSomeone else pushed to this branch and their commits aren't in yours, so the force push was refused to avoid overwriting their work. Pull (or rebase onto the remote branch) first, then push again.`;
  if (/Host key verification failed/.test(msg)) return `${msg}\n\nThe server's host key changed or is untrusted; check ~/.ssh/known_hosts.`;
  return msg;
}

/** git_run for the active tab, executed with the active profile's SSH key and author. */
async function gitRaw(args) {
  try {
    return await invoke('git_run', { profileId: activeProfile().id, repo: S.repo, args });
  } catch (e) {
    throw explainGitError(String(e));
  }
}

/** Run a mutating git command; returns stdout or null on failure (already toasted). */
function git(args, okMsg) {
  return runGit(() => gitRaw(args), okMsg);
}

/** Like git(), for any backend call that runs git (conflicts jump to the WIP panel). */
async function runGit(fn, okMsg) {
  return busy(async () => {
    try {
      const out = await fn();
      if (okMsg) toast(okMsg, 'ok');
      await refresh();
      return out ?? '';
    } catch (e) {
      const msg = String(e);
      await refresh();
      if (/CONFLICT|could not apply|fix conflicts|after resolving the conflicts/i.test(msg) && S.index.has('WIP')) {
        toast('Stopped on conflicts — resolve each file in the panel on the right, then Continue.', 'err');
        select('WIP');
      } else toast(msg, 'err');
      return null;
    }
  });
}

function ask(msg, { input = false, value = '', ok = 'OK', danger = false, placeholder = '', alt = null } = {}) {
  return new Promise((resolve) => {
    const dlg = $('#modal');
    const inp = $('#modal-input');
    $('#modal-msg').textContent = msg;
    inp.hidden = !input;
    inp.value = value;
    inp.placeholder = placeholder;
    $('#modal-ok').textContent = ok;
    $('#modal-alt').hidden = !alt;
    $('#modal-alt').textContent = alt || '';
    dlg.classList.toggle('danger', danger);
    dlg.returnValue = '';
    dlg.showModal();
    if (input) {
      inp.focus();
      inp.select();
    } else {
      $('#modal-ok').focus();
    }
    dlg.addEventListener(
      'close',
      () => {
        if (dlg.returnValue === 'alt') return resolve('alt');
        const accepted = dlg.returnValue === 'ok';
        resolve(accepted ? (input ? inp.value.trim() : true) : null);
      },
      { once: true },
    );
  });
}
$('#modal-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('#modal').close('ok');
  }
});

// ------------------------------------------------------------------ undo

/**
 * Remember how to reverse the last destructive action. Offered in the toast and with ⌘Z;
 * only the most recent action can be undone, and only in the repository it happened in.
 */
function offerUndo(msg, fn) {
  const entry = { repo: S.repo, msg, fn };
  S.undo = entry;
  toast(msg, 'ok', { label: 'Undo', fn: () => runUndo(entry) });
}

async function runUndo(entry = S.undo) {
  if (!entry) return;
  if (entry !== S.undo) return toast('Only the most recent action can be undone', 'err');
  if (entry.repo !== S.repo) return toast('Switch back to that repository tab to undo', 'err');
  S.undo = null;
  await busy(async () => {
    try {
      await entry.fn();
      toast(`Undone: ${entry.msg}`, 'ok');
    } catch (e) {
      toast(`Couldn't undo: ${e}`, 'err');
    }
    await refresh();
  });
}

const takeSnapshot = (paths, index = false) => invoke('snapshot_files', { repo: S.repo, paths, index });
const restoreSnapshot = (snapshot) => invoke('restore_files', { profileId: activeProfile().id, repo: S.repo, snapshot });
const revParse = async (rev) => (await gitRaw(['rev-parse', rev])).trim();

/**
 * Run something that moves the current branch (reset, amend, rebase) and offer to move it back.
 * `undoMode` is the reset mode that reverses it; `snapshot` also brings back discarded changes.
 */
async function moveHead(fn, okMsg, { undoMode = 'keep', snapshot = null } = {}) {
  let before, branch;
  try {
    before = await revParse('HEAD');
    branch = (await gitRaw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch {}
  const out = await runGit(typeof fn === 'function' ? fn : () => gitRaw(fn));
  if (out === null) return null;
  const after = await revParse('HEAD').catch(() => '');
  if (!before || !after || (after === before && !snapshot)) {
    if (okMsg) toast(okMsg, 'ok');
    return out;
  }
  offerUndo(okMsg, async () => {
    const [now, nowBranch] = [await revParse('HEAD'), (await gitRaw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()];
    if (now !== after || nowBranch !== branch) throw `${branch} has changed since then`;
    await gitRaw(['reset', `--${undoMode}`, before]);
    if (snapshot) await restoreSnapshot(snapshot);
  });
  return out;
}

function fmtDate(t) {
  if (!t) return '';
  const d = new Date(t * 1000);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} days ago`;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
const fmtFull = (t) => new Date(t * 1000).toLocaleString();

function hashHue(s) {
  let h = 0;
  for (const ch of s || '') h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h) % 360;
}
function initials(name) {
  const parts = (name || '?').trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
const avatar = (name, email) =>
  `<span class="avatar" style="background:hsl(${hashHue(email || name)} 45% 42%)">${esc(initials(name))}</span>`;

const short = (sha) => (sha || '').slice(0, 7);
const currentBranch = () => S.refs?.branches.find((b) => b.current);

// ------------------------------------------------------------------ repo lifecycle

let refreshing = false;
let refreshAgain = false;
async function refresh() {
  if (!S.repo) return;
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  try {
    const repo = S.repo;
    // The graph comes back only when refs, HEAD or the WIP row changed since `graphKey`.
    const knownKey = S.graph && S.graphFor === repo ? S.graphKey : null;
    const snap = await invoke('get_snapshot', { repo, knownKey });
    if (repo !== S.repo) return;
    const { status, refs, op } = snap;
    if (snap.graph) {
      S.graph = snap.graph;
      S.rows = snap.graph.rows;
      S.graphKey = snap.key;
      S.graphFor = repo;
    }
    const graph = S.graph;
    S.status = status;
    S.refs = refs;
    S.op = op || {};
    if (S.conflictPath && !status.conflicted.some((f) => f.path === S.conflictPath)) closeConflict();
    if (snap.graph) S.index = new Map(S.rows.map((r, i) => [r.sha, i]));
    if (!S.selected || !S.index.has(S.selected)) S.selected = graph.dirty ? 'WIP' : graph.head_sha;
    if (S.file && (S.file.mode === 'staged' || S.file.mode === 'unstaged')) {
      // Follow the file when all of it moved between unstaged and staged (e.g. last hunk staged).
      const has = (list) => list.some((f) => f.path === S.file.path);
      const other = S.file.mode === 'staged' ? 'unstaged' : 'staged';
      if (has(status[S.file.mode])) showDiff(S.file, true);
      else if (has(status[other])) showDiff({ ...S.file, mode: other, untracked: false });
      else closeDiff();
    }
    renderToolbar();
    renderSidebar();
    if (snap.graph) layoutGraph();
    renderRows();
    renderDetail();
    if (S.matches.length) runSearch($('#search').value, false);
  } catch (e) {
    toast(String(e), 'err');
  } finally {
    refreshing = false;
    if (refreshAgain) {
      refreshAgain = false;
      refresh();
    }
  }
}

let changeTimer;
function scheduleRefresh() {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(refresh, 150);
}

// ------------------------------------------------------------------ toolbar

function renderToolbar() {
  const b = currentBranch();
  $('#branch-name').textContent = S.graph?.head_branch || (S.graph?.head_sha ? `detached @ ${short(S.graph.head_sha)}` : 'no commits');
  $('#ahead-badge').textContent = b?.ahead ? b.ahead : '';
  $('#behind-badge').textContent = b?.behind ? b.behind : '';
  document.title = `${S.name} — Gittygit`;
}

/**
 * Overwrite the upstream branch after amending/rebasing pushed commits. --force-with-lease and
 * --force-if-includes refuse if the remote has commits we haven't fetched and integrated.
 */
async function forcePush(b, afterReject = false) {
  const why = afterReject
    ? `Push was rejected: ${b.upstream} has commits that aren't on your local ${b.name}. That usually means you amended or rebased commits you had already pushed.\n\n`
    : '';
  const ok = await ask(
    `${why}Force push ${b.name} to ${b.upstream}?\n\nThe remote branch is replaced with yours. It's a safe force push (with lease): it's refused if someone else pushed in the meantime.`,
    { ok: 'Force push', danger: true },
  );
  if (ok !== true) return;
  if (!afterReject && !(await confirmRemoteForProfile('Force push'))) return;
  const dest = b.upstream_ref || `refs/heads/${b.name}`;
  await git(['push', '--force-with-lease', '--force-if-includes', b.upstream_remote, `${b.name}:${dest}`], `Force-pushed ${b.name} → ${b.upstream}`);
}

function defaultRemote() {
  const names = S.refs?.remote_names || [];
  return names.includes('origin') ? 'origin' : names[0];
}

const ACTIONS = {
  async pull() {
    await git(['pull'], 'Pulled');
  },
  async push() {
    const b = currentBranch();
    if (!b) return toast('Not on a branch', 'err');
    if (!(await confirmRemoteForProfile('Push'))) return;
    if (!b.upstream) {
      const remote = defaultRemote();
      if (!remote) return toast('This repository has no remotes', 'err');
      return git(['push', '-u', remote, b.name], `Pushed ${b.name} → ${remote}/${b.name}`);
    }
    let rejected = null;
    await busy(async () => {
      try {
        await gitRaw(['push']);
        toast(`Pushed ${b.name}`, 'ok');
      } catch (e) {
        const msg = String(e);
        if (/\(fetch first\)/.test(msg)) rejected = 'fetch';
        else if (/\(non-fast-forward\)/.test(msg)) rejected = 'diverged';
        else toast(msg, 'err');
      }
      await refresh();
    });
    if (rejected === 'fetch') toast(`${b.upstream} has commits you don't have yet. Pull first, then push again.`, 'err');
    if (rejected === 'diverged') forcePush(b, true);
  },
  async fetch() {
    await git(['fetch', '--all', '--prune'], 'Fetched all remotes');
  },
  async branch() {
    const base = S.selected && S.selected !== 'WIP' ? S.selected : null;
    const name = await ask(base ? `New branch at ${short(base)}` : 'New branch from HEAD', {
      input: true,
      placeholder: 'feature/my-branch',
      ok: 'Create',
    });
    if (!name) return;
    await git(['switch', '-c', name, ...(base ? [base] : [])], `Created ${name}`);
  },
  async stash() {
    if (!S.graph?.dirty) return toast('Nothing to stash');
    const msg = await ask('Stash all changes (including untracked)', { input: true, placeholder: 'Optional message', ok: 'Stash' });
    if (msg === null) return;
    await git(['stash', 'push', '-u', ...(msg ? ['-m', msg] : [])], 'Changes stashed');
  },
  async pop() {
    if (!S.refs?.stashes.length) return toast('No stashes');
    await git(['stash', 'pop'], 'Stash popped');
  },
  terminal: () => invoke('reveal', { repo: S.repo, target: 'terminal' }),
  finder: () => invoke('reveal', { repo: S.repo, target: 'finder' }),
};

document.querySelectorAll('[data-act]').forEach((b) =>
  b.addEventListener('click', () => {
    if (!S.repo) return;
    ACTIONS[b.dataset.act]?.();
  }),
);

// ------------------------------------------------------------------ sidebar

function renderSidebar() {
  const r = S.refs;
  if (!r) return;
  const section = (key, title, count, body) =>
    `<details class="sb-section" data-key="${key}" ${S.sbClosed.has(key) ? '' : 'open'}>
      <summary>${title}<span class="count">${count}</span></summary>${body}</details>`;
  const item = (kind, name, sha, ico, extra = '', cls = '') =>
    `<div class="sb-item ${cls}" data-kind="${kind}" data-name="${esc(name)}" data-sha="${sha}" title="${esc(name)}">
      ${icon(ico)}<span class="name">${esc(name)}</span>${extra}</div>`;
  const empty = (t) => `<div class="sb-empty">${t}</div>`;

  const names = new Set(r.branches.map((b) => b.name));
  for (const n of S.sbSel) if (!names.has(n)) S.sbSel.delete(n);
  const local = r.branches
    .map((b) => {
      const track = [b.ahead ? `↑${b.ahead}` : '', b.behind ? `↓${b.behind}` : ''].join(' ').trim();
      const cls = [b.current && 'current', S.sbSel.has(b.name) && 'sel'].filter(Boolean).join(' ');
      return item('local', b.name, b.sha, b.current ? 'check' : 'branch', track ? `<span class="track">${track}</span>` : '', cls);
    })
    .join('');

  const groups = {};
  for (const rb of r.remotes) {
    const remote = r.remote_names.find((n) => rb.name.startsWith(n + '/')) || rb.name.split('/')[0];
    (groups[remote] ||= []).push(rb);
  }
  const remotes = Object.entries(groups)
    .map(([remote, list]) => `<div class="sb-group">${icon('cloud')} ${esc(remote)}</div>` + list.map((rb) => item('remote', rb.name, rb.sha, 'branch')).join(''))
    .join('');

  const tags = r.tags.map((t) => item('tag', t.name, t.sha, 'tag')).join('');
  const stashes = r.stashes.map((s) => item('stash', s.message, s.sha, 'stash', '', '').replace('data-name=', `data-index="${s.index}" data-name=`)).join('');

  const n = S.sbSel.size;
  const deletable = [...S.sbSel].filter((name) => name !== currentBranch()?.name).length;
  const selbar = n > 1
    ? `<div class="sb-selbar"><span>${n} selected</span><span class="spacer"></span>
        ${deletable ? `<button class="mini danger" data-sel="delete">Delete ${deletable}</button>` : ''}<button class="mini" data-sel="clear">Clear</button></div>`
    : '';
  $('#sidebar').innerHTML =
    selbar +
    section('local', 'Local', r.branches.length, local || empty('No branches')) +
    section('remote', 'Remote', r.remotes.length, remotes || empty('No remotes')) +
    section('tags', 'Tags', r.tags.length, tags || empty('No tags')) +
    section('stashes', 'Stashes', r.stashes.length, stashes || empty('No stashes'));

  $('#sidebar').querySelectorAll('details').forEach((d) =>
    d.addEventListener('toggle', () => {
      d.open ? S.sbClosed.delete(d.dataset.key) : S.sbClosed.add(d.dataset.key);
      save('kl.sbClosed', [...S.sbClosed]);
    }),
  );
}

function setBranchSelection(names, anchor = S.sbAnchor) {
  S.sbSel = new Set(names);
  S.sbAnchor = anchor;
  renderSidebar();
}

$('#sidebar').addEventListener('click', (e) => {
  const selBtn = e.target.closest('[data-sel]');
  if (selBtn) {
    if (selBtn.dataset.sel === 'delete') deleteBranches([...S.sbSel]);
    else setBranchSelection([], null);
    return;
  }
  const it = e.target.closest('.sb-item');
  if (!it) return;
  const { kind, name } = it.dataset;
  if (kind === 'local' && (e.metaKey || e.ctrlKey)) {
    // ⌘-click toggles one branch in the selection
    const next = new Set(S.sbSel);
    next.has(name) ? next.delete(name) : next.add(name);
    return setBranchSelection(next, name);
  }
  if (kind === 'local' && e.shiftKey && S.sbAnchor) {
    // ⇧-click selects the visible range between the anchor and this branch
    const order = S.refs.branches.map((b) => b.name);
    const [a, b] = [order.indexOf(S.sbAnchor), order.indexOf(name)].sort((x, y) => x - y);
    if (a >= 0) return setBranchSelection(order.slice(a, b + 1));
  }
  setBranchSelection(kind === 'local' ? [name] : [], kind === 'local' ? name : null);
  jumpTo(it.dataset.sha);
});
$('#sidebar').addEventListener('keydown', (e) => {
  if ((e.key === 'Backspace' || e.key === 'Delete') && S.sbSel.size) {
    e.preventDefault();
    deleteBranches([...S.sbSel]);
  } else if (e.key === 'Escape' && S.sbSel.size) {
    e.stopPropagation();
    setBranchSelection([], null);
  } else if (e.metaKey && e.key === 'a') {
    e.preventDefault();
    setBranchSelection(S.refs.branches.filter((b) => !b.current).map((b) => b.name));
  }
});
$('#sidebar').addEventListener('dblclick', (e) => {
  const it = e.target.closest('.sb-item');
  if (!it) return;
  if (it.dataset.kind === 'local') checkoutLocal(it.dataset.name);
  if (it.dataset.kind === 'remote') checkoutRemote(it.dataset.name);
  if (it.dataset.kind === 'stash') git(['stash', 'apply', `stash@{${it.dataset.index}}`], 'Stash applied');
});
$('#sidebar').addEventListener('contextmenu', (e) => {
  const it = e.target.closest('.sb-item');
  if (!it) return;
  e.preventDefault();
  const { kind, name, sha, index } = it.dataset;
  if (kind === 'local' && S.sbSel.size > 1 && S.sbSel.has(name)) {
    const n = S.sbSel.size;
    return showMenu(e, [
      [`Delete ${[...S.sbSel].filter((b) => b !== currentBranch()?.name).length} branches…`, () => deleteBranches([...S.sbSel]), 'danger'],
      null,
      ...(() => {
        const tracked = S.refs.branches.filter((b) => S.sbSel.has(b.name) && b.upstream && !b.current);
        return tracked.length ? [[`Pull ${tracked.length} branches (fast-forward)`, () => fastForward(tracked)], null] : [];
      })(),
      ['Clear selection', () => setBranchSelection([], null)],
    ]);
  }
  if (kind === 'local' && !S.sbSel.has(name)) setBranchSelection([name], name);
  if (kind === 'stash') {
    const ref = `stash@{${index}}`;
    return showMenu(e, [
      ['Apply stash', () => git(['stash', 'apply', ref], 'Stash applied')],
      ['Pop stash', () => git(['stash', 'pop', ref], 'Stash popped')],
      null,
      ['Delete stash…', () => dropStash(ref, name), 'danger'],
    ]);
  }
  showMenu(e, refMenu(kind, name, sha));
});

// ------------------------------------------------------------------ branch operations

async function dropStash(ref, message) {
  if (!(await ask(`Delete ${ref}?\n\n${message}`, { ok: 'Delete', danger: true }))) return;
  const out = await git(['stash', 'drop', ref]);
  const sha = /\(([0-9a-f]{7,64})\)/.exec(out || '')?.[1];
  if (sha) offerUndo(`Deleted ${ref}`, () => gitRaw(['stash', 'store', '-m', message, sha]));
}

async function deleteTag(name) {
  if (!(await ask(`Delete local tag ${name}?`, { ok: 'Delete', danger: true }))) return;
  const obj = await revParse(`refs/tags/${name}`).catch(() => null);
  const out = await git(['tag', '-d', name]);
  if (out === null) return;
  if (obj) offerUndo(`Deleted tag ${name}`, () => gitRaw(['tag', name, obj]));
}

async function deleteRemoteBranch(name, remote, branch) {
  if (!(await ask(`Delete branch ${branch} on remote ${remote}?`, { ok: 'Delete', danger: true }))) return;
  const sha = S.refs.remotes.find((r) => r.name === name)?.sha;
  const out = await git(['push', remote, '--delete', branch]);
  if (out === null) return;
  if (sha) offerUndo(`Deleted ${name}`, () => gitRaw(['push', remote, `${sha}:refs/heads/${branch}`]));
  else toast(`Deleted ${name}`, 'ok');
}

async function confirmRun(msg, args, okMsg) {
  if (await ask(msg, { ok: 'Continue', danger: true })) await git(args, okMsg);
}
function checkoutLocal(name) {
  if (currentBranch()?.name === name) return;
  return git(['switch', name], `Checked out ${name}`);
}
function checkoutRemote(remoteName) {
  const remote = S.refs.remote_names.find((n) => remoteName.startsWith(n + '/'));
  const local = remote ? remoteName.slice(remote.length + 1) : remoteName;
  if (S.refs.branches.some((b) => b.name === local)) return checkoutLocal(local);
  return git(['switch', '--track', remoteName], `Checked out ${local} tracking ${remoteName}`);
}

function refMenu(kind, name, sha) {
  const cur = currentBranch()?.name;
  if (kind === 'tag') {
    return [
      ['Copy tag name', () => navigator.clipboard.writeText(name)],
      null,
      ['Delete tag…', () => deleteTag(name), 'danger'],
    ];
  }
  if (kind === 'remote') {
    const remote = S.refs.remote_names.find((n) => name.startsWith(n + '/'));
    const branch = remote ? name.slice(remote.length + 1) : name;
    return [
      [`Checkout ${branch}`, () => checkoutRemote(name)],
      cur && [`Merge ${name} into ${cur}`, () => git(['merge', name], `Merged ${name}`)],
      cur && [`Rebase ${cur} onto ${name}`, () => moveHead(['rebase', name], `Rebased ${cur} onto ${name}`)],
      null,
      ['Copy branch name', () => navigator.clipboard.writeText(name)],
      null,
      remote && [`Delete ${name} on ${remote}…`, () => deleteRemoteBranch(name, remote, branch), 'danger'],
    ];
  }
  const isCur = name === cur;
  const br = S.refs.branches.find((b) => b.name === name);
  const canFF = !isCur && br?.upstream;
  return [
    !isCur && [`Checkout ${name}`, () => checkoutLocal(name)],
    canFF && [`Pull ${br.upstream} into ${name} (fast-forward)${br.behind ? `  ↓${br.behind}` : ''}`, () => fastForward([br])],
    !isCur && cur && [`Merge ${name} into ${cur}`, () => git(['merge', name], `Merged ${name} into ${cur}`)],
    !isCur && cur && [`Rebase ${cur} onto ${name}`, () => moveHead(['rebase', name], `Rebased ${cur} onto ${name}`)],
    isCur && ['Push', () => ACTIONS.push()],
    isCur && br?.upstream && ['Force push (with lease)…', () => forcePush(br), 'danger'],
    isCur && ['Pull', () => ACTIONS.pull()],
    null,
    ['Create branch here…', () => newBranchAt(sha)],
    ['Copy branch name', () => navigator.clipboard.writeText(name)],
    null,
    !isCur && [`Delete ${name}…`, () => deleteBranches([name]), 'danger'],
  ];
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 'es'}`;
const nameList = (names, max = 12) =>
  names.slice(0, max).map((n) => `  • ${n}`).join('\n') + (names.length > max ? `\n  …and ${names.length - max} more` : '');

/** Delete local branches one by one, sorting failures into "not merged" and other errors. */
async function runBranchDeletes(names, flag) {
  const res = { deleted: [], unmerged: [], failed: [], was: new Map() };
  for (const n of names) {
    try {
      const out = await gitRaw(['branch', flag, n]);
      res.deleted.push(n);
      // "Deleted branch x (was 1a2b3c4)." — enough to recreate it.
      const was = /\(was ([0-9a-f]+)\)/.exec(out)?.[1];
      if (was) res.was.set(n, was);
    } catch (e) {
      if (/not fully merged/.test(String(e))) res.unmerged.push(n);
      else res.failed.push(`${n}: ${e}`);
    }
  }
  return res;
}

async function deleteBranches(names) {
  const cur = currentBranch()?.name;
  const keepCurrent = names.includes(cur);
  names = names.filter((n) => n !== cur);
  if (!names.length) return toast(`${cur} is checked out and can't be deleted`, 'err');
  const msg =
    names.length === 1
      ? `Delete local branch ${names[0]}?`
      : `Delete ${plural(names.length, 'local branch')}?\n\n${nameList(names)}`;
  const note = keepCurrent ? `\n\n${cur} is checked out and will be kept.` : '';
  if (!(await ask(msg + note, { ok: names.length === 1 ? 'Delete' : `Delete ${names.length}`, danger: true }))) return;

  await busy(async () => {
    const res = await runBranchDeletes(names, '-d');
    if (res.unmerged.length) {
      const force = await ask(
        `${plural(res.unmerged.length, 'branch')} ${res.unmerged.length === 1 ? 'is' : 'are'} not fully merged:\n\n${nameList(res.unmerged)}\n\nForce delete? Their unmerged commits will only be reachable via reflog.`,
        { ok: 'Force delete', danger: true },
      );
      if (force) {
        const forced = await runBranchDeletes(res.unmerged, '-D');
        res.deleted.push(...forced.deleted);
        forced.was.forEach((v, k) => res.was.set(k, v));
        res.failed.push(...forced.failed);
        res.unmerged = forced.unmerged;
      }
    }
    if (res.deleted.length) {
      const msg = res.deleted.length === 1 ? `Deleted ${res.deleted[0]}` : `Deleted ${plural(res.deleted.length, 'branch')}`;
      const restore = [...res.was];
      offerUndo(msg, async () => {
        for (const [n, sha] of restore) await gitRaw(['branch', n, sha]);
      });
    }
    if (res.unmerged.length) toast(`Kept ${plural(res.unmerged.length, 'unmerged branch')}`);
    if (res.failed.length) toast(res.failed.join('\n'), 'err');
    // Keep only branches that survived (e.g. declined force delete) so they can be retried.
    S.sbSel = new Set(res.unmerged);
    await refresh();
  });
}

/**
 * Update local branches from their upstream without checking them out. The backend runs one
 * `git fetch <remote> <ref>:refs/heads/<branch> …` per remote, which only fast-forwards.
 */
async function fastForward(branches) {
  const before = new Map(S.refs.branches.map((b) => [b.name, b.sha]));
  const list = branches.map((b) => ({ name: b.name, remote: b.upstream_remote, remote_ref: b.upstream_ref }));
  let res;
  try {
    res = await busy(() => invoke('fast_forward', { profileId: activeProfile().id, repo: S.repo, branches: list }));
  } catch (e) {
    return toast(explainGitError(String(e)), 'err');
  }
  await busy(refresh);
  const after = new Map(S.refs.branches.map((b) => [b.name, b.sha]));
  const names = (o) => res.filter((r) => r.outcome === o).map((r) => r.name);
  const moved = names('updated'), current = names('current'), diverged = names('diverged');
  const failed = res
    .filter((r) => r.outcome === 'checked-out' || r.outcome === 'failed')
    .map((r) => (r.outcome === 'checked-out' ? `${r.name} is checked out${r.name === currentBranch()?.name ? '' : ' in another worktree'}` : `${r.name}: ${r.detail}`));
  if (moved.length) toast(moved.length === 1 ? `Fast-forwarded ${moved[0]} (${short(before.get(moved[0]))} → ${short(after.get(moved[0]))})` : `Fast-forwarded ${plural(moved.length, 'branch')}`, 'ok');
  if (current.length) toast(current.length === 1 ? `${current[0]} is already up to date` : `${plural(current.length, 'branch')} already up to date`);
  if (diverged.length)
    toast(`Can't fast-forward ${diverged.join(', ')}: ${diverged.length === 1 ? 'it has' : 'they have'} local commits that aren't upstream. Check out and merge or rebase instead.`, 'err');
  if (failed.length) toast(explainGitError(failed.join('\n')), 'err');
}

async function newBranchAt(sha) {
  const name = await ask(`New branch at ${short(sha)}`, { input: true, placeholder: 'branch-name', ok: 'Create' });
  if (name) await git(['switch', '-c', name, sha], `Created ${name}`);
}

// ------------------------------------------------------------------ graph

function layoutGraph() {
  const lanes = Math.max(1, S.graph?.max_lanes || 1);
  S.graphW = Math.max(60, Math.min(320, LANE_X0 * 2 + (lanes - 1) * LANE_W));
  $('#center').style.setProperty('--graph-w', `${S.graphW}px`);
  $('#graph-spacer').style.height = `${S.rows.length * ROW_H}px`;
}

const lx = (c) => LANE_X0 + c * LANE_W;

function graphSvg(r) {
  const ys = [0, ROW_H / 2, ROW_H];
  const wip = r.sha === 'WIP';
  let paths = '';
  for (const [x1, y1, x2, y2, c] of r.edges) {
    const X1 = lx(x1), Y1 = ys[y1], X2 = lx(x2), Y2 = ys[y2];
    let d;
    if (X1 === X2) d = `M${X1} ${Y1}L${X2} ${Y2}`;
    else {
      const my = (Y1 + Y2) / 2;
      d = `M${X1} ${Y1}C${X1} ${my} ${X2} ${my} ${X2} ${Y2}`;
    }
    paths += `<path d="${d}" stroke="${laneColor(c)}" stroke-width="2" fill="none"${wip ? ' stroke-dasharray="3 3"' : ''}/>`;
  }
  const cx = lx(r.col), cy = ROW_H / 2, col = laneColor(r.color);
  let node;
  if (wip) node = `<circle cx="${cx}" cy="${cy}" r="7" fill="#1b1d23" stroke="${col}" stroke-width="2" stroke-dasharray="3 2"/>`;
  else if (r.parents.length > 1) node = `<circle cx="${cx}" cy="${cy}" r="4.5" fill="${col}"/>`;
  else
    node = `<circle cx="${cx}" cy="${cy}" r="9" fill="${col}" stroke="#1b1d23" stroke-width="1.5"/>` +
      `<text x="${cx}" y="${cy + 3}" text-anchor="middle" font-size="8" font-weight="700" fill="#fff">${esc(initials(r.author))}</text>`;
  return `<svg width="${S.graphW}" height="${ROW_H}">${paths}${node}</svg>`;
}

function parseRefs(r) {
  const remotes = S.refs?.remote_names || [];
  const out = [];
  for (let s of r.refs) {
    let head = false;
    if (s.startsWith('HEAD -> ')) {
      head = true;
      s = s.slice(8);
    } else if (s === 'HEAD') {
      out.push({ kind: 'head', name: 'HEAD', head: true });
      continue;
    }
    if (s.startsWith('tag: ')) {
      out.push({ kind: 'tag', name: s.slice(5) });
      continue;
    }
    if (s.endsWith('/HEAD')) continue;
    const remote = remotes.find((n) => s.startsWith(n + '/'));
    out.push({ kind: remote ? 'remote' : 'local', name: s, head, remote });
  }
  // Fold "origin/main" into a local "main" pill, as GitKraken does.
  for (const p of out) {
    if (p.kind !== 'local') continue;
    const twin = out.find((q) => q.kind === 'remote' && q.name === `${q.remote}/${p.name}`);
    if (twin) {
      p.synced = true;
      twin.hidden = true;
    }
  }
  return out.filter((p) => !p.hidden).sort((a, b) => (b.head ? 1 : 0) - (a.head ? 1 : 0));
}

function pillHtml(p, color) {
  const ico = p.kind === 'tag' ? 'tag' : p.kind === 'remote' ? 'cloud' : 'laptop';
  const extra = p.synced ? icon('cloud') : '';
  return `<span class="pill ${p.head ? 'head' : ''}" style="--c:${color}" data-kind="${p.kind}" data-name="${esc(p.name)}" title="${esc(p.name)}">${icon(ico)}${esc(p.name)}${extra}</span>`;
}

function refsHtml(r) {
  if (!r.refs.length) return '';
  const pills = parseRefs(r);
  if (!pills.length) return '';
  const color = laneColor(r.color);
  let html = pillHtml(pills[0], color);
  if (pills.length > 1) html += `<span class="pill more" title="${esc(pills.slice(1).map((p) => p.name).join('\n'))}">+${pills.length - 1}</span>`;
  return html;
}

function wipSummary() {
  const st = S.status;
  if (!st) return '';
  const n = new Set([...st.staged, ...st.unstaged, ...st.conflicted].map((f) => f.path)).size;
  return `${n} file${n === 1 ? '' : 's'} changed`;
}

function rowHtml(r, i) {
  const wip = r.sha === 'WIP';
  const cls = ['row', wip && 'wip', r.parents.length > 1 && 'merge', S.selected === r.sha && 'sel', S.matchSet.has(r.sha) && 'match']
    .filter(Boolean)
    .join(' ');
  const msg = wip ? `// WIP — ${wipSummary()}` : esc(r.subject);
  return `<div class="${cls}" data-i="${i}" style="top:${i * ROW_H}px">
    <div class="c-refs">${refsHtml(r)}</div>
    <div class="c-graph">${graphSvg(r)}</div>
    <div class="c-msg" title="${wip ? '' : esc(r.subject)}">${msg}</div>
    <div class="c-author">${esc(r.author)}</div>
    <div class="c-date" title="${wip ? '' : fmtFull(r.time)}">${wip ? '' : fmtDate(r.time)}</div>
  </div>`;
}

let renderedRange = '';
function renderRows(force = true) {
  const sc = $('#graph-scroll');
  const total = S.rows.length;
  const first = Math.max(0, Math.floor(sc.scrollTop / ROW_H) - 20);
  const last = Math.min(total, Math.ceil((sc.scrollTop + sc.clientHeight) / ROW_H) + 20);
  // While scrolling, only rebuild when the window has drifted near the buffer edge.
  const key = `${first}:${last}`;
  if (!force && renderedRange) {
    const [f, l] = renderedRange.split(':').map(Number);
    const vFirst = Math.floor(sc.scrollTop / ROW_H);
    const vLast = Math.ceil((sc.scrollTop + sc.clientHeight) / ROW_H);
    if (vFirst - f >= 5 && l - vLast >= 5) return;
  }
  renderedRange = key;
  let html = '';
  for (let i = first; i < last; i++) html += rowHtml(S.rows[i], i);
  $('#graph-rows').innerHTML = html || (S.graph && !total ? '<div class="diff-empty">This repository has no commits yet.</div>' : '');
}
// Render synchronously in the scroll event so fast wheel/trackpad scrolls never paint empty rows.
$('#graph-scroll').addEventListener('scroll', () => renderRows(false), { passive: true });
new ResizeObserver(() => S.repo && renderRows()).observe($('#graph-scroll'));

function select(sha, scroll = false) {
  if (!sha) return;
  S.selected = sha;
  closeDiff();
  closeConflict();
  if (scroll) ensureVisible(S.index.get(sha));
  renderRows();
  renderDetail();
}

function ensureVisible(i) {
  if (i == null) return;
  const sc = $('#graph-scroll');
  const top = i * ROW_H;
  if (top < sc.scrollTop) sc.scrollTop = top - ROW_H * 2;
  else if (top + ROW_H > sc.scrollTop + sc.clientHeight) sc.scrollTop = top - sc.clientHeight + ROW_H * 3;
}

function jumpTo(sha) {
  if (!S.index.has(sha)) return toast('Commit is outside the loaded history');
  select(sha, true);
}

$('#graph-rows').addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (row) select(S.rows[+row.dataset.i].sha);
});
$('#graph-rows').addEventListener('dblclick', (e) => {
  const pill = e.target.closest('.pill[data-kind]');
  if (pill) {
    if (pill.dataset.kind === 'local') return checkoutLocal(pill.dataset.name);
    if (pill.dataset.kind === 'remote') return checkoutRemote(pill.dataset.name);
    return;
  }
  const row = e.target.closest('.row');
  if (!row) return;
  const r = S.rows[+row.dataset.i];
  const local = parseRefs(r).find((p) => p.kind === 'local');
  if (local) checkoutLocal(local.name);
});
$('#graph-rows').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  e.preventDefault();
  const r = S.rows[+row.dataset.i];
  select(r.sha);
  const pill = e.target.closest('.pill[data-kind]');
  if (pill && pill.dataset.kind !== 'head') return showMenu(e, refMenu(pill.dataset.kind, pill.dataset.name, r.sha));
  if (r.sha === 'WIP') {
    return showMenu(e, [
      ['Stash all changes…', () => ACTIONS.stash()],
      ['Stage all changes', () => git(['add', '-A'], 'Staged all changes')],
      null,
      ['Discard all changes…', () => discardAll(), 'danger'],
    ]);
  }
  const cur = currentBranch()?.name || 'HEAD';
  const merge = r.parents.length > 1 ? ['-m', '1'] : [];
  const branchItems = parseRefs(r)
    .filter((p) => p.kind === 'local' && p.name !== currentBranch()?.name)
    .flatMap((p) => [[`Checkout ${p.name}`, () => checkoutLocal(p.name)], [`Merge ${p.name} into ${cur}`, () => git(['merge', p.name], `Merged ${p.name}`)]]);
  showMenu(e, [
    ...branchItems,
    branchItems.length ? null : false,
    ['Create branch here…', () => newBranchAt(r.sha)],
    ['Create tag here…', () => newTag(r.sha)],
    ['Checkout this commit (detached)', () => confirmRun(`Check out ${short(r.sha)} in detached HEAD state?`, ['checkout', '--detach', r.sha], `HEAD at ${short(r.sha)}`)],
    null,
    ['Cherry-pick commit', () => git(['cherry-pick', ...merge, r.sha], `Cherry-picked ${short(r.sha)}`)],
    ['Revert commit', () => git(['revert', '--no-edit', ...merge, r.sha], `Reverted ${short(r.sha)}`)],
    null,
    r.sha !== S.graph?.head_sha && [`Interactive rebase ${cur} from here…`, () => openRebase(r.sha)],
    null,
    [`Reset ${cur} to here — soft`, () => resetTo(r.sha, 'soft')],
    [`Reset ${cur} to here — mixed`, () => resetTo(r.sha, 'mixed')],
    [`Reset ${cur} to here — hard…`, () => resetTo(r.sha, 'hard'), 'danger'],
    null,
    ['Copy commit SHA', () => navigator.clipboard.writeText(r.sha).then(() => toast('SHA copied'))],
  ]);
});

/** Reset the current branch; undo moves it back and restores what a hard reset threw away. */
async function resetTo(sha, mode) {
  const cur = currentBranch()?.name || 'HEAD';
  if (mode === 'hard' && !(await ask(`Hard reset ${cur} to ${short(sha)}?\nUncommitted changes are discarded (you can undo right after).`, { ok: 'Reset', danger: true }))) return;
  let snapshot = null;
  try {
    // Mixed/hard rewrite the index; hard also the working tree (untracked files are left alone).
    const tracked = mode === 'hard' ? dirtyPaths().filter((p) => !S.status.unstaged.some((f) => f.path === p && f.status === '?')) : [];
    if (mode !== 'soft') snapshot = await takeSnapshot(tracked, true);
  } catch (e) {
    return toast(`Couldn't save your changes before the reset: ${e}`, 'err');
  }
  await moveHead(['reset', `--${mode}`, sha], `${mode[0].toUpperCase()}${mode.slice(1)} reset ${cur} to ${short(sha)}`, {
    undoMode: mode === 'hard' ? 'keep' : mode,
    snapshot,
  });
}

const dirtyPaths = () => [...new Set([...S.status.staged, ...S.status.unstaged, ...S.status.conflicted].map((f) => f.path))];

async function newTag(sha) {
  const name = await ask(`New tag at ${short(sha)}`, { input: true, placeholder: 'v1.0.0', ok: 'Create' });
  if (name) await git(['tag', name, sha], `Tagged ${name}`);
}

async function discardAll() {
  if (!(await ask('Discard ALL uncommitted changes, including untracked files?', { ok: 'Discard all', danger: true }))) return;
  await busy(async () => {
    try {
      const snapshot = await takeSnapshot(dirtyPaths(), true);
      if (S.graph?.head_sha) await gitRaw(['reset', '--hard']);
      await gitRaw(['clean', '-fd']);
      offerUndo('All changes discarded', () => restoreSnapshot(snapshot));
    } catch (e) {
      toast(String(e), 'err');
    }
    await refresh();
  });
}

// keyboard navigation in graph
$('#graph-scroll').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const i = S.index.get(S.selected) ?? -1;
  const n = Math.max(0, Math.min(S.rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
  if (S.rows[n]) select(S.rows[n].sha, true);
});

// ------------------------------------------------------------------ search

function runSearch(q, jump = true) {
  q = q.trim().toLowerCase();
  S.matches = [];
  if (q) {
    S.rows.forEach((r, i) => {
      if (r.sha === 'WIP') return;
      if (r.sha.startsWith(q) || r.subject.toLowerCase().includes(q) || r.author.toLowerCase().includes(q) || r.email.toLowerCase().includes(q)) S.matches.push(i);
    });
  }
  S.matchSet = new Set(S.matches.map((i) => S.rows[i].sha));
  if (jump) {
    S.matchPos = -1;
    nextMatch();
  }
  renderRows();
}
function nextMatch(dir = 1) {
  if (!S.matches.length) return;
  S.matchPos = (S.matchPos + dir + S.matches.length) % S.matches.length;
  select(S.rows[S.matches[S.matchPos]].sha, true);
}
let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(e.target.value), 120);
});
$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') nextMatch(e.shiftKey ? -1 : 1);
  if (e.key === 'Escape') {
    e.target.value = '';
    runSearch('', false);
    $('#graph-scroll').focus();
  }
});

// ------------------------------------------------------------------ detail panel

function fileRow(f, mode, actions = '') {
  const slash = f.path.lastIndexOf('/');
  const dir = slash >= 0 ? f.path.slice(0, slash + 1) : '';
  const base = f.path.slice(slash + 1);
  const sel = S.file && S.file.path === f.path && S.file.mode === mode ? ' sel' : '';
  const title = f.orig ? `${f.orig} → ${f.path}` : f.path;
  return `<div class="f-row${sel}" data-path="${esc(f.path)}" data-mode="${mode}" data-status="${esc(f.status)}" data-xy="${esc(f.conflict || '')}" title="${esc(title)}">
    <span class="st st-${esc(f.status)}">${esc(f.status === '?' ? 'A' : f.status)}</span>
    <span class="p"><span class="ell">…</span><span class="dir"><span>${esc(dir)}</span></span><span class="base">${esc(base)}</span></span>
    ${f.conflict ? `<small class="cx">${esc(CONFLICT_KIND[f.conflict] || f.conflict)}</small>` : ''}
    <span class="acts">${actions}</span></div>`;
}

/**
 * File rows keep the file name whole and clip the folder path from the left; a separate "…"
 * shows only when the folder is actually clipped (CSS ellipsis in RTL boxes overlaps the text).
 */
function markCutPaths() {
  $('#detail').querySelectorAll('.f-row .p').forEach((p) => {
    const d = p.querySelector('.dir');
    p.classList.toggle('cut', d.scrollWidth > d.clientWidth + 1);
  });
}
new ResizeObserver(() => markCutPaths()).observe($('#detail'));

function renderDetail() {
  if (!S.repo || !S.selected) {
    $('#detail').innerHTML = '';
    return;
  }
  if (S.selected === 'WIP') renderWip();
  else renderCommit(S.selected);
}

// --- work in progress

const draft = { summary: '', body: '', amend: false };

function renderWip() {
  const d = $('#detail');
  if (!$('#wip-panel', d)) {
    d.innerHTML = `<div id="wip-panel" style="display:contents">
      <div class="d-head"><h2 id="wip-title"></h2><div class="sha-line" id="wip-sub"></div></div>
      <div class="d-scroll" id="wip-files"></div>
      <div class="commit-box">
        <div class="summary-wrap"><input id="c-summary" placeholder="Commit summary" spellcheck="true"><span class="count" id="c-count"></span></div>
        <textarea id="c-body" placeholder="Description (optional)"></textarea>
        <label><input type="checkbox" id="c-amend"> Amend previous commit</label>
        <button class="primary" id="c-go">Commit</button>
      </div></div>`;
    const sum = $('#c-summary'), body = $('#c-body'), amend = $('#c-amend');
    sum.value = draft.summary;
    body.value = draft.body;
    amend.checked = draft.amend;
    sum.addEventListener('input', () => {
      draft.summary = sum.value;
      updateCommitButton();
    });
    body.addEventListener('input', () => (draft.body = body.value));
    amend.addEventListener('change', async () => {
      draft.amend = amend.checked;
      if (amend.checked && !sum.value && S.graph?.head_sha) {
        try {
          const c = await getCommit(S.graph.head_sha);
          const [s, ...rest] = c.message.split('\n');
          sum.value = draft.summary = s;
          body.value = draft.body = rest.join('\n').trim();
        } catch {}
      }
      updateCommitButton();
    });
    $('#c-go').addEventListener('click', doCommit);
    [sum, body].forEach((el) =>
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.metaKey) doCommit();
      }),
    );
  }
  const st = S.status;
  $('#wip-title').textContent = `${wipSummary()}`;
  $('#wip-sub').textContent = `on ${S.graph.head_branch || 'detached HEAD'}`;

  const stageBtn = '<button class="mini" data-do="stage">Stage</button>';
  const discardBtn = '<button class="mini danger" data-do="discard">Discard</button>';
  const unstageBtn = '<button class="mini" data-do="unstage">Unstage</button>';
  let html = opBannerHtml();
  if (st.conflicted.length) {
    html += `<div class="f-section-h conflicts">Conflicts (${st.conflicted.length})<span class="spacer"></span><small>click a file to resolve</small></div>` +
      st.conflicted.map((f) => fileRow(f, 'conflict')).join('');
  }
  html += `<div class="f-section-h">Unstaged Files (${st.unstaged.length})<span class="spacer"></span>${st.unstaged.length ? '<button class="mini" data-do="stage-all">Stage all</button>' : ''}</div>`;
  html += st.unstaged.length ? st.unstaged.map((f) => fileRow(f, 'unstaged', stageBtn + discardBtn)).join('') : '<div class="f-empty">No unstaged changes</div>';
  html += `<div class="f-section-h">Staged Files (${st.staged.length})<span class="spacer"></span>${st.staged.length ? '<button class="mini" data-do="unstage-all">Unstage all</button>' : ''}</div>`;
  html += st.staged.length ? st.staged.map((f) => fileRow(f, 'staged', unstageBtn)).join('') : '<div class="f-empty">No staged changes</div>';
  $('#wip-files').innerHTML = html;
  markCutPaths();
  // Rebase/cherry-pick/revert commit through Continue; a manual commit would add an extra one.
  const op = S.op?.kind;
  $('.commit-box').style.display = op && op !== 'merge' ? 'none' : '';
  if (op === 'merge' && !draft.summary && !draft.mergePrefilled && S.op.message) {
    const [first, ...rest] = S.op.message.split('\n').filter((l) => !l.startsWith('#'));
    $('#c-summary').value = draft.summary = first || '';
    $('#c-body').value = draft.body = rest.join('\n').trim();
    draft.mergePrefilled = true;
  }
  if (!op) draft.mergePrefilled = false;
  updateCommitButton();
}

function updateCommitButton() {
  const btn = $('#c-go');
  if (!btn) return;
  const n = S.status?.staged.length || 0;
  const len = draft.summary.length;
  const count = $('#c-count');
  count.textContent = len ? String(72 - len) : '';
  count.classList.toggle('over', len > 72);
  const merging = S.op?.kind === 'merge';
  btn.disabled = !draft.summary.trim() || (!n && !draft.amend && !merging) || S.status?.conflicted.length > 0;
  btn.textContent = merging
    ? 'Commit merge'
    : draft.amend
      ? 'Amend previous commit'
      : n
        ? `Commit changes to ${n} file${n === 1 ? '' : 's'}`
        : 'Stage files to commit';
}

async function doCommit() {
  if ($('#c-go').disabled) return;
  const msg = draft.summary.trim() + (draft.body.trim() ? `\n\n${draft.body.trim()}` : '');
  const args = ['commit', ...(draft.amend ? ['--amend'] : []), '-m', msg];
  // Undoing an amend brings back the original commit, with the amended changes staged.
  const out = draft.amend ? await moveHead(args, 'Commit amended', { undoMode: 'soft' }) : await git(args, 'Committed');
  if (out !== null) {
    draft.summary = draft.body = '';
    draft.amend = false;
    $('#c-summary').value = $('#c-body').value = '';
    $('#c-amend').checked = false;
    updateCommitButton();
  }
}

async function unstage(paths) {
  try {
    await gitRaw(['restore', '--staged', '--', ...paths]);
  } catch {
    // No HEAD yet (initial commit): drop from the index instead.
    await gitRaw(['rm', '--cached', '-r', '-q', '--', ...paths]);
  }
}

async function fileAction(kind, path, status) {
  await busy(async () => {
    try {
      if (kind === 'stage') await gitRaw(['add', '-A', '--', path]);
      if (kind === 'unstage') await unstage([path]);
      if (kind === 'stage-all') await gitRaw(['add', '-A']);
      if (kind === 'unstage-all') await unstage(S.status.staged.map((f) => f.path));
      if (kind === 'discard') {
        if (!(await ask(`Discard changes to ${path}?`, { ok: 'Discard', danger: true }))) return;
        const snapshot = await takeSnapshot([path]);
        if (status === '?') await gitRaw(['clean', '-f', '--', path]);
        else await gitRaw(['restore', '--worktree', '--', path]);
        if (S.file?.path === path) closeDiff();
        offerUndo(`Discarded changes to ${path}`, () => restoreSnapshot(snapshot));
      }
    } catch (e) {
      toast(String(e), 'err');
    }
    await refresh();
  });
}

$('#detail').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-do]');
  const row = e.target.closest('.f-row');
  if (btn) {
    e.stopPropagation();
    return fileAction(btn.dataset.do, row?.dataset.path, row?.dataset.status);
  }
  const link = e.target.closest('[data-sha-link]');
  if (link) return jumpTo(link.dataset.shaLink);
  if (row && row.dataset.mode === 'conflict') return openConflict(row.dataset.path, row.dataset.xy);
  if (row) {
    const mode = row.dataset.mode;
    showDiff({ path: row.dataset.path, mode, sha: mode === 'commit' ? S.selected : null, untracked: row.dataset.status === '?' });
  }
});
$('#detail').addEventListener('dblclick', (e) => {
  const row = e.target.closest('.f-row');
  if (!row || e.target.closest('[data-do]')) return;
  if (row.dataset.mode === 'unstaged') fileAction('stage', row.dataset.path);
  if (row.dataset.mode === 'staged') fileAction('unstage', row.dataset.path);
});

// --- commit

async function getCommit(sha) {
  if (S.commitCache.has(sha)) return S.commitCache.get(sha);
  const c = await invoke('get_commit', { repo: S.repo, sha });
  S.commitCache.set(sha, c);
  return c;
}

async function renderCommit(sha) {
  let c;
  try {
    c = await getCommit(sha);
  } catch (e) {
    $('#detail').innerHTML = `<div class="f-empty">${esc(e)}</div>`;
    return;
  }
  if (S.selected !== sha) return;
  const [summary, ...rest] = c.message.split('\n');
  const body = rest.join('\n').trim();
  const parents = c.parents.map((p) => `<a data-sha-link="${p}">${short(p)}</a>`).join(' ');
  const committed = c.committer !== c.author || c.commit_time !== c.time ? `<small>committed by ${esc(c.committer)} · ${fmtDate(c.commit_time)}</small>` : '';
  $('#detail').innerHTML = `
    <div class="d-head">
      <div class="sha-line"><span>commit <a data-sha-link="${c.sha}" title="${c.sha}">${short(c.sha)}</a></span>${parents ? `<span>parent ${parents}</span>` : ''}</div>
      <h2>${esc(summary)}</h2>
      ${body ? `<div class="body">${esc(body)}</div>` : ''}
      <div class="d-meta">${avatar(c.author, c.email)}<div class="who"><b>${esc(c.author)}</b><small title="${fmtFull(c.time)}">authored ${fmtDate(c.time)} · ${esc(c.email)}</small>${committed}</div></div>
    </div>
    <div class="d-scroll">
      <div class="f-section-h">${c.files.length} changed file${c.files.length === 1 ? '' : 's'}${c.parents.length > 1 ? ' <small>(vs first parent)</small>' : ''}</div>
      ${c.files.map((f) => fileRow(f, 'commit')).join('') || '<div class="f-empty">No file changes</div>'}
    </div>`;
  markCutPaths();
}

// ------------------------------------------------------------------ diff view

/** Parse a unified diff of one file into header lines and hunks. */
function parseDiff(text) {
  const m = { header: [], hunks: [], binary: false, whole: false, adds: 0, dels: 0 };
  let h = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('Binary files')) m.binary = true;
    if (line.startsWith('@@')) {
      const r = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!r) continue;
      h = { head: line, old: +r[1], new: +r[2], lines: [] };
      m.hunks.push(h);
      continue;
    }
    if (!h) {
      if (line) m.header.push(line);
      // New, deleted and renamed files are staged as a whole.
      if (/^(new file|deleted file|rename from|copy from)/.test(line)) m.whole = true;
      continue;
    }
    const k = line[0];
    if (k === '+' || k === '-' || k === ' ') {
      h.lines.push({ k, t: line.slice(1) });
      if (k === '+') m.adds++;
      if (k === '-') m.dels++;
    } else if (k === '\\' && h.lines.length) h.lines[h.lines.length - 1].noeol = true;
  }
  return m;
}

/** Can lines/hunks of this diff be staged, unstaged or discarded on their own? */
const partialOk = (file, m) => (file.mode === 'unstaged' || file.mode === 'staged') && !file.untracked && !m.binary && !m.whole && m.hunks.length;

function diffHtml(m, file) {
  if (m.binary) return '<div class="diff-empty">Binary file — no text diff available.</div>';
  if (!m.hunks.length) return '<div class="diff-empty">No textual changes (mode change or empty file).</div>';
  const partial = partialOk(file, m);
  const hunkBtns =
    !partial ? '' : file.mode === 'unstaged'
      ? '<button class="mini" data-hunk="stage">Stage hunk</button><button class="mini danger" data-hunk="discard">Discard hunk</button>'
      : '<button class="mini" data-hunk="unstage">Unstage hunk</button>';
  let html = '', count = 0;
  for (const [hi, h] of m.hunks.entries()) {
    html += `<div class="hunk" data-h="${hi}"><span>${esc(h.head)}</span>${hunkBtns}</div>`;
    let o = h.old, n = h.new;
    for (const [li, ln] of h.lines.entries()) {
      if (++count > 20000) return `<div class="diff-lines${partial ? ' picking' : ''}">${html}</div><div class="diff-empty">Diff truncated (over 20,000 lines).</div>`;
      const key = `${hi}:${li}`;
      const eol = ln.noeol ? '<span class="noeol" title="No newline at end of file">⏎̸</span>' : '';
      if (ln.k === '+')
        html += `<div class="dl add${S.lineSel.has(key) ? ' picked' : ''}" data-k="${key}"><span class="n"></span><span class="n">${n++}</span><span class="s">+</span><span class="t">${esc(ln.t)}${eol}</span></div>`;
      else if (ln.k === '-')
        html += `<div class="dl del${S.lineSel.has(key) ? ' picked' : ''}" data-k="${key}"><span class="n">${o++}</span><span class="n"></span><span class="s">−</span><span class="t">${esc(ln.t)}${eol}</span></div>`;
      else html += `<div class="dl"><span class="n">${o++}</span><span class="n">${n++}</span><span class="s"></span><span class="t">${esc(ln.t)}${eol}</span></div>`;
    }
  }
  return `<div class="diff-lines${partial ? ' picking' : ''}">${html}</div>`;
}

/**
 * Patch containing only the picked changed lines. Applied forward (stage) the target is the
 * old side, so unpicked "-" lines stay as context and unpicked "+" lines vanish; applied in
 * reverse (unstage/discard) it's the other way round. `git apply --recount` fixes the counts.
 */
function buildPatch(m, pick, reverse) {
  let out = '';
  for (const [hi, h] of m.hunks.entries()) {
    const body = [];
    let picked = 0;
    for (const [li, ln] of h.lines.entries()) {
      let k = ln.k;
      if (k !== ' ') {
        if (pick(hi, li)) picked++;
        else if ((k === '-') !== reverse) k = ' ';
        else continue;
      }
      body.push(k + ln.t);
      if (ln.noeol) body.push('\\ No newline at end of file');
    }
    if (picked) out += `@@ -${h.old} +${h.new} @@\n${body.join('\n')}\n`;
  }
  if (!out) return '';
  const header = m.header.filter((l) => !/^(old|new) mode /.test(l));
  return `${header.join('\n')}\n${out}`;
}

async function applyPicked(mode, pick, what) {
  const file = S.file;
  const m = S.diffModel;
  if (!file || !m) return;
  const patch = buildPatch(m, pick, mode !== 'stage');
  if (!patch) return;
  if (mode === 'discard' && !(await ask(`Discard ${what} in ${file.path}?`, { ok: 'Discard', danger: true }))) return;
  await busy(async () => {
    try {
      const snapshot = mode === 'discard' ? await takeSnapshot([file.path]) : null;
      await invoke('apply_patch', { profileId: activeProfile().id, repo: S.repo, patch, mode });
      S.lineSel.clear();
      if (snapshot) offerUndo(`Discarded ${what} in ${file.path}`, () => restoreSnapshot(snapshot));
    } catch (e) {
      toast(explainGitError(String(e)), 'err');
    }
    await refresh();
  });
}

function diffActionsHtml(file) {
  const n = S.lineSel.size;
  const lines = `${n} line${n === 1 ? '' : 's'}`;
  if (n && file.mode === 'unstaged')
    return `<button class="mini" data-diff-do="lines-stage">Stage ${lines}</button><button class="mini danger" data-diff-do="lines-discard">Discard ${lines}</button><button class="mini" data-diff-do="lines-clear">Clear</button>`;
  if (n && file.mode === 'staged')
    return `<button class="mini" data-diff-do="lines-unstage">Unstage ${lines}</button><button class="mini" data-diff-do="lines-clear">Clear</button>`;
  const back = file.back ? '<button class="mini" data-diff-do="back">← Back</button>' : '';
  const nav = file.untracked
    ? ''
    : ['blame', 'history'].filter((m) => m !== file.mode).map((m) => `<button class="mini" data-diff-do="${m}">${m[0].toUpperCase()}${m.slice(1)}</button>`).join('');
  if (file.mode === 'unstaged') return back + nav + '<button class="mini" data-diff-do="stage">Stage file</button><button class="mini danger" data-diff-do="discard">Discard</button>';
  if (file.mode === 'staged') return back + nav + '<button class="mini" data-diff-do="unstage">Unstage file</button>';
  return back + nav;
}

/** Open a full-pane view (diff, blame, history) for a file, replacing the current one. */
function openFileView(file) {
  if (file.mode === 'blame') return showBlame(file);
  if (file.mode === 'history') return showHistory(file);
  return showDiff(file);
}

function showPane(file, path, stats, html, keepScroll) {
  $('#diff-path').textContent = path;
  $('#diff-stats').innerHTML = stats;
  $('#diff-actions').innerHTML = diffActionsHtml(file);
  const body = $('#diff-body');
  const keep = keepScroll ? body.scrollTop : 0;
  body.innerHTML = html;
  body.scrollTop = keep;
  $('#diff-view').hidden = false;
  document.querySelectorAll('#detail .f-row').forEach((r) => r.classList.toggle('sel', r.dataset.path === file.path && r.dataset.mode === file.mode));
}

async function showDiff(file, silent = false) {
  S.file = file;
  try {
    const text = await invoke('get_diff', { repo: S.repo, path: file.path, mode: file.mode, sha: file.sha || null, untracked: !!file.untracked });
    if (S.file !== file) return;
    // Keep picked lines only while the diff they refer to is unchanged.
    if (text !== S.diffText) S.lineSel.clear();
    S.diffText = text;
    S.diffModel = parseDiff(text);
    S.lineAnchor = null;
    const m = S.diffModel;
    showPane(file, file.path, `<span class="add-c">+${m.adds}</span> <span class="del-c">−${m.dels}</span>`, diffHtml(m, file), silent);
  } catch (e) {
    if (!silent) toast(String(e), 'err');
  }
}

function closeDiff() {
  S.file = null;
  S.diffModel = null;
  S.diffText = null;
  S.lineSel.clear();
  $('#diff-view').hidden = true;
  document.querySelectorAll('#detail .f-row.sel').forEach((r) => r.classList.remove('sel'));
}

function refreshPicked() {
  document.querySelectorAll('#diff-body .dl[data-k]').forEach((el) => el.classList.toggle('picked', S.lineSel.has(el.dataset.k)));
  if (S.file) $('#diff-actions').innerHTML = diffActionsHtml(S.file);
}

// Pick changed lines by clicking their gutter (⇧-click for a range); the text stays selectable.
$('#diff-body').addEventListener('click', (e) => {
  const hb = e.target.closest('[data-hunk]');
  if (hb) {
    const hi = +hb.closest('.hunk').dataset.h;
    const mode = hb.dataset.hunk;
    return applyPicked(mode, (h) => h === hi, 'this hunk');
  }
  const row = e.target.closest('.picking .dl[data-k]');
  if (!row || e.target.closest('.t')) return;
  const keys = [...document.querySelectorAll('#diff-body .dl[data-k]')].map((el) => el.dataset.k);
  const k = row.dataset.k;
  if (e.shiftKey && S.lineAnchor && keys.includes(S.lineAnchor)) {
    const [a, b] = [keys.indexOf(S.lineAnchor), keys.indexOf(k)].sort((x, y) => x - y);
    keys.slice(a, b + 1).forEach((x) => S.lineSel.add(x));
  } else {
    S.lineSel.has(k) ? S.lineSel.delete(k) : S.lineSel.add(k);
    S.lineAnchor = k;
  }
  refreshPicked();
});

$('#diff-close').addEventListener('click', closeDiff);
$('#diff-actions').addEventListener('click', (e) => {
  const b = e.target.closest('[data-diff-do]');
  if (!b || !S.file) return;
  const f = S.file;
  const act = b.dataset.diffDo;
  const picked = (h, l) => S.lineSel.has(`${h}:${l}`);
  const n = S.lineSel.size;
  const what = `${n} line${n === 1 ? '' : 's'}`;
  if (act === 'lines-stage') return applyPicked('stage', picked, what);
  if (act === 'lines-unstage') return applyPicked('unstage', picked, what);
  if (act === 'lines-discard') return applyPicked('discard', picked, what);
  if (act === 'lines-clear') {
    S.lineSel.clear();
    return refreshPicked();
  }
  if (act === 'back') return openFileView(f.back);
  if (act === 'blame') return openFileView({ mode: 'blame', path: f.path, rev: f.mode === 'commit' ? f.sha : null, back: f });
  if (act === 'history') return openFileView({ mode: 'history', path: f.path, back: f });
  const status = f.untracked ? '?' : '';
  if (act !== 'discard') closeDiff();
  fileAction(act, f.path, status);
});

// File rows: history / blame / open from the context menu.
$('#detail').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.f-row');
  if (!row) return;
  e.preventDefault();
  const { path, mode, status } = row.dataset;
  const sha = mode === 'commit' ? S.selected : null;
  const isNew = status === '?' || (mode === 'staged' && status === 'A');
  showMenu(e, [
    !isNew && status !== 'D' && ['Blame', () => openFileView({ mode: 'blame', path, rev: sha })],
    !isNew && ['File history', () => openFileView({ mode: 'history', path })],
    null,
    status !== 'D' && ['Open file', () => invoke('reveal', { repo: S.repo, target: 'file', path }).catch((err) => toast(String(err), 'err'))],
    ['Copy path', () => navigator.clipboard.writeText(path).then(() => toast('Path copied'))],
  ]);
});

// ------------------------------------------------------------------ context menu

function showMenu(e, items) {
  const m = $('#ctx-menu');
  const clean = items.filter((x) => x !== false && x !== undefined && x !== '');
  // collapse leading/trailing/double separators
  const list = clean.filter((x, i) => x !== null || (i > 0 && i < clean.length - 1 && clean[i - 1] !== null));
  m.innerHTML = list
    .map((x, i) =>
      x === null
        ? '<hr>'
        : `<div class="mi ${x[2] || ''}" data-i="${i}">${x[3] ? `<span class="pdot" style="--c:${esc(x[3])}"></span>` : ''}${esc(x[0])}</div>`,
    )
    .join('');
  m.hidden = false;
  const { innerWidth: W, innerHeight: H } = window;
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(e.clientX, W - r.width - 8)}px`;
  m.style.top = `${Math.min(e.clientY, H - r.height - 8)}px`;
  m.onclick = (ev) => {
    const it = ev.target.closest('.mi');
    if (!it) return;
    m.hidden = true;
    list[+it.dataset.i][1]();
  };
}
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#ctx-menu')) $('#ctx-menu').hidden = true;
});
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('input, textarea, #diff-body, .row, .sb-item, .tab')) e.preventDefault();
});

// ------------------------------------------------------------------ resizers

const layoutEl = $('#layout');
const widths = load('kl.widths', {});
if (widths.sidebar) layoutEl.style.setProperty('--sidebar-w', `${widths.sidebar}px`);
if (widths.detail) layoutEl.style.setProperty('--detail-w', `${widths.detail}px`);
document.querySelectorAll('.resizer').forEach((rz) =>
  rz.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const which = rz.dataset.resize;
    const startX = e.clientX;
    const start = which === 'sidebar' ? $('#sidebar').offsetWidth : $('#detail').offsetWidth;
    const move = (ev) => {
      const dx = ev.clientX - startX;
      const w = Math.max(160, Math.min(600, which === 'sidebar' ? start + dx : start - dx));
      widths[which] = w;
      layoutEl.style.setProperty(which === 'sidebar' ? '--sidebar-w' : '--detail-w', `${w}px`);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      save('kl.widths', widths);
      renderRows();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }),
);

// ------------------------------------------------------------------ global keys & boot

window.addEventListener('focus', () => S.repo && scheduleRefresh());

listen('repo-changed', (ev) => {
  if (ev.payload === S.repo) scheduleRefresh();
});

hydrateIcons();
// Repo/tab/profile lifecycle, global shortcuts and boot live in profiles.js.
