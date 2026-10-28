'use strict';
// Merge/rebase/cherry-pick conflict resolution. Loaded after app.js and shares its globals.

const CONFLICT_KIND = {
  UU: 'both modified',
  AA: 'both added',
  DU: 'deleted by ours',
  UD: 'deleted by theirs',
  AU: 'added by ours',
  UA: 'added by theirs',
  DD: 'both deleted',
};

S.op = {};
S.conflictPath = null;
const CF = { path: null, xy: null, segs: null, crlf: false };

/** Friendly names for the two sides. During a rebase git's "ours" is the branch being
 *  rebased onto and "theirs" is your commit being replayed — the reverse of a merge. */
function sideNames() {
  const op = S.op || {};
  const head = S.graph?.head_branch || 'HEAD';
  switch (op.kind) {
    case 'rebase':
      return { ours: `${op.onto || 'upstream'} (rebasing onto)`, theirs: `your commit${op.incoming ? ` ${op.incoming}` : ''}` };
    case 'merge':
      return { ours: `${head} (current)`, theirs: `${op.incoming || 'incoming'} (merging in)` };
    case 'cherry-pick':
    case 'revert':
      return { ours: `${head} (current)`, theirs: `${op.incoming || 'commit'} (${op.kind})` };
    default:
      return { ours: 'Current (HEAD)', theirs: 'Incoming' };
  }
}

// ------------------------------------------------------------------ markers

/** Split text into plain segments and conflict blocks; null if markers are unbalanced. */
function parseConflicts(text) {
  const segs = [];
  let buf = [];
  let cur = null;
  let part = null;
  for (const line of text.split('\n')) {
    if (!cur && line.startsWith('<<<<<<<')) {
      if (buf.length) segs.push({ type: 'text', lines: buf });
      buf = [];
      cur = { type: 'conflict', ours: [], base: null, theirs: [], oursLabel: line.slice(7).trim(), theirsLabel: '', result: null, pick: null };
      part = 'ours';
    } else if (cur && part === 'ours' && line.startsWith('|||||||')) {
      cur.base = [];
      part = 'base';
    } else if (cur && part !== 'theirs' && line === '=======') {
      part = 'theirs';
    } else if (cur && part === 'theirs' && line.startsWith('>>>>>>>')) {
      cur.theirsLabel = line.slice(7).trim();
      segs.push(cur);
      cur = null;
    } else if (cur) {
      cur[part].push(line);
    } else {
      buf.push(line);
    }
  }
  if (cur) return null;
  if (buf.length) segs.push({ type: 'text', lines: buf });
  return segs;
}

function assemble() {
  const out = [];
  for (const s of CF.segs) out.push(...(s.type === 'text' ? s.lines : s.result));
  const text = out.join('\n');
  return CF.crlf ? text.replace(/\n/g, '\r\n') : text;
}

const pickLines = {
  ours: (b) => [...b.ours],
  theirs: (b) => [...b.theirs],
  both: (b) => [...b.ours, ...b.theirs],
  'both-rev': (b) => [...b.theirs, ...b.ours],
};

// ------------------------------------------------------------------ view

function closeConflict() {
  S.conflictPath = null;
  CF.path = null;
  $('#conflict-view').hidden = true;
  document.querySelectorAll('#detail .f-row[data-mode="conflict"].sel').forEach((r) => r.classList.remove('sel'));
}

function markRow() {
  document.querySelectorAll('#detail .f-row[data-mode="conflict"]').forEach((r) => r.classList.toggle('sel', r.dataset.path === CF.path));
}

async function openConflict(path, xy) {
  closeDiff();
  let file;
  try {
    file = await invoke('read_conflict', { repo: S.repo, path });
  } catch (e) {
    return toast(String(e), 'err');
  }
  Object.assign(CF, { path, xy, segs: null, crlf: false });
  S.conflictPath = path;
  const names = sideNames();
  $('#cf-path').textContent = path;
  $('#cf-legend').innerHTML =
    `<span class="lg ours">◧ Ours: ${esc(names.ours)}</span><span class="lg theirs">◨ Theirs: ${esc(names.theirs)}</span>` +
    (S.op?.kind === 'rebase' ? '<small>In a rebase, “ours” is the branch you are rebasing onto and “theirs” is your own commit.</small>' : '');
  $('#conflict-view').hidden = false;
  markRow();

  if (file.binary) return renderSpecial('binary');
  if (!file.exists) return renderSpecial('missing');
  CF.crlf = file.text.includes('\r\n');
  CF.segs = parseConflicts(CF.crlf ? file.text.replace(/\r\n/g, '\n') : file.text);
  if (!CF.segs) return renderSpecial('malformed');
  if (!CF.segs.some((s) => s.type === 'conflict')) return renderSpecial(['UU', 'AA'].includes(xy) ? 'clean' : 'deleted');
  renderBlocks();
}

