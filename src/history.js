'use strict';

// File history and blame, shown in the diff pane. Clicking a commit opens that commit's
// change to the file, with "← Back" returning here.

const UNCOMMITTED = /^0+$/;

/** Select a commit in the graph without closing the open file view. */
function highlightCommit(sha) {
  if (!S.index.has(sha)) return;
  S.selected = sha;
  ensureVisible(S.index.get(sha));
  renderRows();
  renderDetail();
}

function openCommitFile(sha, path, back) {
  highlightCommit(sha);
  showDiff({ path, mode: 'commit', sha, back });
}

async function showHistory(file) {
  S.file = file;
  let list;
  try {
    list = await invoke('file_history', { repo: S.repo, path: file.path });
  } catch (e) {
    S.file = file.back || null;
    return toast(String(e), 'err');
  }
  if (S.file !== file) return;
  file.list = list;
  const rows = list
    .map((h, i) => {
      const renamed = h.path !== file.path ? `<small class="hi-path">as ${esc(h.path)}</small>` : '';
      return `<div class="hi-row" data-i="${i}">
        ${avatar(h.author, h.email)}
        <div class="hi-main"><div class="hi-subj">${esc(h.subject)}</div>
          <small>${esc(h.author)} · <span title="${fmtFull(h.time)}">${fmtDate(h.time)}</span>${renamed}</small></div>
        <span class="st st-${esc(h.status || 'M')}">${esc(h.status || '·')}</span>
        <code>${short(h.sha)}</code></div>`;
    })
    .join('');
  const n = list.length;
  showPane(file, file.path, `<small>history · ${n}${n === 1000 ? '+' : ''} commit${n === 1 ? '' : 's'}</small>`,
    rows || '<div class="diff-empty">No commits touch this file.</div>');
}

async function showBlame(file) {
  S.file = file;
  let b;
  try {
    b = await invoke('blame', { repo: S.repo, path: file.path, rev: file.rev || null });
  } catch (e) {
    S.file = file.back || null;
    return toast(String(e), 'err');
  }
  if (S.file !== file) return;
  file.blame = b;
  let html = '';
  const max = Math.min(b.text.length, 20000);
  for (let i = 0; i < max; i++) {
    const ci = b.owner[i];
    const c = b.commits[ci];
    const first = i === 0 || b.owner[i - 1] !== ci;
    const local = UNCOMMITTED.test(c.sha);
    const meta = !first
      ? ''
      : local
        ? '<span class="bm-sha">uncommitted</span>'
        : `<span class="bm-sha">${short(c.sha)}</span> <b>${esc(c.author)}</b> <span class="bm-date" title="${fmtFull(c.time)}">${fmtDate(c.time)}</span> <span class="bm-sum">${esc(c.summary)}</span>`;
    const hue = local ? 0 : hashHue(c.sha);
    html += `<div class="bl${first ? ' first' : ''}${local ? ' local' : ''}" data-c="${ci}" style="--hue:${hue}"><span class="bm" title="${local ? '' : esc(c.summary)}">${meta}</span><span class="n">${i + 1}</span><span class="t">${esc(b.text[i])}</span></div>`;
  }
  if (b.text.length > max) html += '<div class="diff-empty">Blame truncated (over 20,000 lines).</div>';
  const at = file.rev ? `at ${short(file.rev)}` : 'working tree';
  showPane(file, file.path, `<small>blame · ${at} · ${b.commits.filter((c) => !UNCOMMITTED.test(c.sha)).length} commits</small>`,
    html ? `<div class="bl-lines">${html}</div>` : '<div class="diff-empty">Empty file.</div>');
}

$('#diff-body').addEventListener('click', (e) => {
  const f = S.file;
  if (!f) return;
  const hi = e.target.closest('.hi-row');
  if (hi && f.mode === 'history') {
    const h = f.list[+hi.dataset.i];
    return openCommitFile(h.sha, h.path, f);
  }
  const bm = e.target.closest('.bl .bm');
  if (bm && f.mode === 'blame') {
    const c = f.blame.commits[+bm.parentElement.dataset.c];
    if (!UNCOMMITTED.test(c.sha)) openCommitFile(c.sha, f.path, f);
  }
});
