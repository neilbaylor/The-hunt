// A golfer you can swing. The game drives it with a swing angle (see SwingState); the golfer works out
// the whole body: hips and shoulders turning, the arms reaching the club, the club on its plane,
// knees, feet, and where the eyes look. Left-handers are a mirror image of the same rig.
import * as THREE from 'three';
import { buildBody, BONE, type Body } from './body';
import { Rig, type BodyPose } from './rig';
import { buildClub, buildHands, CLUB_SPECS, clubLengthT, attackAngleDeg, type ClubModel } from './club';
import type { GolferProfile } from './profile';
import { buildHumanBody, type HumanData, type HumanExtras } from './human';
import { sampleSwing, pinWeights, clipChest, buildClubTrack, clubAt, keyedMBWeight, rowAt, num, vec, EV } from './mocap';

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
  /** intro walk-in, with phase 'address': 0 = standing easy a step back from the ball, facing out, leaning on the club;
   *  1 = the exact address pose. Scrubbable (INTRO_SECONDS at natural speed). Leave undefined when not in the intro,
   *  or call golfer.playIntroToAddress() and let the golfer run it on its own clock. */
  intro?: number;
}
/** natural length of the intro walk-in (turn, two steps, settle over the ball), seconds */
export const INTRO_SECONDS = 1.8;

export const BALL_R = 0.02135;
const IN = 0.0254;
const GRIP_R = 0.0115;
// finger flexion on a grip (radians, MCP/PIP/DIP; index, middle, ring, pinky; thumb unused), traced with MediaPipe
// Hand Landmarker from a tour-style overlap grip photo: the index least curled (trigger finger), middle/ring peaking at PIP
const GRIP_CURL = [[0, 0, 0], [0.38, 1.1, 0.95], [0.61, 1.31, 1.06], [1.15, 1.41, 1.06], [1.15, 0.99, 1.38]].map(r => r.map(v => v * 0.92)); // grip radius under the hands (it tapers 9.8 → 12.8 mm in club.ts)

