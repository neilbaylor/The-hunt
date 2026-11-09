// Dev page: the Pro V1x as the HUD draws it (CPU shaded, front and back) and the in-game 3D ball (front and back)
// on a white studio sweep with a soft contact shadow, to compare against product photos.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { shadeBall, mat3Identity, mat3Rotate, onBallTexUpdate } from './balltex';
import { tourBallMaterial } from './ballmat';

const q = new URLSearchParams(location.search);
document.body.style.background = q.get('bg') ?? '#ffffff';
const S = 360;
const views: [number, number][] = [[0, 0], [0, Math.PI]];
const cvs = views.map(() => { const c = document.createElement('canvas'); c.width = c.height = S; document.body.appendChild(c); return c; });
const draw = () => views.forEach(([ax, ay], i) => { const m = mat3Identity(); mat3Rotate(m, 0, ay); mat3Rotate(m, ax, 0); const g = cvs[i].getContext('2d')!; g.clearRect(0, 0, S, S); g.drawImage(shadeBall(S, m), 0, 0); });
draw(); onBallTexUpdate(draw);

const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }); r.setPixelRatio(1); r.setSize(2 * S, S); document.body.appendChild(r.domElement);
r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.15;
r.shadowMap.enabled = true; r.shadowMap.type = THREE.VSMShadowMap;
const scene = new THREE.Scene(); const cam = new THREE.PerspectiveCamera(14, 2, 0.01, 10); cam.position.set(0, 0.014, 0.21); cam.lookAt(0, 0.0, 0);
const pm = new THREE.PMREMGenerator(r); scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture; scene.environmentIntensity = 0.9;
const key = new THREE.DirectionalLight('#ffffff', 1.6); key.position.set(-0.15, 1, 0.5); key.castShadow = true;
key.shadow.mapSize.set(1024, 1024); key.shadow.radius = 18; key.shadow.blurSamples = 16; Object.assign(key.shadow.camera, { left: -0.1, right: 0.1, top: 0.1, bottom: -0.1, near: 0.1, far: 3 }); scene.add(key);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.28 })); floor.rotation.x = -Math.PI / 2; floor.position.y = -0.02135; floor.receiveShadow = true; scene.add(floor);
const mat = tourBallMaterial();
for (const [x, ry] of [[-0.024, 0], [0.024, Math.PI]] as const) {
  const b = new THREE.Mesh(new THREE.SphereGeometry(0.02135, 128, 96), mat); b.position.x = x; b.rotation.y = ry; b.castShadow = true; scene.add(b);
}
const render = () => r.render(scene, cam);
const loop = () => { render(); requestAnimationFrame(loop); }; loop();
setTimeout(() => { (window as any).__ready = true; }, 2500);
