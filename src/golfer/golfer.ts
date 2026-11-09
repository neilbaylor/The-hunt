// A golfer you can swing. The game drives it with a swing angle (see SwingState); the golfer works out
// the whole body: hips and shoulders turning, the arms reaching the club, the club on its plane,
// knees, feet, and where the eyes look. Left-handers are a mirror image of the same rig.
import * as THREE from 'three';
import { buildBody, BONE, type Body } from './body';
import { Rig, type BodyPose } from './rig';
import { buildClub, buildHands, CLUB_SPECS, type ClubModel } from './club';
import type { GolferProfile } from './profile';

export type ShotMode = 'full' | 'punch' | 'pitch' | 'flop';
export type SwingPhase = 'address' | 'back' | 'down' | 'follow';
export interface SwingState {
  phase: SwingPhase;
  /** hands angle on the swing circle, radians: 0 = address/impact, + = backswing, - = follow-through */
  phi: number;
  /** phi at the top of this swing (for the downswing blend) */
  topPhi: number;
  /** seconds since the golfer started standing over the ball (breathing, waggle) */
  idleT: number;
  /** look at this world point instead (e.g. at the camera on the intro screen) */
  lookAt?: THREE.Vector3;
}

export const BALL_R = 0.02135;
const IN = 0.0254;

interface Keys { hipTurn: number; hipTilt: number; hipSide: number; chestTurn: number; chestTilt: number; chestSide: number; shift: number; drop: number; heel: number; shrug: number }
const A: Keys = { hipTurn: 0, hipTilt: 0.22, hipSide: 0.03, chestTurn: 0, chestTilt: 0.64, chestSide: 0.1, shift: 0, drop: 0, heel: 0, shrug: 0 };
const T: Keys = { hipTurn: -0.8, hipTilt: 0.2, hipSide: -0.02, chestTurn: -1.62, chestTilt: 0.66, chestSide: 0.03, shift: -0.025, drop: 0, heel: 0, shrug: 0.18 };
const I: Keys = { hipTurn: 0.62, hipTilt: 0.18, hipSide: 0.07, chestTurn: 0.3, chestTilt: 0.6, chestSide: 0.25, shift: 0.07, drop: 0.012, heel: 0.3, shrug: -0.05 };
const F: Keys = { hipTurn: 1.45, hipTilt: 0.05, hipSide: 0.04, chestTurn: 1.9, chestTilt: 0.06, chestSide: -0.12, shift: 0.12, drop: -0.03, heel: 1, shrug: -0.15 };
const lerpK = (a: Keys, b: Keys, t: number, o: Keys) => { for (const k in a) (o as any)[k] = (a as any)[k] + ((b as any)[k] - (a as any)[k]) * t; return o; };
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** how each shot type swings: backswing length, finish length, stance and hinge */
export const SHOT_STYLE: Record<ShotMode, { back: number; finish: number; stance: number; hinge: number; open: number; handsFwd: number; tempo: number }> = {
  full:  { back: 1,    finish: 1,    stance: 1,    hinge: 1,    open: 0,    handsFwd: 0,    tempo: 1 },
  punch: { back: 0.72, finish: 0.5,  stance: 0.9,  hinge: 0.7,  open: 0,    handsFwd: 0.05, tempo: 0.85 },
  pitch: { back: 0.58, finish: 0.58, stance: 0.75, hinge: 0.85, open: 0.05, handsFwd: 0.02, tempo: 0.9 },
  flop:  { back: 0.92, finish: 0.9,  stance: 1.05, hinge: 1.1,  open: 0.3,  handsFwd: -0.02, tempo: 1.15 },
};
export const PHI_TOP = 2.45;     // hands angle at the top of a full swing
export const PHI_FINISH = -3.2; // hands angle at a full finish

export class Golfer {
  readonly root = new THREE.Group();   // world placement (mirrored for left-handers)
  readonly char = new THREE.Group();   // character space
  readonly body: Body;
  readonly rig: Rig;
  club!: ClubModel;
  private hands!: { group: THREE.Group; wristLead: THREE.Vector3; wristTrail: THREE.Vector3 };
  private clubIndex = 6;
  mode: ShotMode = 'full';
  readonly k: number;
  private pose: BodyPose;
  // address setup
  private ballC = new THREE.Vector3();     // ball centre (char)
  private clubAt = new THREE.Vector3();    // club origin at address (char)
  private gripAddr = new THREE.Vector3();  // lead grip at address (char)
  private circleC = new THREE.Vector3();
  private e1 = new THREE.Vector3(); private e2 = new THREE.Vector3(); private axis = new THREE.Vector3();
  private rh = 0.6;
  private stanceX = 0;
  private pelvisBase = new THREE.Vector3();
  readonly clubHeadWorld = new THREE.Vector3();
  readonly lefty: boolean;
  private smile = 0;
  /** ease the face toward a smile (1) or neutral (0) */
  smileToward(target: number, dt: number) { this.smile += (target - this.smile) * (1 - Math.exp(-dt * 5)); this.body.setSmile(this.smile); }

