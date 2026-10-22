import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
const port = 4791;
const srv = spawn('node', ['cli/agenttown.mjs', process.argv[2] || '--demo', '--no-open', '--port', String(port)], { stdio: 'pipe' });
await new Promise(r => setTimeout(r, 800));
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1000, height: 900 } });
const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => m.type() === 'error' && errs.push(m.text()));
await p.goto(`http://127.0.0.1:${port}/?local=1`);
await p.waitForFunction(() => window.agenttown?.duration() > 0);
const d = await p.evaluate(() => window.agenttown.duration());
console.log('duration', d, 'status', await p.textContent('#status'));
for (const f of (process.argv[3] || '0.3,0.55,0.75,0.97').split(',').map(Number)) {
  await p.evaluate(s => window.agenttown.seek(s), d * f);
  await p.locator('#view').screenshot({ path: `/tmp/at_${f}.png` });
}
console.log('errors', errs);
await b.close(); srv.kill();
