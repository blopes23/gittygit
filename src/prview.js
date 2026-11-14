'use strict';
// A pull request in the detail panel (sidebar → Pull requests): description, checks, reviews and
// comments, its changes and files, and the actions: approve, request changes, comment, merge,
// close, check out. Reading works without a token for public repositories; acting needs one.

const REVIEW_STATE = { APPROVED: ['approved', 'ok'], CHANGES_REQUESTED: ['requested changes', 'bad'], COMMENTED: ['commented', ''], DISMISSED: ['review dismissed', ''] };

function openPR(number) {
  if (S.pr?.number !== number) {
    S.pr = { number, detail: null };
    S.dtab = 'overview';
  }
  S.multi.clear();
  S.compare = null;
  S.branch = null;
  closeDiff();
  setBranchSelection([], null);
  const head = findPR(number)?.head_sha;
  if (head && S.index.has(head)) revealInGraph(head);
  renderDetail();
}

async function loadPR(p) {
  try {
    p.detail = await invoke('pr_detail', { profileId: activeProfile().id, repo: S.repo, remote: defaultRemote(), number: p.number });
  } catch (e) {
    p.error = String(e);
  }
}

/** The PR's head commit, fetched (without a ref, so it stays out of the graph) if needed. */
async function prHead(d) {
  try {
    await invoke('get_commit', { repo: S.repo, sha: d.head_sha });
  } catch {
    await busy(() => gitRaw(['fetch', '--no-tags', '--quiet', defaultRemote(), `pull/${d.number}/head`]));
  }
  return d.head_sha;
}

const fmtIso = (iso) => (iso ? fmtDate(Date.parse(iso) / 1000) : '');

function mergeStatus(d) {
  if (d.merged) return ['Merged', 'ok'];
  if (d.state !== 'open') return ['Closed', 'bad'];
  if (d.draft) return ['Draft', ''];
  return (
    {
      clean: ['Ready to merge', 'ok'],
      unstable: ['Mergeable · some checks failed', 'warn'],
      has_hooks: ['Ready to merge', 'ok'],
      behind: ['Behind its base branch', 'warn'],
      blocked: ['Blocked (required reviews or checks)', 'warn'],
      dirty: ['Has conflicts with its base branch', 'bad'],
    }[d.mergeable_state] || ['Checking whether it can merge…', '']
  );
}

function checksHtml(checks) {
  if (!checks.length) return '';
  const failed = checks.filter((c) => ['failure', 'cancelled', 'timed_out', 'action_required'].includes(c.conclusion));
  const running = checks.filter((c) => c.status !== 'completed');
  const head = failed.length ? `${failed.length} of ${checks.length} checks failed` : running.length ? `${running.length} of ${checks.length} checks running` : `${checks.length} checks passed`;
  const cls = failed.length ? 'bad' : running.length ? 'warn' : 'ok';
  const rows = checks
    .map((c) => {
      const st = c.status !== 'completed' ? 'pending' : c.conclusion === 'success' ? 'success' : ['skipped', 'neutral'].includes(c.conclusion) ? 'skipped' : 'failure';
      return `<div class="pr-check"><span class="chk chk-${st}"></span><a data-url="${esc(c.url || '')}">${esc(c.name)}</a><small>${esc(c.status === 'completed' ? c.conclusion : c.status)}</small></div>`;
    })
    .join('');
  return `<details class="pr-checks"${failed.length ? ' open' : ''}><summary class="pr-st ${cls}">${head}</summary>${rows}</details>`;
}

