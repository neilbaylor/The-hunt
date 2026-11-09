// Turns a swing (power, timing, path) plus club, mode and lie into a ball launch.
import { CLUB_SPECS } from '../golfer/club';
import type { ShotMode } from '../golfer/golfer';
import { speedForCarry, type Launch } from './ball';

export const YD = 0.9144;
const D = Math.PI / 180;

/** full-swing carry (yds), launch (deg), spin (rpm) for a good amateur, per club */
export const CLUB_DATA: Record<string, { full: number; launch: number; spin: number; curve: number; pitch?: number; flop?: number }> = {
  '1W': { full: 265, launch: 12.5, spin: 2500, curve: 1.3 },
  '3W': { full: 235, launch: 11.5, spin: 3400, curve: 1.2 },
  '5W': { full: 218, launch: 12.5, spin: 4100, curve: 1.1 },
  '4H': { full: 204, launch: 13.5, spin: 4500, curve: 1.0 },
  '5i': { full: 190, launch: 14, spin: 5000, curve: 1.0 },
  '6i': { full: 178, launch: 16, spin: 5600, curve: 0.95 },
  '7i': { full: 165, launch: 18, spin: 6200, curve: 0.9 },
  '8i': { full: 152, launch: 20, spin: 7000, curve: 0.85 },
  '9i': { full: 140, launch: 24, spin: 9200, curve: 0.8 },
  'PW': { full: 128, launch: 26, spin: 9100, curve: 0.75, pitch: 1 },
  '50°': { full: 113, launch: 29, spin: 9500, curve: 0.7, pitch: 0.9 },
  '56°': { full: 96, launch: 32, spin: 9900, curve: 0.65, pitch: 0.8, flop: 1 },
  '60°': { full: 80, launch: 35, spin: 10200, curve: 0.6, pitch: 0.72, flop: 0.87 },
};

export const MODES: Record<ShotMode, { label: string; rule: string; ok: (id: string) => boolean; max: (id: string) => number }> = {
  full: { label: 'Full', rule: 'Any club', ok: () => true, max: id => CLUB_DATA[id].full },
  punch: { label: 'Punch', rule: 'No driver · flies low', ok: id => id !== '1W', max: id => Math.round(CLUB_DATA[id].full * 0.78) },
  pitch: { label: 'Pitch', rule: 'PW to 60° · max 65', ok: id => !!CLUB_DATA[id].pitch, max: id => Math.round(65 * (CLUB_DATA[id].pitch ?? 0)) },
  flop: { label: 'Flop', rule: '56° or 60° · max 30', ok: id => !!CLUB_DATA[id].flop, max: id => Math.round(30 * (CLUB_DATA[id].flop ?? 0)) },
};

export interface Lie { name: string; pct: number; slope: number; side: -1 | 0 | 1; txt: string }
export const LIES: Lie[] = [
  { name: 'Tee box', pct: 100, slope: 0, side: 0, txt: 'Flat lie' },
  { name: 'Fairway', pct: 100, slope: 3, side: -1, txt: 'Ball above feet · starts left' },
  { name: 'First cut', pct: 92, slope: 2, side: 1, txt: 'Ball below feet · starts right' },
  { name: 'Rough', pct: 78, slope: 5, side: -1, txt: 'Ball above feet · starts left' },
  { name: 'Fairway bunker', pct: 85, slope: 1, side: 1, txt: 'Ball below feet · starts right' },
];

export interface SwingResult {
  power: number;      // 0..1 pull length
  offMs: number;      // transition timing vs the golfer reaching the top (- early, + late)
  pushMs: number;     // time from the top to the strike line
  angle: number;      // push angle in degrees, + = to the right on the pad
  drift: number;      // average sideways drift during the pull, as a fraction of the pad
  released: boolean;  // finger lifted before the strike line
  /** where the club meets the ball, each -1..1: y +1 = top of the ball, x -1 = inner half (toward the golfer) */
  strike?: { x: number; y: number };
}

export interface ShotPlan {
  launch: Launch;
  targetCarryYds: number;
  tempoWord: 'Smooth' | 'Quick' | 'Late' | 'Slow push';
  tempoCls: 'good' | 'warn' | 'bad';
  driftWord: string; driftCls: 'good' | 'warn' | 'bad';
  shape: string;
  why: string;
  error: number;
}

