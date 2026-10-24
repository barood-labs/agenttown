import { parseSession, type Session } from './parser';
import { buildModel, renderFrame, hitTest, LOW_W, LOW_H, type Model } from './town';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';

const view = document.getElementById('view') as HTMLCanvasElement;
const ctx = view.getContext('2d')!;
const low = document.createElement('canvas'); low.width = LOW_W; low.height = LOW_H;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const playBtn = $<HTMLButtonElement>('play'), scrub = $<HTMLInputElement>('scrub'), timeEl = $('time');
const speedSel = $<HTMLSelectElement>('speed'), status = $('status');

let model: Model | null = null;
let t = 0, playing = false, last = 0, liveMode = false;

function load(text: string, name: string, live = false) {
  try {
    const s: Session = parseSession(text);
    const prev = model;
    const following = !prev || t >= prev.duration - 0.05 || playing;
    model = buildModel(s);
    if (!live || !prev) t = 0;
    status.textContent = `${live ? '● LIVE  ' : ''}${name}: ${s.events.length} events, ${s.files.length} files`;
    draw(); if (!live || following) setPlaying(true);
    return true;
  } catch (e: any) { status.textContent = live ? `● LIVE  waiting for events… (${e.message})` : '⚠ ' + e.message; return false; }
}

function draw() {
  if (!model) return;
  renderFrame(ctx, low, model, t);
  scrub.value = String(Math.round((t / model.duration) * 1000));
  timeEl.textContent = `${t.toFixed(1)}s / ${model.duration.toFixed(1)}s`;
}

function setPlaying(p: boolean) { playing = p; playBtn.textContent = p ? '❚❚' : '▶'; last = performance.now(); }

function tick(now: number) {
  if (playing && model) {
    t += ((now - last) / 1000) * Number(speedSel.value);
    if (t >= model.duration) { t = model.duration; if (!liveMode) setPlaying(false); }
    draw();
  }
  last = now;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

playBtn.onclick = () => { if (model && t >= model.duration) t = 0; setPlaying(!playing); };
scrub.oninput = () => { if (!model) return; t = (Number(scrub.value) / 1000) * model.duration; draw(); };
document.addEventListener('keydown', e => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (e.code === 'Space') { e.preventDefault(); playBtn.click(); return; }
  if (!model) return;
  if (e.code === 'ArrowRight' || e.code === 'KeyL') { e.preventDefault(); t = Math.min(model.duration, t + 0.5 * Number(speedSel.value)); draw(); }
  else if (e.code === 'ArrowLeft' || e.code === 'KeyJ') { e.preventDefault(); t = Math.max(0, t - 0.5 * Number(speedSel.value)); draw(); }
  else if (e.code === 'Home') { e.preventDefault(); t = 0; draw(); }
  else if (e.code === 'End') { e.preventDefault(); t = model.duration; draw(); }
  else if (e.key === ']' || e.key === '[') {
    e.preventDefault();
    const opts = [...speedSel.options].map(o => Number(o.value));
    const i = opts.indexOf(Number(speedSel.value));
    const n = e.key === ']' ? Math.min(opts.length - 1, i + 1) : Math.max(0, i - 1);
    speedSel.value = String(opts[n]);
  }
});

async function loadUrl(url: string) {
  status.textContent = 'loading…';
  const r = await fetch(url);
  if (!r.ok) { status.textContent = `⚠ could not load ${url}`; return; }
  load(await r.text(), url.split('/').pop()!);
}
$<HTMLSelectElement>('sample').onchange = e => loadUrl((e.target as HTMLSelectElement).value);
$<HTMLInputElement>('file').onchange = async e => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) load(await f.text(), f.name); };

// drag and drop
const drop = $('drop');
window.addEventListener('dragover', e => { e.preventDefault(); drop.classList.remove('hidden'); });
window.addEventListener('dragleave', e => { if (!e.relatedTarget) drop.classList.add('hidden'); });
window.addEventListener('drop', async e => {
  e.preventDefault(); drop.classList.add('hidden');
  const f = e.dataTransfer?.files?.[0]; if (f) load(await f.text(), f.name);
});

function download(blob: Blob, name: string) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// Frame-exact GIF export (offline, deterministic)
async function exportGif(opts: { width?: number; fps?: number; speed?: number } = {}): Promise<any> {
  if (!model) throw new Error('no session');
  const width = opts.width ?? 720, height = Math.round(width * 9 / 16), fps = opts.fps ?? 12, speed = opts.speed ?? Number(speedSel.value) * 2;
  const c = document.createElement('canvas'); c.width = width; c.height = height;
  const cc = c.getContext('2d', { willReadFrequently: true })!;
  const gif = GIFEncoder();
  const frames = Math.ceil((model.duration / speed) * fps);
  for (let i = 0; i <= frames; i++) {
    renderFrame(cc, low, model, Math.min(model.duration, (i / fps) * speed));
    const { data } = cc.getImageData(0, 0, width, height);
    const pal = quantize(data, 128, { format: 'rgb444' });
    gif.writeFrame(applyPalette(data, pal, 'rgb444'), width, height, { palette: pal, delay: Math.round(1000 / fps) });
    if (i % 10 === 0) { status.textContent = `GIF ${Math.round((i / frames) * 100)}%`; await new Promise(r => setTimeout(r)); }
  }
  gif.finish();
  status.textContent = 'GIF ready';
  return gif.bytes();
}

