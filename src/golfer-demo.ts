// Dev page: look at the golfer in fixed poses. ?pose=address|top|impact|finish|half|down &view=behind|face|dtl|close &club=6 &mode=full
import * as THREE from 'three';
import { Golfer, PHI_TOP, PHI_FINISH, type ShotMode } from './golfer/golfer';
import { NEIL } from './golfer/profile';
import { loadNeil } from './golfer/assets';

const q = new URLSearchParams(location.search);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1); renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color('#9cc3e0');
scene.add(new THREE.HemisphereLight('#cfe6ff', '#4a6a30', 1.1));
const sun = new THREE.DirectionalLight('#fff1dc', 2.6); sun.position.set(-4, 7, 6); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3 }); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: '#5f9f3b', roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
const pmrem = new THREE.PMREMGenerator(renderer);
const envScene = new THREE.Scene(); envScene.background = new THREE.Color('#bcd6ea');
envScene.add(new THREE.HemisphereLight('#ffffff', '#55703a', 3));
scene.environment = pmrem.fromScene(envScene as any, 0.04).texture;

const golfer = new Golfer(q.get('head') === 'makehuman' ? { ...NEIL, head: 'makehuman' } : NEIL, q.has('old') ? undefined : await loadNeil());   // head=makehuman: the old face
golfer.setClub(+(q.get('club') ?? 6), (q.get('mode') ?? 'full') as ShotMode);
if (q.has('tee')) golfer.setTee(+q.get('tee')!);   // ball bottom above the turf, metres
scene.add(golfer.root);
for (const h of (q.get('hide') ?? '').split(',')) golfer.body.root.traverse(o => { if (h && o.name === h) o.visible = false; });
const ball = new THREE.Mesh(new THREE.SphereGeometry(0.02135, 24, 16), new THREE.MeshStandardMaterial({ color: '#fff', roughness: 0.3 }));
ball.castShadow = true; scene.add(ball); golfer.ballWorld(ball.position);

const poses: Record<string, any> = {
  address: { phase: 'address', phi: 0 },
  half: { phase: 'back', phi: PHI_TOP * 0.45 },
  top: { phase: 'back', phi: PHI_TOP },
  down: { phase: 'down', phi: PHI_TOP * 0.4 },
  impact: { phase: 'down', phi: 0 },
  through: { phase: 'follow', phi: PHI_FINISH * 0.3 },
  finish: { phase: 'follow', phi: PHI_FINISH },
  b25: { phase: 'back', phi: PHI_TOP * 0.25 }, b70: { phase: 'back', phi: PHI_TOP * 0.7 }, d70: { phase: 'down', phi: PHI_TOP * 0.7 }, d20: { phase: 'down', phi: PHI_TOP * 0.2 }, t30: { phase: 'follow', phi: PHI_FINISH * 0.3 }, t80: { phase: 'follow', phi: PHI_FINISH * 0.8 },
  t10: { phase: 'follow', phi: PHI_FINISH * 0.1 }, t20: { phase: 'follow', phi: PHI_FINISH * 0.2 }, t45: { phase: 'follow', phi: PHI_FINISH * 0.45 }, t60: { phase: 'follow', phi: PHI_FINISH * 0.6 },
};
golfer.body.setSmile(+(q.get('smile') ?? 0));
// face (generated head): &expr=smile:0.8,grimace:0,browUp:0,blink:1 &gaze=x,y (-1..1)
{ const face = (golfer.body as any).face;
  if (face && q.has('gaze')) { const [gx, gy] = q.get('gaze')!.split(',').map(Number); face.setGaze(gx, gy ?? 0); }
  if (face && q.has('say')) face.say(q.get('say')!);
  if (face && q.has('expr')) face.setExpression(Object.fromEntries(q.get('expr')!.split(',').map(t => { const [k, v] = t.split(':'); return [k, +v]; }))); }
