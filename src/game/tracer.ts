// A broadcast-style shot tracer: a camera-facing ribbon that follows the ball.
import * as THREE from 'three';

export class Tracer {
  readonly mesh: THREE.Mesh;
  private pts: THREE.Vector3[] = [];
  private geo = new THREE.BufferGeometry();
  private pos: Float32Array; private alpha: Float32Array;
  constructor(private max = 900, color = '#ffd34d') {
    this.pos = new Float32Array(max * 2 * 3); this.alpha = new Float32Array(max * 2);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('a', new THREE.BufferAttribute(this.alpha, 1));
    const idx: number[] = []; for (let i = 0; i < max - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    this.geo.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color(color) } },
      vertexShader: 'attribute float a; varying float vA; void main(){ vA = a; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 color; varying float vA; void main(){ gl_FragColor = vec4(color, vA); }',
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(this.geo, mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = 5;
  }
  set color(c: string) { (this.mesh.material as THREE.ShaderMaterial).uniforms.color.value.set(c); }
  clear() { this.pts = []; this.geo.setDrawRange(0, 0); }
  push(p: THREE.Vector3) { const l = this.pts[this.pts.length - 1]; if (l && l.distanceToSquared(p) < 0.04) return; if (this.pts.length < this.max) this.pts.push(p.clone()); }
  update(cam: THREE.Camera, fade = 1) {
    const n = this.pts.length; if (n < 2) { this.geo.setDrawRange(0, 0); return; }
    const cp = cam.position, t = new THREE.Vector3(), v = new THREE.Vector3(), side = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const p = this.pts[i];
      t.subVectors(this.pts[Math.min(n - 1, i + 1)], this.pts[Math.max(0, i - 1)]).normalize();
      v.subVectors(p, cp); const d = v.length(); v.multiplyScalar(1 / d);
      side.crossVectors(t, v).normalize().multiplyScalar(Math.max(0.03, d * 0.0028));
      this.pos.set([p.x + side.x, p.y + side.y, p.z + side.z, p.x - side.x, p.y - side.y, p.z - side.z], i * 6);
      const a = (0.25 + 0.7 * Math.min(1, i / 12)) * fade * Math.min(1, (n - i) / 3 + 0.6);
      this.alpha[i * 2] = this.alpha[i * 2 + 1] = a;
    }
    (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('a') as THREE.BufferAttribute).needsUpdate = true;
    this.geo.setDrawRange(0, (n - 1) * 6);
  }
}
