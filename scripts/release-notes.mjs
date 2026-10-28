// Turn commit messages into release notes (shown in the app's "What's new").
// Usage: git log --no-merges --format='%x1e%s%x1f%b' <range> | node scripts/release-notes.mjs
// Each commit becomes a bullet from its subject; "- " lines in its body become sub-bullets.
// Release bumps, CI-only and trailer lines are left out.
import { readFileSync } from 'node:fs';

const input = readFileSync(0, 'utf8');
const out = [];
for (const record of input.split('\x1e')) {
  const [subject = '', body = ''] = record.split('\x1f');
  const title = subject.trim();
  if (!title || /^(release v|ci:|chore:|merge )/i.test(title)) continue;
  out.push(`- ${title}`);
  let bullet = null;
  for (const raw of body.split('\n')) {
    const line = raw.trimEnd();
    if (/^\s*-\s+/.test(line)) {
      if (bullet) out.push(bullet);
      bullet = `  - ${line.replace(/^\s*-\s+/, '')}`;
    } else if (bullet && /^\s{2,}\S/.test(line)) {
      bullet += ` ${line.trim()}`; // wrapped continuation of a sub-bullet
    } else if (bullet) {
      out.push(bullet);
      bullet = null;
    }
  }
  if (bullet) out.push(bullet);
}
process.stdout.write(out.length ? out.join('\n') + '\n' : '- Maintenance release\n');
