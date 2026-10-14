'use strict';
// In-app updates: quiet check shortly after launch and every 6 hours, plus
// "Gittygit → Check for Updates…" in the menu bar. Loaded after app.js.

const UPD = { info: null, installing: false, dismissed: null };

function renderUpdateBanner(state = 'available', pct = null) {
  const el = $('#update-banner');
  const info = UPD.info;
  if (!info) return (el.hidden = true);
  el.hidden = false;
  if (state === 'installing') {
    el.innerHTML = `<b>Updating to ${esc(info.version)}…</b>
      <div class="upd-bar"><span style="width:${pct ?? 0}%"></span></div>
      <small>${pct == null ? 'Starting download' : `${pct}%`} · Gittygit restarts when done</small>`;
    return;
  }
  el.innerHTML = `<b>Gittygit ${esc(info.version)} is available</b>
    <small>You have ${esc(info.current)}${info.date ? ` · released ${esc(info.date)}` : ''}</small>
    ${info.notes ? `<details><summary>What's new</summary><div class="upd-notes">${esc(info.notes)}</div></details>` : ''}
    <div class="upd-actions"><button class="ghost" data-upd="later">Later</button><button class="primary" data-upd="install">Restart &amp; update</button></div>`;
}

async function checkForUpdates({ manual = false } = {}) {
  if (UPD.installing) return;
  try {
    UPD.info = await invoke('check_update');
  } catch (e) {
    if (manual) toast(`Couldn't check for updates: ${e}`, 'err');
    return;
  }
  if (!UPD.info) {
    if (manual) toast("You're on the latest version.", 'ok');
    return renderUpdateBanner();
  }
  // A dismissed version stays quiet until the next manual check or a newer release.
  if (!manual && UPD.dismissed === UPD.info.version) return;
  renderUpdateBanner();
}

async function installUpdate() {
  if (UPD.installing) return;
  UPD.installing = true;
  renderUpdateBanner('installing');
  try {
    await invoke('install_update'); // relaunches the app on success
  } catch (e) {
    UPD.installing = false;
    toast(`Update failed: ${e}`, 'err');
    renderUpdateBanner();
  }
}

$('#update-banner').addEventListener('click', (e) => {
  const b = e.target.closest('[data-upd]');
  if (!b) return;
  if (b.dataset.upd === 'install') installUpdate();
  else {
    UPD.dismissed = UPD.info?.version;
    $('#update-banner').hidden = true;
  }
});

listen('update-progress', (ev) => {
  const { downloaded, total } = ev.payload;
  renderUpdateBanner('installing', total ? Math.min(100, Math.round((downloaded / total) * 100)) : null);
});
listen('menu-check-updates', () => checkForUpdates({ manual: true }));

setTimeout(checkForUpdates, 4000);
setInterval(checkForUpdates, 6 * 60 * 60 * 1000);
