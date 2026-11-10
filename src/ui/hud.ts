// The HUD: club, swing mode and lie panels, the swing pad, the spin ball, the shot card and toasts.
// Plain DOM over the WebGL canvas. The default look ('f', Clubhouse Candy) is playful and tactile:
// cream toy-like chips in Toronto Hunt navy, red and gold. The older looks (A Broadcast, B Clubhouse,
// C Y2K Pro Tour) are still there (tap the player chip to cycle). Corner groups scale with the screen.
import { shadeBall, mat3Identity, mat3Rotate, mat3RotateAxis, onBallTexUpdate, type Mat3 } from './balltex';
import { CLUB_SPECS } from '../golfer/club';
import type { ShotMode } from '../golfer/golfer';
import { CLUB_DATA, LIES, MODES, type ShotPlan } from '../game/shot';
import type { GolferProfile } from '../golfer/profile';
import crestUrl from '../assets/brand/toronto-hunt-crest.png';
import portraitUrl from '../assets/neil/portrait.jpg';
import css from './hud.css?inline';

export type Skin = 'f' | 'a' | 'b' | 'c';
export const SKINS: Skin[] = ['f', 'a', 'b', 'c'];
/** phones: the swing card pops in for a few seconds then leaves; elsewhere it shrinks to a pill */
/** the visible viewport (excludes the browser's address bar and toolbar on phones) */
export function viewport() {
  const vv = window.visualViewport;
  const w = Math.round(vv?.width ?? innerWidth), h = Math.round(vv?.height ?? innerHeight);
  return { w: Math.max(1, w), h: Math.max(1, h), top: Math.round(vv?.offsetTop ?? 0) };
}
const isPhone = () => matchMedia('(pointer: coarse)').matches || (innerHeight > innerWidth && innerWidth < 700);
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
let uid = 0;

/** the shot's flight in miniature: ball on the left, dotted flight, where it lands and how far it rolls */
/** how each club reads in the UI: the badge in the chip's circle and its full name */
export const CLUB_UI: Record<string, [string, string]> = {
  '1W': ['D', 'Driver'], '3W': ['3W', '3 Wood'], '5W': ['5W', '5 Wood'], '4H': ['Hy', 'Hybrid'],
  '5i': ['5i', '5 Iron'], '6i': ['6i', '6 Iron'], '7i': ['7i', '7 Iron'], '8i': ['8i', '8 Iron'], '9i': ['9i', '9 Iron'],
  'PW': ['PW', 'PW'], '50°': ['GW', 'GW · 50°'], '56°': ['SW', 'SW · 56°'], '60°': ['LW', 'LW · 60°'],
};
const clubUI = (id: string) => CLUB_UI[id] ?? [id, id];
const modeGlyph = (m: ShotMode, _w = 3) => {
  const [lx, ay, roll] = { full: [46, 3, 6], punch: [34, 17, 16], pitch: [32, 8, 5], flop: [24, 1, 0] }[m]; // land x, apex y, roll
  const x0 = 6, gy = 23, cx = (x0 + lx) / 2, cy = 2 * ay - gy; // quadratic control point so the apex sits at ay
  return `<svg viewBox="0 0 56 30" aria-hidden="true" class="flight-glyph">
    <path d="M2 ${gy + 4} H54" stroke="#5aa83e" stroke-width="5" stroke-linecap="round"/>
    <path d="M${x0} ${gy} Q${cx} ${cy} ${lx} ${gy}" fill="none" stroke="var(--h-accent)" stroke-width="3" stroke-linecap="round" stroke-dasharray="0.1 5"/>
    ${roll ? `<path d="M${lx} ${gy + 1} h${roll}" stroke="var(--h-accent)" stroke-width="3" stroke-linecap="round"/>` : ''}
    <circle cx="${x0}" cy="${gy - 1}" r="4" fill="#fff" stroke="#13294b" stroke-width="1.6"/>
  </svg>`;
};
const lieRing = (pct: number) => {
  const r = 19, C = 2 * Math.PI * r, col = pct >= 95 ? 'var(--h-good)' : pct >= 85 ? 'var(--h-warn)' : 'var(--h-bad)';
  return `<svg viewBox="0 0 46 46" aria-hidden="true"><circle cx="23" cy="23" r="${r}" fill="none" stroke="var(--h-track)" stroke-width="5"/><circle cx="23" cy="23" r="${r}" fill="none" stroke="${col}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${C * pct / 100} ${C}" transform="rotate(-90 23 23)"/><text x="23" y="27.5" text-anchor="middle" font-size="12" font-weight="700" fill="var(--h-ink)" style="font-family:var(--h-display)">${pct}</text></svg>`;
};
/** friendly words for each lie */
const LIE_WORD: Record<string, [string, 'good' | 'ok' | 'meh' | 'bad', 'tee' | 'fairway' | 'cut' | 'rough' | 'sand']> = {
  'Tee box': ['Perfect', 'good', 'tee'], 'Fairway': ['Clean', 'good', 'fairway'], 'First cut': ['Good', 'ok', 'cut'],
  'Rough': ['Heavy', 'bad', 'rough'], 'Fairway bunker': ['Sandy', 'meh', 'sand'],
};
/** a tiny illustrated scene: ball sitting on a tilted strip of turf, an arrow for where it will start */
/** a crisp little Pro V1x for the lie tile (front face, slight tilt), cached */
let lieBallCache = '';
const lieBallURL = () => { if (!lieBallCache) { const m = mat3Identity(); mat3Rotate(m, 0.25, 0.35); lieBallCache = shadeBall(72, m).toDataURL(); } return lieBallCache; };
/** deterministic jitter so the turf looks the same every render */
const rnd = (i: number) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
/** the lie tile: layered turf that tilts with the slope, a real ball sitting in it (on a tee, nestled in rough, in sand) */
const lieScene = (slope: number, side: number, kind: string) => {
  const tilt = (-side * Math.min(18, slope * 4)).toFixed(1), gy = 36, uid = 'ls' + kind;
  const look = {
    tee:     { sky: ['#a8d5f5', '#e2f2fc'], soil: ['#6fbf4a', '#3f8a2c'], back: '#4f9a35', front: '#7fd055', hi: '#c6f08c', h: [2.5, 4], n: 34, stripe: .14 },
    fairway: { sky: ['#a8d5f5', '#e2f2fc'], soil: ['#69b847', '#3a7f2a'], back: '#468f31', front: '#73c64e', hi: '#b9ea83', h: [3.5, 5.5], n: 30, stripe: .2 },
    cut:     { sky: ['#a8d5f5', '#e2f2fc'], soil: ['#5aa63e', '#356f26'], back: '#3e8129', front: '#66b745', hi: '#a9dd78', h: [5, 8], n: 30, stripe: .1 },
    rough:   { sky: ['#a9cfee', '#dfeef8'], soil: ['#3f7f2b', '#24521a'], back: '#2b5e1e', front: '#4a8f30', hi: '#8ec462', h: [9, 16], n: 46, stripe: 0 },
    sand:    { sky: ['#b2dbf7', '#f3f1e6'], soil: ['#f1dca8', '#d6b779'], back: '', front: '', hi: '', h: [0, 0], n: 0, stripe: 0 },
  }[kind as 'tee'] ?? null;
  const L = look!;
  // blades: a back layer (darker), the ball, then a front layer (lighter, with a highlight edge) that can hide part of it
  const blade = (i: number, col: string, hiCol: string, scale: number) => {
    const x = -16 + rnd(i) * 104, h = (L.h[0] + rnd(i + 7) * (L.h[1] - L.h[0])) * scale, lean = (rnd(i + 3) - 0.5) * h * 0.7, w = 1.2 + rnd(i + 5) * 1.3;
    return `<path d="M${(x - w).toFixed(1)} ${gy + 0.6} Q${(x + lean * 0.4).toFixed(1)} ${(gy - h * 0.55).toFixed(1)} ${(x + lean).toFixed(1)} ${(gy - h).toFixed(1)} Q${(x + lean * 0.3 + w * 0.3).toFixed(1)} ${(gy - h * 0.5).toFixed(1)} ${(x + w).toFixed(1)} ${gy + 0.6} Z" fill="${col}"/>` + (hiCol ? `<path d="M${(x + lean * 0.4).toFixed(1)} ${(gy - h * 0.5).toFixed(1)} Q${(x + lean * 0.7).toFixed(1)} ${(gy - h * 0.8).toFixed(1)} ${(x + lean).toFixed(1)} ${(gy - h).toFixed(1)}" stroke="${hiCol}" stroke-width=".6" fill="none" opacity=".8"/>` : '');
  };
  let back = '', front = '';
  for (let i = 0; i < L.n; i++) back += blade(i, L.back, '', 1.05);
  for (let i = 0; i < L.n; i++) front += blade(i + 101, L.front, L.hi, kind === 'rough' ? 0.95 : 0.8);
  const stripes = L.stripe ? Array.from({ length: 6 }, (_, i) => `<path d="M${-30 + i * 22} ${gy} l14 0 l-10 30 l-14 0 Z" fill="#fff" opacity="${i % 2 ? 0 : L.stripe}"/>`).join('') : '';
  const sand = kind === 'sand' ? Array.from({ length: 5 }, (_, i) => `<path d="M-14 ${gy + 3 + i * 3.4} q9 -1.6 18 0 t18 0 t18 0 t18 0 t18 0" stroke="#c9a663" stroke-width=".9" fill="none" opacity=".75"/>`).join('') + `<path d="M-14 ${gy + 0.4} q50 -2.2 100 0" stroke="#fff6dc" stroke-width="1" fill="none" opacity=".8"/>` : '';
  // the ball: ~33% of the tile height; on a tee, sitting down in rough, a touch down in sand
  const r = 8.6, cx = 36;
  const cy = kind === 'tee' ? gy - r - 5.5 : kind === 'rough' ? gy - r + 4.5 : kind === 'cut' ? gy - r + 1.5 : kind === 'sand' ? gy - r + 2 : gy - r + 0.6;
  const tee = kind === 'tee' ? `<path d="M${cx - 3.6} ${gy - 5.6} h7.2 l-1.6 2.2 h-1.1 l-.5 9 h-1 l-.5 -9 h-1.1 Z" fill="#fffdf6" stroke="#cfc6b0" stroke-width=".5"/>` : '';
  const shadow = `<ellipse cx="${cx + 1}" cy="${(kind === 'tee' ? gy : Math.min(gy + 0.5, cy + r)).toFixed(1)}" rx="${r * 0.95}" ry="2.1" fill="rgba(0,0,0,.28)"/>`;
  const ballImg = `<image href="${lieBallURL()}" x="${cx - r}" y="${(cy - r).toFixed(1)}" width="${2 * r}" height="${2 * r}"/>`;
  return `<svg class="lie-scene" viewBox="0 0 72 52" aria-hidden="true">
    <defs><linearGradient id="${uid}sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${L.sky[0]}"/><stop offset="1" stop-color="${L.sky[1]}"/></linearGradient>
    <linearGradient id="${uid}soil" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${L.soil[0]}"/><stop offset="1" stop-color="${L.soil[1]}"/></linearGradient></defs>
    <rect width="72" height="52" fill="url(#${uid}sky)"/>
    <g class="lie-tilt" style="--tilt:${tilt}deg">
      <rect x="-20" y="${gy}" width="112" height="40" fill="url(#${uid}soil)"/>${stripes}${sand}
      ${back}${tee}${shadow}${ballImg}${front}
    </g>
  </svg>`;
};
const slopeIcon = (slope: number, side: number) => {
  const tilt = -side * Math.min(18, slope * 4);
  const arrow = side ? `<g transform="translate(36 9)"><path d="M${side * 14} 0 L${-side * 10} 0" stroke="var(--h-accent)" stroke-width="3" stroke-linecap="round"/><path d="M${side * 18} 0 L${side * 9} -6 L${side * 9} 6 Z" fill="var(--h-accent)"/></g>` : `<text x="36" y="13" text-anchor="middle" font-size="10" fill="var(--h-dim)">LEVEL</text>`;
  return `<svg viewBox="0 0 72 40" aria-hidden="true">${arrow}<g transform="rotate(${tilt} 36 30)"><rect x="6" y="30" width="60" height="7" rx="2" fill="var(--h-good)" opacity=".85"/><circle cx="36" cy="26" r="4" fill="#fff"/></g></svg>`;
};