// debugging the generated head's look: &headmat=basic shows its texture unlit; &nofill drops its warm self-fill
golfer.body.root.traverse(o => {
  if (o.name !== 'gen-head') return;
  const m = (o as THREE.Mesh).material as THREE.MeshPhysicalMaterial;
  if (q.get('headmat') === 'basic') (o as THREE.Mesh).material = new THREE.MeshBasicMaterial({ map: m.map });
});
if (q.has('novisor')) golfer.body.root.traverse(o => { if (o.name === 'visor') o.visible = false; });
// generic poses: b0.3 = backswing at 30% of a full top, d0.38 = downswing with the hands at 38% of the top, f0.12 = 12% of the follow-through
const pm = /^([bdf])([\d.]+)$/.exec(q.get('pose') ?? '');
if (pm) poses[pm[0]] = pm[1] === 'b' ? { phase: 'back', phi: PHI_TOP * +pm[2] } : pm[1] === 'd' ? { phase: 'down', phi: PHI_TOP * +pm[2] } : { phase: 'follow', phi: PHI_FINISH * +pm[2] };
const ps = poses[q.get('pose') ?? 'address'];
if (ps) golfer.update({ topPhi: PHI_TOP, idleT: 0, ...ps });
else { golfer.body.bones.forEach((b, i) => { b.quaternion.identity(); if (i === 1) b.position.copy(golfer.body.skel.joint[1]); }); golfer.club.group.visible = false; golfer.root.updateMatrixWorld(true); }