  constructor(readonly profile: GolferProfile) {
    this.k = profile.heightM / 1.905;
    this.lefty = profile.handed === 'left';
    this.body = buildBody(profile);
    this.rig = new Rig(this.body);
    this.char.add(this.body.root);
    this.char.rotation.y = Math.PI / 2;         // char +Z (facing) → world +X; char +X (target) → world -Z
    this.root.add(this.char);
    if (this.lefty) this.root.scale.x = -1;     // mirror: stands on the other side, same target line
    const v = () => new THREE.Vector3();
    this.pose = { pelvis: v(), hipTurn: 0, hipTilt: 0, hipSide: 0, chestTurn: 0, chestTilt: 0, chestSide: 0, look: v(), wristL: v(), wristR: v(), poleL: v(), poleR: v(), ankleL: v(), ankleR: v(), toeL: v(), toeR: v(), kneePoleL: v(), kneePoleR: v(), shrugL: 0, shrugR: 0 };
    this.setClub(6, 'full');
  }

  get clubSpec() { return CLUB_SPECS[this.clubIndex]; }
  /** Where the ball sits (world). Tee height for the driver. */
  ballWorld(out = new THREE.Vector3()) { return this.char.localToWorld(out.copy(this.ballC)); }

  setClub(index: number, mode: ShotMode) {
    this.clubIndex = index; this.mode = mode;
    const spec = CLUB_SPECS[index];
    if (this.club) { this.char.remove(this.club.group); this.club.group.traverse(o => (o as THREE.Mesh).geometry?.dispose?.()); }
    const extra = Math.round((this.profile.heightM - 1.78) / 0.05) * 0.5 * IN; // fitted: +1" for 6'3"
    this.club = buildClub(spec, extra, this.body.materials.glove, this.body.materials.skin);
    this.char.add(this.club.group);
    this.setupAddress();
  }

  private setupAddress() {
    const k = this.k, spec = this.club.spec, st = SHOT_STYLE[this.mode];
    const teed = spec.kind === 'driver';
    // ball and club head
    this.ballC.set(0, teed ? this.club.sweetToGround + 0.012 : BALL_R, 0);
    this.clubAt.set(-BALL_R, this.club.sweetToGround, 0);
    this.gripAddr.copy(this.clubAt).add(this.club.gripLead);
    // stance: wider for long clubs, ball forward for the driver
    const long = (this.club.length - 0.88) / 0.3;
    this.stanceX = teed ? -0.1 * k : -0.035 * k * long;
    // solve how far the golfer stands from the ball so the lead arm hangs naturally
    const pos = this.pose;
    const armLen = this.rig.len.upper + this.rig.len.fore;
    let lo = -1.2, hi = -0.2;
    for (let it = 0; it < 22; it++) {
      const z = (lo + hi) / 2;
      this.pelvisBase.set(this.stanceX + st.handsFwd * 0, 0.925 * k - st.stance * 0.01, z);
      this.addressKeys(pos);
      this.rig.apply(pos);
      const sh = this.rig.P[BONE.upperL];
      const d = sh.distanceTo(this.gripAddr) - 0.07;
      if (d > armLen * 0.97) lo = z; else hi = z;
    }
    // swing circle: plane through the shaft line and the target line
    this.e1.copy(this.club.shaftDir);
    this.e2.set(-1, 0, 0).addScaledVector(this.e1, this.e1.x).normalize();
    this.rh = 0.6 * k;
    this.circleC.copy(this.gripAddr).addScaledVector(this.e1, this.rh);
    this.axis.crossVectors(this.e1.clone().negate(), this.e2).normalize();
    // hands: build once per club, pointing at the arms at address
    if (this.hands) { this.club.group.remove(this.hands.group); }
    const shL = this.rig.P[BONE.upperL].clone(), shR = this.rig.P[BONE.upperR].clone();
    const towardL = shL.sub(this.gripAddr).normalize();
    const towardR = shR.sub(this.clubAt.clone().add(this.club.gripTrail)).normalize();
    this.hands = buildHands(this.club, towardL, towardR, this.body.materials.glove, this.body.materials.skin);
    this.club.group.add(this.hands.group);
    this.update({ phase: 'address', phi: 0, topPhi: PHI_TOP, idleT: 0 });
  }

