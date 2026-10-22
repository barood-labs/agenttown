#!/usr/bin/env node
// AgentTown CLI: finds your latest AI coding session and replays it in your browser.
// Everything stays on your machine: the server binds to 127.0.0.1 only.
import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { join, extname, resolve, dirname, basename } from 'node:path';
import { homedir, platform, tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const optVals = new Set(['--port', '--pick', '--gif'].map(opt).filter(Boolean));
const positional = args.find(a => !a.startsWith('-') && !optVals.has(a));

if (flag('-h') || flag('--help')) {
  console.log(`agenttown: replay an AI coding agent session as a pixel-art town

usage:
  npx @barood-labs/agenttown                 replay your most recent Claude Code / Codex session
  npx @barood-labs/agenttown <file.jsonl>    replay a specific session file
  npx @barood-labs/agenttown --watch         live mode: the town builds while your agent works
  npx @barood-labs/agenttown --gif out.gif   render a session to a GIF (headless Chrome if found)
  npx @barood-labs/agenttown --list          list recent sessions
  npx @barood-labs/agenttown --pick <n>      replay session #n from --list
  npx @barood-labs/agenttown --demo          replay the bundled demo session
options:
  --port <n>     port to serve on (default: random)
  --no-open      don't open the browser`);
  process.exit(0);
}

function walk(dir, out = [], depth = 0) {
  if (!dir || depth > 6 || !existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'subagents') continue;              // Claude Code sidechain transcripts
    const p = join(dir, name);
    let s; try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) walk(p, out, depth + 1);
    else if (name.endsWith('.jsonl') && !name.startsWith('agent-')) out.push({ path: p, mtime: s.mtimeMs, size: s.size });
  }
  return out;
}

function sessions() {
  const home = homedir();
  const claude = walk(join(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects')).map(s => ({ ...s, agent: 'Claude Code' }));
  const codex = walk(join(process.env.CODEX_HOME || join(home, '.codex'), 'sessions')).map(s => ({ ...s, agent: 'Codex' }));
  return [...claude, ...codex].filter(s => s.size > 200).sort((a, b) => b.mtime - a.mtime);
}

const WATCH = flag('--watch') || flag('-w');
const GIF = opt('--gif');
const DEMO = join(DIST, 'samples', 'claude-code-demo.jsonl');
let file, followLatest = false;
if (flag('--demo')) file = DEMO;
else if (positional) file = resolve(positional);
else {
  const all = sessions();
  if (flag('--list')) {
    all.slice(0, 20).forEach((s, i) => console.log(`${String(i + 1).padStart(2)}. ${new Date(s.mtime).toLocaleString()}  ${s.agent.padEnd(11)} ${basename(dirname(s.path))}/${basename(s.path)}`));
    if (!all.length) console.log('No sessions found in ~/.claude/projects or ~/.codex/sessions.');
    process.exit(0);
  }
  const pick = Number(opt('--pick') || 1);
  followLatest = WATCH && !opt('--pick');
  if (!all.length) {
    if (WATCH) { console.log('No sessions yet. Waiting for Claude Code / Codex to start one…'); file = undefined; }
    else { console.log('No Claude Code or Codex sessions found. Showing the demo session instead.'); file = DEMO; }
  } else file = all[pick - 1]?.path;
}
if (!(WATCH && followLatest) && (!file || !existsSync(file))) { console.error(`Session not found: ${file}`); process.exit(1); }

// ---- live mode: tail the file and push appended bytes over SSE ----
const clients = new Set();
let size = 0;
function send(res, ev, data) { res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); }
function readAll() { return file && existsSync(file) ? readFileSync(file, 'utf8') : ''; }
function poll() {
  if (followLatest) {
    const latest = sessions()[0]?.path;
    if (latest && latest !== file) {
      file = latest; size = statSync(file).size;
      console.log(`  ↻ following ${basename(file)}`);
      const text = readAll(); for (const c of clients) send(c, 'reset', { name: basename(file), text });
      return;
    }
  }
  if (!file || !existsSync(file)) return;
  const s = statSync(file).size;
  if (s < size) { size = s; const text = readAll(); for (const c of clients) send(c, 'reset', { name: basename(file), text }); }
  else if (s > size) {
    const fd = openSync(file, 'r'); const buf = Buffer.alloc(s - size); readSync(fd, buf, 0, buf.length, size); closeSync(fd);
    size = s; const text = buf.toString('utf8');
    for (const c of clients) send(c, 'append', { text });
  }
}

let gifDone;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.jsonl': 'application/x-ndjson', '.gif': 'image/gif', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__session') { res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' }); return res.end(readAll()); }
  if (url.pathname === '/__events' && WATCH) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    const text = readAll(); size = Buffer.byteLength(text);
    send(res, 'reset', { name: file ? basename(file) : '', text });
    clients.add(res);
    const ka = setInterval(() => res.write(': ka\n\n'), 15000);
    req.on('close', () => { clients.delete(res); clearInterval(ka); });
    return;
  }
  if (url.pathname === '/__gif' && GIF && req.method === 'POST') {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => { writeFileSync(resolve(GIF), Buffer.concat(chunks)); res.writeHead(200); res.end('ok'); gifDone?.(); });
    return;
  }
  let p = resolve(DIST, '.' + decodeURIComponent(url.pathname));
  if (!p.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
  if (!existsSync(p)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
  res.end(readFileSync(p));
});

function openBrowser(url) {
  const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'cmd' : 'xdg-open';
  const a = platform() === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, a, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch {}
}

function findChrome() {
  const c = [process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'];
  return c.find(p => p && existsSync(p));
}

server.listen(Number(opt('--port') || 0), '127.0.0.1', () => {
  const base = `http://127.0.0.1:${server.address().port}/?local=1`;
  if (GIF) {
    const url = `${base}&export=gif`;
    const chrome = findChrome();
    let child;
    if (chrome) {
      child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--mute-audio',
        `--user-data-dir=${join(tmpdir(), 'agenttown-chrome-' + process.pid)}`, ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), url], { stdio: 'ignore' });
      console.log(`\n  🎞  Rendering ${basename(file)} to ${GIF} with headless Chrome…`);
    } else {
      console.log(`\n  🎞  No Chrome found, opening your browser to render the GIF (keep the tab open)…\n  → ${url}`);
      openBrowser(url);
    }
    const timer = setTimeout(() => { console.error('  ✘ GIF export timed out'); child?.kill(); process.exit(1); }, Number(process.env.AGENTTOWN_GIF_TIMEOUT || 600000));
    gifDone = () => { clearTimeout(timer); child?.kill(); console.log(`  ✔ wrote ${resolve(GIF)}`); setTimeout(() => process.exit(0), 100); };
    return;
  }
  const url = WATCH ? `${base}&live=1` : base;
  if (WATCH) { setInterval(poll, 400); console.log(`\n  🏙  AgentTown is live-watching ${file ? basename(file) : '(waiting for a session)'}\n  → ${url}\n\n  (local only, nothing is uploaded. Ctrl+C to quit)\n`); }
  else console.log(`\n  🏙  AgentTown is replaying ${basename(file)}\n  → ${url}\n\n  (local only, nothing is uploaded. Ctrl+C to quit)\n`);
  if (!flag('--no-open')) openBrowser(url);
});
