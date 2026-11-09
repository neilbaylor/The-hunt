// Dev page: the tour ball at several orientations (HUD shading) and the in-game ball (three.js).
import * as THREE from 'three';
import { shadeBall, mat3Identity, mat3Rotate, ballTex, onBallTexUpdate } from './balltex';

const views: [number, number][] = [[0, 0], [0, 0.6], [0.5, -0.4], [0, Math.PI], [-1.0, 0.3]];
const cvs = views.map(() => { const c = document.createElement('canvas'); c.width = c.height = 300; document.body.appendChild(c); return c; });
const draw = () => views.forEach(([ax, ay], i) => { const m = mat3Identity(); mat3Rotate(m, ax, ay); cvs[i].getContext('2d')!.clearRect(0, 0, 300, 300); cvs[i].getContext('2d')!.drawImage(shadeBall(300, m), 0, 0); });
draw(); onBallTexUpdate(draw);

const r = new THREE.WebGLRenderer({ antialias: true, alpha: true }); r.setSize(300, 300); document.body.appendChild(r.domElement);
r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene(); const cam = new THREE.PerspectiveCamera(20, 1, 0.01, 10); cam.position.set(0, 0, 0.14);
scene.add(new THREE.HemisphereLight('#dfefff', '#4a7a30', 1.2)); const sun = new THREE.DirectionalLight('#fff3e0', 3); sun.position.set(-1, 1.4, 1.2); scene.add(sun);
const pm = new THREE.PMREMGenerator(r); const env = new THREE.Scene(); env.background = new THREE.Color('#b9d4ec'); scene.environment = pm.fromScene(env as any).texture;
const T = ballTex();
const pr = new THREE.CanvasTexture(T.printCanvas); pr.colorSpace = THREE.SRGBColorSpace;
const nm = new THREE.CanvasTexture(T.normalCanvas);
const mat = new THREE.MeshPhysicalMaterial({ color: '#fbfaf6', roughness: 0.42, clearcoat: 1, clearcoatRoughness: 0.12, normalMap: nm });
mat.onBeforeCompile = sh => { sh.uniforms.printMap = { value: pr }; sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D printMap;').replace('#include <map_fragment>', '#include <map_fragment>\nvec4 p2 = texture2D(printMap, vNormalMapUv);\ndiffuseColor.rgb = mix(diffuseColor.rgb, p2.rgb, p2.a);'); };
const ball = new THREE.Mesh(new THREE.SphereGeometry(0.02135, 64, 48), mat); scene.add(ball);
onBallTexUpdate(() => { pr.needsUpdate = true; r.render(scene, cam); });
setTimeout(() => { r.render(scene, cam); (window as any).__ready = true; }, 1500);
