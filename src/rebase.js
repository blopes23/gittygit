'use strict';

// Interactive rebase: reorder, reword, squash, fixup or drop the commits after a base commit.
// The list shows newest first, like the graph; the backend gets git's oldest-first todo.

const RB_ACTIONS = {
  pick: 'Pick',
  reword: 'Reword',
  squash: 'Squash ↓',
  fixup: 'Fixup ↓',
  drop: 'Drop',
};
const RB = { base: null, items: [], drag: null };
const rbDlg = $('#rebase-dlg');

/** `preset.squash`: consecutive commits (oldest first) to squash into the oldest of them. */
async function openRebase(base, preset = {}) {
  if (S.op?.kind) return toast(`Finish the ${S.op.kind} in progress first.`, 'err');
  if (S.status && (S.status.staged.length || S.status.unstaged.some((f) => f.status !== '?')))
    return toast('Commit or stash your changes before an interactive rebase.', 'err');
  let plan;
  try {
    plan = await busy(() => invoke('rebase_plan', { repo: S.repo, base }));
  } catch (e) {
    return toast(String(e), 'err');
  }
  if (plan.has_merges) return toast("The commits after this one include merges, which an interactive rebase would flatten. Pick a later commit.", 'err');
  if (!plan.commits.length) return toast('There are no commits after this one on the current branch.');
  const squash = preset.squash || [];
  if (squash.length) {
    const order = plan.commits.map((c) => c.sha);
    if (squash.some((sha, k) => order[k] !== sha))
      return toast('Squashing needs consecutive commits on the current branch. Select a run of commits without gaps.', 'err');
  }
  RB.base = base;
  RB.items = plan.commits.reverse().map((c) => ({ ...c, action: squash.includes(c.sha) && c.sha !== squash[0] ? 'squash' : 'pick', edited: c.message }));
  renderRebase();
  rbDlg.showModal();
}

/** Problem with the current plan, or '' when it can run. Squash/fixup meld into the row below. */
function rebaseProblem() {
  const kept = RB.items.filter((it) => it.action !== 'drop');
  if (!kept.length) return 'Every commit is dropped. Use “Reset to here” instead.';
  const oldest = kept[kept.length - 1];
  if (oldest.action === 'squash' || oldest.action === 'fixup') return `“${oldest.message.split('\n')[0]}” is the oldest kept commit, so there's nothing below it to ${oldest.action} into.`;
  const blank = RB.items.find((it) => it.action === 'reword' && !it.edited.trim());
  if (blank) return 'A reworded commit needs a message.';
  return '';
}

