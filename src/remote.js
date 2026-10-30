'use strict';
// Working with remotes: pull strategies, background fetch, remote tags, renaming/tracking
// branches and fixing HTTPS sign-in. Loaded after app.js and profiles.js (shares their globals).

// ------------------------------------------------------------------ pull

const PULL_MODES = { ask: 'Ask when branches diverge', merge: 'Merge', rebase: 'Rebase', 'ff-only': 'Fast-forward only' };
const PULL_FLAGS = { ask: ['--ff-only'], merge: ['--no-rebase', '--ff'], rebase: ['--rebase'], 'ff-only': ['--ff-only'] };
const DIVERGED = /Not possible to fast-forward|divergent branches/i;

const pullMode = () => S.store.settings.repo_pull[S.repo] || S.store.settings.pull_mode || 'ask';

async function setPullMode(mode) {
  const repo = S.repo;
  await mutateStore((st) => {
    st.settings.repo_pull[repo] = mode;
  });
}

/**
 * Pull the current branch with an explicit strategy, so git's own pull.* config can't leave
 * it stuck. In "ask" mode a fast-forward is tried first; if the branches diverged, the user
 * picks Merge or Rebase once and that's remembered for the repository.
 */
async function pull(mode = pullMode()) {
  const b = currentBranch();
  if (!b) return toast('Not on a branch', 'err');
  if (!b.upstream) return toast(`${b.name} doesn't track a remote branch. Right-click it → Track remote branch…`, 'err');
  let diverged = false;
  const out = await moveHead(
    async () => {
      try {
        return await gitRaw(['pull', ...PULL_FLAGS[mode]]);
      } catch (e) {
        if ((mode === 'ask' || mode === 'ff-only') && DIVERGED.test(String(e))) {
          diverged = true;
          return '';
        }
        throw e;
      }
    },
    (moved) => (moved ? `Pulled ${b.upstream} into ${b.name}` : diverged ? null : `${b.name} is already up to date`),
  );
  if (out === null) return;
  fetchSucceeded(S.repo);
  if (!diverged) return;
  if (mode === 'ff-only')
    return toast(`Can't fast-forward ${b.name}: it and ${b.upstream} both have new commits. Use Pull ▾ → Merge or Rebase.`, 'err');
  const choice = await ask(
    `${b.name} and ${b.upstream} both have new commits.\n\nRebase replays your commits on top of ${b.upstream} (linear history). Merge joins them with a merge commit.\n\nYour choice is remembered for this repository; change it any time from Pull ▾.`,
    { ok: 'Rebase', alt: 'Merge' },
  );
  if (!choice) return;
  const chosen = choice === 'alt' ? 'merge' : 'rebase';
  await setPullMode(chosen);
  return pull(chosen);
}

function pullMenu(e) {
  const cur = pullMode();
  const mark = (m) => (m === cur ? '✓ ' : '    ');
  showMenu(e, [
    ['Pull with merge', () => pull('merge')],
    ['Pull with rebase', () => pull('rebase')],
    ['Pull (fast-forward only)', () => pull('ff-only')],
    null,
    ['This repository pulls with', null, 'label'],
    ...Object.entries(PULL_MODES).map(([m, label]) => [mark(m) + label, () => setPullMode(m).then(() => toast(`Pull: ${label}`))]),
  ]);
}

// ------------------------------------------------------------------ background fetch

// The active repository is fetched every N minutes (Settings), and when the app regains focus
// after a minute. Failures don't toast: the Fetch button gets a warning dot with the error,
// and retries back off (2×, 4×… the interval, up to 16×).
const AUTO = { fails: 0, error: null, last: new Map() };