  private addressKeys(p: BodyPose) {
    const k = this.k, st = SHOT_STYLE[this.mode];
    p.hipTurn = A.hipTurn + st.open; p.hipTilt = A.hipTilt; p.hipSide = A.hipSide;
    p.chestTurn = A.chestTurn + st.open * 0.5; p.chestTilt = A.chestTilt; p.chestSide = A.chestSide;
    p.pelvis.copy(this.pelvisBase);
    p.shrugL = p.shrugR = 0;
    this.feet(p, 0, 0);
    p.wristL.copy(this.gripAddr).add(new THREE.Vector3(0.02, 0.06, -0.05));
    p.wristR.copy(this.gripAddr).add(new THREE.Vector3(-0.02, 0.0, -0.06));
    p.poleL.set(0.5, -0.5, this.pelvisBase.z); p.poleR.set(-0.5, -0.5, this.pelvisBase.z);
    p.look.copy(this.ballC);
    void k;
  }

  private feet(p: BodyPose, heel: number, shift: number) {
    const k = this.k, st = SHOT_STYLE[this.mode];
    const long = (this.club.length - 0.88) / 0.3;
    const half = (0.16 + 0.1 * long) * k * st.stance;
    const fz = this.pelvisBase.z + 0.1 * k;
    const flareL = 0.38 + st.open, flareR = -0.12;
    const openBack = st.open * 0.12; // open stance: lead foot pulled back from the line
    p.ankleL.set(this.stanceX + half, 0.09 * k, fz - openBack);
    p.ankleR.set(this.stanceX - half, 0.09 * k, fz);
    p.toeL.copy(p.ankleL).add(new THREE.Vector3(Math.sin(flareL), -0.068 * k / 0.17, Math.cos(flareL)).multiplyScalar(0.17 * k));
    p.toeR.copy(p.ankleR).add(new THREE.Vector3(Math.sin(flareR), -0.068 * k / 0.17, Math.cos(flareR)).multiplyScalar(0.17 * k));
    // trail heel comes up and the trail knee kicks in toward the target in the follow-through
    if (heel > 0) {
      const toe = p.toeR.clone();
      const v = p.ankleR.clone().sub(toe);
      v.applyAxisAngle(new THREE.Vector3(Math.cos(flareR), 0, -Math.sin(flareR)), -1.0 * heel);
      p.ankleR.copy(toe).add(v);
      p.ankleR.x += 0.05 * heel;
      p.toeR.y += 0.0;
    }
    p.kneePoleL.set(p.ankleL.x + 0.15 + shift, 0.5, fz + 1.0);
    p.kneePoleR.set(p.ankleR.x + 0.25 + 1.2 * heel, 0.5, fz + 1.0);
  }

