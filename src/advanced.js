'use strict';
// Advanced repositories: submodules, Git LFS, worktrees, commit signatures and bisect.

// ------------------------------------------------------------------ submodules, worktrees, LFS

async function updateExtras(repo) {
  try {
    S.extras.set(repo, await invoke('repo_extras', { repo }));
  } catch {
    return;
  }
  if (repo !== S.repo) return;
  renderSidebar();
  renderLfsHint();
}

const extras = () => S.extras.get(S.repo) || { submodules: [], lfs: { used: false, installed: false }, worktrees: [] };
const SUB_STATE = { ok: 'Up to date', changed: 'Checked out at a different commit than recorded', uninitialized: 'Not downloaded yet (Update to fetch it)', conflict: 'In conflict' };

function extrasSections(section, empty) {
  const x = extras();
  let html = '';
  if (x.submodules.length) {
    const items = x.submodules
      .map(
        (m) => `<div class="sb-item sm-${m.state}" data-kind="submodule" data-name="${esc(m.path)}" data-sha="${m.sha}" title="${esc(m.path)}\n${esc(SUB_STATE[m.state])}${m.url ? `\n${esc(m.url)}` : ''}">
          ${icon('repo')}<span class="name">${esc(m.path)}</span>${m.state === 'ok' ? '' : `<span class="badge">${m.state === 'uninitialized' ? 'not loaded' : m.state}</span>`}</div>`,
      )
      .join('');
    html += section('submodules', 'Submodules', x.submodules.length, items || empty('None'));
  }
  if (x.worktrees.length > 1) {
    const items = x.worktrees
      .map(
        (w) => `<div class="sb-item${w.current ? ' current' : ''}" data-kind="worktree" data-name="${esc(w.path)}" data-sha="${w.head}" title="${esc(w.path)}${w.prunable ? '\nFolder is missing' : ''}${w.locked ? '\nLocked' : ''}">
          ${icon(w.current ? 'check' : 'folder')}<span class="name">${esc(w.branch || (w.bare ? '(bare)' : `detached ${short(w.head)}`))}</span><small class="wt-path">${esc(baseName(w.path))}</small>${w.prunable ? '<span class="badge">missing</span>' : ''}</div>`,
      )
      .join('');
    html += section('worktrees', 'Worktrees', x.worktrees.length, items);
  }
  return html;
}

// --- submodules

function submoduleMenu(path) {
  const m = extras().submodules.find((s) => s.path === path);
  if (!m) return [];
  return [
    [m.state === 'uninitialized' ? 'Download (init and update)' : 'Update to the recorded commit', () => updateSubmodules([path])],
    m.state !== 'uninitialized' && ['Open in new tab', () => openSubmodule(path)],
    null,
    ['Update all submodules', () => updateSubmodules([])],
    ['Copy path', () => navigator.clipboard.writeText(path).then(() => toast('Path copied'))],
  ];
}

/** `git submodule update --init --recursive` (all, or the given paths) with the profile's SSH key. */
async function updateSubmodules(paths) {
  const what = paths.length ? paths.join(', ') : 'all submodules';
  if ((await git(['submodule', 'update', '--init', '--recursive', ...(paths.length ? ['--', ...paths] : [])], `Updated ${what}`)) !== null) updateExtras(S.repo);
}

function openSubmodule(path) {
  const m = extras().submodules.find((s) => s.path === path);
  if (m?.state === 'uninitialized') return toast(`${path} isn't downloaded yet. Right-click it → Download.`, 'err');
  openRepo(`${S.repo}/${path}`);
}

// --- worktrees

const worktreeFor = (branch) => extras().worktrees.find((w) => w.branch === branch && !w.current);

function worktreeMenu(path) {
  const w = extras().worktrees.find((x) => x.path === path);
  if (!w) return [];
  return [
    !w.current && !w.prunable && ['Open in new tab', () => openWorktree(path)],
    !w.prunable && ['Reveal in Finder', () => invoke('reveal', { repo: path, target: 'finder' })],
    null,
    w.prunable && ['Clean up missing worktrees', () => git(['worktree', 'prune'], 'Removed missing worktrees').then(() => updateExtras(S.repo))],
    !w.current && !w.prunable && [`Remove worktree…`, () => removeWorktree(w), 'danger'],
  ];
}

const openWorktree = (path) => openRepo(path);

