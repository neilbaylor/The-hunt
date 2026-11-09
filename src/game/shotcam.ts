// Cinematic camera for long shots: (a) swing round to the golfer's face and follow-through,
// (b) crane up and fly after the ball, following it with a gentle dolly-zoom at the apex and a slight tilt
// as it falls, (c) settle on a TV-style view of the landing and roll. Short shots keep the plain chase cam.
// All poses are computed fresh each frame from live positions and blended with smooth easing: no shake, no cuts
// (except a tap-to-skip), no fast whips. Everything tunable is in SHOTCAM.
import * as THREE from 'three';

export const SHOTCAM = {
  minCarryYds: 120,      // only shots predicted to carry at least this far get the cinematic
  hold: 0.18,            // s: stay on the swing cam to see the strike
  face: 0.95,            // s: arc from behind to a ¾ front view of the face / follow-through
  faceAngle: 50,         // deg: ¾ front = this far from straight-in-front towards the target
  faceRadius: 2.35,      // m from the head at the end of the arc (push-in from ~3.6)
  faceDrop: 0.28,        // m: aim this far below the head so the face sits in the upper third (portrait)
  catch: 0.85,           // s: crane up off the golfer and fly after the ball (fast start, smooth catch-up)
  crane: 6,              // m: how high the fly-by arcs over the golfer
  chaseBack: 11,         // m behind the ball while following (close enough that the ball itself reads)
  chaseSide: 2.5,        // m off the line (to the golfer's back side) so the tracer reads as an arc
  chaseUp: 2.5,          // m above the ground ...
  chaseUpK: 0.6,         // ... plus this share of the ball's height: a touch below the ball, so it flies against the sky
  lookAhead: 2.5,        // m: lead the ball along its direction of travel (room for it to fly into)
  frameLift: 6,          // deg: aim this far below the ball so it rides in the upper-middle third of a portrait frame
  apexZoom: 9,           // deg: fov punch-in at the apex (the camera backs off to match: a soft dolly-zoom)
  apexWidth: 7,          // m/s of vertical speed over which the apex zoom fades
  fallTilt: 3,           // deg: camera roll as the ball falls
  landLead: 1.9,         // s before touchdown to start settling on the landing view (and zooming in)
  landZoom: 13,          // deg: the fov narrows this much over the settle, so the ball and green fill the frame at touchdown
  breathe: 1.2,          // deg: a slow fov breathe while following (speed feel)
  closeIn: 0.3,          // share of the chase distance the camera closes while following
  land: 1.4,             // s: settle from the chase to the landing view
  landFwd: 9, landSide: 17, landUp: 5,   // landing view: beside the landing spot (a touch past it), raised; never across the ball's path
};

export interface ShotCamCtx {
  ball: { pos: THREE.Vector3; vel: THREE.Vector3; phase: string };
  head: THREE.Vector3;            // golfer's head, world
  predictLanding: () => THREE.Vector3 | null;
  groundAt: (x: number, z: number) => number;
  blocked: (x: number, z: number) => boolean;   // a spot that would park the camera behind a flag or board
}
export interface ShotCamPose { pos: THREE.Vector3; look: THREE.Vector3; dFov: number; roll: number; dof: number }

/** The variants, picked at random per long shot (weighted, never the same twice running; ?shotcam= forces one):
 *  orbit  — behind → round to his face and follow-through → crane up and chase the ball (the original)
 *  freeze — bullet time at impact: the world stops, the camera orbits the frozen golfer to his face, time resumes,
 *           then it whips off after the ball
 *  cut    — stays behind him through the follow-through watching the ball start, then a hard cut to a broadcast
 *           camera down by the landing area looking back up the range (longer lens), which picks the ball up
 *  low    — a turf-level camera beside the line, looking up as the ball rockets past, then a cut to the broadcast cam */
