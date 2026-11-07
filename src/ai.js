'use strict';
// Optional local AI (Ollama): drafts commit messages and pull request descriptions. Off until
// turned on in Settings; the changes are sent only to the Ollama address set there.

const AI = {
  cfg: { on: false, url: 'http://localhost:11434', model: '', ...load('gg.ai', {}) },
  ready: false, // enabled and the model is available
  running: false,
  onText: null,
};

listen('ai-text', (e) => AI.onText?.(e.payload));

/** Checks that Ollama answers and has the chosen model; shows or hides the AI buttons. */
async function aiCheck() {
  AI.ready = false;
  if (AI.cfg.on) {
    try {
      const models = await invoke('ai_models', { url: AI.cfg.url });
      if (!AI.cfg.model && models.length) AI.cfg.model = models[0];
      AI.ready = models.includes(AI.cfg.model);
    } catch {}
  }
  aiCommitButton();
}

/** About how long the model needs to read `text` (~4 characters a token, ~500 tokens/s). */
const readingTime = (text) => Math.max(2, Math.round(text.length / 4 / 500));

/** Runs a prompt; `onText` gets each piece. Returns the whole text, or null (stopped/failed). */
async function aiRun(prompt, onText) {
  AI.running = true;
  AI.onText = onText;
  aiCommitButton();
  try {
    return await invoke('ai_generate', { url: AI.cfg.url, model: AI.cfg.model, prompt });
  } catch (e) {
    if (String(e) !== 'stopped') {
      toast(String(e), 'err');
      aiCheck();
    }
    return null;
  } finally {
    AI.running = false;
    AI.onText = null;
    aiCommitButton();
  }
}

