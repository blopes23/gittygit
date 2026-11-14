'use strict';
// Pull requests (GitHub) and merge requests (GitLab): a sidebar section with the open ones and
// their CI status, badges on local branches, "Create pull request" (the host's page for a new one)
// and checking one out by number. Public repositories work without a token; a per-profile token
// (Profiles → Accounts) adds private ones and acting on them.

const CHECK_TITLE = { success: 'Checks passed', failure: 'Checks failed', pending: 'Checks running' };

/** How the repository's host names things: "pull request #12" or "merge request !12". */
function prWords(forge = repoPRs()?.forge) {
  return forge === 'gitlab'
    ? { one: 'merge request', One: 'Merge request', many: 'Merge requests', sign: '!', site: 'GitLab' }
    : { one: 'pull request', One: 'Pull request', many: 'Pull requests', sign: '#', site: 'GitHub' };
}

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
    S.prs.set(repo, /not a GitHub|no such remote/.test(msg) ? { none: true } : { error: msg });
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
  const w = prWords();
  return `<span class="pr-badge${pr.checks ? ` chk-${pr.checks}` : ''}" title="${w.One} ${w.sign}${pr.number}${pr.checks ? ` · ${CHECK_TITLE[pr.checks]}` : ''}">${w.sign}${pr.number}</span>`;
}

function prSection(section, empty) {
  const d = S.prs.get(S.repo);
  if (d === undefined || d?.none) return '';
  const w = prWords(d?.forge);
  if (d === null) return section('prs', 'Pull requests', '…', empty('Loading…'));
  if (d.error) return section('prs', 'Pull requests', '!', `<div class="sb-empty pr-err" title="${esc(d.error)}">${esc(d.error)}</div>`);
  const items = d.prs
    .map((p) => {
      const dot = p.checks ? `<span class="chk chk-${p.checks}" title="${CHECK_TITLE[p.checks]}"></span>` : '';
      const fork = p.head_repo && p.head_repo !== d.slug ? ' (fork)' : '';
      return `<div class="sb-item pr-item${p.draft ? ' draft' : ''}" data-kind="pr" data-name="${p.number}" data-sha="${p.head_sha}" title="${w.sign}${p.number} ${esc(p.title)}\n${esc(p.author)} · ${esc(p.head_ref)}${fork} → ${esc(p.base_ref)}${p.draft ? '\nDraft' : ''}">
        <span class="pr-num">${w.sign}${p.number}</span><span class="name">${esc(p.title)}</span>${dot}</div>`;
    })
    .join('');
  return section('prs', w.many, d.prs.length, items || empty(`No open ${w.one}s`));
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
    [`Refresh ${prWords().one}s`, () => updatePRs(S.repo)],
  ];
}

/** Branch menu entry: open the branch's PR, or create one. */
function prMenuItem(br) {
  const d = repoPRs();
  if (!d) return null;
  const pr = prForBranch(br.name);
  const w = prWords();
  if (pr) return [`Open ${w.one} ${w.sign}${pr.number}`, () => openUrl(pr.url)];
  return [`Create ${w.one} on ${w.site}…`, () => createPR(br)];
}

/** Opens GitHub's compare page for the branch, pushing it first if it isn't published. */
async function createPR(br) {
  const d = repoPRs();
  if (!d) return toast("This repository isn't on GitHub or GitLab (or the host couldn't be reached).", 'err');
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
  if (remoteBranch === base) return toast(`${branch.name} is the default branch; create the ${prWords().one} from a feature branch.`, 'err');
  const gitlab = d.forge === 'gitlab';
  const compareUrl = gitlab
    ? `https://${d.host}/${d.slug}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(remoteBranch)}&merge_request%5Btarget_branch%5D=${encodeURIComponent(base)}`
    : `https://github.com/${d.slug}/compare/${encodeURI(base)}...${encodeURI(remoteBranch)}?expand=1`;
  // The page's parameters for a prefilled title and description.
  const fields = gitlab ? { title: 'merge_request%5Btitle%5D', body: 'merge_request%5Bdescription%5D' } : { title: 'title', body: 'body' };
  if (AI.ready) return aiPullRequest({ compareUrl, fields, remoteRef: `${branch.upstream_remote}/${remoteBranch}`, baseRef: `${branch.upstream_remote}/${base}` });
  openUrl(compareUrl);
}

/** Check out a PR: its branch if it's ours, else fetch pull/N/head into pr/N. */
async function checkoutPR(number) {
  if (!number) {
    const n = await ask(`Check out which ${prWords().one}?`, { input: true, placeholder: '123', ok: 'Check out' });
    number = parseInt(String(n || '').replace(/^[#!]/, ''), 10);
    if (!number) return;
  }
  const pr = findPR(number);
  const d = repoPRs();
  if (pr && d && pr.head_repo === d.slug) {
    const local = S.refs.branches.some((b) => b.name === pr.head_ref);
    return local ? checkoutLocal(pr.head_ref) : checkoutRemote(`${defaultRemote()}/${pr.head_ref}`);
  }
  const remote = defaultRemote();
  const gitlab = d?.forge === 'gitlab';
  const w = prWords();
  const branch = `${gitlab ? 'mr' : 'pr'}/${number}`;
  const ref = gitlab ? `refs/merge-requests/${number}/head` : `refs/pull/${number}/head`;
  if (currentBranch()?.name === branch) return git(['pull', '--ff-only', remote, ref], `Updated ${branch}`);
  const out = await git(['fetch', remote, `+${ref}:refs/heads/${branch}`]);
  if (out !== null) await git(['switch', branch], `Checked out ${w.one} ${w.sign}${number} as ${branch}`);
}