$('gif').onclick = async () => { setPlaying(false); download(new Blob([await exportGif()], { type: 'image/gif' }), 'agenttown.gif'); };

$('webm').onclick = () => {
  if (!model) return;
  const rec = new MediaRecorder(view.captureStream(30), { mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm' });
  const chunks: Blob[] = [];
  rec.ondataavailable = e => chunks.push(e.data);
  rec.onstop = () => { download(new Blob(chunks, { type: 'video/webm' }), 'agenttown.webm'); status.textContent = 'WebM ready'; };
  t = 0; rec.start(); setPlaying(true); status.textContent = 'recording WebM… (plays once)';
  const iv = setInterval(() => { if (!playing) { clearInterval(iv); rec.stop(); } }, 200);
};

// hooks for headless recording / tests
(window as any).agenttown = {
  seek: (s: number) => { setPlaying(false); t = s; draw(); },
  duration: () => model?.duration ?? 0,
  exportGif: async (o: any) => { const b = await exportGif(o); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); },
};

// hover / click a building for details
const tip = $('tip');
let pinned = false;
function inspect(ev: MouseEvent) {
  if (!model) return null;
  const r = view.getBoundingClientRect();
  return hitTest(model, t, (ev.clientX - r.left) / r.width * LOW_W, (ev.clientY - r.top) / r.height * LOW_H);
}
function showTip(ev: MouseEvent, info: ReturnType<typeof hitTest>) {
  if (!info) { tip.classList.add('hidden'); view.style.cursor = ''; return; }
  view.style.cursor = 'pointer';
  const esc = (x: string) => x.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
  tip.innerHTML = `<b>${esc(info.file)}</b><br>${info.floors} floor${info.floors > 1 ? 's' : ''} · ${info.writes ? 'created · ' : ''}${info.edits} edit${info.edits === 1 ? '' : 's'} · ${info.reads} read${info.reads === 1 ? '' : 's'}${info.fails ? ` · <span class="bad">${info.fails} failing test run${info.fails > 1 ? 's' : ''}</span>` : ''}<br><i>last: ${esc(info.last)}</i>`;
  const r = view.parentElement!.getBoundingClientRect();
  tip.style.left = `${Math.min(ev.clientX - r.left + 12, r.width - 260)}px`; tip.style.top = `${ev.clientY - r.top + 12}px`;
  tip.classList.remove('hidden');
}
view.addEventListener('mousemove', e => { if (!pinned) showTip(e, inspect(e)); });
view.addEventListener('mouseleave', () => { if (!pinned) tip.classList.add('hidden'); });
view.addEventListener('click', e => { const i = inspect(e); pinned = !!i && !pinned; showTip(e, i); });

// live mode: the CLI tails the session file and streams appended lines over SSE
function startLive() {
  liveMode = true;
  let text = '', name = '';
  const es = new EventSource('/__events');
  es.addEventListener('reset', (e: MessageEvent) => { const d = JSON.parse(e.data); text = d.text; name = d.name; model = null; load(text, name, true); });
  es.addEventListener('append', (e: MessageEvent) => { text += JSON.parse(e.data).text; load(text, name, true); });
  es.onerror = () => { status.textContent = '● LIVE  disconnected, retrying…'; };
}

// CLI --gif: render, then hand the bytes back to the local server
async function exportToCli() {
  for (let i = 0; i < 200 && !model; i++) await new Promise(r => setTimeout(r, 50));
  const bytes = await exportGif({ width: Number(qs.get('w') || 720) });
  await fetch('/__gif', { method: 'POST', body: bytes });
  status.textContent = 'GIF saved by the CLI. You can close this tab.';
}

// boot: CLI-served session, ?session=url, or the bundled sample
const qs = new URLSearchParams(location.search);
(async () => {
  if (qs.get('live') === '1') return startLive();
  if (qs.get('local') === '1') { await loadUrl('/__session'); if (qs.get('export') === 'gif') { setPlaying(false); exportToCli(); } return; }
  if (qs.get('session')) return loadUrl(qs.get('session')!);
  if (qs.get('sample') === 'codex') { $<HTMLSelectElement>('sample').value = 'samples/codex-demo.jsonl'; return loadUrl('samples/codex-demo.jsonl'); }
  loadUrl('samples/claude-code-demo.jsonl');
})();
