// Golf ball flight: gravity, drag and Magnus lift from spin, then bounces and roll that depend on the
// surface and on the spin (wedges check up, backspin can pull the ball back). Metres, seconds, rad/s.
import * as THREE from 'three';
import type { Range, Surface } from '../world/range';

export const BALL = { r: 0.02135, m: 0.04593 };
const RHO = 1.225, AREA = Math.PI * BALL.r * BALL.r, G = 9.81;
const RPM = (2 * Math.PI) / 60;

export interface Launch {
  speed: number;     // m/s
  launch: number;    // vertical launch angle, radians
  azimuth: number;   // horizontal start direction, radians (+ = right of the target line from behind)
  spinRpm: number;   // total spin
  tilt: number;      // spin-axis tilt, radians (+ = curves right)
}

export type BallPhase = 'teed' | 'flight' | 'bounce' | 'roll' | 'stopped';

// e: bounce, mu: friction during an impact, pit: speed the turf soaks up per m/s of landing speed,
// slide: friction while the ball skids along the turf, roll: rolling resistance (× g)
const SURF: Record<Surface, { e: number; mu: number; pit: number; slide: number; roll: number }> = {
  tee: { e: 0.3, mu: 0.3, pit: 0.42, slide: 0.42, roll: 0.2 },
  fairway: { e: 0.3, mu: 0.3, pit: 0.42, slide: 0.42, roll: 0.2 },
  rough: { e: 0.15, mu: 0.35, pit: 0.6, slide: 0.6, roll: 0.45 },
  green: { e: 0.25, mu: 0.32, pit: 0.45, slide: 0.32, roll: 0.065 },
  bunker: { e: 0.03, mu: 0.6, pit: 0.95, slide: 1.2, roll: 1.6 },
};
let K_STEEP = 5;
const smooth01 = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
export const tune = { set steep(v: number) { K_STEEP = v; } };
/** tests only: pretend the whole world is this surface when there is no range */
export const TEST = { surface: 'fairway' as Surface };

const _v = new THREE.Vector3(), _f = new THREE.Vector3(), _n = new THREE.Vector3(), _w = new THREE.Vector3();

export class Ball {
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly spin = new THREE.Vector3();   // angular velocity vector (rad/s)
  /** while rolling: the speed of the ball's surface from its spin (equals the velocity once it rolls cleanly) */
  readonly sv = new THREE.Vector3();
  /** horizontal distance from the first landing to where it stopped (negative = spun back) */
  roll() { if (!this.landing) return 0; const d = new THREE.Vector3(this.pos.x - this.landing.x, 0, this.pos.z - this.landing.z), f = new THREE.Vector3(this.landing.x - this.start.x, 0, this.landing.z - this.start.z).normalize(); return d.dot(f); }
  phase: BallPhase = 'teed';
  t = 0;
  apex = 0;
  landing: THREE.Vector3 | null = null;  // first touchdown
  start = new THREE.Vector3();
  bounces = 0;
  lastSurface: Surface = 'tee';
  /** rolling angle for drawing the ball */
  readonly spinQuat = new THREE.Quaternion();

  constructor(private range: Range | null) {}

  tee(at: THREE.Vector3) {
    this.pos.copy(at); this.vel.set(0, 0, 0); this.spin.set(0, 0, 0);
    this.phase = 'teed'; this.t = 0; this.apex = at.y; this.landing = null; this.bounces = 0; this.start.copy(at); this.sv.set(0, 0, 0);
  }

  hit(L: Launch) {
    const dirH = new THREE.Vector3(Math.sin(L.azimuth), 0, -Math.cos(L.azimuth));
    this.vel.copy(dirH).multiplyScalar(Math.cos(L.launch) * L.speed);
    this.vel.y = Math.sin(L.launch) * L.speed;
    // backspin axis is horizontal, perpendicular to travel; tilt it to curve
    const back = new THREE.Vector3().crossVectors(dirH, new THREE.Vector3(0, 1, 0)).normalize();
    this.spin.copy(back).multiplyScalar(Math.cos(L.tilt)).addScaledVector(new THREE.Vector3(0, -1, 0), Math.sin(L.tilt)).multiplyScalar(L.spinRpm * RPM);
    this.phase = 'flight'; this.t = 0; this.start.copy(this.pos); this.apex = this.pos.y; this.landing = null; this.bounces = 0;
    this.after = { top: 0, side: 0, appliedBack: 0, appliedSide: 0 };
  }