/** a tapered ribbon outline along a stroke, thin at the start, wide at the end */
function ribbon(pts: [number, number][], w0: number, w1: number) {
  const P = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 0.8);
  if (P.length < 2) return '';
  const L: string[] = [], R: string[] = [];
  for (let i = 0; i < P.length; i++) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
    let nx = -(b[1] - a[1]), ny = b[0] - a[0]; const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
    const w = (w0 + (w1 - w0) * (i / (P.length - 1))) / 2;
    L.push(`${(P[i][0] + nx * w).toFixed(1)} ${(P[i][1] + ny * w).toFixed(1)}`); R.push(`${(P[i][0] - nx * w).toFixed(1)} ${(P[i][1] - ny * w).toFixed(1)}`);
  }
  const w = w1 / 2;
  const end = R[R.length - 1];
  return `M${L.join(' L')} A${w} ${w} 0 0 1 ${end} L${R.reverse().join(' L')} Z`;
}
const buzz = (p: number | number[]) => { try { navigator.vibrate?.(p); } catch { /* not allowed */ } };

/** the swing-stick puck: a real Pro V1x, model mark facing the player, cached as an image */
let puckCache = '';
function puckURL() {
  if (!puckCache) { const m = mat3Identity(); mat3Rotate(m, 0, Math.PI); mat3Rotate(m, 0.18, 0); puckCache = shadeBall(160, m).toDataURL(); }
  return puckCache;
}
onBallTexUpdate(() => { puckCache = ''; const u = puckURL(); document.querySelectorAll('.puck-img').forEach(i => i.setAttribute('href', u)); });