async function renderPR() {
  const p = S.pr;
  const pr = findPR(p.number);
  if (!p.detail && !p.error) {
    $('#detail').innerHTML = `<div class="d-head"><div class="sha-line"><span>pull request #${p.number}</span></div><h2>${esc(pr?.title || '')}</h2></div><div class="d-scroll"><div class="f-empty">Loading…</div></div>`;
    await loadPR(p);
    if (S.pr !== p) return;
  }
  if (p.error) {
    $('#detail').innerHTML = `<div class="d-head"><div class="sha-line"><span>pull request #${p.number}</span></div><h2>${esc(pr?.title || '')}</h2></div><div class="d-scroll"><div class="f-empty">${esc(p.error)}</div></div>`;
    return;
  }
  const d = p.detail;
  const [status, cls] = mergeStatus(d);
  const open = d.state === 'open';
  const fork = d.head_repo && d.head_repo !== d.slug ? ` <small>(${esc(d.head_repo)})</small>` : '';
  const labels = d.labels.map((l) => `<span class="pr-label">${esc(l)}</span>`).join('');
  const acts = !open
    ? ''
    : `<div class="multi-acts pr-acts">
        <button class="mini" data-pr="approve">Approve</button>
        <button class="mini" data-pr="request_changes">Request changes…</button>
        <button class="mini" data-pr="comment">Comment…</button>
        <button class="mini primary-mini" data-pr="merge"${d.mergeable_state === 'dirty' || d.draft ? ' disabled' : ''}>Merge…</button>
        <button class="mini danger" data-pr="close">Close</button>
      </div>`;
  const tabs = detailTabs([['overview', 'Overview'], ['changes', `Changes (${d.changed_files})`], ['files', 'Files']]);
  $('#detail').innerHTML = `
    <div class="d-head">
      <div class="sha-line"><span>pull request <a data-url="${esc(d.url)}">#${d.number}</a></span><span>${esc(d.author)} · ${fmtIso(d.created_at)}</span></div>
      <h2>${esc(d.title)}</h2>
      <div class="pr-meta"><code>${esc(d.head_ref)}</code>${fork} → <code>${esc(d.base_ref)}</code> · ${d.commits} commit${d.commits === 1 ? '' : 's'} · <span class="add">+${d.additions}</span> <span class="del">−${d.deletions}</span>${labels}</div>
      <div class="pr-st ${cls}">${status}</div>
      ${checksHtml(d.checks)}
      ${acts}
      ${open && !d.authed ? '<div class="b-switch"><span>Add a GitHub token in Profiles to review, merge or close.</span></div>' : ''}
      <div class="multi-acts"><button class="mini" data-pr="checkout">Check out</button><button class="mini" data-pr="github">Open on GitHub</button><button class="mini" data-pr="reload">Refresh</button></div>
      ${tabs}
    </div>
    <div class="d-scroll" id="pr-body"></div>`;
  const body = $('#pr-body');
  if (S.dtab === 'overview') return (body.innerHTML = prOverviewHtml(d));
  body.innerHTML = '<div class="f-empty">Getting the pull request’s commits…</div>';
  let head;
  try {
    head = await prHead(d);
  } catch (e) {
    if (S.pr === p) body.innerHTML = `<div class="f-empty">${esc(e)}</div>`;
    return;
  }
  if (S.pr !== p || !body.isConnected) return;
  let res;
  try {
    res = await invoke('range_changes', { repo: S.repo, base: `${defaultRemote()}/${d.base_ref}`, head });
  } catch (e) {
    body.innerHTML = `<div class="f-empty">${esc(e)}</div>`;
    return;
  }
  if (S.pr !== p || !body.isConnected) return;
  S.range = { a: res.fork, b: head };
  if (S.dtab === 'files') return showTree(body, head, new Map(res.files.map((f) => [f.path, f.status])));
  body.innerHTML = `<div class="f-section-h">${res.files.length} changed file${res.files.length === 1 ? '' : 's'}</div>${fileRows(res.files, 'range') || '<div class="f-empty">No file changes</div>'}`;
  fileListDrawn();
}

function prOverviewHtml(d) {
  const desc = d.body?.trim() ? `<div class="pr-text">${esc(d.body.trim())}</div>` : '<div class="f-empty">No description.</div>';
  const requested = d.requested.length ? `<div class="f-section-h">Review requested from</div><div class="pr-text">${d.requested.map(esc).join(', ')}</div>` : '';
  const items = d.timeline
    .map((t) => {
      const [what, c] = t.kind === 'review' ? REVIEW_STATE[t.state] || [String(t.state).toLowerCase(), ''] : ['commented', ''];
      return `<div class="pr-event"><div class="pr-event-h"><b>${esc(t.author)}</b> <span class="pr-st ${c}">${what}</span> <small>${fmtIso(t.at)}</small></div>${t.body?.trim() ? `<div class="pr-text">${esc(t.body.trim())}</div>` : ''}</div>`;
    })
    .join('');
  return `<div class="f-section-h">Description</div>${desc}${requested}<div class="f-section-h">Reviews and comments (${d.timeline.length})</div>${items || '<div class="f-empty">None yet.</div>'}`;
}

// ------------------------------------------------------------------ actions

