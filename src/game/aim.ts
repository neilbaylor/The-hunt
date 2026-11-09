// Aiming. Two pieces:
//  1. An always-on aim guide in the swing camera: a dashed gold arrow on the ground from the ball toward
//     the target, fading with distance, and a small landing marker where it ends.
//  2. An AIM view (button on the right edge, or 'A' on a keyboard): the camera rises to a steep overhead
//     view down the range. Drag anywhere to move the landing ring (direction + distance, clamped to the
//     club's range), drag the round handle on the curved path to bend the shot (draw / fade intent),
//     pinch or +/- to zoom, Done to return to the swing camera.
// The result lives in `aim` (exported, also on window.__game.aim): dir (radians, + = right of the
// straight-down-the-range line), distanceYds, curve (-1..1, + = the ball bends right).
import * as THREE from 'three';
import type { Range } from '../world/range';

const YD = 0.9144;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export interface Aim { dir: number; distanceYds: number; curve: number; loft: number }
/** loft: -1..1 (launch lower .. higher), set with the loft arc on the left in the aim view */
export const aim: Aim = { dir: 0, distanceYds: 165, curve: 0, loft: 0 };

const NAVY = new THREE.Color('#14284b'), GOLD = new THREE.Color('#f2c21b'), CYAN = new THREE.Color('#5fd8ff'), CREAM = new THREE.Color('#fff6e2');