export function padSVG(skin: Skin) {
  const id = 'p' + (++uid);
  const ticks = [20, 40, 60, 80].map((y, i) => `<line x1="-9" x2="9" y1="${y}" y2="${y}" class="tick"/><text x="14" y="${y + 3.5}" font-size="9" class="tlab">${(i + 1) * 25}</text>`).join('');
  const common = (lane: string, tick: string, tlab: string, trailB: string, trailD: string, ring: string) => `
    <style>#${id} .tick{stroke:${tick};stroke-width:1.5} #${id} .tlab{fill:${tlab}}</style>
    <line x1="0" x2="0" y1="-78" y2="84" stroke="${lane}" stroke-width="2" stroke-dasharray="3 5" stroke-linecap="round"/>
    <path d="M-7 -40 L0 -50 L7 -40" fill="none" stroke="${lane}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <g class="hint"><path d="M-9 34 L0 44 L9 34" fill="none" stroke="${trailB}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M-9 46 L0 56 L9 46" fill="none" stroke="${trailB}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" opacity=".55"/></g>
    ${ticks}
    <circle r="95" fill="none" stroke="${ring}" stroke-width="5" class="top-ring"/>
    <text class="push-cue" y="-58" text-anchor="middle">PUSH!</text>
    <path class="trail-b" d="" fill="none" stroke="${trailB}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/>
    <path class="trail-d" d="" fill="none" stroke="${trailD}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity=".95"/>`;
  if (skin === 'f') {
    // a chunky toy stick: cream bezel on a turf disc, a groove you pull the ball down, a power arc that fills
    const arcPt = (f: number, r = 80) => { const a = ((262 - 150 * f) * Math.PI) / 180; return [Math.cos(a) * r, Math.sin(a) * r]; };
    const [ax0, ay0] = arcPt(0), [ax1, ay1] = arcPt(1);
    const beads = [0.25, 0.5, 0.75, 1].map((f, i) => { const [x, y] = arcPt(f); const [lx, ly] = arcPt(f, 66); return `<g class="bead" data-f="${f}"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${i === 3 ? 6 : 4.5}"/></g>`; void lx; void ly; }).join('');
    const stripes = Array.from({ length: 7 }, (_, i) => `<rect x="${-90 + i * 26}" y="-90" width="13" height="180" fill="rgba(255,255,255,.045)"/>`).join('');
    const rays = Array.from({ length: 12 }, (_, i) => { const a = (i / 12) * Math.PI * 2; return `<path d="M${(Math.cos(a) * 30).toFixed(1)} ${(Math.sin(a) * 30).toFixed(1)} L${(Math.cos(a + 0.08) * 46).toFixed(1)} ${(Math.sin(a + 0.08) * 46).toFixed(1)} L${(Math.cos(a - 0.08) * 46).toFixed(1)} ${(Math.sin(a - 0.08) * 46).toFixed(1)} Z"/>`; }).join('');
    return `<svg class="pad-svg pad-f" id="${id}" viewBox="-100 -100 200 200" aria-hidden="true">
    <defs>
      <radialGradient id="${id}b" cx="36%" cy="30%"><stop offset="0" stop-color="#ffffff"/><stop offset=".6" stop-color="#f3f5f8"/><stop offset="1" stop-color="#b9c1cc"/></radialGradient>
      <linearGradient id="${id}r" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fffdf5"/><stop offset=".55" stop-color="#fbeccc"/><stop offset="1" stop-color="#e2c27c"/></linearGradient>
      <radialGradient id="${id}t" cx="45%" cy="35%"><stop offset="0" stop-color="#4fa743"/><stop offset=".7" stop-color="#2e7a32"/><stop offset="1" stop-color="#1d5526"/></radialGradient>
      <linearGradient id="${id}p" gradientUnits="userSpaceOnUse" x1="0" y1="-80" x2="0" y2="80"><stop offset="0" stop-color="#ffe066"/><stop offset=".55" stop-color="#ffb21a"/><stop offset=".85" stop-color="#ff7a1a"/><stop offset="1" stop-color="#e5352b"/></linearGradient>
      <linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#174a2c"/><stop offset=".55" stop-color="#2d6a3a"/><stop offset=".85" stop-color="#8f8a2e"/><stop offset="1" stop-color="#c9a227"/></linearGradient>
      <linearGradient id="${id}cap" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe680"/><stop offset="1" stop-color="#f2a900"/></linearGradient>
      <clipPath id="${id}c"><circle r="82"/></clipPath>
      <filter id="${id}s" x="-60%" y="-60%" width="220%" height="220%"><feDropShadow dx="0" dy="4" stdDeviation="3.2" flood-color="#06142b" flood-opacity=".5"/></filter>
    </defs>
    <circle cy="5" r="95" fill="rgba(6,20,43,.35)"/>
    <circle r="94" fill="#d4b064"/>
    <circle r="91" fill="url(#${id}r)"/>
    <circle r="82" fill="url(#${id}t)"/>
    <g clip-path="url(#${id}c)">${stripes}<circle r="82" fill="none" stroke="rgba(0,0,0,.25)" stroke-width="6"/></g>
    <path d="M${ax0.toFixed(1)} ${ay0.toFixed(1)} A80 80 0 0 0 ${ax1.toFixed(1)} ${ay1.toFixed(1)}" fill="none" stroke="rgba(6,20,43,.45)" stroke-width="15" stroke-linecap="round"/>
    <path class="power-arc" d="M${ax0.toFixed(1)} ${ay0.toFixed(1)} A80 80 0 0 0 ${ax1.toFixed(1)} ${ay1.toFixed(1)}" fill="none" stroke="url(#${id}p)" stroke-width="15" stroke-linecap="round" pathLength="100" stroke-dasharray="0 100"/>
    ${beads}
    <g class="ptarget" visibility="hidden"><line class="pt-ring" stroke="#ff4fa3" stroke-width="5" stroke-linecap="round"/><line class="pt-track" x1="-21" x2="21" stroke="#ff4fa3" stroke-width="4" stroke-linecap="round"/><g class="pt-lab"><rect x="-17" y="-9" width="34" height="18" rx="9" fill="#ff4fa3" stroke="#fff" stroke-width="1.5"/><text y="4.5" text-anchor="middle">150</text></g></g>
    <rect x="-17" y="-74" width="34" height="166" rx="17" fill="url(#${id}g)"/>
    <rect x="-17" y="-74" width="34" height="166" rx="17" fill="none" stroke="rgba(0,0,0,.35)" stroke-width="3"/>
    <rect x="-15.5" y="-72.5" width="31" height="163" rx="15.5" fill="none" stroke="rgba(255,246,227,.22)" stroke-width="1.2"/>
    <g class="hint"><path d="M-10 26 L0 36 L10 26" fill="none" stroke="#ffd23f" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M-10 39 L0 49 L10 39" fill="none" stroke="#ffd23f" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" opacity=".5"/></g>
    <path class="trail-b" d="" fill="#ffd23f" opacity=".95"/>
    <path class="trail-d" d="" fill="#5ff0a0" opacity=".95"/>
    <circle r="95" fill="none" stroke="#ffd23f" stroke-width="7" class="top-ring"/>
    <g class="push-cue-f" transform="translate(0 -58)"><rect x="-34" y="-15" width="68" height="28" rx="14" fill="#c8102e" stroke="#fff" stroke-width="2.5"/><text y="6" text-anchor="middle">PUSH!</text></g>
    <g class="puck-shadow"><ellipse cy="22" rx="20" ry="5" fill="rgba(0,0,0,.32)"/></g>
    <g class="puck"><g class="burst" fill="#ffd23f">${rays}</g><g class="strike-ring"><circle r="26" fill="none" stroke="#fff" stroke-width="4"/></g><g class="puck-body"><g filter="url(#${id}s)"><circle r="25" fill="#fff"/></g><image class="puck-img" href="${puckURL()}" x="-25.5" y="-25.5" width="51" height="51"/></g></g></svg>`;
  }
  if (skin === 'a') return `<svg class="pad-svg" id="${id}" viewBox="-100 -100 200 200" aria-hidden="true">
    <circle r="92" fill="rgba(8,18,42,.55)"/><circle r="92" fill="none" stroke="#fff" stroke-width="2"/>
    ${Array.from({ length: 36 }, (_, i) => { const a = i * Math.PI / 18, r0 = i % 9 === 0 ? 80 : 85; return `<line x1="${(Math.cos(a) * r0).toFixed(1)}" y1="${(Math.sin(a) * r0).toFixed(1)}" x2="${(Math.cos(a) * 90).toFixed(1)}" y2="${(Math.sin(a) * 90).toFixed(1)}" stroke="rgba(255,255,255,.4)" stroke-width="${i % 9 === 0 ? 2 : 1}"/>`; }).join('')}
    ${common('rgba(255,255,255,.45)', 'rgba(255,255,255,.55)', '#a9b8d3', '#ffc72c', '#2fd3ff', '#ffc72c')}
    <g class="puck"><circle r="22" fill="#fff"/><circle r="15" fill="none" stroke="#ffc72c" stroke-width="3"/><circle r="5" fill="#0a1630"/></g></svg>`;
  if (skin === 'b') return `<svg class="pad-svg" id="${id}" viewBox="-100 -100 200 200" aria-hidden="true">
    <defs><radialGradient id="${id}f" cx="40%" cy="35%"><stop offset="0" stop-color="#f7f0dc"/><stop offset="1" stop-color="#ddcfa8"/></radialGradient>
    <linearGradient id="${id}b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f1d68f"/><stop offset=".5" stop-color="#a97f2c"/><stop offset="1" stop-color="#e8c777"/></linearGradient>
    <radialGradient id="${id}p" cx="38%" cy="32%"><stop offset="0" stop-color="#2f7a52"/><stop offset="1" stop-color="#0f3a25"/></radialGradient></defs>
    <circle r="92" fill="url(#${id}f)" opacity=".92"/><circle r="88" fill="none" stroke="url(#${id}b)" stroke-width="8"/><circle r="80" fill="none" stroke="rgba(16,48,31,.25)" stroke-width="1"/>
    ${common('rgba(16,48,31,.55)', 'rgba(16,48,31,.6)', '#5b5236', '#9b7425', '#10301f', '#d4ad57')}
    <g class="puck"><circle r="23" fill="url(#${id}b)"/><circle r="19" fill="url(#${id}p)"/><path d="M-4 -8 h8 l-2.5 5 v10 h-3 v-10 z" fill="#f4ecd8"/></g></svg>`;
  return `<svg class="pad-svg" id="${id}" viewBox="-100 -100 200 200" aria-hidden="true">
    <defs><radialGradient id="${id}f" cx="50%" cy="30%"><stop offset="0" stop-color="#4f7bff"/><stop offset="1" stop-color="#0b1f8a"/></radialGradient>
    <linearGradient id="${id}c" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".45" stop-color="#9aa6bf"/><stop offset=".55" stop-color="#5b6680"/><stop offset="1" stop-color="#e6ebf5"/></linearGradient>
    <radialGradient id="${id}p" cx="40%" cy="30%"><stop offset="0" stop-color="#fffbb0"/><stop offset=".55" stop-color="#ffd400"/><stop offset="1" stop-color="#ff8a00"/></radialGradient></defs>
    <circle r="92" fill="url(#${id}f)" opacity=".9"/><circle r="88" fill="none" stroke="url(#${id}c)" stroke-width="10"/>
    <path d="M-70 -50 A86 86 0 0 1 70 -50" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="3" stroke-linecap="round"/>
    ${common('#ffe234', 'rgba(255,255,255,.75)', '#bcd0ff', '#ffe234', '#5cff8a', '#5cff8a')}
    <g class="puck"><circle r="23" fill="#0a1450"/><circle r="21" fill="url(#${id}p)" stroke="#fff" stroke-width="2"/><path d="M0 -10 L2.9 -3.6 L9.5 -3.1 L4.5 1.3 L5.9 8 L0 4.6 L-5.9 8 L-4.5 1.3 L-9.5 -3.1 L-2.9 -3.6 Z" fill="#0b1a7a"/></g></svg>`;
}