function rebaseSummary() {
  const n = (a) => RB.items.filter((it) => it.action === a).length;
  const moved = RB.items.some((it, i) => it.pos !== undefined && it.pos !== i);
  const parts = [
    n('reword') && `${n('reword')} reworded`,
    n('squash') + n('fixup') && `${n('squash') + n('fixup')} squashed`,
    n('drop') && `${n('drop')} dropped`,
    moved && 'reordered',
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'No changes yet';
}

function renderRebase() {
  RB.items.forEach((it, i) => (it.pos ??= i));
  const branch = S.graph?.head_branch || 'HEAD';
  const rows = RB.items
    .map((it, i) => {
      const [subject] = it.message.split('\n');
      const opts = Object.entries(RB_ACTIONS).map(([a, label]) => `<option value="${a}"${a === it.action ? ' selected' : ''}>${label}</option>`).join('');
      const text = it.action === 'reword'
        ? `<textarea class="rb-msg" data-i="${i}" spellcheck="true">${esc(it.edited)}</textarea>`
        : `<span class="rb-subj">${esc(subject)}</span>`;
      return `<div class="rb-row rb-${it.action}" draggable="true" data-i="${i}">
        <span class="rb-grip" title="Drag to reorder">⋮⋮</span>
        <select data-i="${i}">${opts}</select>
        <code>${short(it.sha)}</code>
        <div class="rb-text">${text}<small>${esc(it.author)} · ${fmtDate(it.time)}</small></div>
        <span class="rb-move"><button class="ghost" data-mv="-1" data-i="${i}" title="Move up (newer)" ${i === 0 ? 'disabled' : ''}>↑</button><button class="ghost" data-mv="1" data-i="${i}" title="Move down (older)" ${i === RB.items.length - 1 ? 'disabled' : ''}>↓</button></span>
      </div>`;
    })
    .join('');
  const problem = rebaseProblem();
  const idle = rebaseSummary() === 'No changes yet';
  rbDlg.innerHTML = `<div class="rb">
    <h3>Interactive rebase <b>${esc(branch)}</b> onto <code>${short(RB.base)}</code></h3>
    <p class="rb-hint">Newest at the top. Drag or use ↑↓ to reorder. <b>Squash</b> melds a commit into the one below it and keeps both messages; <b>Fixup</b> keeps only the one below's message.</p>
    <div class="rb-list">${rows}</div>
    <div class="rb-base"><code>${short(RB.base)}</code> base (unchanged)</div>
    <p class="rb-err">${esc(problem)}</p>
    <menu><span class="rb-sum">${esc(rebaseSummary())}</span><span class="spacer"></span>
      <button class="ghost" data-rb="cancel">Cancel</button>
      <button class="primary" data-rb="start" ${problem || idle ? 'disabled' : ''}>Start rebase</button></menu>
  </div>`;
}

function updateRebaseFooter() {
  const problem = rebaseProblem();
  $('.rb-err', rbDlg).textContent = problem;
  $('[data-rb="start"]', rbDlg).disabled = !!problem || rebaseSummary() === 'No changes yet';
  $('.rb-sum', rbDlg).textContent = rebaseSummary();
}

function moveItem(from, to) {
  if (to < 0 || to >= RB.items.length || from === to) return;
  const [it] = RB.items.splice(from, 1);
  RB.items.splice(to, 0, it);
  renderRebase();
}

rbDlg.addEventListener('change', (e) => {
  const sel = e.target.closest('select[data-i]');
  if (!sel) return;
  RB.items[+sel.dataset.i].action = sel.value;
  renderRebase();
  if (sel.value === 'reword') $(`.rb-msg[data-i="${sel.dataset.i}"]`, rbDlg)?.focus();
});
rbDlg.addEventListener('input', (e) => {
  const ta = e.target.closest('.rb-msg');
  if (!ta) return;
  RB.items[+ta.dataset.i].edited = ta.value;
  updateRebaseFooter();
});
rbDlg.addEventListener('click', async (e) => {
  const mv = e.target.closest('[data-mv]');
  if (mv) return moveItem(+mv.dataset.i, +mv.dataset.i + +mv.dataset.mv);
  const b = e.target.closest('[data-rb]');
  if (!b) return;
  if (b.dataset.rb === 'cancel') return rbDlg.close();
  if (rebaseProblem() || rebaseSummary() === 'No changes yet') return;
  // Oldest first for git's todo list.
  const steps = [...RB.items].reverse().map((it) => ({ action: it.action, sha: it.sha, message: it.action === 'reword' ? it.edited.trim() : null }));
  const base = RB.base;
  const summary = rebaseSummary();
  rbDlg.close();
  const fn = () =>
    invoke('interactive_rebase', { profileId: activeProfile().id, repo: S.repo, base, steps }).catch((err) => {
      throw explainGitError(String(err));
    });
  await moveHead(fn, `Rebased ${S.graph?.head_branch || 'HEAD'} (${summary.toLowerCase()})`);
});

rbDlg.addEventListener('dragstart', (e) => {
  const row = e.target.closest('.rb-row');
  if (!row || e.target.closest('textarea, select')) return e.preventDefault();
  RB.drag = +row.dataset.i;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', row.dataset.i);
  row.classList.add('dragging');
});
rbDlg.addEventListener('dragover', (e) => {
  const row = e.target.closest('.rb-row');
  if (RB.drag === null || !row) return;
  e.preventDefault();
  rbDlg.querySelectorAll('.rb-row').forEach((r) => r.classList.remove('drop-above', 'drop-below'));
  const below = e.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
  row.classList.add(below ? 'drop-below' : 'drop-above');
});
rbDlg.addEventListener('drop', (e) => {
  const row = e.target.closest('.rb-row');
  if (RB.drag === null || !row) return;
  e.preventDefault();
  const below = e.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
  let to = +row.dataset.i + (below ? 1 : 0);
  if (to > RB.drag) to--;
  const from = RB.drag;
  RB.drag = null;
  moveItem(from, to);
});
rbDlg.addEventListener('dragend', () => {
  RB.drag = null;
  rbDlg.querySelectorAll('.rb-row').forEach((r) => r.classList.remove('dragging', 'drop-above', 'drop-below'));
});
