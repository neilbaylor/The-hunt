// Cinematic camera for long shots: (a) swing round to the golfer's face and follow-through,
// (b) crane up and fly after the ball, following it with a gentle dolly-zoom at the apex and a slight tilt
// as it falls, (c) settle on a TV-style view of the landing and roll. Short shots keep the plain chase cam.
// All poses are computed fresh each frame from live positions and blended with smooth easing: no shake, no cuts
// (except a tap-to-skip), no fast whips. Everything tunable is in SHOTCAM.
import * as THREE from 'three';

export const SHOTCAM = {
  minCarryYds: 120,      // only shots predicted to carry at least this far get the cinematic
  hold: 0.28,            // s: stay on the swing cam to see the strike
  face: 1.45,            // s: arc from behind to a ¾ front view of the face / follow-through
  faceAngle: 50,         // deg: ¾ front = this far from straight-in-front towards the target
  faceRadius: 2.35,      // m from the head at the end of the arc (push-in from ~3.6)
  faceDrop: 0.28,        // m: aim this far below the head so the face sits in the upper third (portrait)
  catch: 1.6,            // s: crane up off the golfer and fly after the ball
  crane: 9,              // m: how high the fly-by arcs over the golfer
  chaseBack: 17,         // m behind the ball while following
  chaseSide: 4,          // m off the line (to the golfer's back side) so the tracer reads as an arc
  chaseUp: 2.5,          // m above the ground ...
  chaseUpK: 0.6,         // ... plus this share of the ball's height: a touch below the ball, so it flies against the sky
  lookAhead: 8,          // m: look this far ahead of the ball (room for it to fly into)
  apexZoom: 9,           // deg: fov punch-in at the apex (the camera backs off to match: a soft dolly-zoom)
  apexWidth: 7,          // m/s of vertical speed over which the apex zoom fades
  fallTilt: 3,           // deg: camera roll as the ball falls
  landLead: 1.7,         // s before touchdown to start settling on the landing view
  land: 1.4,             // s: settle from the chase to the landing view
  landBack: 26, landSide: 12, landUp: 5.5,  // landing view: past the landing spot, off to the side, raised
};

export interface ShotCamCtx {
  ball: { pos: THREE.Vector3; vel: THREE.Vector3; phase: string };
  head: THREE.Vector3;            // golfer's head, world
  predictLanding: () => THREE.Vector3 | null;
  groundAt: (x: number, z: number) => number;
  blocked: (x: number, z: number) => boolean;   // a spot that would park the camera behind a flag or board
}
export interface ShotCamPose { pos: THREE.Vector3; look: THREE.Vector3; dFov: number; roll: number; dof: number }

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

  /** start at impact. faceDir: where the golfer faces at address (towards the ball); side: +1 if the golfer's
   *  back is on +lateral of the target line (lefty), -1 otherwise */
  start(camPos: THREE.Vector3, camLook: THREE.Vector3, faceDir: THREE.Vector3, targetDir: THREE.Vector3, side: number) {
    this.active = true; this.phase = 'face'; this.t = 0; this.t0Phase = 0; this.landPos = null;
    this.startPos.copy(camPos); this.startLook.copy(camLook);
    this.faceDir.copy(faceDir).setY(0).normalize(); this.targetDir.copy(targetDir).setY(0).normalize(); this.side = side;
  }
  stop() { this.active = false; }
  /** tap: jump straight to the landing view (the caller fast-forwards the ball) */
  skipToLanding(ctx: ShotCamCtx) { this.pickLanding(ctx); this.phase = 'landing'; this.t0Phase = this.t - SHOTCAM.land; }

  update(dt: number, ctx: ShotCamCtx): ShotCamPose {
    this.t += dt;
    const C = SHOTCAM, o = this.out, b = ctx.ball;
    o.dFov = 0; o.roll = 0; o.dof = 0;
    if (this.phase === 'face') {
      this.facePose(ctx, o, smoother((this.t - C.hold) / C.face));
      o.dof = 1;
      if (this.t >= C.hold + C.face) { this.phase = 'catch'; this.t0Phase = this.t; this.faceEnd.pos.copy(o.pos); this.faceEnd.look.copy(o.look); }
      return o;
    }
    if (this.phase === 'catch') {
      const s = smoother((this.t - this.t0Phase) / C.catch);
      const f = this.followPose(ctx, new THREE.Vector3(), new THREE.Vector3());
      // the face view keeps watching the golfer (live head) while we leave it
      const fp = this.faceEnd.pos, fl = this.faceEnd.look.clone().lerp(ctx.head.clone().addScaledVector(Y, -C.faceDrop), 1);
      // quadratic Bezier with a raised middle: crane up and over, then down behind the ball
      const mid = fp.clone().lerp(f.pos, 0.35); mid.y = Math.max(fp.y, f.pos.y) + C.crane;
      const u = 1 - s;
      o.pos.copy(fp).multiplyScalar(u * u).addScaledVector(mid, 2 * u * s).addScaledVector(f.pos, s * s);
      // the look point rises off the golfer up the tracer to the ball (keeps the turn slow and readable)
      const lookMid = fl.clone().lerp(b.pos, 0.5); lookMid.y += 6;
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
    o.pos.copy(fromPos).lerp(this.landPos!, s);
    const lookNow = b.pos.clone().addScaledVector(Y, 0.3);
    o.look.copy(fromLook).lerp(lookNow, s);
    o.dFov = (f ? f.dFov : this.from.dFov) * (1 - s); o.roll = (f ? f.roll : this.from.roll) * (1 - s);
    if (f) { this.from.pos.copy(f.pos); this.from.look.copy(f.look); this.from.dFov = f.dFov; this.from.roll = f.roll; }
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
    const back = C.chaseBack * (1 + 0.55 * apex);
    pos.copy(b.pos).addScaledVector(dir, -back).addScaledVector(lat, C.chaseSide);
    const g = ctx.groundAt(pos.x, pos.z);
    pos.y = g + C.chaseUp + Math.max(0, b.pos.y - g) * C.chaseUpK;
    look.copy(b.pos).addScaledVector(dir, C.lookAhead);
    return { pos, look, dFov: -C.apexZoom * apex, roll: C.fallTilt * Math.PI / 180 * fall * -this.side };
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
    const tries: [number, number][] = [[C.landBack, C.landSide], [C.landBack, -C.landSide], [C.landBack * 0.8, C.landSide * 1.6], [C.landBack * 0.8, -C.landSide * 1.6], [C.landBack * 1.3, C.landSide * 0.5]];
    let p = land.clone().addScaledVector(dir, tries[0][0]).addScaledVector(lat, tries[0][1]);
    for (const [fw, sd] of tries) { const c = land.clone().addScaledVector(dir, fw).addScaledVector(lat, sd); if (!ctx.blocked(c.x, c.z)) { p = c; break; } }
    p.y = Math.max(land.y, ctx.groundAt(p.x, p.z)) + C.landUp;
    this.landPos = p; this.landLook.copy(land);
  }
}
