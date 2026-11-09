// Render test: render.html?view=portrait|landscape|flight &q=low|med|high &time=golden|midday &tm=agx|aces &frames=N &stats=0
// A stand-in golfer (left-hander at +x, ball at the origin, target -Z) to judge light, shadows and turf.
import * as THREE from 'three';
import { createRange, YD, type TimeOfDay } from '../world/range';
import { createPost, type Quality } from './post';
import { Golfer, PHI_TOP } from '../golfer/golfer';
import { NEIL } from '../golfer/profile';
import { loadNeil } from '../golfer/assets';

const qs = new URLSearchParams(location.search);
const view = qs.get('view') ?? (innerHeight > innerWidth ? 'portrait' : 'landscape');
const quality = (qs.get('q') ?? 'high') as Quality;
const time = (qs.get('time') ?? 'golden') as TimeOfDay;
const maxFrames = Number(qs.get('frames') ?? 0);

const renderer = new THREE.WebGLRenderer({ antialias: quality === 'low', powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);
renderer.info.autoReset = false;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(view === 'portrait' ? 52 : 40, innerWidth / innerHeight, 0.1, 7000);
const range = createRange(renderer, scene);
range.setTimeOfDay(time);
// the featured target (the game sets it from the club in hand): ?feat=yards, 0 to hide
if (qs.get('feat') !== '0') range.setFeaturedTarget(Number(qs.get('feat') ?? 160));
const post = createPost(renderer, scene, camera, { quality, grade: time, toneMapping: (qs.get('tm') as 'agx' | 'aces') ?? 'agx' });
// depth of field like the game's address camera (?dof=0 to compare)
post.setDof(view === 'portrait' || view === 'landscape' ? Number(qs.get('dof') ?? 1) : 0, Number(qs.get('ds') ?? 90), Number(qs.get('de') ?? 420));

// stand-in golfer at address: legs, hips, a tilted torso, head with a cap, arms and a club down to the ball
const golfer = new THREE.Group();
const shirt = new THREE.MeshStandardMaterial({ color: '#e9e6df', roughness: 0.8 });
const pants = new THREE.MeshStandardMaterial({ color: '#2b3039', roughness: 0.75 });
const skin = new THREE.MeshStandardMaterial({ color: '#d9a68b', roughness: 0.6 });
const add = (g: THREE.BufferGeometry, m: THREE.Material, p: [number, number, number], r: [number, number, number] = [0, 0, 0]) => {
  const mesh = new THREE.Mesh(g, m); mesh.position.set(...p); mesh.rotation.set(...r); mesh.castShadow = mesh.receiveShadow = true; golfer.add(mesh); return mesh;
};
for (const s of [-1, 1]) add(new THREE.CapsuleGeometry(0.075, 0.78, 6, 12), pants, [0.05, 0.47, s * 0.2], [0, 0, 0.12]);
add(new THREE.CapsuleGeometry(0.16, 0.12, 6, 14), pants, [0.0, 0.92, 0]);
add(new THREE.CapsuleGeometry(0.17, 0.42, 6, 14), shirt, [-0.2, 1.2, 0], [0, 0, 0.62]);
add(new THREE.SphereGeometry(0.11, 20, 14), skin, [-0.42, 1.48, 0]);
add(new THREE.CylinderGeometry(0.12, 0.12, 0.06, 20), shirt, [-0.42, 1.56, 0], [0, 0, 0.3]);
for (const s of [-1, 1]) add(new THREE.CapsuleGeometry(0.05, 0.55, 6, 10), shirt, [-0.48, 1.05, s * 0.12], [s * 0.15, 0, 0.35]);
add(new THREE.CylinderGeometry(0.006, 0.006, 0.95, 8), new THREE.MeshStandardMaterial({ color: '#c8ccd2', metalness: 1, roughness: 0.25 }), [-0.35, 0.42, 0], [0, 0, 0.95]);
golfer.position.set(0.95, 0, 0);
if (qs.get('golfer') === 'capsule') scene.add(golfer);
else {
  // the real golfer (as in the game) so the frame reads like the game's
  const real = new Golfer(NEIL, await loadNeil());
  real.setClub(Number(qs.get('club') ?? 6), 'full');
  const pose = qs.get('pose') ?? 'address';
  real.update({ phase: pose === 'top' ? 'back' : 'address', phi: pose === 'top' ? PHI_TOP : 0, topPhi: PHI_TOP, idleT: 0 });
  scene.add(real.root);
}
const ball = new THREE.Mesh(new THREE.SphereGeometry(0.0214, 24, 16), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 }));
ball.position.set(0, 0.0214, 0); ball.castShadow = true; scene.add(ball);