export type ShotCamVariant = 'orbit' | 'freeze' | 'cut' | 'low';
const WEIGHTS: [ShotCamVariant, number][] = [['orbit', 0.28], ['freeze', 0.3], ['cut', 0.27], ['low', 0.15]];
let lastVariant: ShotCamVariant | null = null;
export function pickVariant(force?: string | null): ShotCamVariant {
  if (force && WEIGHTS.some(w => w[0] === force)) return (lastVariant = force as ShotCamVariant);
  const pool = WEIGHTS.filter(w => w[0] !== lastVariant), tot = pool.reduce((a, w) => a + w[1], 0);
  let r = Math.random() * tot; for (const [v, w] of pool) { if ((r -= w) <= 0) return (lastVariant = v); }
  return (lastVariant = pool[0][0]);
}
export const VARIANT = {
  freeze: { hold: 0.12, orbit: 1.35, resume: 0.3, whip: 0.65, radius: 2.5 },
  cut: { stay: 1.7, tele: 16 },          // tele: fov narrower than the swing cam on the broadcast camera
  low: { dist: 9, side: 2.2, up: 0.3, hold: 1.25 },
};

type Phase = 'face' | 'catch' | 'follow' | 'landing';
const Y = new THREE.Vector3(0, 1, 0);
const smoother = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * t * (t * (t * 6 - 15) + 10); };
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** a long shot? (predicted carry, and not a pitch or flop) */
export function isLongShot(mode: string, carryYds: number) { return mode !== 'pitch' && mode !== 'flop' && carryYds >= SHOTCAM.minCarryYds; }

export class ShotCam {
  active = false;
  phase: Phase = 'face';
  t = 0;
  private t0Phase = 0;
  private startPos = new THREE.Vector3(); private startLook = new THREE.Vector3();
  private faceDir = new THREE.Vector3(); private targetDir = new THREE.Vector3(); private side = 1;
  private from = { pos: new THREE.Vector3(), look: new THREE.Vector3(), dFov: 0, roll: 0 };
  private landPos: THREE.Vector3 | null = null; private landLook = new THREE.Vector3();
  private out: ShotCamPose = { pos: new THREE.Vector3(), look: new THREE.Vector3(), dFov: 0, roll: 0, dof: 0 };
  private faceEnd = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
  private folHold = 0;   // how long we'd been following when the landing settle began (keeps the close-in)

  /** start at impact. faceDir: where the golfer faces at address (towards the ball); side: +1 if the golfer's
   *  back is on +lateral of the target line (lefty), -1 otherwise */
  variant: ShotCamVariant = 'orbit';
  /** sim time scale the variant asks for (0 = frozen: bullet time) */
  timeScale = 1;
  private bc: THREE.Vector3 | null = null;   // the broadcast camera (cut / low)
  private lowPos = new THREE.Vector3();
  start(camPos: THREE.Vector3, camLook: THREE.Vector3, faceDir: THREE.Vector3, targetDir: THREE.Vector3, side: number, variant: ShotCamVariant = 'orbit') {
    this.active = true; this.phase = 'face'; this.t = 0; this.t0Phase = 0; this.landPos = null; this.folHold = 0;
    this.variant = variant; this.timeScale = 1; this.bc = null;
    this.startPos.copy(camPos); this.startLook.copy(camLook);
    this.faceDir.copy(faceDir).setY(0).normalize(); this.targetDir.copy(targetDir).setY(0).normalize(); this.side = side;
  }
  stop() { this.active = false; this.timeScale = 1; this.lowPos.set(0, 0, 0); }
  /** tap: jump straight to the landing view (the caller fast-forwards the ball) */
  skipToLanding(ctx: ShotCamCtx) { this.pickLanding(ctx); this.phase = 'landing'; this.t0Phase = this.t - SHOTCAM.land; }

