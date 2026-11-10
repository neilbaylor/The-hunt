// Clubface assertions at the 13 swing events, plus clubhead close-ups.
// usage: node clubcheck.mjs [club=0] [shots-out.png] [qs-extra]   (dev server on :5230)
// Character space (right-handed; the lefty is a mirror): +X target, +Y up, +Z the way the golfer faces.
// face = the clubface normal (club local +X), toe = heel → toe across the face (face × butt direction),
// shaft = grip → head. Swing plane = the plane through the address shaft line and the target line.
import { launch, open } from '../swing-check/pw.mjs';
import { execFileSync } from 'child_process';
const [club = '0', shots, extra = ''] = process.argv.slice(2);
const EVENTS = execFileSync('python3', ['-I', new URL('./event_poses.py', import.meta.url).pathname]).toString().trim().split(',');
const NAMES = ['BA', 'MB', 'LBA', 'LB', 'EPR', 'TB', 'EDA', 'ED', 'MD', 'BI', 'MF', 'LF', 'FIN'];
const { browser, page } = await launch(390, 844);
await open(page, `view=face&club=${club}&pose=address&wait=200${extra}`);
const state = ps => { const m = /^([bdf])([\d.]+)$/.exec(ps); return ps === 'address' ? { phase: 'address', phi: 0 } : m[1] === 'b' ? { phase: 'back', phi: 2.6 * +m[2] } : m[1] === 'd' ? { phase: 'down', phi: 2.6 * +m[2] } : { phase: 'follow', phi: -3.2 * +m[2] }; };
const rows = [], files = [];
for (const [i, ps] of EVENTS.entries()) {
  const r = await page.evaluate(({ s, shot }) => {
    const g = window.__g, V = g.root.position.constructor;
    g.update({ topPhi: 2.6, idleT: 0, ...s });
    const q = g.club.group.quaternion, sd = g.club.shaftDir.clone();
    const face = new V(1, 0, 0).applyQuaternion(q), butt = sd.clone().applyQuaternion(q), shaft = butt.clone().negate();
    const toe = face.clone().cross(butt).normalize();
    if (!g.__plane) { g.__plane = new V(1, 0, 0).cross(sd).normalize(); if (g.__plane.y < 0) g.__plane.negate(); }
    const N = g.__plane, deg = x => +(x * 180 / Math.PI).toFixed(0);
    // lead forearm (rig: elbow joint → wrist)
    const fore = g.rig.wristPos.L.clone().sub(g.rig.P[8]).normalize();
    const out = { face: face.toArray().map(v => +v.toFixed(2)), toe: toe.toArray().map(v => +v.toFixed(2)), shaft: shaft.toArray().map(v => +v.toFixed(2)),
      toeUpDeg: deg(Math.asin(Math.max(-1, Math.min(1, toe.y)))), faceUpDeg: deg(Math.asin(Math.max(-1, Math.min(1, face.y)))),
      faceVsForearmDeg: deg(Math.asin(Math.min(1, Math.abs(face.dot(fore))))),           // 0 = face parallel to the lead forearm
      toeOffPlaneDeg: deg(Math.asin(Math.min(1, Math.abs(toe.dot(N))))),                 // 0 = toe (leading edge) in the swing plane
      faceOpenDeg: deg(Math.atan2(face.z, face.x)) };
    if (shot) {
      // close-up: the clubhead from in front of the golfer (face-on), and from behind down the line
      const cam = window.__cam, head = g.club.group.localToWorld(new V(0, 0, 0));
      const lx = g.root.scale.x < 0 ? -1 : 1, dir = shot === 1 ? new V(-lx, 0.15, 0) : new V(0, 0.2, 1);
      cam.clearViewOffset?.(); cam.fov = 14; cam.updateProjectionMatrix();
      cam.position.copy(head).addScaledVector(dir.normalize(), 1.1); cam.lookAt(head); window.__render();
    }
    return out;
  }, { s: state(ps), shot: 0 });
  rows.push([NAMES[i], ps, r]);
  if (shots) for (const shot of [1, 2]) {
    await page.evaluate(({ s, shot }) => {
      const g = window.__g, V = g.root.position.constructor; g.update({ topPhi: 2.6, idleT: 0, ...s });
      const cam = window.__cam, head = g.club.group.localToWorld(new V(0, 0, 0)), lx = g.root.scale.x < 0 ? -1 : 1;
      const grip = g.club.group.localToWorld(g.club.gripLead.clone()), aim = head.clone().lerp(grip, 0.1);
      const dir = shot === 1 ? new V(-lx, 0.12, 0) : new V(0, 0.15, 1);
      cam.clearViewOffset?.(); cam.fov = 22; cam.aspect = 390 / 844; cam.updateProjectionMatrix();
      cam.position.copy(aim).addScaledVector(dir.normalize(), 1.6); cam.lookAt(aim); window.__render();
    }, { s: state(ps), shot });
    const f = `${shots}.${i}.${shot}.png`; await page.screenshot({ path: f, clip: { x: 0, y: 197, width: 390, height: 450 } }); files.push(f);
  }
}
await browser.close();
// targets (owner): toe up at MB and MF; at TB face ~parallel to the lead forearm, toe hanging down, leading edge ~45°,
// head pointing down the target line; square at BI; elsewhere no flips (face square to the lead forearm)
const fails = [];
const chk = (ok, msg) => { if (!ok) fails.push(msg); };
let prev = null;
for (const [n, ps, r] of rows) {
  if (n === 'MB' || n === 'MF') chk(r.toeUpDeg >= 50, `${n}: toe up (toe ${r.toeUpDeg}° above horizontal, want ≥ 50°)`);
  if (n === 'TB') {
    chk(r.toeUpDeg <= -20 && r.toeUpDeg >= -70, `TB: toe hanging down, leading edge ~45° (toe ${r.toeUpDeg}°, want -70..-20)`);
    chk(r.faceUpDeg >= 15, `TB: face up toward the sky (${r.faceUpDeg}°), not flipped`);
    chk(r.faceVsForearmDeg <= 25, `TB: face parallel to the lead forearm (${r.faceVsForearmDeg}° off, want ≤ 25)`);
    chk(r.shaft[0] >= 0.75, `TB: head down the target line (shaft x ${r.shaft[0]}, want ≥ 0.75)`);
  }
  if (n === 'BI') chk(Math.abs(r.faceOpenDeg) <= 6 && r.face[0] > 0.9, `BI: square (face ${r.faceOpenDeg}° open, want |·| ≤ 6)`);
  if (['LBA', 'LB', 'EPR', 'EDA', 'ED', 'LF'].includes(n)) chk(r.faceVsForearmDeg <= 30, `${n}: face square to the lead forearm (${r.faceVsForearmDeg}° off, want ≤ 30)`);
  if (prev) { const d = prev.face[0] * r.face[0] + prev.face[1] * r.face[1] + prev.face[2] * r.face[2]; void d; }
  prev = r;
  console.log(n.padEnd(4), ps.padEnd(8), `toe ${String(r.toeUpDeg).padStart(4)}°  face up ${String(r.faceUpDeg).padStart(4)}°  face-vs-forearm ${String(r.faceVsForearmDeg).padStart(3)}°  toe-off-plane ${String(r.toeOffPlaneDeg).padStart(3)}°  open ${String(r.faceOpenDeg).padStart(4)}°  shaft ${r.shaft}`);
}
console.log(fails.length ? 'FAIL\n  ' + fails.join('\n  ') : 'PASS: clubface at all events');
if (shots) execFileSync('python3', ['-c', `
import sys
from PIL import Image, ImageDraw
fs=sys.argv[2:]; names=sys.argv[1].split(',')
ims=[Image.open(f) for f in fs]; w,h=ims[0].size; n=len(names)
o=Image.new('RGB',(w*n,2*h+24),'white'); d=ImageDraw.Draw(o)
for i in range(n):
    d.text((i*w+6,6),names[i]+'  face-on / down-the-line',fill='black')
    o.paste(ims[2*i],(i*w,24)); o.paste(ims[2*i+1],(i*w,24+h))
o.save(fs[0].rsplit('.',3)[0])
import os
[os.remove(f) for f in fs]
`, NAMES.join(','), ...files]);
process.exit(fails.length ? 1 : 0);
