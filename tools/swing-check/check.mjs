// Swing assertions (char space: body faces +Z at address, target = +X, lead = L; the lefty is a mirror of this).
// usage: node check.mjs [club=6] [tee]
import { launch, open } from './pw.mjs';
const club = process.argv[2] ?? '6';
const tee = process.argv[3];
const { browser, page } = await launch(320, 480);
await open(page, `pose=address&club=${club}${tee ? `&tee=${tee}` : ''}&wait=200&view=face`);
const r = await page.evaluate(() => {
  const g = window.__g, rig = g.rig, P = rig.P, Q = rig.Q;
  const THREE = g.root.position.constructor; // Vector3
  const V = (x = 0, y = 0, z = 0) => new THREE(x, y, z);
  const B = { pelvis: 1, chest: 3, neck: 4, head: 5, upperL: 7, foreL: 8, upperR: 10, foreR: 11, thighL: 12, thighR: 15, footL: 14, footR: 17 };
  const PT = 2.6, PF = -3.2;
  const deg = r => r * 180 / Math.PI;
  const S = g.body.skel;
  const set = s => g.update({ topPhi: PT, idleT: 0, ...s });
  const elbow = side => { const sh = P[side === 'L' ? B.upperL : B.upperR], el = P[side === 'L' ? B.foreL : B.foreR], wr = rig.wristPos[side]; return deg(sh.clone().sub(el).angleTo(wr.clone().sub(el))); };
  // belt: the skinned belt mesh's average height (char space)
  const beltMesh = []; g.body.root.traverse(o => { if (o.name === 'belt') beltMesh.push(o); });
  const beltY = () => {
    const m = beltMesh[0]; if (!m) return P[B.pelvis].y + 0.1;
    const pos = m.geometry.attributes.position, v = V(); let y = 0, n = 0;
    for (let i = 0; i < pos.count; i += 7) { m.getVertexPosition(i, v); m.localToWorld(v); g.char.worldToLocal(v); y += v.y; n++; }
    return y / n;
  };
  const eye = () => P[B.neck].clone().add(V(0, 0.18, 0).applyQuaternion(Q[B.chest]));   // head centre (independent of where the eyes look)
  const footTail = (fb) => P[fb].clone().add(S.tail[fb].clone().sub(S.joint[fb]).applyQuaternion(Q[fb]));
  const flat = v => Math.atan2(v.x, v.z); // angle from +Z toward +X (toward the target)
  const out = {};
  const seq = [];
  // lead elbow: address → top, impact → through
  let minBack = 999, minThru = 999, minDown = 999;
  for (let i = 0; i <= 20; i++) { set({ phase: 'back', phi: PT * i / 20 }); minBack = Math.min(minBack, elbow('L')); }
  for (let i = 0; i <= 20; i++) { set({ phase: 'down', phi: PT * (1 - i / 20) }); minDown = Math.min(minDown, elbow('L')); }
  const thru = []; for (let i = 0; i <= 11; i++) { set({ phase: 'follow', phi: PF * 0.33 * i / 11 }); const a = elbow('L'); thru.push(a.toFixed(0)); minThru = Math.min(minThru, a); } console.log('thru elbows', thru.join(' '));
  out.leadElbowBack = [minBack, minBack >= 165];
  out.leadElbowThru = [minThru, minThru >= 165];
  out.leadElbowDown_info = [minDown, true];
  // trail elbow at delivery (d0.38) and impact
  for (const [nm, s] of [['deliv', { phase: 'down', phi: PT * 0.38 }], ['impact', { phase: 'down', phi: 0 }]]) {
    set(s);
    const el = P[B.foreR], hip = P[B.thighR], by = beltY();
    const fwd = el.z - hip.z;            // toward the ball
    out[`trailElbowFront_${nm}_cm`] = [fwd * 100, fwd > 0];
    out[`trailElbowHeight_${nm}_cmAboveBelt`] = [(el.y - by) * 100, el.y <= by + 0.05];
    out[`trailElbowAngle_${nm}_info`] = [elbow('R'), true];
  }
  // address references
  set({ phase: 'address', phi: 0 });
  const eye0 = eye();
  const ballR0 = footTail(B.footR);
  const leadFlare0 = deg(flat(footTail(B.footL).sub(P[B.footL]).setY(0)));
  out.leadFlareAddr_deg = [leadFlare0, leadFlare0 >= 20 && leadFlare0 <= 30];
  // steady head: address → impact
  let dx = 0, dy = 0, dz = 0;
  const track = s => { set(s); const e = eye(); dx = Math.max(dx, Math.abs(e.x - eye0.x)); dy = Math.max(dy, Math.abs(e.y - eye0.y)); dz = Math.max(dz, Math.abs(e.z - eye0.z)); };
  for (let i = 0; i <= 20; i++) track({ phase: 'back', phi: PT * i / 20 });
  for (let i = 0; i <= 20; i++) track({ phase: 'down', phi: PT * (1 - i / 20) });
  out.headLateral_cm = [dx * 100, dx <= 0.04];
  out.headVertical_cm = [dy * 100, dy <= 0.025];
  out.headToward_ball_cm_info = [dz * 100, true];
  // trail foot pivot: ball of the foot planted through the whole follow-through
  let piv = 0; set({ phase: 'down', phi: 0 });
  for (let i = 0; i <= 20; i++) { set({ phase: 'follow', phi: PF * i / 20 }); piv = Math.max(piv, footTail(B.footR).distanceTo(ballR0)); }
  for (let i = 0; i <= 20; i++) { set({ phase: 'back', phi: PT * i / 20 }); piv = Math.max(piv, footTail(B.footR).distanceTo(ballR0)); }
  out.trailPivot_cm = [piv * 100, piv <= 0.02];
  // held finish
  set({ phase: 'follow', phi: PF });
  const e = eye(), head = P[B.head], ankL = P[B.footL], ballL = footTail(B.footL);
  const footC = ankL.clone().lerp(ballL, 0.5);
  out.finishHeadOverLeadFoot_x_cm = [(head.x - footC.x) * 100, Math.abs(head.x - footC.x) <= 0.10];
  out.finishHeadOverLeadFoot_xz_cm_info = [Math.hypot(head.x - footC.x, head.z - footC.z) * 100, true];
  const spine = P[B.neck].clone().sub(P[B.pelvis]);
  const lat = deg(Math.atan2(-spine.x, spine.y)); // + = away from the target (reverse-C side)
  out.finishSpineTilt_deg = [lat, lat >= 0 && lat <= 8];
  const pf = V(0, 0, 1).applyQuaternion(Q[B.pelvis]).setY(0);
  const pAng = deg(pf.angleTo(V(1, 0, 0)));
  out.finishPelvisToTarget_deg = [pAng, pAng <= 15];
  const toeAng = deg(g.trailToeFlat.angleTo(V(1, 0, 0)));
  out.finishTrailToeToTarget_deg = [toeAng, toeAng <= 25];
  const leadFlareF = deg(flat(footTail(B.footL).sub(P[B.footL]).setY(0)));
  out.leadFlareFinish_deg = [leadFlareF, leadFlareF >= 20 && leadFlareF <= 30];
  // club wrap (info): shaft vs shoulder line, head past the trail shoulder
  const cq = g.club.group.quaternion, cp = g.club.group.position;
  const butt = g.club.butt.clone().applyQuaternion(cq).add(cp), headC = cp.clone();
  const shaft = headC.clone().sub(butt);
  const shL = P[B.upperL], shR = P[B.upperR], shLine = shR.clone().sub(shL);
  out.finishShaftVsShoulders_deg_info = [deg(Math.min(shaft.angleTo(shLine), Math.PI - shaft.angleTo(shLine))), true];
  { const a = shaft.clone().setY(0), b = shLine.clone().setY(0); const t = deg(a.angleTo(b)); out.finishShaftVsShouldersTopView_deg_info = [Math.min(t, 180 - t), true]; }
  out.finishShaftDown_deg_info = [deg(Math.asin(-shaft.clone().normalize().y)), true];
  const along = headC.clone().sub(shL).dot(shLine.clone().normalize()) - shLine.length();
  out.finishHeadPastTrailShoulder_cm_info = [along * 100, true];
  const grip = g.club.gripLead.clone().applyQuaternion(cq).add(cp);
  out.finishHandsAboveHead_cm_info = [(grip.y - head.y) * 100, true];
  return out;
});
await browser.close();
let fails = 0;
for (const [k, [v, ok]] of Object.entries(r)) { if (!ok) fails++; console.log(`${ok ? (k.endsWith('_info') ? ' info' : ' PASS') : ' FAIL'}  ${k.padEnd(42)} ${v.toFixed(1)}`); }
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
