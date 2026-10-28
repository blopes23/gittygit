'use strict';
// Profiles (SSH key + git author) and the repository tabs each profile owns.
// Loaded after app.js and shares its globals (S, $, invoke, ask, toast, busy, refresh…).

const PROFILE_COLORS = ['#4fb3d9', '#a46ff0', '#5fc78a', '#ef9a5b', '#ef6b73', '#e6c062', '#4fd1c5', '#f472b6'];

S.store = null; // { active, profiles: [...] } as persisted by the backend
S.view = new Map(); // repo root -> { selected, scrollTop }
S.tabWarn = new Map(); // repo root -> guard warning text

const clone = (o) => JSON.parse(JSON.stringify(o));
const baseName = (p) => p.replace(/\/+$/, '').split('/').pop();
const profileById = (id, store = S.store) => store.profiles.find((p) => p.id === id);
function activeProfile() {
  return profileById(S.store.active);
}

// ------------------------------------------------------------------ persistence

/**
 * Persist a new store. Repos opted into "use in terminal" get their .git/config
 * updated: removed entries are cleaned up before saving (the backend checks the repo
 * still belongs to the saved profile), new or changed ones are written after.
 */
async function commitStore(next) {
  const before = S.store;
  const ident = (p) => `${p.ssh_key}|${p.git_name}|${p.git_email}`;
  const removals = [];
  const additions = [];
  for (const p of before.profiles) {
    for (const r of p.terminal_repos) {
      const q = profileById(p.id, next);
      if (!q || !q.terminal_repos.includes(r) || !q.tabs.includes(r)) removals.push([p.id, r]);
    }
  }
  for (const q of next.profiles) {
    q.terminal_repos = q.terminal_repos.filter((r) => q.tabs.includes(r));
    for (const r of q.terminal_repos) {
      const p = profileById(q.id, before);
      if (!p || !p.terminal_repos.includes(r) || ident(p) !== ident(q)) additions.push([q.id, r]);
    }
  }
  for (const [profileId, repo] of removals) {
    await invoke('set_terminal_config', { profileId, repo, enabled: false }).catch((e) => toast(`${baseName(repo)}: ${e}`, 'err'));
  }
  await invoke('save_profiles', { store: next });
  S.store = next;
  for (const [profileId, repo] of additions) {
    await invoke('set_terminal_config', { profileId, repo, enabled: true }).catch((e) => toast(`${baseName(repo)}: ${e}`, 'err'));
  }
}

// Store writes run one at a time, each applied to the latest state, so quick
// successive actions (switch profile, change tab…) can't overwrite each other.
let storeQueue = Promise.resolve();
function serialize(task) {
  const run = storeQueue.then(task, task);
  storeQueue = run.catch(() => {});
  return run;
}

async function mutateStore(fn) {
  return serialize(async () => {
    const next = clone(S.store);
    fn(next);
    try {
      await commitStore(next);
      return true;
    } catch (e) {
      toast(String(e), 'err');
      return false;
    }
  });
}

// ------------------------------------------------------------------ chrome

function renderProfileChrome() {
  const p = activeProfile();
  $('#profile-name').textContent = p.name;
  document.documentElement.style.setProperty('--profile', p.color || '#4fb3d9');
  renderTabs();
}

function renderTabs() {
  const p = activeProfile();
  const tabs = p.tabs
    .map((root, i) => {
      const warn = S.tabWarn.get(root);
      return `<div class="tab ${i === p.active_tab && S.repo === root ? 'active' : ''}" data-i="${i}" title="${esc(root)}">
        ${icon('repo')}<span class="t">${esc(baseName(root))}</span>
        ${warn ? `<span class="warn" title="${esc(warn)}">!</span>` : ''}
        <button class="x" data-close="${i}" title="Close tab (⌘W)">×</button></div>`;
    })
    .join('');
  $('#tabs').innerHTML = tabs || `<span class="tab-empty">No repositories in ${esc(p.name)}</span>`;
}

