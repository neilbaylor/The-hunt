// Builds a golfer's body from a profile: a skeleton, skinned meshes (hoodie, pants, neck) lofted along
// the bones, a sculpted head with a painted face, a hair shell, ears and shoes. Everything is generated
// in code so the game ships as one file and every friend can be built from a profile.
//
// Character space: the body faces +Z, its left is +X, Y up, feet on y = 0. All bones have identity
// orientation in the bind pose, so a pose is just a rig-space rotation per bone (see rig.ts).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GolferProfile } from './profile';
import { buildVisor } from './headwear';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const gauss = (x: number) => Math.exp(-x * x);

export const BONE = {
  root: 0, pelvis: 1, spine1: 2, chest: 3, neck: 4, head: 5,
  clavL: 6, upperL: 7, foreL: 8, clavR: 9, upperR: 10, foreR: 11,
  thighL: 12, shinL: 13, footL: 14, thighR: 15, shinR: 16, footR: 17,
} as const;
export const PARENT = [-1, 0, 1, 2, 3, 4, 3, 6, 7, 3, 9, 10, 1, 12, 13, 1, 15, 16];
export const BONE_COUNT = PARENT.length;

export interface Skeleton {
  /** bind position of each bone's joint (char space) */
  joint: THREE.Vector3[];
  /** bind position of each bone's tail (the next joint along the limb) */
  tail: THREE.Vector3[];
  headCenter: THREE.Vector3;
  eye: THREE.Vector3; // midpoint between the eyes (bind)
}

/** Joint layout for a person of the given height/weight. Reference proportions are a 1.905 m man. */
export function skeletonFor(p: GolferProfile): Skeleton {
  const k = p.heightM / 1.905;
  const bmi = p.weightKg / (p.heightM * p.heightM);
  const wide = 0.94 + 0.06 * (bmi / 22.5); // shoulders/hips scale a little with build
  const j = (x: number, y: number, z: number) => V(x * k * wide, y * k, z * k);
  const sym = (v: THREE.Vector3) => V(-v.x, v.y, v.z);
  const shoulderL = j(0.2, 1.522, -0.012), elbowL = j(0.238, 1.19, -0.03), wristL = j(0.262, 0.918, 0.0);
  const hipL = j(0.094, 0.975, 0), kneeL = j(0.1, 0.53, 0.016), ankleL = j(0.104, 0.09, -0.012), toeL = j(0.11, 0.022, 0.17);
  const joint = [
    V(0, 0, 0), j(0, 1.0, 0), j(0, 1.13, -0.006), j(0, 1.3, 0), j(0, 1.575, -0.014), j(0, 1.66, -0.004),
    j(0.026, 1.522, 0.004), shoulderL, elbowL, j(-0.026, 1.522, 0.004), sym(shoulderL), sym(elbowL),
    hipL, kneeL, ankleL, sym(hipL), sym(kneeL), sym(ankleL),
  ];
  const tail = [
    joint[1], joint[2], joint[3], joint[4], joint[5], j(0, 1.9, 0.01),
    shoulderL, elbowL, wristL, sym(shoulderL), sym(elbowL), sym(wristL),
    kneeL, ankleL, toeL, sym(kneeL), sym(ankleL), sym(toeL),
  ];
  return { joint, tail, headCenter: j(0, 1.762, 0.016), eye: j(0, 1.78, 0.092) };
}

// ───────────────────────── loft: rings along a path → skinned tube ─────────────────────────
interface Ring {
  c: THREE.Vector3; rx: number; rz: number;
  zo?: number; xo?: number;     // centre offsets (forward / sideways)
  w: [number, number][];        // [bone, weight]
  shade?: number;               // vertex colour multiplier
  p?: number;                   // superellipse exponent (2 = ellipse, higher = boxier)
}
function loft(rings: Ring[], seg: number, fwdHint: THREE.Vector3, caps: [boolean, boolean]): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], si: number[] = [], sw: number[] = [], col: number[] = [], idx: number[] = [];
  const n = rings.length, cols = seg + 1;
  const t = new THREE.Vector3(), fwd = new THREE.Vector3(), side = new THREE.Vector3();
  const pushSkin = (w: [number, number][]) => {
    const ws = w.slice(0, 4); const sum = ws.reduce((a, b) => a + b[1], 0);
    for (let q = 0; q < 4; q++) { si.push(ws[q] ? ws[q][0] : 0); sw.push(ws[q] ? ws[q][1] / sum : 0); }
  };
  for (let i = 0; i < n; i++) {
    const r = rings[i];
    t.subVectors(rings[Math.min(n - 1, i + 1)].c, rings[Math.max(0, i - 1)].c).normalize();
    fwd.copy(fwdHint).addScaledVector(t, -fwdHint.dot(t)).normalize();
    side.crossVectors(t, fwd).normalize();
    const p = r.p ?? 2;
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2, cs = Math.cos(a), sn = Math.sin(a);
      const ex = Math.sign(cs) * Math.pow(Math.abs(cs), 2 / p), ez = Math.sign(sn) * Math.pow(Math.abs(sn), 2 / p);
      pos.push(
        r.c.x + side.x * (r.rx * ex + (r.xo ?? 0)) + fwd.x * (r.rz * ez + (r.zo ?? 0)),
        r.c.y + side.y * (r.rx * ex + (r.xo ?? 0)) + fwd.y * (r.rz * ez + (r.zo ?? 0)),
        r.c.z + side.z * (r.rx * ex + (r.xo ?? 0)) + fwd.z * (r.rz * ez + (r.zo ?? 0)));
      uv.push(j / seg, i / (n - 1));
      pushSkin(r.w);
      const s = r.shade ?? 1; col.push(s, s, s);
    }
  }
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < seg; j++) {
    const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const cap = (ri: number, flip: boolean) => {
    const r = rings[ri], base = pos.length / 3;
    let cx = 0, cy = 0, cz = 0; for (let j = 0; j < seg; j++) { cx += pos[(ri * cols + j) * 3]; cy += pos[(ri * cols + j) * 3 + 1]; cz += pos[(ri * cols + j) * 3 + 2]; }
    pos.push(cx / seg, cy / seg, cz / seg); uv.push(0.5, ri / (n - 1)); pushSkin(r.w); const s = r.shade ?? 1; col.push(s, s, s);
    for (let j = 0; j < seg; j++) { const a = ri * cols + j, b = a + 1; if (flip) idx.push(base, b, a); else idx.push(base, a, b); }
  };
  if (caps[0]) cap(0, false);
  if (caps[1]) cap(n - 1, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // weld the u-seam normals so the tube is smooth all the way round
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < n; i++) {
    const a = i * cols, b = a + seg;
    const x = nrm.getX(a) + nrm.getX(b), y = nrm.getY(a) + nrm.getY(b), z = nrm.getZ(a) + nrm.getZ(b), l = Math.hypot(x, y, z) || 1;
    nrm.setXYZ(a, x / l, y / l, z / l); nrm.setXYZ(b, x / l, y / l, z / l);
  }
  return g;
}

