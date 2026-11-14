# Gittygit — notes for working on this repo

## UI rules
- **No glyph arrows for carets or disclosure triangles** (▾ ▸ ▼ ► …). At the app's small sizes they
  render hairline-thin and get reported as "barely visible". Use `CHEVRON` (src/app.js) inside menu
  buttons, or the drawn CSS chevron (`.disclosure` class, or the `summary::before` / `.t-dir::before`
  pattern in styles.css) for expandable rows. `npm run check` enforces this and runs in CI.
- More generally: any icon smaller than ~12px is drawn (SVG or CSS borders), never a text character.
