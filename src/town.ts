// Deterministic isometric pixel-art renderer. Everything is a pure function of (session, t),
// so scrubbing, live playback and frame-by-frame export all produce identical frames.
import type { Session, TownEvent } from './parser';

export const LOW_W = 480, LOW_H = 270;
const TW = 16, TH = 8, FLOOR = 5;

const DUR: Record<string, number> = { prompt: 1.4, think: 0.8, read: 1.0, search: 0.8, edit: 1.3, write: 1.5, bash: 1.0, test_pass: 2.2, test_fail: 2.0, agent: 1.8, web: 1.2, todo: 0.9, mcp: 1.1, compact: 1.6, done: 2.5 };

const PALETTES: Record<string, [string, string, string]> = {
  ts: ['#5aa9ff', '#3b7bd0', '#295a9e'], tsx: ['#66d9ef', '#3fb0c6', '#2b7f90'],
  js: ['#ffd84a', '#d9b21f', '#a5860f'], jsx: ['#ffd84a', '#d9b21f', '#a5860f'],
  py: ['#7bd88f', '#4fae63', '#367a44'], rs: ['#ff9b5e', '#d6713a', '#9e4f25'],
  go: ['#7fe0e0', '#4fb5b5', '#348080'], md: ['#e6e6e6', '#bdbdbd', '#8a8a8a'],
  json: ['#c79bff', '#9c6fd6', '#6f4aa0'], css: ['#ff7ab8', '#d6548f', '#a03a69'],
  html: ['#ff8a5c', '#d9653a', '#a14625'], test: ['#ff6b6b', '#d64545', '#9e2f2f'],
};
const DEFAULT_PAL: [string, string, string] = ['#d9c6a5', '#b39d78', '#857257'];

interface Lot { file: string; gx: number; gy: number; firstIdx: number; pal: [string, string, string] }

export interface Model {
  session: Session;
  starts: number[];
  duration: number;
  lots: Map<string, Lot>;
  hq: { gx: number; gy: number };
  ox: number; oy: number;
  tiles: { gx: number; gy: number; road: boolean }[];
  districts: { dir: string; gx: number; gy: number; files: string[] }[];
}

function palFor(f: string): [string, string, string] {
  if (/(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.\w+$/.test(f)) return PALETTES.test;
  const ext = f.split('.').pop()!.toLowerCase();
  return PALETTES[ext] ?? DEFAULT_PAL;
}

const iso = (gx: number, gy: number) => ({ x: (gx - gy) * TW / 2, y: (gx + gy) * TH / 2 });

export function buildModel(session: Session): Model {
  const starts: number[] = [];
  let t = 0.6;
  for (const e of session.events) { starts.push(t); t += DUR[e.kind] ?? 1; }
  const duration = t + 0.4;

  // group files into districts by directory
  const firstIdx = new Map<string, number>();
  session.events.forEach((e, i) => { if (e.file && !firstIdx.has(e.file)) firstIdx.set(e.file, i); });
  const byDir = new Map<string, string[]>();
  for (const f of firstIdx.keys()) {
    const d = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.';
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d)!.push(f);
  }
  const dirs = [...byDir.keys()].sort();
  const blockCols = Math.max(1, Math.ceil(Math.sqrt(dirs.length + 1)));
  const lots = new Map<string, Lot>();
  const BLOCK = 7; // tiles per block incl. road
  const occupied = new Set<string>();
  const districts: Model['districts'] = [];
  let bi = 1; // block 0 is the HQ plaza
  for (const d of dirs) {
    const files = byDir.get(d)!;
    // big directories spill into extra blocks
    for (let k = 0; k < files.length; k += 9) {
      const bx = (bi % blockCols) * BLOCK, by = Math.floor(bi / blockCols) * BLOCK;
      if (k === 0) districts.push({ dir: d, gx: bx + 1, gy: by + 1, files });
      files.slice(k, k + 9).forEach((f, j) => {
        const gx = bx + 1 + (j % 3) * 2, gy = by + 1 + Math.floor(j / 3) * 2;
        occupied.add(gx + ',' + gy);
        lots.set(f, { file: f, gx, gy, firstIdx: firstIdx.get(f)!, pal: palFor(f) });
      });
      bi++;
    }
  }
  const hq = { gx: 3, gy: 3 };
  const blockRows = Math.ceil(bi / blockCols);
  const maxX = blockCols * BLOCK, maxY = blockRows * BLOCK;
  const tiles: Model['tiles'] = [];
  for (let gy = 0; gy < maxY; gy++) for (let gx = 0; gx < maxX; gx++) {
    const road = gx % BLOCK === 0 || gy % BLOCK === 0;
    tiles.push({ gx, gy, road });
  }
  // centre the town in the low-res frame
  let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
  for (const tl of tiles) { const p = iso(tl.gx, tl.gy); minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x + TW); miny = Math.min(miny, p.y); maxy = Math.max(maxy, p.y + TH); }
  const ox = Math.round(LOW_W / 2 - (minx + maxx) / 2);
  const oy = Math.round(LOW_H / 2 - (miny + maxy) / 2 + 22);
  return { session, starts, duration, lots, hq, ox, oy, tiles, districts };
}

