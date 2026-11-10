// Poses a body: spine rotations, two-bone IK for arms and legs, and a head that looks at a point.
// Works in character space (body faces +Z, left = +X). Bones have identity bind orientation, so each
// bone's rig-space rotation maps its bind direction onto its posed direction.
import * as THREE from 'three';
import { BONE, BONE_COUNT, PARENT, type Body } from './body';

export interface BodyPose {
  pelvis: THREE.Vector3;           // pelvis joint position
  hipTurn: number; hipTilt: number; hipSide: number;
  chestTurn: number; chestTilt: number; chestSide: number;
  look: THREE.Vector3;             // point the eyes look at
  wristL: THREE.Vector3; wristR: THREE.Vector3;
  poleL: THREE.Vector3; poleR: THREE.Vector3;     // where each elbow points (a world point)
  ankleL: THREE.Vector3; ankleR: THREE.Vector3;
  toeL: THREE.Vector3; toeR: THREE.Vector3;
  kneePoleL: THREE.Vector3; kneePoleR: THREE.Vector3;
  /** optional: the direction the top of each foot faces (default up); needed when a foot stands on its toe */
  footUpL?: THREE.Vector3; footUpR?: THREE.Vector3;
  shrugL: number; shrugR: number;  // clavicle forward/back (protraction) in radians
  /** optional: the shoulder joint slid from its place (char space, a few cm): the shoulder blade reaching for the club */
  shoulderL?: THREE.Vector3; shoulderR?: THREE.Vector3;
}

const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();

function basis(dir: THREE.Vector3, hint: THREE.Vector3, out: THREE.Matrix4) {
  const y = _a.copy(dir).normalize();
  const z = _b.copy(hint).addScaledVector(y, -hint.dot(y));
  if (z.lengthSq() < 1e-8) z.copy(Math.abs(y.z) < 0.9 ? Z : X).addScaledVector(y, -(Math.abs(y.z) < 0.9 ? y.z : y.x));
  z.normalize();
  const x = _c.crossVectors(y, z);
  return out.makeBasis(x, y, z);
}
/** rotation taking (bindDir, bindHint) to (dir, hint) */
function align(bindDir: THREE.Vector3, bindHint: THREE.Vector3, dir: THREE.Vector3, hint: THREE.Vector3, out: THREE.Quaternion) {
  basis(dir, hint, _m1);
  basis(bindDir, bindHint, _m2);
  _m2.transpose();
  _m1.multiply(_m2);
  return out.setFromRotationMatrix(_m1);
}

export class Rig {
  readonly Q = Array.from({ length: BONE_COUNT }, () => new THREE.Quaternion());
  readonly P = Array.from({ length: BONE_COUNT }, () => new THREE.Vector3());
  private readonly off: THREE.Vector3[];
  private readonly bindDir: THREE.Vector3[];
  readonly wristPos = { L: new THREE.Vector3(), R: new THREE.Vector3() };
  readonly reach = { L: 0, R: 0 };
  readonly len: { upper: number; fore: number; thigh: number; shin: number };
  private readonly eyeOff: THREE.Vector3;

  constructor(readonly body: Body) {
    const { joint, tail } = body.skel;
    this.off = joint.map((j, i) => (PARENT[i] < 0 ? j.clone() : j.clone().sub(joint[PARENT[i]])));
    this.bindDir = joint.map((j, i) => tail[i].clone().sub(j).normalize());
    this.len = {
      upper: joint[BONE.upperL].distanceTo(joint[BONE.foreL]),
      fore: joint[BONE.foreL].distanceTo(tail[BONE.foreL]),
      thigh: joint[BONE.thighL].distanceTo(joint[BONE.shinL]),
      shin: joint[BONE.shinL].distanceTo(tail[BONE.shinL]),
    };
    this.eyeOff = body.skel.eye.clone().sub(joint[BONE.head]);
  }

  private fk(i: number) {
    const par = PARENT[i];
    if (par >= 0) this.P[i].copy(this.off[i]).applyQuaternion(this.Q[par]).add(this.P[par]);
  }

  /** Two-bone IK. Returns the clamped end position. */
  private ik(root: THREE.Vector3, target: THREE.Vector3, a: number, b: number, pole: THREE.Vector3, elbowOut: THREE.Vector3, endOut: THREE.Vector3) {
    const d = _d.subVectors(target, root);
    let dist = d.length();
    const maxR = (a + b) * 0.9995, minR = Math.abs(a - b) + 1e-4;
    dist = Math.min(maxR, Math.max(minR, dist));
    d.normalize();
    endOut.copy(root).addScaledVector(d, dist);
    const x = (a * a - b * b + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(0, a * a - x * x));
    const pv = _a.subVectors(pole, root); pv.addScaledVector(d, -pv.dot(d));
    if (pv.lengthSq() < 1e-8) pv.set(0, -1, 0).addScaledVector(d, d.y);
    pv.normalize();
    elbowOut.copy(root).addScaledVector(d, x).addScaledVector(pv, h);
  }

