'use strict';
// Settings window (Gittygit → Settings…, ⌘,) and Copy Diagnostics.

const stDlg = $('#settings-dlg');

function openSettings() {
  if (stDlg.open || !S.store) return;
  const st = S.store.settings;
  $('#st-fetch').value = String(st.auto_fetch_minutes);
  if (!$('#st-fetch').value) $('#st-fetch').value = '5';
  $('#st-pull').value = st.pull_mode;
  $('#st-words').checked = diffPrefs.words;
  $('#st-syntax').checked = diffPrefs.syntax;
  stDlg.dataset.resetPull = '';
  $('#st-reset-pull').textContent = `Clear per-repository choices (${Object.keys(st.repo_pull).length})`;
  stDlg.returnValue = '';
  stDlg.showModal();
}

$('#st-reset-pull').addEventListener('click', (e) => {
  e.preventDefault();
  stDlg.dataset.resetPull = '1';
  $('#st-reset-pull').textContent = 'Per-repository choices will be cleared';
});

stDlg.addEventListener('close', async () => {
  if (stDlg.returnValue !== 'ok') return;
  const mins = +$('#st-fetch').value;
  const mode = $('#st-pull').value;
  const reset = stDlg.dataset.resetPull === '1';
  // Diff display preferences are per Mac (localStorage), not part of the shared profile store.
  diffPrefs.words = $('#st-words').checked;
  diffPrefs.syntax = $('#st-syntax').checked;
  save('gg.diffWords', diffPrefs.words);
  save('gg.diffSyntax', diffPrefs.syntax);
  if (S.file && S.diffModel) showDiff(S.file, true);
  await mutateStore((st) => {
    st.settings.auto_fetch_minutes = mins;
    st.settings.pull_mode = mode;
    if (reset) st.settings.repo_pull = {};
  });
  renderFetchState();
});

async function copyDiagnostics() {
  const d = await invoke('diagnostics').catch((e) => ({ error: String(e) }));
  const text = [
    `Gittygit ${d.app || '?'} · macOS ${d.macos || '?'} · ${d.arch || '?'}`,
    `git: ${d.git || '?'} (${d.git_version || '?'})`,
    `profiles: ${d.profiles ?? '?'} · open tabs: ${activeProfile()?.tabs.length ?? 0}`,
    `background fetch: every ${S.store?.settings.auto_fetch_minutes || 0} min${AUTO.error ? ` · last error: ${AUTO.error.split('\n')[0]}` : ''}`,
    '',
    `Recent errors (${ERRORS.length}):`,
    ...(ERRORS.length ? ERRORS : ['(none)']),
  ].join('\n');
  await navigator.clipboard.writeText(text);
  toast('Diagnostics copied — paste them into your bug report', 'ok');
}

listen('menu-settings', openSettings);
listen('menu-diagnostics', copyDiagnostics);
// The menu's ⌘, accelerator handles this in the app; the key handler covers the dev browser.
document.addEventListener('keydown', (e) => {
  if (e.metaKey && e.key === ',') {
    e.preventDefault();
    openSettings();
  }
});