  update(dt: number, ctx: ShotCamCtx): ShotCamPose {
    this.t += dt;
    const C = SHOTCAM, o = this.out, b = ctx.ball;
    o.dFov = 0; o.roll = 0; o.dof = 0;
    if (this.variant === 'freeze' && (this.phase === 'face' || this.phase === 'catch')) return this.freeze(ctx, o);
    if ((this.variant === 'cut' || this.variant === 'low') && this.phase !== 'landing') return this.broadcast(ctx, o);
    if (this.phase === 'face') {
      this.facePose(ctx, o, smoother((this.t - C.hold) / C.face));
      o.dof = 1;
      if (this.t >= C.hold + C.face) { this.phase = 'catch'; this.t0Phase = this.t; this.faceEnd.pos.copy(o.pos); this.faceEnd.look.copy(o.look); }
      return o;
    }
    if (this.phase === 'catch') {
      const k = Math.min(1, (this.t - this.t0Phase) / C.catch), s = k >= 1 ? 1 : 1 - Math.pow(1 - k, 3) * (1 - 0.0 * k);   // ease-out: leaves the golfer briskly, settles onto the ball
      const f = this.followPose(ctx, new THREE.Vector3(), new THREE.Vector3());
      // the face view keeps watching the golfer (live head) while we leave it
      const fp = this.faceEnd.pos, fl = this.faceEnd.look.clone().lerp(ctx.head.clone().addScaledVector(Y, -C.faceDrop), 1);
      // quadratic Bezier with a raised middle: crane up and over, then down behind the ball
      const mid = fp.clone().lerp(f.pos, 0.35); mid.y = Math.max(fp.y, f.pos.y) + C.crane;
      const u = 1 - s;
      o.pos.copy(fp).multiplyScalar(u * u).addScaledVector(mid, 2 * u * s).addScaledVector(f.pos, s * s);
      // the look point rises off the golfer up the tracer to the ball (keeps the turn slow and readable)
      const lookMid = fl.clone().lerp(b.pos, 0.6); lookMid.y = Math.max(lookMid.y, b.pos.y) + 8;   // swing the eye up to the sky, not down at the turf
      o.look.copy(fl).multiplyScalar(u * u).addScaledVector(lookMid, 2 * u * s).addScaledVector(f.look, s * s);
      o.dFov = f.dFov * s; o.roll = f.roll * s; o.dof = 1 - s;
      if (s >= 1) { this.phase = 'follow'; this.t0Phase = this.t; }
      if (this.nearLanding(ctx)) this.beginLanding(ctx, o);
      return o;
    }
    if (this.phase === 'follow') {
      const f = this.followPose(ctx, o.pos, o.look); o.dFov = f.dFov; o.roll = f.roll;
      if (this.nearLanding(ctx)) this.beginLanding(ctx, o);
      return o;
    }
    // landing: ease from where we were to the landing view, then watch the ball roll
    if (!this.landPos) this.pickLanding(ctx);
    const s = smoother((this.t - this.t0Phase) / C.land);
    const f = b.phase === 'flight' ? this.followPose(ctx, new THREE.Vector3(), new THREE.Vector3()) : null;
    const fromPos = f ? f.pos : this.from.pos, fromLook = f ? f.look : this.from.look;
    // swing out sideways first, then along: a quadratic path that never runs the camera past the ball
    const lat = new THREE.Vector3(-this.targetDir.z, 0, this.targetDir.x);
    const ctrl = fromPos.clone().addScaledVector(lat, this.landPos!.clone().sub(fromPos).dot(lat)); ctrl.y = Math.max(fromPos.y, this.landPos!.y);
    const u = 1 - s;
    o.pos.copy(fromPos).multiplyScalar(u * u).addScaledVector(ctrl, 2 * u * s).addScaledVector(this.landPos!, s * s);
    // keep the ball AND where it's coming down in shot during the hand-off; once it's down, just the ball
    // the ball stays the subject (eye just ahead of it, towards where it comes down); the camera's move brings the landing area in
    const lookNow = (b.phase === 'flight' ? b.pos.clone().lerp(this.landLook, 0.2) : b.pos.clone()).addScaledVector(Y, 0.3);
    o.look.copy(fromLook).lerp(lookNow, smoother(Math.min(1, s * 2)));
    o.dFov = (f ? f.dFov : this.from.dFov) * (1 - s) - C.landZoom * s; o.roll = (f ? f.roll : this.from.roll) * (1 - s);
    if (f) { this.from.pos.copy(f.pos); this.from.look.copy(f.look); this.from.dFov = f.dFov; this.from.roll = f.roll; }
    return o;
  }

