// Distance + landing regression on flat ground: per club carry, total, roll, apex and landing angle, with
// strike point (high/low on the ball) and spin-ball aftertouch (max topspin / max backspin), plus mode checks.
// Run: npx esbuild tools/sim-check.ts --bundle --platform=node --outfile=/tmp/sim-check.js && node /tmp/sim-check.js
// (window.__game.sim(club, mode, lie, top, strike) in the browser runs the same thing on the real range terrain)
import * as THREE from 'three';
import { Ball, TEST, type Launch } from '../src/game/ball';
import { planShot, LIES, YD } from '../src/game/shot';
import { CLUB_SPECS } from '../src/golfer/club';
import type { ShotMode } from '../src/golfer/golfer';

Math.random = () => 0.5; // deterministic
const fly = (L: Launch, top = 0, surf: 'fairway' | 'green' = 'fairway') => {
  TEST.surface = surf;
  const b = new Ball(null); b.tee(new THREE.Vector3(0, 0.02135, 0)); b.hit(L);
  let landDeg = 0;
  for (let i = 0; i < 120 * 60 && b.phase !== 'stopped'; i++) {
    if (b.phase === 'flight' && b.t > 0.5) b.setAftertouch(top, 0);
    const vx = b.vel.x, vy = b.vel.y, vz = b.vel.z, had = !!b.landing;
    b.step(1 / 120);
    if (!had && b.landing) landDeg = Math.atan2(-vy, Math.hypot(vx, vz)) * 180 / Math.PI;
  }
  return { c: b.carry() / YD, t: b.total() / YD, r: b.roll() / YD, apex: b.apex / YD, land: landDeg, side: b.offline() / YD };
};
const plan = (ci: number, mode: ShotMode = 'full', extra: any = {}) => planShot({ power: 1, offMs: 0, pushMs: 200, angle: 0, drift: 0, released: false, ...extra }, ci, mode, LIES[0], true);
const f = (n: number, w = 4) => n.toFixed(0).padStart(w);
console.log('club | carry total roll apex land° | low-strike c/t | high-strike c/t | max-top total | max-back roll (green)');
for (let ci = 0; ci < CLUB_SPECS.length; ci++) {
  const a = fly(plan(ci).launch), lo = fly(plan(ci, 'full', { strike: { x: 0, y: -1 } }).launch), hi = fly(plan(ci, 'full', { strike: { x: 0, y: 1 } }).launch);
  const t = fly(plan(ci).launch, 1), bk = fly(plan(ci).launch, -1, 'green');
  console.log(`${CLUB_SPECS[ci].id.padEnd(4)} | ${f(a.c, 5)} ${f(a.t, 5)} ${f(a.r)} ${f(a.apex)} ${f(a.land, 5)} | ${f(lo.c)} /${f(lo.t)} | ${f(hi.c)} /${f(hi.t)} | ${f(t.t)} (+${(((t.t - a.t) / a.t) * 100).toFixed(0)}%) | ${f(bk.r)}`);
}
console.log('\nmodes:');
for (const [lab, ci, m, s] of [['punch 7i', 6, 'punch', 'fairway'], ['pitch 56°', 11, 'pitch', 'green'], ['flop 60°', 12, 'flop', 'green']] as [string, number, ShotMode, 'fairway' | 'green'][]) {
  const a = fly(plan(ci, m).launch, 0, s); console.log(`  ${lab.padEnd(10)} carry ${f(a.c)} roll ${f(a.r)} apex ${f(a.apex)} land ${f(a.land)}° (${s})`);
}
console.log('\nstrike point, 7i (left-hander):');
for (const [lab, s] of [['centre', { x: 0, y: 0 }], ['low on ball', { x: 0, y: -1 }], ['high on ball', { x: 0, y: 1 }], ['inner half', { x: -1, y: 0 }], ['outer half', { x: 1, y: 0 }]] as [string, any][]) {
  const P = plan(6, 'full', { strike: s }); const a = fly(P.launch);
  console.log(`  ${lab.padEnd(13)} launch ${(P.launch.launch * 57.3).toFixed(1)}° spin ${Math.round(P.launch.spinRpm)} carry ${f(a.c)} total ${f(a.t)} side ${a.side.toFixed(1)} yd → ${P.shape}`);
}

console.log('\naim view intent, 7i (left-hander; a lefty draw curves right):');
for (const [lab, a] of [['straight', { curve: 0, loft: 0 }], ['curve +1 (bends right)', { curve: 1, loft: 0 }], ['curve -1 (bends left)', { curve: -1, loft: 0 }], ['curve +0.5', { curve: 0.5, loft: 0 }], ['loft +1 (higher)', { curve: 0, loft: 1 }], ['loft -1 (lower)', { curve: 0, loft: -1 }]] as [string, any][]) {
  const P = plan(6, 'full', { aim: a }); const r = fly(P.launch);
  console.log(`  ${lab.padEnd(24)} start ${(P.launch.azimuth * 57.3).toFixed(1).padStart(5)}° tilt ${(P.launch.tilt * 57.3).toFixed(0).padStart(3)}° launch ${(P.launch.launch * 57.3).toFixed(1)}° spin ${Math.round(P.launch.spinRpm)} carry ${f(r.c)} total ${f(r.t)} lands ${r.side.toFixed(1)} yd off line → ${P.shape}`);
}
const both = plan(6, 'full', { aim: { curve: 1, loft: 0 }, angle: 8 }); const rb = fly(both.launch);
console.log(`  curve +1 plus a push 8° right: lands ${rb.side.toFixed(1)} yd off line → ${both.shape}`);