/** Rings along a chain of joints with smooth weight blends across each joint. */
function limbRings(points: THREE.Vector3[], bones: number[], samples: { t: number; rx: number; rz?: number; zo?: number; shade?: number }[], blend = 0.18, startBone?: number): Ring[] {
  // t is measured in "segments": 0..1 along first bone, 1..2 along second, negative = before the first joint
  return samples.map(s => {
    const seg = Math.max(0, Math.min(points.length - 2, Math.floor(s.t)));
    const f = s.t - seg;
    const c = new THREE.Vector3().lerpVectors(points[seg], points[seg + 1], f);
    const w: [number, number][] = [];
    // blend between bones near joints
    const nearJoint = Math.round(s.t);
    const d = s.t - nearJoint;
    if (nearJoint >= 1 && nearJoint <= bones.length - 1 && Math.abs(d) < blend) {
      const k = 0.5 + 0.5 * (d / blend);
      w.push([bones[nearJoint - 1], 1 - k], [bones[nearJoint], k]);
    } else if (s.t < blend && startBone !== undefined) {
      const k = Math.max(0, Math.min(1, 0.5 + 0.5 * (s.t / blend)));
      w.push([startBone, 1 - k], [bones[0], k]);
    } else w.push([bones[Math.min(bones.length - 1, seg)], 1]);
    return { c, rx: s.rx, rz: s.rz ?? s.rx, zo: s.zo, w, shade: s.shade };
  });
}

// ───────────────────────── textures ─────────────────────────
function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, srgb = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
let seed = 1;
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

function heatherTexture(base: string) {
  return canvasTex(256, 256, g => {
    g.fillStyle = base; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 9000; i++) {
      const v = rand();
      g.fillStyle = v < 0.5 ? `rgba(255,255,255,${0.05 + rand() * 0.09})` : `rgba(40,40,45,${0.04 + rand() * 0.08})`;
      g.fillRect(rand() * 256, rand() * 256, 1 + rand() * 2.5, 1);
    }
  });
}
function knitNormal() {
  return canvasTex(128, 128, g => {
    g.fillStyle = 'rgb(128,128,255)'; g.fillRect(0, 0, 128, 128);
    for (let y = 0; y < 128; y += 4) for (let x = 0; x < 128; x += 4) {
      g.fillStyle = 'rgba(160,128,255,.5)'; g.fillRect(x, y, 2, 3);
      g.fillStyle = 'rgba(96,128,255,.5)'; g.fillRect(x + 2, y, 2, 3);
    }
  }, false);
}

// ───────────────────────── head ─────────────────────────
/** average normals of vertices that share a position (uv seams), so seams don't shade */
function weldNormals(g: THREE.BufferGeometry) {
  const p = g.getAttribute('position') as THREE.BufferAttribute, n = g.getAttribute('normal') as THREE.BufferAttribute;
  const map = new Map<string, number[]>();
  for (let i = 0; i < p.count; i++) { const key = `${Math.round(p.getX(i) * 1e5)},${Math.round(p.getY(i) * 1e5)},${Math.round(p.getZ(i) * 1e5)}`; const a = map.get(key); if (a) a.push(i); else map.set(key, [i]); }
  for (const ids of map.values()) {
    if (ids.length < 2) continue;
    let x = 0, y = 0, z = 0; for (const i of ids) { x += n.getX(i); y += n.getY(i); z += n.getZ(i); }
    const l = Math.hypot(x, y, z) || 1; for (const i of ids) n.setXYZ(i, x / l, y / l, z / l);
  }
}

interface HeadParts { head: THREE.Mesh; hair: THREE.Mesh; ears: THREE.Mesh; setSmile: (v: number) => void }

/** Unit-sphere direction of a facial feature → texture coordinates used by the face map. */
const faceUV = (x: number, y: number) => { const z = Math.sqrt(Math.max(0, 1 - x * x - y * y)); return [0.5 + Math.atan2(x, z) / (2 * Math.PI), 0.5 + Math.asin(y) / Math.PI]; };

function sculpt(x: number, y: number, z: number, L: GolferProfile['look'], out: THREE.Vector3, smile = 0) {
  const fl = L.faceLength;
  let px = x * 0.0745, py = y * 0.118 * fl, pz = z * 0.099;
  const front = smooth(0.15, 0.7, z), back = smooth(0.05, -0.6, z);
  // jaw and chin: narrower low down, but keep the angle of the jaw
  const low = smooth(-0.1, -1.0, y);
  const jawAngle = gauss((y + 0.6) / 0.26) * smooth(0.85, 0.0, z) * 0.32;
  px *= 1 - 0.22 * low + jawAngle * low;
  pz += 0.003 * gauss((y + 0.8) / 0.12) * gauss(x / 0.5) * smooth(0.2, 0.7, z); // fuller chin
  pz *= 1 - 0.1 * low * back;
  // chin forward, flat face plane
  pz += 0.006 * gauss((y + 0.86) / 0.13) * gauss(x / 0.35) * front;
  pz = THREE.MathUtils.lerp(pz, pz * 0.94 + 0.004, front * smooth(-0.9, 0.4, y) * 0.8);
  // cranium: slight crown, full back of head, nape pulls in
  py += 0.004 * smooth(0.6, 1, y);
  pz -= 0.009 * back * gauss((y - 0.05) / 0.45);
  const nape = smooth(-0.35, -0.95, y) * back;
  pz *= 1 - 0.4 * nape; px *= 1 - 0.18 * nape;
  // temples slightly flat
  px *= 1 - 0.04 * gauss((y - 0.35) / 0.2) * gauss(z / 0.6);
  if (z > 0) {
    const fz = (dz: number) => { pz += dz * front; };
    // eye sockets and brow ridge
    for (const s of [-1, 1]) {
      fz(-0.0085 * gauss((x - s * 0.36) / 0.17) * gauss((y - 0.06) / 0.11));
      fz(0.0035 * gauss((x - s * 0.53) / 0.16) * gauss((y + 0.08) / 0.14)); // cheekbones
      fz(0.003 * gauss((x - s * 0.13) / 0.06) * gauss((y + 0.32) / 0.06)); // nostril wings
      fz(-0.002 * gauss((x - s * 0.3) / 0.05) * gauss((y + 0.52) / 0.06)); // mouth corners
    }
    fz(0.0042 * gauss((y - 0.23) / 0.07) * gauss(x / 0.52));
    fz(-0.002 * gauss((y - 0.14) / 0.05) * gauss(x / 0.12)); // between the brows
    // nose: bridge → tip, a strong straight nose
    const nn = L.nose;
    let nh = 0;
    if (y < 0.16 && y > -0.42) {
      nh = y > -0.27 ? THREE.MathUtils.lerp(0.024, 0.006, smooth(-0.27, 0.15, y)) : 0.024 * smooth(-0.42, -0.27, y);
    }
    const nw = 0.075 + 0.09 * smooth(-0.05, -0.32, y);
    fz(nn * nh * gauss(x / nw));
    // lips and philtrum
    fz(0.0042 * gauss((y + 0.465) / 0.045) * gauss(x / 0.27));
    fz(0.0045 * gauss((y + 0.575) / 0.05) * gauss(x / 0.25));
    fz(-0.0032 * gauss((y + 0.522) / 0.016) * gauss(x / 0.3));
    fz(-0.0018 * gauss((y + 0.68) / 0.06) * gauss(x / 0.3)); // under the lower lip
    if (smile > 0) {
      for (const s of [-1, 1]) {
        const corner = gauss((x - s * 0.31) / 0.1) * gauss((y + 0.52) / 0.08) * front;
        py += 0.0042 * smile * corner; pz -= 0.0022 * smile * corner; px += s * 0.0018 * smile * corner; // corners up and back
        const cheek = gauss((x - s * 0.46) / 0.17) * gauss((y + 0.24) / 0.16) * front;
        py += 0.0024 * smile * cheek; pz += 0.0024 * smile * cheek;                                      // apple of the cheek rises
        py += 0.0012 * smile * gauss((x - s * 0.36) / 0.12) * gauss((y + 0.03) / 0.05) * front;       // lower lid lifts: smiling eyes
      }
      py -= 0.0016 * smile * gauss(x / 0.22) * gauss((y + 0.6) / 0.07) * front;                       // lower lip drops a touch
    }
  }
  out.set(px, py, pz);
}