export function eventAt(m: Model, t: number): number {
  let lo = 0, hi = m.starts.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (m.starts[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}

function targetOf(m: Model, e: TownEvent | undefined) {
  if (e?.file && m.lots.has(e.file)) { const l = m.lots.get(e.file)!; return { gx: l.gx + 0.9, gy: l.gy + 0.9 }; }
  return { gx: m.hq.gx + 1.2, gy: m.hq.gy + 1.2 };
}

// tiny deterministic PRNG
function rnd(seed: number) { const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); }

interface Bstate { floors: number; built: number; smoke: boolean; lastTouch: number }

function townState(m: Model, t: number, idx: number) {
  const st = new Map<string, Bstate>();
  let lastEdited: string | undefined;
  let broken = new Set<string>();
  let passes = 0, fails = 0;
  for (let i = 0; i <= idx; i++) {
    const e = m.session.events[i];
    const act = m.starts[i] + (DUR[e.kind] ?? 1) * 0.4; // action begins after walking
    if (e.file && m.lots.has(e.file)) {
      const s = st.get(e.file) ?? { floors: 1, built: 0, smoke: false, lastTouch: act };
      if (!st.has(e.file)) s.built = act;
      if ((e.kind === 'edit' || e.kind === 'write') && t >= act) s.floors = Math.min(9, s.floors + (e.kind === 'write' ? 2 : 1));
      s.lastTouch = act;
      st.set(e.file, s);
      if (e.kind === 'edit' || e.kind === 'write') lastEdited = e.file;
    }
    if (e.kind === 'test_fail' && t >= act) { fails++; if (lastEdited) broken.add(lastEdited); }
    if (e.kind === 'test_pass' && t >= act) { passes++; broken = new Set(); }
  }
  for (const f of broken) { const s = st.get(f); if (s) s.smoke = true; }
  return { st, passes, fails };
}

function px(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, col: string) { c.fillStyle = col; c.fillRect(Math.round(x), Math.round(y), w, h); }

function diamond(c: CanvasRenderingContext2D, x: number, y: number, col: string) {
  c.fillStyle = col;
  for (let r = 0; r < TH; r++) {
    const half = r < TH / 2 ? (r + 1) * 2 : (TH - r) * 2;
    c.fillRect(x + TW / 2 - half, y + r, half * 2, 1);
  }
}

function building(c: CanvasRenderingContext2D, x: number, y: number, floors: number, pal: [string, string, string], glow: boolean, seed: number, growth: number) {
  const h = Math.max(1, Math.round(floors * FLOOR * growth));
  // left & right faces
  for (let col = 0; col < TW / 2; col++) {
    const yTop = y + TH / 2 - h + col / 2;
    px(c, x + col, yTop, 1, h + (TH / 2 - Math.abs(col - TW / 2 + 0.5) / 2 | 0), pal[1]);
    px(c, x + TW - 1 - col, yTop, 1, h + (TH / 2 - Math.abs(col - TW / 2 + 0.5) / 2 | 0), pal[2]);
  }
  // roof
  diamond(c, x, y - h, glow ? '#fff6b0' : pal[0]);
  // windows
  if (growth >= 1) for (let f = 0; f < floors; f++) {
    const wy = y + TH / 2 - h + f * FLOOR + 2;
    for (const wx of [2, 5]) {
      const lit = rnd(seed * 31 + f * 7 + wx) > 0.35;
      px(c, x + wx, wy + wx / 2, 1, 2, lit ? '#ffe680' : '#1b2238');
      px(c, x + TW - 1 - wx, wy + wx / 2, 1, 2, rnd(seed * 17 + f * 3 + wx) > 0.45 ? '#ffd24d' : '#141a2c');
    }
  }
  // scaffolding while growing
  if (growth < 1) { for (let k = 0; k < h; k += 3) px(c, x - 1, y + TH / 2 - k, TW + 2, 1, '#c9a34a'); }
}

function hqTower(c: CanvasRenderingContext2D, x: number, y: number, t: number) {
  building(c, x, y, 6, ['#3a3f58', '#2a2e42', '#1d2030'], false, 99, 1);
  // terminal screen
  px(c, x + 3, y - 18, 5, 4, '#0f1a0f');
  px(c, x + 4, y - 17, 1, 1, '#4dff7a'); if (Math.floor(t * 2) % 2) px(c, x + 6, y - 17, 1, 1, '#4dff7a');
  // antenna
  px(c, x + TW / 2, y - 6 * FLOOR - 7, 1, 6, '#9aa0b8');
  px(c, x + TW / 2, y - 6 * FLOOR - 8, 1, 1, Math.floor(t * 3) % 2 ? '#ff4d4d' : '#661f1f');
}

const AGENT = [
  '..aaaa..',
  '.abbbba.',
  '.bcbbcb.',
  '.bbbbbb.',
  '..dddd..',
  '.dddddd.',
  'd.dddd.d',
  '..dddd..',
  '..e..e..',
];
const AG_COL: Record<string, string> = { a: '#ffb347', b: '#ffe0bd', c: '#1a1a2e', d: '#ff6f61', e: '#3a2e5c' };
const HELPER_COL: Record<string, string> = { a: '#5a3825', b: '#ffe0bd', c: '#1a1a2e', d: '#4cc9f0', e: '#22335c' };

function agent(c: CanvasRenderingContext2D, x: number, y: number, walking: boolean, t: number, icon: string, col = AG_COL) {
  const bob = walking ? (Math.floor(t * 8) % 2) : (Math.floor(t * 2) % 2);
  px(c, x - 3, y + 1, 7, 2, 'rgba(0,0,0,0.35)');
  AGENT.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) {
      let ch = row[rx];
      if (ch === '.') continue;
      if (ry === 8 && walking) { if ((rx === 2) !== (bob === 1)) continue; }
      px(c, x - 4 + rx, y - 9 + ry - (ry < 8 ? bob : 0), 1, 1, col[ch]);
    }
  });
  if (icon) {
    const by = y - 20 - bob;
    px(c, x - 5, by, 11, 8, '#ffffff'); px(c, x - 1, by + 8, 2, 2, '#ffffff');
    drawIcon(c, x - 4, by + 1, icon, t);
  }
}

