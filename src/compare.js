'use strict';
// Several commits selected in the graph, comparing two revisions (or one with the working tree),
// and the quick actions that build on them: cherry-pick / revert / squash several commits and
// adding files to .gitignore.

// ------------------------------------------------------------------ multi-selection

/** ⌘-click toggles a commit; ⇧-click selects the range from the anchor row. */
function extendSelection(i, range) {
  const sha = S.rows[i].sha;
  if (!S.multi.size && S.selected && S.selected !== 'WIP') S.multi.add(S.selected);
  if (range && S.multiAnchor != null) {
    const [a, b] = [S.multiAnchor, i].sort((x, y) => x - y);
    for (let k = a; k <= b; k++) if (S.rows[k].sha !== 'WIP') S.multi.add(S.rows[k].sha);
  } else {
    S.multi.has(sha) ? S.multi.delete(sha) : S.multi.add(sha);
    S.multiAnchor = i;
  }
  S.compare = null;
  closeDiff();
  if (S.multi.size === 1) {
    const [only] = S.multi;
    return select(only);
  }
  S.selected = sha;
  renderRows();
  renderDetail();
}

/** Selected commits, oldest first (graph rows are newest first). */
const selectedOldestFirst = () => [...S.multi].filter((sha) => S.index.has(sha)).sort((a, b) => S.index.get(b) - S.index.get(a));

function multiMenu() {
  const shas = selectedOldestFirst();
  const n = shas.length;
  const cur = currentBranch()?.name || 'HEAD';
  return [
    n === 2 && ['Compare these 2 commits', () => compareSelected()],
    null,
    [`Cherry-pick ${n} commits onto ${cur}`, () => cherryPickMany(shas)],
    [`Revert ${n} commits`, () => revertMany(shas)],
    [`Squash ${n} commits…`, () => squashMany(shas)],
    null,
    ['Copy SHAs', () => navigator.clipboard.writeText(shas.join('\n')).then(() => toast(`${n} SHAs copied`))],
    ['Clear selection', () => select(S.selected)],
  ];
}

function renderMulti() {
  const shas = selectedOldestFirst().reverse();
  const n = shas.length;
  const cur = currentBranch()?.name || 'HEAD';
  const rows = shas
    .map((sha) => {
      const r = S.rows[S.index.get(sha)];
      return `<div class="cmp-commit" data-reveal="${sha}">${avatar(r.author, r.email)}<span class="s">${esc(r.subject)}</span><code>${short(sha)}</code></div>`;
    })
    .join('');
  $('#detail').innerHTML = `
    <div class="d-head"><h2>${n} commits selected</h2><div class="sha-line">⌘-click to add or remove, ⇧-click for a range</div>
      <div class="multi-acts">
        ${n === 2 ? '<button class="mini" data-multi="compare">Compare</button>' : ''}
        <button class="mini" data-multi="pick">Cherry-pick onto ${esc(cur)}</button>
        <button class="mini" data-multi="revert">Revert</button>
        <button class="mini" data-multi="squash">Squash…</button>
        <span class="spacer"></span><button class="mini" data-multi="clear">Clear</button>
      </div></div>
    <div class="d-scroll">${rows}</div>`;
}

// ------------------------------------------------------------------ compare

function setCompare(c) {
  S.compare = c;
  S.multi.clear();
  closeDiff();
  renderRows();
  renderDetail();
}

function compareSelected() {
  const [older, newer] = selectedOldestFirst();
  const label = (sha) => short(sha);
  setCompare({ a: older, b: newer, labelA: label(older), labelB: label(newer) });
}

/** Scroll the graph to a commit and flash it, without leaving the current detail view. */
function revealInGraph(sha) {
  if (!S.index.has(sha)) return toast('Commit is outside the loaded history');
  ensureVisible(S.index.get(sha));
  S.flash = sha;
  renderRows();
  setTimeout(() => {
    if (S.flash === sha) {
      S.flash = null;
      renderRows();
    }
  }, 1200);
}