function saveViewState() {
  if (!S.repo) return;
  S.view.set(S.repo, { selected: S.selected, scrollTop: $('#graph-scroll').scrollTop });
}

function showWelcome() {
  S.repo = null;
  S.graph = null;
  $('#layout').hidden = true;
  $('#welcome').hidden = false;
  const p = activeProfile();
  $('#welcome-title').textContent = p.name;
  $('#welcome-sub').textContent = p.tabs.length ? '' : 'Open or clone a repository to add it to this profile.';
  const inAnyProfile = new Set(S.store.profiles.flatMap((q) => q.tabs));
  const list = load('kl.recent', []).filter((r) => !inAnyProfile.has(r.root));
  $('#recent-title').hidden = !list.length;
  $('#recent-list').innerHTML = list
    .map((r) => `<li data-root="${esc(r.root)}"><b>${esc(r.name)}</b><small>${esc(r.root)}</small></li>`)
    .join('');
  document.title = `${p.name} — Gittygit`;
  renderTabs();
}

function rememberRecent(root) {
  const list = load('kl.recent', []).filter((r) => r.root !== root);
  list.unshift({ root, name: baseName(root) });
  save('kl.recent', list.slice(0, 20));
}

// ------------------------------------------------------------------ tabs

async function activateTab(i) {
  const p = activeProfile();
  saveViewState();
  if (!p.tabs.length) return showWelcome();
  i = Math.max(0, Math.min(p.tabs.length - 1, i));
  const root = p.tabs[i];
  if (p.active_tab !== i) await mutateStore((s) => (profileById(p.id, s).active_tab = i));

  const view = S.view.get(root) || {};
  S.repo = root;
  S.name = baseName(root);
  S.selected = view.selected || null;
  S.commitCache.clear();
  S.matches = [];
  S.matchSet = new Set();
  S.sbSel = new Set();
  $('#search').value = '';
  closeDiff();
  $('#detail').innerHTML = '';
  $('#graph-rows').innerHTML = '';
  $('#welcome').hidden = true;
  $('#layout').hidden = false;
  renderTabs();
  // Touch the repo with a single git command first: if macOS needs to ask for folder
  // access (Desktop, Documents…), it asks once here instead of once per parallel command.
  await invoke('resolve_repo', { path: root }).catch(() => {});
  if (S.repo !== root) return;
  invoke('watch_repo', { path: root }).catch(() => {});
  await busy(refresh);
  if (S.repo === root) $('#graph-scroll').scrollTop = view.scrollTop || 0;
  updateTabWarning(p.id, root);
}

async function closeTab(i) {
  const p = activeProfile();
  const root = p.tabs[i];
  S.view.delete(root);
  S.tabWarn.delete(root);
  const wasActive = root === S.repo;
  const ok = await mutateStore((s) => {
    const q = profileById(p.id, s);
    q.tabs.splice(i, 1);
    if (q.active_tab >= q.tabs.length) q.active_tab = Math.max(0, q.tabs.length - 1);
    else if (i < q.active_tab) q.active_tab--;
  });
  if (!ok) return;
  if (wasActive) {
    S.repo = null;
    activateTab(activeProfile().active_tab);
  } else renderTabs();
}

async function switchProfile(id) {
  if (id === S.store.active || !profileById(id)) return;
  saveViewState();
  if (!(await mutateStore((s) => (s.active = id)))) return;
  S.repo = null;
  renderProfileChrome();
  const p = activeProfile();
  if (p.tabs.length) await activateTab(p.active_tab);
  else showWelcome();
  toast(`Switched to ${p.name}`);
}

// ------------------------------------------------------------------ wrong-profile guard

function describeRemotes(check) {
  return check.remotes.map((r) => `${r.name}: ${r.host}/${r.owner}`).join(', ');
}

