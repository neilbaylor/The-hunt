// Turns a swing (power, timing, path) plus club, mode and lie into a ball launch.
import { CLUB_SPECS } from '../golfer/club';
import type { ShotMode } from '../golfer/golfer';
import { speedForCarry, simulateShape, type Launch } from './ball';

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

/** pct is the planning figure (the middle of the range); a real strike rolls a random value in lo..hi,
 *  and worse lies have a wider range */
export interface Lie { name: string; pct: number; lo: number; hi: number; slope: number; side: -1 | 0 | 1; txt: string }
export const LIES: Lie[] = [
  { name: 'Tee box', pct: 100, lo: 100, hi: 100, slope: 0, side: 0, txt: 'Flat lie' },
  { name: 'Fairway', pct: 100, lo: 100, hi: 100, slope: 3, side: -1, txt: 'Ball above feet · starts left' },
  { name: 'First cut', pct: 91, lo: 88, hi: 95, slope: 2, side: 1, txt: 'Ball below feet · starts right' },
  { name: 'Rough', pct: 77.5, lo: 70, hi: 85, slope: 5, side: -1, txt: 'Ball above feet · starts left' },
  { name: 'Fairway bunker', pct: 85, lo: 78, hi: 92, slope: 1, side: 1, txt: 'Ball below feet · starts right' },
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
  /** the player's plan from the aim view: curve -1..1 (+ = bends right on screen), loft -1..1 (lower .. higher) */
  aim?: { curve: number; loft: number };
  /** a real strike: roll the lie's percentage within lo..hi (planning previews use the middle) */
  rollLie?: boolean;
}

export interface ShotPlan {
  launch: Launch;
  targetCarryYds: number;
  tempoWord: 'Very early' | 'Early' | 'Slightly early' | 'Perfect' | 'Slightly late' | 'Late' | 'Very late';
  tempoCls: 'good' | 'warn' | 'bad';
  driftWord: string; driftCls: 'good' | 'warn' | 'bad';
  shape: string;
  /** the curve in golfer's words, empty when it flies straight: Duck hook, Hook, Draw, Cut, Slice, Banana slice */
  shapeWord: string;
  why: string;
  error: number;
}

const rnd = () => Math.random() * 2 - 1;
const gauss = () => { let u = 0; for (let i = 0; i < 4; i++) u += Math.random(); return (u - 2) / 0.58; };
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
/** the shortest full swing, as a fraction of the club's full carry */
export const FULL_MIN = 0.6;