// ── spin ball ──
const SKIN_COL: Record<Skin, { ring: string; acc: string; acc2: string; back: string }> = {
  f: { ring: 'rgba(255,246,227,.55)', acc: '#ffd23f', acc2: '#5ff0a0', back: 'rgba(19,41,75,.6)' },
  a: { ring: 'rgba(255,255,255,.25)', acc: '#ffc72c', acc2: '#2fd3ff', back: 'rgba(8,18,42,.72)' },
  b: { ring: 'rgba(244,236,216,.3)', acc: '#d4ad57', acc2: '#9fd38a', back: 'rgba(13,44,29,.82)' },
  c: { ring: 'rgba(255,255,255,.4)', acc: '#ffe234', acc2: '#5cff8a', back: 'rgba(11,31,138,.82)' },
};
function drawSpinBall(cv: HTMLCanvasElement, m: Mat3, spin: { x: number; y: number }, skin: Skin, active: boolean, blur?: { axis: number[]; d: number }) {
  const ctx = cv.getContext('2d')!, k = cv.width / 136, c = SKIN_COL[skin];
  ctx.setTransform(k, 0, 0, k, 0, 0); ctx.clearRect(0, 0, 136, 136);
  const cx = 68, cy = 67, R = 43, mag = Math.hypot(spin.x, spin.y);
  // tactile bezel: cream ring with a toy bottom edge
  ctx.fillStyle = 'rgba(6,20,43,.35)'; ctx.beginPath(); ctx.arc(cx, cy + 3, 64, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#d4b064'; ctx.beginPath(); ctx.arc(cx, cy + 1.5, 63, 0, Math.PI * 2); ctx.fill();
  const bz = ctx.createLinearGradient(0, cy - 62, 0, cy + 62); bz.addColorStop(0, '#fffdf5'); bz.addColorStop(0.6, '#fbeccc'); bz.addColorStop(1, '#e2c27c');
  ctx.fillStyle = bz; ctx.beginPath(); ctx.arc(cx, cy, 62, 0, Math.PI * 2); ctx.fill();
  const well = ctx.createRadialGradient(cx, cy - 6, 30, cx, cy, 54); well.addColorStop(0, '#24467a'); well.addColorStop(1, '#0f2140');
  ctx.fillStyle = well; ctx.beginPath(); ctx.arc(cx, cy, 53, 0, Math.PI * 2); ctx.fill();
  // spin amount: the groove fills from the top with colour (mint → gold → red as you load it up)
  ctx.lineCap = 'round'; ctx.lineWidth = 7; ctx.strokeStyle = 'rgba(6,20,43,.5)'; ctx.beginPath(); ctx.arc(cx, cy, 57.5, 0, Math.PI * 2); ctx.stroke();
  if (mag > 0.01) {
    const col = mag < 0.45 ? '#5ff0a0' : mag < 0.8 ? '#ffc21a' : '#ff5a3c';
    ctx.strokeStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.arc(cx, cy, 57.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * mag); ctx.stroke(); ctx.shadowBlur = 0;
  }
  for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; ctx.fillStyle = 'rgba(19,41,75,.35)'; ctx.beginPath(); ctx.arc(cx + Math.cos(a) * 57.5, cy + Math.sin(a) * 57.5, 1.1, 0, 7); ctx.fill(); }
  // the ball
  const sh = ctx.createRadialGradient(cx + 3, cy + 7, R * 0.5, cx + 3, cy + 7, R * 1.1);
  sh.addColorStop(0, 'rgba(0,0,0,.45)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = sh; ctx.beginPath(); ctx.arc(cx + 3, cy + 7, R * 1.1, 0, Math.PI * 2); ctx.fill();
  const px = Math.round(R * 2 * k);
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (blur && blur.d > 0.02) {
    // motion blur at high spin: the ball shaded at a few angles across one frame's turn, layered
    const n = 3;
    for (let i = 0; i < n; i++) { const mm = m.slice(); mat3RotateAxis(mm, blur.axis[0], blur.axis[1], blur.axis[2], (i / (n - 1) - 0.5) * blur.d); ctx.globalAlpha = i === 0 ? 1 : 1 / (i + 1); ctx.drawImage(shadeBall(px, mm), Math.round((cx - R) * k), Math.round((cy - R) * k)); }
    ctx.globalAlpha = 1;
  } else ctx.drawImage(shadeBall(px, m), Math.round((cx - R) * k), Math.round((cy - R) * k));
  ctx.restore();
  if (mag > 0.03) {
    // a comet sweeping across the ball's face in the spin direction, curving with the surface
    const ang = Math.atan2(-spin.y, spin.x), len = 0.5 + 0.45 * mag;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(ang);
    const x0 = -R * 0.55 * len, x1 = R * 0.62 * len, bow = R * 0.22;
    const g = ctx.createLinearGradient(x0, 0, x1, 0); g.addColorStop(0, 'rgba(255,210,63,0)'); g.addColorStop(1, 'rgba(255,190,30,.95)');
    ctx.strokeStyle = g; ctx.lineWidth = 7; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x0, bow * 0.6); ctx.quadraticCurveTo(0, -bow, x1, bow * 0.15); ctx.stroke();
    ctx.fillStyle = '#ffb21a'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x1 + 10, bow * 0.1); ctx.lineTo(x1 - 4, -8 + bow * 0.1); ctx.lineTo(x1 - 2, 8 + bow * 0.25); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
  } else if (active) {
    ctx.strokeStyle = 'rgba(255,246,227,.7)'; ctx.lineWidth = 2; ctx.setLineDash([2, 6]); ctx.beginPath(); ctx.arc(cx, cy, R + 5, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
  }
  void c;
}
export const spinWords = (s: { x: number; y: number }) => {
  const parts: string[] = [];
  if (Math.abs(s.y) > 0.05) parts.push(`${s.y < 0 ? 'Backspin' : 'Topspin'} ${Math.round(Math.abs(s.y) * 100)}`);
  if (Math.abs(s.x) > 0.05) parts.push(`${s.x < 0 ? 'Left' : 'Right'} ${Math.round(Math.abs(s.x) * 100)}`);
  return parts.join(' · ');
};

export interface CardData {
  plan: ShotPlan; power: number; offMs: number;
  carry?: number; total?: number; offline?: number; apex?: number; done: boolean;
  /** the flight as flown, in yards: f = along the aim line, s = to the right of it, h = height; land = index of touchdown */
  path?: { f: number; s: number; h: number }[]; land?: number; aimYds?: number;
  /** side curve vs the start line at touchdown (yards, + = bent right) and the spin the player added in the air */
  curveYds?: number; addSpin?: { x: number; y: number }; lefty?: boolean;
}

const curveTxt = (c: CardData) => {
  const v = c.curveYds; if (v === undefined) return c.plan.shape;
  if (Math.abs(v) < 1.5) return 'Straight';
  const right = v > 0, draw = c.lefty ? right : !right;
  const a = Math.abs(v), name = a > 24 ? (draw ? 'Duck hook' : 'Banana slice') : a > 11 ? (draw ? 'Hook' : 'Slice') : (draw ? 'Draw' : 'Cut');
  return `${name} · ${a.toFixed(0)} yds`;
};
const spinTxt = (c: CardData) => {
  const s = c.addSpin; if (!s) return '';
  const tilt = c.plan.launch.tilt;
  const parts = [s.y < -0.05 ? '+backspin' : s.y > 0.05 ? '+topspin' : '', Math.abs(s.x) > 0.05 ? (s.x < 0 ? '←' : '→') : Math.abs(tilt) > 0.04 ? (tilt < 0 ? '↶' : '↷') : ''].filter(Boolean);
  return parts.length ? ` <small>${parts.join(' ')}</small>` : '';
};
/** Shot details sketch: top-down flight (dashed aim line, target ring, flight, roll) and a little side view with the apex */
function shotSketch(c: CardData) {
  const P = c.path!, L = Math.max(1, Math.min(P.length - 1, c.land ?? P.length - 1)), aimY = c.aimYds ?? (c.carry ?? 100);
  const fMax = Math.max(aimY, ...P.map(p => p.f)) * 1.08, W = 268, H = 92, pad = 12;
  const sx = (f: number) => pad + (f / fMax) * (W - 2 * pad), EX = 3;   // lateral exaggerated ×3 so the shape reads
  const sy = (s: number) => H / 2 + Math.max(-H / 2 + 8, Math.min(H / 2 - 8, s * EX * ((W - 2 * pad) / fMax)));
  const pts = (a: number, b: number) => P.slice(a, b + 1).map(p => `${sx(p.f).toFixed(1)},${sy(p.s).toFixed(1)}`).join(' ');
  const end = P[P.length - 1], ld = P[L], rr = Math.max(5, (3 + 0.06 * aimY) * ((W - 2 * pad) / fMax) * 1.4);
  const top = `<svg class="sk-top" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <rect x="0" y="0" width="${W}" height="${H}" rx="14" fill="#e9f5df"/>
    ${[0.2, 0.4, 0.6, 0.8].map(k => `<line x1="${sx(fMax * k).toFixed(1)}" x2="${sx(fMax * k).toFixed(1)}" y1="6" y2="${H - 6}" stroke="#cfe5c2" stroke-width="1"/>`).join('')}
    <line x1="${sx(0)}" y1="${H / 2}" x2="${sx(aimY)}" y2="${H / 2}" stroke="#13294b" stroke-width="1.6" stroke-dasharray="4 4" opacity=".55"/>
    <ellipse cx="${sx(aimY).toFixed(1)}" cy="${H / 2}" rx="${(rr * 0.55).toFixed(1)}" ry="${rr.toFixed(1)}" fill="rgba(242,169,0,.14)" stroke="#f2a900" stroke-width="2"/>
    <polyline points="${pts(0, L)}" fill="none" stroke="#f2a900" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
    <polyline points="${pts(L, P.length - 1)}" fill="none" stroke="#13294b" stroke-width="2" stroke-dasharray="2 3" stroke-linecap="round"/>
    <circle cx="${sx(0)}" cy="${H / 2}" r="4" fill="#fff" stroke="#13294b" stroke-width="1.5"/>
    <circle cx="${sx(ld.f).toFixed(1)}" cy="${sy(ld.s).toFixed(1)}" r="3" fill="#f2a900"/>
    <circle cx="${sx(end.f).toFixed(1)}" cy="${sy(end.s).toFixed(1)}" r="4.2" fill="#fff" stroke="#c8102e" stroke-width="2"/>
  </svg>`;
  const hMax = Math.max(1, ...P.map(p => p.h)), SH = 46, ai = P.reduce((m, p, i) => p.h > P[m].h ? i : m, 0);
  const hy = (h: number) => SH - 6 - (h / hMax) * (SH - 16);
  const side = `<svg class="sk-side" viewBox="0 0 ${W} ${SH}" aria-hidden="true">
    <line x1="${pad}" x2="${W - pad}" y1="${SH - 6}" y2="${SH - 6}" stroke="#7cc95a" stroke-width="3" stroke-linecap="round"/>
    <polyline points="${P.slice(0, L + 1).map(p => `${sx(p.f).toFixed(1)},${hy(p.h).toFixed(1)}`).join(' ')}" fill="none" stroke="#f2a900" stroke-width="2.6" stroke-linecap="round"/>
    <circle cx="${sx(P[ai].f).toFixed(1)}" cy="${hy(P[ai].h).toFixed(1)}" r="3.4" fill="#13294b"/>
    <text x="${(sx(P[ai].f) + 6).toFixed(1)}" y="${(hy(P[ai].h) + 3).toFixed(1)}" class="sk-lab">apex ${(c.apex ?? P[ai].h).toFixed(0)} yds</text>
  </svg>`;
  return `<div class="sc-shape">${top}${side}</div>`;
}