async function updateTabWarning(profileId, root) {
  try {
    const c = await invoke('check_repo', { profileId, repo: root });
    if (c.matches) S.tabWarn.delete(root);
    else S.tabWarn.set(root, `Remote (${describeRemotes(c)}) isn't one of this profile's expected owners`);
    renderTabs();
  } catch {}
}

/** Before network writes: confirm when the repo's remote isn't one the profile expects. */
async function confirmRemoteForProfile(action) {
  const p = activeProfile();
  let c;
  try {
    c = await invoke('check_repo', { profileId: p.id, repo: S.repo });
  } catch {
    return true;
  }
  if (c.matches) return true;
  const msg =
    `${action} as “${p.name}”?\n\nThis repo's remote is ${describeRemotes(c)}, ` +
    `but ${p.name} expects: ${p.remote_owners.join(', ')}.` +
    (c.suggested ? `\n\nIt matches the “${c.suggested[1]}” profile.` : '');
  return (await ask(msg, { ok: `${action} anyway`, danger: true })) === true;
}

/** Add a repository to the active profile (or jump to it), with ownership checks. */
async function openRepo(path) {
  let info;
  try {
    info = await invoke('resolve_repo', { path });
  } catch (e) {
    return toast(String(e), 'err');
  }
  const root = info.root;
  let p = activeProfile();
  const existing = p.tabs.indexOf(root);
  if (existing >= 0) return activateTab(existing);

  const c = await invoke('check_repo', { profileId: p.id, repo: root }).catch(() => null);
  if (c?.owned_by) {
    const [ownerId, ownerName] = c.owned_by;
    const choice = await ask(`${info.name} is already in the “${ownerName}” profile.`, {
      ok: `Open in ${ownerName}`,
      alt: `Move to ${p.name}`,
    });
    if (!choice) return;
    if (choice === true) {
      await switchProfile(ownerId);
      return activateTab(activeProfile().tabs.indexOf(root));
    }
    if (!(await mutateStore((s) => (profileById(ownerId, s).tabs = profileById(ownerId, s).tabs.filter((t) => t !== root))))) return;
  }
  if (c && !c.matches) {
    const expected = p.remote_owners.join(', ');
    const msg =
      `${info.name}'s remote is ${describeRemotes(c)}, which isn't an expected owner for “${p.name}” (${expected}).` +
      (c.suggested ? `\n\nIt matches the “${c.suggested[1]}” profile.` : '');
    const choice = await ask(msg, {
      ok: c.suggested ? `Add to ${c.suggested[1]}` : `Add to ${p.name} anyway`,
      alt: c.suggested ? `Add to ${p.name} anyway` : null,
      danger: !c.suggested,
    });
    if (!choice) return;
    if (choice === true && c.suggested) {
      await switchProfile(c.suggested[0]);
      p = activeProfile();
    }
  }
  if (!(await mutateStore((s) => {
    const q = profileById(p.id, s);
    q.tabs.push(root);
    q.active_tab = q.tabs.length - 1;
  }))) return;
  rememberRecent(root);
  await activateTab(activeProfile().tabs.indexOf(root));
  if (c?.any_https) toast(`${info.name} has an HTTPS remote — SSH keys don't apply to it; macOS keychain credentials are used instead.`);
}

async function pickAndOpen() {
  try {
    const path = await invoke('pick_repo');
    if (path) await openRepo(path);
  } catch (e) {
    toast(String(e), 'err');
  }
}

async function cloneIntoProfile() {
  const p = activeProfile();
  const url = await ask(`Clone into “${p.name}” using ${p.ssh_key ? baseName(p.ssh_key) : 'default SSH settings'}`, {
    input: true,
    placeholder: 'git@github.com:org/repo.git',
    ok: 'Choose folder…',
  });
  if (!url) return;
  const parent = await invoke('pick_path', { kind: 'folder', title: 'Clone into folder' }).catch(() => null);
  if (!parent) return;
  try {
    const info = await busy(() => invoke('clone_repo', { profileId: p.id, url, parent }));
    toast(`Cloned ${info.name}`, 'ok');
    await openRepo(info.root);
  } catch (e) {
    toast(explainGitError(String(e)), 'err');
  }
}