async function renderCompare() {
  const c = S.compare;
  let res;
  try {
    res = await invoke('compare', { repo: S.repo, a: c.a, b: c.b });
  } catch (e) {
    $('#detail').innerHTML = `<div class="f-empty">${esc(e)}</div>`;
    return;
  }
  if (S.compare !== c) return;
  const commits = (list) =>
    list.map((x) => `<div class="cmp-commit" data-reveal="${x.sha}">${avatar(x.author, x.email)}<span class="s">${esc(x.subject)}</span><code>${short(x.sha)}</code></div>`).join('') ||
    '<div class="f-empty">None</div>';
  const cap = (list) => `${list.length}${list.length === 300 ? '+' : ''}`;
  const swappable = c.b !== null;
  $('#detail').innerHTML = `
    <div class="d-head">
      <div class="sha-line"><span>comparing</span></div>
      <h2 class="cmp-title"><code>${esc(c.labelA)}</code> → <code>${esc(c.labelB)}</code></h2>
      <div class="multi-acts">${swappable ? '<button class="mini" data-cmp="swap">Swap sides</button>' : ''}<span class="spacer"></span><button class="mini" data-cmp="close">Close</button></div>
    </div>
    <div class="d-scroll">
      <div class="f-section-h">Changed files (${res.files.length})</div>
      ${res.files.map((f) => fileRow(f, 'range')).join('') || '<div class="f-empty">No differences</div>'}
      <div class="f-section-h">Only in ${esc(c.labelB)} (${cap(res.only_b)})</div>${commits(res.only_b)}
      <div class="f-section-h">Only in ${esc(c.labelA)} (${cap(res.only_a)})</div>${commits(res.only_a)}
    </div>`;
}

$('#detail').addEventListener('click', (e) => {
  const rev = e.target.closest('[data-reveal]');
  if (rev) return revealInGraph(rev.dataset.reveal);
  const m = e.target.closest('[data-multi]');
  if (m) {
    const shas = selectedOldestFirst();
    return { compare: compareSelected, pick: () => cherryPickMany(shas), revert: () => revertMany(shas), squash: () => squashMany(shas), clear: () => select(S.selected) }[m.dataset.multi]();
  }
  const c = e.target.closest('[data-cmp]');
  if (!c) return;
  if (c.dataset.cmp === 'close') return select(S.selected && S.index.has(S.selected) ? S.selected : S.graph.head_sha);
  const { a, b, labelA, labelB } = S.compare;
  setCompare({ a: b, b: a, labelA: labelB, labelB: labelA });
});

// ------------------------------------------------------------------ several commits at once

const hasMerge = (shas) => shas.some((sha) => S.rows[S.index.get(sha)]?.parents.length > 1);

async function cherryPickMany(shas) {
  if (hasMerge(shas)) return toast('The selection includes merge commits; cherry-pick those one at a time.', 'err');
  const cur = currentBranch()?.name || 'HEAD';
  await moveHead(['cherry-pick', ...shas], `Cherry-picked ${shas.length} commits onto ${cur}`);
}

async function revertMany(shas) {
  if (hasMerge(shas)) return toast('The selection includes merge commits; revert those one at a time.', 'err');
  if (!(await ask(`Revert ${shas.length} commits?\n\nA new commit undoing each one is added on ${currentBranch()?.name || 'HEAD'}, newest first.`, { ok: 'Revert' }))) return;
  await moveHead(['revert', '--no-edit', ...[...shas].reverse()], `Reverted ${shas.length} commits`);
}

/** Squash consecutive commits of the current branch: opens interactive rebase prefilled. */
async function squashMany(shas) {
  const oldest = S.rows[S.index.get(shas[0])];
  if (!oldest?.parents.length) return toast("The root commit can't be squashed into its parent.", 'err');
  openRebase(oldest.parents[0], { squash: shas });
}

// ------------------------------------------------------------------ .gitignore

/** Menu entries to ignore a file, its extension or its folder. */
function ignoreMenu(path, mode, status) {
  if (mode === 'conflict') return [];
  const slash = path.lastIndexOf('/');
  const base = path.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot) : '';
  const tracked = status !== '?';
  return [
    ['Ignore this file', () => addIgnore(`/${path}`, path, tracked)],
    ext && [`Ignore all *${ext} files`, () => addIgnore(`*${ext}`, path, tracked)],
    slash > 0 && [`Ignore folder ${path.slice(0, slash + 1)}`, () => addIgnore(`/${path.slice(0, slash + 1)}`, path, tracked)],
  ];
}

async function addIgnore(pattern, path, tracked) {
  try {
    const added = await invoke('add_to_gitignore', { profileId: activeProfile().id, repo: S.repo, pattern });
    toast(added ? `Added ${pattern} to .gitignore` : `${pattern} is already in .gitignore`, 'ok');
  } catch (e) {
    return toast(String(e), 'err');
  }
  // Ignoring doesn't affect files git already tracks.
  if (tracked) {
    const untrack = await ask(`${path} is already tracked, so ignoring it has no effect until it's removed from git.\n\nStop tracking it? The file stays on disk; the removal is staged for your next commit.`, { ok: 'Stop tracking' });
    if (untrack === true) await git(['rm', '--cached', '-q', '--', path], `${path} is no longer tracked`);
  }
  scheduleRefresh();
}