export class Hud {
  readonly el: HTMLDivElement;
  skin: Skin = 'f';
  club = 6; mode: ShotMode = 'full'; lie = 0;
  readonly pad: HTMLDivElement;
  readonly spinCv: HTMLCanvasElement;
  spin = { x: 0, y: 0 };
  private spinM: Mat3 = mat3Identity();
  private spinHint = true;
  /** where the club meets the ball: x +1 = outer half (fades), -1 = inner half (draws); y +1 = top (flies lower), -1 = bottom (flies higher) */
  strike = { x: 0, y: 0 };
  onStrike: (s: { x: number; y: number }) => void = () => {};
  private strikeUsed = false;
  private spinOn = false;
  private spinDrag: [number, number] | null = null;
  private toastT = 0;
  private cardTimer = 0;
  private cardMode: 'hidden' | 'open' | 'mini' = 'hidden';
  private cardInit = false;
  private ticks: Record<string, number> = {};
  onClub: (i: number) => void = () => {};
  onMode: (m: ShotMode) => void = () => {};
  onLie: (i: number) => void = () => {};

  constructor(parent: HTMLElement, private profile: GolferProfile) {
    const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
    this.el = document.createElement('div'); this.el.className = 'hud skin-a';
    this.el.innerHTML = `
      <div class="corner tl"><div class="ed" id="ed" aria-live="polite"><b class="ed-n">165</b><small class="ed-c">YARDS</small><i class="ed-rule" aria-hidden="true"></i></div><div class="row"><div id="modeSlot"></div></div><div class="who" id="who"></div><div class="pop hud-panel" id="modePop" hidden></div></div>
      <div class="corner tr"><div id="lieSlot"></div><div class="wind-chip" id="wind" role="img" aria-label="No wind"><svg viewBox="-12 -12 24 24" aria-hidden="true"><circle r="11" class="wc-ring"/><g class="wc-arrow"><path d="M0 -8 L5 -1 L1.8 -1 L1.8 7 L-1.8 7 L-1.8 -1 L-5 -1 Z"/></g></svg><b>0</b><small>mph</small></div></div>
      <div class="corner bl"><div id="cardSlot"><div class="card-wrap" id="cardWrap"><button type="button" class="hud-panel card-mini" data-act="card-open" aria-expanded="false"></button><div class="card-body" id="cardBody"></div></div></div></div>
      <div class="corner br"><button type="button" class="strike-btn" data-act="strike" aria-label="Strike point: centre. Choose where to hit the ball"><canvas width="112" height="112" aria-hidden="true"></canvas><i class="dot" aria-hidden="true"></i><span>Strike</span></button><div class="pad" id="pad" aria-label="Swing pad: press, pull down, push up"></div><div class="club-dock" id="clubSlot"></div><div class="pop hud-panel club-sheet" id="clubPop" hidden></div></div>
      <div class="corner bc"><div class="spin off" id="spin"><canvas width="408" height="408" aria-label="Spin ball: swipe to add spin"></canvas><div class="spin-label" id="spinLabel">Swipe the ball to add spin</div></div></div>
      <div class="toast" id="toast"></div>
      <div class="confetti" id="confetti" aria-hidden="true"></div>
      <div class="strike-pop" id="strikePop" hidden><div class="sp-card" role="dialog" aria-modal="true" aria-labelledby="spTitle">
        <div class="sp-head"><b id="spTitle">Strike point</b><small id="spRead">Dead centre</small></div>
        <div class="sp-ball" id="spBall"><canvas width="440" height="440" aria-hidden="true"></canvas>
          <span class="sp-lab t">Lower</span><span class="sp-lab b">Higher</span><span class="sp-lab l">Cut</span><span class="sp-lab r">Draw</span>
          <i class="sp-cross" aria-hidden="true"></i><button type="button" class="sp-ret" id="spRet" aria-label="Strike target. Drag, or use the arrow keys"></button></div>
        <div class="sp-btns"><button type="button" class="sp-btn ghost" data-act="strike-centre">Centre</button><button type="button" class="sp-btn" data-act="strike-done">Done</button></div>
      </div></div>`;
    document.documentElement.style.setProperty('--crest', `url("${crestUrl}")`);
    document.documentElement.style.setProperty('--portrait', `url("${portraitUrl}")`);
    parent.appendChild(this.el);
    this.pad = this.el.querySelector('#pad')!;
    this.spinCv = this.el.querySelector('#spin canvas')!;
    // one look for players: the playful 'f' skin (older a/b/c looks stay in code for the concept board only)
    this.skin = 'f';
    this.el.addEventListener('click', e => this.click(e));
    this.el.addEventListener('keydown', e => { const t = e.target as HTMLElement; if ((e.key === 'Enter' || e.key === ' ') && t.matches('.card.simple')) { e.preventDefault(); t.click(); } });
    this.initStrike();
    this.spinCv.addEventListener('pointerdown', e => { if (!this.spinOn) return; this.spinCv.setPointerCapture(e.pointerId); this.spinDrag = [e.clientX, e.clientY]; e.preventDefault(); this.q('#spin').classList.add('grab', 'used'); try { navigator.vibrate?.(8); } catch { /* not allowed */ } });
    this.spinCv.addEventListener('pointermove', e => {
      if (!this.spinDrag || !this.spinOn) return;
      const r = this.spinCv.getBoundingClientRect(), k = 136 / r.width;
      const dx = (e.clientX - this.spinDrag[0]) * k, dy = (e.clientY - this.spinDrag[1]) * k; this.spinDrag = [e.clientX, e.clientY];
      let sx = this.spin.x + dx / 150, sy = this.spin.y - dy / 150; const m = Math.hypot(sx, sy); if (m > 1) { sx /= m; sy /= m; }
      this.spin = { x: sx, y: sy };
      this.spinLabel();
    });
    const end = () => { this.spinDrag = null; this.q('#spin').classList.remove('grab'); };
    this.spinCv.addEventListener('pointerup', end); this.spinCv.addEventListener('pointercancel', end);
    this.setSkin(this.skin);
    onBallTexUpdate(() => drawSpinBall(this.spinCv, this.spinM, this.spin, this.skin, this.spinOn));
    this.fit(); addEventListener('resize', () => this.fit());
    window.visualViewport?.addEventListener('resize', () => this.fit());
    window.visualViewport?.addEventListener('scroll', () => this.fit());
    addEventListener('orientationchange', () => setTimeout(() => this.fit(), 250));
  }

  /** state classes for layout: ready (waiting for a swing), flying (ball in the air), idle (no shot yet) */
  setState(ready: boolean, flying: boolean, idle: boolean) {
    if (ready && this.strikeUsed) { this.strikeUsed = false; if (this.strike.x || this.strike.y) this.setStrike(0, 0); } this.el.classList.toggle('ready', ready); this.el.classList.toggle('flying', flying); this.el.classList.toggle('idle', idle); }

  fit() {
    const { w: W, h: H, top } = viewport();
    const root = document.documentElement.style;
    root.setProperty('--app-h', H + 'px'); root.setProperty('--app-top', top + 'px');
    const portrait = H > W * 1.05;
    this.el.classList.toggle('phone', isPhone());
    this.el.classList.toggle('short', portrait && H / W < 1.62);   // phones with browser bars showing (SE, 13 + Chrome)
    // portrait: fit by width AND height so the chips, the golfer and the stick all fit on screen
    const s = portrait ? clamp(Math.min(W / 430, H / 800), 0.62, 1.15) : clamp(Math.min(W / 960, H / 540), 0.42, 1.35);
    this.el.style.setProperty('--s', String(s));
  }

  setSkin(k: Skin) {
    const keep = ['hidden', 'ready', 'flying', 'idle', 'phone', 'spin-on'].filter(c => this.el.classList.contains(c));
    this.skin = k; this.el.className = ['hud', 'skin-' + k, ...keep].join(' ');
    this.pad.innerHTML = padSVG(k);
    this.render();
    drawSpinBall(this.spinCv, this.spinM, this.spin, k, this.spinOn);
    try { localStorage.setItem('golf-skin-v2', k); } catch { /* storage blocked */ }
  }

  private q<T extends HTMLElement>(sel: string) { return this.el.querySelector(sel) as T; }

  render(card?: CardData | null) {
    const id = CLUB_SPECS[this.club].id, M = MODES[this.mode];
    const [badge, cname] = clubUI(id);
    this.q('#clubSlot').innerHTML = `<button type="button" class="hud-panel club-btn" data-act="club" aria-label="Club: ${cname}, ${M.label} shot, ${M.max(id)} yards. Change club or shot"><span class="eyebrow-h">Club</span><span class="big${badge.length > 2 ? ' sm' : ''}">${badge}</span><span class="yds">${M.max(id)}<small>yds</small></span><span class="cap">${cname}${this.mode !== 'full' ? ` · <em>${M.label}</em>` : ''}</span></button>`;
    this.q('#modeSlot').innerHTML = '';
    const L = LIES[this.lie];
    const [word, q, kind] = LIE_WORD[L.name] ?? ['Okay', 'ok', 'fairway'];
    const where = L.side ? (L.side < 0 ? 'ball above feet, starts left' : 'ball below feet, starts right') : 'flat';
    this.q('#lieSlot').innerHTML = this.skin === 'f'
      ? `<button type="button" class="hud-panel lie-card lie-w" data-act="lie" aria-label="Lie: ${L.name}, ${word}, ${L.pct} percent distance, ${L.slope} degree slope, ball ${where}. Tap for another sample lie">
        ${lieScene(L.slope, L.side, kind)}
        <span class="lie-txt"><span class="lie-name${L.name.length > 10 ? ' long' : ''}">${L.name}</span><span class="lie-q ${q}">${word} · ${L.pct}%</span>
        <span class="lie-slope ${L.slope === 0 ? 'flat' : L.slope <= 3 ? 'mid' : 'steep'}"><b>${L.slope}°</b><small>${L.slope === 0 ? 'flat' : `${L.side < 0 ? '▲ above feet' : '▼ below feet'}`}</small></span></span></button>`
      : `<button type="button" class="hud-panel lie-card" data-act="lie" aria-label="Lie: ${L.name}, ${L.pct} percent, slope ${L.slope} degrees. Tap for another sample lie"><span class="eyebrow-h">Lie</span>
      <span class="lie-top">${lieRing(L.pct)}<span><span class="big" style="display:block">${L.name}</span><span class="sub">${L.pct}% distance</span></span></span>
      <span class="slope">${slopeIcon(L.slope, L.side)}<span class="deg">${L.slope}°</span><span class="sub">${L.txt}</span></span></button>`;
    const p = this.profile;
    if (!this.q('#who').querySelector('.face-wrap')) this.q('#who').innerHTML = `<button type="button" class="hud-panel who-chip" data-act="skin" aria-label="Player: ${p.name}"><i class="avatar" aria-hidden="true"></i><b>${p.name}</b></button>`;
    if (card !== undefined) this.card(card);
    else if (!this.cardInit) this.card(null);
    const cp = this.q('#clubPop'), mp = this.q('#modePop');
    if (!cp.hidden) cp.innerHTML = this.clubList();
    if (!mp.hidden) mp.innerHTML = this.modeList();
  }