  /** Pose the golfer for a swing state. Returns the club-head position (world). */
  update(s: SwingState) {
    const st = SHOT_STYLE[this.mode], p = this.pose, k = this.k;
    const key: Keys = { ...A };
    const topB = Math.min(1, s.topPhi / PHI_TOP);
    const atTop = (b: number, o: Keys) => {
      lerpK(A, T, 1, o);
      for (const n in o) (o as any)[n] = (A as any)[n] + ((T as any)[n] - (A as any)[n]) * b;
      return o;
    };
    const finishK = (): Keys => { const o = { ...F }; for (const n in o) (o as any)[n] = (I as any)[n] + ((F as any)[n] - (I as any)[n]) * st.finish; return o; };
    let phi = s.phi, hinge = 0, beta = 0;
    const hingeTop = 2.05 * st.hinge;
    if (s.phase === 'address') {
      Object.assign(key, A);
      phi = 0;
    } else if (s.phase === 'back') {
      const b = Math.max(0, phi / PHI_TOP);
      const ease = (e: number) => smooth(0, 1, e);
      Object.assign(key, atTop(1, { ...A }));
      for (const n of Object.keys(A) as (keyof Keys)[]) {
        const t = n === 'hipTurn' ? Math.pow(ease(b), 1.3) : ease(b);
        key[n] = A[n] + (T[n] - A[n]) * t;
      }
      hinge = hingeTop * smooth(0.12, 0.85, phi / (PHI_TOP * Math.max(0.5, st.back)));
      beta = -0.32 * smooth(0, PHI_TOP, phi);
    } else if (s.phase === 'down') {
      const top = atTop(topB, { ...A });
      const dd = 1 - Math.max(0, phi) / Math.max(0.01, s.topPhi);
      for (const n of Object.keys(A) as (keyof Keys)[]) {
        const t = n === 'hipTurn' || n === 'shift' ? smooth(0, 0.65, dd) : n === 'chestTurn' ? smooth(0.15, 1, dd) : smooth(0, 1, dd);
        key[n] = top[n] + (I[n] - top[n]) * t;
      }
      const hTop = hingeTop * smooth(0.12, 0.85, s.topPhi / (PHI_TOP * Math.max(0.5, st.back)));
      hinge = hTop * smooth(0.0, 0.62, Math.max(0, phi) / Math.max(0.01, s.topPhi) * 1.0); // lag, released late
      beta = -0.32 * smooth(0, PHI_TOP, Math.max(0, phi));
    } else {
      const fin = finishK();
      const f = Math.min(1, -phi / Math.abs(PHI_FINISH));
      const e = 1 - Math.pow(1 - f, 2);
      for (const n of Object.keys(A) as (keyof Keys)[]) key[n] = I[n] + (fin[n] - I[n]) * e;
      hinge = -2.1 * st.hinge * smooth(0.05, 0.75, f);
      beta = 0.55 * smooth(0.1, 1, f);
    }
    // breathing and a little life at address
    const breathe = s.phase === 'address' ? Math.sin(s.idleT * 1.6) * 0.006 : 0;

    p.hipTurn = key.hipTurn + st.open; p.hipTilt = key.hipTilt; p.hipSide = key.hipSide;
    p.chestTurn = key.chestTurn + st.open * 0.5; p.chestTilt = key.chestTilt + breathe; p.chestSide = key.chestSide;
    p.pelvis.copy(this.pelvisBase); p.pelvis.x += key.shift * k; p.pelvis.y -= key.drop * k;
    p.shrugL = key.shrug; p.shrugR = -key.shrug * 0.5;
    this.feet(p, key.heel, key.shift);

    // hands on the circle, carried round the body by beta; club rotated in the plane by phi + hinge
    const hands = this.circleC.clone()
      .addScaledVector(this.e1, -this.rh * Math.cos(phi))
      .addScaledVector(this.e2, this.rh * Math.sin(phi));
    const pivot = this.pelvisBase.clone();
    hands.sub(pivot).applyAxisAngle(new THREE.Vector3(0, 1, 0), beta).add(pivot);
    const psi = phi + hinge;
    const qc = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), beta).multiply(new THREE.Quaternion().setFromAxisAngle(this.axis, psi));
    const g = this.club.group;
    g.quaternion.copy(qc);
    g.position.copy(hands).sub(this.club.gripLead.clone().applyQuaternion(qc));
    // arms: lead wrist first; if it can't reach, move the club with the hand
    const wl = this.hands.wristLead.clone().applyQuaternion(qc).add(g.position);
    const wr = this.hands.wristTrail.clone().applyQuaternion(qc).add(g.position);
    p.wristL.copy(wl); p.wristR.copy(wr);
    const down = new THREE.Vector3(0, -1, 0);
    p.poleL.copy(this.pelvisBase).add(new THREE.Vector3(0.25, -0.6, 0.15)).addScaledVector(down, 0.2);
    p.poleR.copy(this.pelvisBase).add(new THREE.Vector3(-0.35, -0.5, 0.05));
    if (s.phase === 'follow') p.poleR.set(this.pelvisBase.x + 0.6, -0.4, this.pelvisBase.z + 0.6);
    // eyes: on the ball until well after impact, then down the target line
    let watch = s.phase === 'follow' ? smooth(0.25, 0.75, -phi / Math.abs(PHI_FINISH)) : 0;
    // pre-shot routine: every few seconds over the ball, a look down the range at the target
    if (s.phase === 'address') { const c = (s.idleT + 1.5) % 6.5; watch = Math.max(watch, 0.8 * smooth(0, 0.45, c) * (1 - smooth(1.5, 2.0, c))); }
    p.look.copy(this.ballC).lerp(new THREE.Vector3(60, 6, -4), watch);
    if (s.lookAt) p.look.copy(this.char.worldToLocal(s.lookAt.clone()));
    this.rig.apply(p);
    for (let pass = 0; pass < 2; pass++) {
      const miss = this.rig.wristPos.L.clone().sub(p.wristL);
      if (miss.lengthSq() < 1e-7) break;
      g.position.add(miss);
      p.wristL.add(miss); p.wristR.add(miss);
      this.rig.apply(p);
    }
    this.char.updateMatrixWorld(true);
    return this.club.group.localToWorld(this.clubHeadWorld.set(0, 0, 0));
  }
}
