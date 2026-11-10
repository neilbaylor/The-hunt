// Plays the captured swing (swingclip.ts: real 3D motion recovered from video) on the golfer's rig.
// The clip is proportion-free (angles, unit directions, ratios), so this file only samples it and maps the game's
// swing state (phase + hands angle) onto the clip's timeline. Golfer.updateMocap() turns a sampled row into a pose.
//
// Timeline: the clip is keyed at the 12 swing events of Haddas et al. plus the finish —
//   BA breakaway (address) · MB mid-backswing · LBA lead arm horizontal · LB late backswing · EPR pre-top ·
//   TB top · EDA early downswing A · ED lead arm horizontal coming down · MD mid-downswing · BI ball impact ·
//   MF mid-follow-through · LF lead arm horizontal after impact · FIN finish.
import * as THREE from 'three';
import { SWING_CLIP as C } from './swingclip';

export const SWING_EVENTS = ['BA', 'MB', 'LBA', 'LB', 'EPR', 'TB', 'EDA', 'ED', 'MD', 'BI', 'MF', 'LF', 'FIN'] as const;
export type SwingEvent = typeof SWING_EVENTS[number];
export const EV = C.events;
const N = C.frames, S = C.stride, D = C.data, LAY = C.layout;
const PHI_TOP = 2.6, PHI_FINISH = 3.2;
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** unit-direction channels (re-normalised after interpolation) */
const DIRS = Object.keys(LAY).filter(n => LAY[n][1] === 3 && n !== 'pelvis');

/** one row of the clip at a fractional frame (Catmull-Rom through the frames) */
export function rowAt(t: number, out = new Float32Array(S)) {
  t = Math.min(N - 1, Math.max(0, t));
  const i = Math.min(N - 2, Math.floor(t)), u = t - i, u2 = u * u, u3 = u2 * u;
  const a = Math.max(0, i - 1) * S, b = i * S, c = (i + 1) * S, d = Math.min(N - 1, i + 2) * S;
  const w0 = -0.5 * u3 + u2 - 0.5 * u, w1 = 1.5 * u3 - 2.5 * u2 + 1, w2 = -1.5 * u3 + 2 * u2 + 0.5 * u, w3 = 0.5 * u3 - 0.5 * u2;
  for (let k = 0; k < S; k++) out[k] = w0 * D[a + k] + w1 * D[b + k] + w2 * D[c + k] + w3 * D[d + k];
  for (const n of DIRS) {
    const o = LAY[n][0], l = Math.hypot(out[o], out[o + 1], out[o + 2]) || 1;
    out[o] /= l; out[o + 1] /= l; out[o + 2] /= l;
  }
  return out;
}
export const num = (row: Float32Array, name: string) => row[LAY[name][0]];
export const vec = (row: Float32Array, name: string, out: THREE.Vector3) => { const o = LAY[name][0]; return out.set(row[o], row[o + 1], row[o + 2]); };

// lead-arm angle along the clip (it rises to the top, falls to impact, keeps falling to the finish): the game's hands
// angle maps onto it, so a given fraction of the backswing shows the frame where the lead arm is that far round
const ANG = Array.from({ length: N }, (_, i) => D[i * S + LAY.armAngle[0]]);
const angAt = (t: number) => { const i = Math.min(N - 2, Math.max(0, Math.floor(t))); return ANG[i] + (ANG[i + 1] - ANG[i]) * (t - i); };
function frameAtAngle(t0: number, t1: number, a: number) {
  let lo = t0, hi = t1; const rising = angAt(t1) > angAt(t0);
  for (let it = 0; it < 24; it++) { const m = (lo + hi) / 2; if ((angAt(m) < a) === rising) lo = m; else hi = m; }
  return (lo + hi) / 2;
}
const A_BA = angAt(EV.BA), A_TB = angAt(EV.TB), A_BI = angAt(EV.BI), A_FIN = angAt(EV.FIN);

const _r1 = new Float32Array(S);
/** the clip row for a swing state; t is the clip frame it came from (the downswing's, when two are blended) */
export function sampleSwing(phase: 'back' | 'down' | 'follow', phi: number, topPhi: number, finish: number, out = new Float32Array(S)) {
  let t: number;
  if (phase === 'back') {
    t = frameAtAngle(EV.BA, EV.TB, A_BA + Math.min(1, Math.max(0, phi / PHI_TOP)) * (A_TB - A_BA));
    rowAt(t, out);
  } else if (phase === 'down') {
    const a = Math.min(1, Math.max(0, phi / PHI_TOP));
    t = frameAtAngle(EV.TB, EV.BI, A_BI + a * (A_TB - A_BI));
    rowAt(t, out);
    // a short backswing turns round part-way up: start from the backswing's pose at that height and ease into the downswing's
    const w = topPhi < 0.97 * PHI_TOP ? 1 - smooth(0, 0.35, 1 - Math.max(0, phi) / Math.max(0.01, topPhi)) : 0;
    if (w > 1e-3) {
      rowAt(frameAtAngle(EV.BA, EV.TB, A_BA + a * (A_TB - A_BA)), _r1);
      for (let k = 0; k < S; k++) out[k] += (_r1[k] - out[k]) * w;
      for (const n of DIRS) { const o = LAY[n][0], l = Math.hypot(out[o], out[o + 1], out[o + 2]) || 1; out[o] /= l; out[o + 1] /= l; out[o + 2] /= l; }
    }
  } else {
    const f = Math.min(1, Math.max(0, -phi / PHI_FINISH)) * finish;
    t = frameAtAngle(EV.BI, EV.FIN, A_BI + f * (A_FIN - A_BI));
    rowAt(t, out);
  }
  return { row: out, t };
}