function hairElevation(az: number, hairline: number) {
  // threshold elevation (radians) above which there is hair, by |azimuth| (0 = front, PI = back)
  const a = Math.abs(az);
  const keys: [number, number][] = [[0, 0.5 + 0.18 * hairline], [0.4, 0.52 + 0.2 * hairline], [0.72, 0.6 + 0.26 * hairline], [1.0, 0.42], [1.2, 0.1], [1.3, -0.12], [1.42, 0.2], [1.62, 0.22], [1.85, -0.05], [2.3, -0.5], [Math.PI, -0.6]];
  for (let i = 1; i < keys.length; i++) if (a <= keys[i][0]) { const [a0, e0] = keys[i - 1], [a1, e1] = keys[i]; return e0 + (e1 - e0) * smooth(a0, a1, a); }
  return -0.6;
}

function faceTexture(L: GolferProfile['look'], smile = false) {
  const W = 2048, H = 1024;
  seed = 11;
  return canvasTex(W, H, g => {
    const P = (x: number, y: number) => { const [u, v] = faceUV(x, y); return [u * W, (1 - v) * H]; };
    const scaleX = W / (2 * Math.PI) * 1.02, scaleY = H / Math.PI * 1.0; // unit sphere → px near the front
    g.fillStyle = L.skin; g.fillRect(0, 0, W, H);
    // gentle tone variation + pores
    for (let i = 0; i < 26000; i++) { g.fillStyle = rand() < 0.5 ? 'rgba(120,60,40,.035)' : 'rgba(255,230,210,.04)'; const r = 1 + rand() * 3; g.beginPath(); g.arc(rand() * W, rand() * H, r, 0, 7); g.fill(); }
    const blush = (x: number, y: number, rx: number, ry: number, col: string, a: number) => {
      const [cx, cy] = P(x, y); const gr = g.createRadialGradient(cx, cy, 0, cx, cy, rx * scaleX);
      gr.addColorStop(0, col.replace(')', `,${a})`).replace('rgb', 'rgba')); gr.addColorStop(1, col.replace(')', ',0)').replace('rgb', 'rgba'));
      g.save(); g.translate(cx, cy); g.scale(1, ry / rx); g.translate(-cx, -cy); g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, rx * scaleX, 0, 7); g.fill(); g.restore();
    };
    const warm = new THREE.Color(L.skinWarm), wc = `rgb(${Math.round(warm.r * 255)},${Math.round(warm.g * 255)},${Math.round(warm.b * 255)})`;
    blush(-0.5, -0.18, 0.26, 0.18, wc, smile ? 0.24 : 0.16); blush(0.5, -0.18, 0.26, 0.18, wc, smile ? 0.24 : 0.16);
    blush(0, -0.22, 0.09, 0.09, wc, 0.22); blush(0, 0.42, 0.4, 0.14, wc, 0.08);
    // ears are on the sides
    for (const s of [-1, 1]) { const cx = (0.5 + s * 0.25) * W, cy = 0.52 * H; const gr = g.createRadialGradient(cx, cy, 0, cx, cy, 70); gr.addColorStop(0, wc.replace(')', ',.45)').replace('rgb', 'rgba')); gr.addColorStop(1, wc.replace(')', ',0)').replace('rgb', 'rgba')); g.fillStyle = gr; g.fillRect(cx - 80, cy - 80, 160, 160); }
    // under-eye and socket shading
    for (const s of [-1, 1]) { blush(s * 0.36, -0.03, 0.15, 0.06, 'rgb(110,70,70)', 0.16); blush(s * 0.36, 0.13, 0.15, 0.05, 'rgb(120,80,70)', 0.14); }
    // stubble
    const hc = new THREE.Color(L.hair);
    for (const [bx, by, rx, ry, a] of [[0, -0.72, 0.62, 0.32, 0.2], [0, -0.42, 0.22, 0.06, 0.14], [-0.55, -0.45, 0.22, 0.3, 0.16], [0.55, -0.45, 0.22, 0.3, 0.16]] as number[][])
      blush(bx, by, rx, ry, `rgb(${Math.round(hc.r * 255 + 40)},${Math.round(hc.g * 255 + 35)},${Math.round(hc.b * 255 + 30)})`, a * L.stubble);
    for (let i = 0; i < 70000 * L.stubble; i++) {
      const x = (rand() * 2 - 1) * 0.95, y = -0.25 - rand() * 0.75;
      const zz = 1 - x * x - y * y; if (zz < 0.02) continue;
      // mask: jaw, chin, upper lip, lower cheeks; not on the lips or nose
      let m = smooth(-0.2, -0.5, y) * (0.25 + 0.75 * smooth(0.12, 0.3, Math.abs(x) + Math.max(0, -0.4 - y)));
      m *= 1 - 0.95 * gauss((y + 0.52) / 0.07) * gauss(x / 0.28); // not on the lips
      if (y > -0.44) m *= smooth(0.12, 0.3, Math.abs(x)); // upper lip / nose base
      m *= smooth(0.95, 0.75, Math.abs(x));
      if (rand() > m) continue;
      const [px, py] = P(x, y);
      g.fillStyle = `rgba(${Math.round(hc.r * 255)},${Math.round(hc.g * 255)},${Math.round(hc.b * 255)},${0.12 + rand() * 0.22})`;
      g.fillRect(px, py, 1 + rand(), 1 + rand() * 1.2);
    }
    // short hair painted under the hair shell edge so the hairline is soft
    for (let i = 0; i < 160000; i++) {
      const u = rand(), v = rand(); const az = (u - 0.5) * 2 * Math.PI, el = (v - 0.5) * Math.PI;
      const e = hairElevation(az, L.hairline);
      const d = el - (e + 0.01);
      if (d < 0) { if (rand() > Math.max(0, 1 + d / 0.035) * 0.8) continue; }
      g.fillStyle = `rgba(${Math.round(hc.r * 255)},${Math.round(hc.g * 255)},${Math.round(hc.b * 255)},${d < 0 ? 0.35 + rand() * 0.35 : 0.85})`;
      g.fillRect(u * W, (1 - v) * H, 1.5 + rand() * 2, 2 + rand() * 3);
    }
    // lips
    const lip = (yc: number, h: number, a: number) => { const [cx, cy] = P(0, yc); g.save(); g.translate(cx, cy); g.scale(1, h); const gr = g.createRadialGradient(0, 0, 0, 0, 0, 0.25 * scaleX); const lc = new THREE.Color(L.lips); const rgb = `${Math.round(lc.r * 255)},${Math.round(lc.g * 255)},${Math.round(lc.b * 255)}`; gr.addColorStop(0, `rgba(${rgb},${a})`); gr.addColorStop(0.7, `rgba(${rgb},${a * 0.8})`); gr.addColorStop(1, `rgba(${rgb},0)`); g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 0.25 * scaleX, 0, 7); g.fill(); g.restore(); };
    if (!smile) {
      lip(-0.48, 0.12, 0.5); lip(-0.565, 0.18, 0.55);
      const [x0, y0] = P(-0.3, -0.525), [x1] = P(0.3, -0.525), [, yc] = P(0, -0.522); g.strokeStyle = 'rgba(90,45,40,.6)'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(x0, y0 - 2); g.quadraticCurveTo((x0 + x1) / 2, yc + 4, x1, y0 - 2); g.stroke();
    } else {
      // an open, friendly smile: thin upper lip, a row of teeth, fuller lower lip
      lip(-0.47, 0.09, 0.45); lip(-0.585, 0.15, 0.5);
      const [lx, ly] = P(-0.31, -0.51), [rx] = P(0.31, -0.51), [, top] = P(0, -0.49), [, bot] = P(0, -0.572), [cx] = P(0, -0.52);
      g.save();
      g.beginPath(); g.moveTo(lx, ly); g.quadraticCurveTo(cx, top - 6, rx, ly); g.quadraticCurveTo(cx, bot + 10, lx, ly); g.closePath();
      g.fillStyle = '#3a1d1a'; g.fill(); g.clip();
      const tg = g.createLinearGradient(0, top, 0, bot); tg.addColorStop(0, '#f4efe6'); tg.addColorStop(0.75, '#e6ddd0'); tg.addColorStop(1, '#b9a99a');
      g.fillStyle = tg; g.beginPath(); g.moveTo(lx + 10, ly - 1); g.quadraticCurveTo(cx, top - 4, rx - 10, ly - 1); g.quadraticCurveTo(cx, bot - 2, lx + 10, ly - 1); g.fill();
      g.strokeStyle = 'rgba(150,130,115,.45)'; g.lineWidth = 1.2;
      for (let i = -4; i <= 4; i++) { const tx = cx + i * 14 * (1 + Math.abs(i) * 0.05); g.beginPath(); g.moveTo(tx, top); g.lineTo(tx, top + 26); g.stroke(); }
      const sh = g.createLinearGradient(lx, 0, rx, 0); sh.addColorStop(0, 'rgba(40,20,18,.75)'); sh.addColorStop(0.18, 'rgba(40,20,18,0)'); sh.addColorStop(0.82, 'rgba(40,20,18,0)'); sh.addColorStop(1, 'rgba(40,20,18,.75)');
      g.fillStyle = sh; g.fillRect(lx, top - 10, rx - lx, bot - top + 20);
      g.restore();
      g.strokeStyle = 'rgba(110,60,52,.5)'; g.lineWidth = 2; g.beginPath(); g.moveTo(lx, ly); g.quadraticCurveTo(cx, top - 6, rx, ly); g.stroke();
      // smile lines from the nose to the mouth corners
      for (const s2 of [-1, 1]) { const [ax, ay] = P(s2 * 0.15, -0.32), [bx, by] = P(s2 * 0.31, -0.5); g.strokeStyle = 'rgba(120,70,60,.28)'; g.lineWidth = 3; g.beginPath(); g.moveTo(ax, ay); g.quadraticCurveTo(ax + s2 * 28, (ay + by) / 2, bx, by); g.stroke(); }
    }
    // nostrils
    for (const s of [-1, 1]) { const [cx, cy] = P(s * 0.085, -0.335); g.fillStyle = 'rgba(70,35,30,.55)'; g.beginPath(); g.ellipse(cx, cy, 9, 5, s * 0.4, 0, 7); g.fill(); }
    // eyes: almond shaped, a little hooded, blue-grey irises
    const ir = new THREE.Color(L.eyes);
    const almond = (cx: number, cy: number, ew: number, eh: number, s: number) => {
      // inner corner (toward the nose) a touch lower than the outer corner
      const inX = cx - s * ew, outX = cx + s * ew;
      g.beginPath(); g.moveTo(inX, cy + eh * 0.15);
      g.bezierCurveTo(cx - s * ew * 0.45, cy - eh * 1.15, cx + s * ew * 0.45, cy - eh * 1.2, outX, cy - eh * 0.05);
      g.bezierCurveTo(cx + s * ew * 0.4, cy + eh * 0.95, cx - s * ew * 0.45, cy + eh * 0.95, inX, cy + eh * 0.15);
      g.closePath();
    };
    for (const s of [-1, 1]) {
      const [cx, cy] = P(s * 0.36, 0.055);
      const ew = 0.118 * scaleX, eh = (smile ? 0.034 : 0.043) * scaleY;
      // socket shading and the hooded fold above the lid
      blush(s * 0.36, 0.1, 0.17, 0.07, 'rgb(120,78,68)', 0.2);
      g.save(); almond(cx, cy, ew, eh, s); g.clip();
      g.fillStyle = '#e2d8d1'; g.fillRect(cx - ew, cy - eh * 1.3, ew * 2, eh * 2.6);
      const irisR = eh * 1.02, ix = cx - s * 1.5, iy = cy + eh * 0.12;
      const gi = g.createRadialGradient(ix, iy, irisR * 0.15, ix, iy, irisR);
      gi.addColorStop(0, `rgb(${Math.round(ir.r * 170)},${Math.round(ir.g * 175)},${Math.round(ir.b * 170)})`);
      gi.addColorStop(0.55, `rgb(${Math.round(ir.r * 255)},${Math.round(ir.g * 255)},${Math.round(ir.b * 255)})`);
      gi.addColorStop(0.92, `rgb(${Math.round(ir.r * 150)},${Math.round(ir.g * 160)},${Math.round(ir.b * 170)})`);
      gi.addColorStop(1, 'rgb(38,46,56)');
      g.fillStyle = gi; g.beginPath(); g.arc(ix, iy, irisR, 0, 7); g.fill();
      for (let i = 0; i < 40; i++) { const a = rand() * 7; g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 1; g.beginPath(); g.moveTo(ix + Math.cos(a) * irisR * 0.4, iy + Math.sin(a) * irisR * 0.4); g.lineTo(ix + Math.cos(a) * irisR * 0.9, iy + Math.sin(a) * irisR * 0.9); g.stroke(); }
      g.fillStyle = '#0d0d0f'; g.beginPath(); g.arc(ix, iy, irisR * 0.36, 0, 7); g.fill();
      const lid = g.createLinearGradient(0, cy - eh * 1.2, 0, cy + eh * 0.1);
      lid.addColorStop(0, 'rgba(50,30,26,.55)'); lid.addColorStop(1, 'rgba(50,30,26,0)');
      g.fillStyle = lid; g.fillRect(cx - ew, cy - eh * 1.3, ew * 2, eh * 1.5);
      g.fillStyle = 'rgba(255,255,255,.85)'; g.beginPath(); g.arc(ix + irisR * 0.32, iy - irisR * 0.32, irisR * 0.16, 0, 7); g.fill();
      g.restore();
      // lash line on top, softer line below, crease above
      g.save(); almond(cx, cy, ew, eh, s); g.strokeStyle = 'rgba(40,24,20,.0)'; g.restore();
      g.strokeStyle = 'rgba(32,20,16,.92)'; g.lineWidth = 5; g.lineCap = 'round';
      g.beginPath(); g.moveTo(cx - s * ew, cy + eh * 0.15); g.bezierCurveTo(cx - s * ew * 0.45, cy - eh * 1.15, cx + s * ew * 0.45, cy - eh * 1.2, cx + s * ew * 1.04, cy - eh * 0.1); g.stroke();
      g.strokeStyle = 'rgba(90,55,48,.45)'; g.lineWidth = 2.2;
      g.beginPath(); g.moveTo(cx + s * ew, cy - eh * 0.05); g.bezierCurveTo(cx + s * ew * 0.4, cy + eh * 0.95, cx - s * ew * 0.45, cy + eh * 0.95, cx - s * ew, cy + eh * 0.15); g.stroke();
      g.strokeStyle = 'rgba(110,66,56,.38)'; g.lineWidth = 3.5;
      g.beginPath(); g.moveTo(cx - s * ew * 0.85, cy - eh * 0.9); g.bezierCurveTo(cx - s * ew * 0.3, cy - eh * 1.9, cx + s * ew * 0.5, cy - eh * 1.85, cx + s * ew * 1.1, cy - eh * 0.75); g.stroke();
      // brow: fairly straight and full, thicker toward the nose
      const bc = new THREE.Color(L.brows);
      for (let i = 0; i < 520; i++) {
        const tt = rand();
        const bx = s * (0.15 + tt * 0.4), by = 0.218 + 0.018 * Math.sin(tt * Math.PI * 0.9) - tt * 0.012 + (rand() - 0.5) * 0.05 * (1 - tt * 0.55);
        const [px, py] = P(bx, by);
        g.strokeStyle = `rgba(${Math.round(bc.r * 255)},${Math.round(bc.g * 255)},${Math.round(bc.b * 255)},${0.35 + rand() * 0.45})`;
        g.lineWidth = 1.4 + rand() * 1.2; g.beginPath(); g.moveTo(px, py); g.lineTo(px + s * (5 + rand() * 7), py - 2.5 - rand() * 3 + tt * 2); g.stroke();
      }
    }
  });
}