// ------------------------------------------------------------------ tab bar & switcher events

$('#tabs').addEventListener('click', (e) => {
  const x = e.target.closest('[data-close]');
  if (x) return closeTab(+x.dataset.close);
  const t = e.target.closest('.tab');
  if (t) activateTab(+t.dataset.i);
});
$('#tabs').addEventListener('auxclick', (e) => {
  const t = e.target.closest('.tab');
  if (t && e.button === 1) closeTab(+t.dataset.i);
});
$('#tabs').addEventListener('contextmenu', (e) => {
  const t = e.target.closest('.tab');
  if (!t) return;
  e.preventDefault();
  const i = +t.dataset.i;
  const p = activeProfile();
  const root = p.tabs[i];
  const inTerminal = p.terminal_repos.includes(root);
  showMenu(e, [
    ['Close tab', () => closeTab(i)],
    p.tabs.length > 1 && ['Close other tabs', () => closeOtherTabs(i)],
    null,
    [inTerminal ? '✓ Use profile in terminal git' : 'Use profile in terminal git', () => toggleTerminal(root, !inTerminal)],
    ['Reveal in Finder', () => invoke('reveal', { repo: root, target: 'finder' })],
    null,
    ...S.store.profiles.filter((q) => q.id !== p.id).map((q) => [`Move to ${q.name}`, () => moveRepo(root, q.id), '', q.color]),
  ]);
});

async function closeOtherTabs(i) {
  const p = activeProfile();
  const keep = p.tabs[i];
  await mutateStore((s) => {
    const q = profileById(p.id, s);
    q.tabs = [keep];
    q.active_tab = 0;
  });
  if (S.repo !== keep) activateTab(0);
  else renderTabs();
}

async function toggleTerminal(root, enabled) {
  const p = S.store.profiles.find((q) => q.tabs.includes(root));
  if (!p) return;
  if (enabled && !p.ssh_key && !(p.git_name && p.git_email)) return toast(`Set an SSH key or git author for ${p.name} first`, 'err');
  const ok = await mutateStore((s) => {
    const q = profileById(p.id, s);
    q.terminal_repos = enabled ? [...new Set([...q.terminal_repos, root])] : q.terminal_repos.filter((r) => r !== root);
  });
  if (ok) toast(enabled ? `${baseName(root)}: terminal git now uses ${p.name}'s key and author` : `${baseName(root)}: removed ${p.name}'s settings from .git/config`, 'ok');
}

async function moveRepo(root, targetId) {
  const p = activeProfile();
  const target = profileById(targetId);
  const ok = await mutateStore((s) => {
    const from = profileById(p.id, s);
    const to = profileById(targetId, s);
    const wasTerminal = from.terminal_repos.includes(root);
    from.tabs = from.tabs.filter((r) => r !== root);
    from.active_tab = Math.min(from.active_tab, Math.max(0, from.tabs.length - 1));
    to.tabs.push(root);
    if (wasTerminal) to.terminal_repos.push(root);
  });
  if (!ok) return;
  toast(`Moved ${baseName(root)} to ${target.name}`, 'ok');
  if (S.repo === root) {
    S.repo = null;
    activateTab(activeProfile().active_tab);
  } else renderTabs();
}

$('#tab-add').addEventListener('click', (e) => {
  const inAnyProfile = new Set(S.store.profiles.flatMap((q) => q.tabs));
  const recents = load('kl.recent', []).filter((r) => !inAnyProfile.has(r.root)).slice(0, 8);
  const r = e.currentTarget.getBoundingClientRect();
  showMenu({ clientX: r.left, clientY: r.bottom + 4 }, [
    ['Open repository…  ⌘O', pickAndOpen],
    ['Clone repository…', cloneIntoProfile],
    recents.length ? null : false,
    ...recents.map((x) => [x.name, () => openRepo(x.root)]),
  ]);
});