  private setCard(mode: 'hidden' | 'open' | 'mini') {
    this.cardMode = mode;
    const w = this.q('#cardWrap');
    w.classList.toggle('show', mode !== 'hidden'); w.classList.toggle('mini', mode === 'mini');
    w.querySelector('.card-mini')!.setAttribute('aria-expanded', String(mode === 'open'));
  }
  private later(ms: number, fn: () => void) { clearTimeout(this.cardTimer); this.cardTimer = window.setTimeout(fn, ms); }
  private collapse() { this.setCard(isPhone() ? 'hidden' : 'mini'); }

  /** Last-swing card. Phones: pops in when the ball lands, leaves ~2.5 s after it stops. Elsewhere: shows,
   *  then shrinks to a pill you can tap to open again. */
  card(c: CardData | null) {
    this.cardInit = true;
    const body = this.q('#cardBody'), mini = this.q('.card-mini');
    const phone = isPhone();
    if (!c) {
      this.ticks = {};
      body.innerHTML = `<div class="hud-panel card how"><button type="button" class="card-min" data-act="card-min" aria-label="Minimise">&minus;</button><span class="eyebrow-h">How to swing</span><ol><li>Press the ball on the pad</li><li>Pull straight down. Further is longer</li><li>When the ring flashes, push straight up</li><li>Swipe the spin ball in the air</li></ol></div>`;
      mini.innerHTML = `<i class="q">?</i><b>How to swing</b><span class="chev" aria-hidden="true"></span>`;
      if (phone) this.setCard('hidden'); else { this.setCard('open'); this.later(9000, () => this.collapse()); }
      return;
    }
    const lo = -400, hi = 700, pos = (v: number) => ((clamp(v, lo, hi) - lo) / (hi - lo) * 100).toFixed(1);
    const side = (v: number) => Math.abs(v) < 0.5 ? 'Online' : `${Math.abs(v).toFixed(0)} ${v < 0 ? 'L' : 'R'}`;
    const P = c.plan;
    if (c.carry === undefined) this.ticks = {};
    const tick = (k: string, v: number | undefined, done = true) => {
      if (v === undefined || !done) return `<dd>…</dd>`;
      const from = this.ticks[k]; this.ticks[k] = v;
      return `<dd data-tick="${v.toFixed(0)}" data-from="${from === undefined ? 0 : from.toFixed(0)}">${from === undefined && !reduced() ? 0 : v.toFixed(0)}</dd>`;
    };
    // at a glance: tempo word + tiny bar, one big carry/total line, one small shape/offline line; tap for the rest
    const off = c.done && c.offline !== undefined ? side(c.offline) : '';
    const more = true;   // opened on purpose from the pill: show everything
    body.innerHTML = `<div class="hud-panel card simple${more ? ' more' : ''}" data-act="card-more" role="button" tabindex="0" aria-expanded="${more}" aria-label="Last swing: ${P.tempoWord}. Tap for details"><button type="button" class="card-min" data-act="card-min" aria-label="Minimise">&minus;</button>
      <div class="sc-top"><b class="tempo-word ${P.tempoCls}">${P.tempoWord}</b><span class="sc-tempo" aria-hidden="true"><i class="win" style="left:${pos(-70)}%;width:${(+pos(160) - +pos(-70)).toFixed(1)}%"></i><i class="mark ${P.tempoCls}" style="left:${pos(c.offMs)}%"></i></span></div>
      <div class="sc-main"><span class="sc-n"><small>Carry</small>${tick('carry', c.carry).replace('<dd', '<b').replace('</dd>', '</b>')}</span><span class="sc-n"><small>Total</small>${tick('total', c.total, c.done).replace('<dd', '<b').replace('</dd>', '</b>')}</span><small class="sc-u">yds</small></div>
      <div class="sc-sub"><span>${P.shape}</span>${off ? `<i></i><span>${off}</span>` : ''}<span class="sc-more-cue" aria-hidden="true">${more ? 'less' : 'more'}</span></div>
      <dl class="stats sc-more">
        <div><dt>Power</dt><dd>${Math.round(c.power * 100)}%</dd></div>
        <div><dt>Takeaway</dt><dd class="${P.driftCls}">${P.driftWord}</dd></div>
        <div><dt>Timing</dt><dd>${c.offMs > 0 ? '+' : ''}${Math.round(c.offMs)} ms</dd></div>
        <div><dt>Launch</dt><dd>${(P.launch.launch * 180 / Math.PI).toFixed(1)}°</dd></div>
        <div><dt>Curve</dt><dd>${curveTxt(c)}</dd></div>
        <div><dt>Spin</dt><dd>${Math.round(P.launch.spinRpm / 50) * 50} rpm${spinTxt(c)}</dd></div>
        <div><dt>Apex</dt><dd>${c.apex !== undefined ? c.apex.toFixed(0) + ' yds' : '…'}</dd></div>
      </dl>${c.done && c.path && c.path.length > 3 ? shotSketch(c) : ''}</div>`;
    const yd = c.done && c.total !== undefined ? `${c.total.toFixed(0)} yds` : c.carry !== undefined ? `${c.carry.toFixed(0)} carry` : 'in the air';
    mini.innerHTML = `<i class="dot ${P.tempoCls}"></i><b>${yd}</b><span>Shot details</span><span class="chev" aria-hidden="true"></span>`;
    this.runTicks();
    // a clean screen: the numbers stay out of the way; once the ball stops a small 'Shot details' pill offers them
    void phone;
    if (!c.done) { if (this.cardMode !== 'open') this.setCard('hidden'); clearTimeout(this.cardTimer); }
    else if (this.cardMode !== 'open') { this.setCard('mini'); this.later(6000, () => this.setCard('hidden')); }
  }
  /** count numbers up to their value */
  private runTicks() {
    if (reduced()) return;
    this.el.querySelectorAll<HTMLElement>('#cardBody [data-tick]').forEach(el => {
      const to = +el.dataset.tick!, from = +el.dataset.from!;
      if (from === to) return;
      const t0 = performance.now(), dur = 650;
      const step = (t: number) => {
        const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
        el.textContent = String(Math.round(from + (to - from) * e));
        if (k < 1 && el.isConnected) requestAnimationFrame(step); else el.classList.add('landed');
      };
      requestAnimationFrame(step);
    });
  }

  private clubList() {
    const M = MODES[this.mode], id = CLUB_SPECS[this.club].id;
    // shot type for the selected club (only the ones it can play), then the clubs at that shot type's yardage
    const seg = (Object.keys(MODES) as ShotMode[]).filter(k => MODES[k].ok(id)).map(k => `<button type="button" data-mode="${k}" aria-pressed="${k === this.mode}">${MODES[k].label}</button>`).join('');
    return `<div class="seg" role="group" aria-label="Shot type">${seg}</div><div class="list clubs" role="group" aria-label="Clubs">${CLUB_SPECS.map((c, i) => { const ok = M.ok(c.id); const [b, n] = clubUI(c.id); return `<button type="button" data-club="${i}" aria-pressed="${i === this.club}" aria-label="${n}, ${ok ? M.max(c.id) : MODES.full.max(c.id)} yards"><b>${b === 'D' ? 'Dr' : b}</b><span>${ok ? M.max(c.id) : MODES.full.max(c.id)} yds</span></button>`; }).join('')}</div>`;
  }
  private modeList() {
    const id = CLUB_SPECS[this.club].id;
    return `<div class="list modes" role="group" aria-label="Swing modes">${(Object.keys(MODES) as ShotMode[]).map(k => `<button type="button" data-mode="${k}" aria-pressed="${k === this.mode}" ${MODES[k].ok(id) ? '' : 'disabled'}>${modeGlyph(k)}<b>${MODES[k].label}</b><span>${MODES[k].rule}</span></button>`).join('')}</div>`;
  }
  closePops() { this.q('#clubPop').hidden = true; this.q('#modePop').hidden = true; }