function buildHead(p: GolferProfile, skinMat: THREE.Material): HeadParts {
  const L = p.look;
  const geo = new THREE.SphereGeometry(1, 160, 110);
  geo.rotateY(-Math.PI / 2); // put the uv seam at the back of the head, face centre at u = 0.5
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const unit = pos.clone();
  const o = new THREE.Vector3();
  const smileDelta = new Float32Array(pos.count * 3), o2 = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    sculpt(x, y, z, L, o); sculpt(x, y, z, L, o2, 1);
    smileDelta.set([o2.x - o.x, o2.y - o.y, o2.z - o.z], i * 3);
    pos.setXYZ(i, o.x, o.y, o.z);
  }
  geo.computeVertexNormals(); weldNormals(geo);
  geo.morphAttributes.position = [new THREE.BufferAttribute(smileDelta, 3)];
  geo.morphTargetsRelative = true;
  const mat = (skinMat as THREE.MeshPhysicalMaterial).clone();
  mat.map = faceTexture(L);
  mat.color.set('#ffffff');
  // the smile: a second face map blended in the shader, plus the morph above
  const smileU = { value: 0 }, smileMap = { value: faceTexture(L, true) };
  mat.onBeforeCompile = sh => {
    sh.uniforms.uSmile = smileU; sh.uniforms.smileMap = smileMap;
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uSmile;\nuniform sampler2D smileMap;')
      .replace('#include <map_fragment>', '#ifdef USE_MAP\n vec4 sampledDiffuseColor = mix(texture2D(map, vMapUv), texture2D(smileMap, vMapUv), uSmile);\n diffuseColor *= sampledDiffuseColor;\n#endif');
  };
  mat.customProgramCacheKey = () => 'face-smile';
  mat.roughness = 1;
  mat.roughnessMap = canvasTex(1024, 512, g => {
    const W = 1024, H = 512, P = (x: number, y: number) => { const [u, v] = faceUV(x, y); return [u * W, (1 - v) * H]; };
    g.fillStyle = 'rgb(0,140,0)'; g.fillRect(0, 0, W, H);           // skin ~0.55
    for (const s of [-1, 1]) { const [cx, cy] = P(s * 0.36, 0.055); g.fillStyle = 'rgb(0,28,0)'; g.beginPath(); g.ellipse(cx, cy, 20, 8, 0, 0, 7); g.fill(); }
    const [lx, ly] = P(0, -0.525); g.fillStyle = 'rgb(0,95,0)'; g.beginPath(); g.ellipse(lx, ly, 30, 9, 0, 0, 7); g.fill();
    const [nx, ny] = P(0, -0.2); g.fillStyle = 'rgb(0,115,0)'; g.beginPath(); g.ellipse(nx, ny, 14, 20, 0, 0, 7); g.fill(); // a little shine on the nose
  }, false);
  const head = new THREE.Mesh(geo, mat);

  // hair shell
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
  const hp: number[] = [], huv: number[] = [], keep: boolean[] = [], hm: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const x = unit.getX(i), y = unit.getY(i), z = unit.getZ(i);
    const az = Math.atan2(x, z), el = Math.asin(Math.max(-1, Math.min(1, y)));
    const e = hairElevation(az, L.hairline);
    const m = smooth(e - 0.08, e + 0.16, el);
    const top = smooth(0.15, 1.0, el), front = smooth(-0.2, 0.6, z);
    const tuft = 0.5 + 0.5 * Math.sin(x * 23 + Math.sin(z * 17) * 2) * Math.sin(z * 19 + y * 13 + Math.sin(x * 11));
    const thick = smooth(0.25, 1, m) * (0.003 + 0.008 * top + 0.004 * front * top + 0.0035 * top * tuft) + 0.0006;
    keep.push(m > 0.001);
    hm.push(m);
    hp.push(pos.getX(i) + nrm.getX(i) * thick, pos.getY(i) + nrm.getY(i) * thick, pos.getZ(i) + nrm.getZ(i) * thick);
    const uvA = geo.getAttribute('uv') as THREE.BufferAttribute; huv.push(uvA.getX(i), uvA.getY(i));
  }
  const src = geo.getIndex()!, hidx: number[] = [];
  for (let i = 0; i < src.count; i += 3) { const a = src.getX(i), b = src.getX(i + 1), c = src.getX(i + 2); if (keep[a] || keep[b] || keep[c]) hidx.push(a, b, c); }
  const hg = new THREE.BufferGeometry();
  hg.setAttribute('position', new THREE.Float32BufferAttribute(hp, 3));
  hg.setAttribute('uv', new THREE.Float32BufferAttribute(huv, 2));
  hg.setAttribute('hm', new THREE.Float32BufferAttribute(hm, 1));
  hg.setIndex(hidx); hg.computeVertexNormals(); weldNormals(hg);
  seed = 5;
  const hc = new THREE.Color(L.hair);
  const strands = canvasTex(1024, 512, g => {
    g.fillStyle = L.hair; g.fillRect(0, 0, 1024, 512);
    for (let i = 0; i < 14000; i++) {
      const x = rand() * 1024, y = rand() * 512, len = 6 + rand() * 16, l = rand();
      g.strokeStyle = l < 0.5 ? `rgba(${Math.round(hc.r * 255 + 40)},${Math.round(hc.g * 255 + 30)},${Math.round(hc.b * 255 + 20)},.35)` : 'rgba(10,6,4,.35)';
      g.lineWidth = 1; g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rand() - 0.5) * 4, y + len); g.stroke();
    }
  });
  const hairMat = new THREE.MeshStandardMaterial({ map: strands, roughness: 0.62, metalness: 0, color: '#ffffff', polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  // the hairline is drawn per pixel from the interpolated mask, ragged like real short hair
  hairMat.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float hm;\nvarying float vHm;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvHm = hm;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vHm;')
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n float hn = fract(sin(dot(floor(vMapUv * vec2(2600.0, 1300.0)), vec2(12.9898, 78.233))) * 43758.5453);\n if (vHm < 0.42 + 0.2 * hn) discard;');
  };
  hairMat.customProgramCacheKey = () => 'hair-mask';
  const hair = new THREE.Mesh(hg, hairMat);

  // ears: a flattened, slightly cupped disc on each side
  const ears: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    const e = new THREE.SphereGeometry(1, 24, 16);
    const ep = e.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < ep.count; i++) {
      let x = ep.getX(i), y = ep.getY(i), z = ep.getZ(i);
      const cup = x > 0 ? -0.5 * gauss(Math.hypot(y, z) / 0.6) : 0; // hollow facing outward
      x = (x + cup) * 0.008; y = y * 0.031 * (y > 0 ? 1 : 0.85); z = z * 0.019 * (1 - 0.2 * y);
      ep.setXYZ(i, x * s, y, z);
    }
    e.rotateY(s * -0.32 * L.earOut);
    e.rotateX(-0.12);
    e.translate(s * 0.0735, -0.008 * L.faceLength, -0.008);
    e.computeVertexNormals();
    ears.push(e);
  }
  const earMat = (skinMat as THREE.MeshPhysicalMaterial).clone(); earMat.color.set(L.skinWarm).lerp(new THREE.Color(L.skin), 0.55);
  const earMesh = new THREE.Mesh(mergeGeometries(ears), earMat);
  const setSmile = (v: number) => { smileU.value = v; head.morphTargetInfluences![0] = v; };
  head.updateMorphTargets();
  return { head, hair, ears: earMesh, setSmile };
}