async function autoFetch(minAge) {
  const mins = S.store?.settings.auto_fetch_minutes || 0;
  if (!mins || !S.repo || S.busy || S.fetching || S.op?.kind || document.hidden || !S.refs?.remote_names.length) return;
  const repo = S.repo;
  const wait = minAge ?? mins * 60_000 * 2 ** Math.min(AUTO.fails, 4);
  if (Date.now() - (AUTO.last.get(repo) || 0) < wait) return;
  AUTO.last.set(repo, Date.now());
  const profileId = activeProfile().id;
  S.fetching = (async () => {
    try {
      await invoke('git_run', { profileId, repo, args: ['fetch', '--all', '--prune', '--quiet'] });
      AUTO.fails = 0;
      AUTO.error = null;
      updateRemoteTags(repo);
    } catch (e) {
      AUTO.fails++;
      AUTO.error = explainGitError(String(e));
      recordError(`background fetch: ${e}`);
    }
  })();
  try {
    await S.fetching;
  } finally {
    S.fetching = null;
    renderFetchState();
    if (repo === S.repo) scheduleRefresh();
  }
}
setInterval(() => autoFetch(), 20_000);

/** A manual fetch/pull worked: reset the background schedule and its error. */
function fetchSucceeded(repo) {
  AUTO.last.set(repo, Date.now());
  AUTO.fails = 0;
  AUTO.error = null;
  renderFetchState();
  updateRemoteTags(repo);
}

function renderFetchState() {
  const btn = $('[data-act="fetch"]');
  const mins = S.store?.settings.auto_fetch_minutes || 0;
  btn.classList.toggle('warn', !!AUTO.error);
  btn.title = AUTO.error
    ? `Background fetch failed (retrying less often):\n${AUTO.error}`
    : mins ? `Fetch all (also automatic every ${mins} min)` : 'Fetch all';
}

// ------------------------------------------------------------------ remote tags

/** Which tags exist on the default remote, so local-only ones can be marked. */
async function updateRemoteTags(repo) {
  if (S.remoteTags.get(repo) === null) return; // already loading
  const remote = repo === S.repo ? defaultRemote() : null;
  if (!remote) return;
  S.remoteTags.set(repo, null);
  try {
    const tags = await invoke('remote_tags', { profileId: activeProfile().id, repo, remote });
    S.remoteTags.set(repo, new Set(tags));
  } catch {
    S.remoteTags.delete(repo); // offline or no access: show no markers
  }
  if (repo === S.repo) renderSidebar();
}

/** Push some tags (or all of them, with `names` null). */
async function pushTags(remote, names) {
  if (!(await confirmRemoteForProfile('Push'))) return;
  const args = names ? ['push', remote, ...names.map((n) => `refs/tags/${n}`)] : ['push', remote, '--tags'];
  const what = names ? names.join(', ') : 'all tags';
  if ((await git(args, `Pushed ${what} to ${remote}`)) !== null) updateRemoteTags(S.repo);
}

async function deleteRemoteTag(name, remote) {
  if (!(await ask(`Delete tag ${name} on ${remote}?\n\nOthers who fetched it keep their copy.`, { ok: 'Delete', danger: true }))) return;
  const obj = await revParse(`refs/tags/${name}`).catch(() => null);
  const out = await git(['push', remote, '--delete', `refs/tags/${name}`]);
  if (out === null) return;
  updateRemoteTags(S.repo);
  if (obj) offerUndo(`Deleted tag ${name} on ${remote}`, () => gitRaw(['push', remote, `${obj}:refs/tags/${name}`]));
  else toast(`Deleted tag ${name} on ${remote}`, 'ok');
}

// ------------------------------------------------------------------ rename / track

