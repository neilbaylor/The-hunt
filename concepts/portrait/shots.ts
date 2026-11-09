// Renders portrait backgrounds for the HUD board: ?shot=address|top|finish|flight|landing
// Uses only public APIs of the game so it keeps working as the golfer/renderer are upgraded.
import * as THREE from 'three';
import { Golfer, PHI_TOP, PHI_FINISH } from '../../src/golfer/golfer';
import { NEIL } from '../../src/golfer/profile';
import { createRange } from '../../src/world/range';
import { Ball, speedForCarry } from '../../src/game/ball';
import { Tracer } from '../../src/game/tracer';
import { loadNeil } from '../../src/golfer/assets';
import { createPost } from '../../src/render/post';

const q = new URLSearchParams(location.search);
const shot = q.get('shot') ?? 'address';
const W = 390, H = 844;
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(+(q.get('pr') ?? 2));
renderer.setSize(W, H);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 7000);
const range = createRange(renderer, scene);
range.setTimeOfDay(q.get('time') === 'midday' ? 'midday' : 'golden');
const golfer = new Golfer(NEIL, await loadNeil());
const post = createPost(renderer, scene, camera, { quality: (q.get('q') as any) ?? 'high', grade: range.timeOfDay, toneMapping: 'agx' });
golfer.setClub(shot === 'landing' || shot === 'flight' ? 6 : 6, 'full');
scene.add(golfer.root);
const ballPos = golfer.ballWorld();
const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(0.02135, 32, 20), new THREE.MeshStandardMaterial({ color: '#fff', roughness: 0.3 }));
ballMesh.castShadow = true; ballMesh.position.copy(ballPos); scene.add(ballMesh);
const tracer = new Tracer(); scene.add(tracer.mesh);

// golfer pose
const poses: Record<string, { phase: 'address' | 'back' | 'down' | 'follow'; phi: number }> = {
  address: { phase: 'address', phi: 0 },
  top: { phase: 'back', phi: PHI_TOP },
  finish: { phase: 'follow', phi: PHI_FINISH },
  flight: { phase: 'follow', phi: PHI_FINISH },
  landing: { phase: 'follow', phi: PHI_FINISH },
};
const P = poses[shot] ?? poses.address;
golfer.update({ phase: P.phase, phi: P.phi, topPhi: PHI_TOP, idleT: 0 });

// a 7-iron at the 150 green for the flight shots
const target = range.targets.find(t => t.yards === 150) ?? range.targets[0];
const focus = new THREE.Vector3().copy(ballPos);
const side = golfer.lefty ? 1 : -1;
if (shot === 'flight' || shot === 'landing') {
  const ball = new Ball(range);
  ball.tee(ballPos.clone());
  const carry = Math.hypot(target.pos.x, target.pos.z) * 0.99;
  const launch = 18 * Math.PI / 180, spin = 6200;
  const az = Math.atan2(target.pos.x, -target.pos.z);
  ball.hit({ speed: speedForCarry(carry, launch, spin), launch, azimuth: az, spinRpm: spin, tilt: 0 });
  const stopT = shot === 'flight' ? 2.4 : 99;
  for (let t = 0; t < 14; t += 1 / 120) {
    ball.step(1 / 120); tracer.push(ball.pos);
    if (t >= stopT) break;
    if (shot === 'landing' && ball.phase === 'stopped') break;
  }
  ballMesh.position.copy(ball.pos);
  focus.copy(ball.pos);
  const dir = new THREE.Vector3(ball.vel.x, 0, ball.vel.z);
  if (dir.lengthSq() < 1e-4) dir.set(target.pos.x, 0, target.pos.z);
  dir.normalize();
  if (shot === 'flight') {
    camera.position.copy(ball.pos).addScaledVector(dir, -14).add(new THREE.Vector3(side * 1.2, 2.5, 0));
    camera.lookAt(ball.pos.clone().addScaledVector(dir, 10).add(new THREE.Vector3(0, -4, 0)));
    ballMesh.scale.setScalar(4);
  } else {
    const lat = new THREE.Vector3(-dir.z, 0, dir.x);
    camera.position.copy(target.pos).addScaledVector(dir, 26).addScaledVector(lat, -9 * side);
    camera.position.y = target.pos.y + 4.5;
    camera.lookAt(ball.pos.clone().add(new THREE.Vector3(0, 1.5, 0)));
    ballMesh.scale.setScalar(2.5);
  }
} else {
  // tight Tiger-2005 framing: behind the golfer, off his trail shoulder, he fills the lower half
  const cx = +(q.get('cx') ?? 1.25), cy = +(q.get('cy') ?? 1.5), cz = +(q.get('cz') ?? 4.2);
  const lx = +(q.get('lx') ?? 0.0), ly = +(q.get('ly') ?? 1.25), lz = +(q.get('lz') ?? -6);
  const pull = shot === 'address' ? 1 : 1.08; // a touch wider for the big swing poses
  camera.position.set(side * cx, cy, cz * pull);
  camera.lookAt(side * lx, ly, lz);
  camera.fov = 50; camera.updateProjectionMatrix();
}
camera.updateMatrixWorld();
// the game's camera-following fill light and the tight golfer shadows
const fill = new THREE.DirectionalLight('#fff3e6', 0.9);
fill.position.copy(camera.position).add(new THREE.Vector3(-1.5, 2.2, 0.5)); fill.target.position.set(ballPos.x + side * 0.8, 1.1, ballPos.z);
scene.add(fill, fill.target);
if (shot !== 'flight' && shot !== 'landing') { const feet = ballPos.clone().add(new THREE.Vector3(side * 0.9, 0, 0)); feet.y = 0; range.setShadowFocus(feet, 3.5); range.contactShadow(feet, 1, 0.5); }

let frames = 0;
function frame() {
  range.update(1 / 60, camera, focus);
  tracer.update(camera, 1);
  post.render(1 / 60);
  if (++frames === 6) (window as any).__ready = true;
  if (frames < 8) requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
