// Per-club set-up assertions: stand distance, ball position, shoulder tilt, attack angle, low point. node setup.mjs
import { launch, open } from './pw.mjs';
const { browser, page } = await launch(320, 480);
await open(page, `pose=address&club=6&wait=200&view=face`);
const rows = await page.evaluate(() => {
  const g = window.__g, rig = g.rig, P = rig.P, S = g.body.skel, deg = r => r * 180 / Math.PI, out = [];
  for (const [ci, tee] of [[0, 0.037], [1, 0.012], [3, 0], [4, 0], [6, 0], [9, 0], [12, 0]]) {
    g.setClub(ci, 'full'); g.setTee(tee);
    g.update({ phase: 'address', phi: 0, topPhi: 2.6, idleT: 3.5 });
    const tail = fb => P[fb].clone().add(S.tail[fb].clone().sub(S.joint[fb]).applyQuaternion(rig.Q[fb]));
    const toeZ = Math.max(tail(14).z, tail(17).z) + 0.07 * g.k;            // ball of the foot + the toes
    const half = (P[14].x - P[17].x) / 2, mid = (P[14].x + P[17].x) / 2;
    const el = () => deg(P[7].clone().sub(P[8]).angleTo(rig.wristPos.L.clone().sub(P[8])));
    const r = { club: g.clubSpec.id, toeToBall: -toeZ * 100, stance: half * 200, ballFwd: (0 - mid) / half, shoulderTilt: deg(Math.atan2(P[7].y - P[10].y, Math.abs(P[7].x - P[10].x))), leadElbow: el(), trailShort: rig.reach.R * 100, spec: g.attackAngleDeg() };
    const head = s => { g.update({ topPhi: 2.6, idleT: 0, ...s }); return g.club.group.position.clone(); };
    const a = head({ phase: 'down', phi: 0.05 }), b = head({ phase: 'follow', phi: -0.05 });
    r.attack = deg(Math.atan2(b.y - a.y, Math.hypot(b.x - a.x, b.z - a.z)));
    let lowY = 9, lowX = 0; const ballX = g.ballC.x;
    for (let i = 0; i <= 60; i++) { const u = -0.2 + 0.4 * i / 60; const h = u >= 0 ? head({ phase: 'down', phi: u * 2.6 }) : head({ phase: 'follow', phi: u * 3.2 }); if (h.y < lowY) { lowY = h.y; lowX = h.x; } }
    r.lowPoint = (lowX - (-0.02135) ) * 100; r.lowDepth = (lowY - g.clubAt.y) * 100; void ballX;
    out.push(r);
  }
  return out;
});
await browser.close();
let fails = 0; const F = (c, m) => { if (!c) { fails++; console.log('  FAIL: ' + m); } };
console.log('club  toe-ball  stance  ballFwd  shTilt  attack(spec)  lowPt  depth  leadElb  trailShort');
for (const r of rows) console.log(`${r.club.padEnd(5)} ${r.toeToBall.toFixed(0).padStart(6)}cm ${r.stance.toFixed(0).padStart(5)}cm ${r.ballFwd.toFixed(2).padStart(7)} ${r.shoulderTilt.toFixed(1).padStart(6)}° ${r.attack.toFixed(1).padStart(6)} (${r.spec.toFixed(1)}) ${r.lowPoint.toFixed(1).padStart(6)} ${r.lowDepth.toFixed(1).padStart(6)} ${r.leadElbow.toFixed(0).padStart(6)} ${r.trailShort.toFixed(1).padStart(8)}`);
for (let i = 1; i < rows.length; i++) { const a = rows[i - 1], b = rows[i];
  F(a.toeToBall >= b.toeToBall - 0.5, `stand distance not decreasing ${a.club}→${b.club}`);
  F(a.ballFwd >= b.ballFwd - 0.01, `ball position not moving back ${a.club}→${b.club}`);
  F(a.shoulderTilt >= b.shoulderTilt - 0.2, `shoulder tilt not decreasing ${a.club}→${b.club}`);
  F(a.attack >= b.attack - 0.2, `attack angle not decreasing ${a.club}→${b.club}`); }
const d = rows[0], w = rows[rows.length - 1];
F(d.ballFwd > 0.6, 'driver ball inside the lead heel'); F(Math.abs(w.ballFwd) < 0.12, 'wedge ball in the middle');
F(w.shoulderTilt > 1 && w.shoulderTilt < 10.5, 'wedge shoulders nearly level, trail still low'); F(d.shoulderTilt > w.shoulderTilt + 8, 'driver trail shoulder clearly low');
for (const r of rows) { F(Math.abs(r.attack - r.spec) < 0.7, `${r.club} attack angle ${r.attack.toFixed(1)} vs ${r.spec.toFixed(1)}`); F(r.leadElbow >= 165, `${r.club} lead elbow at address ${r.leadElbow.toFixed(0)}`); F(r.trailShort < 0.6, `${r.club} trail hand off the grip`); }
F(d.lowPoint <= 0.01, 'driver low point behind the ball'); F(w.lowPoint > 0, 'wedge low point ahead of the ball');
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