function drawIcon(c: CanvasRenderingContext2D, x: number, y: number, icon: string, t: number) {
  const k = '#22223b';
  if (icon === 'read') { px(c, x + 1, y + 1, 4, 1, k); px(c, x + 1, y + 4, 4, 1, k); px(c, x, y + 2, 1, 2, k); px(c, x + 5, y + 2, 1, 2, k); px(c, x + 5, y + 5, 2, 1, k); px(c, x + 7, y + 6, 1, 1, k); }
  else if (icon === 'edit') { const sw = Math.floor(t * 6) % 2; px(c, x + 2, y + 1 + sw, 5, 2, '#8d99ae'); px(c, x + 4, y + 3 + sw, 1, 3 - sw, '#a0522d'); }
  else if (icon === 'bash') { px(c, x, y + 1, 1, 1, k); px(c, x + 1, y + 2, 1, 1, k); px(c, x, y + 3, 1, 1, k); if (Math.floor(t * 3) % 2) px(c, x + 3, y + 4, 4, 1, k); }
  else if (icon === 'think') { for (let i = 0; i < 3; i++) px(c, x + 1 + i * 3, y + 3, 1 + (Math.floor(t * 4) % 3 === i ? 1 : 0), 1, k); }
  else if (icon === 'search') { px(c, x + 1, y, 3, 1, k); px(c, x, y + 1, 1, 3, k); px(c, x + 4, y + 1, 1, 3, k); px(c, x + 1, y + 4, 3, 1, k); px(c, x + 5, y + 5, 2, 2, k); }
  else if (icon === 'prompt') { px(c, x + 1, y + 1, 7, 1, '#ff6f61'); px(c, x + 1, y + 3, 5, 1, '#ff6f61'); px(c, x + 1, y + 5, 6, 1, '#ff6f61'); }
  else if (icon === 'pass') { px(c, x + 1, y + 3, 1, 1, '#2a9d4b'); px(c, x + 2, y + 4, 1, 1, '#2a9d4b'); px(c, x + 3, y + 3, 1, 1, '#2a9d4b'); px(c, x + 4, y + 2, 1, 1, '#2a9d4b'); px(c, x + 5, y + 1, 1, 1, '#2a9d4b'); }
  else if (icon === 'web') { px(c, x + 2, y, 4, 1, '#1d4ed8'); px(c, x + 1, y + 1, 6, 5, '#3b82f6'); px(c, x + 2, y + 6, 4, 1, '#1d4ed8'); px(c, x + 1, y + 3, 6, 1, '#93c5fd'); px(c, x + 3, y + 1, 2, 5, '#93c5fd'); }
  else if (icon === 'todo') { for (let i = 0; i < 3; i++) { px(c, x, y + 1 + i * 2, 1, 1, i < 2 ? '#2a9d4b' : k); px(c, x + 2, y + 1 + i * 2, 5, 1, k); } }
  else if (icon === 'mcp') { px(c, x + 2, y, 1, 2, k); px(c, x + 5, y, 1, 2, k); px(c, x + 1, y + 2, 6, 3, '#7c3aed'); px(c, x + 3, y + 5, 2, 2, k); }
  else if (icon === 'agent') { px(c, x + 1, y + 1, 2, 2, '#ff6f61'); px(c, x, y + 3, 4, 3, '#ff6f61'); px(c, x + 5, y + 1, 2, 2, '#4cc9f0'); px(c, x + 4, y + 3, 4, 3, '#4cc9f0'); }
  else if (icon === 'compact') { const q = Math.floor(t * 4) % 2; px(c, x + q, y + 3, 2, 1, k); px(c, x + 6 - q, y + 3, 2, 1, k); px(c, x + 3, y + 1, 2, 5, '#8d99ae'); }
  else if (icon === 'fail') { for (let i = 0; i < 5; i++) { px(c, x + 1 + i, y + 1 + i, 1, 1, '#d62828'); px(c, x + 5 - i, y + 1 + i, 1, 1, '#d62828'); } }
}