const rnd = () => Math.random() * 2 - 1;
const gauss = () => { let u = 0; for (let i = 0; i < 4; i++) u += Math.random(); return (u - 2) / 0.58; };
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function planShot(r: SwingResult, clubIndex: number, mode: ShotMode, lie: Lie, lefty: boolean): ShotPlan {
  const id = CLUB_SPECS[clubIndex].id, C = CLUB_DATA[id];
  const eT = r.offMs < -70 ? clamp((-r.offMs - 70) / 300, 0, 1) : r.offMs > 160 ? clamp((r.offMs - 160) / 600, 0, 1) : 0;
  const eP = clamp((r.pushMs - 280) / 500, 0, 1) + (r.released ? 0.3 : 0);
  const eB = clamp((r.drift - 0.06) / 0.25, 0, 1);
  const e = clamp(eT + 0.6 * eB, 0, 1);

  let carry = MODES[mode].max(id) * clamp(r.power, 0.05, 1) * lie.pct / 100 * (1 - 0.12 * clamp(eP, 0, 1));
  carry *= 1 - Math.random() * 0.09 * e;
  // launch and spin by mode
  let la = C.launch, spin = C.spin;
  if (mode === 'punch') { la *= 0.6; spin *= 0.9; }
  if (mode === 'pitch') { la = C.launch + 6; spin = 6500 + 1200 * (C.pitch ?? 0.8); }
  if (mode === 'flop') { la = 50 + 4 * (1 - (C.flop ?? 1)); spin = 4800; }
  if (mode === 'full' && r.power < 0.8) { la *= 0.92 + 0.08 * r.power; spin *= 0.75 + 0.25 * r.power; }
  if (lie.name === 'Rough') spin *= (C.pitch || ['8i', '9i', '7i', '6i', '5i'].includes(id)) ? 0.6 : 0.85; // flyers: irons lose spin from the rough, woods much less
  if (lie.name === 'Fairway bunker') spin *= 0.85;
  la += rnd() * 3.2 * e;                               // tempo: a bit high or low
  // strike point: under the ball launches higher with more backspin, over it lower with less; off-centre loses a little
  const sk = r.strike ?? { x: 0, y: 0 }, sx = clamp(sk.x, -1, 1), sy = clamp(sk.y, -1, 1);
  la -= 4 * sy; spin *= 1 - 0.25 * sy;
  carry *= 1 - 0.03 * Math.min(1, Math.hypot(sx, sy));
  const speed = speedForCarry(carry * YD, la * D, spin);
  // direction: push angle sets the curve (spin-axis tilt); the start line goes a little the other way
  const ang = clamp(r.angle, -35, 35);
  // inner half of the ball → draw, outer → fade (a lefty's draw curves right)
  const tilt = (ang / 35) * 0.42 * C.curve + gauss() * 0.06 * e + (lefty ? -1 : 1) * sx * 0.1 * C.curve;
  const startDeg = -0.3 * (ang / 35) * 9 * C.curve + gauss() * 2.4 * e + gauss() * 1.8 * eB + lie.side * lie.slope * 0.45;
  // a lefty's draw curves right, so name shapes by handedness
  // name the shape from the whole curve (push angle + strike point), in push-angle degrees
  const effAng = ang + (lefty ? -1 : 1) * sx * (0.1 / 0.42) * 35;
  const curvesLeft = effAng < 0;
  const drawSide = lefty ? !curvesLeft : curvesLeft;
  const shape = Math.abs(effAng) < 3 ? 'Straight' : drawSide ? (Math.abs(effAng) < 12 ? 'Draw' : 'Hook') : (Math.abs(effAng) < 12 ? 'Fade' : 'Slice');
  const tempoWord = eT === 0 && eP < 0.2 ? 'Smooth' : r.offMs < -70 ? 'Quick' : r.offMs > 160 ? 'Late' : 'Slow push';
  const tempoCls = tempoWord === 'Smooth' ? 'good' : (eT > 0.5 || eP > 0.5) ? 'bad' : 'warn';
  const why = tempoWord === 'Smooth'
    ? `${shape}${Math.abs(ang) >= 3 ? ` · pushed ${Math.abs(ang).toFixed(0)}° ${ang < 0 ? 'left' : 'right'}` : ''}`
    : tempoWord === 'Quick' ? `Pushed ${Math.round(-r.offMs)} ms before the top`
    : tempoWord === 'Late' ? `Hung at the top for ${Math.round(r.offMs)} ms`
    : `Push took ${Math.round(r.pushMs)} ms. Snap it up quicker`;
  return {
    launch: { speed, launch: la * D, azimuth: startDeg * D, spinRpm: spin, tilt },
    targetCarryYds: carry, tempoWord, tempoCls,
    driftWord: eB === 0 ? 'Straight' : eB < 0.5 ? 'Wobbly' : 'Off line', driftCls: eB === 0 ? 'good' : eB < 0.5 ? 'warn' : 'bad',
    shape, why, error: e,
  };
}