/** First line and the rest of a drafted message, without the quotes or fences models add. */
function splitDraft(text) {
  const lines = text.replace(/^\s*```\w*\n?/, '').replace(/\n?```\s*$/, '').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  const title = (lines.shift() || '').replace(/^\s*(#+\s*|(title|summary|subject):\s*)/i, '').replace(/^["'`]|["'`]$/g, '').trim();
  return { title, body: lines.join('\n').trim() };
}

// ------------------------------------------------------------------ commit messages

const commitPrompt = (ctx) => `${ctx}

Write the commit message for the staged changes above.
- First line: a summary of at most 72 characters, without a period at the end. Follow the style of the recent commit messages (for example a ticket prefix like "ABC-123: ", their tense and capitalisation).
- Then, only if it adds something, a blank line and a short body: why the change was made, or a few "- " bullets.
- Describe only what the diff shows. Don't mention file counts or that you were given a diff.
Reply with the commit message only, without quotes or code fences.`;

/** The commit box's "Write with AI" button: shown when AI is ready and something is staged. */
function aiCommitButton() {
  const btn = $('#c-ai');
  if (!btn) return;
  btn.hidden = !AI.ready || (!S.status?.staged.length && !AI.running);
  btn.textContent = AI.running ? 'Stop' : 'Write with AI';
  btn.title = AI.running ? 'Stop writing' : `Draft a message for the staged changes with ${AI.cfg.model} (on this Mac)`;
}

async function aiWriteCommit() {
  if (AI.running) return invoke('ai_stop');
  if ((draft.summary.trim() || draft.body.trim()) && !(await ask('Replace your commit message with a new draft?', { ok: 'Replace' }))) return;
  let ctx;
  try {
    ctx = await invoke('ai_commit_context', { repo: S.repo });
  } catch (e) {
    return toast(String(e), 'err');
  }
  const sum = $('#c-summary');
  sum.value = draft.summary = '';
  $('#c-body').value = draft.body = '';
  sum.placeholder = `Reading the staged changes (~${readingTime(ctx)} s)…`;
  let text = '';
  const fill = (t) => {
    const m = splitDraft(t);
    draft.summary = m.title;
    draft.body = m.body;
    // The fields may have been rebuilt (repository switch) while the model was writing.
    if ($('#c-summary')) {
      $('#c-summary').value = m.title;
      $('#c-body').value = m.body;
      updateCommitButton();
    }
  };
  const done = await aiRun(commitPrompt(ctx), (piece) => fill((text += piece)));
  if (done) fill(done);
  if ($('#c-summary')) $('#c-summary').placeholder = 'Commit summary';
  if (done) $('#c-summary')?.focus();
}

$('#detail').addEventListener('click', (e) => {
  if (e.target.closest('#c-ai')) aiWriteCommit();
});

// ------------------------------------------------------------------ pull requests

const prPrompt = (ctx) => `${ctx}

Write a GitHub pull request for the branch above.
- First line: the title, at most 72 characters. If the branch name or the commits start with a ticket id (like ABC-123), start the title with it the same way.
- Then a blank line and a Markdown description: one sentence on what the branch does and why, then "## Changes" with short bullets grouped by area, then "## Notes for reviewers" only if the changes show risks, migrations or follow-ups.
- Describe only what the commits and diff show. Don't invent tests, screenshots, ticket links or issue numbers.
Reply with the title line and the description only, without code fences.`;

const aiDlg = $('#ai-dlg');

/**
 * Drafts the pull request for `remoteRef` into `baseRef` in a dialog, then opens GitHub's
 * compare page with the title and description filled in.
 */
async function aiPullRequest({ compareUrl, remoteRef, baseRef }) {
  let ctx;
  try {
    ctx = await invoke('ai_pr_context', { repo: S.repo, branch: remoteRef, base: baseRef });
  } catch (e) {
    toast(String(e), 'err');
    return openUrl(compareUrl);
  }
  const title = $('#ai-pr-title'), body = $('#ai-pr-body'), status = $('#ai-status');
  title.value = body.value = '';
  status.textContent = `${AI.cfg.model} is reading ${remoteRef} → ${baseRef} (~${readingTime(ctx)} s)…`;
  aiDlg.returnValue = '';
  aiDlg.showModal();
  let text = '';
  const fill = (t) => {
    const m = splitDraft(t);
    title.value = m.title;
    body.value = m.body;
  };
  const run = aiRun(prPrompt(ctx), (piece) => {
    if (!text) status.textContent = `${AI.cfg.model} is writing…`;
    fill((text += piece));
  }).then((out) => {
    if (out && aiDlg.open) fill(out);
    if (aiDlg.open) status.textContent = out === null ? 'Stopped.' : `Drafted by ${AI.cfg.model} on this Mac. Read it through before opening.`;
  });
  const choice = await new Promise((resolve) => aiDlg.addEventListener('close', () => resolve(aiDlg.returnValue), { once: true }));
  if (AI.running) invoke('ai_stop');
  await run;
  const t = title.value.trim(), b = body.value.trim();
  if (choice === 'copy') {
    await navigator.clipboard.writeText(`${t}\n\n${b}`);
    return toast('Title and description copied', 'ok');
  }
  if (choice !== 'ok') return;
  const url = `${compareUrl}&title=${encodeURIComponent(t)}&body=${encodeURIComponent(b)}`;
  // Very long links get cut off by browsers or GitHub: copy the description instead.
  if (url.length > 7000) {
    await navigator.clipboard.writeText(b);
    toast('The description is long, so it was copied: paste it into GitHub', 'ok');
    return openUrl(`${compareUrl}&title=${encodeURIComponent(t)}`);
  }
  openUrl(url);
}

// ------------------------------------------------------------------ settings

async function aiFillSettings() {
  const { on, url, model } = AI.cfg;
  $('#st-ai').checked = on;
  $('#st-ai-url').value = url;
  await aiListModels(model);
}

async function aiListModels(selected = $('#st-ai-model').value) {
  const sel = $('#st-ai-model'), hint = $('#st-ai-hint');
  $('#st-ai-fields').hidden = !$('#st-ai').checked;
  if (!$('#st-ai').checked) return;
  try {
    const models = await invoke('ai_models', { url: $('#st-ai-url').value });
    sel.innerHTML = models.map((m) => `<option${m === selected ? ' selected' : ''}>${esc(m)}</option>`).join('');
    hint.textContent = models.length
      ? 'Your changes are sent only to this address. Larger models write better but read more slowly.'
      : 'Ollama has no models yet: run "ollama pull gemma4" in Terminal.';
  } catch (e) {
    sel.innerHTML = selected ? `<option selected>${esc(selected)}</option>` : '';
    hint.textContent = `${e}. Install it from ollama.com, or check the address.`;
  }
}

$('#st-ai').addEventListener('change', () => aiListModels());
$('#st-ai-url').addEventListener('change', () => aiListModels());

function aiSaveSettings() {
  AI.cfg = { on: $('#st-ai').checked, url: $('#st-ai-url').value.trim() || 'http://localhost:11434', model: $('#st-ai-model').value };
  save('gg.ai', AI.cfg);
  aiCheck();
}

aiCheck();
