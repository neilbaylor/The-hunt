// The aim preview: the predicted flight of a pure strike (current club, mode, aim, curve, strike point; still air),
// drawn at address as a pin-yellow glowing ribbon (constant ~4.5 px core, depth-tested so the golfer hides it) from the ball up into the sky and down to the landing, with a soft ring
// on the ground and an editorial yardage tag. One mesh, rebuilt only when the inputs change.
import * as THREE from 'three';

/** on-screen widths (CSS px): the solid core, and the whole ribbon with its glow */
const CORE_PX = 5.5, HALF_PX = 8.5;   // a ~4.5 px yellow core inside a ~1 px dark border, then the glow

export class AimPreview {
  readonly mesh: THREE.Mesh;
  readonly ring: THREE.Mesh;
  private pts: THREE.Vector3[] = [];
  private geo = new THREE.BufferGeometry();
  private pos: Float32Array; private along: Float32Array;
  private mat: THREE.ShaderMaterial;
  private tag: HTMLDivElement;
  private key = '';
  private t = 0;
  visible = false;

  constructor(scene: THREE.Scene, private max = 240, private ground: (x: number, z: number) => number = () => 0) {
    this.pos = new Float32Array(max * 2 * 3); this.along = new Float32Array(max * 2);
    const across = new Float32Array(max * 2); for (let i = 0; i < max; i++) { across[i * 2] = -1; across[i * 2 + 1] = 1; }
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('s', new THREE.BufferAttribute(this.along, 1));
    this.geo.setAttribute('x', new THREE.BufferAttribute(across, 1));
    const idx: number[] = []; for (let i = 0; i < max - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    this.geo.setIndex(idx);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { t: { value: 0 }, op: { value: 1 }, core: { value: CORE_PX / HALF_PX } },
      vertexShader: 'attribute float s; attribute float x; varying float vS; varying float vX; void main(){ vS = s; vX = x; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      // pin yellow (#ffd23f): a solid ~4.5 px core at 0.7 alpha with a soft glow either side; fades in off the ball and
      // out toward the landing, with a slow brighter pulse running along it
      fragmentShader: `uniform float t; uniform float op; uniform float core; varying float vS; varying float vX;
        void main(){
          float x = abs(vX);
          float inner = 1.0 - smoothstep(core * 0.62, core * 0.78, x);            // the yellow body
          float body = 1.0 - smoothstep(core - 0.06, core + 0.06, x);             // body + its subtle dark border
          float glow = pow(max(0.0, 1.0 - x), 2.2) * 0.34;
          float along = smoothstep(0.0, 0.05, vS) * (1.0 - smoothstep(0.86, 1.0, vS) * 0.55);
          float p = exp(-pow((fract(vS - t * 0.35) - 0.5) * 9.0, 2.0)) * 0.35;
          vec3 yel = mix(vec3(1.0, 0.824, 0.247), vec3(1.0, 0.95, 0.7), p);
          vec3 c = mix(vec3(0.078, 0.157, 0.294), yel, inner);                     // navy edge round the yellow core
          float a = (body * mix(0.5, 0.78, inner) + glow * (1.0 - body)) * along * op;
          if (a < 0.004) discard;
          gl_FragColor = vec4(body > 0.01 ? c : vec3(1.0, 0.824, 0.247), a);
        }`,
      // depth-tested against the golfer (he hides it), drawn before the other transparent things (hair cards, visor)
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = -5; this.mesh.visible = false;
    // the landing ring: pin yellow, a crisp ring with a soft glow inside it
    const ringMat = new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `varying vec2 vP;
        void main(){
          float r = length(vP);
          float ring = smoothstep(0.80, 0.86, r) * (1.0 - smoothstep(0.94, 1.0, r));
          float fill = smoothstep(0.3, 0.84, r) * (1.0 - smoothstep(0.84, 0.9, r)) * 0.22;
          float a = ring * 0.85 + fill;
          if (a < 0.004) discard;
          gl_FragColor = vec4(1.0, 0.824, 0.247, a);
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    this.ring = new THREE.Mesh(new THREE.CircleGeometry(1, 64), ringMat);
    this.ring.rotation.x = -Math.PI / 2; this.ring.visible = false; this.ring.renderOrder = 6;
    scene.add(this.mesh, this.ring);
    this.tag = document.createElement('div'); this.tag.className = 'aim-preview-tag'; this.tag.hidden = true;
    document.body.appendChild(this.tag);
  }

  /** replace the path (world points from the ball to the landing). key: skip the rebuild when nothing changed */
  set(key: string, pts: THREE.Vector3[], yds: number) {
    if (key === this.key) return; this.key = key;
    this.pts = pts.length > this.max ? pts.filter((_, i) => i % Math.ceil(pts.length / this.max) === 0) : pts;
    const L = this.pts[this.pts.length - 1];
    if (L) { this.ring.position.set(L.x, L.y + 0.05, L.z); }
    this.tag.innerHTML = `${Math.round(yds)}<small>YDS</small>`;
  }

  /** the ground track of the flight at fraction t (0 = ball, 1 = landing), by index along the path */
  pointAt(t: number, out: THREE.Vector3): THREE.Vector3 | null {
    const n = this.pts.length; if (n < 3) return null;
    const f = Math.min(n - 1, Math.max(0, t * (n - 1))), i = Math.floor(f), j = Math.min(n - 1, i + 1);
    return out.lerpVectors(this.pts[i], this.pts[j], f - i);
  }

  /** flat: 0 = the flight in the air (swing view) .. 1 = laid on the ground as the shot shape (aim view); the camera
   *  flight between the two views drives it, so the swing view's tracer morphs into the aim view's line */
  update(dt: number, cam: THREE.Camera, canvas: HTMLElement, show: boolean, flat = 0) {
    this.visible = show && this.pts.length > 2;
    this.mesh.visible = this.visible; this.ring.visible = this.visible && flat < 0.5; this.tag.hidden = !this.visible || flat > 0.05;
    if (!this.visible) return;
    this.t += dt; this.mat.uniforms.t.value = this.t;
    const n = this.pts.length, cp = cam.position, tg = new THREE.Vector3(), v = new THREE.Vector3(), sd = new THREE.Vector3();
    // world size of one CSS pixel at unit distance, so the ribbon keeps a constant screen width (core + glow)
    const pc = cam as THREE.PerspectiveCamera, ch = Math.max(1, canvas.clientHeight || canvas.getBoundingClientRect().height);
    const pxAt1 = pc.isPerspectiveCamera ? 2 * Math.tan(THREE.MathUtils.degToRad(pc.fov / 2)) / ch / (pc.view?.enabled ? pc.view.height / pc.view.fullHeight : 1) : 0.002;
    const P = this.pts.map(p => flat <= 0 ? p : p.clone().setY(p.y + (this.ground(p.x, p.z) + 0.12 - p.y) * flat));
    let total = 0; const acc = [0]; for (let i = 1; i < n; i++) { total += P[i].distanceTo(P[i - 1]); acc.push(total); }
    const halfPx = HALF_PX * (1 + 0.25 * flat);   // a touch bolder from overhead
    for (let i = 0; i < n; i++) {
      const p = P[i];
      tg.subVectors(P[Math.min(n - 1, i + 1)], P[Math.max(0, i - 1)]).normalize();
      v.subVectors(p, cp); const d = v.length(); v.multiplyScalar(1 / d);
      sd.crossVectors(tg, v).normalize().multiplyScalar(Math.max(0.004, d * pxAt1 * halfPx));
      this.pos.set([p.x + sd.x, p.y + sd.y, p.z + sd.z, p.x - sd.x, p.y - sd.y, p.z - sd.z], i * 6);
      this.along[i * 2] = this.along[i * 2 + 1] = acc[i] / Math.max(1e-3, total);
    }
    (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('s') as THREE.BufferAttribute).needsUpdate = true;
    this.geo.setDrawRange(0, (n - 1) * 6);
    const L = this.pts[n - 1], dl = cp.distanceTo(L);
    this.ring.scale.setScalar(Math.max(0.8, dl * 0.02));
    // the yardage tag above the landing spot
    const q = L.clone().add(new THREE.Vector3(0, 1.2 + dl * 0.012, 0)).project(cam), r = canvas.getBoundingClientRect();
    const sy = r.top + (-q.y * 0.5 + 0.5) * r.height;
    // only where the landing is actually in view, below the top HUD (never under the big distance number)
    if (q.z > 1 || sy < 230 || Math.abs(q.x) > 0.95 || flat > 0.05) { this.tag.hidden = true; return; }
    this.tag.style.transform = `translate(${(r.left + (q.x * 0.5 + 0.5) * r.width).toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -100%)`;
  }
}