  /** A: bullet time. Frozen while the camera orbits to his face, time resumes, then a quick whip to the chase */
  private freeze(ctx: ShotCamCtx, o: ShotCamPose): ShotCamPose {
    const F = VARIANT.freeze, t = this.t;
    if (this.phase === 'face') {
      const k = (t - F.hold) / F.orbit;
      this.timeScale = t < F.hold ? 0.15 : k < 1 ? 0 : Math.min(1, (t - F.hold - F.orbit) / F.resume);
      const s = smoother(k);
      this.facePose(ctx, o, s); o.dof = 1;
      // pull in tighter than the plain orbit: the frozen moment is the show
      const h = ctx.head, d = o.pos.clone().sub(h); d.y = 0; const r = d.length();
      if (r > 0.01) { const want = F.radius + (1 - Math.sin(Math.PI * Math.min(1, s))) * 0.0; d.multiplyScalar((r + (Math.min(r, want) - r) * s) / r); o.pos.set(h.x + d.x, o.pos.y, h.z + d.z); }
      if (t >= F.hold + F.orbit + F.resume) { this.phase = 'catch'; this.t0Phase = t; this.faceEnd.pos.copy(o.pos); this.faceEnd.look.copy(o.look); this.timeScale = 1; }
      return o;
    }
    // whip: a fast ease-out from the face to the chase
    this.timeScale = 1;
    const k = Math.min(1, (t - this.t0Phase) / F.whip), s = 1 - Math.pow(1 - k, 4);
    const f = this.followPose(ctx, new THREE.Vector3(), new THREE.Vector3());
    o.pos.lerpVectors(this.faceEnd.pos, f.pos, s); o.look.lerpVectors(this.faceEnd.look, f.look, Math.min(1, s * 1.3));
    o.dFov = f.dFov * s - 6 * Math.sin(Math.PI * s); o.dof = 1 - s;
    if (k >= 1) { this.phase = 'follow'; this.t0Phase = t; }
    if (this.nearLanding(ctx)) this.beginLanding(ctx, o);
    return o;
  }

  /** B / D: stay behind (or sit low by the line), then a hard cut to a broadcast camera by the landing area */
  private broadcast(ctx: ShotCamCtx, o: ShotCamPose): ShotCamPose {
    const b = ctx.ball, t = this.t;
    const stay = this.variant === 'cut' ? VARIANT.cut.stay : VARIANT.low.hold;
    if (!this.bc && t < stay && b.phase === 'flight') {
      if (this.variant === 'cut') {
        // the swing camera holds; the eye lifts to watch the ball start
        o.pos.copy(this.startPos);
        o.look.copy(this.startLook).lerp(b.pos, smoother(t / 0.9) * 0.85);
      } else {
        // low, beside the line a few yards ahead, looking back up at the strike; it tracks the ball as it rockets over
        if (t <= 1e-3 || this.lowPos.lengthSq() === 0) {
          const lat = new THREE.Vector3(-this.targetDir.z, 0, this.targetDir.x).multiplyScalar(-this.side);
          this.lowPos.copy(this.startPos).setY(0).addScaledVector(this.targetDir, VARIANT.low.dist + 4).addScaledVector(lat, VARIANT.low.side);
          this.lowPos.y = ctx.groundAt(this.lowPos.x, this.lowPos.z) + VARIANT.low.up;
        }
        o.pos.copy(this.lowPos); o.look.copy(b.pos); o.dFov = 10;   // a wider lens, low and close
      }
      return o;
    }
    // the cut: a fixed broadcast camera beyond the landing area, off the line, raised, looking back up the range
    if (!this.bc) {
      const land = ctx.predictLanding() ?? b.pos.clone();
      const lat = new THREE.Vector3(-this.targetDir.z, 0, this.targetDir.x).multiplyScalar(-this.side);
      const c = land.clone().addScaledVector(this.targetDir, 34).addScaledVector(lat, 13);
      c.y = Math.max(land.y, ctx.groundAt(c.x, c.z)) + 7;
      this.bc = c; this.landLook.copy(land);
    }
    o.pos.copy(this.bc);
    o.look.copy(b.pos).lerp(this.landLook, b.phase === 'flight' ? 0.15 : 0).addScaledVector(Y, 0.3);
    // a longer lens than the swing cam, closing in further as the ball comes down
    const g = ctx.groundAt(b.pos.x, b.pos.z), near = b.phase === 'flight' ? smoother(1 - (b.pos.y - g) / 25) : 1;
    o.dFov = -VARIANT.cut.tele - 6 * near;
    return o;
  }