function renderSpecial(kind) {
  const n = sideNames();
  const xy = CF.xy;
  const msgs = {
    binary: 'This is a binary file, so it can only be resolved by picking one whole version.',
    malformed: 'The conflict markers in this file look incomplete. Fix it in your editor, then mark it resolved.',
    clean: 'No conflict markers are left in this file (it may have been edited already).',
    deleted:
      xy === 'DU' ? `The file was deleted on ours (${n.ours}) but changed on theirs (${n.theirs}).`
      : xy === 'UD' ? `The file was changed on ours (${n.ours}) but deleted on theirs (${n.theirs}).`
      : xy === 'DD' ? 'Both sides deleted or renamed this file.'
      : `The file was added on one side only (${CONFLICT_KIND[xy] || xy}).`,
    missing: xy === 'DD' ? 'Both sides deleted or renamed this file.' : 'The file is not present in the working tree.',
  };
  const btn = (act, label, cls = '') => `<button class="mini ${cls}" data-cf-act="${act}">${esc(label)}</button>`;
  const actions = {
    binary: btn('ours-file', `Use ours — ${n.ours}`) + btn('theirs-file', `Use theirs — ${n.theirs}`),
    malformed: btn('open', 'Open in editor') + btn('mark', 'Mark resolved'),
    clean: btn('mark', 'Mark resolved', 'primary-mini'),
    deleted: (xy === 'DD' ? '' : btn('keep', 'Keep file')) + btn('delete', 'Delete file', 'danger'),
    missing: (xy === 'DD' ? '' : btn('theirs-file', `Restore theirs — ${n.theirs}`) + btn('ours-file', `Restore ours — ${n.ours}`)) + btn('delete', 'Delete file', 'danger'),
  };
  $('#cf-tools').hidden = true;
  $('#cf-progress').textContent = CONFLICT_KIND[xy] || '';
  $('#cf-body').innerHTML = `<div class="cf-special"><p>${esc(msgs[kind])}</p><div class="cf-special-acts">${actions[kind]}</div></div>`;
}

function codeHtml(lines) {
  return lines.length ? esc(lines.join('\n')) : '<span class="cf-none">(no lines)</span>';
}

function textSegHtml(seg, i) {
  const lines = seg.lines;
  if (seg.expanded || lines.length <= 8) return `<pre class="cf-text">${esc(lines.join('\n'))}</pre>`;
  return `<pre class="cf-text">${esc(lines.slice(0, 3).join('\n'))}</pre>
    <div class="cf-fold" data-unfold="${i}">⋯ ${lines.length - 6} unchanged lines</div>
    <pre class="cf-text">${esc(lines.slice(-3).join('\n'))}</pre>`;
}

function blockHtml(b, i, k) {
  const n = sideNames();
  const side = (which, label, lines) => `
    <div class="cf-side ${which} ${b.pick === which ? 'picked' : ''}">
      <div class="cf-h">${which === 'ours' ? '◧' : '◨'} ${esc(which === 'ours' ? n.ours : n.theirs)}
        ${label ? `<small>${esc(label)}</small>` : ''}</div>
      <pre>${codeHtml(lines)}</pre>
    </div>`;
  const choice = (p, label) => `<button class="mini ${b.pick === p ? 'on' : ''}" data-pick="${p}">${label}</button>`;
  return `<section class="cf-block ${b.result ? 'done' : ''}" data-seg="${i}">
    <div class="cf-top"><b>Conflict ${k}</b>${b.result ? '<span class="ok">✓ resolved</span>' : ''}<span class="spacer"></span>
      ${choice('ours', 'Ours')}${choice('theirs', 'Theirs')}${choice('both', 'Both')}${choice('both-rev', 'Both, theirs first')}</div>
    <div class="cf-cols">${side('ours', b.oursLabel, b.ours)}${side('theirs', b.theirsLabel, b.theirs)}</div>
    ${b.result ? `<div class="cf-result"><div class="cf-h">Result <small>— edit freely</small><span class="spacer"></span><button class="mini" data-pick="reset">Undo</button></div>
      <textarea data-result="${i}" spellcheck="false" rows="${Math.min(18, Math.max(2, b.result.length + 1))}">${esc(b.result.join('\n'))}</textarea></div>` : ''}
  </section>`;
}

