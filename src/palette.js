'use strict';
// Command palette (⌘K): type to find any action, branch, repository tab or profile.

const PAL = { items: [], shown: [], sel: 0, recent: load('gg.palRecent', []) };
const palEl = $('#palette');
const palInput = $('#pal-input');

/** Everything the palette can do right now: [id, title, hint, run]. */
function paletteCommands() {
  const cmds = [];
  const add = (id, title, hint, run) => cmds.push({ id, title, hint, run });
  const p = activeProfile();
  if (S.repo) {
    const cur = currentBranch()?.name;
    add('pull', 'Pull', PULL_MODES[pullMode()], () => pull());
    add('pull-merge', 'Pull with merge', '', () => pull('merge'));
    add('pull-rebase', 'Pull with rebase', '', () => pull('rebase'));
    add('push', 'Push', cur || '', () => ACTIONS.push());
    add('fetch', 'Fetch all remotes', '', () => ACTIONS.fetch());
    add('branch', 'New branch…', '', () => ACTIONS.branch());
    add('stash', 'Stash changes…', '', () => ACTIONS.stash());
    add('pop', 'Pop stash', '', () => ACTIONS.pop());
    add('recover', 'Recover lost commits…', 'reflog', () => openRecover());
    add('split', diffPrefs.split ? 'Show diffs inline' : 'Show diffs side by side', '', () => {
      diffPrefs.split = !diffPrefs.split;
      save('gg.diffSplit', diffPrefs.split);
      if (S.file && S.diffModel) showDiff(S.file, true);
    });
    if (extras().submodules.length) add('sub-update', 'Update all submodules', 'submodules', () => updateSubmodules([]));
    if (S.op?.bisect) add('bisect-stop', 'Stop bisect', 'bisect', () => git(['bisect', 'reset'], 'Bisect stopped — back where you started'));
    add('terminal', 'Open in Terminal', '', () => ACTIONS.terminal());
    add('finder', 'Reveal in Finder', '', () => ACTIONS.finder());
    if (repoPRs()) {
      const br = currentBranch();
      if (br) add('pr-create', prForBranch(br.name) ? `Open pull request #${prForBranch(br.name).number}` : 'Create pull request on GitHub…', br.name, () => prMenuItem(br)[1]());
      add('pr-checkout', 'Check out pull request…', '#', () => checkoutPR());
      for (const pr of repoPRs().prs) add(`pr:${pr.number}`, `#${pr.number} ${pr.title}`, 'pull request', () => openUrl(pr.url));
    }
    for (const b of S.refs?.branches || []) {
      if (b.name === cur) continue;
      add(`co:${b.name}`, `Checkout ${b.name}`, 'branch', () => checkoutLocal(b.name));
      if (cur) add(`merge:${b.name}`, `Merge ${b.name} into ${cur}`, 'branch', () => git(['merge', b.name], `Merged ${b.name} into ${cur}`));
      if (cur) add(`cmp:${b.name}`, `Compare ${b.name} with ${cur}`, 'branch', () => setCompare({ a: cur, b: b.name, labelA: cur, labelB: b.name }));
    }
    const locals = new Set((S.refs?.branches || []).map((b) => b.name));
    for (const r of S.refs?.remotes || []) {
      const remote = S.refs.remote_names.find((n) => r.name.startsWith(n + '/'));
      if (!locals.has(remote ? r.name.slice(remote.length + 1) : r.name)) add(`cor:${r.name}`, `Checkout ${r.name}`, 'remote branch', () => checkoutRemote(r.name));
    }
  }
  p.tabs.forEach((root, i) => root !== S.repo && add(`tab:${root}`, `Switch to ${baseName(root)}`, 'tab', () => activateTab(i)));
  for (const q of S.store.profiles) if (q.id !== p.id) add(`profile:${q.id}`, `Switch to profile ${q.name}`, 'profile', () => switchProfile(q.id));
  add('open', 'Open repository…', '⌘O', () => pickAndOpen());
  add('clone', 'Clone repository…', '', () => cloneIntoProfile());
  add('profiles', 'Edit profiles…', '', () => openProfileEditor());
  add('settings', 'Settings…', '⌘,', () => openSettings());
  add('updates', 'Check for updates…', '', () => checkForUpdates({ manual: true }));
  add('diagnostics', 'Copy diagnostics', '', () => copyDiagnostics());
  return cmds;
}

/**
 * Fuzzy score: every query character must appear in order. Matches at word starts and runs of
 * consecutive characters score higher; recently used commands get a boost.
 */
function fuzzy(q, text) {
  const t = text.toLowerCase();
  let score = 0, ti = 0, run = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return -1;
    run = i === ti ? run + 1 : 0;
    score += 1 + run * 2 + (i === 0 || /[\s/\-_.]/.test(t[i - 1]) ? 4 : 0);
    ti = i + 1;
  }
  return score - t.length * 0.01;
}

function renderPalette() {
  const q = palInput.value.trim().toLowerCase().replace(/\s+/g, ' ');
  const recent = (id) => {
    const i = PAL.recent.indexOf(id);
    return i < 0 ? 0 : 8 - i;
  };
  PAL.shown = PAL.items
    .map((c) => ({ c, s: q ? fuzzy(q, c.title) : 0 }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s + recent(b.c.id) - (a.s + recent(a.c.id)))
    .slice(0, 60)
    .map((x) => x.c);
  PAL.sel = Math.min(PAL.sel, Math.max(0, PAL.shown.length - 1));
  $('#pal-list').innerHTML =
    PAL.shown.map((c, i) => `<div class="pal-item${i === PAL.sel ? ' sel' : ''}" data-i="${i}"><span>${esc(c.title)}</span><small>${esc(c.hint)}</small></div>`).join('') ||
    '<div class="pal-empty">No matching command</div>';
  $('#pal-list .pal-item.sel')?.scrollIntoView({ block: 'nearest' });
}

function openPalette() {
  if (!S.store || document.querySelector('dialog[open]')) return;
  PAL.items = paletteCommands();
  PAL.sel = 0;
  palInput.value = '';
  palEl.hidden = false;
  renderPalette();
  palInput.focus();
}

const closePalette = () => (palEl.hidden = true);

function runPalette(i) {
  const c = PAL.shown[i];
  if (!c) return;
  closePalette();
  PAL.recent = [c.id, ...PAL.recent.filter((x) => x !== c.id)].slice(0, 8);
  save('gg.palRecent', PAL.recent);
  c.run();
}

palInput.addEventListener('input', () => {
  PAL.sel = 0;
  renderPalette();
});
palInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    PAL.sel = Math.max(0, Math.min(PAL.shown.length - 1, PAL.sel + (e.key === 'ArrowDown' ? 1 : -1)));
    renderPalette();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    runPalette(PAL.sel);
  } else if (e.key === 'Escape') {
    e.stopPropagation();
    closePalette();
  }
});
$('#pal-list').addEventListener('click', (e) => {
  const it = e.target.closest('.pal-item');
  if (it) runPalette(+it.dataset.i);
});
palEl.addEventListener('mousedown', (e) => {
  if (e.target === palEl) closePalette();
});
document.addEventListener('keydown', (e) => {
  if (e.metaKey && e.key === 'k') {
    e.preventDefault();
    palEl.hidden ? openPalette() : closePalette();
  }
});