// ───────────────────────── shoes ─────────────────────────
function shoeGeometry(side: number) {
  // rings from heel to toe, relative to the ankle joint; flat sole at y = -ankleHeight
  const ah = 0.09;
  const prof: [number, number, number, number][] = [ // z, half width, height, shade
    [-0.082, 0.026, 0.07, 1], [-0.075, 0.036, 0.085, 1], [-0.05, 0.042, 0.092, 1], [0.0, 0.046, 0.095, 1], [0.05, 0.051, 0.078, 1],
    [0.1, 0.054, 0.062, 1], [0.15, 0.05, 0.05, 1], [0.19, 0.04, 0.04, 1], [0.215, 0.024, 0.03, 1], [0.225, 0.01, 0.022, 1],
  ];
  const rings: Ring[] = prof.map(([z, hw, h]) => ({ c: V(0, -ah + h / 2, z), rx: hw, rz: h / 2, w: [[0, 1]], p: 2.6 }));
  const g = loft(rings, 20, V(0, 1, 0), [true, true]);
  // sole band: darken the lowest vertices; a trim stripe along the side
  const pa = g.getAttribute('position') as THREE.BufferAttribute, ca = g.getAttribute('color') as THREE.BufferAttribute;
  for (let i = 0; i < pa.count; i++) {
    const y = pa.getY(i) + ah;
    if (y < 0.018) ca.setXYZ(i, 0.35, 0.35, 0.37);
    else if (y < 0.032 && Math.abs(pa.getX(i)) > 0.03) ca.setXYZ(i, -1, 0, 0); // marker for trim colour
  }
  g.translate(side * 0.004, 0, 0);
  return g;
}

