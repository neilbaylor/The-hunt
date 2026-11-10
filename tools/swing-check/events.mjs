// Swing-event checkpoints from tools/refs/swing/swing_events_12.png (face-on projection, mirrored rig: target = +X).
// node events.mjs [club=6] [tee]
import { launch, open } from './pw.mjs';
const club = process.argv[2] ?? '6', tee = process.argv[3];
const { browser, page } = await launch(320, 480);
await open(page, `pose=address&club=${club}${tee ? `&tee=${tee}` : ''}&wait=200&view=face`);
const r = await page.evaluate(() => {
  const g = window.__g, rig = g.rig, P = rig.P, PT = 2.6, PF = -3.2, deg = r => r * 180 / Math.PI;
  const set = s => g.update({ topPhi: PT, idleT: 3.5, ...s });
  const m = () => {
    const cq = g.club.group.quaternion, cp = g.club.group.position;
    const butt = g.club.butt.clone().applyQuaternion(cq).add(cp), sh = cp.clone().sub(butt);      // butt → head
    const arm = rig.wristPos.L.clone().sub(P[7]);
    const el = s => { const a = P[s === 'L' ? 7 : 10], e = P[s === 'L' ? 8 : 11], w = rig.wristPos[s]; return deg(a.clone().sub(e).angleTo(w.clone().sub(e))); };
    return {
      shaftElev: deg(Math.atan2(sh.y, Math.hypot(sh.x, sh.z))),       // + = head above the hands
      shaftFace: deg(Math.atan2(sh.y, sh.x)),                            // face-on angle: 0 = head toward the target, 90 = straight up, 180 = away
      armElev: deg(Math.atan2(arm.y, Math.abs(arm.x))),                  // face-on lead-arm elevation
      handsVsHip: (rig.wristPos.L.y - P[1].y) * 100, elL: el('L'), elR: el('R'),
      chest: deg(g.pose.chestTurn), hips: deg(g.pose.hipTurn),
    };
  };
  const scan = (phase, a, b, n = 80) => { const o = []; for (let i = 0; i <= n; i++) { const u = a + (b - a) * i / n; set({ phase, phi: phase === 'follow' ? PF * u : PT * u }); o.push({ u, ...m() }); } return o; };
  const cross = (arr, key, v = 0) => { for (let i = 1; i < arr.length; i++) if ((arr[i - 1][key] - v) * (arr[i][key] - v) <= 0) return arr[i]; return null; };
  const back = scan('back', 0.05, 1), down = scan('down', 1, 0), fol = scan('follow', 0.01, 0.7);
  const out = {};
  const A = (name, val, ok, note) => { out[name] = [val, ok, note]; };
  const mb = cross(back, 'shaftElev'); if (mb) { A('MB club horizontal: hands vs hip (cm)', mb.handsVsHip, Math.abs(mb.handsVsHip) <= 15, `u=${mb.u.toFixed(2)}`); } else A('MB club horizontal', NaN, false, 'never');
  const lba = cross(back, 'armElev'); if (lba) A('LBA lead arm horizontal: club face-on angle (90 = vertical)', lba.shaftFace, Math.abs(lba.shaftFace - 100) <= 25, `u=${lba.u.toFixed(2)}`); else A('LBA', NaN, false, 'never');
  const tb = back[back.length - 1]; A('TB top: shaft elevation (0 = parallel, + = short of it)', tb.shaftElev, tb.shaftElev >= -8 && tb.shaftElev <= 15, `faceOn=${tb.shaftFace.toFixed(0)} chest=${tb.chest.toFixed(0)} hips=${tb.hips.toFixed(0)} elL=${tb.elL.toFixed(0)}`);
  const eda = cross(down, 'armElev'); if (eda) A('ED lead arm horizontal coming down: club face-on angle (lag: 90-135)', eda.shaftFace, eda.shaftFace >= 75 && eda.shaftFace <= 140, `u=${eda.u.toFixed(2)}`);
  const md = cross(down, 'shaftElev'); if (md) A('MD club horizontal coming down: hands vs hip (cm)', md.handsVsHip, md.handsVsHip <= 5 && md.handsVsHip >= -25, `u=${md.u.toFixed(2)} hips=${md.hips.toFixed(0)}`); else A('MD', NaN, false, 'never');
  set({ phase: 'down', phi: 0 }); const bi = m(); A('BI impact: hips open (deg)', bi.hips, bi.hips >= 30 && bi.hips <= 50, `chest=${bi.chest.toFixed(0)} elL=${bi.elL.toFixed(0)} elR=${bi.elR.toFixed(0)}`);
  const mf = cross(fol, 'shaftElev'); if (mf) { A('MF club horizontal after impact: lead elbow', mf.elL, mf.elL >= 160, `u=${mf.u.toFixed(2)} chest=${mf.chest.toFixed(0)}`); A('MF: trail elbow', mf.elR, mf.elR >= 155, ''); } else A('MF', NaN, false, 'never');
  const lf = cross(fol.filter(f => f.u > 0.1), 'armElev'); if (lf) A('LF lead arm horizontal: club face-on angle (90 = vertical)', lf.shaftFace, Math.abs(lf.shaftFace - 90) <= 25, `u=${lf.u.toFixed(2)} chest=${lf.chest.toFixed(0)}`); else A('LF', NaN, false, 'never');
  return out;
});
await browser.close();
let fails = 0;
for (const [k, [v, ok, note]] of Object.entries(r)) { if (!ok) fails++; console.log(`${ok ? ' PASS' : ' FAIL'}  ${k.padEnd(66)} ${(+v).toFixed(1).padStart(7)}  ${note ?? ''}`); }
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