// Body keyframes. Turns and forward bend traced from tour swing sequences (MediaPipe pose landmarks, three
// down-the-line sequences, outliers dropped); side bend and pelvis shift, which a down-the-line camera can't
// see, from published 3D tour averages. Angles in radians as the rig reads them: chest = Rz(side)·Rx(tilt)·Ry(turn),
// pelvis = Ry(turn)·Rz(side)·Rx(tilt); + turn opens toward the target, + side tilts the spine away from it.
// hinge: wrist cock as a fraction of a full set (− = re-hinged in the follow-through); beta: hands carried round
// the body (radians about the vertical); pro: trail shoulder reaching toward the ball; reach: the hands' swing radius
// as a multiple of the address one (a full top is a wide, high arc).
interface Keys { hipTurn: number; hipTilt: number; hipSide: number; chestTurn: number; chestTilt: number; chestSide: number; shift: number; drop: number; heel: number; shrug: number; pro: number; hinge: number; beta: number; reach: number; lift: number }
const K = (o: Partial<Keys>, base: Keys): Keys => ({ ...base, ...o });
// address: spine bent toward the ball and tilted away from the target (trail shoulder low, lead hip high)
const A: Keys = { lift: 0, reach: 1, hipTurn: 0.04, hipTilt: 0.28, hipSide: 0.07, chestTurn: 0.04, chestTilt: 0.62, chestSide: 0.2, shift: 0.012, drop: 0, heel: 0, shrug: 0, pro: 0.15, hinge: 0, beta: 0 };
const TAKE = K({ hipTurn: -0.16, hipSide: 0.05, chestTurn: -0.7, chestTilt: 0.63, chestSide: 0.18, shift: 0.004, shrug: 0.04, hinge: 0.32, beta: -0.16 }, A);
const HALF = K({ lift: 0.06, reach: 1.06, hipTurn: -0.4, hipSide: 0.02, chestTurn: -1.15, chestTilt: 0.67, chestSide: 0.14, shift: -0.01, shrug: 0.1, pro: 0.13, hinge: 0.75, beta: -0.1 }, A);
const B3Q = K({ lift: 0.18, reach: 1.3, hipTurn: -0.6, hipTilt: 0.26, hipSide: -0.01, chestTurn: -1.38, chestTilt: 0.69, chestSide: 0.1, shift: -0.018, shrug: 0.15, pro: 0.11, hinge: 1.06, beta: -0.28 }, A);
const T: Keys = { lift: 0.3, reach: 1.42, hipTurn: -0.78, hipTilt: 0.25, hipSide: -0.02, chestTurn: -1.72, chestTilt: 0.69, chestSide: 0.08, shift: -0.02, drop: 0, heel: 0, shrug: 0.25, pro: 0.1, hinge: 1.24, beta: -0.32 };
// downswing: the hips lead (they're already unwinding while the chest is still turned), the trail side drops
const TRANS = K({ lift: 0.28, reach: 1.38, hipTurn: -0.58, hipSide: 0.0, chestTurn: -1.56, chestSide: 0.15, shift: 0.025, shrug: 0.16 }, T);
const DOWN = K({ lift: -0.04, reach: 1.12, hipTurn: -0.12, hipSide: 0.04, chestTurn: -1.02, chestTilt: 0.64, chestSide: 0.28, shift: 0.055, shrug: 0.08, pro: 0.0, hinge: 0.56, beta: -0.16 }, T);
const LATE = K({ lift: -0.1, reach: 1.01, hipTurn: 0.4, hipTilt: 0.18, hipSide: 0.07, chestTurn: -0.42, chestTilt: 0.6, chestSide: 0.32, shift: 0.075, drop: 0.0, heel: 0.33, shrug: 0.0, pro: -0.02, hinge: 0.45, beta: -0.08 }, T);
// delivery: lead arm about parallel on the way down, shaft lagging ~45° behind the hands on plane, hips already open,
// trail elbow tucked in front of the trail hip
const DELIV = K({ lift: -0.34, reach: 1.05, hipTurn: 0.16, hipTilt: 0.19, hipSide: 0.06, chestTurn: -0.6, chestTilt: 0.62, chestSide: 0.44, shift: 0.09, drop: 0.0, heel: 0.3, shrug: 0.04, pro: -0.1, hinge: 0.42, beta: -0.15 }, T);
const I: Keys = { lift: 0, reach: 1, hipTurn: 0.7, hipTilt: 0.18, hipSide: 0.09, chestTurn: 0.22, chestTilt: 0.55, chestSide: 0.24, shift: 0.08, drop: 0.02, heel: 0.36, shrug: 0.1, pro: -0.11, hinge: 0, beta: 0 };
// follow-through: chest keeps rotating and rises; the arms extend down the line, then fold up behind the head
const REL = K({ hipTurn: 0.95, chestTurn: 0.72, chestTilt: 0.4, chestSide: 0.36, shift: 0.1, drop: -0.025, heel: 0.45, hinge: -0.08, beta: 0.08, pro: -0.02 }, I);
const THRU = K({ hipTurn: 1.1, hipTilt: 0.12, hipSide: 0.05, chestTurn: 0.9, chestTilt: 0.3, chestSide: 0.32, shift: 0.13, drop: -0.035, heel: 0.66, shrug: -0.1, pro: -0.06, hinge: -0.45, beta: 0.25 }, I);
const T3Q = K({ hipTurn: 1.5, hipTilt: 0.06, hipSide: 0.02, chestTurn: 1.75, chestTilt: 0.03, chestSide: 0.2, shift: 0.16, drop: -0.04, heel: 0.82, shrug: -0.12, pro: -0.02, hinge: -0.85, beta: 0.42 }, I);
// full finish: belt buckle and chest past the target, weight on the lead leg, upright with a slight reverse-C
const F: Keys = { lift: 0, reach: 1, hipTurn: 1.58, hipTilt: 0.08, hipSide: 0.0, chestTurn: 2.05, chestTilt: 0.18, chestSide: 0.1, shift: 0.17, drop: -0.02, heel: 0.97, shrug: -0.12, pro: 0, hinge: -0.95, beta: 0.52 };
// held finish: fully rotated (buckle and chest a little past the target), all the weight on a straight lead leg,
// trail foot up on its toe with the knee against the lead knee, tall and stacked (spine only ~7° away from the
// target, no backward bow), hands by the head
const HOLD: Keys = { lift: 0, reach: 1, hipTurn: 1.72, hipTilt: 0.05, hipSide: -0.02, chestTurn: 2.3, chestTilt: 0.1, chestSide: 0.12, shift: 0.19, drop: -0.02, heel: 1, shrug: -0.12, pro: 0, hinge: -1.0, beta: 0.6 };
// where each key sits: back/follow by the hands' angle as a fraction of a full top/finish, down by fraction of this top
const KF_BACK: [number, Keys][] = [[0, A], [0.3, TAKE], [0.55, HALF], [0.8, B3Q], [1, T]];
const KF_DOWN: [number, Keys][] = [[0, T], [0.15, TRANS], [0.45, DOWN], [0.62, DELIV], [0.8, LATE], [1, I]];
const KF_FOLLOW: [number, Keys][] = [[0, I], [0.12, REL], [0.33, THRU], [0.55, T3Q], [0.8, F], [1, HOLD]];
const KEY_NAMES = Object.keys(A) as (keyof Keys)[];
/** monotone cubic (Fritsch–Carlson) through the keys of one channel: smooth, never overshoots a key */
function keysAt(kf: [number, Keys][], u: number, o: Keys) {
  u = Math.min(kf[kf.length - 1][0], Math.max(kf[0][0], u));
  let i = 0; while (i < kf.length - 2 && u > kf[i + 1][0]) i++;
  const [x0, k0] = kf[i], [x1, k1] = kf[i + 1], h = x1 - x0, t = (u - x0) / h;
  const h00 = 2 * t ** 3 - 3 * t ** 2 + 1, h10 = t ** 3 - 2 * t ** 2 + t, h01 = -2 * t ** 3 + 3 * t ** 2, h11 = t ** 3 - t ** 2;
  const slope = (j: number, n: keyof Keys) => (kf[j + 1][1][n] - kf[j][1][n]) / (kf[j + 1][0] - kf[j][0]);
  const tan = (j: number, n: keyof Keys) => {
    if (j === 0) return slope(0, n);
    if (j === kf.length - 1) return slope(j - 1, n);
    const a = slope(j - 1, n), b = slope(j, n);
    return a * b <= 0 ? 0 : (2 * a * b) / (a + b); // harmonic mean: no overshoot
  };
  for (const n of KEY_NAMES) o[n] = h00 * k0[n] + h10 * h * tan(i, n) + h01 * k1[n] + h11 * h * tan(i + 1, n);
  return o;
}
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** how each shot type swings: backswing length, finish length, stance and hinge */
export const SHOT_STYLE: Record<ShotMode, { back: number; finish: number; stance: number; hinge: number; open: number; handsFwd: number; tempo: number }> = {
  full:  { back: 1,    finish: 1,    stance: 1,    hinge: 1,    open: 0,    handsFwd: 0,    tempo: 1 },
  punch: { back: 0.72, finish: 0.5,  stance: 0.9,  hinge: 0.7,  open: 0,    handsFwd: 0.05, tempo: 0.85 },
  pitch: { back: 0.58, finish: 0.58, stance: 0.75, hinge: 0.85, open: 0.05, handsFwd: 0.02, tempo: 0.9 },
  flop:  { back: 0.92, finish: 0.9,  stance: 1.05, hinge: 1.1,  open: 0.3,  handsFwd: -0.02, tempo: 1.15 },
};
export const PHI_TOP = 2.6;     // hands angle at the top of a full swing
export const PHI_FINISH = -3.2; // hands angle at a full finish
const ROLL_TOP = +(globalThis.location ? new URLSearchParams(globalThis.location.search).get('roll') ?? 1.2 : 1.2); const ROLL_SIGN = -1; // forearm rotation (radians of club roll at the top)
const ADDRESS_TOE_UP = +(globalThis.location ? new URLSearchParams(globalThis.location.search).get('toeup') ?? 12 : 12);   // degrees, driver
const _fq = globalThis.location ? new URLSearchParams(globalThis.location.search) : null, _fv = (n: string, d: number[]) => _fq?.get(n)?.split(',').map(Number) ?? d;
// held-finish targets in the chest's frame (URL-tunable on golfer.html: fg = hands from the neck, fs = shaft back/down
// added to the shoulder line, fpl/fpr = elbow poles). Traced against tools/refs/swing/rory_finish.jpg, right panel, mirrored.
const ARM_SCALE = +(_fq?.get('arm') ?? 1.08);
const LEAN_K = _fv('lk', [0.35, 1.3]);
// short clubs: weight a little on the lead side, the chest over the ball (pelvis this far toward the target with a wedge)
const PEL_FWD = +(_fq?.get('pf') ?? 0.04);
const HA_K = +(_fq?.get('hk') ?? 0.04);
const MOCAP_PELVIS = new THREE.Vector3(...(_fv('mp', [0.55, 0.5, 1]) as [number, number, number]));
const SIDE_ADJ = _fv('sa', [-0.2, 0.14]);
const FIN = { g: _fv('fg', [0.15, 0.22, -0.17]), s: _fv('fs', [0.8, 0.6]), pl: _fv('fpl', [0.3, -0.7, 0.5]), pr: _fv('fpr', [-0.05, -0.4, 0.8]) };
const GRIP_DOWN = _fv('gd', [0.03, 0.85]);
const TRAIL_W = +(_fq?.get('tw') ?? 0);
const ARC12 = _fv('a12', [-0.5, -0.68, 0.6]), ARC33 = _fv('a33', [-0.5, -0.28, 0.83]), ARC55 = _fv('a55', [0.05, 0.5, 0.8]);
const GRIP_A = _fv('ga', [0.6, 0.7]);
const GRIP_B = _fv('gb', [0.85, 0.55]);
const LEAN = 0.075;             // shaft lean at impact, radians (hands ~6 cm ahead of the ball)

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
  private leanSign = 1;
  /** extra forward bend from the hips found at set-up (radians), faded out as the golfer stands up in the finish */
  private tiltAdj = 0;
  /** height of the ball's bottom above the turf (on a tee), 0 on the turf */
  private teeH = 0;
  /** extra spine tilt away from the target for the longer clubs (radians) */
  private sideAdj = 0;
  /** tee the ball up (metres of tee showing under the ball); re-sets the address */
  setTee(h: number) { if (Math.abs(h - this.teeH) > 1e-4) { this.teeH = h; this.setupAddress(); } }
  /** the trail foot's toes: their flat (on the ground) heel→toe direction, turned with the foot's pivot */
  private trailToeFlat = new THREE.Vector3(0, 0, 1);
  private pelvisBase = new THREE.Vector3();
  readonly clubHeadWorld = new THREE.Vector3();
  readonly lefty: boolean;
  private smile = 0;
  /** ease the face toward a smile (1) or neutral (0) */
  smileToward(target: number, dt: number) { this.smile += (target - this.smile) * (1 - Math.exp(-dt * 5)); this.body.setSmile(this.smile); }

  private extras: HumanExtras | null = null;
  private handFrame: { L: { dir: THREE.Vector3; palm: THREE.Vector3 }; R: { dir: THREE.Vector3; palm: THREE.Vector3 } } | null = null;
  constructor(readonly profile: GolferProfile, human?: HumanData) {
    this.k = profile.heightM / 1.905;
    this.lefty = profile.handed === 'left';
    if (human) { const b = buildHumanBody(human, profile); this.body = b; this.extras = b.extras; }
    else this.body = buildBody(profile);
    this.rig = new Rig(this.body);
    // Neil's arms: the base mesh's are short for 6'3" (shoulder to wrist 56 cm, about 0.295 of his height, where 0.32 is
    // typical), which left no slack to reach the club. Lengthened to ~0.32 of his height; the hand rides out with the wrist.
    if (this.extras && ARM_SCALE !== 1) {
      this.rig.scaleArms(ARM_SCALE);
      for (const sd of ['L', 'R'] as const) this.body.bones[this.extras.hand[sd]].position.multiplyScalar(ARM_SCALE);
    }
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
    const extra = Math.max(0, Math.round((this.profile.heightM - 1.8) / 0.1)) * 0.5 * IN; // fitted: +0.5" per 10 cm over 1.80 m (+0.5" at 6'3")
    // the long clubs sit a little toe-up at address (the hands hang lower than the spec lie, as a tour player's do with
    // a driver; DTL shaft angle ~47°): flatter by 10° for the driver, ~6° for the woods, ~2° for the hybrids, nothing for the irons (continuous by length). Our rig's arms
    // are short for his height, so without it the driver's hands sit too high for a straight lead arm
    const toeUp = ADDRESS_TOE_UP * clubLengthT(spec) ** 2;
    this.club = buildClub(toeUp ? { ...spec, lie: spec.lie - toeUp } : spec, extra, this.body.materials.glove, this.body.materials.skin);
    this.char.add(this.club.group);
    this.setupAddress();
  }

  private setupAddress() {
    const k = this.k, spec = this.club.spec, st = SHOT_STYLE[this.mode];
    const teed = spec.kind === 'driver';
    // ball and club head
    // the ball on its tee (teeH = ball bottom above the turf), else on the turf; woods hover so the sweet spot
    // meets the ball's centre (an upward strike on a teed driver), irons rest on the ground
    this.ballC.set(0, BALL_R + this.teeH, 0);
    const woody = spec.kind === 'driver' || spec.kind === 'wood';
    this.clubAt.set(-BALL_R, Math.max(this.club.sweetToGround, woody ? this.ballC.y : 0), 0);
    void teed;
    this.gripAddr.copy(this.clubAt).add(this.club.gripLead);
    // stance: wider for long clubs, ball forward for the driver
    // ball position (ahead of the stance centre): driver just inside the lead heel, 3 wood two balls back, middle
    // irons a touch ahead of centre, wedges in the middle
    const L = this.club.length;
    const lt = clubLengthT(spec); void L;
    const ahead = 0.215 * lt ** 1.25;   // continuous by club length: wedge 0, 7 iron ~3 cm, 3 wood ~15 cm, driver 21.5 cm
    this.stanceX = -ahead * k;
    // shoulder tilt at address (trail shoulder low): most with the driver, a small tilt with a wedge
    this.sideAdj = SIDE_ADJ[0] + (SIDE_ADJ[1] - SIDE_ADJ[0]) * lt;
    // set-up like a tour player: arms hang (shoulder sockets roughly above the hands), relaxed and nearly
    // straight. Find the distance from the ball that puts the lead shoulder over the hands, then bend more or
    // less from the hips until the lead arm is ~98% extended.
    const pos = this.pose;
    const armLen = this.rig.len.upper + this.rig.len.fore;
    // the wrists where the address pose will put them: on the grip (hands 3 cm down it), with this club's shaft lean
    const sdn = this.club.shaftDir.clone().normalize().multiplyScalar(-GRIP_DOWN[0]);
    const axis0 = new THREE.Vector3().crossVectors(this.club.shaftDir.clone().negate(), new THREE.Vector3(-1, 0, 0).addScaledVector(this.club.shaftDir, this.club.shaftDir.x).normalize()).normalize();
    const sign0 = this.club.gripLead.clone().applyAxisAngle(axis0, 0.1).x > this.club.gripLead.x ? 1 : -1;
    const qLean = new THREE.Quaternion().setFromAxisAngle(axis0, LEAN * (LEAN_K[0] - LEAN_K[1] * lt * lt) * sign0);
    const wristAddr = this.extras ? this.clubAt.clone().add(this.gripFrame('L', this.club.gripLead.clone().add(sdn)).wrist.applyQuaternion(qLean)) : this.gripAddr.clone();
    const wristAddrR = this.extras ? this.clubAt.clone().add(this.gripFrame('R', this.club.gripLead.clone().lerp(this.club.gripTrail, GRIP_DOWN[1]).add(sdn)).wrist.applyQuaternion(qLean)) : null;
    // how far the hands hang ahead of the shoulder: more with the longer clubs (toes ~49 cm from the ball with a wedge,
    // ~53 with a 7 iron, ~68 with the driver)
    const handsAhead = (0.03 + HA_K * lt ** 1.2) * k;
    const solveZ = () => {
      let lo = -1.2, hi = -0.1;
      for (let it = 0; it < 20; it++) {
        const z = (lo + hi) / 2;
        this.pelvisBase.set(this.stanceX + PEL_FWD * (1 - lt) * k, this.body.skel.joint[BONE.pelvis].y - kneeDrop * k - st.stance * 0.01, z);
        this.addressKeys(pos); this.rig.apply(pos);
        const sh = this.rig.P[BONE.upperL];
        // shoulder a touch outside the hands (toward the ball) — a plumb line from it hangs just inside the toes
        if (sh.z < wristAddr.z - handsAhead) lo = z; else hi = z;   // shoulder a little behind the hands (traced: the hands hang just ahead of it)
      }
      // arm length to the actual wrist on the grip (real hands), else to the grip less a hand
      return this.extras ? this.rig.P[BONE.upperL].distanceTo(wristAddr) : this.rig.P[BONE.upperL].distanceTo(this.gripAddr) - 0.072 * k;
    };
    // knee flex adapts to the body's proportions: the most athletic flex for which a natural spine bend still lets
    // the lead arm hang straight to the hands (the tilt search isn't pinned at its upright limit)
    let kneeDrop = 0.05;
    for (; kneeDrop >= -0.02; kneeDrop -= 0.01) {
      let tlo = -0.25, thi = 0.35;
      for (let it = 0; it < 14; it++) {
        this.tiltAdj = (tlo + thi) / 2;
        const d = solveZ();
        if (d > armLen * (this.extras ? 0.999 : 0.985)) tlo = this.tiltAdj; else thi = this.tiltAdj; // too far: bend over more
      }
      this.tiltAdj = (tlo + thi) / 2;
      if (this.tiltAdj > -0.2) break;
    }
    solveZ();
    // the trail hand has to reach too (it's lower on the grip): if the trail arm comes up more than 3.5 cm short (the shoulder blade gives that much), the trail
    // shoulder drops (more spine tilt away from the target) and the bend is re-found
    for (let it = 0; it < 6 && wristAddrR; it++) {
      if (this.rig.P[BONE.upperR].distanceTo(wristAddrR) - armLen <= 0.035) break;
      this.sideAdj += 0.03;
      let tlo = -0.25, thi = 0.35;
      for (let j = 0; j < 12; j++) { this.tiltAdj = (tlo + thi) / 2; if (solveZ() > armLen * 0.999) tlo = this.tiltAdj; else thi = this.tiltAdj; }
      this.tiltAdj = (tlo + thi) / 2; solveZ();
    }
    // swing circle: plane through the shaft line and the target line
    this.e1.copy(this.club.shaftDir);
    this.e2.set(-1, 0, 0).addScaledVector(this.e1, this.e1.x).normalize();
    this.rh = 0.6 * k;
    this.circleC.copy(this.gripAddr).addScaledVector(this.e1, this.rh);
    this.axis.crossVectors(this.e1.clone().negate(), this.e2).normalize();
    { const gl = this.club.gripLead.clone(); const q = new THREE.Quaternion().setFromAxisAngle(this.axis, 0.1); this.leanSign = gl.clone().applyQuaternion(q).x > gl.x ? 1 : -1; }
    // hands: build once per club, pointing at the arms at address
    if (this.hands) { this.club.group.remove(this.hands.group); }
    const shL = this.rig.P[BONE.upperL].clone(), shR = this.rig.P[BONE.upperR].clone();
    const towardL = shL.sub(this.gripAddr).normalize();
    const towardR = shR.sub(this.clubAt.clone().add(this.club.gripTrail)).normalize();
    if (this.extras) {
      // real hands, an overlap (Vardon) grip, neutral to slightly strong. Built in club space:
      // - each palm faces the shaft and sits on the grip (palm normal = from the hand toward the shaft axis);
      // - the hand's long axis crosses the shaft diagonally (the grip runs from the base of the pinky to the middle
      //   of the index finger), the fingers heading round the underside of the grip; the trail hand holds it more
      //   in the fingers (steeper across);
      // - lead hand turned ~28° toward the golfer (V toward the trail shoulder, 2-3 knuckles showing), trail hand
      //   ~14° under. The fingers are then wrapped onto the grip surface in poseHands.
      const gl = this.club.gripLead, gr = this.club.gripTrail;
      void towardL; void towardR;
      const frame = (side: 'L' | 'R', grip: THREE.Vector3) => this.gripFrame(side, grip);
      // overlap grip: the trail pinky rides over the lead index, so the hands sit ~7 cm apart (the club's own
      // trail grip point is 9 cm below the lead one)
      // the lead hand sits ~3 cm further down the grip than the club's nominal point, so a little of the butt shows above
      // the heel pad (the wrist ends up just above the butt, not past it); the trail hand right under it
      const dn = this.club.shaftDir.clone().normalize().multiplyScalar(-GRIP_DOWN[0]);
      const fL = frame('L', gl.clone().add(dn)), fR = frame('R', gl.clone().lerp(gr, GRIP_DOWN[1]).add(dn));
      this.handFrame = { L: fL, R: fR };
      this.hands = { group: new THREE.Group(), wristLead: fL.wrist, wristTrail: fR.wrist };
    } else {
      this.hands = buildHands(this.club, towardL, towardR, this.body.materials.glove, this.body.materials.skin);
    }
    this.club.group.add(this.hands.group);
    this.introSnap = null;
    this.headAnchor = null; this.legAddr = { L: 9, R: 9 };
    this.update({ phase: 'address', phi: 0, topPhi: PHI_TOP, idleT: 0 });
    this.headAnchor = this.headCentre();
    { const m = this.legMiss(this.pose); this.legAddr = { L: m.L + 1e-3, R: m.R + 1e-3 }; }
    // calibrate the attack angle on the keyed swing: measure the path as posed, store the slope to add
    this.aoaFix = 0;
    { const src = this.swingSource; this.swingSource = 'keyed';
      const want = Math.tan(THREE.MathUtils.degToRad(this.attackAngleDeg()));
      for (let it = 0; it < 3; it++) this.aoaFix += want - Math.tan(THREE.MathUtils.degToRad(this.pathAngleDeg()));
      this.swingSource = src; }
    this.update({ phase: 'address', phi: 0, topPhi: PHI_TOP, idleT: 0 });
  }

  /** one hand's frame on the grip, in club space: its long axis, palm normal and wrist position */
  private gripFrame(side: 'L' | 'R', grip: THREE.Vector3) {
        const k = this.k, sd = this.club.shaftDir.clone().normalize();
        const beta = (side === 'L' ? GRIP_B[0] : GRIP_B[1]) + 0.1 * (clubLengthT(this.club.spec) - 0.3),   // a touch stronger with the long clubs
          alpha = side === 'L' ? GRIP_A[0] : GRIP_A[1];   // strong grip: lead ~37° on top (2.5-3 knuckles), trail ~18° under
        const palm = (side === 'L' ? new THREE.Vector3(-Math.cos(beta), 0, Math.sin(beta)) : new THREE.Vector3(Math.cos(beta), 0, -Math.sin(beta)));
        palm.addScaledVector(sd, -palm.dot(sd)).normalize();
        const under = new THREE.Vector3().crossVectors(palm, sd).normalize();
        if (under.z > 0) under.negate();                                    // toward the golfer's side: the hand continues the forearm
        const dir = sd.clone().multiplyScalar(-Math.cos(alpha)).addScaledVector(under, Math.sin(alpha)).normalize();
        // place the hand by its knuckles: the middle knuckle sits on the grip surface on the palm side of the shaft
        // (finger base half-thickness out from the grip), and the wrist follows from the hand's own bind geometry
        const E = this.extras!, mcp = this.body.bones[E.fingers[side][2][0]].position;
        const along = mcp.dot(E.handDir[side]), depth = mcp.dot(E.palm[side]);
        const rMcp = GRIP_R + 0.0125 * k;
        const wrist = grip.clone().addScaledVector(palm, -rMcp).addScaledVector(dir, -along).addScaledVector(palm, -depth);
        return { dir, palm, wrist };
      }

  private addressKeys(p: BodyPose) {
    const k = this.k, st = SHOT_STYLE[this.mode];
    p.hipTurn = A.hipTurn + st.open; p.hipTilt = A.hipTilt; p.hipSide = A.hipSide;
    p.chestTurn = A.chestTurn + st.open * 0.5; p.chestTilt = A.chestTilt + this.tiltAdj; p.chestSide = A.chestSide + this.sideAdj;
    p.pelvis.copy(this.pelvisBase);
    p.shrugL = p.shrugR = 0;
    this.feet(p, 0, 0);
    p.wristL.copy(this.gripAddr).add(new THREE.Vector3(0.02, 0.06, -0.05));
    p.wristR.copy(this.gripAddr).add(new THREE.Vector3(-0.02, 0.0, -0.06));
    p.poleL.set(0.5, -0.5, this.pelvisBase.z); p.poleR.set(-0.5, -0.5, this.pelvisBase.z);
    p.look.copy(this.ballC);
    void k;
  }

  /** half the stance width (ankle joints) for this club and shot */
  private halfStance() { return 0.5 * (0.36 + 0.667 * Math.max(0, this.club.length - 0.9)) * this.k * SHOT_STYLE[this.mode].stance; }
  private feet(p: BodyPose, heel: number, shift: number, hipTurn = 0) {
    p.footUpL = undefined;
    const k = this.k, st = SHOT_STYLE[this.mode];
    // stance (ankle joints): ~36 cm with a wedge, ~42 cm with a 7 iron, ~54 cm with the driver
    const half = this.halfStance();
    // ankles just ahead of the hip joints (tour set-up from behind: knees over the balls of the feet, not a squat)
    const fz = this.pelvisBase.z + 0.04 * k;
    // lead foot flared ~29° toward the target for balance (and kept), trail foot square
    const flareL = 0.5 + st.open, flareR = -0.12;
    const openBack = st.open * 0.12; // open stance: lead foot pulled back from the line
    const J = this.body.skel.joint, T = this.body.skel.tail;
    p.ankleL.set(this.stanceX + half, J[BONE.footL].y, fz - openBack);
    p.ankleR.set(this.stanceX - half, J[BONE.footR].y, fz);
    // feet keep their bind shape, turned out (flared) a little
    const fL = T[BONE.footL].clone().sub(J[BONE.footL]), fR = T[BONE.footR].clone().sub(J[BONE.footR]);
    fL.x = 0; fR.x = 0;
    p.toeL.copy(p.ankleL).add(fL.applyAxisAngle(new THREE.Vector3(0, 1, 0), flareL));
    // as the hips turn over the lead foot in the finish it rolls a little onto its outside edge (the target side):
    // the top of the foot tilts toward the target
    const leadRoll = 0.16 * smooth(1.0, 1.65, hipTurn);
    if (leadRoll > 1e-4) {
      const toeDirL = p.toeL.clone().sub(p.ankleL).setY(0).normalize();
      p.footUpL = new THREE.Vector3(0, 1, 0).applyAxisAngle(toeDirL, -leadRoll);
      if (p.footUpL.x < 0) p.footUpL.copy(new THREE.Vector3(0, 1, 0).applyAxisAngle(toeDirL, leadRoll));
    }
    p.toeR.copy(p.ankleR).add(fR.applyAxisAngle(new THREE.Vector3(0, 1, 0), flareR));
    // trail heel comes up and the trail knee kicks in toward the target in the follow-through
    p.footUpR = undefined;
    this.trailToeFlat.copy(p.toeR).sub(p.ankleR).setY(0).normalize();
    if (heel > 0) {
      // Trail foot after impact, as a tour player's: the heel comes up first and the foot rolls onto its inside edge
      // and the ball of the foot; by the finish it stands up on the toe, heel turned out, laces to the target and the
      // sole facing back. It pivots about the ball of the foot (the foot bone's tail, at ground level), which stays
      // planted; the toes stay flat on the turf (see poseHands).
      const Yv = new THREE.Vector3(0, 1, 0);
      const ballJ = p.toeR.clone();
      const v = p.ankleR.clone().sub(p.toeR), up = Yv.clone();
      const yaw = 1.5 * smooth(0.45, 1, heel);              // + about Y swings the heel toward -X (away from the target), late;
                                                          // by the finish the toe points nearly at the target
      v.applyAxisAngle(Yv, yaw); up.applyAxisAngle(Yv, yaw);
      this.trailToeFlat.applyAxisAngle(Yv, yaw);
      // inside-edge roll early on (the top of the foot tips toward the lead foot), gone by the finish
      const roll = 0.26 * smooth(0, 0.35, heel) * (1 - smooth(0.7, 1, heel));
      up.applyAxisAngle(this.trailToeFlat, -roll);
      const lat = new THREE.Vector3().crossVectors(Yv, v).normalize();
      // heel ~1 cm up at impact, 5-6 cm at the release, sole near vertical in a full finish
      const lift = 1.35 * smooth(0.25, 1.08, heel);
      const sgn = v.clone().applyAxisAngle(lat, 0.3).y > v.y ? 1 : -1;
      v.applyAxisAngle(lat, sgn * lift); up.applyAxisAngle(lat, sgn * lift);
      p.ankleR.copy(ballJ).add(v);
      p.toeR.copy(ballJ);
      p.footUpR = up;
    }
    // trail knee: points the way the trail foot points (kicks in toward the lead knee as the foot pivots), so the shin
    // never twists against the shoe
    const toeDir = p.toeR.clone().sub(p.ankleR).setY(0);
    if (toeDir.lengthSq() < 1e-6) toeDir.set(0, 0, 1);
    toeDir.normalize().lerp(new THREE.Vector3(1, 0, 0), Math.min(0.85, 0.7 * heel)).normalize();
    p.kneePoleR.copy(p.ankleR).addScaledVector(toeDir, 1.0).setY(0.5);
  }

  /** Pose the golfer for a swing state. Returns the club-head position (world). */
  update(s: SwingState) {
    if (!this.mocapBusy) {
      this.idleBreath = 0; this.idleSway = 0;
      if (s.phase === 'address') {
        const u = s.intro ?? this.introClock();
        if (u !== null && u < 1) return this.updateIntro(s, Math.max(0, u));
        this.idleBreath = Math.sin(s.idleT * 1.6) * 0.006; this.idleSway = Math.sin(s.idleT * 0.7) * 0.004 * this.k;
        // idle waggle: a small takeaway and back with the wrists; posed as the first inches of the backswing, so a
        // swing that starts mid-waggle carries straight on from where the club is
        this.wagPhi = this.wagglePhi(s.idleT);
        if (this.wagPhi > 1e-4) s = { ...s, phase: 'back', phi: this.wagPhi, topPhi: PHI_TOP };
      } else if (s.phase === 'back') {
        // swing started mid-waggle: no snap back to address; the waggle's head start fades out over the takeaway
        if (this.wagPhi > 1e-4) s = { ...s, phi: s.phi + this.wagPhi * (1 - smooth(0, 0.22 * PHI_TOP, s.phi)) };
      } else this.wagPhi = 0;
    }
    if (this.swingSource === 'mocap' && s.phase !== 'address' && !this.mocapBusy && this.extras) return this.updateMocap(s);   // the captured swing (mocap.ts); ?swing=keyed for the hand-keyed one
    const st = SHOT_STYLE[this.mode], p = this.pose, k = this.k;
    const key: Keys = { ...A };
    let phi = s.phi, finW = 0;
    const hingeTop = 2.05 * st.hinge;
    if (s.phase === 'address') {
      Object.assign(key, A);
      phi = 0;
    } else if (s.phase === 'back') {
      keysAt(KF_BACK, Math.max(0, phi) / PHI_TOP, key);
    } else if (s.phase === 'down') {
      // from wherever this backswing topped out: the backswing-side difference fades out by impact
      const u = 1 - Math.max(0, phi) / Math.max(0.01, s.topPhi);
      keysAt(KF_DOWN, u, key);
      const top = keysAt(KF_BACK, Math.min(1, s.topPhi / PHI_TOP), { ...A });
      const w = 1 - smooth(0, 0.85, u);
      for (const n of KEY_NAMES) key[n] += (top[n] - T[n]) * w;
      // long clubs: the hands drop further out into the slot at delivery, so the trail elbow still leads the hip
      { const lt = clubLengthT(this.club.spec); key.lift -= 0.3 * lt * lt * smooth(0.45, 0.62, u) * (1 - smooth(0.62, 0.8, u)); }
    } else {
      // short finishes (punch, pitch) stop part-way along the same path and hold
      const f = Math.min(1, -phi / Math.abs(PHI_FINISH));
      keysAt(KF_FOLLOW, f * st.finish, key);
      finW = smooth(0.36, 0.95, f) * smooth(0.45, 0.95, st.finish);
    }
    const hinge = key.hinge * hingeTop, beta = key.beta;
    // breathing and a little life at address
    const breathe = this.idleBreath;

    p.hipTurn = key.hipTurn + st.open; p.hipTilt = key.hipTilt; p.hipSide = key.hipSide;
    p.chestTurn = key.chestTurn + st.open * 0.5; p.chestTilt = key.chestTilt + breathe + this.tiltAdj * (s.phase === 'follow' ? 1 - smooth(0.25, 0.9, -phi / Math.abs(PHI_FINISH)) : 1); p.chestSide = key.chestSide + this.sideAdj * (s.phase === 'follow' ? 1 - smooth(0.1, 0.6, -phi / Math.abs(PHI_FINISH)) : 1);
    p.pelvis.copy(this.pelvisBase); p.pelvis.x += key.shift * k;
    p.pelvis.x += this.idleSway;   // a slow, tiny weight shift while he waits
    // (a short club's set-up already has the weight forward: that is part of the shift, not extra)
    p.pelvis.x -= PEL_FWD * (1 - clubLengthT(this.club.spec)) * k * smooth(A.shift, I.shift, key.shift);
    // a wider stance (driver) needs a longer slide to get the hips, and the head, over the lead foot by the finish
    p.pelvis.x += Math.max(0, key.shift) / HOLD.shift * (this.halfStance() - 0.197 * k); p.pelvis.y -= key.drop * k;
    // clavicles: within anatomical limits (±0.11 rad keeps the shoulder joint within 2 cm of its rest place)
    const clav = (v: number) => Math.max(-0.1, Math.min(0.1, v));
    p.shrugL = clav(key.shrug); p.shrugR = clav(-key.shrug * 0.5 + key.pro);
    this.feet(p, key.heel, key.shift, key.hipTurn);
    (p.shoulderR ??= new THREE.Vector3()).set(0, 0, 0);
    // steady head: from address to impact the head stays where it was at address (within a couple of cm); the spine
    // takes up the hips' turn and slide with a little more or less side bend and forward bend. Faded out after
    // impact so the head rises into the finish.
    const headW = s.phase === 'back' || s.phase === 'down' ? 1 : s.phase === 'follow' ? 1 - smooth(0.04, 0.3, -phi / Math.abs(PHI_FINISH)) : 0;
    this.legReach(p);
    const headOff = [0, 0];
    if (headW > 0.001 && this.headAnchor) {
      // a pro's head isn't frozen: it settles ~1.5 cm back and ~2 cm down into the delivery (still inside the
      // owner's 4 cm / 2.5 cm), then back up to impact
      const uD = s.phase === 'down' ? 1 - Math.max(0, phi) / Math.max(0.01, s.topPhi) : 0, uB = s.phase === 'back' ? Math.max(0, phi) / PHI_TOP : s.phase === 'down' ? 1 : 0;
      const dip = smooth(0.15, 0.55, uD) * (1 - smooth(0.7, 1, uD));
      headOff[0] = -0.012 * smooth(0, 0.6, uB) * (1 - smooth(0.6, 1, uD)) - 0.026 * dip; headOff[1] = -0.012 * dip;
      this.steadyHead(p, headW, headOff[0], headOff[1]);
    }

    // hands on the circle, carried round the body by beta; club rotated in the plane by phi + hinge
    const hands = this.circleC.clone()
      .addScaledVector(this.e1, -this.rh * key.reach * Math.cos(phi) + this.rh * (key.reach - 1))
      .addScaledVector(this.e2, this.rh * key.reach * Math.sin(phi));
    const pivot = this.pelvisBase.clone();
    hands.sub(pivot).applyAxisAngle(new THREE.Vector3(0, 1, 0), beta).add(pivot);
    const psi = phi + hinge;
    // the hands are carried round the body by beta; the club turns with them only half as much going back (keeps it on
    // line, pointing down the target line at the top, rather than across it)
    const betaClub = beta * (s.phase === 'back' ? 1 - 0.47 * smooth(0.35, 0.85, Math.max(0, phi) / PHI_TOP) : s.phase === 'down' ? 1 - 0.47 * smooth(0.3, 0.9, Math.max(0, phi) / Math.max(0.01, s.topPhi)) : 1);
    const qc = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), betaClub).multiply(new THREE.Quaternion().setFromAxisAngle(this.axis, psi));
    const g = this.club.group;
    g.position.copy(hands).sub(this.club.gripLead.clone().applyQuaternion(qc));
    // shaft lean: around address and impact the hands sit ahead of the club head (toward the target).
    // Rotate the club about its head (the club's origin), so the head stays put and the grip moves forward.
    // By club: irons and wedges lean forward (hands ahead of the ball, more at impact); the driver's hands sit behind the
    // teed ball at address (inside the lead thigh, shaft leaning back a little) and about level with it at impact.
    const ltc = clubLengthT(this.club.spec), aLean = LEAN_K[0] - LEAN_K[1] * ltc * ltc, iLean = 1 - 0.85 * ltc * ltc;
    let leanW = 0;
    if (s.phase === 'address') leanW = aLean;
    else if (s.phase === 'down') leanW = iLean * (1 - smooth(0, 0.45, Math.max(0, phi) / Math.max(0.01, s.topPhi)));
    else if (s.phase === 'follow') leanW = iLean * (1 - smooth(0, 0.14, -phi / Math.abs(PHI_FINISH)));
    else if (s.phase === 'back') leanW = aLean * (1 - smooth(0, 0.3, phi / PHI_TOP));
    // forearm rotation: the club (and the hands on it) rolls about its own shaft: open in the takeaway (toe up halfway
    // back, the palms on the swing plane at the top), square again at impact, rolled over through the release
    let roll = 0;
    if (s.phase === 'back') roll = ROLL_TOP * smooth(0, 0.55, phi / PHI_TOP);
    else if (s.phase === 'down') roll = ROLL_TOP * smooth(0, 0.55, s.topPhi / PHI_TOP) * smooth(0, 0.85, Math.max(0, phi) / Math.max(0.01, s.topPhi));
    else if (s.phase === 'follow') roll = -ROLL_TOP * 0.9 * smooth(0, 0.3, -phi / Math.abs(PHI_FINISH));
    if (roll) {
      // the forearms turn the hands in place: pivot the roll at the lead wrist so the arms keep their length
      // the forearms turn the hands in place: roll about the line through both wrists, so both arms keep their length
      const wL0 = this.hands.wristLead.clone().applyQuaternion(qc).add(g.position), wR0 = this.hands.wristTrail.clone().applyQuaternion(qc).add(g.position);
      const ax = wR0.clone().sub(wL0).normalize(), shaftW = this.club.shaftDir.clone().applyQuaternion(qc);
      if (ax.dot(shaftW) < 0) ax.negate();
      const qr = new THREE.Quaternion().setFromAxisAngle(ax, roll * ROLL_SIGN);
      qc.premultiply(qr);
      g.position.sub(wL0).applyQuaternion(qr).add(wL0);
    }
    if (leanW) qc.premultiply(new THREE.Quaternion().setFromAxisAngle(this.axis, LEAN * leanW * this.leanSign));
    g.quaternion.copy(qc);
    // arms: lead wrist first; if it can't reach, move the club with the hand
    const wl = this.hands.wristLead.clone().applyQuaternion(qc).add(g.position);
    const wr = this.hands.wristTrail.clone().applyQuaternion(qc).add(g.position);
    p.wristL.copy(wl); p.wristR.copy(wr);
    const down = new THREE.Vector3(0, -1, 0);
    // elbow poles, explicit per pose: at address the elbows point at the hips (pits up and forward); in the backswing
    // the trail elbow goes down and a little behind the body (traced: van Zyl, Rose), folding ~90° at the top
    p.poleL.copy(this.pelvisBase).add(new THREE.Vector3(0.16, -0.25, -0.05)).addScaledVector(down, 0.2);
    p.poleR.copy(this.pelvisBase).add(new THREE.Vector3(-0.16, -0.25, -0.05)).addScaledVector(down, 0.2);
    if (s.phase === 'back' || s.phase === 'down') {
      const u = s.phase === 'back' ? Math.max(0, phi) / PHI_TOP : Math.max(0, phi) / PHI_TOP * smooth(0.3, 1, Math.max(0, phi) / Math.max(0.01, s.topPhi));
      const shR = this.rig.P[BONE.upperR];
      p.poleR.lerp(shR.clone().add(new THREE.Vector3(-0.12, -0.5, -0.35)), smooth(0.15, 0.85, u));
    }
    if (s.phase === 'down') p.poleR.lerp(this.pelvisBase.clone().add(new THREE.Vector3(0.0, -1.4, 0.05)), smooth(0.2, 0.6, 1 - Math.max(0, phi) / Math.max(0.01, s.topPhi)));
    // elbows that let the wrists stay natural: aim each elbow at the point the forearm would come from if it
    // continued the hand's line on the grip (the hand's direction is fixed by the grip), so the wrist bends only a
    // little. Mostly for the trail arm, half for the lead; the follow-through sets its own elbows below.
    if (this.handFrame && s.phase !== 'follow') {
      for (const [side, w] of [['L', 0.25], ['R', s.phase === 'address' ? 0.5 : 0.15]] as const) {
        const dirW = this.handFrame[side].dir.clone().applyQuaternion(qc);
        const wrist = side === 'L' ? p.wristL : p.wristR;
        const elbowIdeal = wrist.clone().addScaledVector(dirW, -this.rig.len.fore);
        (side === 'L' ? p.poleL : p.poleR).lerp(elbowIdeal, w);
      }
    }
    if (s.phase === 'follow') p.poleR.set(this.pelvisBase.x + 0.6, -0.4, this.pelvisBase.z + 0.6);
    // eyes: on the ball until well after impact, then down the target line
    let watch = s.phase === 'follow' ? smooth(0.25, 0.75, -phi / Math.abs(PHI_FINISH)) : 0;
    // pre-shot routine: every few seconds over the ball, a look down the range at the target
    if (s.phase === 'address') { const c = (s.idleT + 2.0) % 6.5;   // first look 4.5 s in, never at idleT 0 (the walk-in ends looking at the ball)
      watch = Math.max(watch, 0.8 * smooth(0, 0.45, c) * (1 - smooth(1.5, 2.0, c))); }
    p.look.copy(this.ballC).lerp(new THREE.Vector3(60, 6, -4), watch);
    if (s.lookAt) p.look.copy(this.char.worldToLocal(s.lookAt.clone()));
    this.rig.apply(p);
    if (this.extras && (s.phase === 'back' || s.phase === 'down')) {
      // the triangle: the lead arm stays straight through the backswing and downswing; hold the lead wrist at full
      // arm's length from the lead shoulder (in the direction the swing put it) and carry the club with it. Fades out at
      // address and impact, where the set-up already has the arm straight and the club must stay on the ball.
      const wF = s.phase === 'back' ? smooth(0, 0.04, phi / PHI_TOP) : smooth(0, 0.25, Math.max(0, phi) / Math.max(0.01, s.topPhi));
      if (wF > 0.001) {
        const sh = this.rig.P[BONE.upperL], len = (this.rig.len.upper + this.rig.len.fore) * 0.995;
        // the lead arm raised toward vertical by the keyed lift (the hands above the trail shoulder at the top, traced)
        const armDir = p.wristL.clone().sub(sh).normalize(), up = new THREE.Vector3(0, 1, 0);
        const kAx = new THREE.Vector3().crossVectors(armDir, up);
        // (the club keeps its orientation: it stays pointing down the target line at the top)
        // (negative lift drops the hands into the slot in the downswing: hands at the trail thigh at delivery, elbow tucked)
        if (key.lift > 1e-4 && kAx.lengthSq() > 1e-6) armDir.applyAxisAngle(kAx.normalize(), Math.min(key.lift, armDir.angleTo(up) - 0.05));
        else if (key.lift < -1e-4) {
          // the slot: the hands drop down and OUT toward the ball, so the trail forearm reaches them from a low, tucked elbow
          const slot = new THREE.Vector3(0, -1, 0.85).normalize(), ax2 = new THREE.Vector3().crossVectors(armDir, slot);
          if (ax2.lengthSq() > 1e-6) armDir.applyAxisAngle(ax2.normalize(), Math.min(-key.lift, armDir.angleTo(slot)));
        }
        const wT = sh.clone().add(armDir.multiplyScalar(len));
        const mv = wT.sub(p.wristL).multiplyScalar(wF);
        g.position.add(mv); p.wristL.add(mv); p.wristR.add(mv);
        // near the top the shaft points down the target line (not across it): take out most of its sideways part,
        // turning the club about the lead wrist
        const wAim = s.phase === 'back' ? smooth(0.55, 1, phi / PHI_TOP) : smooth(0.6, 1, Math.max(0, phi) / Math.max(0.01, s.topPhi)) * Math.min(1, s.topPhi / PHI_TOP);
        if (wAim > 0.001) {
          const cur = this.club.shaftDir.clone().applyQuaternion(qc).negate().normalize();   // grip → head
          const want = cur.clone(); want.z *= 1 - 0.8 * wAim; want.normalize();
          const qa = new THREE.Quaternion().setFromUnitVectors(cur, want);
          qc.premultiply(qa); g.quaternion.copy(qc);
          g.position.copy(p.wristL).sub(this.hands.wristLead.clone().applyQuaternion(qc));
          p.wristR.copy(this.hands.wristTrail.clone().applyQuaternion(qc).add(g.position));
        }
        this.rig.apply(p);
      }
    }
    if (s.phase === 'follow') {
      // Through-swing hand path, traced (down-the-line refs): after impact the arms extend down the line with the club
      // parallel to the ground, then the hands rise in front of the chest with the shaft up, and only then fold behind
      // the head. Targets are in the chest's frame so they turn with the body. The club keeps its face roll; only the
      // shaft is re-aimed.
      const f = Math.min(1, -phi / Math.abs(PHI_FINISH)) * st.finish;
      const w = smooth(0.0, 0.12, f);
      if (w > 0.001) {
        const qChest = this.rig.Q[BONE.chest], neck = this.rig.P[BONE.neck];
        const L = (v: number[]) => new THREE.Vector3(v[0], v[1], v[2]).applyQuaternion(qChest);
        // [f, lead arm direction (chest frame), reach (fraction of arm length), shaft butt→head (chest frame)]
        const ARC = [
          [0.12, ARC12 as number[], 0.997, [0.45, -0.22, 0.9]],   // release: both arms extended down the line, club low to the target
          [0.33, ARC33 as number[], 0.999, [0.7, 0.6, 0.4]],       // through: arms still long, shaft up toward the target and the lead side
          [0.55, ARC55 as number[], 0.82, [0.12, 0.75, -0.65]],   // 3/4: the lead elbow starts to fold, shaft up over the lead shoulder
        ] as [number, number[], number, number[]][];
        let j = 0; while (j < ARC.length - 2 && f > ARC[j + 1][0]) j++;
        const t = smooth(ARC[j][0], ARC[j + 1][0], f);
        const aL = ARC[j][1].map((v, i) => v + (ARC[j + 1][1][i] - v) * t), sL = ARC[j][3].map((v, i) => v + (ARC[j + 1][3][i] - v) * t);
        const reach = ARC[j][2] + (ARC[j + 1][2] - ARC[j][2]) * t;
        // the lead wrist at that reach from the lead shoulder: the arms keep their length through the release
        const wristT = this.rig.P[BONE.upperL].clone().addScaledVector(L(aL).normalize(), (this.rig.len.upper + this.rig.len.fore) * reach);
        void neck;
        const shaftT = L(sL).normalize();
        const shaftNow = this.club.shaftDir.clone().applyQuaternion(qc).negate().normalize();
        const aim = new THREE.Quaternion().setFromUnitVectors(shaftNow, shaftNow.clone().lerp(shaftT, w).normalize());
        const wristNow = this.hands.wristLead.clone().applyQuaternion(qc).add(g.position);
        qc.premultiply(aim);
        g.quaternion.copy(qc);
        // blend round the lead shoulder (direction and reach separately), not along the chord, so the lead arm
        // stays long through the blend
        const shL = this.rig.P[BONE.upperL], dN = wristNow.clone().sub(shL), dT = wristT.clone().sub(shL);
        const lenB = dN.length() + (dT.length() - dN.length()) * w;
        const dirB = dN.normalize().applyQuaternion(new THREE.Quaternion().setFromUnitVectors(dN.clone(), dT.clone().normalize()).slerp(new THREE.Quaternion(), 1 - w));
        g.position.copy(shL).addScaledVector(dirB, lenB).sub(this.hands.wristLead.clone().applyQuaternion(qc));
        p.wristL.copy(this.hands.wristLead.clone().applyQuaternion(qc).add(g.position));
        p.wristR.copy(this.hands.wristTrail.clone().applyQuaternion(qc).add(g.position));
        this.rig.apply(p);
      }
    }
    if (finW > 0.001) {
      // full finish target, built in the chest's frame: hands up past the lead shoulder, shaft wrapped behind the neck
      const qChest = this.rig.Q[BONE.chest], neck = this.rig.P[BONE.neck];
      const L = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyQuaternion(qChest);
      const gripFin = neck.clone().add(L(...FIN.g as [number, number, number]));   // hands just above and behind the lead ear, face clear under the arms (Rory)
      // the club wraps round: the shaft runs behind the neck about parallel to the shoulder line, the head out past the
      // trail shoulder, angled a little down and back (Rory)
      const shLine = this.rig.P[BONE.upperR].clone().sub(this.rig.P[BONE.upperL]).setY(0).normalize();
      const shaftFin = shLine.add(L(0, 0, -FIN.s[0])).add(new THREE.Vector3(0, -FIN.s[1], 0)).normalize();   // grip → club head, behind the neck
      const faceFin = L(0, 0.35, -0.9).normalize();                  // where the club face points
      // club local frame: shaft runs hosel → butt along shaftDir, face looks along +X
      const mLocal = new THREE.Matrix4(), mFin = new THREE.Matrix4();
      const sd = this.club.shaftDir.clone();
      const fx = new THREE.Vector3(1, 0, 0).addScaledVector(sd, -sd.x).normalize();
      mLocal.makeBasis(sd, fx, new THREE.Vector3().crossVectors(sd, fx));
      const sF = shaftFin.clone().negate(), fF = faceFin.clone().addScaledVector(sF, -faceFin.dot(sF)).normalize();
      mFin.makeBasis(sF, fF, new THREE.Vector3().crossVectors(sF, fF));
      const qFin = new THREE.Quaternion().setFromRotationMatrix(mFin.multiply(mLocal.transpose()));
      const qB = qc.clone().slerp(qFin, finW);
      const gripNow = this.club.gripLead.clone().applyQuaternion(qc).add(g.position);
      const gripB = gripNow.lerp(gripFin, finW);
      qc.copy(qB);
      g.quaternion.copy(qB);
      g.position.copy(gripB).sub(this.club.gripLead.clone().applyQuaternion(qB));
      p.wristL.copy(this.hands.wristLead.clone().applyQuaternion(qB).add(g.position));
      p.wristR.copy(this.hands.wristTrail.clone().applyQuaternion(qB).add(g.position));
      // elbows: lead elbow folds down toward the target, trail elbow points down in front of the chest
      p.poleL.lerp(neck.clone().add(L(...FIN.pl as [number, number, number])), finW);   // lead elbow folded in front of the chin, its tip pointing down (Rory)
      p.poleR.lerp(neck.clone().add(L(...FIN.pr as [number, number, number])), finW);   // trail arm across the face, elbow forward
      this.rig.apply(p);
    }
    // attack angle: through impact the head's path is tilted to this club's attack angle (down with the wedges, level
    // with a long iron, up with the teed driver) by raising or lowering the hands (and the body with them) a little either side of the ball;
    // nothing at the ball itself, fading out within ~half a metre
    if ((s.phase === 'down' || s.phase === 'follow') && this.aoaFix) {
      const x = g.position.x - this.clubAt.x, dy = this.aoaFix * x * Math.exp(-((x / 0.3) ** 2));
      // (the whole body rides with the hands, on the legs, so the arms keep their shape)
      if (Math.abs(dy) > 1e-5) { g.position.y += dy; p.wristL.y += dy; p.wristR.y += dy; p.pelvis.y += dy; if (headW > 0.001 && this.headAnchor) this.steadyHead(p, headW, headOff[0], headOff[1]); else this.rig.apply(p); }
    }
    // both hands stay on the club: if either arm can't reach its wrist target, move the club (both hands) toward
    // that shoulder (the trail arm used to fall short of the grip in the through-swing)
    // the head stays on the ball: where the lead arm can't reach the grip (late in the downswing and through impact the
    // hands follow the swing circle, and the lead shoulder rises and opens away from it), the body gives (chest squarer to
    // the ball, hips a touch nearer and lower) until the lead shoulder is back over the hands, rather than the club lifting off the ball. (The rig's
    // arms are short for his height, so there is no slack to take up.) Solved exactly (bisection), so it moves smoothly.
    {
      const maxR = (this.rig.len.upper + this.rig.len.fore) * 0.9993, sh = this.rig.P[BONE.upperL];
      const t0 = p.chestTurn, z0 = p.pelvis.z;
      // one smooth give: the chest up to ~20° squarer, the hips up to 5 cm nearer the ball
      const err = (t: number) => { p.chestTurn = t0 - 0.35 * t; p.pelvis.z = z0 + 0.05 * t; this.rig.apply(p); return p.wristL.distanceTo(sh) - maxR; };
      if (s.phase !== 'address' && err(0) > 1e-4) {
        let lo = 0, hi = 2;
        if (err(hi) < 0) { for (let it = 0; it < 12; it++) { const m = (lo + hi) / 2; if (err(m) > 0) lo = m; else hi = m; } }
        err(hi);
      }
    }
    // (the trail shoulder blade reaches first: its joint slides up to 4.5 cm toward the grip)
    for (let pass = 0; pass < 3; pass++) {
      const need = p.wristR.clone().sub(this.rig.wristPos.R);
      if (need.lengthSq() < 1e-7) break;
      p.shoulderR!.add(need.multiplyScalar(1.05)).clampLength(0, 0.045);
      this.rig.apply(p);
    }
    for (let pass = 0; pass < 4; pass++) {
      const miss = this.rig.wristPos.L.clone().sub(p.wristL).addScaledVector(this.rig.wristPos.R.clone().sub(p.wristR), TRAIL_W);
      if (miss.lengthSq() < 1e-7) break;
      g.position.add(miss);
      p.wristL.add(miss); p.wristR.add(miss);
      this.rig.apply(p);
    }
    if (this.extras && this.handFrame) this.poseHands(qc, key.heel);
    this.char.updateMatrixWorld(true);
    return this.club.group.localToWorld(this.clubHeadWorld.set(0, 0, 0));
  }

  // ---- captured swing: the default; ?swing=keyed on the URL (or swingSource = 'keyed') gives the hand-keyed one ----
  swingSource: 'keyed' | 'mocap' = globalThis.location && new URLSearchParams(globalThis.location.search).get('swing') === 'keyed' ? 'keyed' : 'mocap';
  private mocapBusy = false;
  private mocapRef: { key: string; track: Float32Array; addr: { pos: THREE.Vector3; quat: THREE.Quaternion; poleL: THREE.Vector3; poleR: THREE.Vector3 }; imp: { pos: THREE.Vector3; quat: THREE.Quaternion; poleL: THREE.Vector3; poleR: THREE.Vector3 }; look: THREE.Quaternion } | null = null;
  private mocapRow = new Float32Array(64); private mocapRow0 = rowAt(EV.BA);
  /** per club and shot: the hand-keyed address and impact club positions (the captured swing is held to them there, so
   *  the per-club set-up and the strike stay exactly as they are), and the club's orientation along the clip */
  private mocapPrepare() {
    const key = `${this.clubIndex}|${this.mode}|${this.teeH}|${this.club.group.uuid}`;
    if (this.mocapRef?.key === key) return this.mocapRef;
    const g = this.club.group, grab = () => ({ pos: g.position.clone(), quat: g.quaternion.clone(), poleL: this.pose.poleL.clone(), poleR: this.pose.poleR.clone() });
    this.mocapBusy = true;
    this.update({ phase: 'down', phi: 0, topPhi: PHI_TOP, idleT: 0 }); const imp = grab();
    this.update({ phase: 'address', phi: 0, topPhi: PHI_TOP, idleT: 0 }); const addr = grab();
    this.mocapBusy = false;
    const track = buildClubTrack(this.club.shaftDir.clone().negate().normalize(), new THREE.Vector3(1, 0, 0), addr.quat);
    // the eyes: the clip's head direction, turned so that at address it looks at the ball
    const qRigChest = this.rig.Q[BONE.chest].clone(), qClip = clipChest(this.mocapRow0, new THREE.Quaternion());
    const head0 = vec(this.mocapRow0, 'head', new THREE.Vector3()).applyQuaternion(qClip.invert()).applyQuaternion(qRigChest);
    const look = new THREE.Quaternion().setFromUnitVectors(head0, this.ballC.clone().sub(this.headCentre()).normalize());
    return (this.mocapRef = { key, track, addr, imp, look });
  }
  private updateMocap(s: SwingState) {
    const ref = this.mocapPrepare(), st = SHOT_STYLE[this.mode], p = this.pose, g = this.club.group, rig = this.rig;
    const phase = s.phase as 'back' | 'down' | 'follow';
    const { row, t } = sampleSwing(phase, s.phi, s.topPhi, st.finish, this.mocapRow), r0 = this.mocapRow0;
    // around mid-backswing, blend toward the hand-keyed swing at the same hands angle (body, arms and club)
    // ...and at address and through impact: there the keyed swing carries the per-club set-up, the attack angle and the
    // body's reach to the ball, and its club keeps MOVING through the ball (a fixed impact pose made the head stall there)
    const pin = pinWeights(phase, t);
    // ...and into the held finish, which is the keyed one (Rory's: stacked over the lead foot, club wrapped behind the neck)
    const fK = phase === 'follow' ? Math.min(1, -s.phi / Math.abs(PHI_FINISH)) : 0;
    const wK = Math.max(phase === 'back' ? keyedMBWeight(t) : 0, pin.address, pin.impact, smooth(0.5, 0.85, fK));
    let kp: { pose: BodyPose; pos: THREE.Vector3; quat: THREE.Quaternion } | null = null;
    let kToe: THREE.Vector3 | null = null;
    if (wK > 1e-3) {
      this.mocapBusy = true; this.update(s); this.mocapBusy = false;
      const c: any = {}; for (const [k, v] of Object.entries(p)) c[k] = v instanceof THREE.Vector3 ? v.clone() : v;
      kp = { pose: c as BodyPose, pos: g.position.clone(), quat: g.quaternion.clone() }; kToe = this.trailToeFlat.clone();
    }
    const d = (n: string) => num(row, n) - num(r0, n);
    const f = phase === 'follow' ? Math.min(1, -s.phi / Math.abs(PHI_FINISH)) : 0;
    // body: the clip's change from its own address, added to this golfer's address for the club in hand
    p.hipTurn = A.hipTurn + st.open + d('hipTurn'); p.hipTilt = A.hipTilt + d('hipTilt'); p.hipSide = A.hipSide + d('hipSide');
    p.chestTurn = A.chestTurn + st.open * 0.5 + d('chestTurn');
    p.chestTilt = A.chestTilt + this.tiltAdj * (1 - smooth(0.25, 0.9, f)) + d('chestTilt');
    p.chestSide = A.chestSide + this.sideAdj * (1 - smooth(0.1, 0.6, f)) + d('chestSide');
    const leg = rig.len.thigh + rig.len.shin, v = new THREE.Vector3();
    // (the capture's hip travel is large for this body: 20 cm of slide by impact, 30 by the finish and a 13 cm drop put
    // the head 40 cm behind the ball in the downswing; scaled to a tour-like 11 cm at impact, 17 at the finish)
    p.pelvis.copy(this.pelvisBase).add(vec(row, 'pelvis', v).multiplyScalar(leg).multiply(MOCAP_PELVIS));
    p.shrugL = p.shrugR = 0; (p.shoulderR ??= new THREE.Vector3()).set(0, 0, 0);
    const heel = num(row, 'heel');
    this.feet(p, heel, 0, p.hipTurn);
    rig.apply(p);
    // lead knee: along the clip's thigh, facing the way the foot points
    p.kneePoleL.copy(rig.P[BONE.thighL]).addScaledVector(vec(row, 'kneeL', v), 0.5).addScaledVector(v.copy(p.toeL).sub(p.ankleL).setY(0).normalize(), 0.5);
    this.legReach(p);
    // steady head, as in the keyed swing: from address to impact the head stays over its address spot (the spine takes
    // up the hips' slide and drop with a little side and forward bend), released into the follow-through
    const headW = phase === 'follow' ? 1 - smooth(0.04, 0.3, f) : 1;
    if (headW > 0.001 && this.headAnchor) { this.steadyHead(p, headW, 0, 0); this.steadyHead(p, headW, 0, 0); }
    // arms and head are read in the chest's frame, so they stay with this body's chest
    const toRig = rig.Q[BONE.chest].clone().multiply(clipChest(row, new THREE.Quaternion()).invert());
    const dir = (n: string) => vec(row, n, new THREE.Vector3()).applyQuaternion(toRig).normalize();
    const shL = rig.P[BONE.upperL], shR = rig.P[BONE.upperR], arm = rig.len.upper + rig.len.fore;
    // the lead arm stays straight from the takeaway until well after impact (monocular capture under-reads it by a few
    // per cent, which shows as a bent elbow); it folds as captured from a third of the way into the follow-through
    const straight = phase === 'follow' ? 1 - smooth(0.33, 0.5, f) : 1;
    const ext = Math.max(num(row, 'leadExt'), 0.995 * straight);
    const wristL = shL.clone().addScaledVector(dir('leadDir'), Math.min(0.997, ext) * arm);
    // club: shaft as captured, carried by the lead hand; held to the keyed club at address and through impact
    const qc = clubAt(ref.track, t, new THREE.Quaternion());
    g.position.copy(wristL).sub(this.hands.wristLead.clone().applyQuaternion(qc));
    p.poleL.copy(shL).add(dir('leadElbow')); p.poleR.copy(shR).add(dir('trailElbow'));
    // delivery slot: coming down, the trail elbow leads in front of the trail hip (the capture leaves it behind the
    // hip, a depth error of the face-on view); strongest between lead-arm-horizontal and mid-downswing
    if (phase === 'down') {
      const wSlot = smooth(EV.EDA, EV.ED + 0.5 * (EV.MD - EV.ED), t) * (1 - smooth(EV.MD, EV.BI, t));
      if (wSlot > 1e-3) p.poleR.lerp(rig.P[BONE.thighR].clone().add(new THREE.Vector3(0.05, -2.2, 0.4)), wSlot);
    }
    void ref.imp;
    // the blends above move the hands along chords round the lead shoulder, which would bend the lead elbow: put the
    // lead wrist back out at the arm's extension (not at address / impact themselves, where the keyed club is exact)
    {
      const wl = this.hands.wristLead.clone().applyQuaternion(qc).add(g.position), dv = wl.sub(shL), dist = dv.length();
      const want = Math.min(0.997, ext) * arm, wPush = 1 - Math.max(pin.address, pin.impact) ** 4;
      if (dist < want && dist > 1e-4) g.position.addScaledVector(dv, (want / dist - 1) * wPush);
    }
    // the club head never goes below where it sat at address (the takeaway brushes the turf, it doesn't dig): if the
    // captured shaft would put it lower, tip the club up about the lead wrist
    const dig = ref.addr.pos.y - g.position.y;
    if (dig > 1e-4) {
      const grip = this.hands.wristLead.clone().applyQuaternion(qc).add(g.position), armV = g.position.clone().sub(grip), len = armV.length();
      const ax = new THREE.Vector3().crossVectors(armV, new THREE.Vector3(0, 1, 0));
      if (ax.lengthSq() > 1e-8) {
        const ang = Math.asin(Math.min(1, (armV.y + dig) / len)) - Math.asin(Math.max(-1, armV.y / len));
        const qf = new THREE.Quaternion().setFromAxisAngle(ax.normalize(), ang);
        qc.premultiply(qf); g.position.copy(grip).add(armV.applyQuaternion(qf));
      }
    }
    if (kp) {
      const P = p as any, K = kp.pose as any;
      for (const k of Object.keys(K)) {
        if (k === 'wristL' || k === 'wristR' || k === 'look') continue;
        if (typeof K[k] === 'number') P[k] += (K[k] - P[k]) * wK;
        else if (K[k] instanceof THREE.Vector3 && P[k]) P[k].lerp(K[k], wK);
      }
      g.position.lerp(kp.pos, wK); qc.slerp(kp.quat, wK);
      if (kToe) this.trailToeFlat.lerp(kToe, wK).normalize();   // the toes turn with the keyed foot
    }
    g.quaternion.copy(qc);
    p.wristL.copy(this.hands.wristLead).applyQuaternion(qc).add(g.position);
    p.wristR.copy(this.hands.wristTrail).applyQuaternion(qc).add(g.position);
    p.look.copy(this.headCentre()).addScaledVector(dir('head').applyQuaternion(ref.look), 4);
    if (s.lookAt) p.look.copy(this.char.worldToLocal(s.lookAt.clone()));
    rig.apply(p);
    // both hands stay on the club (same as the keyed swing): if an arm can't reach, the club comes to the shoulder
    // (as the keyed swing does: the trail shoulder blade reaches first, sliding up to 4.5 cm toward the grip, so the
    // lead arm isn't bent to bring the club to a short trail arm)
    for (let pass = 0; pass < 3; pass++) {
      const need = p.wristR.clone().sub(rig.wristPos.R);
      if (need.lengthSq() < 1e-7) break;
      p.shoulderR!.add(need.multiplyScalar(1.05)).clampLength(0, 0.045);
      rig.apply(p);
    }
    for (let pass = 0; pass < 4; pass++) {
      const miss = rig.wristPos.L.clone().sub(p.wristL).addScaledVector(rig.wristPos.R.clone().sub(p.wristR), 0.12);
      if (miss.lengthSq() < 1e-7) break;
      g.position.add(miss); p.wristL.add(miss); p.wristR.add(miss);
      rig.apply(p);
    }
    // what's left of a bent lead elbow (the hands held to the keyed club at impact while this body stands a little
    // closer than the keyed one): the body gives, moving back from the hands up to 6 cm, rather than the arm folding
    {
      const want = Math.min(0.997, ext) * arm - 0.0005, base = p.pelvis.clone();
      for (let it = 0; it < 4; it++) {
        const dv = p.wristL.clone().sub(rig.P[BONE.upperL]), lack = want - dv.length();
        if (lack < 5e-4) break;
        p.pelvis.addScaledVector(dv.normalize(), -lack * 1.05);
        if (p.pelvis.distanceTo(base) > 0.06) p.pelvis.sub(base).setLength(0.06).add(base);
        rig.apply(p);
      }
    }
    this.poseHands(qc, heel);
    this.char.updateMatrixWorld(true);
    return this.club.group.localToWorld(this.clubHeadWorld.set(0, 0, 0));
  }

  // ---- idle waggle and intro walk-in ----
  private idleBreath = 0; private idleSway = 0; private wagPhi = 0;
  /** true while the idle waggle has the club off the ball (the HUD can ignore it: swing input always wins) */
  get waggling() { return this.wagPhi > 1e-4; }
  /** the waggle as a hands angle (radians) at idle time t: two small pumps every 6.5 s, the first 2.6 s in; 0 otherwise */
  private wagglePhi(t: number) {
    if (t < 2.6) return 0;
    const c = (t - 2.6) % 6.5;
    if (c < 0.8) return 0.045 * Math.sin(Math.PI * c / 0.8) ** 2;
    if (c < 1.5) return 0.03 * Math.sin(Math.PI * (c - 0.8) / 0.7) ** 2;
    return 0;
  }
  private introT0: number | null = null; private introDur = INTRO_SECONDS; private introDone: (() => void) | null = null;
  /** Start the walk-in on the golfer's own clock: from the intro pose he turns, steps in and settles into the exact
   *  address pose. Keep calling update({ phase: 'address', ... }) each frame as usual (without `intro`); the promise
   *  resolves when he is at address. Scrub by hand instead by passing `intro: 0..1` in the swing state. */
  playIntroToAddress(seconds = INTRO_SECONDS) {
    this.introT0 = performance.now(); this.introDur = Math.max(0.05, seconds);
    return new Promise<void>(res => { this.introDone = res; });
  }
  /** 0..1 while the walk-in started by playIntroToAddress is running, else null */
  get introProgress() { return this.introT0 === null ? null : Math.min(1, (performance.now() - this.introT0) / (this.introDur * 1000)); }
  private introClock() {
    const u = this.introProgress;
    if (u !== null && u >= 1) { this.introT0 = null; this.introDone?.(); this.introDone = null; return null; }
    return u;
  }
  private introSnap: { addr: BodyPose; pos: THREE.Vector3; quat: THREE.Quaternion; toe: THREE.Vector3; stand: BodyPose; pos0: THREE.Vector3; quat0: THREE.Quaternion } | null = null;
  private introPrepare() {
    if (this.introSnap) return this.introSnap;
    const k = this.k, g = this.club.group, J = this.body.skel.joint, T = this.body.skel.tail, V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
    const clone = (q: BodyPose) => { const c: any = {}; for (const [n, v] of Object.entries(q)) c[n] = v instanceof THREE.Vector3 ? v.clone() : v; return c as BodyPose; };
    this.mocapBusy = true; this.update({ phase: 'address', phi: 0, topPhi: PHI_TOP, idleT: 0 }); this.mocapBusy = false;
    const addr = clone(this.pose), pos = g.position.clone(), quat = g.quaternion.clone(), toe = this.trailToeFlat.clone();
    // standing easy: upright, feet close, a step back from the ball and turned a touch toward the camera side
    const st = clone(addr);
    st.pelvis.set(addr.pelvis.x - 0.05 * k, J[BONE.pelvis].y - 0.012 * k, addr.pelvis.z - 0.42 * k);
    st.hipTurn = 0.12; st.hipTilt = 0.02; st.hipSide = 0; st.chestTurn = 0.16; st.chestTilt = 0.05; st.chestSide = 0.02; st.shrugL = st.shrugR = 0;
    st.footUpL = st.footUpR = undefined; st.shoulderR?.set(0, 0, 0);
    const Y = V(0, 1, 0), fL = T[BONE.footL].clone().sub(J[BONE.footL]).setX(0), fR = T[BONE.footR].clone().sub(J[BONE.footR]).setX(0);
    st.ankleL.set(st.pelvis.x + 0.13 * k, J[BONE.footL].y, st.pelvis.z + 0.02 * k); st.ankleR.set(st.pelvis.x - 0.13 * k, J[BONE.footR].y, st.pelvis.z + 0.02 * k);
    st.toeL.copy(st.ankleL).add(fL.applyAxisAngle(Y, 0.24)); st.toeR.copy(st.ankleR).add(fR.applyAxisAngle(Y, -0.2));
    st.kneePoleL.copy(st.ankleL).add(V(0.1, 0.5, 1)); st.kneePoleR.copy(st.ankleR).add(V(-0.1, 0.5, 1));
    st.poleL.copy(st.pelvis).add(V(0.35, -0.2, -0.1)); st.poleR.copy(st.pelvis).add(V(-0.35, -0.2, -0.1));
    // the club stands on the turf in front of him, shaft up to his hands at about belt height (he leans on it)
    const X = V(1, 0, 0), hG = 1.02 * k, gy = (th: number) => this.club.gripLead.clone().applyAxisAngle(X, th).y + this.club.sweetToGround;
    const sgn = gy(0.05) > gy(0) ? 1 : -1;
    let lo = 0, hi = 0.75;
    if (gy(sgn * hi) > hG) for (let it = 0; it < 14; it++) { const m = (lo + hi) / 2; if (gy(sgn * m) > hG) hi = m; else lo = m; }
    const quat0 = new THREE.Quaternion().setFromAxisAngle(X, sgn * hi);
    const gl = this.club.gripLead.clone().applyQuaternion(quat0);
    const pos0 = V(st.pelvis.x + 0.05 * k - gl.x, this.club.sweetToGround, st.pelvis.z + 0.3 * k - gl.z);
    return (this.introSnap = { addr, pos, quat, toe, stand: st, pos0, quat0 });
  }
  /** the walk-in at u (0 = standing, 1 = address): he looks up at the camera, steps in with the lead foot then the trail
   *  foot as the club swings down behind the ball, and bends into his set-up */
  private updateIntro(s: SwingState, u: number) {
    const R = this.introPrepare(), p = this.pose, g = this.club.group, a = R.addr, b = R.stand;
    const e = (x0: number, x1: number) => smooth(x0, x1, u), mix = (x: number, y: number, w: number) => x + (y - x) * w;
    const wP = e(0.08, 0.85), wTurn = e(0.05, 0.6), wBend = e(0.45, 1), sL = e(0.08, 0.45), sR = e(0.42, 0.82), sC = e(0.25, 0.95);
    p.pelvis.lerpVectors(b.pelvis, a.pelvis, wP); p.pelvis.y = mix(b.pelvis.y, a.pelvis.y, wBend) - 0.012 * this.k * (Math.sin(Math.PI * sL) + Math.sin(Math.PI * sR));
    p.hipTurn = mix(b.hipTurn, a.hipTurn, wTurn); p.chestTurn = mix(b.chestTurn, a.chestTurn, wTurn);
    p.hipTilt = mix(b.hipTilt, a.hipTilt, wBend); p.chestTilt = mix(b.chestTilt, a.chestTilt, wBend);
    p.hipSide = mix(b.hipSide, a.hipSide, wBend); p.chestSide = mix(b.chestSide, a.chestSide, wBend);
    p.shrugL = mix(b.shrugL, a.shrugL, wBend); p.shrugR = mix(b.shrugR, a.shrugR, wBend);
    (p.shoulderR ??= new THREE.Vector3()).copy(a.shoulderR ?? p.shoulderR.set(0, 0, 0)).multiplyScalar(e(0.6, 1));
    p.footUpL = p.footUpR = undefined;
    const step = (ank: THREE.Vector3, toe: THREE.Vector3, a0: THREE.Vector3, t0: THREE.Vector3, a1: THREE.Vector3, t1: THREE.Vector3, w: number) => {
      const lift = 0.05 * this.k * Math.sin(Math.PI * w);
      ank.lerpVectors(a0, a1, w); toe.lerpVectors(t0, t1, w); ank.y += lift; toe.y += lift * 0.6;
    };
    step(p.ankleL, p.toeL, b.ankleL, b.toeL, a.ankleL, a.toeL, sL); step(p.ankleR, p.toeR, b.ankleR, b.toeR, a.ankleR, a.toeR, sR);
    p.kneePoleL.lerpVectors(b.kneePoleL, a.kneePoleL.lengthSq() > 1e-6 ? a.kneePoleL : b.kneePoleL.clone().add(a.ankleL).sub(b.ankleL), sL);
    p.kneePoleR.lerpVectors(b.kneePoleR, a.kneePoleR, sR);
    this.trailToeFlat.copy(p.toeR).sub(p.ankleR).setY(0).normalize();
    const qc = R.quat0.clone().slerp(R.quat, sC);
    g.quaternion.copy(qc); g.position.lerpVectors(R.pos0, R.pos, sC); g.position.y += 0.12 * this.k * Math.sin(Math.PI * sC);
    p.wristL.copy(this.hands.wristLead).applyQuaternion(qc).add(g.position);
    p.wristR.copy(this.hands.wristTrail).applyQuaternion(qc).add(g.position);
    p.poleL.lerpVectors(b.poleL, a.poleL, e(0.5, 1)); p.poleR.lerpVectors(b.poleR, a.poleR, e(0.5, 1));
    const cam = s.lookAt ? this.char.worldToLocal(s.lookAt.clone()) : new THREE.Vector3(p.pelvis.x + 0.6, 1.6, p.pelvis.z + 4);
    p.look.copy(cam).lerp(a.look, e(0.3, 0.7));
    this.rig.apply(p);
    // hands stay on the club: the trail shoulder gives a little, then the club comes to the lead hand
    for (let pass = 0; pass < 3; pass++) {
      const miss = this.rig.wristPos.L.clone().sub(p.wristL);
      if (miss.lengthSq() < 1e-7) break;
      g.position.add(miss.multiplyScalar(1 - e(0.9, 1))); p.wristL.copy(this.hands.wristLead).applyQuaternion(qc).add(g.position); p.wristR.copy(this.hands.wristTrail).applyQuaternion(qc).add(g.position);
      this.rig.apply(p);
    }
    if (this.extras && this.handFrame) this.poseHands(qc, 0);
    this.char.updateMatrixWorld(true);
    return this.club.group.localToWorld(this.clubHeadWorld.set(0, 0, 0));
  }

  /** this club's attack angle at impact, degrees (+ = up): driver +3, 3 iron 0, wedges −5 */
  attackAngleDeg() { return attackAngleDeg(this.club.spec); }
  /** slope added to the head's path through impact so it meets the ball at the club's attack angle (set in setupAddress) */
  private aoaFix = 0;
  /** the head's path angle through the ball as posed, degrees (+ = rising) */
  pathAngleDeg() {
    const at = (s: Partial<SwingState>) => { this.update({ phase: 'down', phi: 0, topPhi: PHI_TOP, idleT: 0, ...s }); return this.club.group.position.clone(); };
    const a = at({ phase: 'down', phi: 0.05 }), b = at({ phase: 'follow', phi: -0.05 });
    return THREE.MathUtils.radToDeg(Math.atan2(b.y - a.y, Math.hypot(b.x - a.x, b.z - a.z)));
  }
  /** head centre (char space) after rig.apply: the base of the neck plus an offset up the chest's frame, so it doesn't
   *  depend on where the eyes look */
  headCentre(out = new THREE.Vector3()) { return out.set(0, 0.18, 0).applyQuaternion(this.rig.Q[BONE.chest]).add(this.rig.P[BONE.neck]); }
  private headAnchor: THREE.Vector3 | null = null;
  /** both feet stay on the ground: if a leg can't reach its ankle target (wide driver stance, hips slid and turned in
   *  the finish), lower the pelvis until it can, so the trail foot pivots on the ball of the foot instead of lifting */
  private legAddr = { L: 0, R: 0 };
  /** how far each foot joint ends up from its target after rig.apply (the leg IK clamps when a leg can't reach) */
  private legMiss(p: BodyPose) { return { L: this.rig.P[BONE.footL].distanceTo(p.ankleL), R: this.rig.P[BONE.footR].distanceTo(p.ankleR) }; }
  private legReach(p: BodyPose) {
    for (let it = 0; it < 4; it++) {
      this.rig.apply(p);
      const m = this.legMiss(p), need = Math.max(m.L - this.legAddr.L, m.R - this.legAddr.R);
      if (need < 5e-4) break;
      p.pelvis.y -= need * 1.1;
    }
  }
  /** two Newton steps on (chest side bend, chest forward bend) that put the head centre back over its address spot */
  private steadyHead(p: BodyPose, w: number, offX = 0, offY = 0) {
    const H = new THREE.Vector3(), at = () => { this.rig.apply(p); return this.headCentre(H).clone(); };
    const d = 0.02;
    for (let it = 0; it < 4; it++) {
      const h0 = at();
      const ex = (this.headAnchor!.x + offX - h0.x) * w, ey = (this.headAnchor!.y + offY - h0.y) * w;
      if (Math.abs(ex) + Math.abs(ey) < 0.002) break;
      p.chestSide += d; const hs = at(); p.chestSide -= d;
      p.chestTilt += d; const ht = at(); p.chestTilt -= d;
      const a = (hs.x - h0.x) / d, b = (ht.x - h0.x) / d, c = (hs.y - h0.y) / d, e = (ht.y - h0.y) / d;
      const det = a * e - b * c; if (Math.abs(det) < 1e-6) break;
      p.chestSide += Math.max(-0.3, Math.min(0.3, (e * ex - b * ey) / det));
      p.chestTilt += Math.max(-0.3, Math.min(0.3, (a * ey - c * ex) / det));
    }
  }

  /** hands follow the club, fingers wrap the grip, toes stay flat */
  private poseHands(qc: THREE.Quaternion, _heel: number) {
    const E = this.extras!, F = this.handFrame!, Q = this.rig.Q, bones = this.body.bones;
    const m1 = new THREE.Matrix4(), m2 = new THREE.Matrix4();
    const basis = (dir: THREE.Vector3, hint: THREE.Vector3, out: THREE.Matrix4) => {
      const y = dir.clone().normalize(), z = hint.clone().addScaledVector(y, -hint.dot(y)).normalize(), x = new THREE.Vector3().crossVectors(y, z);
      return out.makeBasis(x, y, z);
    };
    const local = (bi: number, parentQ: THREE.Quaternion, q: THREE.Quaternion) => { bones[bi].quaternion.copy(parentQ.clone().invert().multiply(q)); };
    for (const s of ['L', 'R'] as const) {
      const fore = s === 'L' ? BONE.foreL : BONE.foreR;
      const dir = F[s].dir.clone().applyQuaternion(qc), palm = F[s].palm.clone().applyQuaternion(qc);
      basis(dir, palm, m1); basis(E.handDir[s], E.palm[s], m2);
      const qh = new THREE.Quaternion().setFromRotationMatrix(m1.multiply(m2.transpose()));
      local(E.hand[s], Q[fore], qh);
      // fingers wrap the grip: each segment bends just enough to lie on the grip surface (grip radius + half a
      // finger), so there are no gaps and nothing passes through it, whatever the club or pose. The thumb lies
      // along the grip with a gentle fixed curl.
      const g = this.club.group, axisP = this.club.butt.clone().applyQuaternion(qc).add(g.position), axisD = this.club.shaftDir.clone().applyQuaternion(qc).normalize();
      const fromAxis = (pt: THREE.Vector3) => { const d = pt.clone().sub(axisP); return d.addScaledVector(axisD, -d.dot(axisD)).length(); };
      const b1 = new THREE.Vector3(1, 0, 0).addScaledVector(axisD, -axisD.x).normalize(), b2 = new THREE.Vector3().crossVectors(axisD, b1);
      const angleOf = (pt: THREE.Vector3) => { const d = pt.clone().sub(axisP); return Math.atan2(d.dot(b2), d.dot(b1)); };
      // the mesh's own wrist: its forearm joint plus the hand bone's offset (the mesh forearm can differ from the rig's)
      const handP = this.rig.P[fore].clone().add(bones[E.hand[s]].position.clone().applyQuaternion(Q[fore]));
      (this as any).__handGap = (this as any).__handGap ?? {}; (this as any).__handGap[s] = handP.distanceTo(this.rig.wristPos[s]);
      const gripPt = (s === 'L' ? this.club.gripLead : this.club.gripTrail);
      const rFinger = GRIP_R + 0.0098 * this.k; void gripPt;
      E.fingers[s].forEach((chain, fi) => {
        let parentQ = qh, acc = 0;
        if (fi === 0) {
          // thumb: lies along the grip pointing down it (toward the club head), on its own side of the shaft
          const offs = chain.map(b => bones[b].position.clone());
          const segs = [offs[1], offs[2], offs[2].clone().multiplyScalar(0.8)];
          let P = handP.clone().add(offs[0].clone().applyQuaternion(qh));
          let qPrev = qh.clone();
          chain.forEach((b, si) => {
            const d = P.clone().sub(axisP), along = d.dot(axisD);
            const rv = d.clone().addScaledVector(axisD, -along), rl = rv.length(), radial = rv.normalize();
            // aim the segment's end onto the grip surface: as far down the grip as its length allows
            const rT = s === 'L' ? rFinger - 0.002 : rFinger, len = segs[si].length();
            // (never straight in at the shaft: when the thumb's base is too far out to lay the segment on the grip, it
            // still heads mostly down the grip, closing on it, so the thumb never pokes out sideways)
            const down = Math.max(Math.sqrt(Math.max(0, len * len - (rl - rT) * (rl - rT))), Math.abs(rl - rT) * 1.6);
            const target = axisP.clone().addScaledVector(axisD, along - down).addScaledVector(radial, rT);
            const segW = segs[si].clone().applyQuaternion(qPrev).normalize();
            const q = new THREE.Quaternion().setFromUnitVectors(segW, target.sub(P).normalize()).multiply(qPrev);
            local(b, parentQ, q); parentQ = q; qPrev = q;
            P.add(segs[si].clone().applyQuaternion(q));
          });
          return;
        }
        const offs = chain.map(b => bones[b].position.clone());
        const segs = [offs[1], offs[2], offs[2].clone().multiplyScalar(0.85)];       // the last one: to the fingertip
        let P = handP.clone().add(offs[0].clone().applyQuaternion(qh));
        const axis = E.curlAxis[s], qr = new THREE.Quaternion();
        // fingers lie against each other on a grip (the mesh's bind hand has them spread): turn each one toward the
        // middle finger about the palm normal before it wraps
        const mid0 = bones[E.fingers[s][2][0]].position, across = offs[0].clone().sub(mid0);
        const side = Math.sign(new THREE.Vector3().crossVectors(E.palm[s], E.handDir[s]).dot(across));
        // the hand lies diagonally (in line with the forearm) but the fingers hook straight across the grip, as a real
        // hand's do (they flex obliquely): turn each finger, in the palm plane, until it points across the shaft
        const shaftB = axisD.clone().applyQuaternion(qh.clone().invert());
        const xShaft = new THREE.Vector3().crossVectors(E.palm[s], shaftB).normalize();
        if (xShaft.dot(E.handDir[s]) < 0) xShaft.negate();
        const hdP = E.handDir[s].clone().addScaledVector(E.palm[s], -E.handDir[s].dot(E.palm[s])).normalize();
        const turn = Math.atan2(new THREE.Vector3().crossVectors(hdP, xShaft).dot(E.palm[s]), hdP.dot(xShaft));
        const qSpread = new THREE.Quaternion().setFromAxisAngle(E.palm[s], turn - side * [0, 0.1, 0, 0.06, 0.12][fi]);
        const qhs = qh.clone().multiply(qSpread);
        // which way round the grip these fingers wrap: the way the hand points from its knuckles
        const handDirW = E.handDir[s].clone().applyQuaternion(qh), radP = P.clone().sub(axisP).addScaledVector(axisD, -P.clone().sub(axisP).dot(axisD));
        const wrapSign = Math.sign(new THREE.Vector3().crossVectors(radP, handDirW).dot(axisD)) || 1;
        // traced finger shape (MediaPipe hand landmarks on real grips): keep each finger's MCP/PIP/DIP ratios and fit
        // only an MCP offset and an overall scale so the whole finger lies on the grip, wrapping forward round it
        const base = GRIP_CURL[fi];
        const pose = (d: number, sc: number, out?: THREE.Quaternion[]) => {
          let Pp = P.clone(), a = 0, err = 0, angPrev = angleOf(Pp);
          for (let si = 0; si < 3; si++) {
            a += si === 0 ? base[0] + d : base[si] * sc;
            const q = qhs.clone().multiply(qr.setFromAxisAngle(axis, a));
            out?.push(q.clone());
            const end = Pp.clone().add(segs[si].clone().applyQuaternion(q));
            let adv = (angleOf(end) - angPrev) * wrapSign; adv = Math.atan2(Math.sin(adv), Math.cos(adv));
            const r = fromAxis(end);
            err += Math.max(0, rFinger - r) * 3 + Math.max(0, r - rFinger) + (adv < 0.05 ? 0.03 + (0.05 - adv) * 0.1 : 0);
            Pp = end; angPrev = angleOf(end);
          }
          return err;
        };
        let bd = 0, bs = 1, be = Infinity;
        for (let d = -0.5; d <= 1.0; d += 0.04) for (let sc = 0.6; sc <= 1.45; sc += 0.05) { const e = pose(d, sc); if (e < be) { be = e; bd = d; bs = sc; } }
        const qs: THREE.Quaternion[] = []; pose(bd, bs, qs);
        chain.forEach((b, si) => { local(b, parentQ, qs[si]); parentQ = qs[si]; });
        void acc;
      });
    }
    // toes stay flat on the ground when the heel comes up: the toe bone keeps the foot's bind pitch (as at address)
    // and only follows its turn about the vertical
    const S = this.body.skel, flatQ = (fb: number, dir: THREE.Vector3) => {
      const bind = S.tail[fb].clone().sub(S.joint[fb]).setY(0).normalize();
      return new THREE.Quaternion().setFromUnitVectors(bind, dir.clone().setY(0).normalize());
    };
    local(E.ball.L, Q[BONE.footL], flatQ(BONE.footL, new THREE.Vector3(0, 0, 0).add(S.tail[BONE.footL]).sub(S.joint[BONE.footL]).applyQuaternion(Q[BONE.footL])));
    local(E.ball.R, Q[BONE.footR], flatQ(BONE.footR, this.trailToeFlat));
  }
}
