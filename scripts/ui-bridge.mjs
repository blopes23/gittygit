// Dev bridge: serves the Gittygit frontend in a normal browser and forwards invoke() calls to
// the debug binary's `--rpc` mode, so the real Rust backend can be exercised without a webview.
// Usage: node scripts/ui-bridge.mjs <src dir> <debug binary> [initial repo] [port]
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
const [,, srcDir, bin, repo = null, port = '5178'] = process.argv;
const shim = `window.__TAURI__ = {
  core: { invoke: async (cmd, args = {}) => {
    if (cmd === 'initial_repo') return ${JSON.stringify(repo)};
    if (cmd === 'pick_repo' || cmd === 'pick_path') return window.__pick ?? null;
    if (['reveal', 'watch_repo', 'add_key_to_keychain'].includes(cmd)) return null;
    const r = await fetch('/__invoke', { method: 'POST', body: JSON.stringify({ cmd, args }) }).then(r => r.json());
    if ('err' in r) throw r.err; return r.ok; } },
  event: { listen: async () => () => {} } };`;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
http.createServer(async (req, res) => {
  if (req.url === '/__invoke') {
    let body = ''; for await (const c of req) body += c;
    const { cmd, args } = JSON.parse(body);
    execFile(bin, ['--rpc', cmd, JSON.stringify(args)], { maxBuffer: 1 << 28, env: { ...process.env, KL_CONFIG_DIR: process.env.KL_CONFIG_DIR || path.join(path.dirname(bin), 'kl-config') } }, (e, out) => {
      res.setHeader('content-type', 'application/json'); res.end(out || JSON.stringify({ err: String(e) }));
    });
    return;
  }
  if (req.url === '/__shim.js') { res.setHeader('content-type', 'text/javascript'); return res.end(shim); }
  const p = path.join(srcDir, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  try {
    let data = await readFile(p);
    if (p.endsWith('index.html')) data = data.toString().replace('<script src="app.js">', '<script src="/__shim.js"></script><script src="app.js">');
    res.setHeader('content-type', types[path.extname(p)] || 'application/octet-stream'); res.end(data);
  } catch { res.statusCode = 404; res.end(); }
}).listen(+port, '127.0.0.1', () => console.log('bridge on', port));