const cam = new THREE.PerspectiveCamera(q.get('view') === 'close' ? 22 : 40, innerWidth / innerHeight, 0.05, 200);
const view = q.get('view') ?? 'behind';
const lx = golfer.lefty ? 1 : -1; // side of the ball the golfer stands on (world x)
if (view === 'game') { cam.position.set(-0.85 * lx, 1.62, 5.6); cam.lookAt(0.45 * lx, 0.92, -22); cam.fov = 42; cam.updateProjectionMatrix(); }
else if (view === 'back') { const h = new THREE.Vector3(); golfer.body.bones[5].getWorldPosition(h); cam.position.set(h.x + lx * 0.9, h.y + 0.25, h.z + 0.5); cam.lookAt(h.x, h.y + 0.05, h.z); }
else if (view === 'eye') { const e = golfer.body.skel.eye.clone(); golfer.body.bones[0].localToWorld(e); golfer.char.localToWorld(e.copy(golfer.body.skel.eye)); cam.position.set(e.x - lx * 0.25, e.y + 0.01, e.z); cam.lookAt(e); }
else if (view === 'shoe') { const h = new THREE.Vector3(); golfer.body.bones[14].getWorldPosition(h); cam.position.set(h.x - 0.55, 0.32, h.z + 0.45); cam.lookAt(h.x, 0.06, h.z); }
else if (view === 'clubhead') { const h = new THREE.Vector3(); golfer.club.group.localToWorld(h.set(0, 0, 0)); cam.position.set(h.x + (q.has('face') ? -0.0 : 0.25) , h.y + 0.12, h.z + (q.has('face') ? 0.35 : 0.3)); cam.lookAt(h); }
else if (view === 'gripfront' || view === 'gripeye' || view === 'gripdtl') {
  // grip close-ups, built in the golfer's own (character) space: face-on from the ball side, or from his eyes
  const g = golfer.club.gripLead.clone().applyQuaternion(golfer.club.group.quaternion).add(golfer.club.group.position);
  const gt = golfer.club.gripTrail.clone().applyQuaternion(golfer.club.group.quaternion).add(golfer.club.group.position);
  const mid = g.clone().lerp(gt, 0.5);
  const head = golfer.char.worldToLocal(golfer.body.bones[5].getWorldPosition(new THREE.Vector3())).add(new THREE.Vector3(0, 0.05, 0.08));
  // eye view: a third of the way from the eyes to the hands, clear of the hair when the head is turned
  const eye = view === 'gripeye' ? head.lerp(mid, 0.33) : view === 'gripdtl' ? mid.clone().add(new THREE.Vector3(-0.42, 0.06, 0.06)) : mid.clone().add(new THREE.Vector3(0.04, 0.03, 0.42));
  const pw = golfer.char.localToWorld(eye.clone()), tw = golfer.char.localToWorld(mid.clone());
  cam.fov = view === 'gripeye' ? 26 : 30; cam.updateProjectionMatrix(); cam.position.copy(pw); cam.lookAt(tw);
}
else if (view === 'hands') { const h = new THREE.Vector3(); golfer.club.group.localToWorld(h.copy(golfer.club.gripLead)); cam.position.set(h.x + lx * 0.15, h.y + 0.12, h.z + 0.45); cam.lookAt(h); }
else if (view === 'portrait') {
  cam.fov = 52; cam.updateProjectionMatrix();
  const c = (q.get('cam') ?? '2.6,1.5,3.4,-0.4,0.95,-8').split(',').map(Number);
  cam.position.set(c[0] * lx, c[1], c[2]); cam.lookAt(c[3] * lx, c[4], c[5]);
}
else if (view === 'pgame') {
  // the game's portrait swing cam, lens shifted up 20%
  cam.fov = 52; cam.position.set(0.7 * lx, 1.75, 3.6); cam.lookAt(0.45 * lx, 0.35, -6);
  cam.setViewOffset(innerWidth, innerHeight, 0, innerHeight * 0.2, innerWidth, innerHeight); cam.updateProjectionMatrix();
}
else if (view === 'gameclose') { cam.position.set(-0.2 * lx, 1.5, 3.2); cam.lookAt(0.7 * lx, 1.0, -1); }
else if (view === 'behind') { cam.position.set(0.2, 1.75, 4.2); cam.lookAt(0, 0.9, -2); }
else if (view === 'face') { cam.position.set(-lx * 3.6, 1.2, 0); cam.lookAt(lx * 0.6, 0.95, 0); }
else if (view === 'dtl') { cam.position.set(lx * 0.9, 1.3, 4.5); cam.lookAt(lx * 0.6, 1.0, 0); }
else if (view === 'close' || view === 'three') {
  const h = new THREE.Vector3(), e = new THREE.Vector3();
  golfer.body.bones[5].getWorldPosition(h);
  e.copy(golfer.body.skel.eye).sub(golfer.body.skel.joint[5]); golfer.body.bones[5].localToWorld(e);
  const f = e.clone().sub(h).setY(0).normalize();
  if (view === 'three') f.applyAxisAngle(new THREE.Vector3(0, 1, 0), +(q.get('turn') ?? 0.6));
  const c = h.clone().add(new THREE.Vector3(0, 0.1, 0));
  cam.position.copy(c).addScaledVector(f, 0.9).add(new THREE.Vector3(0, 0.03, 0)); cam.lookAt(c);
}
renderer.render(scene, cam);
(window as any).__g = golfer; (window as any).__cam = cam; (window as any).__scene = scene;
(window as any).__render = () => renderer.render(scene, cam);   // frame-by-frame captures (face animation clips)
if (view === 'probe') {
  // bare head, flat front light, narrow lens: for face-landmark detection on our own mesh
  golfer.body.root.traverse(o => { if (o.name === 'visor' || o.name === 'hair-shell') o.visible = false; });
  const skin = golfer.body.meshes.find(m => m.name === 'skin') as THREE.SkinnedMesh;
  if (q.has('plain')) { const m = skin.material as THREE.MeshPhysicalMaterial; m.map = null; m.color.set('#d2a48c'); m.needsUpdate = true; }
  const e = new THREE.Vector3(); golfer.char.localToWorld(e.copy(golfer.body.skel.eye));
  const toward = new THREE.Vector3(); golfer.char.localToWorld(toward.set(golfer.body.skel.eye.x, golfer.body.skel.eye.y, golfer.body.skel.eye.z + 1)); toward.sub(e).normalize();
  cam.fov = 14; cam.aspect = innerWidth / innerHeight; cam.updateProjectionMatrix();
  cam.position.copy(e).addScaledVector(toward, 1.25).add(new THREE.Vector3(0, -0.035, 0)); cam.lookAt(e.clone().add(new THREE.Vector3(0, -0.035, 0)));
  sun.position.copy(cam.position).add(new THREE.Vector3(0.3, 0.6, 0)); 
  renderer.render(scene, cam);
  (window as any).__probe = (px: number[][]) => {
    const rc = new THREE.Raycaster(); const out: (number[] | null)[] = [];
    for (const [x, y] of px) {
      rc.setFromCamera(new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1), cam);
      const hit = rc.intersectObject(skin, false)[0];
      out.push(hit ? golfer.body.root.worldToLocal(hit.point.clone()).toArray() : null);
    }
    return out;
  };
}
setTimeout(() => { renderer.render(scene, cam); (window as any).__ready = true; }, +(q.get('wait') ?? 2500));
