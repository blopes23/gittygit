'use strict';
// GitHub pull requests: a sidebar section with open PRs and their CI status, PR badges on local
// branches, "Create pull request" (GitHub's compare page) and checking out a PR by number.
// Works without a token for public repositories; a per-profile token (Profiles) adds private ones.

const CHECK_TITLE = { success: 'Checks passed', failure: 'Checks failed', pending: 'Checks running' };

/** The default remote's open PRs; errors are kept so the section can explain them. */
async function updatePRs(repo) {
  if (S.prs.get(repo) === null) return; // already loading
  const remote = repo === S.repo ? defaultRemote() : null;
  if (!remote) return;
  S.prs.set(repo, null);
  try {
    S.prs.set(repo, await invoke('pull_requests', { profileId: activeProfile().id, repo, remote }));
  } catch (e) {
    const msg = String(e);
    // Not a GitHub remote: no section at all.
    S.prs.set(repo, /not a GitHub repository|no such remote/.test(msg) ? { none: true } : { error: msg });
  }
  if (repo === S.repo) renderSidebar();
}

const repoPRs = () => {
  const d = S.prs.get(S.repo);
  return d && d.prs ? d : null;
};

/** The open PR whose head is this local branch (same repository, not a fork). */
function prForBranch(branch) {
  const d = repoPRs();
  return d?.prs.find((p) => p.head_ref === branch && p.head_repo === d.slug) || null;
}

function prBadge(branch) {
  const pr = prForBranch(branch);
  if (!pr) return '';
  return `<span class="pr-badge${pr.checks ? ` chk-${pr.checks}` : ''}" title="Pull request #${pr.number}${pr.checks ? ` · ${CHECK_TITLE[pr.checks]}` : ''}">#${pr.number}</span>`;
}

function prSection(section, empty) {
  const d = S.prs.get(S.repo);
  if (d === undefined || d?.none) return '';
  if (d === null) return section('prs', 'Pull requests', '…', empty('Loading…'));
  if (d.error) return section('prs', 'Pull requests', '!', `<div class="sb-empty pr-err" title="${esc(d.error)}">${esc(d.error)}</div>`);
  const items = d.prs
    .map((p) => {
      const dot = p.checks ? `<span class="chk chk-${p.checks}" title="${CHECK_TITLE[p.checks]}"></span>` : '';
      const fork = p.head_repo && p.head_repo !== d.slug ? ' (fork)' : '';
      return `<div class="sb-item pr-item${p.draft ? ' draft' : ''}" data-kind="pr" data-name="${p.number}" data-sha="${p.head_sha}" title="#${p.number} ${esc(p.title)}\n${esc(p.author)} · ${esc(p.head_ref)}${fork} → ${esc(p.base_ref)}${p.draft ? '\nDraft' : ''}">
        <span class="pr-num">#${p.number}</span><span class="name">${esc(p.title)}</span>${dot}</div>`;
    })
    .join('');
  return section('prs', 'Pull requests', d.prs.length, items || empty('No open pull requests'));
}

const findPR = (number) => repoPRs()?.prs.find((p) => p.number === number);
const openUrl = (url) => invoke('reveal', { repo: S.repo, target: 'url', path: url }).catch((e) => toast(String(e), 'err'));

function prMenu(number) {
  const pr = findPR(number);
  if (!pr) return [];
  const local = pr.head_repo === repoPRs().slug && S.refs.branches.some((b) => b.name === pr.head_ref);
  return [
    ['Open on GitHub', () => openUrl(pr.url)],
    [local ? `Checkout ${pr.head_ref}` : `Check out locally as pr/${number}`, () => checkoutPR(number)],
    S.index.has(pr.head_sha) && currentBranch() && [`Compare with ${currentBranch().name}`, () => setCompare({ a: currentBranch().name, b: pr.head_sha, labelA: currentBranch().name, labelB: `#${number}` })],
    null,
    ['Copy link', () => navigator.clipboard.writeText(pr.url).then(() => toast('Link copied'))],
    ['Refresh pull requests', () => updatePRs(S.repo)],
  ];
}

/** Branch menu entry: open the branch's PR, or create one. */
function prMenuItem(br) {
  const d = repoPRs();
  if (!d) return null;
  const pr = prForBranch(br.name);
  if (pr) return [`Open pull request #${pr.number}`, () => openUrl(pr.url)];
  return ['Create pull request on GitHub…', () => createPR(br)];
}

/** Opens GitHub's compare page for the branch, pushing it first if it isn't published. */
async function createPR(br) {
  const d = repoPRs();
  if (!d) return toast("This repository isn't on GitHub (or GitHub couldn't be reached).", 'err');
  let branch = br;
  if (!branch.upstream) {
    if (!branch.current) return toast(`Push ${branch.name} first (check it out, then Push).`, 'err');
    if (!(await ask(`${branch.name} isn't on GitHub yet. Push it now?`, { ok: 'Push' }))) return;
    await ACTIONS.push();
    branch = S.refs.branches.find((b) => b.name === br.name);
    if (!branch?.upstream) return;
  }
  const remoteBranch = branch.upstream_ref.replace(/^refs\/heads\//, '');
  const base = await invoke('default_branch', { repo: S.repo, remote: branch.upstream_remote }).catch(() => 'main');
  if (remoteBranch === base) return toast(`${branch.name} is the default branch; create the pull request from a feature branch.`, 'err');
  openUrl(`https://github.com/${d.slug}/compare/${encodeURI(base)}...${encodeURI(remoteBranch)}?expand=1`);
}

/** Check out a PR: its branch if it's ours, else fetch pull/N/head into pr/N. */
async function checkoutPR(number) {
  if (!number) {
    const n = await ask('Check out which pull request?', { input: true, placeholder: '123', ok: 'Check out' });
    number = parseInt(String(n || '').replace(/^#/, ''), 10);
    if (!number) return;
  }
  const pr = findPR(number);
  const d = repoPRs();
  if (pr && d && pr.head_repo === d.slug) {
    const local = S.refs.branches.some((b) => b.name === pr.head_ref);
    return local ? checkoutLocal(pr.head_ref) : checkoutRemote(`${defaultRemote()}/${pr.head_ref}`);
  }
  const remote = defaultRemote();
  const branch = `pr/${number}`;
  if (currentBranch()?.name === branch) return git(['pull', '--ff-only', remote, `refs/pull/${number}/head`], `Updated ${branch}`);
  const out = await git(['fetch', remote, `+refs/pull/${number}/head:refs/heads/${branch}`]);
  if (out !== null) await git(['switch', branch], `Checked out pull request #${number} as ${branch}`);
}