function smoke(c: CanvasRenderingContext2D, x: number, y: number, t: number, seed: number) {
  // flames on the roof
  for (let i = 0; i < 5; i++) {
    const fh = 2 + Math.floor(rnd(seed + i + Math.floor(t * 10)) * 5);
    px(c, x - 4 + i * 2, y + 2 - fh, 2, fh, fh > 4 ? '#ffd23f' : '#ff5f1f');
  }
  for (let i = 0; i < 12; i++) {
    const life = ((t * 0.55 + rnd(seed + i)) % 1);
    const sx = x + Math.sin(life * 5 + i) * 4 + (rnd(seed * 3 + i) - 0.5) * 6 + life * 10;
    const sy = y - 2 - life * 40;
    const r = 1 + Math.floor(life * 6);
    c.globalAlpha = 0.9 * (1 - life);
    px(c, sx - r, sy - r, r * 2, r * 2, i % 3 === 0 ? '#6e6e7a' : i % 3 === 1 ? '#9a9aa6' : '#c4c4cc');
  }
  c.globalAlpha = 1;
}

const FW = ['#ff4d6d', '#ffd60a', '#4cc9f0', '#80ffdb', '#f72585', '#b5e48c'];
function fireworks(c: CanvasRenderingContext2D, cx: number, cy: number, age: number, seed: number) {
  for (let b = 0; b < 5; b++) {
    const a = age - b * 0.28;
    if (a < 0 || a > 1.4) continue;
    const bx = cx + (rnd(seed + b) - 0.5) * 220, by = cy - 40 - rnd(seed + b * 7) * 60;
    if (a < 0.35) { // rocket
      const ry = by + (1 - a / 0.35) * 70;
      px(c, bx, ry, 1, 3, '#fff3b0');
      continue;
    }
    const k = (a - 0.35) / 1.05;
    const col = FW[(seed + b) % FW.length];
    c.globalAlpha = 1 - k * 0.9;
    for (let i = 0; i < 28; i++) {
      const ang = (i / 28) * Math.PI * 2;
      for (const [rr, sz] of [[1, 2], [0.6, 1]] as const) {
        const r = (5 + k * 30) * rr;
        px(c, bx + Math.cos(ang) * r, by + Math.sin(ang) * r + k * k * 12, sz, sz, i % 4 ? col : '#ffffff');
      }
    }
    c.globalAlpha = 1;
  }
}