  /** aftertouch from the spin ball: top -1..1 (- = backspin), side -1..1 (+ = bends right). Ramps in. */
  private after = { top: 0, side: 0, appliedBack: 0, appliedSide: 0 };
  setAftertouch(top: number, side: number) { this.after.top = top; this.after.side = side; }
  private applyAftertouch(dt: number) {
    const A = this.after;
    // backspin input adds spin; topspin input only trims backspin in the air (never below 70% of what's there),
    // its real effect comes at landing (see bounce)
    const h0 = _v.set(this.vel.x, 0, this.vel.z); const bAxis = h0.lengthSq() > 1e-6 ? _w.crossVectors(h0.normalize(), new THREE.Vector3(0, 1, 0)).normalize() : null;
    const curBack = bAxis ? this.spin.dot(bAxis) - A.appliedBack : 0;
    const wantBack = A.top < 0 ? -A.top * 3200 * RPM : -A.top * 0.3 * Math.max(0, curBack), wantSide = -A.side * 750 * RPM; // extra rad/s at full input
    const rate = 2200 * RPM * dt;
    const dB = Math.max(-rate, Math.min(rate, wantBack - A.appliedBack)), dS = Math.max(-rate, Math.min(rate, wantSide - A.appliedSide));
    if (!dB && !dS) return;
    const h = _v.set(this.vel.x, 0, this.vel.z); if (h.lengthSq() < 1e-6) return; h.normalize();
    const back = _w.crossVectors(h, new THREE.Vector3(0, 1, 0)).normalize();
    this.spin.addScaledVector(back, dB); this.spin.y += dS;
    A.appliedBack += dB; A.appliedSide += dS;
  }

  ground(x: number, z: number) { return this.range ? this.range.heightAt(x, z) : 0; }
  surface(x: number, z: number): Surface { return this.range ? this.range.surfaceAt(x, z) : TEST.surface; }

  step(dt: number) {
    if (this.phase === 'teed' || this.phase === 'stopped') return;
    // sub-step for stability
    const n = Math.max(1, Math.ceil(dt / 0.004)), h = dt / n;
    for (let i = 0; i < n; i++) this.sub(h);
  }

  private sub(dt: number) {
    this.t += dt;
    const p = this.pos, v = this.vel;
    if (this.phase === 'flight' || this.phase === 'bounce') {
      if (this.phase === 'flight') this.applyAftertouch(dt);
      const speed = v.length();
      const w = this.spin.length();
      const S = speed > 0.1 ? (BALL.r * w) / speed : 0;
      const cd = 0.22 + 0.2 * Math.min(0.4, S);
      const cl = speed > 0.1 ? 0.46 * Math.pow(Math.min(0.5, S), 0.4) : 0;
      _f.set(0, -G * BALL.m, 0);
      _f.addScaledVector(v, -0.5 * RHO * AREA * cd * speed);
      if (w > 1 && speed > 0.5) {
        _n.crossVectors(this.spin, v).normalize();
        _f.addScaledVector(_n, 0.5 * RHO * AREA * cl * speed * speed);
      }
      v.addScaledVector(_f, dt / BALL.m);
      this.spin.multiplyScalar(Math.exp(-dt / 24));
      p.addScaledVector(v, dt);
      this.apex = Math.max(this.apex, p.y);
      const gy = this.ground(p.x, p.z) + BALL.r;
      if (p.y <= gy && v.y < 0) this.bounce(gy);
    } else if (this.phase === 'roll') {
      const s = this.surface(p.x, p.z), F = SURF[s];
      this.lastSurface = s;
      this.range?.normalAt(p.x, p.z, _n) ?? _n.set(0, 1, 0);
      // gravity along the slope
      v.x += (_n.x * G * 0.71) * dt; v.z += (_n.z * G * 0.71) * dt;
      // skidding: while the ball's surface speed (spin) doesn't match its travel, turf friction works on both.
      // Leftover backspin pulls a wedge to a stop and can draw it back.
      const slx = v.x - this.sv.x, slz = v.z - this.sv.z, sl = Math.hypot(slx, slz);
      if (sl > 0.04) {
        const a = Math.min(F.slide * G * dt, sl / 3.5);
        v.x -= a * slx / sl; v.z -= a * slz / sl;
        this.sv.x += 2.5 * a * slx / sl; this.sv.z += 2.5 * a * slz / sl;
      } else {
        const sp = Math.hypot(v.x, v.z);
        const dec = F.roll * G * dt;
        // turf holds a slow ball on a slope (static friction): it only keeps creeping if the slope beats the grass
        const slopeAcc = Math.hypot(_n.x, _n.z) * G * 0.71;
        if (sp <= dec || sp < 0.03) { v.set(0, 0, 0); if (slopeAcc < F.roll * G * 1.15 || sp < 0.01) this.phase = 'stopped'; }
        else { v.x *= (sp - dec) / sp; v.z *= (sp - dec) / sp; }
        this.sv.set(v.x, 0, v.z);
      }
      p.x += v.x * dt; p.z += v.z * dt;
      p.y = this.ground(p.x, p.z) + BALL.r;
      // safety net: no shot ever runs out more than 40% of its carry (stops runaway rolls on slopes)
      if (this.landing && Math.hypot(p.x - this.landing.x, p.z - this.landing.z) > Math.max(6, 0.4 * this.carry())) { v.set(0, 0, 0); this.phase = 'stopped'; }
      // visual spin follows the ball's surface speed
      this.spin.set(-this.sv.z, 0, this.sv.x).multiplyScalar(1 / BALL.r);
    }
    // visual spin
    const w = this.spin.length();
    if (w > 0.01) this.spinQuat.premultiply(new THREE.Quaternion().setFromAxisAngle(_w.copy(this.spin).multiplyScalar(1 / w), w * dt));
  }