// ───────────────────────── the whole body ─────────────────────────
export interface Body {
  root: THREE.Group;              // add this to the scene
  bones: THREE.Bone[];
  skel: Skeleton;
  meshes: THREE.Object3D[];
  materials: { skin: THREE.MeshPhysicalMaterial; glove: THREE.MeshStandardMaterial };
  /** 0 = neutral, 1 = smiling */
  setSmile: (v: number) => void;
}

export function buildBody(p: GolferProfile): Body {
  const S = skeletonFor(p);
  const k = p.heightM / 1.905;
  const bmi = p.weightKg / (p.heightM * p.heightM), girth = Math.sqrt(bmi / 22.5);
  const G = (r: number) => r * k * girth; // girth-scaled radius

  // bones (identity orientation, positions relative to parent)
  const bones = S.joint.map(() => new THREE.Bone());
  bones.forEach((b, i) => { const par = PARENT[i]; if (par < 0) b.position.copy(S.joint[i]); else { b.position.subVectors(S.joint[i], S.joint[par]); bones[par].add(b); } });
  const skeleton = new THREE.Skeleton(bones);
  const root = new THREE.Group(); root.name = `golfer-${p.id}`;
  root.add(bones[0]);
  root.updateMatrixWorld(true);

  const J = S.joint, T = S.tail;
  const y = (v: number) => v * k;
  // ── hoodie: torso + sleeves + hem/cuff bands ──
  const torsoRings: Ring[] = ([
    [0.85, 0.196, 0.134, -0.004, [[1, 1]], 0.88],
    [0.875, 0.196, 0.134, -0.004, [[1, 1]], 0.88],
    [0.9, 0.192, 0.13, -0.002, [[1, 1]], 1],
    [0.98, 0.18, 0.122, 0.004, [[1, 0.7], [2, 0.3]], 1],
    [1.08, 0.162, 0.116, 0.006, [[2, 1]], 1],
    [1.18, 0.174, 0.124, 0.01, [[2, 0.6], [3, 0.4]], 1],
    [1.28, 0.185, 0.13, 0.014, [[3, 1]], 1],
    [1.38, 0.196, 0.13, 0.012, [[3, 1]], 1],
    [1.45, 0.2, 0.12, 0.006, [[3, 1]], 1],
    [1.5, 0.2, 0.112, -0.002, [[3, 1]], 1],
    [1.54, 0.188, 0.1, -0.008, [[3, 1]], 1],
    [1.568, 0.152, 0.09, -0.012, [[3, 1]], 0.98],
    [1.592, 0.105, 0.08, -0.012, [[3, 0.8], [4, 0.2]], 0.96],
    [1.615, 0.082, 0.078, -0.008, [[3, 0.6], [4, 0.4]], 0.92],
    [1.63, 0.077, 0.074, -0.006, [[3, 0.5], [4, 0.5]], 0.88],
  ] as [number, number, number, number, [number, number][], number][]).map(([yy, rx, rz, zo, w, shade]) => ({ c: V(0, y(yy), 0), rx: G(rx), rz: G(rz), zo: zo * k, w, shade, p: yy > 1.44 ? 2.0 : 2.35 }));
  const torso = loft(torsoRings, 40, V(0, 0, 1), [false, false]);
  const sleeve = (L: boolean) => {
    const sx = L ? 1 : -1, cl = L ? BONE.clavL : BONE.clavR, up = L ? BONE.upperL : BONE.upperR, fo = L ? BONE.foreL : BONE.foreR;
    const sh = J[up], el = J[fo], wr = T[fo];
    const start = V(sx * 0.12 * k, sh.y - 0.015 * k, sh.z);
    const pts = [start, sh, el, wr];
    return loft(limbRings(pts, [cl, up, fo], [
      { t: 0.0, rx: G(0.044) }, { t: 0.5, rx: G(0.05) }, { t: 1.0, rx: G(0.055), rz: G(0.056) }, { t: 1.2, rx: G(0.054) }, { t: 1.5, rx: G(0.052) },
      { t: 1.85, rx: G(0.048) }, { t: 2.0, rx: G(0.047) }, { t: 2.15, rx: G(0.046) }, { t: 2.5, rx: G(0.044) }, { t: 2.8, rx: G(0.04) },
      { t: 2.86, rx: G(0.036), shade: 0.9 }, { t: 2.97, rx: G(0.034), shade: 0.9 }, { t: 3.0, rx: G(0.03), shade: 0.9 },
    ].map(s => ({ ...s, t: s.t < 1 ? s.t : s.t })), 0.16, BONE.chest).map((r, i) => i < 2 ? { ...r, w: [[BONE.chest, 0.6], [cl, 0.4]] as [number, number][] } : r), 22, V(0, 0, 1), [false, true]);
  };
  const hoodieGeo = mergeGeometries([torso, sleeve(true), sleeve(false)]);
  const topColor = new THREE.Color(p.outfit.topColor);
  const hoodieMat = new THREE.MeshPhysicalMaterial({ map: heatherTexture(p.outfit.topColor), normalMap: knitNormal(), normalScale: new THREE.Vector2(0.35, 0.35), roughness: 0.92, sheen: 0.6, sheenColor: new THREE.Color('#ffffff'), sheenRoughness: 0.75, vertexColors: true });
  (hoodieMat.map as THREE.Texture).wrapS = (hoodieMat.map as THREE.Texture).wrapT = THREE.RepeatWrapping; (hoodieMat.map as THREE.Texture).repeat.set(6, 6);
  (hoodieMat.normalMap as THREE.Texture).wrapS = (hoodieMat.normalMap as THREE.Texture).wrapT = THREE.RepeatWrapping; (hoodieMat.normalMap as THREE.Texture).repeat.set(24, 24);
  void topColor;

  // ── pants: hips + legs ──
  const hips = loft(([
    [0.8, 0.14, 0.092, -0.004, [[1, 1]]],
    [0.86, 0.156, 0.1, -0.008, [[1, 1]]],
    [0.94, 0.16, 0.1, -0.008, [[1, 1]]],
    [0.97, 0.152, 0.098, -0.004, [[1, 1]]],
  ] as [number, number, number, number, [number, number][]][]).map(([yy, rx, rz, zo, w]) => ({ c: V(0, y(yy), 0), rx: G(rx), rz: G(rz), zo: zo * k, w, p: 2.2 })), 36, V(0, 0, 1), [true, true]);
  const leg = (L: boolean) => {
    const th = L ? BONE.thighL : BONE.thighR, sn = L ? BONE.shinL : BONE.shinR;
    const hip = J[th], knee = J[sn], ankle = T[sn];
    const top = V(hip.x * 0.8, hip.y + 0.01 * k, hip.z);
    return loft(limbRings([top, hip, knee, ankle], [BONE.pelvis, th, sn], [
      { t: 0.0, rx: G(0.075) }, { t: 0.6, rx: G(0.084) }, { t: 1.0, rx: G(0.084), rz: G(0.087) }, { t: 1.3, rx: G(0.078) }, { t: 1.6, rx: G(0.068) },
      { t: 1.85, rx: G(0.06) }, { t: 2.0, rx: G(0.058) }, { t: 2.15, rx: G(0.057), zo: -0.004 }, { t: 2.4, rx: G(0.058), zo: -0.008 }, { t: 2.7, rx: G(0.053) },
      { t: 2.92, rx: G(0.052), shade: 0.92 }, { t: 3.0, rx: G(0.053), shade: 0.88 },
    ], 0.2).map((r, i) => i === 0 ? { ...r, w: [[BONE.pelvis, 1]] as [number, number][] } : r), 22, V(0, 0, 1), [false, true]);
  };
  const pantsGeo = mergeGeometries([hips, leg(true), leg(false)]);
  const pantsMat = new THREE.MeshPhysicalMaterial({ color: p.outfit.pants, roughness: 0.78, sheen: 0.4, sheenColor: new THREE.Color('#8890a0'), sheenRoughness: 0.6, vertexColors: true, normalMap: knitNormal(), normalScale: new THREE.Vector2(0.15, 0.15) });

  // ── skin: neck + wrists ──
  const skinMat = new THREE.MeshPhysicalMaterial({ color: p.look.skin, roughness: 0.52, sheen: 0.25, sheenColor: new THREE.Color(p.look.skinWarm), sheenRoughness: 0.5, clearcoat: 0.05, clearcoatRoughness: 0.6 });
  const neckGeo = loft([
    { c: V(0, J[BONE.neck].y - 0.05 * k, J[BONE.neck].z), rx: G(0.074), rz: G(0.07), w: [[BONE.chest, 1]] },
    { c: V(0, J[BONE.neck].y, J[BONE.neck].z), rx: G(0.066), rz: G(0.065), w: [[BONE.chest, 0.3], [BONE.neck, 0.7]] },
    { c: V(0, J[BONE.head].y, J[BONE.head].z + 0.004), rx: G(0.063), rz: G(0.062), w: [[BONE.neck, 0.5], [BONE.head, 0.5]] },
    { c: V(0, J[BONE.head].y + 0.05 * k, J[BONE.head].z + 0.008), rx: G(0.058), rz: G(0.055), w: [[BONE.head, 1]] },
  ], 24, V(0, 0, 1), [false, false]);
  const neckMat = skinMat.clone(); neckMat.vertexColors = true;

  const meshes: THREE.Object3D[] = [];
  const addSkinned = (g: THREE.BufferGeometry, m: THREE.Material) => { const mesh = new THREE.SkinnedMesh(g, m); mesh.castShadow = mesh.receiveShadow = true; mesh.frustumCulled = false; root.add(mesh); mesh.bind(skeleton); meshes.push(mesh); return mesh; };
  addSkinned(hoodieGeo, hoodieMat);
  addSkinned(pantsGeo, pantsMat);
  addSkinned(neckGeo, neckMat);

  // ── rigid parts on bones ──
  const attach = (bi: number, obj: THREE.Object3D, at: THREE.Vector3) => { obj.position.sub(S.joint[bi]).add(at); bones[bi].add(obj); obj.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } }); meshes.push(obj); };
  const hp = buildHead(p, skinMat);
  const headGroup = new THREE.Group(); headGroup.add(hp.head, hp.hair, hp.ears); headGroup.scale.setScalar(k);
  if (p.outfit.headwear?.kind === 'visor') headGroup.add(buildVisor(p.outfit.headwear, 0.0785, 0.1, 0.006, 0.06 * p.look.faceLength, p.handed === 'left'));
  attach(BONE.head, headGroup, S.headCenter);

  // hood bunched at the back of the neck + drawstrings + chest emblem (chest bone)
  // hood: a soft roll lying round the back of the neck
  const hoodPts: THREE.Vector3[] = [];
  for (let i = 0; i <= 12; i++) { const a = -0.68 * Math.PI + (1.36 * Math.PI * i) / 12; hoodPts.push(V(Math.sin(a) * 0.082, -0.03 * Math.cos(a) - 0.008 * (1 - Math.cos(a)), -Math.cos(a) * 0.072)); }
  const hoodGeo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(hoodPts), 40, 0.026, 12, false);
  { const hp2 = hoodGeo.getAttribute('position') as THREE.BufferAttribute; for (let i = 0; i < hp2.count; i++) { const zz = hp2.getZ(i); if (zz < -0.05) { hp2.setZ(i, zz - (-(zz) - 0.05) * 0.6); hp2.setY(i, hp2.getY(i) - (-(zz) - 0.05) * 0.5); } } hoodGeo.computeVertexNormals(); }
  const hoodMat = hoodieMat.clone(); hoodMat.vertexColors = false;
  const hood = new THREE.Mesh(hoodGeo, hoodMat); hood.scale.setScalar(k * girth);
  attach(BONE.chest, hood, V(0, y(1.585), -0.014 * k));
  const cordMat = new THREE.MeshStandardMaterial({ color: p.outfit.topTrim, roughness: 0.8 });
  for (const s of [-1, 1]) {
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.0035, 0.0035, 0.16, 6), cordMat);
    cord.rotation.z = s * 0.06; cord.rotation.x = -0.12;
    attach(BONE.chest, cord, V(s * 0.03 * k, y(1.475), G(0.14) + 0.0));
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.02, 8), new THREE.MeshStandardMaterial({ color: '#d8d8d8', metalness: 0.6, roughness: 0.3 }));
    attach(BONE.chest, tip, V(s * 0.035 * k, y(1.395), G(0.15)));
  }
  const emblem = new THREE.Mesh(new THREE.CircleGeometry(0.03, 32), new THREE.MeshStandardMaterial({
    map: canvasTex(128, 128, g => {
      g.fillStyle = p.outfit.emblem; g.beginPath(); g.arc(64, 64, 60, 0, 7); g.fill();
      g.strokeStyle = '#fff'; g.lineWidth = 7; g.beginPath(); g.moveTo(40, 92); g.lineTo(72, 30); g.stroke(); // a club
      g.fillStyle = '#fff'; g.beginPath(); g.arc(84, 86, 11, 0, 7); g.fill();                              // and a ball
    }), roughness: 0.85, transparent: true,
  }));
  emblem.rotation.y = 0.32; emblem.rotation.x = -0.12;
  attach(BONE.chest, emblem, V(0.085 * k, y(1.4), G(0.128) + 0.012));
  // shoes (foot bones)
  const shoeMat = new THREE.MeshPhysicalMaterial({ color: '#ffffff', roughness: 0.45, clearcoat: 0.25, clearcoatRoughness: 0.4, vertexColors: true });
  for (const L of [true, false]) {
    const bi = L ? BONE.footL : BONE.footR;
    const g = shoeGeometry(L ? 1 : -1);
    const ca = g.getAttribute('color') as THREE.BufferAttribute, base = new THREE.Color(p.outfit.shoes), trim = new THREE.Color(p.outfit.shoeTrim);
    for (let i = 0; i < ca.count; i++) { if (ca.getX(i) < 0) ca.setXYZ(i, trim.r, trim.g, trim.b); else ca.setXYZ(i, base.r * ca.getX(i), base.g * ca.getY(i), base.b * ca.getZ(i)); }
    const shoe = new THREE.Mesh(g, shoeMat); shoe.scale.setScalar(k);
    attach(bi, shoe, S.joint[bi]);
  }

  const glove = new THREE.MeshStandardMaterial({ color: p.outfit.glove, roughness: 0.55 });
  return { root, bones, skel: S, meshes, materials: { skin: skinMat, glove }, setSmile: hp.setSmile };
}