$('#btn-profile').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  showMenu({ clientX: r.left, clientY: r.bottom + 4 }, [
    ...S.store.profiles.map((q, i) => [
      `${q.id === S.store.active ? '✓ ' : ''}${q.name}${i < 9 ? `   ⌘⇧${i + 1}` : ''}`,
      () => switchProfile(q.id),
      '',
      q.color,
    ]),
    null,
    ['Edit profiles…', () => openProfileEditor()],
    ['New profile…', () => openProfileEditor({ create: true })],
  ]);
});

$('#welcome-open').addEventListener('click', pickAndOpen);
$('#welcome-clone').addEventListener('click', cloneIntoProfile);
$('#recent-list').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (li) openRepo(li.dataset.root);
});

// ------------------------------------------------------------------ profile editor

const ED = { draft: null, cur: null, keys: [] };
const dlg = $('#profiles-dlg');
const newId = (name) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile'}-${Math.random().toString(36).slice(2, 6)}`;

async function openProfileEditor({ create = false } = {}) {
  ED.draft = clone(S.store);
  ED.cur = S.store.active;
  ED.keys = await invoke('list_ssh_keys').catch(() => []);
  if (create) addDraftProfile();
  renderEditor();
  dlg.showModal();
  if (create) $('#pf-name').select();
}

function addDraftProfile() {
  const used = new Set(ED.draft.profiles.map((p) => p.color));
  const p = {
    id: newId('profile'),
    name: 'New profile',
    color: PROFILE_COLORS.find((c) => !used.has(c)) || PROFILE_COLORS[0],
    ssh_key: '',
    git_name: '',
    git_email: '',
    remote_owners: [],
    tabs: [],
    active_tab: 0,
    terminal_repos: [],
  };
  ED.draft.profiles.push(p);
  ED.cur = p.id;
}

const draftProfile = () => profileById(ED.cur, ED.draft);

function renderEditor() {
  const p = draftProfile();
  $('#pd-items').innerHTML = ED.draft.profiles
    .map(
      (q) => `<div class="pd-item ${q.id === ED.cur ? 'sel' : ''}" data-id="${q.id}">
        <span class="pdot" style="--c:${esc(q.color)}"></span><span>${esc(q.name || 'Untitled')}</span>
        ${q.id === ED.draft.active ? '<small>active</small>' : ''}</div>`,
    )
    .join('');
  $('#pf-name').value = p.name;
  $('#pf-colors').innerHTML = PROFILE_COLORS.map(
    (c) => `<button class="swatch ${c === p.color ? 'sel' : ''}" data-color="${c}" style="--c:${c}" title="${c}"></button>`,
  ).join('');
  $('#pf-gname').value = p.git_name;
  $('#pf-gemail').value = p.git_email;

  const known = ED.keys.some((k) => k.path === p.ssh_key);
  $('#pf-key').innerHTML =
    `<option value="">ssh defaults / ssh-agent (no specific key)</option>` +
    ED.keys.map((k) => `<option value="${esc(k.path)}">${esc(k.name)} — ${esc(k.kind)}${k.comment ? ` · ${esc(k.comment)}` : ''}</option>`).join('') +
    (p.ssh_key && !known ? `<option value="${esc(p.ssh_key)}">${esc(p.ssh_key)}</option>` : '');
  $('#pf-key').value = p.ssh_key;
  $('#pf-keychain').disabled = !p.ssh_key;
  const firstHost = p.remote_owners.map((o) => o.trim()).find((o) => o.includes('.'))?.split('/')[0];
  $('#pf-host').value = firstHost || $('#pf-host').value || 'github.com';
  $('#pf-test-out').textContent = '';
  $('#pf-test-out').className = 'test-out';
  $('#pf-owners').value = p.remote_owners.join('\n');

  $('#pf-repos').innerHTML = p.tabs.length
    ? p.tabs
        .map(
          (r) => `<div class="pf-repo" data-root="${esc(r)}">
            <span class="name" title="${esc(r)}">${esc(baseName(r))}<small>${esc(r)}</small></span>
            <label title="Write this profile's key and author to the repo's .git/config so terminal git matches the app">
              <input type="checkbox" data-terminal ${p.terminal_repos.includes(r) ? 'checked' : ''}> terminal</label>
            <button class="mini danger" data-remove title="Remove from profile">Remove</button></div>`,
        )
        .join('')
    : '<div class="f-empty">No repositories yet — open or clone one while this profile is active.</div>';
  $('#pf-delete').disabled = ED.draft.profiles.length < 2;
}

