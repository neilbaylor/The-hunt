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

const golfer = new Golfer(NEIL, q.has('old') ? undefined : await loadNeil());
golfer.setClub(+(q.get('club') ?? 6), (q.get('mode') ?? 'full') as ShotMode);
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
};
golfer.body.setSmile(+(q.get('smile') ?? 0));
const ps = poses[q.get('pose') ?? 'address'];
if (ps) golfer.update({ topPhi: PHI_TOP, idleT: 0, ...ps });
else { golfer.body.bones.forEach((b, i) => { b.quaternion.identity(); if (i === 1) b.position.copy(golfer.body.skel.joint[1]); }); golfer.club.group.visible = false; golfer.root.updateMatrixWorld(true); }

const cam = new THREE.PerspectiveCamera(q.get('view') === 'close' ? 22 : 40, innerWidth / innerHeight, 0.05, 200);
const view = q.get('view') ?? 'behind';
const lx = golfer.lefty ? 1 : -1; // side of the ball the golfer stands on (world x)
if (view === 'game') { cam.position.set(-0.85 * lx, 1.62, 5.6); cam.lookAt(0.45 * lx, 0.92, -22); cam.fov = 42; cam.updateProjectionMatrix(); }
else if (view === 'hands') { const h = new THREE.Vector3(); golfer.body.bones[8].getWorldPosition(h); cam.position.set(h.x - lx * 0.5, h.y + 0.15, h.z + 0.35); cam.lookAt(h.x, h.y - 0.05, h.z); }
else if (view === 'portrait') {
  cam.fov = 52; cam.updateProjectionMatrix();
  const c = (q.get('cam') ?? '2.6,1.5,3.4,-0.4,0.95,-8').split(',').map(Number);
  cam.position.set(c[0] * lx, c[1], c[2]); cam.lookAt(c[3] * lx, c[4], c[5]);
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
  if (view === 'three') f.applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.6);
  const c = h.clone().add(new THREE.Vector3(0, 0.1, 0));
  cam.position.copy(c).addScaledVector(f, 0.9).add(new THREE.Vector3(0, 0.03, 0)); cam.lookAt(c);
}
renderer.render(scene, cam);
(window as any).__ready = true;
