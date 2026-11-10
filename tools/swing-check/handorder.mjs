import { launch, open } from './pw.mjs';
const { browser, page } = await launch(320, 480);
await open(page, `pose=address&club=${process.argv[2] ?? 6}&wait=200&view=face&${process.argv[3] ?? ""}`);
const r = await page.evaluate(() => {
  const g = __g, V = g.root.position.constructor, E = g.extras, o = [];
  const poses = { address: { phase: 'address', phi: 0 }, top: { phase: 'back', phi: 2.6 }, impact: { phase: 'down', phi: 0 }, f033: { phase: 'follow', phi: -1.06 }, finish: { phase: 'follow', phi: -3.2 } };
  for (const [n, s] of Object.entries(poses)) {
    g.update({ topPhi: 2.6, idleT: 3.5, ...s }); g.root.updateMatrixWorld(true);
    const cq = g.club.group.quaternion, cp = g.club.group.position;
    const butt = g.club.butt.clone().applyQuaternion(cq).add(cp), down = g.club.shaftDir.clone().applyQuaternion(cq).negate().normalize();
    const meshHand = side => g.char.worldToLocal(g.body.bones[E.hand[side]].getWorldPosition(new V()));
    const d = p => p.clone().sub(butt).dot(down) * 100, off = p => { const v = p.clone().sub(butt); return v.addScaledVector(down, -v.dot(down)).length() * 100; };
    const hL = meshHand('L'), hR = meshHand('R');
    o.push(`${n.padEnd(8)} rigWrist L ${d(g.rig.wristPos.L).toFixed(1)} R ${d(g.rig.wristPos.R).toFixed(1)} | meshHand L ${d(hL).toFixed(1)} (off-axis ${off(hL).toFixed(1)}) R ${d(hR).toFixed(1)} (off ${off(hR).toFixed(1)}) | gap L ${(g.__handGap?.L*100).toFixed(1)} R ${(g.__handGap?.R*100).toFixed(1)}`);
  }
  // glove: which hand bone drives the glove-material vertices
  const gl = g.body.materials.glove; const found = [];
  g.body.root.traverse(m => { const mats = Array.isArray(m.material) ? m.material : [m.material]; if (m.isSkinnedMesh && mats.includes(gl)) found.push(m.name); });
  o.push('glove meshes: ' + found.join(','));
  // which side is the glove on? sample glove-coloured skinned vertices... report bone names for hand L/R
  o.push('hand bones L=' + g.body.bones[E.hand.L].name + ' R=' + g.body.bones[E.hand.R].name + ' lefty=' + g.lefty + ' root.scale.x=' + g.root.scale.x);
  return o.join('\n');
});
console.log(r); await browser.close();