  private facePose(ctx: ShotCamCtx, o: ShotCamPose, s: number) {
    const C = SHOTCAM, h = ctx.head;
    const rel = this.startPos.clone().sub(h); const r0 = Math.hypot(rel.x, rel.z);
    const a0 = Math.atan2(rel.z, rel.x);
    const aFace = Math.atan2(this.faceDir.z, this.faceDir.x);
    const k = C.faceAngle * Math.PI / 180;
    const endDir = this.faceDir.clone().multiplyScalar(Math.cos(k)).addScaledVector(this.targetDir, Math.sin(k));
    // sweep round through the face side: start → face → ¾ front
    const a1 = a0 + wrap(aFace - a0), a2 = a1 + wrap(Math.atan2(endDir.z, endDir.x) - a1);
    const a = a0 + (a2 - a0) * s, r = r0 + (C.faceRadius - r0) * s;
    o.pos.set(h.x + Math.cos(a) * r, this.startPos.y + (h.y + 0.02 - this.startPos.y) * s, h.z + Math.sin(a) * r);
    o.look.copy(this.startLook).lerp(h.clone().addScaledVector(Y, -C.faceDrop), smoother(s * 1.6));
  }

  private followPose(ctx: ShotCamCtx, pos: THREE.Vector3, look: THREE.Vector3) {
    const C = SHOTCAM, b = ctx.ball;
    const dir = new THREE.Vector3(b.vel.x, 0, b.vel.z); if (dir.lengthSq() < 1) dir.copy(this.targetDir); dir.normalize();
    const lat = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(this.side);
    const apex = b.phase === 'flight' ? Math.exp(-((b.vel.y / C.apexWidth) ** 2)) : 0;
    const fall = b.phase === 'flight' && b.vel.y < 0 ? smoother(-b.vel.y / 22) : 0;
    const fol = this.phase === 'follow' ? (this.folHold = this.t - this.t0Phase) : this.phase === 'landing' ? this.folHold : 0;
    const back = C.chaseBack * (1 + 0.55 * apex) * (1 - C.closeIn * smoother(fol / 2.2));
    pos.copy(b.pos).addScaledVector(dir, -back).addScaledVector(lat, C.chaseSide);
    const g = ctx.groundAt(pos.x, pos.z);
    pos.y = g + C.chaseUp + Math.max(0, b.pos.y - g) * C.chaseUpK;
    const v = b.vel.lengthSq() > 1 ? b.vel.clone().normalize() : dir;
    look.copy(b.pos).addScaledVector(v, C.lookAhead);
    look.y -= pos.distanceTo(b.pos) * Math.tan(C.frameLift * Math.PI / 180);
    return { pos, look, dFov: -C.apexZoom * apex + C.breathe * Math.sin(this.t * 2.4) * smoother(fol / 0.6), roll: C.fallTilt * Math.PI / 180 * fall * -this.side };
  }

  private nearLanding(ctx: ShotCamCtx) {
    const b = ctx.ball;
    if (b.phase !== 'flight') return true;
    if (b.vel.y >= 0) return false;
    const hgt = b.pos.y - ctx.groundAt(b.pos.x, b.pos.z);
    return hgt / Math.max(1, -b.vel.y) < SHOTCAM.landLead;
  }
  private beginLanding(ctx: ShotCamCtx, o: ShotCamPose) {
    this.from.pos.copy(o.pos); this.from.look.copy(o.look); this.from.dFov = o.dFov; this.from.roll = o.roll;
    this.pickLanding(ctx); this.phase = 'landing'; this.t0Phase = this.t;
  }
  private pickLanding(ctx: ShotCamCtx) {
    const C = SHOTCAM, b = ctx.ball;
    const land = ctx.predictLanding() ?? b.pos.clone();
    const dir = new THREE.Vector3(b.vel.x, 0, b.vel.z); if (dir.lengthSq() < 1) dir.copy(this.targetDir); dir.normalize();
    const lat = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(-this.side);
    const tries: [number, number][] = [[C.landFwd, C.landSide], [C.landFwd, -C.landSide], [C.landFwd * 1.8, C.landSide * 0.8], [C.landFwd * 1.8, -C.landSide * 0.8], [0, C.landSide * 1.3]];
    let p = land.clone().addScaledVector(dir, tries[0][0]).addScaledVector(lat, tries[0][1]);
    for (const [fw, sd] of tries) { const c = land.clone().addScaledVector(dir, fw).addScaledVector(lat, sd); if (!ctx.blocked(c.x, c.z)) { p = c; break; } }
    p.y = Math.max(land.y, ctx.groundAt(p.x, p.z)) + C.landUp;
    this.landPos = p; this.landLook.copy(land);
  }
}
