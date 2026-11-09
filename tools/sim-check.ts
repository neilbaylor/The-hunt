// Distance + landing regression: carry, total and roll per club on flat fairway and green, with aftertouch,
// plus high/low launch and strike-point cases.
// Run: npx esbuild tools/sim-check.ts --bundle --platform=node --outfile=/tmp/sim-check.js && node /tmp/sim-check.js
import * as THREE from 'three';
import { Ball, TEST, type Launch } from '../src/game/ball';
import { planShot, LIES, YD } from '../src/game/shot';
import { CLUB_SPECS } from '../src/golfer/club';
import type { ShotMode } from '../src/golfer/golfer';

Math.random = () => 0.5; // no tempo randomness at error 0 anyway; keep it deterministic
const fly = (L: Launch, top = 0, surf: 'fairway' | 'green' = 'fairway') => {
  TEST.surface = surf;
  const b = new Ball(null); b.tee(new THREE.Vector3(0, 0.02135, 0)); b.hit(L);
  for (let i = 0; i < 120 * 60 && b.phase !== 'stopped'; i++) { if (b.phase === 'flight' && b.t > 0.5) b.setAftertouch(top, 0); b.step(1 / 120); }
  return { c: b.carry() / YD, t: b.total() / YD, r: b.roll() / YD, side: b.offline() / YD };
};
const plan = (ci: number, mode: ShotMode = 'full', extra: any = {}) => planShot({ power: 1, offMs: 0, pushMs: 200, angle: 0, drift: 0, released: false, ...extra }, ci, mode, LIES[0], true);
const f = (n: number, w = 4) => n.toFixed(0).padStart(w);
console.log('club  carry total  roll | green roll | max-top total | max-back roll');
for (let ci = 0; ci < CLUB_SPECS.length; ci++) {
  const L = plan(ci).launch;
  const a = fly(L), g = fly(L, 0, 'green'), t = fly(L, 1), bk = fly(L, -1, 'green');
  console.log(`${CLUB_SPECS[ci].id.padEnd(4)} ${f(a.c)} ${f(a.t)}  ${f(a.r, 4)} |  ${f(g.r, 4)}      | ${f(t.t)} (+${(((t.t - a.t) / a.t) * 100).toFixed(0)}%) | ${f(bk.r, 4)}`);
}
console.log('\nhigh vs low launch, 7i (same carry):');
for (const [lab, dl] of [['low  (-5°)', -5], ['std', 0], ['high (+5°)', 5]] as [string, number][]) {
  const L = plan(6).launch; L.launch += dl * Math.PI / 180;
  const a = fly(L); console.log(`  ${lab}: carry ${f(a.c)} roll ${f(a.r)}`);
}
console.log('punch 7i:', (() => { const a = fly(plan(6, 'punch').launch); return `carry ${f(a.c)} roll ${f(a.r)}`; })());
console.log('pitch 56°:', (() => { const a = fly(plan(11, 'pitch').launch, 0, 'green'); return `carry ${f(a.c)} roll ${f(a.r)} (green)`; })());
console.log('flop 60°:', (() => { const a = fly(plan(12, 'flop').launch, 0, 'green'); return `carry ${f(a.c)} roll ${f(a.r)} (green)`; })());
console.log('\nstrike point, 7i (lefty):');
for (const [lab, s] of [['centre', { x: 0, y: 0 }], ['low on ball', { x: 0, y: -1 }], ['high on ball', { x: 0, y: 1 }], ['inner half', { x: -1, y: 0 }], ['outer half', { x: 1, y: 0 }]] as [string, any][]) {
  const P = plan(6, 'full', { strike: s }); const a = fly(P.launch);
  console.log(`  ${lab.padEnd(13)} launch ${(P.launch.launch * 57.3).toFixed(1)}° spin ${Math.round(P.launch.spinRpm)} carry ${f(a.c)} total ${f(a.t)} side ${a.side.toFixed(1)} yd`);
}
