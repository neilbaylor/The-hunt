// The HUD: club, swing mode and lie panels, the swing pad, the spin ball, the shot card and toasts.
// Plain DOM over the WebGL canvas. The default look ('f', Clubhouse Candy) is playful and tactile:
// cream toy-like chips in Toronto Hunt navy, red and gold. The older looks (A Broadcast, B Clubhouse,
// C Y2K Pro Tour) are still there (tap the player chip to cycle). Corner groups scale with the screen.
import { CLUB_SPECS } from '../golfer/club';
import type { ShotMode } from '../golfer/golfer';
import { CLUB_DATA, LIES, MODES, type ShotPlan } from '../game/shot';
import type { GolferProfile } from '../golfer/profile';
import crestUrl from '../assets/brand/toronto-hunt-crest.png';
import css from './hud.css?inline';

export type Skin = 'f' | 'a' | 'b' | 'c';
const SKINS: Skin[] = ['f', 'a', 'b', 'c'];
/** phones: the swing card pops in for a few seconds then leaves; elsewhere it shrinks to a pill */
const isPhone = () => matchMedia('(pointer: coarse)').matches || (innerHeight > innerWidth && innerWidth < 700);
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
let uid = 0;

const modeGlyph = (m: ShotMode, w = 3) => {
  const top = { full: 4.25, punch: 2.6, pitch: 2.2, flop: 3.7 }[m], fin = { full: -4.1, punch: -1.9, pitch: -2.5, flop: -3.9 }[m];
  const r = 16, cx = 23, cy = 22;
  const pt = (a: number) => [cx - r * Math.sin(a), cy + r * Math.cos(a)];
  const arc = (a0: number, a1: number) => { let d = ''; for (let i = 0; i <= 24; i++) { const p = pt(a0 + (a1 - a0) * i / 24); d += (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); } return d; };
  const b = Math.min(top, 4.2) * 0.62, f = Math.max(fin, -4.2) * 0.62, tp = pt(b), fp = pt(f);
  return `<svg viewBox="0 0 46 46" aria-hidden="true"><path d="${arc(0, b)}" fill="none" stroke="var(--h-accent)" stroke-width="${w}" stroke-linecap="round"/><path d="${arc(0, f)}" fill="none" stroke="var(--h-dim)" stroke-width="${w - 1}" stroke-linecap="round" stroke-dasharray="2 3"/><circle cx="${tp[0]}" cy="${tp[1]}" r="3" fill="var(--h-accent)"/><circle cx="${cx}" cy="${cy + r}" r="3.4" fill="#fff"/><circle cx="${fp[0]}" cy="${fp[1]}" r="2.2" fill="var(--h-dim)"/></svg>`;
};
const lieRing = (pct: number) => {
  const r = 19, C = 2 * Math.PI * r, col = pct >= 95 ? 'var(--h-good)' : pct >= 85 ? 'var(--h-warn)' : 'var(--h-bad)';
  return `<svg viewBox="0 0 46 46" aria-hidden="true"><circle cx="23" cy="23" r="${r}" fill="none" stroke="var(--h-track)" stroke-width="5"/><circle cx="23" cy="23" r="${r}" fill="none" stroke="${col}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${C * pct / 100} ${C}" transform="rotate(-90 23 23)"/><text x="23" y="27.5" text-anchor="middle" font-size="12" font-weight="700" fill="var(--h-ink)" style="font-family:var(--h-display)">${pct}</text></svg>`;
};
const slopeIcon = (slope: number, side: number) => {
  const tilt = -side * Math.min(18, slope * 4);
  const arrow = side ? `<g transform="translate(36 9)"><path d="M${side * 14} 0 L${-side * 10} 0" stroke="var(--h-accent)" stroke-width="3" stroke-linecap="round"/><path d="M${side * 18} 0 L${side * 9} -6 L${side * 9} 6 Z" fill="var(--h-accent)"/></g>` : `<text x="36" y="13" text-anchor="middle" font-size="10" fill="var(--h-dim)">LEVEL</text>`;
  return `<svg viewBox="0 0 72 40" aria-hidden="true">${arrow}<g transform="rotate(${tilt} 36 30)"><rect x="6" y="30" width="60" height="7" rx="2" fill="var(--h-good)" opacity=".85"/><circle cx="36" cy="26" r="4" fill="#fff"/></g></svg>`;
};

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
    const dimples = Array.from({ length: 19 }, (_, i) => { const a = i * 2.39996, r = 4 + 13 * Math.sqrt(i / 19); return `<circle cx="${(Math.cos(a) * r).toFixed(1)}" cy="${(Math.sin(a) * r).toFixed(1)}" r="2.1" fill="rgba(120,132,150,.22)"/>`; }).join('');
    const tees = [20, 40, 60, 80].map((y, i) => `<g class="tee-mark" transform="translate(0 ${y})"><rect x="-17" y="-1.6" width="34" height="3.2" rx="1.6" fill="rgba(255,246,227,${i === 3 ? 0.95 : 0.5})"/>${i < 3 ? `<text x="22" y="4" font-size="10" class="tlab">${(i + 1) * 25}</text>` : ''}</g>`).join('');
    return `<svg class="pad-svg pad-f" id="${id}" viewBox="-100 -100 200 200" aria-hidden="true">
    <defs>
      <radialGradient id="${id}b" cx="36%" cy="30%"><stop offset="0" stop-color="#ffffff"/><stop offset=".65" stop-color="#f1f3f6"/><stop offset="1" stop-color="#c6ccd6"/></radialGradient>
      <linearGradient id="${id}r" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff8e6"/><stop offset="1" stop-color="#f0d9a0"/></linearGradient>
      <linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(19,41,75,.75)"/><stop offset="1" stop-color="rgba(19,41,75,.45)"/></linearGradient>
      <filter id="${id}s" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#0b1a33" flood-opacity=".45"/></filter>
    </defs>
    <circle r="91" fill="rgba(19,41,75,.32)"/>
    <circle r="88" fill="none" stroke="url(#${id}r)" stroke-width="7"/>
    <circle r="84" fill="none" stroke="rgba(19,41,75,.35)" stroke-width="1.5"/>
    <rect x="-15" y="-74" width="30" height="164" rx="15" fill="url(#${id}g)"/>
    <rect x="-15" y="-74" width="30" height="164" rx="15" fill="none" stroke="rgba(255,246,227,.35)" stroke-width="1.5"/>
    ${tees}
    <g transform="translate(-2 -84)"><line x1="0" y1="0" x2="0" y2="20" stroke="#fff6e3" stroke-width="2.4" stroke-linecap="round"/><path d="M1 0 L16 4.5 L1 9 Z" fill="#ffd23f"/></g>
    <path d="M-8 -40 L0 -49 L8 -40" fill="none" stroke="#fff6e3" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity=".85"/>
    <g class="hint"><path d="M-10 32 L0 42 L10 32" fill="none" stroke="#ffd23f" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M-10 45 L0 55 L10 45" fill="none" stroke="#ffd23f" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" opacity=".55"/></g>
    <circle r="95" fill="none" stroke="#ffd23f" stroke-width="7" class="top-ring"/>
    <text class="push-cue" y="-56" text-anchor="middle">PUSH!</text>
    <path class="trail-b" d="" fill="none" stroke="#ffd23f" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" opacity=".95"/>
    <path class="trail-d" d="" fill="none" stroke="#5ff0a0" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" opacity=".95"/>
    <g class="puck"><g filter="url(#${id}s)"><circle r="23" fill="url(#${id}b)"/></g>${dimples}<ellipse cx="-7" cy="-9" rx="7" ry="4.5" fill="rgba(255,255,255,.85)" transform="rotate(-30 -7 -9)"/></g></svg>`;
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
const DIMPLES = (() => { const n = 180, out: number[][] = [], g = Math.PI * (3 - Math.sqrt(5)); for (let i = 0; i < n; i++) { const y = 1 - (i + 0.5) / n * 2, r = Math.sqrt(1 - y * y), t = g * i; out.push([Math.cos(t) * r, y, Math.sin(t) * r]); } return out; })();
const SKIN_COL: Record<Skin, { ring: string; acc: string; acc2: string; back: string }> = {
  f: { ring: 'rgba(255,246,227,.55)', acc: '#ffd23f', acc2: '#5ff0a0', back: 'rgba(19,41,75,.6)' },
  a: { ring: 'rgba(255,255,255,.25)', acc: '#ffc72c', acc2: '#2fd3ff', back: 'rgba(8,18,42,.72)' },
  b: { ring: 'rgba(244,236,216,.3)', acc: '#d4ad57', acc2: '#9fd38a', back: 'rgba(13,44,29,.82)' },
  c: { ring: 'rgba(255,255,255,.4)', acc: '#ffe234', acc2: '#5cff8a', back: 'rgba(11,31,138,.82)' },
};
function rotPts(pts: number[][], ax: number, ay: number) {
  const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay);
  for (const p of pts) { let [x, y, z] = p; const y2 = y * cx - z * sx, z2 = y * sx + z * cx; y = y2; z = z2; const x2 = x * cy + z * sy; z = -x * sy + z * cy; p[0] = x2; p[1] = y; p[2] = z; }
}
function drawSpinBall(cv: HTMLCanvasElement, pts: number[][], spin: { x: number; y: number }, skin: Skin, active: boolean) {
  const ctx = cv.getContext('2d')!, k = cv.width / 136, c = SKIN_COL[skin];
  ctx.setTransform(k, 0, 0, k, 0, 0); ctx.clearRect(0, 0, 136, 136);
  const cx = 68, cy = 68, R = 44;
  ctx.beginPath(); ctx.arc(cx, cy, 62, 0, Math.PI * 2); ctx.fillStyle = c.back; ctx.fill();
  ctx.lineWidth = 5; ctx.strokeStyle = c.ring; ctx.beginPath(); ctx.arc(cx, cy, 56, 0, Math.PI * 2); ctx.stroke();
  const mag = Math.hypot(spin.x, spin.y);
  if (mag > 0.01) { ctx.strokeStyle = c.acc; ctx.lineCap = 'round'; ctx.beginPath(); ctx.arc(cx, cy, 56, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * mag); ctx.stroke(); }
  const g = ctx.createRadialGradient(cx - 14, cy - 16, 4, cx, cy, R); g.addColorStop(0, '#ffffff'); g.addColorStop(0.7, '#e9edf0'); g.addColorStop(1, '#b5bec6');
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();
  for (const p of pts) { if (p[2] <= 0.05) continue; const r = 3.1 * (0.35 + 0.65 * p[2]); ctx.beginPath(); ctx.ellipse(cx + p[0] * (R - 3), cy + p[1] * (R - 3), r, r * (0.45 + 0.55 * p[2]), Math.atan2(p[1], p[0]), 0, Math.PI * 2); ctx.fillStyle = `rgba(120,132,142,${0.18 + 0.35 * p[2]})`; ctx.fill(); }
  if (mag > 0.03) {
    const ang = Math.atan2(-spin.y, spin.x), L = 18 + 22 * mag;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(ang); ctx.strokeStyle = c.acc; ctx.fillStyle = c.acc; ctx.lineWidth = 5; ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 4;
    ctx.beginPath(); ctx.moveTo(-L * 0.4, 0); ctx.lineTo(L, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(L + 9, 0); ctx.lineTo(L - 3, -8); ctx.lineTo(L - 3, 8); ctx.closePath(); ctx.fill(); ctx.restore();
  } else if (active) {
    ctx.strokeStyle = c.acc2; ctx.lineWidth = 2; ctx.setLineDash([3, 5]); ctx.beginPath(); ctx.arc(cx, cy, R + 4, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
  }
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
}

export class Hud {
  readonly el: HTMLDivElement;
  skin: Skin = 'f';
  club = 6; mode: ShotMode = 'full'; lie = 0;
  readonly pad: HTMLDivElement;
  readonly spinCv: HTMLCanvasElement;
  spin = { x: 0, y: 0 };
  private spinPts = DIMPLES.map(p => p.slice());
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
      <div class="corner tl"><div class="row"><div id="clubSlot"></div><div id="modeSlot"></div></div><div class="who" id="who"></div><div class="pop hud-panel" id="clubPop" hidden></div><div class="pop hud-panel" id="modePop" hidden></div></div>
      <div class="corner tr"><div id="lieSlot"></div></div>
      <div class="corner bl"><div id="cardSlot"><div class="card-wrap" id="cardWrap"><button type="button" class="hud-panel card-mini" data-act="card-open" aria-expanded="false"></button><div class="card-body" id="cardBody"></div></div></div></div>
      <div class="corner br"><div class="pad" id="pad" aria-label="Swing pad: press, pull down, push up"></div><div class="pad-label"><span>Pull <b>back</b></span><i></i><span>push <b>through</b></span></div></div>
      <div class="corner bc"><div class="spin off" id="spin"><canvas width="272" height="272" aria-label="Spin ball: swipe to add spin"></canvas><div class="spin-label" id="spinLabel">Swipe the ball to add spin</div></div></div>
      <div class="toast" id="toast"></div>
      <div class="confetti" id="confetti" aria-hidden="true"></div>`;
    document.documentElement.style.setProperty('--crest', `url("${crestUrl}")`);
    parent.appendChild(this.el);
    this.pad = this.el.querySelector('#pad')!;
    this.spinCv = this.el.querySelector('#spin canvas')!;
    try { const s = localStorage.getItem('golf-skin-v2') as Skin | null; if (s && SKINS.includes(s)) this.skin = s; } catch { /* storage blocked */ }
    this.el.addEventListener('click', e => this.click(e));
    this.spinCv.addEventListener('pointerdown', e => { if (!this.spinOn) return; this.spinCv.setPointerCapture(e.pointerId); this.spinDrag = [e.clientX, e.clientY]; e.preventDefault(); });
    this.spinCv.addEventListener('pointermove', e => {
      if (!this.spinDrag || !this.spinOn) return;
      const r = this.spinCv.getBoundingClientRect(), k = 136 / r.width;
      const dx = (e.clientX - this.spinDrag[0]) * k, dy = (e.clientY - this.spinDrag[1]) * k; this.spinDrag = [e.clientX, e.clientY];
      let sx = this.spin.x + dx / 150, sy = this.spin.y - dy / 150; const m = Math.hypot(sx, sy); if (m > 1) { sx /= m; sy /= m; }
      this.spin = { x: sx, y: sy };
      this.el.querySelector('#spinLabel')!.textContent = spinWords(this.spin) || 'Swipe the ball to add spin';
    });
    const end = () => { this.spinDrag = null; };
    this.spinCv.addEventListener('pointerup', end); this.spinCv.addEventListener('pointercancel', end);
    this.setSkin(this.skin);
    this.fit(); addEventListener('resize', () => this.fit());
  }

  /** state classes for layout: ready (waiting for a swing), flying (ball in the air), idle (no shot yet) */
  setState(ready: boolean, flying: boolean, idle: boolean) { this.el.classList.toggle('ready', ready); this.el.classList.toggle('flying', flying); this.el.classList.toggle('idle', idle); }

  fit() {
    const portrait = innerHeight > innerWidth * 1.05;
    this.el.classList.toggle('phone', isPhone());
    const s = portrait ? clamp(innerWidth / 430, 0.72, 1.25) : clamp(Math.min(innerWidth / 960, innerHeight / 540), 0.42, 1.35);
    this.el.style.setProperty('--s', String(s));
  }

  setSkin(k: Skin) {
    const keep = ['hidden', 'ready', 'flying', 'idle', 'phone', 'spin-on'].filter(c => this.el.classList.contains(c));
    this.skin = k; this.el.className = ['hud', 'skin-' + k, ...keep].join(' ');
    this.pad.innerHTML = padSVG(k);
    this.render();
    drawSpinBall(this.spinCv, this.spinPts, this.spin, k, this.spinOn);
    try { localStorage.setItem('golf-skin-v2', k); } catch { /* storage blocked */ }
  }

  private q<T extends HTMLElement>(sel: string) { return this.el.querySelector(sel) as T; }

  render(card?: CardData | null) {
    const id = CLUB_SPECS[this.club].id, M = MODES[this.mode];
    this.q('#clubSlot').innerHTML = `<button type="button" class="hud-panel club-btn" data-act="club" aria-label="Club: ${CLUB_SPECS[this.club].name}, ${M.max(id)} yards. Change club"><span class="eyebrow-h">Club</span><span class="big">${id}</span><span class="yds">${M.max(id)}<small>yds</small></span><span class="cap">${CLUB_SPECS[this.club].name} · ${M.label.toLowerCase()} max</span></button>`;
    this.q('#modeSlot').innerHTML = `<button type="button" class="hud-panel mode-btn" data-act="mode" aria-label="Swing mode: ${M.label}. Change swing mode"><span class="eyebrow-h">Swing</span><span class="big">${M.label}</span>${modeGlyph(this.mode)}</button>`;
    const L = LIES[this.lie];
    this.q('#lieSlot').innerHTML = `<button type="button" class="hud-panel lie-card" data-act="lie" aria-label="Lie: ${L.name}, ${L.pct} percent, slope ${L.slope} degrees. Tap for another sample lie"><span class="eyebrow-h">Lie</span>
      <span class="lie-top">${lieRing(L.pct)}<span><span class="big" style="display:block">${L.name}</span><span class="sub">${L.pct}% distance</span></span></span>
      <span class="slope">${slopeIcon(L.slope, L.side)}<span class="deg">${L.slope}°</span><span class="sub">${L.txt}</span></span></button>`;
    const p = this.profile;
    this.q('#who').innerHTML = `<button type="button" class="hud-panel who-chip" data-act="skin" aria-label="${p.name}. Tap to change the HUD look"><i class="crest" aria-hidden="true"></i><b>${p.name}</b></button>`;
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

  /** Last-swing card. Phones: pops in when the ball lands, leaves ~4 s after it stops. Elsewhere: shows,
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
    body.innerHTML = `<div class="hud-panel card"><button type="button" class="card-min" data-act="card-min" aria-label="Minimise">&minus;</button><span class="eyebrow-h">Last swing</span>
      <div><div class="tempo-head"><span>Tempo</span><b class="tempo-word ${P.tempoCls}">${P.tempoWord}</b></div>
      <div class="tempo-track"><span class="win" style="left:${pos(-70)}%;width:${(+pos(160) - +pos(-70)).toFixed(1)}%"></span><span class="mark" style="left:${pos(c.offMs)}%"></span></div>
      <div class="tempo-scale"><span>Quick</span><span>${c.offMs > 0 ? '+' : ''}${Math.round(c.offMs)} ms</span><span>Late</span></div></div>
      <dl class="stats">
        <div><dt>Power</dt><dd>${Math.round(c.power * 100)}%</dd></div>
        <div><dt>Takeaway</dt><dd class="${P.driftCls}">${P.driftWord}</dd></div>
        <div><dt>Shape</dt><dd>${P.shape}</dd></div>
        <div><dt>Carry</dt>${tick('carry', c.carry)}</div>
        <div><dt>Total</dt>${tick('total', c.total, c.done)}</div>
        <div><dt>Offline</dt><dd>${c.done && c.offline !== undefined ? side(c.offline) : '…'}</dd></div>
      </dl></div>`;
    const yd = c.done && c.total !== undefined ? `${c.total.toFixed(0)} yds` : c.carry !== undefined ? `${c.carry.toFixed(0)} carry` : 'in the air';
    mini.innerHTML = `<i class="dot ${P.tempoCls}"></i><b>${P.tempoWord}</b><span>${yd}</span><span class="chev" aria-hidden="true"></span>`;
    this.runTicks();
    if (c.carry === undefined) { if (phone) this.setCard('hidden'); else this.setCard('open'); clearTimeout(this.cardTimer); }
    else if (!c.done) { this.setCard('open'); clearTimeout(this.cardTimer); }
    else { this.setCard('open'); this.later(4200, () => this.collapse()); }
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
    const M = MODES[this.mode];
    return `<div class="list clubs" role="group" aria-label="Clubs">${CLUB_SPECS.map((c, i) => `<button type="button" data-club="${i}" aria-pressed="${i === this.club}" ${M.ok(c.id) ? '' : 'disabled'}><b>${c.id}</b><span>${M.ok(c.id) ? M.max(c.id) + ' yds' : '—'}</span></button>`).join('')}</div>`;
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
    if (cb && !cb.disabled) { this.club = +cb.dataset.club!; cp.hidden = true; this.render(); this.onClub(this.club); return; }
    if (mb && !mb.disabled) { this.mode = mb.dataset.mode as ShotMode; mp.hidden = true; this.render(); this.onMode(this.mode); return; }
    if (!a) { if (!t.closest('.pop')) this.closePops(); return; }
    const act = a.dataset.act;
    if (act === 'club') { mp.hidden = true; cp.hidden = !cp.hidden; cp.innerHTML = this.clubList(); }
    if (act === 'mode') { cp.hidden = true; mp.hidden = !mp.hidden; mp.innerHTML = this.modeList(); }
    if (act === 'lie') { this.closePops(); this.lie = (this.lie + 1) % LIES.length; this.render(); this.onLie(this.lie); }
    if (act === 'skin') { this.setSkin(SKINS[(SKINS.indexOf(this.skin) + 1) % SKINS.length]); }
    if (act === 'card-open') { if (this.cardMode === 'open') this.collapse(); else { this.setCard('open'); this.later(isPhone() ? 4000 : 8000, () => this.collapse()); } }
    if (act === 'card-min') { clearTimeout(this.cardTimer); this.collapse(); }
  }

  // ── swing pad drawing ──
  setPad(pt: [number, number], trailB: [number, number][], trailD: [number, number][], atTop: boolean) {
    const svg = this.pad.querySelector('svg'); if (!svg) return;
    const d = (pts: [number, number][]) => pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
    svg.querySelector('.puck')!.setAttribute('transform', `translate(${clamp(pt[0], -80, 80)} ${clamp(pt[1], -95, 95)})`);
    svg.querySelector('.trail-b')!.setAttribute('d', d(trailB));
    svg.querySelector('.trail-d')!.setAttribute('d', d(trailD));
    svg.classList.toggle('at-top', atTop);
  }
  padLocal(e: PointerEvent): [number, number] { const r = this.pad.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * 200 - 100, (e.clientY - r.top) / r.height * 200 - 100]; }

  // ── spin ball ──
  showSpin(on: boolean) {
    this.spinOn = on;
    this.q('#spin').classList.toggle('off', !on);
    this.el.classList.toggle('spin-on', on);
    if (on) { this.spin = { x: 0, y: 0 }; this.q('#spinLabel').textContent = 'Swipe the ball to add spin'; }
  }
  spinDone() {
    this.spinOn = false;
    const w = spinWords(this.spin); this.q('#spinLabel').textContent = w ? 'Spin: ' + w : 'No spin added';
    setTimeout(() => { if (!this.spinOn) { this.q('#spin').classList.add('off'); this.el.classList.remove('spin-on'); } }, 1800);
  }
  tickSpin(dt: number, flying: boolean) {
    if (this.q('#spin').classList.contains('off')) return;
    const rate = flying ? 1 : 0.15;
    rotPts(this.spinPts, (-1.2 - this.spin.y * 4) * dt * rate * 3, this.spin.x * 4 * dt * rate * 3);
    drawSpinBall(this.spinCv, this.spinPts, this.spin, this.skin, flying);
  }

  toast(word: string, why: string, cls: string) {
    const t = this.q('#toast');
    t.classList.remove('on'); void t.offsetWidth; // restart the pop animation
    t.innerHTML = `<span class="word ${cls}">${word}</span>${why ? `<span class="why">${why}</span>` : ''}`;
    t.classList.add('on'); clearTimeout(this.toastT); this.toastT = window.setTimeout(() => t.classList.remove('on'), 2100);
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