function renderBlocks() {
  let k = 0;
  $('#cf-tools').hidden = false;
  $('#cf-body').innerHTML = CF.segs.map((s, i) => (s.type === 'text' ? textSegHtml(s, i) : blockHtml(s, i, ++k))).join('');
  updateProgress();
}

function rerenderBlock(i) {
  const el = $(`.cf-block[data-seg="${i}"]`);
  const k = CF.segs.slice(0, i + 1).filter((s) => s.type === 'conflict').length;
  el.outerHTML = blockHtml(CF.segs[i], i, k);
  updateProgress();
}

function updateProgress() {
  const blocks = CF.segs.filter((s) => s.type === 'conflict');
  const done = blocks.filter((b) => b.result).length;
  $('#cf-progress').textContent = `${done} of ${blocks.length} resolved`;
  $('#cf-progress').className = done === blocks.length ? 'all-done' : '';
  $('#cf-save').disabled = done < blocks.length;
}

$('#cf-body').addEventListener('click', (e) => {
  const unfold = e.target.closest('[data-unfold]');
  if (unfold) {
    CF.segs[+unfold.dataset.unfold].expanded = true;
    return renderBlocks();
  }
  const pick = e.target.closest('[data-pick]');
  if (pick) {
    const i = +pick.closest('.cf-block').dataset.seg;
    const b = CF.segs[i];
    const p = pick.dataset.pick;
    b.pick = p === 'reset' ? null : p;
    b.result = p === 'reset' ? null : pickLines[p](b);
    rerenderBlock(i);
    return;
  }
  const act = e.target.closest('[data-cf-act]');
  if (act) wholeFileAction(act.dataset.cfAct);
});

$('#cf-body').addEventListener('input', (e) => {
  const ta = e.target.closest('textarea[data-result]');
  if (!ta) return;
  const b = CF.segs[+ta.dataset.result];
  b.result = ta.value === '' ? [] : ta.value.split('\n');
  b.pick = 'custom';
  ta.closest('.cf-block').querySelectorAll('.cf-top .mini.on, .cf-side.picked').forEach((x) => x.classList.remove('on', 'picked'));
});

function pickAll(which) {
  for (const s of CF.segs) {
    if (s.type !== 'conflict') continue;
    s.pick = which;
    s.result = pickLines[which](s);
  }
  renderBlocks();
}
$('#cf-all-ours').addEventListener('click', () => pickAll('ours'));
$('#cf-all-theirs').addEventListener('click', () => pickAll('theirs'));
$('#cf-close').addEventListener('click', closeConflict);
$('#cf-open').addEventListener('click', () => invoke('reveal', { repo: S.repo, target: 'file', path: CF.path }).catch((e) => toast(String(e), 'err')));

$('#cf-save').addEventListener('click', async () => {
  const content = assemble();
  if (/^(<{7}|={7}|>{7})( |$)/m.test(content.replace(/\r/g, ''))) {
    const go = await ask('The result still contains conflict markers (<<<<<<<, =======, >>>>>>>). Save anyway?', { ok: 'Save anyway', danger: true });
    if (go !== true) return;
  }
  const path = CF.path;
  try {
    await busy(() => invoke('resolve_conflict', { profileId: activeProfile().id, repo: S.repo, path, content }));
  } catch (e) {
    return toast(String(e), 'err');
  }
  closeConflict();
  await refresh();
  // Count from git directly: refresh() may skip if another refresh is in flight.
  const st = await invoke('get_status', { repo: S.repo }).catch(() => S.status);
  const left = st?.conflicted.length || 0;
  toast(left ? `Resolved ${path} — ${left} file${left === 1 ? '' : 's'} left` : `Resolved ${path} — all conflicts resolved`, 'ok');
});