$('#pd-items').addEventListener('click', (e) => {
  const it = e.target.closest('.pd-item');
  if (!it) return;
  ED.cur = it.dataset.id;
  renderEditor();
});
$('#pd-new').addEventListener('click', () => {
  addDraftProfile();
  renderEditor();
  $('#pf-name').select();
});
$('#pf-name').addEventListener('input', (e) => {
  draftProfile().name = e.target.value;
  $(`.pd-item[data-id="${ED.cur}"] span:nth-child(2)`).textContent = e.target.value || 'Untitled';
});
$('#pf-gname').addEventListener('input', (e) => (draftProfile().git_name = e.target.value));
$('#pf-gemail').addEventListener('input', (e) => (draftProfile().git_email = e.target.value));
$('#pf-owners').addEventListener('input', (e) => {
  draftProfile().remote_owners = e.target.value.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
});
$('#pf-colors').addEventListener('click', (e) => {
  const b = e.target.closest('[data-color]');
  if (!b) return;
  draftProfile().color = b.dataset.color;
  renderEditor();
});
$('#pf-key').addEventListener('change', (e) => {
  draftProfile().ssh_key = e.target.value;
  $('#pf-keychain').disabled = !e.target.value;
});
$('#pf-browse').addEventListener('click', async () => {
  const path = await invoke('pick_path', { kind: 'file', title: 'Choose a private SSH key' }).catch(() => null);
  if (!path) return;
  if (path.endsWith('.pub')) return toast('Pick the private key (the file without .pub)', 'err');
  draftProfile().ssh_key = path;
  renderEditor();
});
$('#pf-test').addEventListener('click', async () => {
  const out = $('#pf-test-out');
  out.className = 'test-out';
  out.textContent = 'Connecting…';
  const r = await invoke('test_ssh', { key: draftProfile().ssh_key, host: $('#pf-host').value || 'github.com' });
  out.className = `test-out ${r.ok ? 'ok' : 'err'}`;
  let msg = r.message || (r.ok ? 'Authenticated' : 'No response');
  if (!r.ok && /Permission denied/.test(msg) && draftProfile().ssh_key) {
    msg += '\nIf this key has a passphrase, click “Add to keychain…” and enter it once.';
  }
  out.textContent = msg;
});
$('#pf-keychain').addEventListener('click', () => {
  invoke('add_key_to_keychain', { key: draftProfile().ssh_key })
    .then(() => toast('Enter the passphrase in Terminal, then run Test connection again.'))
    .catch((e) => toast(String(e), 'err'));
});
$('#pf-repos').addEventListener('click', (e) => {
  const row = e.target.closest('.pf-repo');
  if (!row) return;
  const p = draftProfile();
  const root = row.dataset.root;
  if (e.target.closest('[data-remove]')) {
    p.tabs = p.tabs.filter((r) => r !== root);
    p.terminal_repos = p.terminal_repos.filter((r) => r !== root);
    p.active_tab = Math.min(p.active_tab, Math.max(0, p.tabs.length - 1));
    renderEditor();
  } else if (e.target.closest('[data-terminal]')) {
    const on = e.target.checked;
    p.terminal_repos = on ? [...new Set([...p.terminal_repos, root])] : p.terminal_repos.filter((r) => r !== root);
  }
});
$('#pf-delete').addEventListener('click', async () => {
  const p = draftProfile();
  const confirmed = await ask(
    `Delete profile “${p.name}”?${p.tabs.length ? `\n\nIts ${p.tabs.length} tab(s) are removed from Gittygit (the repositories on disk are not touched).` : ''}`,
    { ok: 'Delete profile', danger: true },
  );
  if (confirmed !== true) return;
  ED.draft.profiles = ED.draft.profiles.filter((q) => q.id !== p.id);
  if (ED.draft.active === p.id) ED.draft.active = ED.draft.profiles[0].id;
  ED.cur = ED.draft.active;
  renderEditor();
});
$('#pf-cancel').addEventListener('click', () => dlg.close());
$('#pf-save').addEventListener('click', async () => {
  for (const p of ED.draft.profiles) {
    p.name = p.name.trim();
    if (!p.name) return toast('Every profile needs a name', 'err');
    if (p.git_email && !/^[^@\s]+@[^@\s]+$/.test(p.git_email.trim())) return toast(`“${p.git_email}” doesn't look like an email`, 'err');
  }
  const prevActive = S.store.active;
  const prevRepo = S.repo;
  try {
    await serialize(() => commitStore(ED.draft));
  } catch (e) {
    return toast(String(e), 'err');
  }
  dlg.close();
  toast('Profiles saved', 'ok');
  renderProfileChrome();
  const p = activeProfile();
  if (S.store.active !== prevActive || !p.tabs.includes(prevRepo)) {
    S.repo = null;
    if (p.tabs.length) activateTab(p.active_tab);
    else showWelcome();
  } else if (S.repo) updateTabWarning(p.id, S.repo);
});

