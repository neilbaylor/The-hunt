// The aim preview: the predicted flight of a pure strike (current club, mode, aim, curve, strike point; still air),
// drawn at address as a thin glowing ribbon from the ball up into the sky and down to the landing, with a soft ring
// on the ground and an editorial yardage tag. One mesh, rebuilt only when the inputs change.
import * as THREE from 'three';

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

  constructor(scene: THREE.Scene, private max = 240) {
    this.pos = new Float32Array(max * 2 * 3); this.along = new Float32Array(max * 2);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('s', new THREE.BufferAttribute(this.along, 1));
    const idx: number[] = []; for (let i = 0; i < max - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    this.geo.setIndex(idx);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { t: { value: 0 }, op: { value: 1 } },
      vertexShader: 'attribute float s; varying float vS; void main(){ vS = s; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      // warm yellow, fading in off the ball and out toward the landing, with a slow pulse running along it
      fragmentShader: `uniform float t; uniform float op; varying float vS;
        void main(){
          float a = smoothstep(0.0, 0.08, vS) * (1.0 - smoothstep(0.8, 1.0, vS)) * 0.55 + 0.12 * smoothstep(0.0, 0.03, vS);
          float p = exp(-pow((fract(vS - t * 0.35) - 0.5) * 9.0, 2.0)) * 0.45;
          gl_FragColor = vec4(mix(vec3(1.0, 0.80, 0.18), vec3(1.0, 0.95, 0.65), p), (a + p * a) * op * 0.7);   // warm tracer yellow, translucent next to the real one
        }`,
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    // drawn before the other transparent things (hair cards, visor) so the golfer always hides it
    this.mesh = new THREE.Mesh(this.geo, this.mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = -5; this.mesh.visible = false;
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.82, 1, 48), new THREE.MeshBasicMaterial({ color: '#ffd23f', transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
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

  update(dt: number, cam: THREE.Camera, canvas: HTMLElement, show: boolean) {
    this.visible = show && this.pts.length > 2;
    this.mesh.visible = this.ring.visible = this.visible; this.tag.hidden = !this.visible;
    if (!this.visible) return;
    this.t += dt; this.mat.uniforms.t.value = this.t;
    const n = this.pts.length, cp = cam.position, tg = new THREE.Vector3(), v = new THREE.Vector3(), sd = new THREE.Vector3();
    let total = 0; const acc = [0]; for (let i = 1; i < n; i++) { total += this.pts[i].distanceTo(this.pts[i - 1]); acc.push(total); }
    for (let i = 0; i < n; i++) {
      const p = this.pts[i];
      tg.subVectors(this.pts[Math.min(n - 1, i + 1)], this.pts[Math.max(0, i - 1)]).normalize();
      v.subVectors(p, cp); const d = v.length(); v.multiplyScalar(1 / d);
      const lift = Math.min(1, Math.max(0, (p.y - this.pts[0].y) / 18));   // a touch bolder as it climbs, so it reads in the sky
      sd.crossVectors(tg, v).normalize().multiplyScalar(Math.max(0.02, d * 0.0036) * (1 + 0.7 * lift));
      this.pos.set([p.x + sd.x, p.y + sd.y, p.z + sd.z, p.x - sd.x, p.y - sd.y, p.z - sd.z], i * 6);
      this.along[i * 2] = this.along[i * 2 + 1] = acc[i] / Math.max(1e-3, total);
    }
    (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('s') as THREE.BufferAttribute).needsUpdate = true;
    this.geo.setDrawRange(0, (n - 1) * 6);
    const L = this.pts[n - 1], dl = cp.distanceTo(L);
    this.ring.scale.setScalar(Math.max(0.8, dl * 0.018));
    // the yardage tag above the landing spot
    const q = L.clone().add(new THREE.Vector3(0, 1.2 + dl * 0.012, 0)).project(cam), r = canvas.getBoundingClientRect();
    const sy = r.top + (-q.y * 0.5 + 0.5) * r.height;
    // only where the landing is actually in view, below the top HUD (never under the big distance number)
    if (q.z > 1 || sy < 230 || Math.abs(q.x) > 0.95) { this.tag.hidden = true; return; }
    this.tag.style.transform = `translate(${(r.left + (q.x * 0.5 + 0.5) * r.width).toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -100%)`;
  }
}