  private click(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const a = t.closest('[data-act]') as HTMLElement | null, cb = t.closest('[data-club]') as HTMLButtonElement | null, mb = t.closest('[data-mode]') as HTMLButtonElement | null;
    const cp = this.q('#clubPop'), mp = this.q('#modePop');
    if (cb && !cb.disabled) {
      this.club = +cb.dataset.club!; cp.hidden = true;
      if (!MODES[this.mode].ok(CLUB_SPECS[this.club].id)) { this.mode = 'full'; this.render(); this.onMode(this.mode); }
      this.render(); this.onClub(this.club); return;
    }
    if (mb && !mb.disabled) { this.mode = mb.dataset.mode as ShotMode; this.render(); cp.innerHTML = this.clubList(); this.onMode(this.mode); return; }
    if (!a) { if (!t.closest('.pop')) this.closePops(); return; }
    const act = a.dataset.act;
    if (act === 'club') { mp.hidden = true; cp.hidden = !cp.hidden; cp.innerHTML = this.clubList(); }
    if (act === 'mode') { cp.hidden = true; mp.hidden = !mp.hidden; mp.innerHTML = this.modeList(); }
    if (act === 'lie') {
      this.closePops();
      this.lie = (this.lie + 1) % LIES.length; this.render(); this.onLie(this.lie);   // tap for another sample lie
    }
    if (act === 'skin') { a.classList.remove('wiggle'); void a.offsetWidth; a.classList.add('wiggle'); }
    if (act === 'card-open') { if (this.cardMode === 'open') this.setCard('hidden'); else { this.setCard('open'); this.later(9000, () => this.setCard('hidden')); } }
    if (act === 'card-more' && !t.closest('.card-min')) { const k = a.classList.toggle('more'); a.setAttribute('aria-expanded', String(k)); const cue = a.querySelector('.sc-more-cue'); if (cue) cue.textContent = k ? 'less' : 'more'; this.later(k ? 6000 : 2500, () => this.collapse()); }
    if (act === 'strike') { this.closePops(); this.openStrike(true); }
    if (act === 'strike-centre') { this.setStrike(0, 0); }
    if (act === 'strike-done') { this.openStrike(false); }
    if (act === 'card-min') { clearTimeout(this.cardTimer); this.collapse(); }
  }

  // ── swing pad drawing ──
  private padTop = false; private padStruck = false;
  /** the pull that carries the ball to the aim distance (0..1), or null at full; hint when even a full swing's minimum is too far */
  private pTarget: number | null = null; private pOn = false;
  setPowerTarget(f: number | null, yds: number, hint = '') {
    const key = `${f === null ? 'x' : f.toFixed(3)}|${Math.round(yds)}|${hint}`;
    if ((this as any)._ptk === key) return; (this as any)._ptk = key;
    this.pTarget = f;
    const svg = this.pad.querySelector('svg'), g = svg?.querySelector<SVGGElement>('.ptarget'); if (!svg || !g) return;
    g.setAttribute('visibility', f === null ? 'hidden' : 'visible');
    this.el.querySelector('#padHint')?.remove();
    if (hint) this.q('.br').insertAdjacentHTML('beforeend', `<div class="pad-hint" id="padHint">${hint}</div>`);
    if (f === null) return;
    const a = ((262 - 150 * f) * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
    const L = g.querySelector('.pt-ring')!; L.setAttribute('x1', (c * 70).toFixed(1)); L.setAttribute('y1', (sn * 70).toFixed(1)); L.setAttribute('x2', (c * 92).toFixed(1)); L.setAttribute('y2', (sn * 92).toFixed(1));
    const T = g.querySelector('.pt-track')!, ty = (f * 80).toFixed(1); T.setAttribute('y1', ty); T.setAttribute('y2', ty);
    g.querySelector('.pt-lab')!.setAttribute('transform', `translate(${(c * 64 - 6).toFixed(1)} ${(sn * 64).toFixed(1)})`);
    g.querySelector('text')!.textContent = String(Math.round(yds));
  }
  setPad(pt: [number, number], trailB: [number, number][], trailD: [number, number][], atTop: boolean) {
    const svg = this.pad.querySelector('svg'); if (!svg) return;
    const puck = svg.querySelector('.puck') as SVGGElement;
    const px = clamp(pt[0], -80, 80), py = clamp(pt[1], -95, 95);
    if (svg.classList.contains('pad-f')) {
      const dragging = trailB.length > 0 && (px !== 0 || py !== 0);
      svg.classList.toggle('dragging', dragging);
      // CSS transforms on SVG use user units: the spring-back on release comes from the transition
      puck.style.transform = `translate(${px}px, ${py}px)`;
      (svg.querySelector('.puck-shadow') as SVGGElement).style.transform = `translate(${px}px, ${py}px)`;
      svg.querySelector('.trail-b')!.setAttribute('d', ribbon(trailB, 3, 11));
      svg.querySelector('.trail-d')!.setAttribute('d', ribbon(trailD, 5, 13));
      const depth = trailB.reduce((m, p) => Math.max(m, p[1]), 0), f = clamp(depth / 80, 0, 1);
      svg.querySelector('.power-arc')!.setAttribute('stroke-dasharray', `${(f * 100).toFixed(1)} 100`);
      svg.querySelectorAll<SVGGElement>('.bead').forEach(b => b.classList.toggle('lit', f >= +b.dataset.f! - 0.02));
      svg.classList.toggle('maxed', f >= 0.98);
      // on the aim distance's pull: a glow and a tick
      const on = this.pTarget !== null && trailB.length > 1 && Math.abs(f - this.pTarget) <= 0.03;
      svg.classList.toggle('on-target', on); if (on && !this.pOn) buzz(10); this.pOn = on;
      (svg as unknown as HTMLElement).style.setProperty('--pull', f.toFixed(3));   // the dial swells as you pull
      if (atTop && !this.padTop) buzz(12);
      this.padTop = atTop;
      const hit = trailD.length > 0 && trailD[trailD.length - 1][1] < -45;
      if (hit && !this.padStruck) { svg.classList.remove('strike'); void (svg as unknown as HTMLElement).getBoundingClientRect(); svg.classList.add('strike'); buzz([8, 30, 16]); setTimeout(() => svg.classList.remove('strike'), 650); }
      this.padStruck = hit || (trailD.length > 0 && this.padStruck);
      if (!trailB.length && !trailD.length) this.padStruck = false;
      svg.classList.toggle('at-top', atTop);
      return;
    }
    const d = (pts: [number, number][]) => pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
    puck.setAttribute('transform', `translate(${px} ${py})`);
    svg.querySelector('.trail-b')!.setAttribute('d', d(trailB));
    svg.querySelector('.trail-d')!.setAttribute('d', d(trailD));
    svg.classList.toggle('at-top', atTop);
  }
  padLocal(e: PointerEvent): [number, number] { const r = this.pad.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * 200 - 100, (e.clientY - r.top) / r.height * 200 - 100]; }

  // ── spin ball ──
  private spinLabel(prefix = '') {
    const el = this.q('#spinLabel'), w = spinWords(this.spin), mag = Math.hypot(this.spin.x, this.spin.y);
    el.textContent = w ? prefix + w : prefix ? '' : this.spinHint ? 'Swipe for spin' : '';
    el.dataset.lvl = !w ? '' : mag < 0.45 ? 'lo' : mag < 0.8 ? 'mid' : 'hi';
    el.classList.remove('tick'); void el.offsetWidth; el.classList.add('tick');
  }
  showSpin(on: boolean, base?: { rpm: number; tilt: number }) {
    this.spinOn = on;
    if (base) this.spinBase = base;
    this.spinFelt = 0; this.spinRate = 0;
    this.q('#spin').classList.toggle('off', !on);
    this.el.classList.toggle('spin-on', on);
    if (on) {
      this.strikeUsed = true; this.spin = { x: 0, y: 0 }; this.spinM = mat3Identity();
      // the hint only for the first couple of shots; the ring pulses every time it appears
      let n = 0; try { n = +(localStorage.getItem('golf-spin-hint') ?? 0); localStorage.setItem('golf-spin-hint', String(n + 1)); } catch { /* storage blocked */ }
      this.spinHint = n < 2;
      const sp = this.q('#spin'); sp.classList.remove('pulse', 'used'); void sp.offsetWidth; sp.classList.add('pulse');
      this.q('#spinLabel').textContent = this.spinHint ? 'Swipe for spin' : '';
    }
  }
  spinDone() {
    this.spinOn = false;
    this.spinLabel('Spin: ');
    setTimeout(() => { if (!this.spinOn) { this.q('#spin').classList.add('off'); this.el.classList.remove('spin-on'); } }, 1800);
  }
  /** the shot's real spin, for the spin ball's turning (set at launch) */
  spinBase = { rpm: 6000, tilt: 0 };
  onSpinTick: (level: number) => void = () => {};
  private spinFelt = 0; private spinFeltT = 0; private spinRate = 0;
  tickSpin(dt: number, flying: boolean) {
    if (this.q('#spin').classList.contains('off')) return;
    // backspin from the strike plus what the player swipes in (spin.y < 0 = more backspin), read at phone size:
    // 0.3–3 rev/s on screen, non-linear; sidespin tilts the axis, enough topspin reverses it
    const eff = this.spinBase.rpm - this.spin.y * 5000;
    const rps = Math.sign(eff || 1) * (0.3 + 2.7 * Math.pow(Math.min(1, Math.abs(eff) / 11000), 0.75));
    const want = flying ? rps : rps * 0.25;
    this.spinRate += (want - this.spinRate) * Math.min(1, dt * 4);
    const th = Math.max(-1, Math.min(1, this.spin.x * 0.75 + this.spinBase.tilt * 1.5));
    const axis = [Math.cos(th), Math.sin(th), 0];
    const ang = this.spinRate * Math.PI * 2 * dt;
    mat3RotateAxis(this.spinM, axis[0], axis[1], axis[2], ang);
    drawSpinBall(this.spinCv, this.spinM, this.spin, this.skin, flying, Math.abs(this.spinRate) > 1.3 ? { axis, d: Math.min(0.9, Math.abs(ang) * 1.6) } : undefined);
    // a whirr and a buzz as spin is added
    const lvl = Math.hypot(this.spin.x, this.spin.y), t = performance.now();
    if (lvl > this.spinFelt + 0.07 && t - this.spinFeltT > 90) { this.spinFelt = lvl; this.spinFeltT = t; this.onSpinTick(lvl); try { navigator.vibrate?.(5); } catch { /* not allowed */ } }
    if (lvl < this.spinFelt - 0.1) this.spinFelt = lvl;
  }