export function planShot(r: SwingResult, clubIndex: number, mode: ShotMode, lie: Lie, lefty: boolean): ShotPlan {
  const id = CLUB_SPECS[clubIndex].id, C = CLUB_DATA[id];
  const eT = r.offMs < -70 ? clamp((-r.offMs - 70) / 300, 0, 1) : r.offMs > 160 ? clamp((r.offMs - 160) / 600, 0, 1) : 0;
  const eP = clamp((r.pushMs - 280) / 500, 0, 1) + (r.released ? 0.3 : 0);
  const eB = clamp((r.drift - 0.06) / 0.25, 0, 1);
  const e = clamp(eT + 0.6 * eB, 0, 1);

  // a full swing always goes a decent way: the stick's travel maps onto 60–100% of the club's full carry
  // (shorter shots are what punch, pitch and flop are for)
  const pw = mode === 'full' ? FULL_MIN + (1 - FULL_MIN) * clamp(r.power, 0, 1) : clamp(r.power, 0.05, 1);
  // planning (aim, preview tracer, power target) uses the top of the lie's range; a real strike rolls within it,
  // so a poor lie can only come up short of the plan
  const liePct = r.rollLie ? lie.lo + Math.random() * (lie.hi - lie.lo) : lie.hi;
  let carry = MODES[mode].max(id) * pw * liePct / 100 * (1 - 0.12 * clamp(eP, 0, 1));
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
  // planned trajectory from the aim view: up to ±3.5° launch and ±15% spin
  const intent = r.aim ?? { curve: 0, loft: 0 }, ic = clamp(intent.curve, -1, 1), il = clamp(intent.loft, -1, 1);
  la += 3.5 * il; spin *= 1 + 0.15 * il;
  carry *= 1 - 0.03 * Math.min(1, Math.hypot(sx, sy));
  let speed = speedForCarry(carry * YD, la * D, spin);
  // direction: push angle sets the curve (spin-axis tilt); the start line goes a little the other way
  // the stick's push angle is read relative to the golfer: a left-hander's swing is the mirror image, so the same
  // push that hooks a right-hander's ball left hooks a lefty's ball right
  const ang = clamp(r.angle, -35, 35) * (lefty ? -1 : 1);
  // inner half of the ball → draw, outer → fade (a lefty's draw curves right)
  const execTilt = (ang / 35) * 0.42 * C.curve + (lefty ? -1 : 1) * sx * 0.1 * C.curve;   // swing push + strike point
  // planned shape (aim view): a realistic spin-axis tilt (up to ~17° on a 7i), ball speed re-solved so the
  // carry holds, and the start line aimed so a pure strike lands on the ring
  let planTilt = 0, planStartDeg = 0;
  if (Math.abs(ic) > 0.02) {
    planTilt = ic * 0.33 * C.curve;
    for (let i = 0; i < 3; i++) {
      const S = simulateShape({ speed, launch: la * D, azimuth: 0, spinRpm: spin, tilt: planTilt });
      speed *= Math.sqrt((carry * YD) / Math.max(1, S.carry));
      planStartDeg = -Math.atan2(S.side, S.carry) * 180 / Math.PI;
    }
  }
  const tilt = planTilt + execTilt + gauss() * 0.06 * e;
  const startDeg = planStartDeg - 0.3 * (ang / 35) * 9 * C.curve + gauss() * 2.4 * e + gauss() * 1.8 * eB + lie.side * lie.slope * 0.45;
  // a lefty's draw curves right, so name shapes by handedness
  // name the shape from the whole curve (plan + push angle + strike point), in push-angle degrees
  const effAng = (execTilt / (0.42 * C.curve)) * 35 + ic * 9;   // a full planned curve reads as a Draw/Fade
  const curvesLeft = effAng < 0;
  const drawSide = lefty ? !curvesLeft : curvesLeft;
  const aA = Math.abs(effAng);
  const shapeWord = aA < 3 ? '' : drawSide
    ? (aA < 12 ? 'Draw' : aA < 22 ? 'Hook' : 'Duck hook')
    : (aA < 12 ? 'Cut' : aA < 22 ? 'Slice' : 'Banana slice');
  const shape = shapeWord || 'Straight';
  // timing, in plain words (the Perfect window is the same -70..+160 ms as before)
  const o = r.offMs;
  const tempoWord: ShotPlan['tempoWord'] =
    o < -280 ? 'Very early' : o < -150 ? 'Early' : o < -70 ? 'Slightly early'
    : o > 550 ? 'Very late' : o > 300 ? 'Late' : o > 160 ? 'Slightly late'
    : eP >= 0.2 ? 'Slightly late'    // a slow, dragged push through arrives late
    : 'Perfect';
  const tempoCls = tempoWord === 'Perfect' ? 'good' : tempoWord.startsWith('Slightly') ? 'warn' : 'bad';
  const why = tempoWord === 'Perfect'
    ? `${shape}${Math.abs(ang) >= 3 ? ` · pushed ${Math.abs(r.angle).toFixed(0)}° ${r.angle < 0 ? 'left' : 'right'}` : ''}`
    : o < -70 ? `Pushed ${Math.round(-o)} ms before the top`
    : o > 160 ? `Hung at the top for ${Math.round(o)} ms`
    : `Push took ${Math.round(r.pushMs)} ms. Snap it up quicker`;
  return {
    launch: { speed, launch: la * D, azimuth: startDeg * D, spinRpm: spin, tilt },
    targetCarryYds: carry, tempoWord, tempoCls,
    driftWord: eB === 0 ? 'Straight' : eB < 0.5 ? 'Wobbly' : 'Off line', driftCls: eB === 0 ? 'good' : eB < 0.5 ? 'warn' : 'bad',
    shape, shapeWord, why, error: e,
  };
}
