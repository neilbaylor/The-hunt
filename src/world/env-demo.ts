// Test page for the range environment: env.html?view=tee|flight|green
import * as THREE from 'three';
import { createRange, YD } from './range';

const qs = new URLSearchParams(location.search);
const view = qs.get('view') ?? 'tee';
const maxFrames = Number(qs.get('frames') ?? 0); // >0: stop after this many frames (for screenshots)
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 6000);
const range = createRange(renderer, scene);

// stand-ins for scale: a ball on a tee and a 1.9 m capsule where the left-handed golfer stands
const ball = new THREE.Mesh(new THREE.SphereGeometry(0.0214, 24, 16), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 }));
ball.position.set(0, 0.03, 0); ball.castShadow = true; scene.add(ball);
const golfer = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 1.5, 6, 12), new THREE.MeshStandardMaterial({ color: 0x2c3e66, roughness: 0.7 }));
golfer.position.set(1.0, 0.95, 0); golfer.castShadow = true; scene.add(golfer);

const focus = new THREE.Vector3();
const t150 = range.targets.find(t => t.yards === 150)!;
if (view === 'flight') {
  const z = -150 * YD;
  camera.position.set(1.5, 25, z + 30); camera.lookAt(0, 6, z - 120);
  focus.set(0, range.heightAt(0, z - 20), z - 20);
  ball.position.set(-2, 18, z - 8);
} else if (view === 'top') {
  camera.position.set(0, 1400, -150); camera.lookAt(0, 0, -151);
  focus.set(0, 0, 0);
} else if (view === 'side') {
  camera.position.set(-160, 60, -60); camera.lookAt(0, 10, -260);
  focus.set(0, 0, -100);
} else if (view === 'green') {
  camera.position.set(t150.pos.x + 4, t150.pos.y + 1.7, t150.pos.z - 13); camera.lookAt(0, 1.2, 0);
  focus.copy(t150.pos);
} else {
  camera.position.set(0.2, 1.75, 4.2); camera.lookAt(0, 1.0, -30);
  focus.set(0.6, 0, 0);
}

const stats = document.getElementById('stats')!;
let last = performance.now(), frames = 0;
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  range.update(dt, camera, focus);
  renderer.render(scene, camera);
  frames++;
  if (frames % 10 === 0 || frames === maxFrames) {
    const i = renderer.info.render;
    stats.textContent = `${view} · calls ${i.calls} · tris ${(i.triangles / 1000).toFixed(0)}k · ${range.surfaceAt(camera.position.x, camera.position.z)}`;
    (window as unknown as { __stats: object }).__stats = { calls: i.calls, triangles: i.triangles, ms: Math.round(performance.now() - now) };
  }
  if (maxFrames && frames >= maxFrames) return;
  requestAnimationFrame(frame);
}
window.addEventListener('resize', () => { camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); });
requestAnimationFrame(frame);
// debug: triangles per object (instanced counts included)
(window as unknown as { __breakdown: () => string }).__breakdown = () => {
  const rows: string[] = [];
  scene.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry, tris = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    const n = (m as unknown as THREE.InstancedMesh).isInstancedMesh ? (m as unknown as THREE.InstancedMesh).count : 1;
    rows.push(`${m.name || m.type} ${tris}x${n}=${Math.round(tris * n / 1000)}k`);
  });
  return rows.join('\n');
};
(window as unknown as { __range: unknown }).__range = range;
