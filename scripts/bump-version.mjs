// Usage: node scripts/bump-version.mjs 0.2.0
// Sets the app version in package.json (read by tauri.conf.json) and src-tauri/Cargo.toml.
import { readFileSync, writeFileSync } from 'node:fs';

const next = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(next ?? '')) {
  console.error('Usage: node scripts/bump-version.mjs <major.minor.patch>');
  process.exit(1);
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
if (!newer(next, pkg.version)) {
  console.error(`${next} is not newer than the current ${pkg.version}; installed apps would not update.`);
  process.exit(1);
}
pkg.version = next;
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8').replace(/^version = ".*"$/m, `version = "${next}"`);
writeFileSync('src-tauri/Cargo.toml', cargo);
console.log(`Version set to ${next}. Next:
  git commit -am "Release v${next}" && git tag v${next} && git push origin main v${next}`);
