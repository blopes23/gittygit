'use strict';
// Recover lost commits: git's reflog (where HEAD and branches pointed recently) and, on demand,
// a deep scan for commits nothing points to any more (dropped stashes, deleted branches).

const rcDlg = $('#recover-dlg');
const RC = { mode: 'reflog', list: [], sel: -1 };

async function openRecover() {
  if (!S.repo || rcDlg.open) return;
  RC.mode = 'reflog';
  RC.sel = -1;
  rcDlg.showModal();
  await loadRecover();
}

async function loadRecover() {
  renderRecover('Loading…');
  try {
    RC.list = RC.mode === 'reflog' ? await invoke('get_reflog', { repo: S.repo }) : await invoke('get_unreachable', { repo: S.repo });
  } catch (e) {
    RC.list = [];
    return renderRecover(String(e));
  }
  RC.sel = -1;
  renderRecover();
}

/** Reflog actions in plain words ("commit: X" → "Committed", "reset: moving to …" → "Reset"…). */
function describeAction(a) {
  const [kind] = a.split(':');
  const label = {
    commit: 'Committed', 'commit (amend)': 'Amended', 'commit (merge)': 'Merge commit', 'commit (initial)': 'First commit',
    reset: 'Reset', checkout: 'Checked out', merge: 'Merged', pull: 'Pulled', rebase: 'Rebase', 'cherry-pick': 'Cherry-picked',
    revert: 'Reverted', branch: 'Branch created', fetch: 'Fetched', push: 'Pushed', clone: 'Cloned',
  }[kind.replace(/ \(.*\)$/, '')] || kind;
  return kind.startsWith('rebase') ? `${label} ${kind.match(/\((.*)\)/)?.[1] || ''}`.trim() : label;
}

function renderRecover(message = '') {
  const rows = RC.list
    .map((e, i) => {
      const ref = e.selector ? e.selector.replace(/^refs\/heads\//, '').replace(/@\{\d+\}$/, '') : '';
      const what = RC.mode === 'reflog' ? `<span class="rc-act" title="${esc(e.action)}${ref ? ` (${esc(ref)})` : ''}">${esc(describeAction(e.action))}</span>` : '<span class="rc-act">Unreachable</span>';
      return `<div class="rc-row${i === RC.sel ? ' sel' : ''}" data-i="${i}">
        <span class="rc-time" title="${fmtFull(e.time)}">${fmtDate(e.time)}</span>${what}
        <span class="rc-subj">${esc(e.subject)}</span><code>${short(e.sha)}</code></div>`;
    })
    .join('');
  const e = RC.list[RC.sel];
  rcDlg.innerHTML = `<div class="rc">
    <div class="rc-head"><h3>Recover lost commits</h3><span class="spacer"></span>
      <div class="seg"><button class="${RC.mode === 'reflog' ? 'on' : ''}" data-rc="reflog">Recent activity</button><button class="${RC.mode === 'deep' ? 'on' : ''}" data-rc="deep">Deep scan</button></div></div>
    <p class="hint">${RC.mode === 'reflog'
      ? 'Every place HEAD and your branches have pointed recently (git keeps about 90 days). Pick the state you want back.'
      : 'Commits nothing points to any more — dropped stashes, work from deleted branches. Git removes these after about two weeks.'}</p>
    <div class="rc-list">${rows || `<div class="f-empty">${esc(message || 'Nothing found')}</div>`}</div>
    <div class="rc-preview" id="rc-preview">${e ? '' : '<span class="hint">Select an entry to see the commit.</span>'}</div>
    <menu><button class="ghost" data-rc="close">Close</button><span class="spacer"></span>
      <button class="ghost" data-rc="branch" ${e ? '' : 'disabled'}>Create branch here…</button>
      <button class="ghost danger-txt" data-rc="reset" ${e && currentBranch() ? '' : 'disabled'}>Reset ${esc(currentBranch()?.name || 'branch')} here…</button></menu>
  </div>`;
  if (e) previewRecover(e.sha);
}

async function previewRecover(sha) {
  let c;
  try {
    c = await getCommit(sha);
  } catch (e) {
    return ($('#rc-preview').textContent = String(e));
  }
  if (RC.list[RC.sel]?.sha !== sha) return;
  $('#rc-preview').innerHTML = `<b>${esc(c.message.split('\n')[0])}</b>
    <div class="hint">${esc(c.author)} · ${fmtDate(c.time)} · <code>${short(c.sha)}</code>${S.index.has(sha) ? ' · in the graph' : ' · not in any branch'}</div>
    <div class="rc-files">${c.files.slice(0, 40).map((f) => `<div><span class="st st-${esc(f.status)}">${esc(f.status)}</span> ${esc(f.path)}</div>`).join('')}${c.files.length > 40 ? `<div class="hint">…and ${c.files.length - 40} more</div>` : ''}</div>`;
}

rcDlg.addEventListener('click', async (ev) => {
  const row = ev.target.closest('.rc-row');
  if (row) {
    RC.sel = +row.dataset.i;
    return renderRecover();
  }
  const b = ev.target.closest('[data-rc]');
  if (!b) return;
  const act = b.dataset.rc;
  if (act === 'close') return rcDlg.close();
  if (act === 'reflog' || act === 'deep') {
    RC.mode = act;
    return loadRecover();
  }
  const e = RC.list[RC.sel];
  if (!e) return;
  rcDlg.close();
  if (act === 'branch') {
    const name = await ask(`New branch at ${short(e.sha)} “${e.subject}”`, { input: true, placeholder: 'recovered-work', ok: 'Create' });
    if (name && (await git(['branch', name, e.sha], `Created ${name} at ${short(e.sha)}`)) !== null) jumpTo(e.sha);
  } else if (act === 'reset') {
    await resetTo(e.sha, 'hard');
  }
});