  apply(p: BodyPose) {
    const { Q, P } = this;
    Q[BONE.root].identity(); P[BONE.root].set(0, 0, 0);
    // pelvis: tilt forward, then turn about the vertical
    const qPel = Q[BONE.pelvis].setFromAxisAngle(Y, p.hipTurn).multiply(_q.setFromAxisAngle(Z, p.hipSide)).multiply(_q.setFromAxisAngle(X, p.hipTilt));
    P[BONE.pelvis].copy(p.pelvis);
    // chest: turn about the spine, tilt the spine toward the ball, bend sideways
    const qChest = Q[BONE.chest].setFromAxisAngle(Z, p.chestSide).multiply(_q.setFromAxisAngle(X, p.chestTilt)).multiply(_q.setFromAxisAngle(Y, p.chestTurn));
    Q[BONE.spine1].copy(qPel).slerp(qChest, 0.45);
    this.fk(BONE.spine1); this.fk(BONE.chest);
    // clavicles follow the chest with a little protraction
    Q[BONE.clavL].copy(qChest).multiply(_q.setFromAxisAngle(Y, -p.shrugL));
    Q[BONE.clavR].copy(qChest).multiply(_q.setFromAxisAngle(Y, p.shrugR));
    this.fk(BONE.clavL); this.fk(BONE.clavR); this.fk(BONE.upperL); this.fk(BONE.upperR);
    if (p.shoulderL) P[BONE.upperL].add(p.shoulderL);
    if (p.shoulderR) P[BONE.upperR].add(p.shoulderR);
    // neck + head: look at a point, keep "up" close to the chest's up
    this.fk(BONE.neck);
    const chestUp = _b.set(0, 1, 0).applyQuaternion(qChest).clone();
    const headApprox = _c.copy(this.off[BONE.head]).applyQuaternion(qChest).add(P[BONE.neck]).clone();
    const eye = this.eyeOff.clone().applyQuaternion(qChest).add(headApprox);
    const gaze = p.look.clone().sub(eye).normalize();
    // limit how far the head can twist relative to the chest
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(qChest);
    const ang = fwd.angleTo(gaze);
    if (ang > 1.45) gaze.lerp(fwd, (ang - 1.45) / ang).normalize();
    const up = chestUp.addScaledVector(gaze, -chestUp.dot(gaze)).normalize();
    basis(up, gaze, _m1); Q[BONE.head].setFromRotationMatrix(_m1);
    Q[BONE.neck].copy(qChest).slerp(Q[BONE.head], 0.5);
    this.fk(BONE.head);

    // arms
    const elbow = new THREE.Vector3(), end = new THREE.Vector3();
    for (const side of ['L', 'R'] as const) {
      const up = side === 'L' ? BONE.upperL : BONE.upperR, fo = side === 'L' ? BONE.foreL : BONE.foreR;
      const target = side === 'L' ? p.wristL : p.wristR, pole = side === 'L' ? p.poleL : p.poleR;
      const sh = P[up];
      this.ik(sh, target, this.len.upper, this.len.fore, pole, elbow, end);
      const uDir = _d.subVectors(elbow, sh).clone();
      const fDir = new THREE.Vector3().subVectors(end, elbow);
      // the inside of the elbow faces the forearm; when straight, fall back to the chest's forward
      const front = fDir.clone().addScaledVector(uDir.clone().normalize(), -fDir.dot(uDir) / uDir.length());
      const chestF = new THREE.Vector3(0, 0, 1).applyQuaternion(qChest);
      if (front.length() < 0.02) front.copy(chestF); else front.normalize().lerp(chestF, 0.15);
      align(this.bindDir[up], Z, uDir, front, Q[up]);
      align(this.bindDir[fo], Z, fDir, front, Q[fo]);
      this.fk(fo);
      this.wristPos[side].copy(end);
      this.reach[side] = target.distanceTo(end);
    }

    // legs
    this.fk(BONE.thighL); this.fk(BONE.thighR);
    for (const side of ['L', 'R'] as const) {
      const th = side === 'L' ? BONE.thighL : BONE.thighR, sn = side === 'L' ? BONE.shinL : BONE.shinR, ft = side === 'L' ? BONE.footL : BONE.footR;
      const ankle = side === 'L' ? p.ankleL : p.ankleR, toe = side === 'L' ? p.toeL : p.toeR, pole = side === 'L' ? p.kneePoleL : p.kneePoleR;
      this.ik(P[th], ankle, this.len.thigh, this.len.shin, pole, elbow, end);
      const tDir = _d.subVectors(elbow, P[th]).clone(), sDir = new THREE.Vector3().subVectors(end, elbow);
      const knee = new THREE.Vector3().subVectors(pole, elbow); knee.y = 0; if (knee.lengthSq() < 1e-6) knee.set(0, 0, 1); knee.normalize();
      align(this.bindDir[th], Z, tDir, knee, Q[th]);
      align(this.bindDir[sn], Z, sDir, knee, Q[sn]);
      this.fk(sn); this.fk(ft);
      const up = (side === 'L' ? p.footUpL : p.footUpR) ?? Y;
      align(this.bindDir[ft], Y, _a.subVectors(toe, P[ft]).clone(), up, Q[ft]);
    }

    // write bone locals
    const bones = this.body.bones;
    for (let i = 0; i < BONE_COUNT; i++) {
      const par = PARENT[i];
      if (par < 0) bones[i].quaternion.copy(Q[i]);
      else bones[i].quaternion.copy(_q2.copy(Q[par]).invert().multiply(Q[i]));
    }
    bones[BONE.pelvis].position.copy(p.pelvis);
    for (const [bi, o] of [[BONE.upperL, p.shoulderL], [BONE.upperR, p.shoulderR]] as const) {
      bones[bi].position.copy(this.off[bi]);
      if (o) bones[bi].position.add(_a.copy(o).applyQuaternion(_q2.copy(Q[PARENT[bi]]).invert()));
    }
  }

  /** world-ish (character space) position of the head joint and the eyes after apply() */
  eyePosition(out: THREE.Vector3) { return out.copy(this.eyeOff).applyQuaternion(this.Q[BONE.head]).add(this.P[BONE.head]); }
}