async function wholeFileAction(act) {
  const path = CF.path;
  const steps = {
    'ours-file': [['checkout', '--ours', '--', path], ['add', '--', path]],
    'theirs-file': [['checkout', '--theirs', '--', path], ['add', '--', path]],
    keep: [['add', '--', path]],
    mark: [['add', '--', path]],
    delete: [['rm', '-q', '--', path]],
  }[act];
  if (act === 'open') return $('#cf-open').click();
  if (act === 'delete' && (await ask(`Delete ${path} as the resolution?`, { ok: 'Delete file', danger: true })) !== true) return;
  try {
    await busy(async () => {
      for (const args of steps) await gitRaw(args);
    });
  } catch (e) {
    return toast(String(e), 'err');
  }
  closeConflict();
  await refresh();
  toast(`Resolved ${path}`, 'ok');
}

// ------------------------------------------------------------------ merge / rebase in progress

function opBannerHtml() {
  const op = S.op || {};
  if (!op.kind) return '';
  const n = S.status?.conflicted.length || 0;
  const head = S.graph?.head_branch || 'HEAD';
  const b = (x) => `<b>${esc(x)}</b>`;
  const title = {
    merge: `Merging ${b(op.incoming || 'a branch')} into ${b(head)}`,
    rebase: `Rebasing ${b(op.head_name || 'branch')} onto ${b(op.onto || 'upstream')}${op.step ? ` — commit ${op.step[0]} of ${op.step[1]}` : ''}`,
    'cherry-pick': `Cherry-picking ${b(op.incoming || 'a commit')}`,
    revert: `Reverting ${b(op.incoming || 'a commit')}`,
  }[op.kind];
  const sub = op.kind === 'rebase' && op.incoming ? `<div class="op-sub">Applying ${esc(op.incoming)}</div>` : '';
  const state = n ? `${n} conflicted file${n === 1 ? '' : 's'} — click one below to resolve it` : 'All conflicts resolved — continue when ready';
  const cont = { merge: 'Commit merge', rebase: 'Continue rebase', 'cherry-pick': 'Continue', revert: 'Continue' }[op.kind];
  return `<div class="op-banner">
    <div class="op-title">${title}</div>${sub}
    <div class="op-state ${n ? 'pending' : 'ready'}">${state}</div>
    <div class="op-acts">
      <button class="mini danger" data-op="abort">Abort</button>
      ${op.kind === 'rebase' ? '<button class="mini" data-op="skip" title="Drop this commit from the rebased branch">Skip commit</button>' : ''}
      <span class="spacer"></span>
      <button class="mini primary-mini" data-op="continue" ${n ? 'disabled' : ''}>${cont}</button>
    </div></div>`;
}

$('#detail').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-op]');
  if (!btn) return;
  e.stopPropagation();
  const kind = S.op?.kind;
  if (!kind) return;
  const what = { merge: 'merge', rebase: 'rebase', 'cherry-pick': 'cherry-pick', revert: 'revert' }[kind];
  if (btn.dataset.op === 'abort') {
    const ok = await ask(`Abort the ${what}?\n\nYour branch goes back to how it was before it started; conflict resolutions made so far are discarded.`, {
      ok: `Abort ${what}`,
      danger: true,
    });
    if (ok === true) {
      closeConflict();
      await git([kind, '--abort'], `${what[0].toUpperCase()}${what.slice(1)} aborted`);
    }
  } else if (btn.dataset.op === 'skip') {
    const ok = await ask("Skip this commit?\n\nIts changes are dropped from the rebased branch.", { ok: 'Skip commit', danger: true });
    if (ok === true) await git(['rebase', '--skip'], 'Commit skipped');
  } else if (btn.dataset.op === 'continue') {
    const args = kind === 'merge' ? ['commit', '--no-edit'] : [kind, '--continue'];
    const out = await git(args, kind === 'merge' ? 'Merge committed' : `${what[0].toUpperCase()}${what.slice(1)} continued`);
    if (out !== null && kind === 'merge') {
      draft.summary = draft.body = '';
      draft.mergePrefilled = false;
    }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.conflictPath && $('#ctx-menu').hidden && !$('#modal').open) closeConflict();
});