$('#detail').addEventListener('click', async (e) => {
  const link = e.target.closest('[data-url]');
  if (link && S.pr) return link.dataset.url && openUrl(link.dataset.url);
  const b = e.target.closest('[data-pr]');
  if (!b || !S.pr?.detail) return;
  const p = S.pr, d = p.detail;
  const act = b.dataset.pr;
  if (act === 'github') return openUrl(d.url);
  if (act === 'checkout') return checkoutPR(d.number);
  if (act === 'reload') {
    p.detail = p.error = null;
    return renderPR();
  }
  let body = '', method = '', del = false;
  if (act === 'approve') {
    const t = await askText(`Approve #${d.number}?`, { ok: 'Approve', hint: 'An optional comment goes with the approval.' });
    if (t === null) return;
    body = t;
  } else if (act === 'request_changes' || act === 'comment') {
    const t = await askText(act === 'comment' ? `Comment on #${d.number}` : `Request changes on #${d.number}`, {
      ok: act === 'comment' ? 'Comment' : 'Request changes',
      hint: act === 'comment' ? 'Posted to the pull request’s conversation.' : 'Tell the author what needs to change before this can merge.',
      required: true,
    });
    if (t === null) return;
    body = t;
  } else if (act === 'merge') {
    const m = await askMerge(d);
    if (!m) return;
    ({ title: body, method, del } = m);
  } else if (act === 'close') {
    if (!(await ask(`Close #${d.number} without merging?\n\nIts branch stays; it can be reopened on GitHub.`, { ok: 'Close pull request', danger: true }))) return;
  }
  let msg;
  try {
    msg = await busy(() => invoke('pr_action', { profileId: activeProfile().id, repo: S.repo, remote: defaultRemote(), number: d.number, action: act, body, method, deleteBranch: del }));
  } catch (err) {
    return toast(String(err), 'err');
  }
  toast(msg, 'ok');
  updatePRs(S.repo);
  if (S.pr === p) {
    p.detail = null;
    renderPR();
  }
});

/** A multi-line text prompt; resolves to the text (possibly empty) or null when cancelled. */
function askText(title, { ok = 'OK', hint = '', required = false, value = '' } = {}) {
  const dlg = $('#text-dlg'), area = $('#text-dlg-body'), okBtn = $('#text-dlg-ok');
  $('#text-dlg-title').textContent = title;
  $('#text-dlg-hint').textContent = hint;
  okBtn.textContent = ok;
  area.value = value;
  const sync = () => (okBtn.disabled = required && !area.value.trim());
  area.oninput = sync;
  area.onkeydown = (e) => e.key === 'Enter' && e.metaKey && !okBtn.disabled && dlg.close('ok');
  sync();
  dlg.returnValue = '';
  dlg.showModal();
  area.focus();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? area.value.trim() : null), { once: true }));
}

/** Merge method, commit title and branch deletion for merging `d`; null when cancelled. */
function askMerge(d) {
  const dlg = $('#merge-dlg'), sel = $('#mg-method'), title = $('#mg-title'), del = $('#mg-delete');
  const names = { merge: 'Create a merge commit', squash: 'Squash and merge', rebase: 'Rebase and merge' };
  const last = load('gg.mergeMethod', 'merge');
  sel.innerHTML = d.merge_methods.map((m) => `<option value="${m}"${m === last ? ' selected' : ''}>${names[m]}</option>`).join('');
  title.value = `${d.title} (#${d.number})`;
  const sameRepo = !d.head_repo || d.head_repo === d.slug;
  del.checked = sameRepo && d.delete_branch_on_merge;
  del.disabled = !sameRepo;
  $('#mg-delete-label').textContent = sameRepo ? `Delete ${d.head_ref} on GitHub afterwards` : 'The branch is in a fork and stays there';
  $('#mg-what').textContent = `${d.head_ref} → ${d.base_ref}`;
  const sync = () => ($('#mg-title-row').hidden = sel.value === 'rebase');
  sel.onchange = sync;
  sync();
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) =>
    dlg.addEventListener(
      'close',
      () => {
        if (dlg.returnValue !== 'ok') return resolve(null);
        save('gg.mergeMethod', sel.value);
        resolve({ method: sel.value, title: sel.value === 'rebase' ? '' : title.value.trim(), del: del.checked && !del.disabled });
      },
      { once: true },
    ),
  );
}
