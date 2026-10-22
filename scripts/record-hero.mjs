// Headless hero GIF: renders deterministic frames in Chrome, encodes with ffmpeg.
import { chromium } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
const FPS = Number(process.env.FPS || 12), SPEED = Number(process.env.SPEED || 2.2), port = 4792;
const srv = spawn('node', ['cli/agenttown.mjs', '--demo', '--no-open', '--port', String(port)]);
await new Promise(r => setTimeout(r, 800));
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const p = await b.newPage();
await p.goto(`http://127.0.0.1:${port}/?local=1`);
await p.waitForFunction(() => window.agenttown?.duration() > 0);
const d = await p.evaluate(() => window.agenttown.duration());
rmSync('/tmp/hero', { recursive: true, force: true }); mkdirSync('/tmp/hero');
const n = Math.ceil((d / SPEED) * FPS);
for (let i = 0; i <= n; i++) {
  const url = await p.evaluate(s => { window.agenttown.seek(s); return document.getElementById('view').toDataURL('image/png'); }, Math.min(d, (i / FPS) * SPEED));
  writeFileSync(`/tmp/hero/f${String(i).padStart(4, '0')}.png`, Buffer.from(url.split(',')[1], 'base64'));
}
// hold the last frame a moment
await b.close(); srv.kill();
mkdirSync('docs', { recursive: true });
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', '/tmp/hero/f%04d.png',
  '-vf', `scale=${process.env.W || 720}:-1:flags=neighbor,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`, 'docs/hero.gif']);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', '/tmp/hero/f%04d.png', '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '34', 'docs/hero.webm']);
console.log('frames', n + 1);