  private bounce(gy: number) {
    const p = this.pos, v = this.vel;
    p.y = gy;
    const s = this.surface(p.x, p.z), F = SURF[s];
    this.lastSurface = s;
    if (!this.landing) this.landing = p.clone();
    this.bounces++;
    // impact on a flat-ish surface: normal restitution, tangential grip with the spin
    this.range?.normalAt(p.x, p.z, _n) ?? _n.set(0, 1, 0);
    const vn = v.dot(_n);
    const vt = _v.copy(v).addScaledVector(_n, -vn);
    const tDir = vt.clone(); const vtl = tDir.length(); if (vtl > 1e-4) tDir.multiplyScalar(1 / vtl); else tDir.set(0, 0, -1);
    // spin about the axis that rolls the ball along tDir (positive = topspin)
    const rollAxis = new THREE.Vector3().crossVectors(_n, tDir);
    const wRoll = this.spin.dot(rollAxis);
    // the turf gives under the ball and soaks up speed (steep landings more), then friction grips the spin
    // steep landings dig in and lose more of their forward speed (a wedge bites, a driver skips)
    const steep = Math.abs(vn) / Math.max(1e-3, Math.hypot(vn, vtl));
    const vIn = Math.max(0, vtl - F.pit * Math.abs(vn) * (1 + K_STEEP * Math.max(0, steep - 0.68)));
    // hard, steep landings sink into the turf and pop up less
    const e = F.e * (1 - 0.35 * smooth01((Math.abs(vn) - 6) / 8));
    const Jmax = F.mu * (1 + e) * Math.abs(vn);
    let rw = BALL.r * wRoll;                        // surface speed from spin (+ = topspin)
    // topspin aftertouch: on the first touchdown the ball comes off the turf running (up to ~12% more total)
    if (this.bounces === 1 && this.after.top > 0) rw += this.after.top * 0.45 * vtl;
    const slip = vIn - rw;
    let vt2: number, rw2: number;
    if (3.5 * Jmax >= Math.abs(slip)) { vt2 = (5 * vIn + 2 * rw) / 7; rw2 = vt2; }   // grips: rolls cleanly
    else { const J = Math.sign(slip) * Jmax; vt2 = vIn - J; rw2 = rw + 2.5 * J; }   // still skidding: keeps some spin
    const vn2 = -vn * e * (Math.abs(vn) > 2 ? 1 : 0.5);
    v.copy(tDir).multiplyScalar(vt2).addScaledVector(_n, vn2);
    this.spin.copy(rollAxis).multiplyScalar(rw2 / BALL.r).addScaledVector(_n, this.spin.dot(_n) * 0.5);
    if (vn2 < 0.45) { this.phase = 'roll'; v.addScaledVector(_n, -v.dot(_n)); this.sv.copy(tDir).multiplyScalar(rw2); }
    else this.phase = 'bounce';
  }

  /** run a copy of the flight ahead to find where it first lands (for cameras); returns null if not found */
  predictLanding(maxT = 12): THREE.Vector3 | null {
    if (this.phase !== 'flight') return this.landing;
    const b = new Ball(this.range);
    b.pos.copy(this.pos); b.vel.copy(this.vel); b.spin.copy(this.spin); b.phase = 'flight';
    for (let t = 0; t < maxT; t += 1 / 60) { b.step(1 / 60); if (b.landing) return b.landing; }
    return null;
  }

  carry() { return this.landing ? Math.hypot(this.landing.x - this.start.x, this.landing.z - this.start.z) : Math.hypot(this.pos.x - this.start.x, this.pos.z - this.start.z); }
  total() { return Math.hypot(this.pos.x - this.start.x, this.pos.z - this.start.z); }
  offline() { return this.pos.x - this.start.x; }
}

/** Simulate a launch on flat ground and return carry (m) and apex (m). Used to aim the shot. */
export function simulateCarry(L: Launch) {
  const b = new Ball(null);
  b.tee(new THREE.Vector3(0, BALL.r, 0));
  b.hit(L);
  for (let i = 0; i < 2400 && !b.landing; i++) b.step(1 / 120);
  return { carry: b.carry(), apex: b.apex, time: b.t, side: b.landing ? b.landing.x : 0 };
}

/** Find the ball speed that carries `carry` metres with this launch angle and spin. */
export function speedForCarry(carry: number, launch: number, spinRpm: number) {
  let lo = 3, hi = 95;
  for (let i = 0; i < 26; i++) {
    const mid = (lo + hi) / 2;
    const c = simulateCarry({ speed: mid, launch, azimuth: 0, spinRpm, tilt: 0 }).carry;
    if (c < carry) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