/** how strongly the club is held to the game's own address / impact club position at clip frame t */
export function pinWeights(phase: 'back' | 'down' | 'follow', t: number) {
  const address = phase === 'back' ? 1 - smooth(EV.BA, EV.MB, t) : 0;
  const impact = phase === 'down' ? smooth(EV.MD, EV.BI, t) ** 2 : phase === 'follow' ? 1 - smooth(EV.BI, EV.BI + 0.6 * (EV.MF - EV.BI), t) : 0;
  return { address, impact };
}

/** the chest's orientation in the clip at a row (same convention as the rig: Rz(side)·Rx(tilt)·Ry(turn)) */
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1), _q = new THREE.Quaternion();
export function clipChest(row: Float32Array, out: THREE.Quaternion) {
  return out.setFromAxisAngle(Z, num(row, 'chestSide')).multiply(_q.setFromAxisAngle(X, num(row, 'chestTilt'))).multiply(_q.setFromAxisAngle(Y, num(row, 'chestTurn')));
}

export const CLUB_SUB = 6;
/**
 * The club's orientation along the clip for one club: the shaft follows the clip's shaft direction; its roll about the
 * shaft (which the video can't show) is whatever lets the lead hand continue the lead forearm and puts the trail
 * wrist where the clip has it. Carried from sample to sample without twisting, then nudged, so it never flips.
 * All inputs are in the club's own space. Returns quaternions (xyzw) at CLUB_SUB samples per clip frame.
 */
export function buildClubTrack(headDir: THREE.Vector3, leadHandDir: THREE.Vector3, wristLead: THREE.Vector3, wristTrail: THREE.Vector3) {
  const M = (N - 1) * CLUB_SUB + 1, out = new Float32Array(M * 4);
  const row = new Float32Array(S), d = new THREE.Vector3(), prevD = new THREE.Vector3(), q = new THREE.Quaternion(), qt = new THREE.Quaternion(), qr = new THREE.Quaternion();
  const fore = new THREE.Vector3(), line = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), v = new THREE.Vector3();
  const handLine = wristTrail.clone().sub(wristLead).normalize();
  const score = (qq: THREE.Quaternion) => v.copy(leadHandDir).applyQuaternion(qq).dot(fore) + 0.4 * v.copy(handLine).applyQuaternion(qq).dot(line);
  for (let i = 0; i < M; i++) {
    rowAt(i / CLUB_SUB, row);
    vec(row, 'shaft', d);
    // lead forearm (elbow → wrist) and the line between the wrists, from the clip's arm directions
    vec(row, 'leadDir', a).multiplyScalar(num(row, 'leadExt')); vec(row, 'leadElbow', b).multiplyScalar(0.52);
    fore.copy(a).sub(b).normalize(); vec(row, 'wristLine', line);
    let span: number, step: number;
    if (i === 0) { q.setFromUnitVectors(headDir, d); span = Math.PI; step = Math.PI / 36; }
    else { q.premultiply(qt.setFromUnitVectors(prevD, d)); span = 0.35; step = 0.05; }
    let best = -Infinity, bestA = 0;
    for (let th = -span; th <= span + 1e-6; th += step) { const sc = score(qt.copy(q).premultiply(qr.setFromAxisAngle(d, th))); if (sc > best) { best = sc; bestA = th; } }
    q.premultiply(qr.setFromAxisAngle(d, i === 0 ? bestA : bestA * 0.5)).normalize();
    prevD.copy(d);
    out[i * 4] = q.x; out[i * 4 + 1] = q.y; out[i * 4 + 2] = q.z; out[i * 4 + 3] = q.w;
  }
  return out;
}
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
export function clubAt(track: Float32Array, t: number, out: THREE.Quaternion) {
  const x = Math.min(N - 1, Math.max(0, t)) * CLUB_SUB, i = Math.min((N - 1) * CLUB_SUB - 1, Math.floor(x));
  _qa.fromArray(track as unknown as number[], i * 4); _qb.fromArray(track as unknown as number[], i * 4 + 4);
  return out.copy(_qa).slerp(_qb, x - i);
}
