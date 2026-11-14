// Usage: npm run check
// UI rules that are easy to break without noticing. Fails (exit 1) listing file:line.
//
// - No tiny glyph arrows (▾ ▸ ▼ ► …) for carets or disclosure triangles: at the app's 9–12px
//   sizes they render hairline-thin and nearly invisible. Use CHEVRON (app.js) for menu
//   buttons, or the .disclosure / summary::before CSS chevrons for expandable rows.
//   Comments may mention them.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');
const GLYPHS = /[▾▴▸◂▼▲►◄⌄⌃]/;
const isComment = (line) => /^\s*(\/\/|\/\*|\*|<!--)/.test(line);

const problems = [];
for (const name of readdirSync(SRC)) {
  if (!/\.(js|html|css)$/.test(name)) continue;
  readFileSync(path.join(SRC, name), 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (GLYPHS.test(line) && !isComment(line)) problems.push(`src/${name}:${i + 1}: glyph arrow "${line.match(GLYPHS)[0]}" — use CHEVRON or a CSS chevron instead`);
    });
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('UI checks passed');