export function renderLow(c: CanvasRenderingContext2D, m: Model, t: number) {
  c.imageSmoothingEnabled = false;
  // night sky
  const g = c.createLinearGradient(0, 0, 0, LOW_H);
  g.addColorStop(0, '#0b1026'); g.addColorStop(1, '#2b1f4a');
  c.fillStyle = g; c.fillRect(0, 0, LOW_W, LOW_H);
  for (let i = 0; i < 70; i++) { if (rnd(i * 5 + Math.floor(t * 1.5) * (i % 7 === 0 ? 1 : 0)) > 0.15) px(c, rnd(i) * LOW_W, rnd(i + 99) * LOW_H * 0.6, 1, 1, i % 9 ? '#c8d0ff' : '#fff7c2'); }
  // moon
  c.fillStyle = '#f6f1d1'; c.beginPath(); c.arc(LOW_W - 50, 34, 11, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#0d1229'; c.beginPath(); c.arc(LOW_W - 45, 30, 10, 0, Math.PI * 2); c.fill();

  const idx = eventAt(m, t);
  const { st } = townState(m, t, idx);
  const P = (gx: number, gy: number) => { const p = iso(gx, gy); return { x: p.x + m.ox, y: p.y + m.oy }; };

  for (const tl of m.tiles) {
    const p = P(tl.gx, tl.gy);
    const alt = (tl.gx + tl.gy) % 2 === 0;
    diamond(c, p.x, p.y, tl.road ? (alt ? '#3d3d52' : '#38384c') : (alt ? '#2f6b3a' : '#2b6335'));
    if (tl.road && tl.gx % 7 === 0 && tl.gy % 7 !== 0 && tl.gy % 2 === 0) px(c, p.x + TW / 2, p.y + TH / 2, 1, 1, '#d8d27a');
    if (tl.road && tl.gy % 7 === 0 && tl.gx % 7 !== 0 && tl.gx % 2 === 0) px(c, p.x + TW / 2, p.y + TH / 2, 1, 1, '#d8d27a');
    if (!tl.road && rnd(tl.gx * 13 + tl.gy * 7) > 0.93) { px(c, p.x + 7, p.y - 3, 3, 4, '#3fa34d'); px(c, p.x + 8, p.y + 1, 1, 2, '#6b4226'); }
  }

  // agent position
  const e = m.session.events[Math.max(0, idx)];
  const dur = DUR[e?.kind] ?? 1;
  const local = idx < 0 ? 0 : (t - m.starts[idx]) / dur;
  const from = targetOf(m, idx > 0 ? m.session.events[idx - 1] : undefined);
  const to = targetOf(m, idx >= 0 ? e : undefined);
  const wk = Math.min(1, local / 0.4);
  const ease = wk * wk * (3 - 2 * wk);
  const ag = { gx: from.gx + (to.gx - from.gx) * ease, gy: from.gy + (to.gy - from.gy) * ease };
  const walking = wk < 1 && (from.gx !== to.gx || from.gy !== to.gy);

  // draw objects in depth order
  type D = { depth: number; draw: () => void };
  const draws: D[] = [];
  draws.push({ depth: m.hq.gx + m.hq.gy, draw: () => { const p = P(m.hq.gx, m.hq.gy); hqTower(c, p.x, p.y, t); } });
  let seed = 0;
  for (const [f, s] of st) {
    const lot = m.lots.get(f)!; const sd = ++seed;
    const grow = Math.min(1, Math.max(0.05, (t - s.built) / 0.6));
    if (t < s.built) continue;
    const glow = idx >= 0 && e.file === f && !walking && (e.kind === 'read' || e.kind === 'search');
    draws.push({ depth: lot.gx + lot.gy, draw: () => {
      const p = P(lot.gx, lot.gy);
      building(c, p.x, p.y, s.floors, lot.pal, glow, sd, grow);
      if (s.smoke) smoke(c, p.x + TW / 2, p.y - s.floors * FLOOR, t, sd);
    } });
  }
  let icon = '';
  if (idx >= 0 && !walking) icon = e.kind === 'test_pass' ? 'pass' : e.kind === 'test_fail' ? 'fail' : e.kind === 'write' ? 'edit' : e.kind === 'done' ? '' : e.kind;
  if (idx >= 0 && e.failed && local > 0.65) icon = 'fail';
  // subagents: a helper walks out from HQ to a random lot and back
  const lotList = [...m.lots.values()];
  for (let i = Math.max(0, idx - 6); i <= idx; i++) {
    if (m.session.events[i].kind !== 'agent') continue;
    const age = t - m.starts[i], life = 4.5;
    if (age < 0 || age > life) continue;
    const dest = lotList.length ? lotList[Math.floor(rnd(i * 11) * lotList.length)] : { gx: m.hq.gx + 3, gy: m.hq.gy };
    const k = age / life, out = k < 0.5 ? k * 2 : (1 - k) * 2;
    const ez = out * out * (3 - 2 * out);
    const h = { gx: m.hq.gx + 0.6 + (dest.gx + 0.9 - m.hq.gx - 0.6) * ez, gy: m.hq.gy + 1.4 + (dest.gy + 0.9 - m.hq.gy - 1.4) * ez };
    const hw = k < 0.4 || k > 0.6;
    draws.push({ depth: h.gx + h.gy + 0.02, draw: () => { const p = P(h.gx, h.gy); agent(c, p.x + TW / 2, p.y + TH / 2, hw, t + i, hw ? '' : 'read', HELPER_COL); } });
  }
  draws.push({ depth: ag.gx + ag.gy + 0.01, draw: () => { const p = P(ag.gx, ag.gy); agent(c, p.x + TW / 2, p.y + TH / 2, walking, t, icon); } });
  draws.sort((a, b) => a.depth - b.depth).forEach(d => d.draw());

  // fireworks on passing tests and at the end
  for (let i = 0; i <= idx; i++) {
    const k = m.session.events[i].kind;
    if (k !== 'test_pass' && k !== 'done') continue;
    const age = t - (m.starts[i] + (DUR[k] ?? 1) * 0.4);
    if (age >= 0 && age < 2.6) fireworks(c, LOW_W / 2, LOW_H / 2, age, i * 7 + 1);
  }
  if (idx >= 0 && e.kind === 'compact') { c.globalAlpha = Math.max(0, 0.35 * (1 - Math.abs(local - 0.5) * 2)); px(c, 0, 0, LOW_W, LOW_H, '#c8d0ff'); c.globalAlpha = 1; }
}

const KIND_COL: Record<string, string> = { agent: '#4cc9f0', web: '#93c5fd', todo: '#80ff72', mcp: '#c4a1ff', compact: '#c8d0ff', prompt: '#ff8fa3', think: '#b8c0ff', read: '#9bf6ff', search: '#9bf6ff', edit: '#ffd166', write: '#ffd166', bash: '#caffbf', test_pass: '#80ff72', test_fail: '#ff6b6b', done: '#ffffff' };

export function renderFrame(main: CanvasRenderingContext2D, low: HTMLCanvasElement | OffscreenCanvas, m: Model, t: number) {
  const lc = low.getContext('2d') as CanvasRenderingContext2D;
  renderLow(lc, m, t);
  const W = main.canvas.width, H = main.canvas.height;
  main.imageSmoothingEnabled = false;
  main.drawImage(low as CanvasImageSource, 0, 0, W, H);
  const s = W / 960;
  const idx = eventAt(m, t);
  const ev = m.session.events;
  main.font = `bold ${Math.round(18 * s)}px "Courier New", monospace`;
  main.textBaseline = 'top';
  // title
  main.fillStyle = 'rgba(10,12,30,0.75)'; main.fillRect(12 * s, 12 * s, 440 * s, 54 * s);
  main.fillStyle = '#ffd166'; main.fillText('AgentTown', 22 * s, 18 * s);
  main.font = `${Math.round(13 * s)}px "Courier New", monospace`;
  main.fillStyle = '#c8d0ff';
  const agentName = m.session.agent === 'claude-code' ? 'Claude Code' : m.session.agent === 'codex' ? 'Codex' : 'agent';
  main.fillText(`${agentName} · ${m.session.title}`.slice(0, 58), 22 * s, 42 * s);
  // stats
  const { passes, fails } = townState(m, t, idx);
  const tokens = idx >= 0 ? ev[idx].tokens : 0;
  const stats = `files ${m.session.files.filter(f => (m.lots.get(f)?.firstIdx ?? 1e9) <= idx).length}  ✔ ${passes}  ✘ ${fails}${tokens ? `  tokens ${tokens.toLocaleString('en-US')}` : ''}`;
  main.font = `bold ${Math.round(13 * s)}px "Courier New", monospace`;
  const sw = main.measureText(stats).width + 20 * s;
  main.fillStyle = 'rgba(10,12,30,0.75)'; main.fillRect(W - sw - 12 * s, 12 * s, sw, 28 * s);
  main.fillStyle = '#e0e6ff'; main.fillText(stats, W - sw - 2 * s, 19 * s);
  // district labels
  const k = W / LOW_W;
  main.font = `bold ${Math.round(10 * s)}px "Courier New", monospace`;
  for (const d of m.districts) {
    if (!d.files.some(f => (m.lots.get(f)?.firstIdx ?? 1e9) <= idx)) continue;
    const p = iso(d.gx, d.gy);
    const name = d.dir === '.' ? '/' : d.dir.split('/').slice(-2).join('/') + '/';
    const lx = (p.x + m.ox + TW / 2) * k, ly = (p.y + m.oy + TH + 2) * k;
    const tw = main.measureText(name).width;
    main.fillStyle = 'rgba(10,12,30,0.6)'; main.fillRect(lx - tw / 2 - 3 * s, ly - 1 * s, tw + 6 * s, 13 * s);
    main.fillStyle = '#ffe9a8'; main.fillText(name, lx - tw / 2, ly);
  }
  // event log
  main.font = `${Math.round(13 * s)}px "Courier New", monospace`;
  const start = Math.max(0, idx - 3);
  const rows = ev.slice(start, idx + 1);
  if (rows.length) {
    main.fillStyle = 'rgba(10,12,30,0.78)'; main.fillRect(12 * s, H - (24 + rows.length * 20) * s, 620 * s, (12 + rows.length * 20) * s);
    rows.forEach((e, i) => {
      main.globalAlpha = i === rows.length - 1 ? 1 : 0.55;
      main.fillStyle = KIND_COL[e.kind] ?? '#fff';
      const tag = e.kind === 'test_pass' ? 'PASS' : e.kind === 'test_fail' ? 'FAIL' : e.kind.toUpperCase();
      main.fillText(`${tag.padEnd(6)} ${e.label}`.slice(0, 78), 22 * s, H - (18 + (rows.length - i) * 20) * s + 0);
    });
    main.globalAlpha = 1;
  }
  // progress bar
  main.fillStyle = 'rgba(255,255,255,0.15)'; main.fillRect(0, H - 4 * s, W, 4 * s);
  main.fillStyle = '#ffd166'; main.fillRect(0, H - 4 * s, W * Math.min(1, t / m.duration), 4 * s);
}

export interface FileInfo { file: string; reads: number; edits: number; writes: number; fails: number; last: string; floors: number }

/** Which building is under a point in low-res canvas coordinates at time t (topmost first). */
export function hitTest(m: Model, t: number, lx: number, ly: number): FileInfo | null {
  const idx = eventAt(m, t);
  const { st } = townState(m, t, idx);
  let best: { f: string; depth: number } | null = null;
  for (const [f, s] of st) {
    if (t < s.built) continue;
    const lot = m.lots.get(f)!; const p = iso(lot.gx, lot.gy);
    const x = p.x + m.ox, y = p.y + m.oy, h = s.floors * FLOOR;
    if (lx >= x && lx < x + TW && ly >= y - h && ly < y + TH + 2 && (!best || lot.gx + lot.gy > best.depth)) best = { f, depth: lot.gx + lot.gy };
  }
  if (!best) return null;
  const info: FileInfo = { file: best.f, reads: 0, edits: 0, writes: 0, fails: 0, last: '', floors: st.get(best.f)!.floors };
  let lastEdit = '';
  for (let i = 0; i <= idx; i++) {
    const e = m.session.events[i];
    if (e.kind === 'edit' || e.kind === 'write') lastEdit = e.file ?? '';
    if (e.kind === 'test_fail' && lastEdit === best.f) info.fails++;
    if (e.file !== best.f) continue;
    if (e.kind === 'read' || e.kind === 'search') info.reads++;
    if (e.kind === 'edit') info.edits++;
    if (e.kind === 'write') info.writes++;
    info.last = e.label;
  }
  return info;
}