  // ── strike point picker ──
  private strikeM: Mat3 = (() => { const m = mat3Identity(); mat3Rotate(m, 0.18, 0); return m; })();
  private initStrike() {
    const btnCv = this.q<HTMLCanvasElement>('.strike-btn canvas'), big = this.q<HTMLCanvasElement>('#spBall canvas');
    const paint = () => {
      btnCv.getContext('2d')!.clearRect(0, 0, 112, 112); btnCv.getContext('2d')!.drawImage(shadeBall(112, this.strikeM), 0, 0);
      big.getContext('2d')!.clearRect(0, 0, 440, 440); big.getContext('2d')!.drawImage(shadeBall(440, this.strikeM), 0, 0);
    };
    paint(); onBallTexUpdate(paint);
    const ball = this.q('#spBall');
    let drag = false;
    const move = (e: PointerEvent) => {
      const r = big.getBoundingClientRect(), R = r.width / 2;
      const px = (e.clientX - r.left - R) / R, py = (e.clientY - r.top - R) / R;
      // screen right = toward the golfer (inner half) for this left-hander's camera; screen up = top of the ball
      this.setStrike(-px, -py);
    };
    ball.addEventListener('pointerdown', e => { drag = true; ball.setPointerCapture(e.pointerId); move(e); e.preventDefault(); });
    ball.addEventListener('pointermove', e => { if (drag) move(e); });
    const end = () => { drag = false; };
    ball.addEventListener('pointerup', end); ball.addEventListener('pointercancel', end);
    this.q('#spRet').addEventListener('keydown', e => {
      const k = (e as KeyboardEvent).key, d = 0.1;
      if (k === 'ArrowLeft') this.setStrike(this.strike.x + d, this.strike.y); else if (k === 'ArrowRight') this.setStrike(this.strike.x - d, this.strike.y);
      else if (k === 'ArrowUp') this.setStrike(this.strike.x, this.strike.y + d); else if (k === 'ArrowDown') this.setStrike(this.strike.x, this.strike.y - d);
      else if (k === 'Escape' || k === 'Enter') this.openStrike(false); else return;
      e.preventDefault();
    });
    this.q('#strikePop').addEventListener('click', e => { if (e.target === this.q('#strikePop')) this.openStrike(false); });
    this.setStrike(0, 0);
  }
  /** set the strike point (clamped to the ball's face) and redraw the markers */
  setStrike(x: number, y: number) {
    const lim = 0.78, l = Math.hypot(x, y); if (l > lim) { x *= lim / l; y *= lim / l; }
    if (Math.abs(x) < 0.06) x = 0; if (Math.abs(y) < 0.06) y = 0; // gentle snap to centre lines
    this.strike = { x, y };
    // screen position: outer (+x) is screen left, top (+y) is screen up
    for (const el of [this.q('.strike-btn'), this.q('#spBall')]) { el.style.setProperty('--sx', String(-x)); el.style.setProperty('--sy', String(-y)); }
    const v = y > 0.15 ? 'High' : y < -0.15 ? 'Low' : '', h = x > 0.15 ? 'Cut' : x < -0.15 ? 'Draw' : '';
    const fly = [y > 0.15 ? 'flies lower' : y < -0.15 ? 'flies higher' : '', x > 0.15 ? 'cuts' : x < -0.15 ? 'draws' : ''].filter(Boolean).join(', ');
    const label = v || h ? `${[v, h].filter(Boolean).join(' · ')}${fly ? ' — ' + fly : ''}` : 'Dead centre';
    this.q('#spRead').textContent = label;
    this.q('.strike-btn').setAttribute('aria-label', `Strike point: ${label}. Choose where to hit the ball`);
    this.q('.strike-btn').classList.toggle('set', !!(x || y));
    this.onStrike(this.strike);
  }
  openStrike(on: boolean) {
    const pop = this.q('#strikePop');
    pop.hidden = !on; this.el.classList.toggle('strike-open', on);
    if (on) (this.q('#spRet') as HTMLButtonElement).focus({ preventScroll: true }); else (this.q('.strike-btn') as HTMLButtonElement).focus({ preventScroll: true });
  }

  // ── the editorial distance: one big Anton number (the target at address, live in the air, the total after) ──
  private edKey = '';
  private ed(n: number, cap: string, mode: 'address' | 'live' | 'result') {
    const key = `${mode}|${n}|${cap}`; if (key === this.edKey) return; this.edKey = key;
    const el = this.q('#ed'); if (!el) return;
    el.className = 'ed ' + mode;
    el.querySelector('.ed-n')!.textContent = String(n);
    el.querySelector('.ed-c')!.textContent = cap;
  }
  /** at address: the distance to the target (follows the aim ring) and the club */
  edAddress(yds: number) { const id = CLUB_SPECS[this.club].id; this.ed(Math.round(yds), `YARDS · ${clubUI(id)[1].toUpperCase()}${this.mode !== 'full' ? ' · ' + MODES[this.mode].label.toUpperCase() : ''}`, 'address'); }
  /** in the air: a small live yardage */
  edLive(yds: number) { this.ed(Math.max(0, Math.round(yds)), 'YARDS · IN THE AIR', 'live'); }
  /** after the ball stops: the big total with a short caption */
  edResult(yds: number, cap: string) { this.ed(Math.round(yds), cap, 'result'); const el = this.q('#ed'); el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }

  /** wind: speed (mph, with the gust) and where it blows toward relative to the aim line (deg, 0 = helping, clockwise) */
  setWind(mph: number, relDeg: number, gust: number) {
    const el = this.q('#wind'); if (!el) return;
    const m = Math.round(mph);
    if (el.dataset.m !== String(m)) { el.dataset.m = String(m); el.querySelector('b')!.textContent = String(m); }
    (el.querySelector('.wc-arrow') as SVGGElement).setAttribute('transform', `rotate(${relDeg.toFixed(1)}) scale(${(0.92 + 0.12 * (gust - 0.8) / 0.4).toFixed(3)})`);
    el.classList.toggle('calm', m < 1);
    const dir = Math.abs(((relDeg % 360) + 540) % 360 - 180);   // 180 = helping, 0 = into
    const word = m < 1 ? 'No wind' : `${m} mph ${dir > 135 ? 'helping' : dir < 45 ? 'into you' : 'across'}`;
    if (el.getAttribute('aria-label') !== word) el.setAttribute('aria-label', 'Wind: ' + word);
  }
  /** the cinematic shot cam's phase (null when off): the spin ball steps aside for the face shot */
  setCine(phase: string | null) { this.el.classList.toggle('cine-face', phase === 'face'); }

  /** after the shot: one friendly line that fades (the numbers live behind 'Shot details') */
  shotLine(text: string, cls: string) {
    const t = this.q('#toast');
    t.classList.remove('on'); void t.offsetWidth;
    t.innerHTML = `<span class="word line ${cls}">${text}</span>`;
    t.classList.add('on'); clearTimeout(this.toastT); this.toastT = window.setTimeout(() => t.classList.remove('on'), 2600);
    if (cls === 'good') this.celebrate(/green|pin|hole|pured/i.test(text) ? 34 : 18);
  }
  toast(word: string, why: string, cls: string) {
    const t = this.q('#toast');
    t.classList.remove('on'); void t.offsetWidth; // restart the pop animation
    t.innerHTML = `<span class="word ${cls}">${word}</span>${why ? `<span class="why">${why}</span>` : ''}`;
    t.classList.add('on'); clearTimeout(this.toastT); this.toastT = window.setTimeout(() => t.classList.remove('on'), 1500);
    if (cls === 'good') this.celebrate(/green|pin|hole/i.test(word + why) ? 34 : 18);
  }
  /** a little burst of confetti from the toast */
  celebrate(n = 18) {
    if (reduced()) return;
    const box = this.q('#confetti');
    const cols = ['#ffd23f', '#13294b', '#c8102e', '#fff6e3', '#5ff0a0', '#f2a900'];
    let html = '';
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.4, d = 70 + Math.random() * 110;
      const x = Math.cos(a) * d, y = Math.sin(a) * d * 0.75 - 40, r = Math.round(Math.random() * 720 - 360);
      const w = 6 + Math.random() * 6, h = Math.random() < 0.5 ? w : w * 0.45;
      html += `<i style="--x:${x.toFixed(0)}px;--y:${y.toFixed(0)}px;--r:${r}deg;--d:${(0.7 + Math.random() * 0.5).toFixed(2)}s;width:${w.toFixed(0)}px;height:${h.toFixed(0)}px;background:${cols[i % cols.length]};border-radius:${h === w ? '50%' : '2px'}"></i>`;
    }
    box.innerHTML = html; box.classList.remove('go'); void box.offsetWidth; box.classList.add('go');
  }
}

export { CLUB_DATA };