async function renameBranch(br) {
  const name = await ask(`Rename ${br.name} to`, { input: true, value: br.name, ok: 'Rename' });
  if (!name || name === br.name) return;
  const remote = br.upstream_remote;
  // Offer the remote rename only when the upstream is the same-named branch.
  const published = br.upstream && br.upstream_ref === `refs/heads/${br.name}`;
  let onRemote = false;
  if (published) {
    const c = await ask(
      `${br.name} is published as ${br.upstream}. Rename it on ${remote} too?\n\nThat pushes ${name}, deletes ${br.name} on ${remote} and tracks the new name. Anyone else using ${br.upstream} will need to switch.`,
      { ok: `Rename on ${remote} too`, alt: 'Only locally' },
    );
    if (!c) return;
    onRemote = c === true;
    if (onRemote && !(await confirmRemoteForProfile('Rename on remote'))) return;
  }
  const move = async (from, to) => {
    await gitRaw(['branch', '-m', from, to]);
    if (!onRemote) return;
    await gitRaw(['push', remote, `refs/heads/${to}:refs/heads/${to}`]);
    await gitRaw(['branch', '--set-upstream-to', `${remote}/${to}`, to]);
    await gitRaw(['push', remote, '--delete', from]);
  };
  await busy(async () => {
    try {
      await move(br.name, name);
      offerUndo(`Renamed ${br.name} → ${name}${onRemote ? ` (also on ${remote})` : ''}`, () => move(name, br.name));
    } catch (e) {
      toast(explainGitError(String(e)), 'err');
    }
    await refresh();
  });
}

async function trackBranch(br) {
  const options = S.refs.remotes.map((r) => r.name);
  const guess = br.upstream || options.find((n) => n.endsWith(`/${br.name}`)) || '';
  const target = await ask(`Which remote branch should ${br.name} track?`, { input: true, value: guess, list: options, placeholder: 'origin/branch', ok: 'Track' });
  if (!target) return;
  if (!options.includes(target)) return toast(`${target} doesn't exist. Fetch first, or push ${br.name} to create it.`, 'err');
  await git(['branch', '--set-upstream-to', target, br.name], `${br.name} now tracks ${target}`);
}

// ------------------------------------------------------------------ HTTPS sign-in

/** Offered on HTTPS sign-in failures: switch the remote to SSH (preferred) or store a token. */
async function fixHttps(host) {
  if (!S.repo) return;
  const remotes = await invoke('get_remotes', { repo: S.repo }).catch(() => []);
  const r = remotes.find((x) => x.url.startsWith('https://') && x.url.includes(host)) || remotes.find((x) => x.url.startsWith('https://'));
  if (!r) return toast("This repository's remotes don't use HTTPS.");
  const c = await ask(
    `${r.name} uses HTTPS (${r.url}), and git needs a sign-in Gittygit can't prompt for.\n\n` +
      (r.ssh_url ? `Recommended: switch it to SSH (${r.ssh_url}) so it uses this profile's SSH key.\n\n` : '') +
      'Or save an access token in git\'s credential store (macOS Keychain).',
    r.ssh_url ? { ok: 'Switch to SSH', alt: 'Use a token…' } : { ok: 'Use a token…' },
  );
  if (!c) return;
  if (c === true && r.ssh_url) {
    try {
      await invoke('set_remote_url', { profileId: activeProfile().id, repo: S.repo, name: r.name, url: r.ssh_url });
      toast(`${r.name} now uses ${r.ssh_url}. If fetching fails, check the profile's key has access (Profiles → Test connection).`, 'ok');
    } catch (e) {
      toast(String(e), 'err');
    }
    return;
  }
  openTokenDialog(r, new URL(r.url).host);
}

function openTokenDialog(remote, host) {
  const dlg = $('#token-dlg');
  const url = new URL(remote.url);
  $('#tk-host').textContent = host;
  $('#tk-user').value = decodeURIComponent(url.username);
  $('#tk-user').placeholder = 'your username on ' + host;
  $('#tk-token').value = '';
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener(
    'close',
    async () => {
      const username = $('#tk-user').value.trim();
      const token = $('#tk-token').value;
      $('#tk-token').value = ''; // don't leave it in the DOM
      if (dlg.returnValue !== 'ok' || !username || !token) return;
      try {
        await invoke('store_https_credential', { profileId: activeProfile().id, repo: S.repo, host, username, token });
        // Put the username in the URL so git looks up this account's token, not another one's.
        if (!url.username) {
          url.username = username;
          await invoke('set_remote_url', { profileId: activeProfile().id, repo: S.repo, name: remote.name, url: url.toString() });
        }
        toast(`Token saved for ${username}@${host}. Try again.`, 'ok');
      } catch (e) {
        toast(String(e), 'err');
      }
    },
    { once: true },
  );
}