/** A flat ribbon lying on the ground (or a few cm above it), rebuilt from a list of points each update. */
class Ribbon {
  readonly mesh: THREE.Mesh;
  private pos: Float32Array; private along: Float32Array; private across: Float32Array;
  private geo = new THREE.BufferGeometry();
  readonly mat: THREE.ShaderMaterial;
  constructor(private max: number, color: THREE.Color, opts: { dash?: number; fadeStart?: number; fadeEnd?: number; opacity?: number; edge?: THREE.Color } = {}) {
    this.pos = new Float32Array(max * 2 * 3); this.along = new Float32Array(max * 2); this.across = new Float32Array(max * 2);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('along', new THREE.BufferAttribute(this.along, 1));
    this.geo.setAttribute('across', new THREE.BufferAttribute(this.across, 1));
    const idx: number[] = []; for (let i = 0; i < max - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    this.geo.setIndex(idx);
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        color: { value: color.clone() }, edge: { value: (opts.edge ?? NAVY).clone() }, opacity: { value: opts.opacity ?? 1 },
        dash: { value: opts.dash ?? 0 }, fadeStart: { value: opts.fadeStart ?? 1e6 }, fadeEnd: { value: opts.fadeEnd ?? 2e6 }, flow: { value: 0 },
      },
      vertexShader: 'attribute float along; attribute float across; varying float vA; varying float vX; void main(){ vA = along; vX = across; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform vec3 color; uniform vec3 edge; uniform float opacity, dash, fadeStart, fadeEnd, flow; varying float vA; varying float vX;
        void main(){
          float x = abs(vX - 0.5) * 2.0;                       // 0 centre .. 1 edge
          float body = 1.0 - smoothstep(0.55, 0.7, x);
          float rim = 1.0 - smoothstep(0.88, 1.0, x);
          vec3 c = mix(edge, color, body);
          float a = rim * opacity;
          if (dash > 0.0) { float d = fract((vA - flow) / dash); a *= smoothstep(0.0, 0.06, d) * (1.0 - smoothstep(0.38, 0.46, d)); }
          a *= 1.0 - smoothstep(fadeStart, fadeEnd, vA);
          if (a < 0.01) discard;
          gl_FragColor = vec4(c, a);
        }`,
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = 6;
  }
  set(points: THREE.Vector3[], width: number) {
    const n = Math.min(points.length, this.max); if (n < 2) { this.geo.setDrawRange(0, 0); return; }
    let acc = 0; const t = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < n; i++) {
      const p = points[i];
      if (i > 0) acc += p.distanceTo(points[i - 1]);
      t.subVectors(points[Math.min(n - 1, i + 1)], points[Math.max(0, i - 1)]); t.y = 0; t.normalize();
      s.crossVectors(t, up).normalize().multiplyScalar(width / 2);
      this.pos.set([p.x - s.x, p.y, p.z - s.z, p.x + s.x, p.y, p.z + s.z], i * 6);
      this.along[i * 2] = this.along[i * 2 + 1] = acc;
      this.across[i * 2] = 0; this.across[i * 2 + 1] = 1;
    }
    (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('along') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('across') as THREE.BufferAttribute).needsUpdate = true;
    this.geo.setDrawRange(0, (n - 1) * 6);
  }
}

/** a flat ring (annulus) with a navy rim and a soft translucent fill, lying on the ground */
function makeRing() {
  const g = new THREE.Group();
  const mat = (c: THREE.Color, o: number) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, side: THREE.DoubleSide });
  const fill = new THREE.Mesh(new THREE.CircleGeometry(1, 64), mat(GOLD, 0.07));
  const rimOut = new THREE.Mesh(new THREE.RingGeometry(0.925, 1.045, 96), mat(NAVY, 0.6));
  const rim = new THREE.Mesh(new THREE.RingGeometry(0.945, 1.025, 96), mat(GOLD, 1));
  // centre chevron pointing down the aim line
  const tri = new THREE.Shape(); tri.moveTo(-0.24, 0.2); tri.lineTo(0.24, 0.2); tri.lineTo(0, -0.22); tri.closePath(); // points back toward the ball
  const triOut = new THREE.Mesh(new THREE.ShapeGeometry(tri), mat(NAVY, 0.85)); triOut.scale.setScalar(1.22);
  const triIn = new THREE.Mesh(new THREE.ShapeGeometry(tri), mat(CREAM, 1));
  const chevron = new THREE.Group(); chevron.add(triOut, triIn); triIn.position.z = 0.001;
  for (const m of [fill, rimOut, rim]) { m.rotation.x = -Math.PI / 2; g.add(m); }
  // the chevron rides on the far edge of the ring
  const holder = new THREE.Group(); chevron.position.set(0, 0, -1); holder.add(chevron); holder.rotation.x = -Math.PI / 2; holder.rotation.x = 0; chevron.rotation.x = -Math.PI / 2; g.add(holder);
  fill.renderOrder = rimOut.renderOrder = 6; rim.renderOrder = 7; triOut.renderOrder = 8; triIn.renderOrder = 9;
  return { group: g, chevron: holder };
}

function makeHandle() {
  const g = new THREE.Group();
  const m = (c: THREE.Color) => new THREE.MeshBasicMaterial({ color: c, transparent: true, depthWrite: false, depthTest: false });
  const out = new THREE.Mesh(new THREE.CircleGeometry(1.15, 40), m(new THREE.Color('#0b3a52'))); const inn = new THREE.Mesh(new THREE.CircleGeometry(0.9, 40), m(CYAN)); const dot = new THREE.Mesh(new THREE.CircleGeometry(0.34, 24), m(CREAM));
  const arrow = (sx: number) => { const sh = new THREE.Shape(); sh.moveTo(sx * 1.45, 0.42); sh.lineTo(sx * 2.05, 0); sh.lineTo(sx * 1.45, -0.42); sh.closePath(); return new THREE.Mesh(new THREE.ShapeGeometry(sh), m(CYAN)); };
  for (const [x, o] of [[out, 10], [inn, 11], [dot, 12], [arrow(1), 12], [arrow(-1), 12]] as [THREE.Mesh, number][]) { x.rotation.x = -Math.PI / 2; x.renderOrder = o; g.add(x); }
  inn.position.y = 0.01; dot.position.y = 0.02;
  return g;
}

const CSS = `
.aim-rail { position: fixed; z-index: 30; right: max(10px, env(safe-area-inset-right)); top: calc(var(--aim-top, 38%)); display: grid; gap: 8px; justify-items: end; font-family: 'Fredoka', 'Nunito', system-ui, sans-serif; pointer-events: none; transition: opacity .25s, transform .25s; }
.aim-rail.off { opacity: 0; transform: translateX(16px); }
.aim-rail.off button { pointer-events: none; }
.aim-rail button { pointer-events: auto; -webkit-tap-highlight-color: transparent; border: 0; cursor: pointer; font: 600 15px/1 'Fredoka', 'Nunito', system-ui, sans-serif; color: #14284b; background: linear-gradient(#fffaf0, #f3e6c8); border-radius: 999px; box-shadow: 0 3px 0 #c9b385, 0 6px 14px rgba(10,20,40,.28), inset 0 1px 0 #fff; transition: transform .08s; }
.aim-rail button:active { transform: translateY(2px) scale(.97); box-shadow: 0 1px 0 #c9b385, 0 3px 8px rgba(10,20,40,.25), inset 0 1px 0 #fff; }
.aim-rail button:focus-visible { outline: 3px solid #f2c21b; outline-offset: 2px; }
.aim-rail .aim-go { display: flex; align-items: center; gap: 7px; padding: 9px 13px 9px 10px; }
.aim-rail .aim-go svg { width: 22px; height: 22px; }
.aim-rail .zoom { width: 44px; height: 44px; font-size: 24px; display: grid; place-items: center; }
.aim-rail .done { padding: 11px 16px; background: linear-gradient(#ffe066, #f2c21b); box-shadow: 0 3px 0 #b48a12, 0 6px 14px rgba(10,20,40,.28), inset 0 1px 0 #fff6c2; }
.aim-rail .inaim { display: none; }
body.aiming .aim-rail .inaim { display: grid; }
body.aiming .aim-rail .aim-go { display: none; }
body.aiming .hud .bc, body.aiming .hud .bl, body.aiming .hud .tr { opacity: 0 !important; pointer-events: none !important; transition: opacity .25s; }
body.aiming .hud .br { opacity: .92; }
.aim-loft { position: fixed; z-index: 30; left: max(10px, env(safe-area-inset-left)); top: calc(var(--aim-top, 38%) + 40px); display: none; gap: 6px; justify-items: center; font-family: 'Fredoka', 'Nunito', system-ui, sans-serif; }
body.aiming .aim-loft { display: grid; }
.aim-loft button { -webkit-tap-highlight-color: transparent; border: 0; cursor: pointer; width: 40px; height: 40px; border-radius: 999px; font: 600 22px/1 'Fredoka', system-ui, sans-serif; color: #14284b; background: linear-gradient(#fffaf0, #f3e6c8); box-shadow: 0 3px 0 #c9b385, 0 6px 14px rgba(10,20,40,.28), inset 0 1px 0 #fff; }
.aim-loft button:active { transform: translateY(2px) scale(.97); }
.aim-loft button:focus-visible { outline: 3px solid #f2c21b; outline-offset: 2px; }
.aim-loft .arc { display: grid; justify-items: center; background: rgba(255,246,226,.92); border-radius: 14px; padding: 6px 6px 4px; box-shadow: 0 4px 10px rgba(10,20,40,.25); }
.aim-loft .arc svg { width: 56px; height: 35px; }
.aim-loft .lv { font: 600 11px/1 'Fredoka', system-ui, sans-serif; color: #14284b; letter-spacing: .02em; }
.aim-label { position: fixed; z-index: 29; left: 0; top: 0; pointer-events: none; transform: translate(-50%, -100%); font: 600 14px/1.1 'Fredoka', 'Nunito', system-ui, sans-serif; color: #14284b; background: #fff6e2; border-radius: 999px; padding: 6px 11px; box-shadow: 0 2px 0 #c9b385, 0 4px 10px rgba(10,20,40,.3); white-space: nowrap; transition: opacity .2s; }
.aim-label b { color: #b8860b; font-weight: 700; }
.aim-label.off { opacity: 0; }
.aim-tip { position: fixed; z-index: 29; left: 50%; bottom: calc(max(16px, env(safe-area-inset-bottom)) + 8px); transform: translateX(-50%); font: 500 13px/1.25 'Nunito', system-ui, sans-serif; color: #fff; background: rgba(20,40,75,.82); padding: 9px 14px; border-radius: 14px; text-align: center; pointer-events: none; max-width: calc(100vw - 32px); box-shadow: 0 4px 14px rgba(0,0,0,.25); transition: opacity .25s; }
.aim-tip b { color: #f2c21b; }
.aim-tip.off { opacity: 0; }
@media (prefers-reduced-motion: reduce) { .aim-rail, .aim-label, .aim-tip { transition: none; } }
`;

export interface AimOptions {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLElement;
  range: Range | null;
  ballPos: () => THREE.Vector3;
  /** carry window for the current club and mode, in yards */
  carry: () => { min: number; max: number; full: number };
  lefty: boolean;
  onChange?: () => void;
}

export class AimController {
  active = false;
  zoom = 1;
  private enabled = false;
  private guide = new Ribbon(80, GOLD, { dash: 1.1, fadeStart: 10, fadeEnd: 34, opacity: 0.8 });
  private marker = makeRing();
  private aimLine = new Ribbon(80, GOLD, { opacity: 0.95 });
  private pathLine = new Ribbon(96, CYAN, { opacity: 0.95, edge: new THREE.Color('#0b3a52') });
  private ring = makeRing();
  private handle = makeHandle();
  private rail: HTMLDivElement; private loftRail: HTMLDivElement; private label: HTMLDivElement; private tip: HTMLDivElement;
  private ray = new THREE.Raycaster();
  private drag: 'ring' | 'bend' | null = null;
  private pts = new Map<number, { x: number; y: number }>();
  private pinch0 = 0; private zoom0 = 1;
  private t = 0;
  private loftShown = NaN;

  constructor(private o: AimOptions) {
    o.scene.add(this.guide.mesh, this.marker.group, this.aimLine.mesh, this.pathLine.mesh, this.ring.group, this.handle);
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    this.rail = document.createElement('div'); this.rail.className = 'aim-rail off';
    this.rail.innerHTML = `
      <button type="button" class="aim-go" aria-label="Aim the shot"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="#14284b" stroke-width="2.4"/><circle cx="12" cy="12" r="4.2" fill="#f2c21b" stroke="#14284b" stroke-width="1.6"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4" stroke="#14284b" stroke-width="2.4" stroke-linecap="round"/></svg>Aim</button>
      <div class="inaim" style="gap:8px;justify-items:end">
        <button type="button" class="zoom" data-z="out" aria-label="Zoom out">−</button>
        <button type="button" class="zoom" data-z="reset" aria-label="Reset aim to straight"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M19 12a7 7 0 1 1-2.05-4.95" fill="none" stroke="#14284b" stroke-width="2.4" stroke-linecap="round"/><path d="M17.5 3.5v4.2h-4.2" fill="none" stroke="#14284b" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.6" fill="#f2c21b"/></svg></button>
        <button type="button" class="zoom" data-z="in" aria-label="Zoom in">+</button>
        <button type="button" class="done">Done</button>
      </div>`;
    document.body.appendChild(this.rail);
    // loft control on the left: + / arc gauge / −
    this.loftRail = document.createElement('div'); this.loftRail.className = 'aim-loft';
    this.loftRail.innerHTML = `<button type="button" data-l="1" aria-label="Higher launch">+</button><div class="arc" aria-hidden="true"><svg viewBox="0 0 64 40"><path d="M6 34 Q32 -6 58 34" fill="none" stroke="rgba(20,40,75,.25)" stroke-width="5" stroke-linecap="round"/><path class="arcp" d="M6 34 Q32 -6 58 34" fill="none" stroke="#f2c21b" stroke-width="5" stroke-linecap="round"/><circle class="dot" cx="32" cy="14" r="5" fill="#fff6e2" stroke="#14284b" stroke-width="2"/></svg><span class="lv">Normal</span></div><button type="button" data-l="-1" aria-label="Lower launch">−</button>`;
    document.body.appendChild(this.loftRail);
    this.loftRail.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.addEventListener('click', () => { aim.loft = clamp(Math.round((aim.loft + +b.dataset.l! * 0.5) * 2) / 2, -1, 1); this.changed(); }));
    this.label = document.createElement('div'); this.label.className = 'aim-label off'; document.body.appendChild(this.label);
    this.tip = document.createElement('div'); this.tip.className = 'aim-tip off';
    this.tip.innerHTML = '<b>Drag</b> to move the target · drag the <b>blue dot</b> to curve it';
    document.body.appendChild(this.tip);
    this.rail.querySelector('.aim-go')!.addEventListener('click', () => this.open());
    this.rail.querySelector('.done')!.addEventListener('click', () => this.close());
    this.rail.querySelectorAll<HTMLButtonElement>('.zoom').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.z === 'in') this.zoom = clamp(this.zoom * 0.78, 0.35, 1.8);
      else if (b.dataset.z === 'out') this.zoom = clamp(this.zoom * 1.28, 0.35, 1.8);
      else { aim.dir = 0; aim.curve = 0; aim.distanceYds = o.carry().full; this.changed(); }
    }));
    addEventListener('keydown', e => {
      if (!this.enabled || (e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'a' || e.key === 'A') this.active ? this.close() : this.open();
      if (this.active && e.key === 'Escape') this.close();
    });
    const c = o.canvas;
    c.addEventListener('pointerdown', e => this.down(e));
    c.addEventListener('pointermove', e => this.move(e));
    c.addEventListener('pointerup', e => this.up(e));
    c.addEventListener('pointercancel', e => this.up(e));
    c.addEventListener('wheel', e => { if (!this.active) return; e.preventDefault(); this.zoom = clamp(this.zoom * Math.exp(e.deltaY * 0.0015), 0.35, 1.8); }, { passive: false });
    aim.distanceYds = o.carry().full;
  }

  /** the ready state toggles the rail; leaving it closes the aim view */
  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on; this.rail.classList.toggle('off', !on);
    if (!on && this.active) this.close();
  }
  open() { if (!this.enabled) return; this.active = true; this.zoom = 1; document.body.classList.add('aiming'); this.tip.classList.remove('off'); setTimeout(() => this.tip.classList.add('off'), 3800); }
  close() { this.active = false; this.drag = null; this.pts.clear(); document.body.classList.remove('aiming'); this.tip.classList.add('off'); }
  /** club or mode changed: keep the direction, reset distance to the new club's full carry */
  clubChanged() { const c = this.o.carry(); aim.distanceYds = c.full; aim.distanceYds = clamp(aim.distanceYds, c.min, c.max); this.changed(); }
  private changed() { this.o.onChange?.(); }

  dirVec(out = new THREE.Vector3()) { return out.set(Math.sin(aim.dir), 0, -Math.cos(aim.dir)); }
  targetPos(out = new THREE.Vector3()) {
    const b = this.o.ballPos(); this.dirVec(out).multiplyScalar(aim.distanceYds * YD).add(b);
    out.y = this.ground(out.x, out.z); return out;
  }
  private ground(x: number, z: number) { return this.o.range ? this.o.range.heightAt(x, z) : 0; }

  /** the curved shape of the planned shot: quadratic bezier from the ball to the target */
  private shapePoint(t: number, out: THREE.Vector3) {
    const b = this.o.ballPos(), T = this.targetPos(), D = b.distanceTo(T);
    const perp = new THREE.Vector3(-Math.cos(aim.dir), 0, -Math.sin(aim.dir)).negate(); // + = right of the aim line
    const ctrl = b.clone().lerp(T, 0.5).addScaledVector(perp, -aim.curve * D * 0.10);
    out.set(0, 0, 0).addScaledVector(b, (1 - t) * (1 - t)).addScaledVector(ctrl, 2 * t * (1 - t)).addScaledVector(T, t * t);
    out.y = this.ground(out.x, out.z) + 0.06;
    return out;
  }

  /** camera for the aim view: high behind the ball, looking steeply down the aim line */
  cameraWant(pos: THREE.Vector3, look: THREE.Vector3) {
    // framed for the real lens: the ball sits just above the swing stick (64% down the screen) and the
    // landing ring below the top chips (28%). Height is fixed at 0.96·D; solve the set-back and pitch.
    const b = this.o.ballPos(), d = this.dirVec(), D = Math.max(25, aim.distanceYds * YD), z = this.zoom;
    const t = Math.tan(THREE.MathUtils.degToRad(this.o.camera.fov / 2)), H = 0.96 * D * z;
    const yb = 0.28, yr = -0.44; // NDC, + = below centre
    const solve = (B: number) => { const ab = Math.atan2(H, B), ar = Math.atan2(H, B + D); const p = ab - Math.atan(yb * t); return { p, err: Math.tan(ar - p) - yr * t }; };
    let lo = 0, hi = 4 * D;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (solve(mid).err > 0) hi = mid; else lo = mid; }
    const B = (lo + hi) / 2, pitch = Math.max(0.2, solve(B).p);
    pos.copy(b).addScaledVector(d, -B); pos.y = b.y + H;
    look.copy(pos).addScaledVector(d, H / Math.tan(pitch)); look.y = b.y;
  }

  private worldAt(cx: number, cy: number): THREE.Vector3 | null {
    const r = this.o.canvas.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), this.o.camera);
    const o = this.ray.ray.origin, dv = this.ray.ray.direction; if (dv.y > -1e-3) return null;
    let y = 0, p = new THREE.Vector3();
    for (let i = 0; i < 3; i++) { const t = (y - o.y) / dv.y; p = o.clone().addScaledVector(dv, t); y = this.ground(p.x, p.z); }
    return p;
  }
  private screenOf(p: THREE.Vector3) {
    const v = p.clone().project(this.o.camera), r = this.o.canvas.getBoundingClientRect();
    return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height, ok: v.z < 1 };
  }

  private down(e: PointerEvent) {
    if (!this.active) return;
    this.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { this.o.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (this.pts.size === 2) { const [a, b] = [...this.pts.values()]; this.pinch0 = Math.hypot(a.x - b.x, a.y - b.y); this.zoom0 = this.zoom; this.drag = null; return; }
    const h = this.screenOf(this.handle.position);
    this.drag = Math.hypot(h.x - e.clientX, h.y - e.clientY) < 34 ? 'bend' : 'ring';
    this.tip.classList.add('off');
    this.move(e);
    e.preventDefault();
  }
  private move(e: PointerEvent) {
    if (!this.active || !this.pts.has(e.pointerId)) return;
    this.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pts.size >= 2) {
      const [a, b] = [...this.pts.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinch0 > 0) this.zoom = clamp(this.zoom0 * this.pinch0 / Math.max(10, d), 0.35, 1.8);
      return;
    }
    const w = this.worldAt(e.clientX, e.clientY); if (!w) return;
    const b = this.o.ballPos();
    if (this.drag === 'ring') {
      const c = this.o.carry();
      const dx = w.x - b.x, dz = w.z - b.z;
      aim.dir = clamp(Math.atan2(dx, -dz), -0.62, 0.62);
      aim.distanceYds = clamp(Math.hypot(dx, dz) / YD, c.min, c.max);
      this.changed();
    } else if (this.drag === 'bend') {
      const T = this.targetPos(), D = Math.max(1, b.distanceTo(T));
      const right = new THREE.Vector3(Math.cos(aim.dir), 0, Math.sin(aim.dir));
      const off = w.clone().sub(b.clone().lerp(T, 0.5)).dot(right);           // + = to the right of the line
      // the bezier midpoint sits at -curve * D * 0.05 to the side (matches the simulated bow): dragging left bends the ball right
      aim.curve = clamp(-off / (D * 0.05), -1, 1);
      if (Math.abs(aim.curve) < 0.06) aim.curve = 0;
      this.changed();
    }
  }
  private up(e: PointerEvent) { this.pts.delete(e.pointerId); if (this.pts.size < 2) this.pinch0 = 0; if (this.pts.size === 0) this.drag = null; }

  shapeName() {
    const c = aim.curve; if (Math.abs(c) < 0.08) return 'Straight';
    const right = c > 0; // ball bends right
    const draw = this.o.lefty ? right : !right;
    return (Math.abs(c) > 0.65 ? (draw ? 'Hook' : 'Slice') : (draw ? 'Draw' : 'Fade'));
  }

  /** per frame. showGuide: the swing-camera arrow (ready state, not flying) */
  update(dt: number, showGuide: boolean) {
    this.t += dt;
    const b = this.o.ballPos(), d = this.dirVec(), T = this.targetPos(), D = aim.distanceYds * YD;
    const disp = (3 + 0.06 * aim.distanceYds) * YD;  // landing dispersion radius
    // 1. swing-camera guide: dashed arrow from just past the ball, fading out; marker at the landing spot
    const g = showGuide && !this.active;
    this.guide.mesh.visible = g; this.marker.group.visible = g;
    if (g) {
      const pts: THREE.Vector3[] = []; const L = Math.min(D, 46);
      for (let i = 0; i <= 60; i++) { const s = 0.9 + (L - 0.9) * (i / 60); const p = b.clone().addScaledVector(d, s); p.y = this.ground(p.x, p.z) + 0.012; pts.push(p); }
      this.guide.set(pts, 0.06);
      this.guide.mat.uniforms.flow.value = -this.t * 1.4;
      this.marker.group.position.set(T.x, T.y + 0.05, T.z); this.marker.group.scale.setScalar(disp * 0.8);
      this.marker.chevron.visible = false;
    }
    // 2. aim view: straight dashed aim line, cyan shot shape, ring, bend handle, distance label
    const a = this.active;
    this.aimLine.mesh.visible = a; this.pathLine.mesh.visible = a; this.ring.group.visible = a; this.handle.visible = a;
    if (a) {
      const camD = this.o.camera.position.distanceTo(b.clone().lerp(T, 0.5));
      const w = clamp(camD * 0.012, 0.25, 2.2);
      const sp: THREE.Vector3[] = [];
      for (let i = 0; i <= 60; i++) { const p = b.clone().lerp(T, i / 60); p.y = this.ground(p.x, p.z) + 0.04; sp.push(p); }
      this.aimLine.set(sp, w * 0.42);
      const cp: THREE.Vector3[] = []; for (let i = 0; i <= 90; i++) cp.push(this.shapePoint(i / 90, new THREE.Vector3()));
      this.pathLine.set(cp, w * 0.34);
      this.ring.group.position.set(T.x, T.y + 0.06, T.z); this.ring.group.scale.setScalar(disp);
      this.ring.chevron.rotation.y = -aim.dir; this.ring.chevron.children[0].scale.setScalar(clamp(w * 4.2 / disp, 0.3, 1.1));
      this.shapePoint(0.5, this.handle.position); this.handle.position.y += 0.1; this.handle.scale.setScalar(w * 2.1);
      // floating label above the ring
      const s = this.screenOf(T.clone().add(new THREE.Vector3(0, 0, 0)).addScaledVector(d, disp * 1.1));
      this.label.classList.toggle('off', !s.ok);
      this.label.style.transform = `translate(${s.x}px, ${s.y - 10}px) translate(-50%, -100%)`;
      this.label.innerHTML = `${Math.round(aim.distanceYds)} yds · <b>${this.shapeName()}</b>`;
    } else this.label.classList.add('off');
    if (this.loftShown !== aim.loft) {
      this.loftShown = aim.loft;
      const cy = 14 - aim.loft * 9; // peak of the arc rises with loft
      this.loftRail.querySelectorAll('path').forEach(p => p.setAttribute('d', `M6 34 Q32 ${(-6 - aim.loft * 16).toFixed(1)} 58 34`));
      this.loftRail.querySelector('.dot')!.setAttribute('cy', cy.toFixed(1));
      this.loftRail.querySelector('.lv')!.textContent = aim.loft > 0.25 ? (aim.loft > 0.75 ? 'Max high' : 'High') : aim.loft < -0.25 ? (aim.loft < -0.75 ? 'Max low' : 'Low') : 'Normal';
    }
    void D;
  }
}