const focus = new THREE.Vector3(0.6, 0, 0);
if (view === 'portrait') {
  // the game's portrait swing cam: behind the left-hander's trail side, lens shifted up 20%
  camera.position.set(0.7, 1.75, 3.6); camera.lookAt(0.45, 0.35, -6);
  camera.setViewOffset(innerWidth, innerHeight, 0, innerHeight * 0.2, innerWidth, innerHeight); camera.updateProjectionMatrix();
} else if (view === 'flag' || view === 'sign') {
  const t = range.targets.find(g => g.yards === Number(qs.get('yds') ?? 100))!;
  if (view === 'flag') { camera.position.set(t.pos.x - 4.2, t.pos.y + 1.7, t.pos.z + 4.4); camera.lookAt(t.pos.x, t.pos.y + 1.7, t.pos.z); }
  else {
    const side = t.pos.x < 0 ? -1 : 1, W = 2.0 + t.yards * 0.012, bx = t.pos.x + side * (t.radius + W / 2 + 4.0), bz = t.pos.z - 1.0;
    camera.position.set(bx * 0.55, t.pos.y + 1.7, bz + 9); camera.lookAt(bx, t.pos.y + 1.1, bz);
  }
  focus.copy(t.pos);
} else if (view === 'landing' || view === 'landfw') {
  // a ball come to rest down the range (rough, or the fairway), seen from the landing camera's height
  const bx = view === 'landing' ? 31 : 3, bz = -118, by = range.heightAt(bx, bz);
  ball.position.set(bx, by + 0.0214, bz); focus.set(bx, by + 0.0214, bz);
  camera.position.set(bx - 1.4, by + 0.9, bz + 2.2); camera.lookAt(bx, by + 0.05, bz);
} else if (view === 'aim') { camera.position.set(0.5, 50, 22); camera.lookAt(0, 0, -110); focus.set(0, 0, -80);
} else if (view === 'bunker') { camera.position.set(-1, 3.2, -112); camera.lookAt(-6.5, 0, -126); focus.set(-6.5, 0, -126);
} else if (view === 'cup') { const t = range.featured ?? range.targets[0]; camera.position.set(t.pos.x + 0.7, t.pos.y + 0.9, t.pos.z + 1.0); camera.lookAt(t.pos.x, t.pos.y + 0.25, t.pos.z); focus.copy(t.pos);
} else if (view === 'bg') { camera.fov = 18; camera.updateProjectionMatrix(); camera.position.set(0.7, 1.75, 3.6); camera.lookAt(0, 12, -500);
} else if (view === 'trees') { camera.position.set(22, 1.9, -30); camera.lookAt(62, 6.0, -22); focus.set(45, 0, -28);
} else if (view === 'turf') { camera.position.set(1.2, 0.9, 1.6); camera.lookAt(-0.2, 0.0, -1.5); }
else if (view === 'flight') {
  const z = -150 * YD; camera.position.set(1.5, 25, z + 30); camera.lookAt(0, 6, z - 120); focus.set(0, range.heightAt(0, z - 20), z - 20);
} else { camera.position.set(-0.6, 1.62, 5.2); camera.lookAt(0.45, 0.92, -22); }
if (view === 'portrait' || view === 'landscape' || view === 'turf') { range.setShadowFocus(new THREE.Vector3(0.95, 0, 0), 3.5); range.contactShadow(new THREE.Vector3(0.95, 0, 0), 1, 0.5); }

(window as unknown as { __scene: THREE.Scene }).__scene = scene;
const stats = document.getElementById('stats')!;
if (qs.get('stats') === '0') stats.style.display = 'none';
let last = performance.now(), frames = 0;
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  renderer.info.reset();
  range.update(dt, camera, focus);
  const t0 = performance.now();
  post.render(dt);
  frames++;
  const i = renderer.info.render;
  stats.textContent = `${view} · ${quality} · ${time} · calls ${i.calls} · tris ${(i.triangles / 1000).toFixed(0)}k`;
  (window as unknown as { __stats: object }).__stats = { calls: i.calls, triangles: i.triangles, cpuMs: performance.now() - t0 };
  if (maxFrames && frames >= maxFrames) { (window as unknown as { __done: boolean }).__done = true; return; }
  requestAnimationFrame(frame);
}
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); post.setSize(innerWidth, innerHeight); });
requestAnimationFrame(frame);