/** Check a branch out in a separate folder next to this repository. */
async function addWorktree(branch) {
  const parent = await invoke('pick_path', { kind: 'folder', title: `Folder to create the ${branch} worktree in` }).catch(() => null);
  if (!parent) return;
  const path = `${parent.replace(/\/+$/, '')}/${baseName(S.repo)}-${branch.replace(/[^\w.-]+/g, '-')}`;
  if ((await git(['worktree', 'add', path, branch], `Created worktree for ${branch}`)) === null) return;
  await updateExtras(S.repo);
  if ((await ask(`${branch} is checked out in ${path}.\n\nOpen it in a new tab?`, { ok: 'Open' })) === true) openRepo(path);
}

async function removeWorktree(w) {
  if (!(await ask(`Remove the worktree at ${w.path}?\n\nThe folder is deleted; the branch ${w.branch || ''} stays.`, { ok: 'Remove', danger: true }))) return;
  try {
    await gitRaw(['worktree', 'remove', w.path]);
  } catch (e) {
    if (!/modified or untracked files|is dirty/.test(String(e))) return toast(String(e), 'err');
    const force = await ask(`${w.path} has uncommitted changes. Remove it anyway? They are lost.`, { ok: 'Remove anyway', danger: true });
    if (force !== true) return;
    await git(['worktree', 'remove', '--force', w.path]);
  }
  toast('Worktree removed', 'ok');
  updateExtras(S.repo);
}

// --- LFS

function renderLfsHint() {
  const { lfs } = extras();
  const el = $('#lfs-hint');
  const show = lfs.used && !lfs.installed && !load('gg.lfsDismissed', []).includes(S.repo);
  el.hidden = !show;
  if (!show) return;
  el.innerHTML = `<span>This repository uses <b>Git LFS</b>, but git-lfs isn't installed, so large files appear as small pointer files. Install it with <code>brew install git-lfs</code>, then <code>git lfs install</code>.</span>
    <span class="spacer"></span><button class="mini" data-lfs="no">Dismiss</button>`;
}
$('#lfs-hint').addEventListener('click', (e) => {
  if (!e.target.closest('[data-lfs]')) return;
  save('gg.lfsDismissed', [...load('gg.lfsDismissed', []), S.repo]);
  $('#lfs-hint').hidden = true;
});

// ------------------------------------------------------------------ special diffs