// ------------------------------------------------------------------ shortcuts & boot

document.addEventListener('keydown', (e) => {
  if (dlg.open) return;
  const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
  if (e.metaKey && e.shiftKey && digit) {
    e.preventDefault();
    const p = S.store.profiles[+digit - 1];
    if (p) switchProfile(p.id);
  } else if (e.metaKey && !e.shiftKey && digit) {
    e.preventDefault();
    if (+digit - 1 < activeProfile().tabs.length) activateTab(+digit - 1);
  } else if (e.metaKey && (e.key === 'o' || e.key === 't')) {
    e.preventDefault();
    pickAndOpen();
  } else if (e.metaKey && e.key === 'w') {
    e.preventDefault();
    const p = activeProfile();
    if (S.repo) closeTab(p.tabs.indexOf(S.repo));
  } else if (e.metaKey && e.key === 'f' && S.repo) {
    e.preventDefault();
    $('#search').focus();
    $('#search').select();
  } else if (e.metaKey && e.key === 'r' && S.repo) {
    e.preventDefault();
    busy(refresh);
  } else if (e.key === 'Escape') {
    if (!$('#ctx-menu').hidden) $('#ctx-menu').hidden = true;
    else if (S.file) closeDiff();
  }
});

(async function boot() {
  S.store = await invoke('get_profiles');
  if (S.store.fresh) {
    // First launch with profiles: carry over the last opened repository.
    const last = load('kl.last', null);
    if (last) {
      const p = activeProfile();
      p.tabs = [last];
      p.active_tab = 0;
    }
    try {
      await serialize(() => commitStore(clone(S.store)));
    } catch {}
  }
  renderProfileChrome();
  const arg = await invoke('initial_repo');
  if (arg) return openRepo(arg);
  const p = activeProfile();
  if (p.tabs.length) activateTab(p.active_tab);
  else showWelcome();
})();
