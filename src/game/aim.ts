// Aiming. Two pieces:
//  1. An always-on aim guide in the swing camera: a dashed gold arrow on the ground from the ball toward
//     the target, fading with distance, and a small landing marker where it ends.
//  2. An AIM view: tap anywhere on the course (not a button, not the swing stick) or press 'A'. The camera
//     flies up to a steep overhead view down the range. One finger: drag the landing ring (direction +
//     distance, clamped to the club's range) or the round handle on the curved path (draw / fade intent).
//     Two fingers: pinch to zoom, drag to pan. The X at the top or 'Back to swing' at the bottom returns.
//     High / low is set on the strike-point ball, not here (aim.loft stays 0).
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
  constructor(private max: number, color: THREE.Color, opts: { dash?: number; fadeStart?: number; fadeEnd?: number; opacity?: number; edge?: THREE.Color; glow?: boolean } = {}) {
    this.pos = new Float32Array(max * 2 * 3); this.along = new Float32Array(max * 2); this.across = new Float32Array(max * 2);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('along', new THREE.BufferAttribute(this.along, 1));
    this.geo.setAttribute('across', new THREE.BufferAttribute(this.across, 1));
    const idx: number[] = []; for (let i = 0; i < max - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    this.geo.setIndex(idx);
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        color: { value: color.clone() }, edge: { value: (opts.edge ?? NAVY).clone() }, opacity: { value: opts.opacity ?? 1 },
        dash: { value: opts.dash ?? 0 }, glow: { value: opts.glow ? 1 : 0 }, fadeStart: { value: opts.fadeStart ?? 1e6 }, fadeEnd: { value: opts.fadeEnd ?? 2e6 }, flow: { value: 0 },
      },
      vertexShader: 'attribute float along; attribute float across; varying float vA; varying float vX; void main(){ vA = along; vX = across; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform vec3 color; uniform vec3 edge; uniform float opacity, dash, glow, fadeStart, fadeEnd, flow; varying float vA; varying float vX;
        void main(){
          float x = abs(vX - 0.5) * 2.0;                       // 0 centre .. 1 edge
          float body = 1.0 - smoothstep(0.55, 0.7, x);
          float rim = 1.0 - smoothstep(0.88, 1.0, x);
          vec3 c = mix(edge, color, body);
          float a = rim * opacity;
          if (glow > 0.5) {                                    // the preview tracer's look: a solid core with a soft glow
            float core = 1.0 - smoothstep(0.36, 0.46, x);
            c = color; a = (core + (1.0 - core) * pow(1.0 - x, 2.2) * 0.55) * opacity;
          }
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

/** the aim view's bullseye: concentric pin-yellow rings with a thin navy edge (so they read on striped grass from
 *  overhead), a soft glow between them, a centre dot, and a slow ripple running outward. Radius 1 = the outer ring. */
function makeBullseye() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { t: { value: 0 } },
    vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform float t; varying vec2 vP;
      float band(float r, float c, float w, float aa) { return smoothstep(c - w - aa, c - w, r) * (1.0 - smoothstep(c + w, c + w + aa, r)); }
      void main(){
        float r = length(vP), aa = fwidth(r) * 1.2;
        vec3 Y = vec3(1.0, 0.824, 0.247), N = vec3(0.078, 0.157, 0.294);
        float y1 = band(r, 1.0, 0.035, aa), e1 = band(r, 1.0, 0.06, aa);
        float y2 = band(r, 0.64, 0.028, aa), e2 = band(r, 0.64, 0.05, aa);
        float y3 = band(r, 0.30, 0.024, aa), e3 = band(r, 0.30, 0.045, aa);
        float dot = 1.0 - smoothstep(0.075, 0.075 + aa, r), dotE = 1.0 - smoothstep(0.105, 0.105 + aa, r);
        float yel = max(max(y1, y2), max(y3, dot)), edge = max(max(e1, e2), max(e3, dotE));
        float glow = (1.0 - smoothstep(0.0, 1.0, r)) * 0.16 + exp(-pow((r - 1.0) * 9.0, 2.0)) * 0.22;
        float ph = fract(t * 0.45), ripple = exp(-pow((r - ph * 1.25) * 14.0, 2.0)) * (1.0 - ph) * 0.45 * step(r, 1.25);
        vec3 c = mix(N, Y, yel); float a = max(edge * 0.55, yel * 0.95);
        a = max(a, glow + ripple); if (edge < 0.01) c = Y;
        if (a < 0.004) discard;
        gl_FragColor = vec4(c, a);
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  const m = new THREE.Mesh(new THREE.CircleGeometry(1.3, 96), mat); m.rotation.x = -Math.PI / 2; m.renderOrder = 7;
  const g = new THREE.Group(); g.add(m);
  return { group: g, mat };
}

function makeWindArrow() {
  const sh = new THREE.Shape(); sh.moveTo(0, -1); sh.lineTo(0.6, -0.2); sh.lineTo(0.22, -0.2); sh.lineTo(0.22, 0.9); sh.lineTo(-0.22, 0.9); sh.lineTo(-0.22, -0.2); sh.lineTo(-0.6, -0.2); sh.closePath();
  const m = new THREE.Mesh(new THREE.ShapeGeometry(sh), new THREE.MeshBasicMaterial({ color: '#cfeaff', transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide }));
  m.rotation.x = -Math.PI / 2; m.renderOrder = 9;
  const g = new THREE.Group(); g.add(m); g.visible = false; return g;
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
.aim-rail { position: fixed; inset: 0; z-index: 30; pointer-events: none; font-family: 'Fredoka', 'Nunito', system-ui, sans-serif; }
.aim-rail button { position: absolute; pointer-events: auto; -webkit-tap-highlight-color: transparent; border: 0; cursor: pointer; color: #14284b; background: linear-gradient(#fffaf0, #f3e6c8); border-radius: 999px; box-shadow: 0 3px 0 #c9b385, 0 6px 14px rgba(10,20,40,.28), inset 0 1px 0 #fff; transition: transform .12s cubic-bezier(.3,1.6,.5,1), opacity .25s; }
.aim-rail button:active { transform: translateY(2px) scale(.96); }
.aim-rail button:focus-visible { outline: 3px solid #f2c21b; outline-offset: 2px; }
.aim-rail .aim-x { display: none !important; right: max(12px, env(safe-area-inset-right)); top: calc(max(12px, env(safe-area-inset-top)) + 78px); width: 48px; height: 48px; display: grid; place-items: center; }
.aim-rail .aim-x svg { width: 22px; height: 22px; }
.aim-rail .aim-back { left: var(--ab-x, 50%); top: var(--ab-y, auto); bottom: var(--ab-b, calc(max(16px, env(safe-area-inset-bottom)) + 30px)); width: var(--ab-d, 200px); height: var(--ab-d, 200px); transform: translateX(-50%); border-radius: 50%; padding: 0; display: grid; place-items: center; text-align: center; font: 700 22px/1.05 'Fredoka', 'Nunito', system-ui, sans-serif; color: #fff; text-shadow: 0 1px 3px rgba(0,0,0,.6); background: rgba(255,210,63,.32); border: 3px solid rgba(255,230,128,.95); box-sizing: border-box; backdrop-filter: blur(1.5px); box-shadow: 0 0 18px rgba(255,210,63,.45); }   /* same size, shape and place as the swing control it stands in for */
.aim-rail .aim-back:active { transform: translateX(-50%) scale(.96); }
body:not(.aiming) .aim-rail button { opacity: 0; pointer-events: none; }
body.aiming .hud .bc { opacity: .55 !important; pointer-events: none !important; transition: opacity .25s; }   /* the swing control stays, dimmed under the Back to Swing disc; the strike ball and club chip stay on */
/* lie and wind stay on in aim view, in their usual top-right spot */
.aim-label { position: fixed; z-index: 29; left: 0; top: 0; pointer-events: none; transform: translate(-50%, -100%); display: flex; align-items: baseline; gap: 6px; font: 600 13px/1 'Fredoka', 'Nunito', system-ui, sans-serif; color: #fff6e2; background: rgba(20,40,75,.9); border-radius: 999px; padding: 6px 12px 7px; box-shadow: 0 0 0 2px #ffd23f, 0 4px 12px rgba(10,20,40,.35); white-space: nowrap; transition: opacity .2s; }
.aim-label .n { font: 400 24px/0.9 'Anton', 'Barlow Condensed', sans-serif; color: #ffd23f; letter-spacing: .01em; }
.aim-label .u { font: 600 9.5px/1 'Barlow', sans-serif; letter-spacing: .2em; color: #ffd23f; margin-left: -3px; }
.aim-label b { color: #fff6e2; font-weight: 600; }
.aim-label.off { opacity: 0; }
.aim-tip { position: fixed; z-index: 29; left: 50%; bottom: calc(max(16px, env(safe-area-inset-bottom)) + 84px); transform: translateX(-50%); font: 500 13px/1.25 'Nunito', system-ui, sans-serif; color: #fff; background: rgba(20,40,75,.82); padding: 9px 14px; border-radius: 14px; text-align: center; pointer-events: none; max-width: calc(100vw - 32px); box-shadow: 0 4px 14px rgba(0,0,0,.25); transition: opacity .25s; }
.aim-tip b { color: #f2c21b; }
.aim-tip.off { opacity: 0; }
@media (prefers-reduced-motion: reduce) { .aim-rail button, .aim-label, .aim-tip { transition: none; } }
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
  /** a point on the drawn shot shape (the flight preview on the ground), 0..1 from the ball; null when not ready */
  shapeAt?: (t: number, out: THREE.Vector3) => THREE.Vector3 | null;
}

export class AimController {
  active = false;
  zoom = 1;
  private enabled = false;
  private guide = new Ribbon(80, GOLD, { dash: 1.1, fadeStart: 10, fadeEnd: 34, opacity: 0.8 });
  private marker = makeRing();
  private aimLine = new Ribbon(80, CREAM, { opacity: 0.75, dash: 5 });   // the straight start line: quiet cream dashes under the yellow shape
  private pathLine = new Ribbon(96, new THREE.Color('#ffd23f'), { opacity: 0.8, glow: true });   // same pin-yellow glow as the swing-view flight preview
  private ring = makeRing();   // (unused in the aim view now: see bullseye)
  private bull = makeBullseye();
  private handle = makeHandle();
  private windArrow = makeWindArrow();
  private wind = new THREE.Vector3();
  private rail: HTMLDivElement; private label: HTMLDivElement; private tip: HTMLDivElement;
  private tap: { id: number; x: number; y: number; t: number } | null = null;
  private atEdge = false;
  private pan = new THREE.Vector3(); private pan0 = new THREE.Vector3(); private panAt: THREE.Vector3 | null = null;
  private ray = new THREE.Raycaster();
  private drag: 'ring' | 'bend' | null = null;
  private pts = new Map<number, { x: number; y: number }>();
  private pinch0 = 0; private zoom0 = 1;
  private t = 0;
  private bullPop = 0;

  constructor(private o: AimOptions) {
    o.scene.add(this.guide.mesh, this.marker.group, this.aimLine.mesh, this.pathLine.mesh, this.ring.group, this.bull.group, this.handle, this.windArrow);
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    this.rail = document.createElement('div'); this.rail.className = 'aim-rail off';
    this.rail.innerHTML = `
      <button type="button" class="aim-x" aria-label="Close aim, back to the swing"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="#14284b" stroke-width="3" stroke-linecap="round"/></svg></button>
      <button type="button" class="aim-back">Back to<br>Swing</button>`;
    document.body.appendChild(this.rail);
    aim.loft = 0;
    this.label = document.createElement('div'); this.label.className = 'aim-label off'; document.body.appendChild(this.label);
    this.tip = document.createElement('div'); this.tip.className = 'aim-tip off';
    this.tip.innerHTML = '<b>Drag</b> the target · drag the <b>blue dot</b> to curve · <b>pinch</b> to zoom';
    document.body.appendChild(this.tip);
    this.rail.querySelector('.aim-x')!.addEventListener('click', () => this.close());
    this.rail.querySelector('.aim-back')!.addEventListener('click', () => this.close());
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
  /** sit the Back to Swing button exactly where the swing control is (same size and shape) */
  private placeBack() {
    const pad = (document.querySelector('.hud .pad .pad-svg') ?? document.querySelector('.hud .pad')) as HTMLElement | null, b = this.rail.querySelector('.aim-back') as HTMLElement | null;
    if (!pad || !b) return;
    const r = pad.getBoundingClientRect(); if (r.width < 10) return;
    const d = r.width * 0.95;   // exactly the visible ring (r 95 of the 200 viewBox)
    b.style.setProperty('--ab-x', `${r.left + r.width / 2}px`); b.style.setProperty('--ab-y', `${r.top + (r.height - d) / 2}px`); b.style.setProperty('--ab-b', 'auto'); b.style.setProperty('--ab-d', `${d}px`);
  }
  open() { if (!this.enabled || this.active) return; this.placeBack(); this.active = true; this.zoom = 1; this.pan.set(0, 0, 0); document.body.classList.add('aiming'); this.tip.classList.remove('off'); setTimeout(() => this.tip.classList.add('off'), 3800); }
  close() { this.active = false; this.drag = null; this.pts.clear(); document.body.classList.remove('aiming'); this.tip.classList.add('off'); }
  /** club or mode changed: keep the direction, reset distance to the new club's full carry */
  /** club or mode changed: aim at the new full distance (always inside the new reachable band) */
  clubChanged() { const c = this.o.carry(); aim.distanceYds = clamp(c.full, c.min, c.max); this.changed(); }
  private changed() { this.o.onChange?.(); }
  /** the session wind (world m/s): shown as a subtle arrow beside the target ring in the aim view */
  setWind(w: THREE.Vector3) { this.wind.copy(w); }

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
    pos.add(this.pan); look.add(this.pan);   // two-finger pan
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
    if (!this.active) { if (this.enabled && e.isPrimary) this.tap = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() }; return; }
    this.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { this.o.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (this.pts.size === 2) { const [a, b] = [...this.pts.values()]; this.pinch0 = Math.hypot(a.x - b.x, a.y - b.y); this.zoom0 = this.zoom; this.drag = null; this.pan0.copy(this.pan); this.panAt = this.worldAt((a.x + b.x) / 2, (a.y + b.y) / 2); return; }
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
      // pan: keep the world point that was under the fingers' midpoint under it
      if (this.panAt) { const w = this.worldAt((a.x + b.x) / 2, (a.y + b.y) / 2); if (w) { this.pan.x += this.panAt.x - w.x; this.pan.z += this.panAt.z - w.z; const L = Math.max(30, aim.distanceYds * YD); this.pan.x = clamp(this.pan.x, -L, L); this.pan.z = clamp(this.pan.z, -L, L * 0.5); } }
      return;
    }
    const w = this.worldAt(e.clientX, e.clientY); if (!w) return;
    const b = this.o.ballPos();
    if (this.drag === 'ring') {
      const c = this.o.carry();
      const dx = w.x - b.x, dz = w.z - b.z;
      aim.dir = clamp(Math.atan2(dx, -dz), -0.62, 0.62);
      const want = Math.hypot(dx, dz) / YD;
      aim.distanceYds = clamp(want, c.min, c.max);
      // the ring stops at the club's reach: a little bump when it hits the end
      const atEdge = want < c.min || want > c.max;
      if (atEdge && !this.atEdge) { try { navigator.vibrate?.(12); } catch { /* not allowed */ } this.bullPop = 1; }
      this.atEdge = atEdge;
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
  private up(e: PointerEvent) {
    // a quick tap on the course (not a drag) opens the aim view
    if (!this.active && this.tap && this.tap.id === e.pointerId) { const q = this.tap; this.tap = null; if (performance.now() - q.t < 320 && Math.hypot(e.clientX - q.x, e.clientY - q.y) < 12) this.open(); return; }
    this.pts.delete(e.pointerId); if (this.pts.size < 2) this.pinch0 = 0; if (this.pts.size === 0) this.drag = null; }

  shapeName() {
    const c = aim.curve; if (Math.abs(c) < 0.08) return 'Straight';
    const right = c > 0; // ball bends right
    const draw = this.o.lefty ? right : !right;
    return (Math.abs(c) > 0.65 ? (draw ? 'Hook' : 'Slice') : (draw ? 'Draw' : 'Cut'));
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
    this.aimLine.mesh.visible = a; this.pathLine.mesh.visible = false;   // the shot shape is the flight preview laid on the ground (preview.ts)
    this.ring.group.visible = false; this.bull.group.visible = a; this.handle.visible = a;
    if (a) {
      const camD = this.o.camera.position.distanceTo(b.clone().lerp(T, 0.5));
      const w = clamp(camD * 0.012, 0.25, 2.2);
      const sp: THREE.Vector3[] = [];
      for (let i = 0; i <= 60; i++) { const p = b.clone().lerp(T, i / 60); p.y = this.ground(p.x, p.z) + 0.04; sp.push(p); }
      this.aimLine.set(sp, w * 0.22);
      const cp: THREE.Vector3[] = []; for (let i = 0; i <= 90; i++) cp.push(this.shapePoint(i / 90, new THREE.Vector3()));
      this.pathLine.set(cp, w * 0.75);
      this.ring.group.position.set(T.x, T.y + 0.06, T.z); this.ring.group.scale.setScalar(disp);
      // the bullseye: a gentle breathing pulse, and a pop when the ring hits the end of the club's reach
      this.bull.mat.uniforms.t.value = this.t;
      this.bullPop = Math.max(0, this.bullPop - dt * 3);
      this.bull.group.position.set(T.x, T.y + 0.06, T.z); this.bull.group.scale.setScalar(disp * (1 + 0.03 * Math.sin(this.t * 2.4) + 0.12 * this.bullPop));
      this.ring.chevron.rotation.y = -aim.dir; this.ring.chevron.children[0].scale.setScalar(clamp(w * 4.2 / disp, 0.3, 1.1));
      // the bend handle rides the drawn shape (the preview's ground track) where it bows most, else the bezier
      if (!this.o.shapeAt?.(0.6, this.handle.position)) this.shapePoint(0.5, this.handle.position);
      this.handle.position.y = this.ground(this.handle.position.x, this.handle.position.z) + 0.16; this.handle.scale.setScalar(w * 2.1);
      // floating label above the ring
      const s = this.screenOf(T.clone().add(new THREE.Vector3(0, 0, 0)).addScaledVector(d, disp * 1.1));
      this.label.classList.toggle('off', !s.ok);
      this.label.style.transform = `translate(${s.x}px, ${s.y - 10}px) translate(-50%, -100%)`;
      this.label.innerHTML = `<span class="n">${Math.round(aim.distanceYds)}</span><span class="u">YDS</span><b>${this.shapeName()}</b>`;
      // a subtle wind arrow beside the ring, pointing where it blows
      const ws = Math.hypot(this.wind.x, this.wind.z);
      this.windArrow.visible = ws > 0.3;
      if (ws > 0.3) {
        const side = new THREE.Vector3(Math.cos(aim.dir), 0, Math.sin(aim.dir));
        this.windArrow.position.copy(T).addScaledVector(side, disp * 1.9); this.windArrow.position.y = this.ground(this.windArrow.position.x, this.windArrow.position.z) + 0.08;
        this.windArrow.rotation.y = Math.atan2(this.wind.x, this.wind.z);
        this.windArrow.scale.setScalar(w * (2.4 + ws * 0.25));
        (this.windArrow.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>).material.opacity = 0.45 + 0.25 * Math.sin(this.t * 3);
      }
    } else { this.label.classList.add('off'); this.windArrow.visible = false; }
    void D;
  }
}
