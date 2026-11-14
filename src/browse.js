'use strict';
// The "Files" tab of a commit, branch or pull request: the whole project at that point as a
// folder tree (files changed there marked), a filter, and a read-only view of any file.

S.dtab = 'changes'; // detail tab: 'changes' | 'files' (| 'overview' for pull requests)
const TREE = {
  cache: new Map(), // rev → { root, paths }
  open: new Set(), // expanded folder paths; kept across revisions (same project)
  rev: null,
  changed: new Map(), // path → status in the current view
  q: '',
  onlyChanged: false,
};

/** Tab buttons for the detail header; `tabs` = [[key, label], …]. */
const detailTabs = (tabs) =>
  `<div class="d-tabs">${tabs.map(([k, label]) => `<button type="button" data-dtab="${k}" class="${S.dtab === k ? 'on' : ''}">${label}</button>`).join('')}</div>`;

$('#detail').addEventListener('click', (e) => {
  const t = e.target.closest('[data-dtab]');
  if (!t || S.dtab === t.dataset.dtab) return;
  S.dtab = t.dataset.dtab;
  closeDiff();
  renderDetail();
});

function buildTree(paths) {
  const root = { name: '', path: '', dirs: new Map(), files: [] };
  for (const p of paths) {
    const parts = p.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/');
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { name: parts[i], path, dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i]);
    }
    node.files.push(p);
  }
  return root;
}

/**
 * Fills `el` with the file tree of `rev`; `changed` maps paths to their status in this view
 * (marked in the tree, and the "Changed only" switch).
 */
async function showTree(el, rev, changed) {
  if (TREE.rev !== rev) TREE.q = ''; // a filter is about the files you were just looking at
  TREE.rev = rev;
  TREE.changed = changed;
  el.innerHTML = '<div class="f-empty">Loading files…</div>';
  let t = TREE.cache.get(rev);
  if (!t) {
    try {
      const paths = await invoke('tree_files', { repo: S.repo, rev });
      t = { paths, root: buildTree(paths) };
      if (TREE.cache.size > 20) TREE.cache.clear();
      TREE.cache.set(rev, t);
    } catch (e) {
      el.innerHTML = `<div class="f-empty">${esc(e)}</div>`;
      return;
    }
  }
  if (TREE.rev !== rev || !el.isConnected) return;
  el.innerHTML = `<div class="t-bar">
      <input type="search" id="t-filter" placeholder="Filter ${t.paths.length.toLocaleString()} files" spellcheck="false" autocomplete="off" value="${esc(TREE.q)}">
      ${changed.size ? `<label class="t-only"><input type="checkbox" id="t-only"${TREE.onlyChanged ? ' checked' : ''}> Changed only (${changed.size})</label>` : ''}
    </div><div id="t-list"></div>`;
  renderTreeList();
}

function renderTreeList() {
  const list = $('#t-list');
  const t = TREE.cache.get(TREE.rev);
  if (!list || !t) return;
  const q = TREE.q.trim().toLowerCase();
  const only = TREE.onlyChanged && TREE.changed.size;
  if (q || only) {
    // A flat list of matches (changed files that were deleted aren't in the tree).
    const pool = only ? [...TREE.changed.keys()] : t.paths;
    const files = pool.filter((p) => !q || p.toLowerCase().includes(q)).map((path) => ({ path, status: TREE.changed.get(path) || '' }));
    list.innerHTML = fileRows(files, 'tree') || '<div class="f-empty">No matching files</div>';
  } else {
    list.innerHTML = treeHtml(t.root, 0);
  }
  fileListDrawn();
}

/** Folders containing changed files (for their marker). */
function changedDirs() {
  const dirs = new Set();
  for (const p of TREE.changed.keys()) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return dirs;
}

function treeHtml(node, depth, dirs = changedDirs()) {
  let html = '';
  for (const d of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const open = TREE.open.has(d.path);
    html += `<div class="t-row t-dir${open ? ' open' : ''}" data-dir="${esc(d.path)}" style="--d:${depth}">${icon('folder')}<span class="t-name">${esc(d.name)}</span>${dirs.has(d.path) ? '<span class="t-dot" title="Has changes"></span>' : ''}</div>`;
    if (open) html += treeHtml(d, depth + 1, dirs);
  }
  for (const p of node.files.slice().sort((a, b) => a.localeCompare(b))) {
    const st = TREE.changed.get(p);
    html += `<div class="t-row t-file${S.file?.mode === 'view' && S.file.path === p ? ' sel' : ''}" data-path="${esc(p)}" style="--d:${depth}">${st ? `<span class="st st-${esc(st)}">${esc(st)}</span>` : '<span class="st"></span>'}<span class="t-name">${esc(p.slice(p.lastIndexOf('/') + 1))}</span></div>`;
  }
  return html;
}

$('#detail').addEventListener('input', (e) => {
  if (e.target.id !== 't-filter') return;
  TREE.q = e.target.value;
  renderTreeList();
});
$('#detail').addEventListener('change', (e) => {
  if (e.target.id !== 't-only') return;
  TREE.onlyChanged = e.target.checked;
  renderTreeList();
});
$('#detail').addEventListener('click', (e) => {
  const dir = e.target.closest('.t-dir');
  if (dir) {
    const p = dir.dataset.dir;
    TREE.open.has(p) ? TREE.open.delete(p) : TREE.open.add(p);
    return renderTreeList();
  }
  const row = e.target.closest('.t-file, .f-row[data-mode="tree"]');
  if (row) openTreeFile(row.dataset.path);
});

/** Opens a file of the tree; changed files get a button to their changes in this view. */
function openTreeFile(path) {
  const st = TREE.changed.get(path);
  let diff = null;
  if (st) {
    if (S.range && !S.compare) diff = { path, mode: 'range', sha: S.range.a, sha2: S.range.b };
    else if (S.selected && S.selected !== 'WIP') diff = { path, mode: 'commit', sha: S.selected };
  }
  openFileView({ mode: 'view', path, rev: TREE.rev, diff });
}

/** A file's contents at a revision, with line numbers and syntax colours. */
async function showFileAt(file) {
  S.file = file;
  let text;
  try {
    text = await invoke('file_at', { repo: S.repo, rev: file.rev, path: file.path });
  } catch (e) {
    if (S.file === file) showPane(file, file.path, '', `<div class="diff-empty">${esc(e)}</div>`);
    return;
  }
  if (S.file !== file) return;
  const lines = text.replace(/\n$/, '').split('\n');
  const max = Math.min(lines.length, 20000);
  const shown = lines.slice(0, max);
  const lang = langFor(file.path);
  let syn = null;
  if (lang && max <= 10000) {
    try {
      syn = htmlToLines(window.hljs.highlight(shown.join('\n'), { language: lang, ignoreIllegals: true }).value);
    } catch {}
  }
  let html = '';
  for (let i = 0; i < max; i++) html += `<div class="fl"><span class="n">${i + 1}</span><span class="t">${decorateLine(shown[i], syn?.[i] || null, null)}</span></div>`;
  if (lines.length > max) html += '<div class="diff-empty">Showing the first 20,000 lines.</div>';
  showPane(file, file.path, `<small>${lines.length.toLocaleString()} lines · at ${short(file.rev)}</small>`, text ? `<div class="fl-lines">${html}</div>` : '<div class="diff-empty">Empty file.</div>');
  document.querySelectorAll('#detail .t-file').forEach((r) => r.classList.toggle('sel', r.dataset.path === file.path));
}
