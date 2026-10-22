#!/usr/bin/env node
// AgentTown CLI: finds your latest AI coding session and replays it in your browser.
// Everything stays on your machine: the server binds to 127.0.0.1 only.
import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, resolve, dirname, basename } from 'node:path';
import { homedir, platform } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

if (flag('-h') || flag('--help')) {
  console.log(`agenttown: replay an AI coding agent session as a pixel-art town

usage:
  npx @barood-labs/agenttown                 replay your most recent Claude Code / Codex session
  npx @barood-labs/agenttown <file.jsonl>    replay a specific session file
  npx @barood-labs/agenttown --list          list recent sessions
  npx @barood-labs/agenttown --pick <n>      replay session #n from --list
  npx @barood-labs/agenttown --demo          replay the bundled demo session
options:
  --port <n>     port to serve on (default: random)
  --no-open      don't open the browser`);
  process.exit(0);
}

function walk(dir, out = [], depth = 0) {
  if (depth > 6 || !existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let s; try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) walk(p, out, depth + 1);
    else if (name.endsWith('.jsonl')) out.push({ path: p, mtime: s.mtimeMs, size: s.size });
  }
  return out;
}

function sessions() {
  const home = homedir();
  const claude = walk(join(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects')).map(s => ({ ...s, agent: 'Claude Code' }));
  const codex = walk(join(process.env.CODEX_HOME || join(home, '.codex'), 'sessions')).map(s => ({ ...s, agent: 'Codex' }));
  return [...claude, ...codex].filter(s => s.size > 200).sort((a, b) => b.mtime - a.mtime);
}

let file;
if (flag('--demo')) file = join(DIST, 'samples', 'claude-code-demo.jsonl');
else if (args[0] && !args[0].startsWith('-')) file = resolve(args[0]);
else {
  const all = sessions();
  if (flag('--list')) {
    all.slice(0, 20).forEach((s, i) => console.log(`${String(i + 1).padStart(2)}. ${new Date(s.mtime).toLocaleString()}  ${s.agent.padEnd(11)} ${basename(dirname(s.path))}/${basename(s.path)}`));
    if (!all.length) console.log('No sessions found in ~/.claude/projects or ~/.codex/sessions.');
    process.exit(0);
  }
  const pick = Number(opt('--pick') || 1);
  if (!all.length) { console.log('No Claude Code or Codex sessions found. Showing the demo session instead.'); file = join(DIST, 'samples', 'claude-code-demo.jsonl'); }
  else file = all[pick - 1]?.path;
}
if (!file || !existsSync(file)) { console.error(`Session not found: ${file}`); process.exit(1); }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.jsonl': 'application/x-ndjson', '.gif': 'image/gif', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__session') { res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' }); return res.end(readFileSync(file)); }
  let p = resolve(DIST, '.' + decodeURIComponent(url.pathname));
  if (!p.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
  if (!existsSync(p)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
  res.end(readFileSync(p));
});
server.listen(Number(opt('--port') || 0), '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}/?local=1`;
  console.log(`\n  🏙  AgentTown is replaying ${basename(file)}\n  → ${url}\n\n  (local only, nothing is uploaded. Ctrl+C to quit)\n`);
  if (!flag('--no-open')) {
    const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'cmd' : 'xdg-open';
    const a = platform() === 'win32' ? ['/c', 'start', '', url] : [url];
    try { spawn(cmd, a, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch {}
  }
});
