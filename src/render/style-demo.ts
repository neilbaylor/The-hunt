// Style lab: style.html?style=0..5 &pose=address|top|finish &view=portrait|close &pr=N
// The real range and golfer in the portrait swing cam, with a hand-drawn finish from styles.ts.
import * as THREE from 'three';
import { createRange } from '../world/range';
import { Golfer, PHI_TOP, PHI_FINISH } from '../golfer/golfer';
import { NEIL } from '../golfer/profile';
import { loadNeil } from '../golfer/assets';
import { createStyler, type StyleId } from './styles';

const qs = new URLSearchParams(location.search);
const style = Number(qs.get('style') ?? 1) as StyleId;
const pose = qs.get('pose') ?? 'address';
const view = qs.get('view') ?? 'portrait';

const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(Number(qs.get('pr') ?? Math.min(devicePixelRatio, 2)));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 7000);
const range = createRange(renderer, scene);
range.setTimeOfDay((qs.get('time') as 'golden' | 'midday') ?? 'golden');

const golfer = new Golfer(NEIL, await loadNeil());
golfer.setClub(6, 'full');
const st = pose === 'top' ? { phase: 'back' as const, phi: PHI_TOP } : pose === 'finish' ? { phase: 'follow' as const, phi: PHI_FINISH } : { phase: 'address' as const, phi: 0 };
golfer.update({ ...st, topPhi: PHI_TOP, idleT: 0 });
// front three-quarter head-and-shoulders, like the intro: he looks up at the camera with a friendly smile
let faceCam: THREE.Vector3 | null = null;
if (view === 'face') {
  golfer.body.setSmile(Number(qs.get('smile') ?? 0.6));
  for (let pass = 0; pass < 3; pass++) {
    const head = new THREE.Vector3(); golfer.body.bones[5].getWorldPosition(head);
    const eye = golfer.char.localToWorld(golfer.body.skel.eye.clone());
    const fwd = eye.clone().sub(head); fwd.y = 0; fwd.normalize();
    // swing the view 35° toward the camera side (the range behind him), lift slightly
    fwd.applyAxisAngle(new THREE.Vector3(0, 1, 0), Number(qs.get('turn') ?? 0.6));
    faceCam = eye.clone().addScaledVector(fwd, 1.05).add(new THREE.Vector3(0, 0.08, 0));
    golfer.update({ ...st, topPhi: PHI_TOP, idleT: 0, lookAt: faceCam });
  }
}
scene.add(golfer.root);
const ball = new THREE.Mesh(new THREE.SphereGeometry(0.0214, 24, 16), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 }));
ball.position.copy(golfer.ballWorld()); ball.castShadow = true; scene.add(ball);
// the game's camera-following fill light
const fill = new THREE.DirectionalLight('#fff3e6', 0.9); scene.add(fill, fill.target);

const feet = new THREE.Vector3(0.9, 0, 0);
if (view === 'face' && faceCam) {
  const head = new THREE.Vector3(); golfer.body.bones[5].getWorldPosition(head);
  camera.fov = 21; camera.position.copy(faceCam); camera.lookAt(head.x, head.y - 0.06, head.z);
} else if (view === 'close') {
  // head and upper body, from the camera side
  const h = new THREE.Vector3(); golfer.body.bones[5].getWorldPosition(h);
  camera.fov = 30; camera.position.set(h.x + 0.9, h.y + 0.05, h.z + 1.3); camera.lookAt(h.x - 0.05, h.y - 0.22, h.z);
} else {
  camera.position.set(0.7, 1.75, 3.6); camera.lookAt(0.45, 0.35, -6);
  camera.setViewOffset(innerWidth, innerHeight, 0, innerHeight * 0.2, innerWidth, innerHeight);
}
camera.updateProjectionMatrix(); camera.updateMatrixWorld();
fill.position.copy(camera.position).add(new THREE.Vector3(-1.5, 2.2, 0.5)); fill.target.position.set(0.8, 1.1, 0);
range.setShadowFocus(feet, 3.5); range.contactShadow(feet, 1, 0.5);

const styler = createStyler(renderer, scene, camera, style);
addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); styler.setSize(innerWidth, innerHeight); });
let frames = 0;
const focus = new THREE.Vector3(0.6, 0, 0);
function frame() {
  range.update(1 / 60, camera, focus);
  styler.render();
  frames++;
  if (frames === 6) setTimeout(() => { styler.render(); (window as any).__ready = true; }, 2500);
  if (frames < 6) requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
(window as any).__setStyle = (id: StyleId) => { styler.setStyle(id); styler.render(); };
