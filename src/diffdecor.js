'use strict';
// Diff decoration: syntax colours (highlight.js, bundled in vendor/) and changed-word highlights.
// Both work per hunk and are cached on the parsed diff, so re-renders and the virtualized big-diff
// window only pay for them once.

const DIFF_LANGS = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', mts: 'typescript',
  json: 'json', css: 'css', scss: 'scss', less: 'less', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', plist: 'xml',
  md: 'markdown', py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', m: 'objectivec', mm: 'objectivec', php: 'php',
  sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', sql: 'sql', lua: 'lua',
  pl: 'perl', r: 'r', graphql: 'graphql', gql: 'graphql', mk: 'makefile', diff: 'diff', patch: 'diff',
};
const MAX_HL_LINES = 5000; // per hunk side; bigger hunks stay plain

function langFor(path) {
  const base = path.split('/').pop().toLowerCase();
  if (base === 'makefile') return 'makefile';
  if (base === 'dockerfile') return null;
  const lang = DIFF_LANGS[base.split('.').pop()];
  return lang && window.hljs?.getLanguage(lang) ? lang : null;
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'" };
const unescapeHtml = (s) => s.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (e) => ENTITIES[e]);

/** highlight.js HTML → per line, a list of [text, classes]; spans stay open across newlines. */
function htmlToLines(html) {
  const lines = [[]];
  const stack = [];
  const re = /<span class="([^"]+)">|<\/span>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) stack.push(m[1]);
    else if (m[2] === undefined) stack.pop();
    else {
      const parts = unescapeHtml(m[2]).split('\n');
      parts.forEach((t, i) => {
        if (i) lines.push([]);
        if (t) lines[lines.length - 1].push([t, stack.join(' ')]);
      });
    }
  }
  return lines;
}

/** Syntax segments for every line of a hunk (old side for "-", new side otherwise), or null. */
function hunkSyntax(h, lang) {
  if (h.syn !== undefined) return h.syn;
  h.syn = null;
  if (!lang || h.lines.length > MAX_HL_LINES * 2) return null;
  const sides = { old: [], new: [] };
  const at = [];
  for (const ln of h.lines) {
    const side = ln.k === '-' ? 'old' : 'new';
    if (ln.k === ' ') sides.old.push(ln.t);
    at.push(sides[side].length);
    sides[side].push(ln.t);
  }
  try {
    const hl = (lines) => htmlToLines(window.hljs.highlight(lines.join('\n'), { language: lang, ignoreIllegals: true }).value);
    const oldL = hl(sides.old), newL = hl(sides.new);
    h.syn = h.lines.map((ln, i) => (ln.k === '-' ? oldL : newL)[at[i]] || null);
  } catch {
    h.syn = null;
  }
  return h.syn;
}

/** Pairs each removed line with the added line at the same position in its block (li → li). */
function linePairs(h) {
  if (h.pairs) return h.pairs;
  const pairs = new Map();
  const L = h.lines;
  for (let i = 0; i < L.length; ) {
    if (L[i].k !== '-') {
      i++;
      continue;
    }
    const dels = [];
    while (i < L.length && L[i].k === '-') dels.push(i++);
    const adds = [];
    while (i < L.length && L[i].k === '+') adds.push(i++);
    for (let j = 0; j < Math.min(dels.length, adds.length); j++) {
      pairs.set(dels[j], adds[j]);
      pairs.set(adds[j], dels[j]);
    }
  }
  return (h.pairs = pairs);
}

/**
 * Character ranges that differ between two lines, from a longest-common-subsequence of word,
 * space and punctuation tokens. Null when the lines are too long or barely related (then the
 * whole-line colour says enough).
 */
function wordRanges(a, b) {
  const tok = (s) => s.match(/\w+|\s+|[^\w\s]/g) || [];
  const A = tok(a), B = tok(b);
  const n = A.length, m = B.length;
  if (!n || !m || n * m > 40000) return null;
  const dp = new Uint16Array((n + 1) * (m + 1));
  const W = m + 1;
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * W + j] = A[i] === B[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
  const keepA = new Uint8Array(n), keepB = new Uint8Array(m);
  let common = 0;
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (A[i] === B[j]) {
      keepA[i++] = keepB[j++] = 1;
      common += A[i - 1].length;
    } else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) i++;
    else j++;
  }
  if (common < 0.3 * Math.max(a.length, b.length)) return null;
  // Changed tokens become ranges; ranges separated only by spaces merge into one phrase.
  const ranges = (T, keep, str) => {
    const out = [];
    let pos = 0;
    T.forEach((t, i) => {
      if (!keep[i] && t.trim()) {
        const last = out[out.length - 1];
        if (last && !str.slice(last[1], pos).trim()) last[1] = pos + t.length;
        else out.push([pos, pos + t.length]);
      }
      pos += t.length;
    });
    return out;
  };
  return { a: ranges(A, keepA, a), b: ranges(B, keepB, b) };
}

/** Changed ranges for line `li` of a hunk (null if it has no partner or nothing to show). */
function lineWordRanges(h, li) {
  h.wd ??= new Map();
  if (h.wd.has(li)) return h.wd.get(li);
  const pi = linePairs(h).get(li);
  if (pi === undefined) return null;
  const del = h.lines[li].k === '-' ? li : pi;
  const add = del === li ? pi : li;
  const r = wordRanges(h.lines[del].t, h.lines[add].t);
  h.wd.set(del, r && r.a);
  h.wd.set(add, r && r.b);
  return h.wd.get(li);
}

/** HTML for a line's text with syntax classes and changed-word marks. */
function decorateLine(text, syn, ranges) {
  if (!syn && !ranges) return esc(text);
  // Fall back to plain text if the highlighter's segments don't add up to the line.
  const segs = syn && syn.reduce((n, s) => n + s[0].length, 0) === text.length ? syn : [[text, '']];
  const cuts = new Set([0, text.length]);
  for (const [s, e] of ranges || []) cuts.add(s).add(e);
  let out = '';
  let pos = 0;
  for (const [t, cls] of segs) {
    const bounds = [...cuts].filter((c) => c > pos && c < pos + t.length).sort((x, y) => x - y);
    let start = pos;
    for (const end of [...bounds, pos + t.length]) {
      const piece = text.slice(start, end);
      const changed = ranges?.some(([s, e]) => start >= s && start < e);
      const c = [cls, changed ? 'wd' : ''].filter(Boolean).join(' ');
      out += c ? `<span class="${c}">${esc(piece)}</span>` : esc(piece);
      start = end;
    }
    pos += t.length;
  }
  return out;
}