const fmtBytes = (n) => (n >= 1 << 20 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

/**
 * Submodule moves (git's --submodule=log summary) and Git LFS pointer files get a readable
 * summary instead of a line diff. Returns null for ordinary diffs.
 */
function specialDiffHtml(text) {
  if (text.startsWith('Submodule ')) {
    const blocks = [];
    for (const line of text.split('\n')) {
      if (line.startsWith('Submodule ')) blocks.push({ head: line.replace(/:$/, ''), added: [], removed: [] });
      else if (line.startsWith('  > ')) blocks.at(-1)?.added.push(line.slice(4));
      else if (line.startsWith('  < ')) blocks.at(-1)?.removed.push(line.slice(4));
    }
    const list = (items, cls, sign) => items.map((c) => `<li class="${cls}"><span>${sign}</span>${esc(c)}</li>`).join('');
    return `<div class="special-diff">${blocks
      .map(
        (b) => `<h4>${esc(b.head)}</h4>
        ${b.added.length || b.removed.length ? `<p class="hint">${b.added.length} new commit${b.added.length === 1 ? '' : 's'}${b.removed.length ? `, ${b.removed.length} removed` : ''}</p>` : ''}
        <ul>${list(b.added, 'add', '+')}${list(b.removed, 'del', '−')}</ul>`,
      )
      .join('')}</div>`;
  }
  if (text.includes('version https://git-lfs.github.com/spec/v1')) {
    const changed = text.split('\n').filter((l) => /^[+-](?![+-])/.test(l));
    if (changed.length && changed.every((l) => /^[+-](version https:\/\/git-lfs|oid sha256:|size \d+|ext-)/.test(l))) {
      const size = (sign) => +(changed.find((l) => l.startsWith(`${sign}size `)) || '').split(' ')[1] || null;
      const [a, b] = [size('-'), size('+')];
      const what = a && b ? `${fmtBytes(a)} → ${fmtBytes(b)}` : b ? `added, ${fmtBytes(b)}` : a ? `removed (was ${fmtBytes(a)})` : 'changed';
      return `<div class="special-diff"><h4>Stored in Git LFS</h4><p>The file itself lives in LFS storage; git only tracks a small pointer. Size: ${what}.</p></div>`;
    }
  }
  return null;
}

// ------------------------------------------------------------------ signatures

const SIG = {
  G: ['ok', (s) => `Signed by ${s || 'a trusted key'}`],
  U: ['ok', (s) => `Signed by ${s || 'a key'} (not marked as trusted)`],
  B: ['bad', () => 'Bad signature — the commit was changed after signing'],
  X: ['warn', (s) => `Signed by ${s || 'a key'}; the signature has expired`],
  Y: ['warn', (s) => `Signed by ${s || 'a key'} that has expired`],
  R: ['bad', (s) => `Signed by ${s || 'a key'} that was revoked`],
  E: ['warn', () => "Signed, but the signature can't be checked here (missing key or allowed-signers file)"],
};

function signatureHtml(c) {
  const s = c.signature && SIG[c.signature];
  if (!s) return '';
  return `<div class="sig sig-${s[0]}">${s[0] === 'ok' ? '✓' : s[0] === 'bad' ? '✗' : '!'} ${esc(s[1](c.signer))}</div>`;
}

// ------------------------------------------------------------------ bisect

function bisectMenu(sha) {
  if (!S.op?.bisect) return [null, ['Find the commit that broke something (bisect)…', () => startBisect(sha)]];
  return [null, ['Bisect: mark this commit good', () => bisectMark('good', sha)], ['Bisect: mark this commit bad', () => bisectMark('bad', sha)], ['Bisect: skip this commit', () => bisectMark('skip', sha)]];
}

async function startBisect(sha) {
  const c = await ask(
    `Bisect checks out commits between a good one and a bad one, halving the range each time, until it finds the first bad commit.\n\nDoes ${short(sha)} have the problem?`,
    { ok: 'Yes — it is bad', alt: 'No — it works (good)' },
  );
  if (!c) return;
  await bisectMark(c === true ? 'bad' : 'good', sha, true);
}

/** Mark a commit (default: the checked-out one) good/bad/skip; starts bisect if needed. */
async function bisectMark(kind, sha = null, start = false) {
  const out = await runGit(async () => {
    if (start) await gitRaw(['bisect', 'start']);
    return gitRaw(['bisect', kind, ...(sha ? [sha] : [])]);
  });
  if (out === null) return;
  const left = /Bisecting: (\d+) revisions? left to test after this \(roughly (\d+) steps?\)/.exec(out);
  const found = /^([0-9a-f]{7,64}) is the first bad commit/m.exec(out);
  if (found) {
    toast(`Found it: ${short(found[1])} is the first bad commit`, 'ok');
    if (S.index.has(found[1])) select(found[1], true);
  } else if (left) toast(`Marked ${kind}. Test the checked-out commit — about ${left[2]} step${left[2] === '1' ? '' : 's'} left.`, 'ok');
  else toast(`Marked ${kind}.`, 'ok');
}

function renderBisectBar() {
  const bar = $('#bisect-bar');
  const b = S.op?.bisect;
  bar.hidden = !b;
  if (!b) return;
  const head = S.graph?.head_sha;
  const row = head && S.rows[S.index.get(head)];
  const subject = (sha) => S.rows[S.index.get(sha)]?.subject || '';
  let text, buttons;
  if (b.found) {
    text = `Found it: <code>${short(b.found)}</code> “${esc(subject(b.found))}” is the first bad commit.`;
    buttons = `<button class="mini" data-bis="show">Show commit</button><button class="mini primary-mini" data-bis="reset">Stop bisect</button>`;
  } else if (!b.bad || !b.good.length) {
    text = `Bisecting: now mark a commit that ${b.bad ? 'works (good)' : 'has the problem (bad)'} — right-click it in the graph, or mark the checked-out one.`;
    buttons = `<button class="mini" data-bis="${b.bad ? 'good' : 'bad'}">Checked-out commit is ${b.bad ? 'good' : 'bad'}</button><button class="mini" data-bis="reset">Stop</button>`;
  } else {
    text = `Bisecting · about ${b.steps ?? '?'} step${b.steps === 1 ? '' : 's'} left (${b.remaining ?? '?'} commits). Test <code>${short(head)}</code> “${esc(row?.subject || '')}”: does it have the problem?`;
    buttons = `<button class="mini good" data-bis="good">Good</button><button class="mini bad" data-bis="bad">Bad</button><button class="mini" data-bis="skip" title="Can't test this one">Skip</button><button class="mini" data-bis="reset">Stop</button>`;
  }
  bar.innerHTML = `<span>${text}</span><span class="spacer"></span>${buttons}`;
}

$('#bisect-bar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-bis]');
  if (!b) return;
  const act = b.dataset.bis;
  if (act === 'show') return S.op?.bisect?.found && jumpTo(S.op.bisect.found);
  if (act === 'reset') return git(['bisect', 'reset'], 'Bisect stopped — back where you started');
  bisectMark(act);
});
