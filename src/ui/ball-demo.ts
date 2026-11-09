// Dev page: the Pro V1x as the HUD draws it (CPU shaded, several orientations) and the in-game 3D ball.
// /src/ui/ball-demo.html?bg=%235a2c17 sets the backdrop (to match a reference photo).
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { shadeBall, mat3Identity, mat3Rotate, onBallTexUpdate } from './balltex';
import { tourBallMaterial } from './ballmat';

const q = new URLSearchParams(location.search);
document.body.style.background = q.get('bg') ?? '#3d7a30';
const S = 360;
const views: [number, number][] = [[0.25, 0], [0.25, 0.7], [0.25, Math.PI], [-0.9, 0.3]];
const cvs = views.map(() => { const c = document.createElement('canvas'); c.width = c.height = S; document.body.appendChild(c); return c; });
const draw = () => views.forEach(([ax, ay], i) => { const m = mat3Identity(); mat3Rotate(m, 0, ay); mat3Rotate(m, ax, 0); const g = cvs[i].getContext('2d')!; g.clearRect(0, 0, S, S); g.drawImage(shadeBall(S, m), 0, 0); });
draw(); onBallTexUpdate(draw);

const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }); r.setPixelRatio(1); r.setSize(S, S); document.body.appendChild(r.domElement);
r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.05;
const scene = new THREE.Scene(); const cam = new THREE.PerspectiveCamera(16, 1, 0.01, 10); cam.position.set(0, 0.05, 0.16); cam.lookAt(0, 0, 0);
const pm = new THREE.PMREMGenerator(r); scene.environment = pm.fromScene(new RoomEnvironment(), 0.03).texture; scene.environmentIntensity = 0.38;
const key = new THREE.DirectionalLight('#fff4e6', 3.4); key.position.set(-0.9, 1.1, 0.75); scene.add(key);
const ball = new THREE.Mesh(new THREE.SphereGeometry(0.02135, 96, 64), tourBallMaterial()); scene.add(ball);
ball.rotation.x = -0.1;
const render = () => r.render(scene, cam);
onBallTexUpdate(render);
const loop = () => { render(); requestAnimationFrame(loop); }; loop();
setTimeout(() => { (window as any).__ready = true; }, 2500);
