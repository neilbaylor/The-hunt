// The driving range: sky, light, terrain, turf, greens, flags, yardage boards and trees.
// Everything is generated in code (no asset files) so the game can ship as one HTML file.
//
// World: metres, Y up. The teed ball is at the origin; the target line is -Z.
import * as THREE from 'three';
import crestUrl from '../assets/brand/toronto-hunt-crest.png?url';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type Surface = 'tee' | 'fairway' | 'rough' | 'green' | 'bunker';
export interface RangeTarget { yards: number; pos: THREE.Vector3; radius: number; color: string }
export type TimeOfDay = 'golden' | 'midday';
export interface Range {
  sun: THREE.DirectionalLight;
  /** every frame; focus = world point the shadow frustum should centre on (golfer at address, then the ball) */
  update(dt: number, camera: THREE.Camera, focus: THREE.Vector3): void;
  surfaceAt(x: number, z: number): Surface;
  heightAt(x: number, z: number): number;
  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3;
  targets: RangeTarget[];
  /**
   * Tight, sharp shadows around a character: pass the golfer's feet position and a radius (m, ~3-5).
   * Pass null to go back to the wide shadow box that follows update()'s `focus` (ball in flight).
   */
  setShadowFocus(center: THREE.Vector3 | null, radius?: number): void;
  /** soft ambient-occlusion blob on the ground under the golfer (null hides it). strength 0..1, radius in m. */
  contactShadow(position: THREE.Vector3 | null, strength?: number, radius?: number): void;
  setTimeOfDay(t: TimeOfDay): void;
  /** scale blade, tree and far-tree counts, tree LOD distance and the shadow map to a performance tier (cheap, any time) */
  setDetail(d: Detail): void;
  readonly detail: Detail;
  /** wind (m/s, blowing toward); the flags stream with it. Below ~0.3 m/s they show a light breeze instead. */
  setWind(v: THREE.Vector3): void;
  /**
   * Put the featured target green (yellow crest flag, real cup) at this carry distance in yards, a little off the
   * line so it clears the scenery greens and bunkers; it slides there if already shown. null hides it.
   * While shown it is also in `targets` (so 'On the green' and the landing camera know about it).
   */
  setFeaturedTarget(yards: number | null): void;
  readonly featured: RangeTarget | null;
  readonly timeOfDay: TimeOfDay;
  /** unit vector pointing at the sun (world) */
  readonly sunDirection: THREE.Vector3;
  /** the haze/horizon colour (linear) for the current time of day */
  readonly hazeColor: THREE.Color;
  /** the golfer's environment map: the scene's sky light without the sun's glow (see applyTime) */
  readonly avatarEnv: THREE.Texture;
}

export const YD = 0.9144;
/** the golfer's env map caps the sky's luminance here (linear), which cuts off the glow round the sun */
const AVATAR_ENV_CAP = 20;
/** how much the range draws: 'low' for weak phones (coarser terrain, fewer blades and trees, smaller shadow map) */
export type Detail = 'low' | 'med' | 'high';
export interface RangeOptions { detail?: Detail }

// ───────────────────────── layout ─────────────────────────
// Two looks. Golden hour: a low sun ahead and to the left down the range, so the golfer is rim lit and long
// soft shadows run back toward the camera, with warm haze in the distance. Midday: high sun behind the camera.
// Azimuth: degrees from +Z toward +X (180 = straight down the range).
interface TimePreset {
  elev: number; azim: number;
  sky: { turbidity: number; rayleigh: number; mieCoefficient: number; mieDirectionalG: number };
  clouds: number; sunColor: string; sunI: number; hemiSky: string; hemiGround: string; hemiI: number;
  fog: string; fogDensity: number; envI: number; groundBounce: string; trans: number;
}
const TIMES: Record<TimeOfDay, TimePreset> = {
  golden: {
    elev: 9, azim: 238,
    // a hazy summer evening, sun low and nearly into the camera: creamy pale sky, golden light, cool green shade
    sky: { turbidity: 12, rayleigh: 0.6, mieCoefficient: 0.012, mieDirectionalG: 0.86 },
    clouds: 0.1, sunColor: '#ffc466', sunI: 8.2, hemiSky: '#b4c0c8', hemiGround: '#46502c', hemiI: 0.15,
    fog: '#efdfbe', fogDensity: 0.0012, envI: 0.25, groundBounce: '#556028', trans: 1.25,
  },
  midday: {
    elev: 48, azim: -28,
    // a clean blue sky, crisp shadows, haze only at the horizon
    sky: { turbidity: 3.0, rayleigh: 1.7, mieCoefficient: 0.0035, mieDirectionalG: 0.8 },
    clouds: 0.22, sunColor: '#fff4e6', sunI: 3.6, hemiSky: '#cfe2f6', hemiGround: '#46602e', hemiI: 0.34,
    fog: '#cbdbe8', fogDensity: 0.00038, envI: 0.55, groundBounce: '#3c5e2a', trans: 0.35,
  },
};

const TEE = { cx: 0, cz: 2, hx: 7, hz: 8, r: 0.45 }; // tee box rounded rectangle (x∈[-7,7], z∈[-6,10])
const TEE_DROP = 0.14; // how far the tee box stands above the ground around it
const FW_START = -6.5, FW_END = -322, CAP0 = 14, CAP1 = 26, FIRST_CUT = 2.6;
const FRINGE = 2.1;

interface Green { yards: number; x: number; z: number; r: number; p: number; color: string }
const GREENS: Green[] = [
  // the first three sit close to the line so their flags are in the portrait swing camera's narrow frame
  // the chipping / putting green just short-left of the tee, then the target greens (about 1.7x the area they were)
  { yards: 25, x: -13, z: -25 * YD, r: 9.5, p: 2.2, color: '#f4f4ef' },
  { yards: 50, x: -6.5, z: -50 * YD, r: 8.5, p: 0.3, color: '#d7263d' },
  { yards: 100, x: 9.5, z: -100 * YD, r: 11, p: 1.7, color: '#ffd23f' },
  { yards: 150, x: -12, z: -150 * YD, r: 13.5, p: 2.9, color: '#f4f4ef' },
  { yards: 200, x: 15, z: -200 * YD, r: 15.5, p: 4.2, color: '#2f6fdf' },
  { yards: 250, x: -12, z: -250 * YD, r: 17.5, p: 5.1, color: '#ff8a1c' },
  { yards: 300, x: 6, z: -300 * YD, r: 19.5, p: 0.9, color: '#9b5de5' },
];
// the clubhouse on the rise beyond the range: white clapboard, dark roof, a flag on the gable
const CLUBHOUSE = { x: -42, z: -585, w: 34, d: 14, h: 8, yaw: 0.12 };
// the featured target: one green that moves to the carry distance of the club in hand (setFeaturedTarget)
const FEAT = { x: 0, z: -9999, r: 9, on: 0 };
const FEAT_U = { value: new THREE.Vector4(0, -9999, 9, 0) }; // x, z, radius, visibility (ground shader)
const featWob = (a: number) => 1 + 0.06 * Math.sin(2 * a + 1.1) + 0.04 * Math.sin(3 * a + 2.3);
const featD = (x: number, z: number) => Math.hypot(x - FEAT.x, z - FEAT.z) / (FEAT.r * featWob(Math.atan2(z - FEAT.z, x - FEAT.x)));
interface Bunker { x: number; z: number; rx: number; rz: number; rot: number; p: number }
const BUNKERS: Bunker[] = [
  { x: 4, z: -124, rx: 4.8, rz: 2.4, rot: 0.45, p: 0.7 },
  { x: -36, z: -229, rx: 5.2, rz: 3.0, rot: -0.35, p: 2.1 },
  { x: 25, z: -150, rx: 7.5, rz: 2.8, rot: 0.12, p: 3.3 },
  // greenside: around the 50, 100 and 200 greens
  { x: 8, z: -50, rx: 3.2, rz: 2.0, rot: 0.6, p: 1.1 },
  { x: -8, z: -86, rx: 3.6, rz: 2.2, rot: 0.8, p: 2.6 },
  { x: 27, z: -99, rx: 3.2, rz: 2.0, rot: -0.6, p: 5.3 },
  { x: -7, z: -176, rx: 4.0, rz: 2.4, rot: 0.3, p: 0.4 },
  { x: 37, z: -193, rx: 3.6, rz: 2.2, rot: -0.9, p: 3.9 },
  { x: 3, z: -248, rx: 6.2, rz: 2.2, rot: 0.05, p: 4.6 },
];

// ───────────────────────── math helpers (shared by CPU + mirrored in GLSL) ─────────────────────────
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const smooth = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
function hash2(i: number, j: number): number {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x: number, z: number): number {
  const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash2(i, j), b = hash2(i + 1, j), c = hash2(i, j + 1), d = hash2(i + 1, j + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x: number, z: number, oct = 4): number {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let k = 0; k < oct; k++) { s += a * vnoise(x * f + k * 17.3, z * f - k * 9.1); n += a; a *= 0.5; f *= 2.03; }
  return s / n;
}
let seed = 1234567;
const rand = () => { seed = (Math.imul(seed, 1103515245) + 12345) | 0; return ((seed >>> 8) & 0xffffff) / 0x1000000; };

const fwCenter = (z: number) => 3 * Math.sin(z / 97) + 2 * Math.sin(z / 41 + 1.3);
function fwHalf(z: number, grow: number): number {
  const s0 = FW_START + grow, s1 = FW_END - grow;
  if (z > s0 || z < s1) return -1;
  let h = 25 + 3.5 * Math.sin(z / 53 + 0.4) + 2 * Math.sin(z / 23 + 2.1) + grow;
  if (z > s0 - CAP0) { const t = (z - (s0 - CAP0)) / CAP0; h *= Math.sqrt(Math.max(0, 1 - t * t)); }
  if (z < s1 + CAP1) { const t = (s1 + CAP1 - z) / CAP1; h *= Math.sqrt(Math.max(0, 1 - t * t)); }
  return h;
}
const wob = (a: number, p: number) => 1 + 0.11 * Math.sin(2 * a + p) + 0.06 * Math.sin(3 * a + 2 * p) + 0.03 * Math.sin(5 * a + 3 * p);
/** normalised distance from a green's centre (1 = edge of the putting surface) */
function greenD(g: Green, x: number, z: number): number {
  const dx = x - g.x, dz = z - g.z;
  return Math.hypot(dx, dz) / (g.r * wob(Math.atan2(dz, dx), g.p));
}
function bunkerD(b: Bunker, x: number, z: number): number {
  const dx = x - b.x, dz = z - b.z, c = Math.cos(b.rot), s = Math.sin(b.rot);
  const u = (dx * c + dz * s) / b.rx, v = (-dx * s + dz * c) / b.rz;
  const a = Math.atan2(v, u);
  return Math.hypot(u, v) / clawK(a, b.p);
}
/** the outline of a claw bunker at angle a: fingers of sand reaching out, grassy noses pushing in (kept in sync with GLSL) */
function clawK(a: number, p: number): number {
  return 1 + 0.1 * Math.sin(3 * a + p) + 0.06 * Math.sin(5 * a + p * 1.7)
    + 0.32 * Math.pow(0.5 + 0.5 * Math.sin(5 * a + p * 2.3), 6) - 0.2 * Math.pow(0.5 + 0.5 * Math.sin(3 * a + p * 4.1), 10);
}
function teeSD(x: number, z: number): number {
  const qx = Math.abs(x - TEE.cx) - (TEE.hx - TEE.r), qz = Math.abs(z - TEE.cz) - (TEE.hz - TEE.r);
  return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - TEE.r;
}

// ───────────────────────── terrain height ─────────────────────────
/** height of the terrain mesh (under the tee box it sits TEE_DROP below the box top) */
/** how far (m) a point is outside the playing corridor (negative inside) */
function outside(x: number, z: number): number { return Math.max(Math.abs(x - fwCenter(z)) - 52, -z - 350, z - 60); }
/** height of the woodland canopy mass laid over the far terrain (seen from afar as forest) */
const canopyAt = (x: number, z: number) => forestAt(x, z) * smooth(70, 130, outside(x, z)) * 15;
function rawHeight(x: number, z: number, withCanopy = true): number {
  // how far outside the playing corridor we are
  const out = outside(x, z);
  const a = smooth(0, 90, out);
  let h = a * (6 * fbm(x / 85, z / 85) + 2.5) + Math.max(0, out) * 0.06 * a;
  // big distant hills that frame the horizon
  const r = Math.hypot(x * 0.85, (z + 160) * 0.62);
  h += smooth(700, 1600, r) * (18 + 45 * fbm(x / 520 + 3.1, z / 520 - 2.7, 5));
  if (withCanopy && out > 60) h += canopyAt(x, z);
  // gentle movement inside the corridor, flat at the tee and on the greens
  let flat = smooth(14, 45, Math.hypot(x, z));
  for (const g of GREENS) flat = Math.min(flat, smooth(1.0, 2.2, greenD(g, x, z)));
  h += (1 - a) * flat * (0.7 * Math.sin(x / 37 + 0.7) * Math.sin(z / 53) + 0.45 * Math.sin((x + z) / 71) + 0.2 * Math.sin(z / 19 + x / 29));
  // rough mounds and ripples along the fairway edges, the fairway a smooth carpet flowing between them
  {
    const fh = fwHalf(z, 0);
    if (fh > 0) {
      const e = Math.abs(x - fwCenter(z)) - fh;
      h += (1 - a) * flat * smooth(-1, 7, e) * (1 - smooth(16, 30, e)) * (0.75 + 0.45 * Math.sin(z / 13 + x / 7) * Math.sin(z / 29));
    }
  }
  // raised greens with a soft collar
  for (const g of GREENS) {
    const d = greenD(g, x, z);
    if (d < 1.6) h += 0.32 * (1 - smooth(1.0, 1.45, d)) + 0.06 * Math.max(0, 1 - d * d)
      // tilted gently from back to front (about 1.2%), as greens are, so putts and chips break a little
      + 0.16 * (1 - smooth(0.95, 1.5, d)) * clamp(-(z - g.z) / g.r, -1.2, 1.2);
  }
  // bunkers dug in
  for (const b of BUNKERS) {
    const d = bunkerD(b, x, z);
    // a flat sand floor, a steep face and a raised, ragged grass lip
    if (d < 1.6) h -= 0.5 * (1 - smooth(0.8, 1.02, d)) - 0.2 * smooth(0.98, 1.06, d) * (1 - smooth(1.1, 1.5, d));
  }
  // the tee box stands proud of its surroundings
  h -= TEE_DROP * (1 - smooth(0, 16, Math.max(teeSD(x, z), 0)));
  return h;
}
function heightAt(x: number, z: number): number { return teeSD(x, z) <= 0 ? 0 : rawHeight(x, z); }
function surfaceAt(x: number, z: number): Surface {
  if (teeSD(x, z) <= 0) return 'tee';
  for (const b of BUNKERS) if (bunkerD(b, x, z) < 1) return 'bunker';
  if (FEAT.on > 0.5) { const d = featD(x, z); if (d < 1) return 'green'; if (d < 1 + FRINGE / FEAT.r) return 'fairway'; }
  for (const g of GREENS) { const d = greenD(g, x, z); if (d < 1) return 'green'; if (d < 1 + FRINGE / g.r) return 'fairway'; }
  const h = fwHalf(z, 0);
  if (h > 0 && Math.abs(x - fwCenter(z)) < h) return 'fairway';
  return 'rough';
}

// ───────────────────────── colours ─────────────────────────
const lin = (hex: string) => new THREE.Color(hex); // THREE.Color converts sRGB hex to linear
const COL = {
  rough: lin('#33561f'), roughDry: lin('#6a7334'), meadow: lin('#4a6b2c'), cut: lin('#377232'),
  fwDark: lin('#3f7a28'), fwLight: lin('#6ca438'), fringe: lin('#3f8833'),
  green: lin('#5ea341'), greenLight: lin('#72b04a'), tee: lin('#4a8a32'), teeLight: lin('#5a9a3a'),
  sand: lin('#f1e8d2'), sandDark: lin('#d2c39f'), lip: lin('#2f5f1c'), forest: lin('#1d3313'), forestLeaf: lin('#1b3412'), forestLeafLight: lin('#3f5f22'),
};
const v3 = (c: THREE.Color) => `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;

/** CPU approximation of the ground shader's colour (used to tint grass blades so they sit in the turf) */
function groundColorCPU(x: number, z: number, out: THREE.Color): THREE.Color {
  const s = surfaceAt(x, z);
  const band = (Math.floor(z / (2 * 9.144) + 0.5) & 1) ? 1 : 0;
  const lane = (Math.floor(x / 9.0 + 0.5) & 1) ? 1 : 0;
  if (s === 'tee') out.copy(COL.tee).lerp(COL.teeLight, ((Math.floor((x + z) / 1.6) & 1) ? 0.6 : 0.1));
  else if (s === 'green') out.copy(COL.green);
  else if (s === 'bunker') out.copy(COL.sand);
  else if (s === 'fairway') out.copy(COL.fwDark).lerp(COL.fwLight, 0.65 * band + 0.35 * lane);
  else {
    const h = fwHalf(z, FIRST_CUT);
    if (h > 0 && Math.abs(x - fwCenter(z)) < h) out.copy(COL.cut);
    else out.copy(COL.rough).lerp(COL.roughDry, smooth(0.55, 0.8, fbm(x / 30, z / 30, 2)) * 0.4);
  }
  return out;
}

// ───────────────────────── textures ─────────────────────────
/** Seamless value-noise data: R fine, G medium, B large blotches, A grain. Shared by the GPU texture and CPU lookups. */
const NOISE_N = 256;
let noiseCache: Uint8Array | null = null;
function noiseData(): Uint8Array {
  if (noiseCache) return noiseCache;
  const N = NOISE_N, data = new Uint8Array(N * N * 4);
  const per = (x: number, y: number, period: number, s: number) => {
    // periodic value noise: lattice wraps at `period`
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const h = (a: number, b: number) => hash2(((a % period) + period) % period + s, ((b % period) + period) % period - s);
    const a = h(i, j), b = h(i + 1, j), c = h(i, j + 1), d = h(i + 1, j + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  const oct = (x: number, y: number, base: number, s: number) => {
    let sum = 0, amp = 0.5, tot = 0;
    for (let k = 0, p = base; k < 4; k++, p *= 2) { sum += amp * per(x * p / N, y * p / N, p, s + k * 31); tot += amp; amp *= 0.5; }
    return sum / tot;
  };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const o = (y * N + x) * 4;
    data[o] = Math.round(oct(x, y, 16, 3) * 255);
    data[o + 1] = Math.round(oct(x, y, 6, 11) * 255);
    data[o + 2] = Math.round(oct(x, y, 3, 23) * 255);
    data[o + 3] = Math.round(hash2(x * 7 + 1, y * 13 + 5) * 255);
  }
  return (noiseCache = data);
}
// Woodland map: a non-repeating fbm baked into a texture over the whole world (12 m per texel),
// sampled by the ground shader and, identically, by the CPU when placing trees and building the canopy.
const FMAP_N = 512, FMAP_X0 = -3100, FMAP_Z0 = -3400, FMAP_SIZE = 6200;
let fmapCache: Uint8Array | null = null;
function forestMapData(): Uint8Array {
  if (fmapCache) return fmapCache;
  const d = new Uint8Array(FMAP_N * FMAP_N);
  for (let j = 0; j < FMAP_N; j++) for (let i = 0; i < FMAP_N; i++) {
    const x = FMAP_X0 + (i + 0.5) / FMAP_N * FMAP_SIZE, z = FMAP_Z0 + (j + 0.5) / FMAP_N * FMAP_SIZE;
    d[j * FMAP_N + i] = Math.round(clamp(fbm(x / 300 + 11.3, z / 300 - 4.7, 4) * 1.15 - 0.07, 0, 1) * 255);
  }
  return (fmapCache = d);
}
function forestRaw(x: number, z: number): number {
  const d = forestMapData(), N = FMAP_N;
  const u = (x - FMAP_X0) / FMAP_SIZE * N - 0.5, v = (z - FMAP_Z0) / FMAP_SIZE * N - 0.5;
  const i = clamp(Math.floor(u), 0, N - 2), j = clamp(Math.floor(v), 0, N - 2), fx = clamp(u - i, 0, 1), fy = clamp(v - j, 0, 1);
  const at = (a: number, b: number) => d[b * N + a] / 255;
  return (at(i, j) * (1 - fx) + at(i + 1, j) * fx) * (1 - fy) + (at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx) * fy;
}
/** 0..1: where the woods are thick (outside the playing corridor) */
const forestAt = (x: number, z: number) => smooth(0.5, 0.6, forestRaw(x, z));
function makeForestTexture(): THREE.DataTexture {
  const t = new THREE.DataTexture(forestMapData(), FMAP_N, FMAP_N, THREE.RedFormat);
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter; t.generateMipmaps = false;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}
function makeNoiseTexture(renderer: THREE.WebGLRenderer): THREE.DataTexture {
  const N = NOISE_N, data = noiseData();
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  t.needsUpdate = true;
  return t;
}

/**
 * Turf detail: a seamless top-down picture of cut grass at ~1 px ≈ 1 mm, stored as multiplicative factors
 * (128 = ×1.0) so the ground shader keeps its own colours and just gains real blade structure close up.
 * RGB = colour factor, A = height (for the micro-normal).
 */
function makeTurfTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  const N = 512, cv = document.createElement('canvas'); cv.width = cv.height = N;
  const g = cv.getContext('2d')!;
  const save = seed; seed = 77123;
  g.fillStyle = 'rgb(104,110,100)'; g.fillRect(0, 0, N, N);
  // soil/thatch shadows between the blades
  for (let i = 0; i < 3400; i++) { const x = rand() * N, y = rand() * N, r = 1.5 + rand() * 4; g.fillStyle = `rgba(40,46,34,${0.08 + rand() * 0.12})`; g.beginPath(); g.ellipse(x, y, r, r * 0.6, rand() * 3.14, 0, 7); g.fill(); }
  // clumps: soft patches a little lighter or darker, so blades don't look evenly sprinkled
  for (let i = 0; i < 120; i++) { const x = rand() * N, y = rand() * N, r = 14 + rand() * 40, l = rand() < 0.5 ? 150 : 96; const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, `rgba(${l},${l + 6},${l - 10},0.12)`); gr.addColorStop(1, `rgba(${l},${l},${l},0)`); for (const ox of [-N, 0, N]) for (const oy of [-N, 0, N]) { g.save(); g.translate(ox, oy); g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r); g.restore(); } }
  // blades: short curved strokes, lying a little toward one direction (cut grass leans), lighter tips
  g.lineCap = 'round';
  for (let i = 0; i < 52000; i++) {
    const x = rand() * N, y = rand() * N;
    const a = (rand() < 0.75 ? 0.6 : rand() * 6.28) + (rand() - 0.5) * 1.4;
    const L = 3 + rand() * 7, w = 0.7 + rand() * 1.0;
    const l = rand();
    const r = Math.round(100 + 60 * l + (rand() < 0.08 ? 25 : 0)), gg = Math.round(112 + 62 * l), b = Math.round(86 + 34 * l - (rand() < 0.1 ? 20 : 0));
    const dx = Math.cos(a) * L, dy = Math.sin(a) * L;
    for (const ox of [0, x + dx > N ? -N : x + dx < 0 ? N : 0]) for (const oy of [0, y + dy > N ? -N : y + dy < 0 ? N : 0]) {
      const gr = g.createLinearGradient(x + ox, y + oy, x + ox + dx, y + oy + dy);
      gr.addColorStop(0, `rgba(${r - 30},${gg - 26},${b - 22},0.9)`); gr.addColorStop(1, `rgba(${r + 22},${gg + 20},${b + 4},0.95)`);
      g.strokeStyle = gr; g.lineWidth = w;
      g.beginPath(); g.moveTo(x + ox, y + oy); g.quadraticCurveTo(x + ox + dx * 0.5 + dy * 0.15, y + oy + dy * 0.5 - dx * 0.15, x + ox + dx, y + oy + dy); g.stroke();
      if (!ox && !oy) break;
    }
  }
  // height in alpha: brighter = higher blade (luminance)
  const img = g.getImageData(0, 0, N, N), d = img.data;
  for (let i = 0; i < d.length; i += 4) d[i + 3] = Math.min(255, Math.round((d[i] + d[i + 1] * 2 + d[i + 2]) / 4 * 1.2));
  g.putImageData(img, 0, 0);
  seed = save;
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.premultiplyAlpha = false;
  return t;
}

// The Toronto Hunt crest, shared by the flags and the yardage boards (drawn in when it has loaded)
let crestImg: HTMLImageElement | null = null;
const crestWaiters: (() => void)[] = [];
function onCrest(f: () => void) {
  if (crestImg) { f(); return; }
  crestWaiters.push(f);
  if (crestWaiters.length === 1) {
    const im = new Image();
    im.onload = () => { crestImg = im; for (const w of crestWaiters.splice(0)) w(); };
    im.src = crestUrl;
  }
}
const FLAG_YELLOW = '#f2c21b';
/** yellow flag cloth: fine weave, a hem sleeve at the pole, stitched edges, the crest in the middle */
function makeFlagTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  const W = 512, H = 368, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d')!;
  const draw = () => {
    const save = seed; seed = 9911;
    g.fillStyle = FLAG_YELLOW; g.fillRect(0, 0, W, H);
    // weave
    for (let y = 0; y < H; y += 2) { g.fillStyle = `rgba(120,80,0,${0.03 + (y % 4 ? 0.02 : 0)})`; g.fillRect(0, y, W, 1); }
    for (let x = 0; x < W; x += 2) { g.fillStyle = 'rgba(255,240,180,0.035)'; g.fillRect(x, 0, 1, H); }
    for (let i = 0; i < 1800; i++) { g.fillStyle = `rgba(${rand() < 0.5 ? '90,60,0' : '255,245,200'},0.05)`; g.fillRect(rand() * W, rand() * H, 2 + rand() * 6, 1); }
    // sleeve at the pole and stitched hems
    const sl = g.createLinearGradient(0, 0, 30, 0); sl.addColorStop(0, 'rgba(110,70,0,0.35)'); sl.addColorStop(1, 'rgba(110,70,0,0)');
    g.fillStyle = sl; g.fillRect(0, 0, 30, H);
    g.strokeStyle = 'rgba(120,85,10,0.55)'; g.setLineDash([5, 4]); g.lineWidth = 1.6;
    g.strokeRect(9, 9, W - 18, H - 18); g.beginPath(); g.moveTo(30, 0); g.lineTo(30, H); g.stroke(); g.setLineDash([]);
    if (crestImg) {
      const ch = H * 0.8, cw = ch * crestImg.width / crestImg.height;
      g.drawImage(crestImg, W * 0.53 - cw / 2, H / 2 - ch / 2, cw, ch);
      // printed ink sits in the cloth: let the weave show through a little
      for (let y = 0; y < H; y += 2) { g.fillStyle = 'rgba(0,0,0,0.035)'; g.fillRect(0, y, W, 1); }
    }
    seed = save;
    t.needsUpdate = true;
  };
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  draw(); onCrest(draw);
  return t;
}

// Yardage boards: painted, slightly weathered boards. 4×4 cells of 512×256: 0..5 faces, 6 board back, 7 timber.
function makeSignAtlas(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  const cv = document.createElement('canvas'); cv.width = 2048; cv.height = 1024;
  const g = cv.getContext('2d')!;
  const cell = (i: number) => [(i % 4) * 512, Math.floor(i / 4) * 256] as const;
  const grain = (x: number, y: number, w: number, h: number, base: string, dark: string, planks: number) => {
    g.fillStyle = base; g.fillRect(x, y, w, h);
    for (let i = 0; i < 260; i++) { const yy = y + rand() * h; g.strokeStyle = dark; g.globalAlpha = 0.06 + rand() * 0.12; g.lineWidth = 0.6 + rand() * 1.6; g.beginPath(); g.moveTo(x, yy); g.bezierCurveTo(x + w * 0.3, yy + (rand() - 0.5) * 6, x + w * 0.7, yy + (rand() - 0.5) * 6, x + w, yy + (rand() - 0.5) * 4); g.stroke(); }
    g.globalAlpha = 1;
    for (let k = 1; k < planks; k++) { const yy = y + (h * k) / planks; g.fillStyle = 'rgba(0,0,0,0.28)'; g.fillRect(x, yy - 1.5, w, 3); g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(x, yy + 1.5, w, 1.5); }
  };
  const draw = () => {
    const save = seed; seed = 5150;
    GREENS.forEach((gr, i) => {
      const [x, y] = cell(i);
      // dark green frame, cream painted planks inside
      grain(x, y, 512, 256, '#1d3a26', '#0c1a10', 1);
      grain(x + 16, y + 16, 480, 224, '#efe9d8', '#8a7e64', 3);
      // weathering: faded patches, a few chips, grime toward the bottom
      for (let k = 0; k < 40; k++) { g.fillStyle = `rgba(${rand() < 0.5 ? '120,105,80' : '255,252,240'},${0.04 + rand() * 0.06})`; g.beginPath(); g.ellipse(x + 16 + rand() * 480, y + 16 + rand() * 224, 6 + rand() * 30, 3 + rand() * 10, 0, 0, 7); g.fill(); }
      const gm = g.createLinearGradient(0, y + 150, 0, y + 240); gm.addColorStop(0, 'rgba(70,60,40,0)'); gm.addColorStop(1, 'rgba(70,60,40,0.22)'); g.fillStyle = gm; g.fillRect(x + 16, y + 150, 480, 90);
      // numbers in the frame green, a little worn
      g.fillStyle = '#163021'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
      const nx = x + (crestImg ? 330 : 256);
      g.font = '700 132px Georgia, "Times New Roman", serif';
      g.fillText(String(gr.yards), nx, y + 178);
      g.font = '700 26px Georgia, "Times New Roman", serif';
      g.fillText('Y A R D S', nx, y + 218);
      if (crestImg) { const ch = 132, cw = ch * crestImg.width / crestImg.height; g.drawImage(crestImg, x + 36, y + 62, cw, ch); g.fillStyle = 'rgba(22,48,33,0.5)'; g.fillRect(x + 36 + cw + 14, y + 52, 3, 152); }
      for (let k = 0; k < 220; k++) { g.fillStyle = 'rgba(239,233,216,0.55)'; g.fillRect(x + 30 + rand() * 450, y + 40 + rand() * 190, 1 + rand() * 3, 1 + rand() * 2); }
    });
    const [bx, by] = cell(14); grain(bx, by, 512, 256, '#5a4430', '#2c1f14', 4);
    const [tx, ty] = cell(15); grain(tx, ty, 512, 256, '#4a3826', '#20160c', 1);
    seed = save;
    t.needsUpdate = true;
  };
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  draw(); onCrest(draw);
  return t;
}

// ───────────────────────── ground material ─────────────────────────
function groundMaterial(noise: THREE.Texture, forest: THREE.Texture, turf: THREE.Texture): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  const greens = GREENS.map(g => `vec4(${g.x.toFixed(3)}, ${g.z.toFixed(3)}, ${g.r.toFixed(3)}, ${g.p.toFixed(3)})`).join(', ');
  const bunkA = BUNKERS.map(b => `vec4(${b.x.toFixed(3)}, ${b.z.toFixed(3)}, ${b.rx.toFixed(3)}, ${b.rz.toFixed(3)})`).join(', ');
  const bunkB = BUNKERS.map(b => `vec2(${b.rot.toFixed(4)}, ${b.p.toFixed(3)})`).join(', ');
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNoise = { value: noise };
    sh.uniforms.uForest = { value: forest };
    sh.uniforms.uTurf = { value: turf };
    sh.uniforms.uFeat = FEAT_U;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNrm = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWPos;
varying vec3 vWNrm;
uniform sampler2D uNoise;
uniform sampler2D uForest;
uniform sampler2D uTurf;
uniform vec4 uFeat;
const vec4 GREENS[${GREENS.length}] = vec4[](${greens});
const vec4 BUNKA[${BUNKERS.length}] = vec4[](${bunkA});
const vec2 BUNKB[${BUNKERS.length}] = vec2[](${bunkB});
float fwCenter(float z) { return 3.0 * sin(z / 97.0) + 2.0 * sin(z / 41.0 + 1.3); }
float fwHalf(float z, float grow) {
  float s0 = ${FW_START.toFixed(1)} + grow, s1 = ${FW_END.toFixed(1)} - grow;
  if (z > s0 || z < s1) return -1.0;
  float h = 25.0 + 3.5 * sin(z / 53.0 + 0.4) + 2.0 * sin(z / 23.0 + 2.1) + grow;
  if (z > s0 - ${CAP0.toFixed(1)}) { float t = (z - (s0 - ${CAP0.toFixed(1)})) / ${CAP0.toFixed(1)}; h *= sqrt(max(0.0, 1.0 - t * t)); }
  if (z < s1 + ${CAP1.toFixed(1)}) { float t = (s1 + ${CAP1.toFixed(1)} - z) / ${CAP1.toFixed(1)}; h *= sqrt(max(0.0, 1.0 - t * t)); }
  return h;
}
// signed distance (m) to a fairway outline grown by \`grow\`; negative inside
float fwSD(vec2 p, float grow) { float h = fwHalf(p.y, grow); return h <= 0.0 ? 40.0 : abs(p.x - fwCenter(p.y)) - h; }
float teeSD(vec2 p) {
  vec2 q = abs(p - vec2(${TEE.cx.toFixed(1)}, ${TEE.cz.toFixed(1)})) - vec2(${(TEE.hx - TEE.r).toFixed(2)}, ${(TEE.hz - TEE.r).toFixed(2)});
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - ${TEE.r.toFixed(2)};
}
// anti-aliased "inside" mask for a distance-like value d crossing edge e
float inside(float d, float e) { float w = max(fwidth(d), 1e-4) * 0.75; return 1.0 - smoothstep(e - w, e + w, d); }
// anti-aliased stripe 0/1 with period 2 (bands of width 1 in units of x)
float stripes(float x) { float w = max(fwidth(x), 1e-4); float t = abs(fract(x * 0.5) - 0.5) * 2.0; return smoothstep(0.5 - w, 0.5 + w, t); }
float gRough = 1.0;
float gBump = 1.0;
float gSheen = 0.0;
vec3 gSandB = vec3(0.0);
// turf detail: two rotated scales so the tile never shows; returns a colour factor around 1.0
vec4 turfAt(vec2 p, float scale) {
  vec2 a = p * scale;
  vec2 b = mat2(0.799, -0.602, 0.602, 0.799) * p * (scale * 0.43) + 0.37;
  vec4 t1 = texture2D(uTurf, a, -0.5), t2 = texture2D(uTurf, b, -0.5);
  return mix(t1, t2, 0.42) * vec4(vec3(1.0 / 0.47), 1.0);
}
// tee box divots: elongated scars along the target line, denser in the hitting area, none under the ball or the feet
vec3 divotAt(vec2 p) { // x = coverage, y = 0 old (sand-seed) .. 1 fresh (soil), z = depth for the bump
  float cs = 0.3;
  vec2 cell = floor(p / cs);
  vec3 best = vec3(0.0);
  // yesterday's hitting lines: rows across the tee a couple of metres ahead and behind today's spot
  float row = max(1.0 - smoothstep(0.35, 0.9, abs(p.y + 2.6)), 0.7 * (1.0 - smoothstep(0.35, 0.9, abs(p.y - 3.4))));
  row = max(row, 0.5 * (1.0 - smoothstep(0.3, 0.8, abs(p.y + 4.8))));
  float dens = 0.012 + 0.3 * row * (1.0 - smoothstep(4.5, 6.0, abs(p.x)));
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 c = cell + vec2(float(i), float(j));
    float h = fract(sin(dot(c, vec2(127.1, 311.7))) * 43758.5453);
    if (h > dens) continue;
    float h2 = fract(h * 91.7 + 0.13), h3 = fract(h * 13.3 + 0.71);
    vec2 ctr = (c + 0.2 + 0.6 * vec2(h2, h3)) * cs;
    if (length(ctr) < 0.42 || (abs(ctr.x - 0.9) < 0.5 && abs(ctr.y) < 0.55)) continue;
    float a = (fract(h * 5.3) - 0.5) * 0.7;
    vec2 d = mat2(cos(a), -sin(a), sin(a), cos(a)) * (p - ctr);
    vec2 sz = vec2(0.016 + 0.008 * h2, 0.04 + 0.025 * h3);
    // a torn edge
    float e = length(d / sz) + 0.12 * sin(atan(d.y, d.x) * 7.0 + h * 30.0);
    float cov = 1.0 - smoothstep(0.82, 1.0, e);
    if (cov > best.x) best = vec3(cov, step(0.85, fract(h * 37.1)), 1.0 - e);
  }
  return best;
}
// mown grass: blades laid one way look light when you look along them and dark against them
vec2 viewXZ() { vec2 d = cameraPosition.xz - vWPos.xz; return d / max(length(d), 1e-3); }
float mowSheen(float stripe, vec2 mowAxis) { return (stripe * 2.0 - 1.0) * dot(viewXZ(), mowAxis); }
vec3 groundColor(vec2 p) {
  float n1 = texture2D(uNoise, p * 0.23).r;
  float n2 = texture2D(uNoise, p * 0.031).g;
  float n3 = texture2D(uNoise, p * 0.0041).b;
  float n4 = texture2D(uNoise, p * 1.7).a;
  float var = 0.5 * n1 + 0.3 * n2 + 0.2 * n3;
  // rough: dark, blotchy, a little sun-dried in places; beyond the corridor it becomes meadow,
  // drier on the high ground and on slopes
  vec3 col = mix(${v3(COL.rough)}, ${v3(COL.roughDry)}, smoothstep(0.5, 0.85, n2 * 0.6 + n3 * 0.55) * 0.5);
  float wild = clamp(smoothstep(45.0, 110.0, abs(p.x - fwCenter(p.y))) + smoothstep(-360.0, -420.0, p.y) + smoothstep(60.0, 110.0, p.y), 0.0, 1.0);
  float slope = 1.0 - clamp(vWNrm.y, 0.0, 1.0);
  vec3 meadow = mix(${v3(COL.meadow)}, ${v3(COL.roughDry)}, clamp(smoothstep(20.0, 140.0, vWPos.y) * 0.25 + slope * 0.8 + (n3 - 0.5) * 0.6, 0.0, 0.7));
  col = mix(col, meadow, wild * 0.85);
  // the big hills on the horizon are wooded: dark clumpy canopy with a few greener clearings and hedgerows
  float hill = smoothstep(560.0, 900.0, length(vec2(p.x * 0.85, (p.y + 160.0) * 0.62)));
  if (hill > 0.0) {
    float cl = texture2D(uNoise, p * 0.0026 + 0.31).g, cl2 = texture2D(uNoise, p * 0.012).r;
    float clearing = smoothstep(0.52, 0.62, cl * 0.8 + cl2 * 0.35);
    vec3 woods = mix(${v3(COL.forestLeaf)} * 0.9, ${v3(COL.forestLeafLight)}, smoothstep(0.3, 0.85, cl2)) * (0.75 + 0.5 * texture2D(uNoise, p * 0.05).r);
    vec3 field = mix(${v3(COL.meadow)} * 1.1, ${v3(COL.cut)}, cl2) * (0.9 + 0.2 * n2);
    col = mix(col, mix(woods, field, clearing), hill);
  }
  // forest floor: dark, shaded ground where the woods are thick, so distant trees read as woodland
  float fmask = smoothstep(0.5, 0.6, texture2D(uForest, (p - vec2(${FMAP_X0.toFixed(1)}, ${FMAP_Z0.toFixed(1)})) / ${FMAP_SIZE.toFixed(1)}).r);
  float outd = max(abs(p.x - fwCenter(p.y)) - 52.0, max(-p.y - 350.0, p.y - 60.0));
  col = mix(col, ${v3(COL.forest)} * (0.8 + 0.4 * n2), fmask * smoothstep(50.0, 75.0, outd) * 0.85);
  // the canopy mass itself: clumpy dark foliage, lighter crowns catching the sun
  float canopy = fmask * smoothstep(80.0, 135.0, outd);
  float clump = texture2D(uNoise, p * 0.085).r, clump2 = texture2D(uNoise, p * 0.021).g;
  vec3 leafc = mix(${v3(COL.forestLeaf)}, ${v3(COL.forestLeafLight)}, smoothstep(0.35, 0.8, clump * 0.7 + clump2 * 0.5));
  leafc *= 0.65 + 0.7 * clump;
  col = mix(col, leafc, smoothstep(0.15, 0.6, canopy));
  col *= 0.84 + 0.3 * var;
  // a soft lawn grain in the middle distance (where the blade picture has faded) and broad, gentle colour patches
  // so no stretch looks stamped out; the grain is faded where it would alias
  {
    float g1 = texture2D(uNoise, p * 0.9 + 0.17).a, g2 = texture2D(uNoise, p * 0.37).r;
    float alias = clamp(fwidth(p.x * 0.9) + fwidth(p.y * 0.9), 0.0, 1.0);
    col *= 1.0 + (0.09 * (g1 - 0.5) + 0.07 * (g2 - 0.5)) * (1.0 - alias);
    float macro = texture2D(uNoise, p * 0.0125 + 0.61).b;
    col *= vec3(1.0 + 0.06 * (macro - 0.5), 1.0 + 0.03 * (macro - 0.5), 1.0 - 0.04 * (macro - 0.5));
  }
  // first cut ring
  float cut = inside(fwSD(p, ${FIRST_CUT.toFixed(1)}), 0.0);
  col = mix(col, ${v3(COL.cut)} * (0.88 + 0.22 * var), cut);
  gRough = 1.0;
  // fairway with mowing stripes across the line and fainter lanes along it
  float fw = inside(fwSD(p, 0.0), 0.0);
  // bold diagonal mowing stripes, with fainter straight lanes down the line
  float across = stripes((p.y * 0.86 + p.x * 0.5) / 7.5 + 0.5 + 0.02 * sin(p.x / 4.3 + p.y * 0.05)), along = stripes(p.x / 9.0 + 0.5 + 0.03 * sin(p.y / 17.0));
  vec3 fwc = mix(${v3(COL.fwDark)}, ${v3(COL.fwLight)}, 0.5 + 0.24 * (across - 0.5));
  fwc *= 1.0 + 0.22 * mowSheen(across, vec2(0.5, 0.86)) + 0.06 * mowSheen(along, vec2(1.0, 0.0));
  fwc *= 0.9 + 0.18 * (0.6 * n1 + 0.4 * n2);
  col = mix(col, fwc, fw);
  gRough = mix(gRough, 0.92, fw);
#ifndef LOW_DETAIL
  // divot scars where shots land: mostly filled with pale sand-and-seed, a few fresh; faded out before they alias
  if (fw > 0.5 && p.y < -40.0 && fwidth(p.x) < 0.06) {
    vec2 sc = floor(p / 0.8);
    float hs = fract(sin(dot(sc, vec2(91.7, 37.3))) * 43758.55);
    if (hs < 0.06) {
      vec2 c = (sc + 0.2 + 0.6 * vec2(fract(hs * 13.1), fract(hs * 7.7))) * 0.8;
      float ang = (fract(hs * 3.3) - 0.5) * 0.6;
      vec2 q = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * (p - c);
      float e = length(q / vec2(0.03, 0.065)) + 0.12 * sin(atan(q.y, q.x) * 7.0 + hs * 40.0);
      float cov = (1.0 - smoothstep(0.8, 1.0, e)) * (1.0 - smoothstep(0.03, 0.06, fwidth(p.x)));
      vec3 dc = mix(${v3(lin('#a39a72'))} * (0.9 + 0.2 * n1), ${v3(lin('#4a3a28'))}, step(0.8, fract(hs * 29.0)));
      col = mix(col, dc, cov * 0.7);
    }
  }
#endif
  // greens: fringe collar then the putting surface, both slightly raised in the mesh
  for (int i = 0; i < ${GREENS.length}; i++) {
    vec4 g = GREENS[i];
    vec2 d = p - g.xy;
    float a = atan(d.y, d.x);
    float gd = length(d) / (g.z * (1.0 + 0.11 * sin(2.0 * a + g.w) + 0.06 * sin(3.0 * a + 2.0 * g.w) + 0.03 * sin(5.0 * a + 3.0 * g.w)));
    if (gd > 1.6) continue;
    float fr = inside(gd, 1.0 + ${FRINGE.toFixed(2)} / g.z);
    // first cut: a band of slightly longer, darker grass outside the fringe collar
    col = mix(col, ${v3(COL.cut)} * (0.84 + 0.2 * n1), inside(gd, 1.0 + ${(FRINGE + 1.6).toFixed(2)} / g.z) * (1.0 - fr) * 0.85);
    col = mix(col, ${v3(COL.fringe)} * (0.92 + 0.14 * n1), fr);
    float gm = inside(gd, 1.0);
    vec3 gc = mix(${v3(COL.green)}, ${v3(COL.greenLight)}, 0.35);
    gc *= 1.0 + 0.11 * mowSheen(stripes(p.y / 2.8), vec2(0.0, 1.0)) + 0.05 * mowSheen(stripes(p.x / 2.8), vec2(1.0, 0.0));
    gc *= 0.95 + 0.08 * n1;
#ifndef LOW_DETAIL
    // pitch marks round the hole: small dark pits with a lifted rim, only where they would not alias
    if (gd < 0.7) {
      vec2 bc = floor(d / 0.45);
      float hb = fract(sin(dot(bc + g.w, vec2(41.3, 289.1))) * 43758.55);
      if (hb < 0.22) {
        vec2 c = (bc + 0.25 + 0.5 * vec2(fract(hb * 17.0), fract(hb * 31.0))) * 0.45;
        float r = length(d - c);
        float pit = 1.0 - smoothstep(0.008, 0.014, r), rim = smoothstep(0.009, 0.013, r) * (1.0 - smoothstep(0.013, 0.02, r));
        gc *= 1.0 - (0.35 * pit - 0.12 * rim) * (1.0 - smoothstep(0.004, 0.012, fwidth(p.x)));
      }
    }
#endif
    // the cut edge of the turf right round the hole, and a crisp darker line where the putting surface meets the fringe
    float hr = length(d);
    gc *= 1.0 - 0.35 * (1.0 - smoothstep(0.054, 0.066, hr));
    gc *= 1.0 - 0.12 * smoothstep(0.93, 1.0, gd) * gm;
    col = mix(col, gc, gm);
    gRough = mix(gRough, 0.74, gm);
    gBump = mix(gBump, 0.28, gm);
    gSheen = max(gSheen, gm);
  }
  // the featured green (moves with the club in hand): same fringe, putting surface and hole collar
  if (uFeat.w > 0.0) {
    vec2 d = p - uFeat.xy;
    float a = atan(d.y, d.x);
    float gd = length(d) / (uFeat.z * (1.0 + 0.06 * sin(2.0 * a + 1.1) + 0.04 * sin(3.0 * a + 2.3)));
    if (gd < 1.8) {
      col = mix(col, ${v3(COL.fringe)} * (0.92 + 0.14 * n1), inside(gd, 1.0 + ${FRINGE.toFixed(2)} / uFeat.z) * uFeat.w);
      // painted target ring on the fairway round it (reads from the tee and from the overhead aim view)
      float rm = abs(gd * uFeat.z - (uFeat.z + ${FRINGE.toFixed(2)} + 1.4));
      col = mix(col, vec3(0.78, 0.8, 0.74) * (0.92 + 0.1 * n1), inside(rm, 0.16) * uFeat.w * 0.9);
      float gm = inside(gd, 1.0) * uFeat.w;
      vec3 gc = mix(${v3(COL.green)}, ${v3(COL.greenLight)}, 0.7) * 1.06;
      gc *= 1.0 + 0.11 * mowSheen(stripes(p.y / 2.8), vec2(0.0, 1.0)) + 0.05 * mowSheen(stripes(p.x / 2.8), vec2(1.0, 0.0));
      gc *= 0.95 + 0.08 * n1;
      gc *= 1.0 - 0.35 * (1.0 - smoothstep(0.054, 0.066, length(d)));
      gc *= 1.0 - 0.12 * smoothstep(0.93, 1.0, gd);
      col = mix(col, gc, gm);
      gRough = mix(gRough, 0.74, gm);
      gBump = mix(gBump, 0.28, gm);
      gSheen = max(gSheen, gm);
    }
  }
  // bunkers: dark grass lip, then raked sand
  for (int i = 0; i < ${BUNKERS.length}; i++) {
    vec4 b = BUNKA[i]; vec2 bb = BUNKB[i];
    vec2 d = p - b.xy; float c = cos(bb.x), s = sin(bb.x);
    vec2 uv = vec2((d.x * c + d.y * s) / b.z, (-d.x * s + d.y * c) / b.w);
    float a = atan(uv.y, uv.x);
    float bd = length(uv) / (1.0 + 0.1 * sin(3.0 * a + bb.y) + 0.06 * sin(5.0 * a + bb.y * 1.7)
      + 0.32 * pow(0.5 + 0.5 * sin(5.0 * a + bb.y * 2.3), 6.0) - 0.2 * pow(0.5 + 0.5 * sin(3.0 * a + bb.y * 4.1), 10.0));
    if (bd > 1.4) continue;
    col = mix(col, ${v3(COL.lip)} * (0.9 + 0.2 * n1), inside(bd, 1.13) * 0.85);
    float sm = inside(bd + (n1 - 0.5) * 0.025, 1.0);
    vec3 sc = mix(${v3(COL.sand)}, ${v3(COL.sandDark)}, smoothstep(0.78, 1.0, bd) * 0.55);
    // rake lines along the bunker's long axis, wandering a little; faded out where they would alias
    vec2 luv = uv * b.zw;
    float rakeF = luv.y * 14.0 + 0.7 * sin(luv.x * 0.8 + bb.y) + 0.25 * sin(luv.x * 2.7 + bb.y * 3.0);
    float rakeFade = (1.0 - smoothstep(0.2, 0.5, fwidth(rakeF))) * (1.0 - smoothstep(0.82, 0.97, bd));
    float rk = sin(rakeF * 6.2832);
    sc *= 0.88 + 0.08 * n4 + 0.07 * n1 + 0.06 * rk * rakeFade;
    // footprints and scuffs: soft darker dents
    sc *= 1.0 - 0.07 * smoothstep(0.7, 0.85, texture2D(uNoise, p * 0.6 + bb.y).g);
    // the grass lip overhangs the sand: a thin dark band of shadow just inside the edge
    sc *= 1.0 - 0.32 * smoothstep(0.9, 1.0, bd);
    gSandB += vec3(-s, 0.0, c) * cos(rakeF * 6.2832) * 0.16 * rakeFade * sm;
    col = mix(col, sc, sm);
    gRough = mix(gRough, 1.0, sm);
    gBump = mix(gBump, 0.5, sm);
  }
  // tee box: short diagonal-cut turf
  float tm = inside(teeSD(p), 0.0);
  vec3 tc = mix(${v3(COL.tee)}, ${v3(COL.teeLight)}, 0.45);
  // tee: a crisp diagonal cross-cut, each pass light one way and dark the other
  tc *= 1.0 + 0.06 * mowSheen(stripes(p.x / 1.75), vec2(1.0, 0.0)) + 0.025 * mowSheen(stripes(p.y / 1.75), vec2(0.0, 1.0));
  tc *= 0.95 + 0.08 * n1 + 0.04 * n2;
  // tee box wear: a few lighter scuffs and divots near the ball
  float wear = smoothstep(0.62, 0.8, texture2D(uNoise, p * 0.9 + 3.1).g) * (1.0 - smoothstep(1.5, 4.0, length(p - vec2(0.3, -0.6))));
  tc = mix(tc, ${v3(COL.roughDry)} * 0.9, wear * 0.12);
  // feet and carts wear the turf thin round the tee markers
  for (int m = 0; m < 2; m++) {
    vec2 mp = m == 0 ? vec2(-3.4, -1.3) : vec2(4.3, -1.1);
    float dm = length((p - mp) * vec2(1.0, 1.4));
    tc = mix(tc, ${v3(COL.roughDry)} * 0.85, (1.0 - smoothstep(0.25, 0.95, dm)) * 0.32 * (0.6 + 0.4 * n1));
  }
  // divots: old ones filled with a pale sand-and-seed mix with green coming through, fresh ones dark soil
#ifdef LOW_DETAIL
  vec3 dv = vec3(0.0);
#else
  vec3 dv = divotAt(p);
#endif
  if (dv.x > 0.0) {
    vec3 sandSeed = mix(${v3(lin('#a39a72'))}, ${v3(COL.teeLight)}, 0.25 + 0.35 * n4) * (0.9 + 0.2 * n1);
    vec3 soil = mix(${v3(lin('#4a3a28'))}, ${v3(lin('#6b5a3c'))}, n4);
    tc = mix(tc, mix(sandSeed, soil, dv.y), dv.x * mix(0.6, 0.85, dv.y));
  }
  col = mix(col, tc, tm);
  gRough = mix(gRough, 0.9, tm);
  gBump = mix(gBump, 0.75, tm);
  // close up: real blade structure from the turf picture (shorter turf on the tee/greens = finer)
  float camD = length(vWPos - cameraPosition);
  float nearF = 1.0 - smoothstep(6.0, 60.0, camD);
  if (nearF > 0.0) {
    float sc = mix(0.62, 0.95, max(tm, gBump < 0.4 ? 1.0 : 0.0));
    vec3 tf = turfAt(p, sc).rgb;
    col *= mix(vec3(1.0), tf * tf, nearF * mix(0.85, 0.5, 1.0 - gBump));
  }
  return col;
}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= groundColor(vWPos.xz);')
      // fine turf bump near the camera so close-up grass catches the light unevenly
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
#ifndef LOW_DETAIL
{
  float fadeB = 1.0 - smoothstep(4.0, 35.0, length(vWPos - cameraPosition));
  if (fadeB > 0.0) {
    vec2 q = vWPos.xz;
    float e = 0.004;
    float h0 = turfAt(q, 0.7).a, hx = turfAt(q + vec2(e, 0.0), 0.7).a, hz = turfAt(q + vec2(0.0, e), 0.7).a;
    vec3 wb = vec3(h0 - hx, 0.0, h0 - hz) * 2.2 * fadeB * gBump + gSandB;
    normal = normalize(normal + (viewMatrix * vec4(wb, 0.0)).xyz);
  }
}
#endif`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;')
      // turf is a poor mirror: damp the sky sheen that makes grass look plastic at grazing angles
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n// greens keep a soft putting-surface sheen\nreflectedLight.directSpecular *= mix(0.3, 0.5, gSheen);\nreflectedLight.indirectSpecular *= mix(0.25, 0.32, gSheen);');
  };
  m.customProgramCacheKey = () => 'range-ground-v12';
  return m;
}

// ───────────────────────── terrain mesh ─────────────────────────
/** axis samples: dense (step) inside [lo,hi], then growing geometrically out to ±limit */
function axis(lo: number, hi: number, step: number, minV: number, maxV: number, grow = 1.11): number[] {
  const out: number[] = [];
  for (let v = lo; v <= hi + 1e-6; v += step) out.push(v);
  let s = step, v = lo; const left: number[] = [];
  while (v > minV) { s *= grow; v -= s; left.push(Math.max(v, minV)); }
  s = step; v = out[out.length - 1];
  while (v < maxV) { s *= grow; v += s; out.push(Math.min(v, maxV)); }
  return left.reverse().concat(out);
}
/** The terrain as a grid of chunks (dense in the playing corridor), so the camera and frustum culling skip what is off screen. */
function terrainChunks(detail: Detail = 'high'): THREE.BufferGeometry[] {
  const coarse = detail === 'low', fine = detail === 'high' ? 0.5 : 1.0;
  // 2 m everywhere in the corridor, 0.5 m over the bunkers so their lips and faces are crisp
  const refine = (arr: number[], spans: [number, number][]) => {
    let out = arr.filter(v => !spans.some(([a, b]) => v > a && v < b));
    for (const [a, b] of spans) for (let v = a; v <= b + 1e-6; v += fine) out.push(v);
    out = [...new Set(out.map(v => Math.round(v * 1000) / 1000))].sort((a, b) => a - b);
    return out;
  };
  // low detail: 3 m in the corridor, no bunker refinement, faster growth outward (about a third of the triangles)
  const xs = coarse ? axis(-111, 111, 3, -5200, 5200, 1.2) : refine(axis(-110, 110, 2, -5200, 5200, 1.13), BUNKERS.map(b => [Math.floor(b.x - b.rx * 1.7), Math.ceil(b.x + b.rx * 1.7)]));
  const zs = coarse ? axis(-372, 60, 3, -5600, 4200, 1.2) : refine(axis(-372, 60, 2, -5600, 4200, 1.13), BUNKERS.map(b => [Math.floor(b.z - b.rx * 1.7), Math.ceil(b.z + b.rx * 1.7)]));
  const nx = xs.length, nz = zs.length;
  const pos = new Float32Array(nx * nz * 3), nrm = new Float32Array(nx * nz * 3), v = new THREE.Vector3();
  let k = 0;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const x = xs[i], z = zs[j];
    pos[k] = x; pos[k + 1] = rawHeight(x, z); pos[k + 2] = z;
    // smooth analytic normals (face-averaged ones show the grid as facets on the raised greens)
    const ex = Math.max(0.5, (xs[Math.min(i + 1, nx - 1)] - xs[Math.max(i - 1, 0)]) / 4);
    const ez = Math.max(0.5, (zs[Math.min(j + 1, nz - 1)] - zs[Math.max(j - 1, 0)]) / 4);
    v.set((rawHeight(x - ex, z) - rawHeight(x + ex, z)) / (2 * ex), 1, (rawHeight(x, z - ez) - rawHeight(x, z + ez)) / (2 * ez)).normalize();
    nrm[k] = v.x; nrm[k + 1] = v.y; nrm[k + 2] = v.z;
    k += 3;
  }
  const near = (arr: number[], val: number) => arr.reduce((best, a, i) => Math.abs(a - val) < Math.abs(arr[best] - val) ? i : best, 0);
  const cx = [0, near(xs, -110), near(xs, 110), nx - 1];
  const cz = [0, near(zs, -372), near(zs, -150), near(zs, 60), nz - 1];
  const out: THREE.BufferGeometry[] = [];
  for (let a = 0; a < cx.length - 1; a++) for (let b = 0; b < cz.length - 1; b++) {
    const i0 = cx[a], i1 = cx[a + 1], j0 = cz[b], j1 = cz[b + 1], w = i1 - i0 + 1, h = j1 - j0 + 1;
    const P = new Float32Array(w * h * 3), N = new Float32Array(w * h * 3);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const src = ((j0 + j) * nx + (i0 + i)) * 3, dst = (j * w + i) * 3;
      P[dst] = pos[src]; P[dst + 1] = pos[src + 1]; P[dst + 2] = pos[src + 2];
      N[dst] = nrm[src]; N[dst + 1] = nrm[src + 1]; N[dst + 2] = nrm[src + 2];
    }
    const idx = new Uint32Array((w - 1) * (h - 1) * 6);
    let q = 0;
    for (let j = 0; j < h - 1; j++) for (let i = 0; i < w - 1; i++) {
      const p0 = j * w + i, p1 = p0 + 1, p2 = p0 + w, p3 = p2 + 1;
      idx[q++] = p0; idx[q++] = p2; idx[q++] = p1;
      idx[q++] = p1; idx[q++] = p2; idx[q++] = p3;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    out.push(g);
  }
  return out;
}

function teeBoxGeometry(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const x0 = TEE.cx - TEE.hx, x1 = TEE.cx + TEE.hx, y0 = -(TEE.cz + TEE.hz), y1 = -(TEE.cz - TEE.hz), r = TEE.r - 0.08;
  s.moveTo(x0 + r, y0); s.lineTo(x1 - r, y0); s.quadraticCurveTo(x1, y0, x1, y0 + r);
  s.lineTo(x1, y1 - r); s.quadraticCurveTo(x1, y1, x1 - r, y1);
  s.lineTo(x0 + r, y1); s.quadraticCurveTo(x0, y1, x0, y1 - r);
  s.lineTo(x0, y0 + r); s.quadraticCurveTo(x0, y0, x0 + r, y0);
  const depth = 0.8, bev = 0.12;
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: bev, bevelSize: 0.32, bevelSegments: 6, curveSegments: 6 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, -(depth + bev), 0);
  g.deleteAttribute('uv');
  g.computeVertexNormals();
  return g;
}

// ───────────────────────── the cup ─────────────────────────
// 108 mm hole: 25 mm of soil and roots, then the white liner's rim, the liner, a dark bottom. Drawn as a real hole:
// a mask disc pushes the depth to the far plane right after the terrain, then the inside of the cup is drawn into it.
const CUP = { HR: 0.054, LIP: 0.025, DEEP: 0.102, UP: 0.012 };
/** [lip wall, liner wall, rim, bottom] at the origin (walls are seen from inside), and the mask disc */
function cupGeometries(): { parts: THREE.BufferGeometry[]; mask: THREE.BufferGeometry } {
  const { HR, LIP, DEEP, UP } = CUP;
  // the terrain mesh can sit a few mm off the analytic height, so the mask floats just above it and the
  // soil lip reaches up to the mask (every ray through the mask then lands on the inside of the cup)
  const lip = new THREE.CylinderGeometry(HR, HR, LIP + UP, 32, 1, true); lip.translate(0, (UP - LIP) / 2, 0);
  const liner = new THREE.CylinderGeometry(HR - 0.002, HR - 0.002, DEEP - LIP, 32, 1, true); liner.translate(0, -LIP - (DEEP - LIP) / 2, 0);
  const rim = new THREE.RingGeometry(HR - 0.0075, HR, 32); rim.rotateX(-Math.PI / 2); rim.translate(0, -LIP, 0);
  const bottom = new THREE.CircleGeometry(HR, 32); bottom.rotateX(-Math.PI / 2); bottom.translate(0, -DEEP, 0);
  for (const w of [lip, liner]) { const n = w.getAttribute('normal') as THREE.BufferAttribute; for (let v = 0; v < n.count; v++) n.setXYZ(v, -n.getX(v), -n.getY(v), -n.getZ(v)); }
  const ao = (y: number) => 0.3 + 0.7 * Math.pow(clamp(1 + y / DEEP, 0, 1), 1.6); // darker toward the bottom
  const mask = new THREE.CircleGeometry(HR, 32); mask.rotateX(-Math.PI / 2); mask.translate(0, UP, 0);
  return {
    parts: [
      paint(lip, (x, y, z, _a, _b, _c, c) => c.copy(lin('#4a3826')).lerp(lin('#3f5a22'), clamp(1 + y / 0.008, 0, 1) * 0.8).multiplyScalar(y > 0 ? 0.6 : 1).multiplyScalar(ao(y) * (0.8 + 0.4 * hash2(Math.round(Math.atan2(z, x) * 30), 3)))),
      paint(liner, (_x, y, _z, _a, _b, _c, c) => c.copy(lin('#efefea')).multiplyScalar(ao(y))),
      paint(rim, (_x, _y, _z, _a, _b, _c, c) => c.copy(lin('#f6f6f2'))),
      paint(bottom, (_x, _y, _z, _a, _b, _c, c) => c.copy(lin('#2a2a26')).multiplyScalar(0.35)),
    ],
    mask,
  };
}
/** real proportions near the tee (7 ft stick, 20 x 14 in flag); far pins grow a little so they still read from the tee */
function pinScale(yards: number) {
  const far = Math.max(0, yards - 90);
  return { k: 1 + far / 900, kf: 1 + far / 380 };
}
/** a flagstick (from 8 cm down in the cup), its top ferrule and the crest flag, at the origin */
function pinGeometries(H: number, fw: number, fh: number, pr: number, k: number, kf: number, phase: number) {
  const pole = new THREE.CylinderGeometry(pr, pr * 1.08, H, 16, 1, false); pole.translate(0, H / 2 - 0.08, 0);
  const tip = new THREE.CylinderGeometry(pr * 1.5, pr * 1.3, 0.05 * k, 10); tip.translate(0, H - 0.08 + 0.02 * k, 0);
  // flag: hangs from the top of the pole, streams with the wind (toward +x, slightly away)
  const flag = new THREE.PlaneGeometry(fw, fh, 18, 8); flag.translate(fw / 2 + pr, 0, 0);
  flag.rotateY(-0.25);
  flag.translate(0, H - 0.08 - fh / 2 - 0.03 * kf, 0);
  const n = flag.getAttribute('position').count;
  flag.setAttribute('aPhase', new THREE.BufferAttribute(new Float32Array(n).fill(phase), 1));
  flag.setAttribute('aLen', new THREE.BufferAttribute(new Float32Array(n).fill(fw), 1));
  flag.setAttribute('aH', new THREE.BufferAttribute(new Float32Array(n).fill(fh), 1));
  // the pole's axis at the top of the flag's hoist (the shader rebuilds the cloth from here, so the wind can turn it)
  const pole3 = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { pole3[i * 3] = 0; pole3[i * 3 + 1] = H - 0.08 - 0.03 * kf; pole3[i * 3 + 2] = 0; }
  flag.setAttribute('aPole', new THREE.BufferAttribute(pole3, 3));
  // the base ferrule, seated in the bottom of the cup
  const fer = new THREE.CylinderGeometry(pr * 1.35, pr * 1.2, 0.045, 12); fer.translate(0, -CUP.DEEP + 0.0225, 0);
  return { pole, tip, flag, fer };
}

// ───────────────────────── trees ─────────────────────────
function paint(g: THREE.BufferGeometry, fn: (x: number, y: number, z: number, nx: number, ny: number, nz: number, out: THREE.Color) => void): THREE.BufferGeometry {
  const p = g.getAttribute('position'), n = g.getAttribute('normal');
  const col = new Float32Array(p.count * 3), c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    fn(p.getX(i), p.getY(i), p.getZ(i), n.getX(i), n.getY(i), n.getZ(i), c);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
const n3 = (x: number, y: number, z: number) => Math.sin(x * 3.1 + 1.7) * Math.sin(y * 2.7 + 0.3) * Math.sin(z * 3.3 + 2.1) + 0.5 * Math.sin(x * 7.3 + z * 5.1 + y * 4.7);
/** a lumpy foliage blob; normals bend outward from the whole canopy so it shades softly */
function blob(cx: number, cy: number, cz: number, r: number, sy: number, detail: number, canopyC: THREE.Vector3, leaf: THREE.Color, canopyBottom: number, canopyTop: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + 0.2 * n3(x / r * 1.3 + cx, y / r * 1.3 + cy, z / r * 1.3 + cz);
    p.setXYZ(i, cx + x * k, cy + y * k * sy, cz + z * k);
  }
  g.computeVertexNormals();
  // smooth, soft normals: half from the lump's own centre, half from the whole canopy's centre
  const nrm = g.getAttribute('normal'), tmp = new THREE.Vector3(), out = new THREE.Vector3(), fn = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    out.set(p.getX(i), p.getY(i), p.getZ(i)).sub(canopyC).normalize();
    fn.set(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
    tmp.set(p.getX(i) - cx, (p.getY(i) - cy) / sy, p.getZ(i) - cz).normalize().multiplyScalar(0.45).addScaledVector(out, 0.55).addScaledVector(fn, 0.12).normalize();
    nrm.setXYZ(i, tmp.x, tmp.y, tmp.z);
  }
  return paint(g, (x, y, z, nx, ny, nz, c) => {
    const h = clamp((y - canopyBottom) / (canopyTop - canopyBottom), 0, 1);
    const outward = new THREE.Vector3(x - canopyC.x, (y - canopyC.y) * 0.8, z - canopyC.z).normalize();
    const ao = 0.32 + 0.5 * h + 0.3 * Math.max(0, outward.dot(new THREE.Vector3(nx, ny, nz)));
    const tint = 0.85 + 0.3 * (0.5 + 0.5 * n3(x * 0.9, y * 0.9, z * 0.9));
    c.copy(leaf).multiplyScalar(ao * tint);
  });
}
function finish(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const clean = parts.map(g => { const n = g.index ? g.toNonIndexed() : g; for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'color') n.deleteAttribute(k); return n; });
  const m = mergeGeometries(clean, false)!;
  m.computeBoundingSphere();
  return m;
}
function farTreeGeo(kind = 0, cheap = false): THREE.BufferGeometry {
  const trunk = (h: number) => { const t = new THREE.CylinderGeometry(0.18, 0.3, h, 5, 1, true).toNonIndexed(); t.translate(0, h / 2, 0); return paint(t, (_x, _y, _z, _a, _b, _c, c) => c.copy(lin('#3a2f24'))); };
  if (kind === 1) {
    // conifer: three stacked, slightly ragged cones, darker blue-green
    const leaf = lin('#24412a'), C = new THREE.Vector3(0, 7, 0), parts = [trunk(2)];
    [[2.6, 5.5, 2.2], [2.0, 4.6, 5.2], [1.3, 3.8, 8.0]].forEach(([r, h, y], i) => {
      const c = new THREE.ConeGeometry(r, h, 7, 1, true).toNonIndexed();
      const p = c.getAttribute('position');
      for (let v = 0; v < p.count; v++) { const a = Math.atan2(p.getZ(v), p.getX(v)); const k = 1 + 0.18 * Math.sin(a * 3 + i * 2.1) * (p.getY(v) < 0 ? 1 : 0); p.setXYZ(v, p.getX(v) * k, p.getY(v), p.getZ(v) * k); }
      c.translate(0, y + h / 2, 0); c.computeVertexNormals();
      parts.push(paint(c, (x, yy, z, nx, ny, nz, col) => { const ao = 0.45 + 0.55 * clamp((yy - 1) / 11, 0, 1); col.copy(leaf).multiplyScalar(ao * (0.85 + 0.25 * Math.max(0, nx * 0.6 + ny * 0.5 - nz * 0.3))); }));
      void C;
    });
    return finish(parts);
  }
  // broadleaf: four low-poly lumps around a crown, so the silhouette is ragged rather than a ball
  const leaf = lin('#3a5f28'), C = new THREE.Vector3(0, 6, 0);
  const lumps: [number, number, number, number][] = [[0, 6.3, 0, 2.7], [1.6, 5.4, 0.6, 2.1], [-1.4, 5.6, -0.8, 2.2], [0.3, 7.6, -0.5, 1.8]];
  // cheap (low detail): two bigger lumps, about half the triangles
  const use: [number, number, number, number][] = cheap ? [[0.2, 6.2, -0.2, 3.0], [1.0, 5.0, 0.6, 2.3]] : lumps;
  return finish([trunk(2.8), ...use.map(([x, y, z, r]) => blob(x, y, z, r, 1.05, cheap ? 0 : 1, C, leaf, 3.2, 9.5))]);
}

// ───────────────────────── card trees (alpha-tested foliage cards) ─────────────────────────
// Atlas (1024×512): broadleaf leaf cluster (u 0–0.5), pine needle spray (u 0.5–1, v 0.5–1),
// small-leaf cluster (u 0.5–0.75, v 0–0.5), and two opaque patches: bark and dark foliage core.
const UV_LEAF: [number, number, number, number] = [0.004, 0.004, 0.496, 0.996];
const UV_PINE: [number, number, number, number] = [0.504, 0.51, 0.996, 0.99];
const UV_SMALL: [number, number, number, number] = [0.504, 0.008, 0.746, 0.49];
const UV_BARK_RECT: [number, number, number, number] = [778 / 1024, 1 - 500 / 512, 852 / 1024, 1 - 268 / 512]; // u0, v0, u1, v1
const UV_BIRCH_RECT: [number, number, number, number] = [956 / 1024, 1 - 500 / 512, 1016 / 1024, 1 - 268 / 512];
function makeFoliageAtlas(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  // drawn in 1024×512 units at 2× resolution so leaf clusters stay crisp up close
  const cv = document.createElement('canvas'); cv.width = 2048; cv.height = 1024;
  const g = cv.getContext('2d')!;
  g.scale(2, 2);
  const R = () => rand();
  // painted leaf masses (hand-drawn realism): overlapping rounded leaf clusters, each lit from the top with a
  // darker underside, solid in the middle and scalloped, with a few see-through gaps, at the rim. Values stay clean
  // and broad so the crown reads as a few big volumes, not a spray of specks.
  seed = 4242;
  g.clearRect(0, 0, 1024, 512);
  const cluster = (x: number, y: number, r: number, light: number, warm: number, leafLen: number) => {
    // the scalloped rim: small leaf tips standing out round the edge
    const c = (k: number) => `rgb(${Math.round((44 + 58 * light + warm * 18) * k)},${Math.round((78 + 70 * light) * k)},${Math.round((30 + 26 * light - warm * 10) * k)})`;
    g.fillStyle = c(0.72);
    for (let i = 0, n = Math.round(r * 0.55); i < n; i++) {
      const a = (i / n) * Math.PI * 2 + R() * 0.3, l = leafLen * (0.8 + R() * 0.5);
      g.save(); g.translate(x + Math.cos(a) * r * 0.86, y + Math.sin(a) * r * 0.86); g.rotate(a);
      g.beginPath(); g.ellipse(l * 0.35, 0, l * 0.6, l * 0.3, 0, 0, 7); g.fill(); g.restore();
    }
    // the body: lit from the top-left, shadowed toward the bottom-right
    const gr = g.createRadialGradient(x - r * 0.35, y - r * 0.45, r * 0.1, x, y, r * 1.05);
    gr.addColorStop(0, c(1.12)); gr.addColorStop(0.55, c(0.92)); gr.addColorStop(1, c(0.62));
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    // a little painted leaf texture inside: a few strokes, low contrast
    for (let i = 0, n = Math.round(r * 0.4); i < n; i++) {
      const a = R() * 6.28, rr = Math.sqrt(R()) * r * 0.8, lx = x + Math.cos(a) * rr, ly = y + Math.sin(a) * rr;
      g.fillStyle = R() < 0.5 ? c(1.18) : c(0.8); g.globalAlpha = 0.35;
      g.beginPath(); g.ellipse(lx, ly, leafLen * 0.55, leafLen * 0.26, R() * 6.28, 0, 7); g.fill(); g.globalAlpha = 1;
    }
  };
  // broadleaf mass (oak / maple): a big rounded crown of clusters, darker and denser toward the middle and bottom
  {
    const items: [number, number, number, number][] = [];
    for (let i = 0; i < 70; i++) {
      const a = R() * 6.28, rr = Math.sqrt(R()) * 196, r = 30 + R() * 26 - rr * 0.06;
      const x = 256 + Math.cos(a) * rr, y = 256 + Math.sin(a) * rr;
      if (Math.hypot(x - 256, y - 256) + r > 246) continue;
      // light: higher clusters and those toward the upper-left catch more light
      items.push([x, y, r, clamp(0.55 - (y - 256) / 520 - (x - 256) / 1400 + (R() - 0.5) * 0.2, 0.1, 1)]);
    }
    items.sort((p0, p1) => p0[1] - p1[1]); // top clusters behind, lower ones in front: a rounded, stacked mass
    for (const [x, y, r, l] of items) cluster(x, y, r, l, R() * 0.6, 13);
  }
  // birch / poplar mass: smaller, lighter, looser clusters
  {
    const items: [number, number, number, number][] = [];
    for (let i = 0; i < 70; i++) {
      const a = R() * 6.28, rr = Math.sqrt(R()) * 100, r = 15 + R() * 13;
      const x = 640 + Math.cos(a) * rr * 0.78, y = 384 + Math.sin(a) * rr;
      if (Math.hypot((x - 640) / 0.78, y - 384) + r > 120) continue;
      items.push([x, y, r, clamp(0.75 - (y - 384) / 300 + (R() - 0.5) * 0.25, 0.2, 1)]);
    }
    items.sort((p0, p1) => p0[1] - p1[1]);
    for (const [x, y, r, l] of items) cluster(x, y, r, l, 0.8 + R() * 0.6, 9);
  }
  // pine spray: a twig with needles, side shoots
  const needles = (x0: number, y0: number, x1: number, y1: number, len: number, n: number) => {
    for (let i = 0; i < n; i++) {
      const t = i / n, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t, ang = Math.atan2(y1 - y0, x1 - x0);
      const L = len * (1 - 0.55 * t) * (0.8 + R() * 0.4);
      for (const sd of [-1, 1]) {
        const a = ang + sd * (0.55 + R() * 0.35);
        const l = 0.35 + R() * 0.5;
        g.strokeStyle = `rgb(${Math.round(34 + 30 * l)},${Math.round(70 + 46 * l)},${Math.round(44 + 24 * l)})`;
        g.lineWidth = 3 + R() * 2;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * L, y + Math.sin(a) * L); g.stroke();
      }
    }
  };
  g.strokeStyle = '#4b3a29'; g.lineWidth = 6; g.beginPath(); g.moveTo(516, 128); g.quadraticCurveTo(760, 118, 1012, 134); g.stroke();
  for (let k = 0; k < 7; k++) { const x = 560 + k * 62, sd = k % 2 ? 1 : -1; needles(x, 126, x + 70, 126 + sd * (60 + R() * 30), 34, 30); }
  needles(516, 128, 1012, 134, 50, 210);
  // opaque patches (bark, dark foliage core) — big enough to survive mipmapping
  // bark: grey-brown with vertical fissures and lichen flecks
  g.fillStyle = '#4e463d'; g.fillRect(772, 262, 88, 244);
  for (let i = 0; i < 70; i++) { const x = 772 + R() * 88, w = 1 + R() * 3; g.strokeStyle = `rgba(${R() < 0.5 ? '28,22,16' : '120,108,92'},${0.35 + R() * 0.4})`; g.lineWidth = w; g.beginPath(); g.moveTo(x, 262); for (let y = 262; y < 506; y += 12) g.lineTo(x + (R() - 0.5) * 4, y); g.stroke(); }
  for (let i = 0; i < 60; i++) { g.fillStyle = `rgba(${R() < 0.5 ? '120,130,90' : '160,150,130'},0.25)`; g.beginPath(); g.ellipse(772 + R() * 88, 262 + R() * 244, 2 + R() * 4, 1 + R() * 3, 0, 0, 7); g.fill(); }
  g.fillStyle = '#56493d'; g.fillRect(784, 280, 1, 1);
  // birch bark: chalky white with dark lenticel dashes and black knots
  g.fillStyle = '#e4e0d6'; g.fillRect(952, 262, 68, 244);
  for (let i = 0; i < 90; i++) { g.fillStyle = `rgba(${R() < 0.7 ? '40,36,32' : '150,140,120'},${0.5 + R() * 0.4})`; g.fillRect(952 + R() * 60, 262 + R() * 240, 4 + R() * 12, 1 + R() * 2); }
  for (let i = 0; i < 10; i++) { g.fillStyle = 'rgba(25,22,20,0.8)'; g.beginPath(); g.ellipse(955 + R() * 60, 270 + R() * 230, 3 + R() * 4, 2 + R() * 3, 0, 0, 7); g.fill(); }
  g.fillStyle = '#2f4a20'; g.fillRect(880, 280, 64, 64);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}
class CardBuf {
  pos: number[] = []; nrm: number[] = []; col: number[] = []; uv: number[] = []; idx: number[] = [];
  quad(c: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3, n: THREE.Vector3, shade: number, r: [number, number, number, number], shadeTip = shade) {
    const b = this.pos.length / 3;
    const corners: [number, number, number, number][] = [[-1, -1, r[0], r[1]], [1, -1, r[2], r[1]], [1, 1, r[2], r[3]], [-1, 1, r[0], r[3]]];
    for (const [a, bb, uu, vv] of corners) {
      this.pos.push(c.x + u.x * a + v.x * bb, c.y + u.y * a + v.y * bb, c.z + u.z * a + v.z * bb);
      this.nrm.push(n.x, n.y, n.z);
      const sh = a > 0 ? shadeTip : shade; this.col.push(sh, sh, sh);
      this.uv.push(uu, vv);
    }
    this.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  /** an existing geometry (trunk, core) mapped to one opaque atlas patch */
  solid(g0: THREE.BufferGeometry, uv: [number, number], shade: (x: number, y: number, z: number) => number, normalFrom?: THREE.Vector3) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    const p = g.getAttribute('position'), n = g.getAttribute('normal');
    const b = this.pos.length / 3;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      this.pos.push(x, y, z);
      if (normalFrom) { const d = new THREE.Vector3(x, y, z).sub(normalFrom).normalize(); this.nrm.push(d.x, d.y, d.z); } else this.nrm.push(n.getX(i), n.getY(i), n.getZ(i));
      const sh = shade(x, y, z); this.col.push(sh, sh, sh);
      this.uv.push(uv[0], uv[1]);
      this.idx.push(b + i);
    }
  }
  /** a cylinder with its own uv (u round, v along), mapped into an atlas rectangle; vRep = how many times v repeats (clamped to 1 tile) */
  solidRect(g0: THREE.BufferGeometry, r: [number, number, number, number], _vRep: number, shade: (x: number, y: number, z: number) => number) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    const p = g.getAttribute('position'), n = g.getAttribute('normal'), uv = g.getAttribute('uv');
    const b = this.pos.length / 3;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      this.pos.push(x, y, z); this.nrm.push(n.getX(i), n.getY(i), n.getZ(i));
      const sh = shade(x, y, z); this.col.push(sh, sh, sh);
      this.uv.push(r[0] + (r[2] - r[0]) * (0.05 + 0.9 * uv.getX(i)), r[1] + (r[3] - r[1]) * (0.05 + 0.9 * uv.getY(i)));
      this.idx.push(b + i);
    }
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}
const randUnit = (out: THREE.Vector3) => { const z = rand() * 2 - 1, a = rand() * Math.PI * 2, r = Math.sqrt(1 - z * z); return out.set(r * Math.cos(a), z, r * Math.sin(a)); };
function branch(B: CardBuf, from: THREE.Vector3, to: THREE.Vector3, r0: number, r1: number, bark = UV_BARK_RECT) {
  const len = from.distanceTo(to);
  const c = new THREE.CylinderGeometry(r1, r0, len, 6, 1, true);
  c.translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
  c.applyQuaternion(q); c.translate(from.x, from.y, from.z);
  B.solidRect(c, bark, len / 4, (_x, y) => 0.42 + 0.3 * clamp(y / 8, 0, 1)); // dark trunks, a little lighter up in the crown
}
/** leafy canopy built from lumps of cards around dark cores */
function leafyTree(hi: boolean, trunkH: number, trunkR: number, lumps: [number, number, number, number][], sy: number, tex: [number, number, number, number], cardSize: number, density: number, bark = UV_BARK_RECT): THREE.BufferGeometry {
  const B = new CardBuf();
  const C = new THREE.Vector3(); lumps.forEach(([x, y, z]) => C.add(new THREE.Vector3(x, y, z))); C.multiplyScalar(1 / lumps.length);
  const bottom = Math.min(...lumps.map(l => l[1] - l[3] * sy)), top = Math.max(...lumps.map(l => l[1] + l[3] * sy));
  // trunk with a slight lean, forking into limbs that reach each lump; a few bare twigs poke through the gaps
  const fork = new THREE.Vector3(0.12, trunkH * 0.78, -0.05);
  branch(B, new THREE.Vector3(0, -0.2, 0), fork, trunkR, trunkR * 0.7, bark);
  branch(B, fork, new THREE.Vector3(0.05, trunkH * 1.15, -0.03), trunkR * 0.62, trunkR * 0.3, bark);
  for (const [x, y, z] of lumps.slice(1)) {
    const mid = new THREE.Vector3(x * 0.45 + fork.x * 0.55, (y - 0.4) * 0.5 + fork.y * 0.5 - 0.2, z * 0.45);
    branch(B, fork.clone().add(new THREE.Vector3(0, -0.15, 0)), mid, trunkR * 0.5, trunkR * 0.32, bark);
    branch(B, mid, new THREE.Vector3(x * 0.85, y - 0.3, z * 0.85), trunkR * 0.32, trunkR * 0.12, bark);
  }
  // a few limbs show in the gaps under and between the leaf masses
  if (hi) for (let i = 0; i < 5; i++) { const a = rand() * 6.28, y = trunkH * (0.55 + rand() * 0.25); branch(B, new THREE.Vector3(0.05, y, 0), new THREE.Vector3(Math.cos(a) * 1.6, y + 0.6 + rand() * 0.8, Math.sin(a) * 1.6), trunkR * 0.18, trunkR * 0.05, bark); }
  const d = new THREE.Vector3(), rnd = new THREE.Vector3(), u = new THREE.Vector3(), v = new THREE.Vector3(), fN = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (const [lx, ly, lz, r] of lumps) {
    // a smooth inner mass (no facets) so you never see through to a hard polyhedron
    const core = new THREE.SphereGeometry(r * 0.42, hi ? 10 : 6, hi ? 7 : 4); core.scale(1, sy, 1); core.translate(lx, ly, lz);
    // the core is leafy too (alpha-tested leaf texture, shaded dark) so it reads as deep foliage, not a ball
    B.solidRect(core, [UV_LEAF[0] + 0.06, UV_LEAF[1] + 0.1, UV_LEAF[2] - 0.06, UV_LEAF[3] - 0.1], 1, (_x, y) => 0.3 + 0.34 * clamp((y - bottom) / (top - bottom), 0, 1));
    const count = Math.round(density * r * r * (hi ? 1 : 0.38));
    for (let i = 0; i < count; i++) {
      randUnit(d); d.y = d.y * 0.85 + 0.15;  d.normalize();
      const k = 0.5 + 0.5 * Math.sqrt(rand());
      c.set(lx + d.x * r * k, ly + d.y * r * k * sy, lz + d.z * r * k);
      // facing mostly out of the lump, so from any side a lump is a few overlapping painted masses
      fN.copy(d).multiplyScalar(0.9).add(randUnit(rnd).multiplyScalar(0.55)).normalize();
      u.crossVectors(fN, randUnit(rnd)).normalize(); v.crossVectors(fN, u).normalize();
      const sz = cardSize * (0.8 + rand() * 0.4) * (hi ? 1 : 1.3) * 0.5;
      u.multiplyScalar(sz); v.multiplyScalar(sz);
      // soft "canopy" normal: mostly away from the whole crown's centre, a little up
      // lighting normal: out of this lump, blended with out of the whole crown, a touch up
      n.set(c.x - C.x, (c.y - C.y) * 0.85, c.z - C.z).normalize().multiplyScalar(0.4).addScaledVector(d, 0.6).add(new THREE.Vector3(0, 0.12, 0)).normalize();
      const h = clamp((c.y - bottom) / (top - bottom), 0, 1);
      const shade = clamp(0.4 + 0.3 * h + 0.3 * (k - 0.5) * 2 * 0.5 + (rand() - 0.5) * 0.05, 0.28, 1.05);
      B.quad(c, u, v, n, shade, tex);
    }
  }
  return B.build();
}
const lift = (l: [number, number, number, number][], dy: number) => l.map(([x, y, z, r]) => [x, y + dy, z, r] as [number, number, number, number]);
function broadleafCards(hi: boolean) {
  // a mature oak: a tall clean trunk and a broad, billowy crown of big masses lifted high
  return leafyTree(hi, 7.2, 0.22, lift([[0, 6.8, 0, 3.0], [2.3, 5.9, 0.6, 2.3], [-2.2, 6.1, -0.4, 2.4], [0.3, 5.7, -2.3, 2.2], [-0.4, 5.6, 2.2, 2.2], [0.6, 8.6, 0.2, 2.0]], 2.8), 0.86, UV_LEAF, 2.3, 5.0);
}
function broadleafB(hi: boolean) {
  // an older, wider, flatter-topped tree with an irregular crown
  return leafyTree(hi, 6.4, 0.26, lift([[0.4, 6.3, 0.2, 2.8], [2.9, 5.4, 0.9, 2.2], [-2.7, 5.6, -0.3, 2.5], [-0.8, 5.1, -2.6, 2.1], [1.1, 5.0, 2.5, 2.0], [-1.2, 7.6, 0.8, 1.9], [1.6, 7.2, -1.2, 1.8]], 2.4), 0.78, UV_LEAF, 2.2, 5.2);
}
function mapleCards(hi: boolean) {
  // a rounder, denser maple crown
  return leafyTree(hi, 5.4, 0.2, lift([[0, 6.2, 0, 2.7], [1.6, 5.2, 0.4, 2.0], [-1.5, 5.3, -0.5, 2.1], [0.2, 5.0, -1.7, 1.9], [-0.3, 5.1, 1.7, 1.9], [0.3, 7.7, -0.2, 1.9]], 1.6), 0.96, UV_LEAF, 2.1, 5.4);
}
function poplarCards(hi: boolean) {
  // a birch: white bark, a tall loose crown of small light leaf masses
  return leafyTree(hi, 4.2, 0.2, [[0, 5.4, 0, 1.7], [0.5, 7.2, 0.2, 1.6], [-0.3, 9.0, -0.2, 1.4], [0.2, 10.5, 0, 1.0], [1.2, 6.2, -0.6, 1.2]], 1.2, UV_SMALL, 1.7, 5.5, UV_BIRCH_RECT);
}
function pineCards(hi: boolean): THREE.BufferGeometry {
  const B = new CardBuf();
  const H = 11.5;
  branch(B, new THREE.Vector3(0, -0.2, 0), new THREE.Vector3(0, H, 0), 0.28, 0.04);
  const step = hi ? 0.48 : 1.0, per = hi ? 6 : 5;
  const o = new THREE.Vector3(), a0 = new THREE.Vector3(), a1 = new THREE.Vector3(), c = new THREE.Vector3(), u = new THREE.Vector3(), v = new THREE.Vector3(), n = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  for (let y = 1.7, wi = 0; y < H - 0.4; y += step * (0.85 + rand() * 0.3), wi++) {
    const t = (y - 1.7) / (H - 1.7);
    const R = 3.0 * Math.pow(1 - t, 0.9) + 0.3;
    for (let b = 0; b < per + (rand() < 0.5 ? 1 : 0); b++) {
      const ang = (b / per) * Math.PI * 2 + wi * 0.9 + (rand() - 0.5) * 0.5;
      o.set(Math.cos(ang), 0, Math.sin(ang));
      const L = R * (0.8 + rand() * 0.3);
      a0.copy(o).multiplyScalar(0.12).setY(y);
      a1.copy(o).multiplyScalar(L).setY(y - 0.32 * L - 0.1);
      c.addVectors(a0, a1).multiplyScalar(0.5);
      u.subVectors(a1, a0).multiplyScalar(0.5);
      const side = new THREE.Vector3().crossVectors(u, up).normalize();
      const w = (0.42 + 0.3 * L / 3.3) * (hi ? 1 : 1.3);
      n.copy(o).multiplyScalar(0.6).add(new THREE.Vector3(0, 0.8, 0)).normalize();
      const shade = clamp(0.38 + 0.45 * t + 0.1 * rand(), 0.3, 1.0);
      // a flat-ish spray and a tilted one so the branch has body from any angle
      v.copy(side).multiplyScalar(w).addScaledVector(up, w * 0.25);
      B.quad(c, u, v, n, shade * 0.85, UV_PINE, shade * 1.1);
      if (hi) { v.copy(side).multiplyScalar(w * 0.35).addScaledVector(up, w * 0.75); B.quad(c, u, v, n, shade * 0.8, UV_PINE, shade); }
    }
  }
  // a dark core so you can't see through the middle
  const core = new THREE.ConeGeometry(1.6, H - 2.6, hi ? 8 : 6, 1, true); core.translate(0, 2.0 + (H - 2.6) / 2, 0);
  B.solidRect(core, [UV_PINE[0] + 0.05, UV_PINE[1] + 0.05, UV_PINE[2] - 0.05, UV_PINE[3] - 0.08], 1, (_x, y) => 0.24 + 0.26 * clamp(y / H, 0, 1));
  return B.build();
}
function foliageMaterial(atlas: THREE.Texture, U: { uSunView: { value: THREE.Vector3 }; uSunCol: { value: THREE.Color }; uTrans: { value: number }; uTime: { value: number }; uWindS: { value: number } }) {
  const m = new THREE.MeshStandardMaterial({ map: atlas, alphaTest: 0.5, side: THREE.DoubleSide, vertexColors: true, roughness: 1, metalness: 0 });
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uWindS;\nvarying float vAutumn;\nvarying float vHue;')
      .replace('#include <color_vertex>', `#include <color_vertex>
vAutumn = 0.0; vHue = 0.0;
#ifdef USE_INSTANCING_COLOR
if (instanceColor.r > 4.0) {
  float code = instanceColor.r - 8.0;          // 0..1 tint, +2 per hue step
  float hueStep = floor(code / 2.0);
  vHue = hueStep / 2.0;
  vAutumn = 0.55 + 0.5 * (code - hueStep * 2.0);
  vColor.xyz = color.xyz * vec3(instanceColor.g, instanceColor.g, instanceColor.b);
}
#endif`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
#ifdef USE_INSTANCING
float wph = instanceMatrix[3][0] * 0.21 + instanceMatrix[3][2] * 0.13;
#else
float wph = 0.0;
#endif
float wk = max(position.y - 2.5, 0.0);
// sway with the range's wind: the crown leans and breathes, the outer masses flutter a little faster
float wamp = 0.5 + 1.3 * uWindS;
transformed.x += (sin(uTime * 1.1 + wph) * 0.6 + sin(uTime * 2.3 + wph * 1.7 + position.x) * 0.25) * 0.022 * wk * wamp;
transformed.z += sin(uTime * 0.9 + wph * 1.3) * 0.016 * wk * wamp;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uSunView;\nuniform vec3 uSunCol;\nuniform float uTrans;\nvarying float vAutumn;\nvarying float vHue;')
      .replace('#include <map_fragment>', `
vec4 sampledDiffuseColor = texture2D(map, vMapUv, -0.6);
// keep leaf edges crisp at every distance: rescale alpha around the cutoff by its screen-space rate of change
sampledDiffuseColor.a = clamp((sampledDiffuseColor.a - 0.42) / max(fwidth(sampledDiffuseColor.a), 1e-4) * 0.5 + 0.5, 0.0, 1.0);
diffuseColor *= sampledDiffuseColor;
if (vAutumn > 0.0) {
  vec3 dc = diffuseColor.rgb;
  float leafy = smoothstep(0.0, 0.04, dc.g - max(dc.r, dc.b) * 0.9);
  float lum = dot(dc, vec3(0.3, 0.6, 0.1));
  vec3 pal = vHue < 0.25 ? vec3(1.0, 0.36, 0.06) : vHue < 0.75 ? vec3(0.8, 0.12, 0.05) : vec3(1.0, 0.62, 0.08);
  diffuseColor.rgb = mix(dc, lum * pal * 2.4, leafy * vAutumn);
}`)
      // foliage cards keep their canopy normals on both faces
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''))
      // light through the leaves when the sun is behind them
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
// readable canopies: bright crowns catching the sky, dark undersides (the canopy normals point out of the crown)
float topL = smoothstep(-0.65, 0.85, (vec4(normal, 0.0) * viewMatrix).y);
reflectedLight.indirectDiffuse *= mix(vec3(0.34, 0.44, 0.52), vec3(1.4, 1.36, 1.12), topL);
reflectedLight.directDiffuse *= mix(vec3(0.68, 0.76, 0.84), vec3(1.18, 1.14, 0.94), topL);
float backlit = pow(max(dot(normalize(-vViewPosition), uSunView), 0.0), 3.0);
// a soft rim where the masses turn away from us, brightest with the sun behind (clean edges for the ink finish)
float rimL = pow(1.0 - clamp(abs(dot(normalize(vViewPosition), normal)), 0.0, 1.0), 3.0);
reflectedLight.directDiffuse += diffuseColor.rgb * uSunCol * rimL * (0.05 + 0.2 * backlit);
reflectedLight.directDiffuse += diffuseColor.rgb * uSunCol * uTrans * (0.03 + 0.18 * backlit);
// leaves are matte: no sky sheen on the cards
reflectedLight.directSpecular *= 0.15;
reflectedLight.indirectSpecular *= 0.1;`);
  };
  m.customProgramCacheKey = () => 'range-foliage-v6';
  return m;
}

// ───────────────────────── build ─────────────────────────
export function createRange(renderer: THREE.WebGLRenderer, scene: THREE.Scene, opts: RangeOptions = {}): Range {
  // the terrain's density is fixed when it is built; everything else follows setDetail() at runtime
  const buildDetail: Detail = opts.detail ?? 'high';
  let tod: TimeOfDay = 'golden';
  const sunDir = new THREE.Vector3();
  const sunFrom = (P: TimePreset, out: THREE.Vector3) => out.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - P.elev), THREE.MathUtils.degToRad(P.azim));
  sunFrom(TIMES.golden, sunDir);

  // sky (visible) + an environment map rendered from a copy of it (image-based light), rebuilt per time of day
  const sky = new Sky();
  sky.scale.setScalar(6000);
  const su = sky.material.uniforms;
  su.cloudScale.value = 0.00022; su.cloudSpeed.value = 0.00003; su.cloudElevation.value = 0.55;
  sky.frustumCulled = false;
  scene.add(sky);
  const fogColor = new THREE.Color();
  scene.fog = new THREE.FogExp2(0xffffff, 0.0005);
  scene.background = new THREE.Color();
  const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 0.3);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 3.0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 3;
  const sc = sun.shadow.camera;
  sc.near = 1; sc.far = 420;
  scene.add(sun, sun.target);
  let envRT: THREE.WebGLRenderTarget | null = null, avatarRT: THREE.WebGLRenderTarget | null = null;
  // things that depend on the sun (baked tree shadows) register here
  const sunListeners: (() => void)[] = [];
  const treeUniforms = { uSunView: { value: new THREE.Vector3() }, uSunCol: { value: new THREE.Color() }, uTrans: { value: 1 }, uTime: { value: 0 }, uWindS: { value: 0.35 } };

  function applyTime(t: TimeOfDay) {
    tod = t;
    const P = TIMES[t];
    sunFrom(P, sunDir);
    for (const k of Object.keys(P.sky) as (keyof TimePreset['sky'])[]) su[k].value = P.sky[k];
    su.sunPosition.value.copy(sunDir);
    su.cloudCoverage.value = P.clouds; su.cloudDensity.value = 0.42;
    // environment light from the same sky, with a green-gold bounce below the horizon
    const envScene = new THREE.Scene();
    const envSky = new Sky();
    envSky.scale.setScalar(1000);
    const eu = envSky.material.uniforms;
    for (const k of Object.keys(P.sky) as (keyof TimePreset['sky'])[]) eu[k].value = P.sky[k];
    eu.sunPosition.value.copy(sunDir); eu.showSunDisc.value = 0; eu.cloudCoverage.value = P.clouds; eu.cloudDensity.value = 0.42;
    envScene.add(envSky);
    const groundDome = new THREE.Mesh(new THREE.SphereGeometry(900, 24, 12, 0, Math.PI * 2, Math.PI / 2 + 0.02, Math.PI / 2), new THREE.MeshBasicMaterial({ color: lin(P.groundBounce), side: THREE.BackSide }));
    envScene.add(groundDome);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const rt = pmrem.fromScene(envScene, 0.02, 0.1, 5000);
    envRT?.dispose(); envRT = rt;
    scene.environment = rt.texture;
    scene.environmentIntensity = P.envI;
    // the golfer's own environment: the same sky with the sun's glow capped. The sky's Mie lobe round the low sun is
    // ~1000x brighter than the rest of it (the disc is off but the glow is not), so in the scene env it acts as a
    // second, cyan-white sun: facing it, his front took ~30x the sky light his side does and ~100x his back, which
    // lifted the polo to mint and the khaki to pale yellow in the face-on and intro views. The directional sun
    // already lights him from there, so his env keeps the sky but not the lobe.
    const cap = AVATAR_ENV_CAP.toFixed(3);
    envSky.material.onBeforeCompile = sh => {
      sh.fragmentShader = sh.fragmentShader.replace('gl_FragColor = vec4( texColor, 1.0 );',
        `texColor *= min(1.0, ${cap} / max(dot(texColor, vec3(0.2126, 0.7152, 0.0722)), 1e-5));\n gl_FragColor = vec4( texColor, 1.0 );`);
    };
    envSky.material.needsUpdate = true;
    const pmrem2 = new THREE.PMREMGenerator(renderer);
    const rt2 = pmrem2.fromScene(envScene, 0.02, 0.1, 5000);
    avatarRT?.dispose(); avatarRT = rt2;
    pmrem2.dispose();
    pmrem.dispose();
    envSky.geometry.dispose(); envSky.material.dispose(); groundDome.geometry.dispose(); (groundDome.material as THREE.Material).dispose();
    fogColor.copy(lin(P.fog));
    (scene.fog as THREE.FogExp2).color.copy(fogColor); (scene.fog as THREE.FogExp2).density = P.fogDensity;
    (scene.background as THREE.Color).copy(fogColor);
    hemi.color.copy(lin(P.hemiSky)); hemi.groundColor.copy(lin(P.hemiGround)); hemi.intensity = P.hemiI;
    sun.color.copy(lin(P.sunColor)); sun.intensity = P.sunI;
    treeUniforms.uSunCol.value.copy(sun.color).multiplyScalar(sun.intensity);
    treeUniforms.uTrans.value = P.trans;
    // the light-space basis for shadow snapping depends on the sun
    lightRight.crossVectors(new THREE.Vector3(0, 1, 0), sunDir).normalize();
    lightUp.crossVectors(sunDir, lightRight).normalize();
    half = 0;
    for (const f of sunListeners) f();
  }
  const lightRight = new THREE.Vector3(), lightUp = new THREE.Vector3();
  let half = 0;

  // ground
  const noise = makeNoiseTexture(renderer);
  const gmat = groundMaterial(noise, makeForestTexture(), makeTurfTexture(renderer));
  for (const g of terrainChunks(buildDetail)) {
    const terrain = new THREE.Mesh(g, gmat);
    terrain.receiveShadow = true;
    terrain.name = 'terrain';
    terrain.renderOrder = -3; // before the hole mask
    scene.add(terrain);
  }
  const teeBox = new THREE.Mesh(teeBoxGeometry(), gmat);
  teeBox.receiveShadow = true; teeBox.castShadow = true;
  scene.add(teeBox);

  // tee markers: painted hardwood blocks in the club's navy with a gold band, set into the turf
  {
    const parts: THREE.BufferGeometry[] = [];
    for (const [sx, sz] of [[-3.4, -1.3], [4.3, -1.1]]) {
      const blk = new RoundedBoxGeometry(0.17, 0.09, 0.09, 3, 0.015); blk.rotateY(0.04 * sx); blk.translate(sx, 0.035, sz);
      parts.push(paint(blk, (x, y, _z, _a, ny, _c, c) => {
        const band = Math.abs(y - 0.05) < 0.006 ? 1 : 0;
        c.copy(band ? lin('#f2c21b') : lin('#1d2229')).multiplyScalar(0.8 + 0.2 * Math.max(0, ny) + (y < 0.0 ? -0.2 : 0));
        void x;
      }));
    }
    const m = new THREE.Mesh(finish(parts), new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.42, clearcoat: 0.5, clearcoatRoughness: 0.35 }));
    m.castShadow = true; m.receiveShadow = true;
    scene.add(m);
  }

  // the clubhouse on the rise beyond the range: white clapboard walls, a dark slate roof with dormers,
  // chimneys and a flagpole. Seen through the haze it gives the backdrop a sense of place.
  {
    const C = CLUBHOUSE, gy = rawHeight(C.x, C.z, false) - 0.6;
    const wallTex = (() => {
      const cv = document.createElement('canvas'); cv.width = 512; cv.height = 128; const g = cv.getContext('2d')!;
      g.fillStyle = '#efece4'; g.fillRect(0, 0, 512, 128);
      for (let y = 0; y < 128; y += 6) { g.fillStyle = 'rgba(0,0,0,0.07)'; g.fillRect(0, y, 512, 1.5); }
      for (let row = 0; row < 2; row++) for (let i = 0; i < 14; i++) {
        const x = 14 + i * 35.5, y = row ? 70 : 18;
        g.fillStyle = '#273038'; g.fillRect(x, y, 18, 34); g.fillStyle = 'rgba(255,230,180,0.35)'; g.fillRect(x + 2, y + 2, 6, 14);
        g.fillStyle = '#1b2a22'; g.fillRect(x - 4, y, 3, 34); g.fillRect(x + 19, y, 3, 34);
      }
      g.fillStyle = '#3a2b1f'; g.fillRect(236, 76, 40, 52);
      const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
    })();
    const grp = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(C.w, C.h, C.d), new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.85 }));
    body.position.y = C.h / 2; grp.add(body);
    const wing = new THREE.Mesh(new THREE.BoxGeometry(12, C.h * 0.75, 10), body.material); wing.position.set(C.w / 2 + 5, C.h * 0.375, 3); grp.add(wing);
    const roofMat = new THREE.MeshStandardMaterial({ color: '#2b3036', roughness: 0.7 });
    const roofShape = new THREE.Shape([new THREE.Vector2(-C.d / 2 - 0.8, 0), new THREE.Vector2(C.d / 2 + 0.8, 0), new THREE.Vector2(0, 5.2)]);
    const roof = new THREE.Mesh(new THREE.ExtrudeGeometry(roofShape, { depth: C.w + 1.6, bevelEnabled: false }), roofMat);
    roof.rotation.y = Math.PI / 2; roof.position.set(-C.w / 2 - 0.8, C.h, 0); grp.add(roof);
    for (const dx of [-10, 0, 10]) { const dm = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.8, 2.4), roofMat); dm.position.set(dx, C.h + 1.6, C.d / 2 - 1.6); grp.add(dm); }
    for (const dx of [-C.w / 2 + 3, C.w / 2 - 3]) { const ch = new THREE.Mesh(new THREE.BoxGeometry(1.2, 3.2, 1.2), new THREE.MeshStandardMaterial({ color: '#7a4a36', roughness: 0.9 })); ch.position.set(dx, C.h + 4.2, -1); grp.add(ch); }
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 12, 6), new THREE.MeshStandardMaterial({ color: '#e8e8e4', roughness: 0.5 })); pole.position.set(C.w / 2 + 14, 6, 9); grp.add(pole);
    const fl = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.6), new THREE.MeshStandardMaterial({ color: FLAG_YELLOW, roughness: 0.9, side: THREE.DoubleSide })); fl.position.set(C.w / 2 + 15.4, 11, 9); grp.add(fl);
    grp.position.set(C.x, gy, C.z); grp.rotation.y = C.yaw;
    // bake into two meshes: the textured walls, and everything else in vertex colours
    grp.updateMatrixWorld(true);
    const walls: THREE.BufferGeometry[] = [], rest: THREE.BufferGeometry[] = [];
    grp.traverse(o => {
      const m = o as THREE.Mesh; if (!m.isMesh) return;
      const mat = m.material as THREE.MeshStandardMaterial, g = m.geometry.clone().applyMatrix4(m.matrixWorld);
      if (mat.map) walls.push(g.index ? g.toNonIndexed() : g);
      else rest.push(paint(g, (_x, _y, _z, _a, _b, _c, c) => c.copy(mat.color)));
    });
    const wallMesh = new THREE.Mesh(mergeGeometries(walls, false)!, body.material);
    const restMesh = new THREE.Mesh(finish(rest), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, side: THREE.DoubleSide }));
    wallMesh.name = restMesh.name = 'clubhouse';
    scene.add(wallMesh, restMesh);
  }

  // a little life: the ball-picker cart working the far end of the range, and a few birds wheeling over it
  const picker = (() => {
    const parts: THREE.BufferGeometry[] = [];
    const box = (w: number, h: number, d: number, x: number, y: number, z: number, col: string) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); parts.push(paint(g, (_x, _y, _z, _a, ny, _c, c) => c.copy(lin(col)).multiplyScalar(0.85 + 0.15 * ny))); };
    box(1.25, 0.55, 2.0, 0, 0.55, 0, '#e9ecef');          // body
    box(1.2, 0.08, 1.6, 0, 1.75, -0.1, '#1e4d2b');          // roof
    for (const [x, z] of [[-0.55, -0.75], [0.55, -0.75], [-0.55, 0.55], [0.55, 0.55]]) box(0.05, 1.0, 0.05, x, 1.25, z, '#2b2f33');
    box(0.5, 0.45, 0.6, 0, 0.95, 0.35, '#1e4d2b');         // seat back
    box(1.9, 0.5, 0.9, 0, 0.32, -1.6, '#7d848b');          // the picking cage in front
    box(1.95, 0.06, 0.95, 0, 0.6, -1.6, '#5c636a');
    for (const [x, z] of [[-0.62, -0.7], [0.62, -0.7], [-0.62, 0.7], [0.62, 0.7]]) { const w = new THREE.CylinderGeometry(0.22, 0.22, 0.16, 10); w.rotateZ(Math.PI / 2); w.translate(x, 0.22, z); parts.push(paint(w, (_x, _y, _z, _a, _b, _c, c) => c.copy(lin('#1c1c1c')))); }
    const m = new THREE.Mesh(finish(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }));
    m.name = 'picker'; m.castShadow = true;
    scene.add(m);
    return m;
  })();
  const birds = (() => {
    // a shallow V: two wings whose tips flap (scale y of the instance)
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.12, -0.5, 0.12, -0.08, 0, 0, -0.12, 0, 0, 0.12, 0, 0, -0.12, 0.5, 0.12, -0.08], 3));
    g.computeVertexNormals();
    const im = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ color: '#2a2a2e', side: THREE.DoubleSide }), 7);
    im.name = 'birds'; im.frustumCulled = false;
    scene.add(im);
    return im;
  })();
  const life = { m: new THREE.Matrix4(), q: new THREE.Quaternion(), s: new THREE.Vector3(), p: new THREE.Vector3(), e: new THREE.Euler() };
  function updateLife(t: number) {
    // the picker drives slow loops up and down the far end
    const z = -240 + 32 * Math.sin(t * 0.017), x = fwCenter(z) + 15 * Math.sin(t * 0.043);
    const dz = 32 * 0.017 * Math.cos(t * 0.017), dx = 15 * 0.043 * Math.cos(t * 0.043);
    picker.position.set(x, rawHeight(x, z), z);
    picker.rotation.y = Math.atan2(-dx, -dz);
    // birds: a loose flock circling over the 100–150 yard greens, each flapping in its own rhythm
    for (let i = 0; i < birds.count; i++) {
      const a = t * 0.11 + i * 0.5 + 0.3 * Math.sin(t * 0.3 + i), r = 22 + 5 * Math.sin(i * 1.7);
      life.p.set(-20 + Math.cos(a) * r + i * 1.3, 32 + 4 * Math.sin(t * 0.21 + i * 1.1), -125 + Math.sin(a) * r * 0.7);
      life.e.set(0, -a, 0.25); life.q.setFromEuler(life.e);
      const flap = Math.sin(t * (7 + i * 0.6) + i * 2.0);
      life.s.set(1.6, 1.6 * flap, 1.6);
      birds.setMatrixAt(i, life.m.compose(life.p, life.q, life.s));
    }
    birds.instanceMatrix.needsUpdate = true;
  }

  // greens: yellow flagsticks with waving crest flags, cups, and yardage boards
  const targets: RangeTarget[] = GREENS.map(g => ({ yards: g.yards, pos: new THREE.Vector3(g.x, heightAt(g.x, g.z), g.z), radius: g.r, color: FLAG_YELLOW }));
  // wind for the flags: x, z = direction it blows toward, w = strength 0..1 (eased); a light breeze when there is none
  const flagUniforms = { uTime: { value: 0 }, uWind: { value: new THREE.Vector3(0.95, -0.31, 0.36) } };
  const windIn = new THREE.Vector3(), BREEZE = new THREE.Vector3(1.1, 0, -0.4); // calm: a faint drooping flutter
  const featGroup = new THREE.Group(), featPin = new THREE.Group();
  const featTarget: RangeTarget = { yards: 150, pos: new THREE.Vector3(0, 0, -9999), radius: 9, color: FLAG_YELLOW };
  const feat = { from: new THREE.Vector2(), to: new THREE.Vector2(), r0: 9, r1: 9, t: 1, s0: 1, s1: 1 };
  const signSpots: { x: number; z: number; w: number }[] = [];
  {
    const poles: THREE.BufferGeometry[] = [], tips: THREE.BufferGeometry[] = [], flags: THREE.BufferGeometry[] = [], cups: THREE.BufferGeometry[] = [], holes: THREE.BufferGeometry[] = [], ferrules: THREE.BufferGeometry[] = [];
    const boards: THREE.BufferGeometry[] = [], posts: THREE.BufferGeometry[] = [];
    const cellUV = (cell: number) => [(cell % 4) * 0.25, 1 - (Math.floor(cell / 4) + 1) * 0.25] as const;
    const mapFace = (geo: THREE.BufferGeometry, face: number, cell: number, inset = 0.004) => {
      const [u0, v0] = cellUV(cell), uv = geo.getAttribute('uv') as THREE.BufferAttribute;
      for (let v = face * 4; v < face * 4 + 4; v++) uv.setXY(v, u0 + inset + uv.getX(v) * (0.25 - 2 * inset), v0 + inset + uv.getY(v) * (0.25 - 2 * inset));
    };
    GREENS.forEach((g, i) => {
      const y0 = heightAt(g.x, g.z);
      // a touch bigger far away so they still read from the tee; the cloth more so, so the crest reads on a phone
      const { k, kf } = pinScale(g.yards);
      const H = 2.13 * k + 0.08, fw = 0.51 * kf, fh = 0.36 * kf, pr = 0.0085 * k;
      const pin = pinGeometries(H, fw, fh, pr, k, kf, i * 1.7 + 0.4);
      for (const geo of [pin.pole, pin.tip, pin.flag, pin.fer]) geo.translate(g.x, y0, g.z);
      { const a = pin.flag.getAttribute('aPole') as THREE.BufferAttribute; for (let v = 0; v < a.count; v++) a.setXYZ(v, a.getX(v) + g.x, a.getY(v) + y0, a.getZ(v) + g.z); }
      poles.push(pin.pole); tips.push(pin.tip); flags.push(pin.flag); ferrules.push(pin.fer);
      const cup = cupGeometries();
      for (const geo of [...cup.parts, cup.mask]) geo.translate(g.x, y0, g.z);
      cups.push(...cup.parts); holes.push(cup.mask);
      // yardage board beside the green on the outside, turned to face the tee
      const side = g.x < 0 ? -1 : 1;
      const W = 2.0 + g.yards * 0.012, BH = W * 0.5, T = 0.08, lift = 0.5 + W * 0.1;
      const bx = g.x + side * (g.r + W / 2 + 4.0), bz = g.z - 1.0, by = rawHeight(bx, bz);
      signSpots.push({ x: bx, z: bz, w: W });
      const yaw = Math.atan2(0 - bx, 2 - bz);
      const board = new THREE.BoxGeometry(W, BH, T);
      for (const f of [0, 1, 2, 3]) mapFace(board, f, 15, 0.06);
      mapFace(board, 4, i); mapFace(board, 5, 14);
      board.rotateY(yaw); board.translate(bx, by + lift + BH / 2, bz);
      boards.push(board);
      // a capped timber post at each end, standing proud of the board
      for (const px of [-W / 2 - 0.05, W / 2 + 0.05]) {
        const ph2 = lift + BH + 0.12 + 0.3;
        const post = new THREE.BoxGeometry(0.11 * (1 + W / 6), ph2, 0.11 * (1 + W / 6));
        for (const f of [0, 1, 2, 3, 4, 5]) mapFace(post, f, 15, 0.02);
        post.translate(px, ph2 / 2 - 0.3, -T * 0.2); post.rotateY(yaw); post.translate(bx, by, bz);
        posts.push(post);
        const cap = new THREE.ConeGeometry(0.1 * (1 + W / 6), 0.07, 4, 1); cap.rotateY(Math.PI / 4);
        cap.translate(px, ph2 - 0.3 + 0.035, -T * 0.2); cap.rotateY(yaw); cap.translate(bx, by, bz);
        const cuv = cap.getAttribute('uv') as THREE.BufferAttribute; const [u0, v0] = cellUV(15); for (let v = 0; v < cuv.count; v++) cuv.setXY(v, u0 + 0.02 + cuv.getX(v) * 0.2, v0 + 0.02 + cuv.getY(v) * 0.2);
        posts.push(cap);
      }
    });
    // glossy painted fibreglass: a crisp clear-coat highlight running up the stick
    const pinMat = new THREE.MeshPhysicalMaterial({ color: FLAG_YELLOW, emissive: FLAG_YELLOW, emissiveIntensity: 0.16, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 1.4 });
    // far away a real 17 mm stick is thinner than a pixel and vanishes: widen it with distance to about a pixel
    pinMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
{
  vec3 wp0 = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vec2 side = objectNormal.xz;
  if (dot(side, side) > 0.25) transformed.xz += normalize(side) * max(0.0, distance(wp0, cameraPosition) * 0.0011 - 0.0085);
}`);
    };
    pinMat.customProgramCacheKey = () => 'range-pin-v1';
    const poleMesh = new THREE.Mesh(mergeGeometries(poles.map(p => p.toNonIndexed()), false)!, pinMat);
    poleMesh.castShadow = true;
    const tipMesh = new THREE.Mesh(mergeGeometries(tips.map(p => p.toNonIndexed()), false)!, new THREE.MeshStandardMaterial({ color: '#2a2a2a', roughness: 0.4, metalness: 0.6 }));
    // draw order: terrain (-3), the hole mask (-2), the cup inside (-1), then everything else
    // walls are seen from inside only (their outsides would poke out of the turf); rim and bottom face up
    const cupMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 });
    const cupWalls = new THREE.Mesh(finish(cups.filter((_, i) => i % 4 < 2)), cupMat.clone()); (cupWalls.material as THREE.Material).side = THREE.BackSide;
    const cupMesh = new THREE.Mesh(finish(cups.filter((_, i) => i % 4 >= 2)), cupMat);
    cupMesh.renderOrder = cupWalls.renderOrder = -1;
    const holeMesh = new THREE.Mesh(mergeGeometries(holes, false)!, new THREE.ShaderMaterial({
      vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'void main() { gl_FragColor = vec4(0.0); gl_FragDepth = 1.0; }',
      // a written depth is what gets tested, so the test is 'always'; safe because only the terrain is drawn before it
      colorWrite: false, depthFunc: THREE.AlwaysDepth,
    }));
    holeMesh.renderOrder = -2;
    const ferMesh = new THREE.Mesh(mergeGeometries(ferrules, false)!, new THREE.MeshStandardMaterial({ color: '#b9bcc0', roughness: 0.3, metalness: 0.9 }));
    // flag cloth: a wave travelling from the pole to the free edge, growing toward the fly end, with matching normals;
    // the crest reads the right way round from both sides; the cloth glows a little when the sun is behind it
    const flagMat = new THREE.MeshStandardMaterial({ map: makeFlagTexture(renderer), roughness: 0.88, side: THREE.DoubleSide });
    flagMat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = flagUniforms.uTime;
      sh.uniforms.uSunView = treeUniforms.uSunView; sh.uniforms.uSunCol = treeUniforms.uSunCol;
      sh.uniforms.uWind = flagUniforms.uWind;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
attribute float aPhase;
attribute float aLen;
attribute float aH;
attribute vec3 aPole;
uniform float uTime;
uniform vec3 uWind;
// the cloth at (u along the fly from the hoist, v up the hoist): it streams downwind, droops when the wind is light,
// and carries a wave that travels from the pole to the free edge, growing toward it, with slow gusts on top
vec3 flagPos(vec2 st) {
  float u = st.x, v = st.y, L = aLen, s = uWind.z;
  vec3 D = normalize(vec3(uWind.x, 0.0, uWind.y)), N = vec3(-D.z, 0.0, D.x);
  float gust = 0.7 + 0.3 * sin(uTime * 0.71 + aPhase) * sin(uTime * 0.23 + aPhase * 2.3);
  float amp = (0.06 + 0.17 * s) * L * pow(u, 1.15) * gust;
  float sp = 4.0 + 7.0 * s;
  float w = amp * (sin(u * 7.5 + v * 1.4 - uTime * sp + aPhase) + 0.35 * sin(u * 14.0 - v * 2.6 - uTime * sp * 1.55 + aPhase * 1.7));
  float slack = (1.0 - s);
  float reach = u * L * (1.0 - slack * 0.3 * u) - abs(w) * 0.35;
  float droop = (slack * 0.5 + 0.05) * u * u * L * (1.0 - 0.35 * v);
  vec3 p = aPole + D * (0.012 + reach) + N * w;
  p.y += -(1.0 - v) * aH - droop;
  return p;
}`)
        .replace('#include <beginnormal_vertex>', `
vec3 P0 = flagPos(uv);
vec3 Pu = flagPos(uv + vec2(0.02, 0.0)) - P0, Pv = flagPos(uv + vec2(0.0, 0.02)) - P0;
vec3 objectNormal = normalize(cross(Pu, Pv));
#ifdef USE_TANGENT
vec3 objectTangent = vec3(tangent.xyz);
#endif`)
        .replace('#include <begin_vertex>', `vec3 transformed = P0;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uSunView;\nuniform vec3 uSunCol;')
        .replace('#include <map_fragment>', `
vec2 fuv = vMapUv;
if (!gl_FrontFacing) fuv.x = 1.0 - fuv.x;
vec4 sampledDiffuseColor = texture2D(map, fuv);
diffuseColor *= sampledDiffuseColor;`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
float thru = pow(max(dot(normalize(-vViewPosition), uSunView), 0.0), 2.0);
reflectedLight.directDiffuse += diffuseColor.rgb * uSunCol * (0.06 + 0.28 * thru);
reflectedLight.indirectSpecular *= 0.3;`);
    };
    flagMat.customProgramCacheKey = () => 'range-flag-v3';
    const flagMesh = new THREE.Mesh(mergeGeometries(flags, false)!, flagMat);
    flagMesh.frustumCulled = false;
    const signMat = new THREE.MeshStandardMaterial({ map: makeSignAtlas(renderer), roughness: 0.78 });
    const boardMesh = new THREE.Mesh(mergeGeometries(boards.map(b => b.toNonIndexed()), false)!, signMat);
    boardMesh.castShadow = true; boardMesh.receiveShadow = true;
    const postMesh = new THREE.Mesh(mergeGeometries(posts.map(p => p.index ? p.toNonIndexed() : p), false)!, signMat);
    postMesh.castShadow = true; postMesh.receiveShadow = true;
    scene.add(poleMesh, tipMesh, cupMesh, cupWalls, holeMesh, ferMesh, flagMesh, boardMesh, postMesh);

    // the featured target's pin and cup: built once at the 150-yd size; the pin is scaled with distance
    {
      const { k, kf } = pinScale(150);
      const pin = pinGeometries(2.13 * k + 0.08, 0.51 * kf, 0.36 * kf, 0.0085 * k, k, kf, 0.9);
      const cup = cupGeometries();
      const mk = (g: THREE.BufferGeometry, m: THREE.Material, order = 0, shadow = false) => { const o = new THREE.Mesh(g, m); o.renderOrder = order; o.castShadow = shadow; return o; };
      const fl = mk(pin.flag, flagMat); fl.frustumCulled = false;
      featPin.add(mk(pin.pole, pinMat, 0, true), mk(pin.tip, tipMesh.material as THREE.Material), fl);
      featGroup.add(featPin,
        mk(finish(cup.parts.slice(0, 2)), cupWalls.material as THREE.Material, -1), mk(finish(cup.parts.slice(2)), cupMat, -1),
        mk(cup.mask, holeMesh.material as THREE.Material, -2), mk(pin.fer, ferMesh.material as THREE.Material));
      featGroup.visible = false;
      scene.add(featGroup);
    }
  }

  // trees
  const treeLods: { zA: number; zB: number; hi: THREE.InstancedMesh[]; lo: THREE.InstancedMesh[]; box: THREE.Box3 }[] = [];
  const frustum = new THREE.Frustum(), projView = new THREE.Matrix4();
  // instanced sets whose count follows the detail tier (their instances are in shuffled order, so a prefix is an even sample)
  const thin: { im: THREE.InstancedMesh; full: number; f: Record<Detail, number> }[] = [];
  const DETAIL = { lodFar: { low: 35, med: 90, high: 120 } as Record<Detail, number>, shadow: { low: 1024, med: 2048, high: 2048 } as Record<Detail, number>, patch: { low: 0.45, med: 0.8, high: 1 } as Record<Detail, number> };
  let detail: Detail = buildDetail, lodFar = DETAIL.lodFar[detail], patchMax = 0;
  {
    const species = [broadleafCards(true), pineCards(true), poplarCards(true), broadleafB(true), mapleCards(true)];
    const speciesLo = [broadleafCards(false), pineCards(false), poplarCards(false), broadleafB(false), mapleCards(false)];
    const treeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
    const cardMat = foliageMaterial(makeFoliageAtlas(renderer), treeUniforms);
    // near the corridor: grouped by distance down the range so frustum culling (camera and shadows) works
    const CH = [[200, 30], [30, -40], [-40, -150], [-150, -260], [-260, -720]];
    const buckets: THREE.Matrix4[][][] = CH.map(() => species.map(() => []));
    const tints: THREE.Color[][][] = CH.map(() => species.map(() => []));
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const blocked = (x: number, z: number) => {
      if (teeSD(x, z) < 8) return true;
      for (const g of GREENS) if (greenD(g, x, z) < 2.2) return true;
      for (const sp of signSpots) if (Math.abs(x - sp.x) < sp.w + 3 && Math.abs(z - sp.z) < 8) return true;
      return false;
    };
    const blobs: { x: number; z: number; r: number; h: number }[] = [];
    const tintOf = (out: THREE.Color, k: number) => {
      // natural spread: most trees a little darker or lighter, some yellower, some bluer
      const b = 0.78 + rand() * 0.42, warm = (rand() - 0.5) * 0.22 * k;
      return out.setRGB(b * (1 + warm), b, b * (1 - warm * 0.8));
    };
    const place = (x: number, z: number, sp0: number, scl: number, green = false) => {
      let sp = sp0;
      if (blocked(x, z)) return;
      const ci = CH.findIndex(([a, b]) => z <= a && z > b); if (ci < 0) return;
      p.set(x, rawHeight(x, z, false) - 0.15, z);
      q.setFromAxisAngle(up, rand() * Math.PI * 2);
      q.premultiply(new THREE.Quaternion().setFromEuler(new THREE.Euler((rand() - 0.5) * 0.12, 0, (rand() - 0.5) * 0.12)));
      s.set(scl * (0.9 + rand() * 0.2), scl * (0.85 + rand() * 0.35), scl * (0.9 + rand() * 0.2));
      if (sp === 0) { const r2 = rand(); sp = r2 < 0.4 ? 0 : r2 < 0.7 ? 3 : 4; }
      buckets[ci][sp].push(m4.compose(p, q, s).clone());
      const tc = tintOf(new THREE.Color(), 1);
      // a few trees have started to turn (encoded as r > 4: the leaf shader recolours them)
      if (!green && sp !== 1 && rand() < (sp === 4 ? 0.16 : 0.05)) tc.r = 8 + Math.floor(rand() * 3) * 2 + rand() * 0.9;
      tints[ci][sp].push(tc);
      blobs.push({ x, z, r: (sp === 1 ? 2.6 : sp === 2 ? 1.9 : sp === 3 ? 3.9 : 3.5) * s.x, h: (sp === 1 ? 10 : sp === 2 ? 11 : 12) * s.y });
    };
    // two or three loose rows down each side
    for (const side of [-1, 1]) {
      for (let z = 70; z > -400; z -= 4 + rand() * 6) {
        const h = Math.max(fwHalf(z, 0), 22);
        const rows = 1 + Math.floor(rand() * 3);
        for (let r = 0; r < rows; r++) {
          // the first row stands close along the rough, so its long evening shadows reach across the fairway
          const dx = h + 13 + r * 9 + rand() * 12 + (z > -20 ? 6 : 0);
          const x = fwCenter(z) + side * dx;
          // mostly oaks and maples along the fairway, a few birches, the odd conifer
          const sp = rand() < 0.78 ? 0 : rand() < 0.65 ? 2 : 1;
          // an irregular line: gaps showing the sky, mostly mid-sized trees with the odd much taller one
          if (rand() < 0.16) continue;
          place(x, z + (rand() - 0.5) * 3, sp, rand() < 0.14 ? 1.45 + rand() * 0.5 : 0.6 + rand() * 0.8);
        }
      }
    }
    // a few big hero oaks and maples close to the tee and down the first 100 yards, framing the shot as in the
    // photos: broad crowns of big lobes, 15–25 m across, high over clean trunks
    for (const [hx, hz, sp, sc] of [[-26, 6, 3, 2.0], [-34, -36, 0, 2.3], [31, -16, 4, 1.9], [-24, -66, 3, 1.7], [33, -70, 0, 2.1], [-34, -110, 4, 1.6]] as const) place(hx, hz, sp, sc, true); // heroes stay summer-green
    // the far end and behind the tee
    for (let i = 0; i < 140; i++) { const x = (rand() - 0.5) * 260, z = -345 - rand() * 120; place(x, z, rand() < 0.5 ? 0 : 1, 0.9 + rand() * 0.7); }
    // a second, taller layer further back on the rising ground, with gaps, so the backdrop has depth
    for (let i = 0; i < 190; i++) {
      const x = (rand() - 0.5) * 420, z = -470 - rand() * 190;
      if (Math.abs(x - CLUBHOUSE.x) < 30 && Math.abs(z - CLUBHOUSE.z) < 26) continue;
      if (fbm(x / 60 + 2.2, z / 60, 2) < 0.38) continue;
      place(x, z, rand() < 0.45 ? 1 : rand() < 0.5 ? 0 : 2, 1.15 + rand() * 0.8);
    }
    for (let i = 0; i < 60; i++) { const x = (rand() - 0.5) * 200, z = 38 + rand() * 90; place(x, z, rand() < 0.5 ? 0 : rand() < 0.5 ? 1 : 2, 0.9 + rand() * 0.6); }
    // the middle distance (50–170 m outside the corridor): woodland edges and lone trees, full-detail species
    for (let i = 0, kept = 0; i < 9000 && kept < 200; i++) {
      const x = (rand() - 0.5) * 700, z = 220 - rand() * 860;
      const out = outside(x, z);
      if (out < 48 || out > 170) continue;
      const dens = forestAt(x, z);
      if (rand() > dens * 0.7 + 0.02) continue;
      place(x, z, rand() < 0.55 ? 0 : rand() < 0.6 ? 1 : 2, 1.0 + rand() * 0.6);
      kept++;
    }
    // each chunk has a full-detail and a low-detail set; update() shows one depending on camera distance
    CH.forEach(([zA, zB], ci) => {
      const hi: THREE.InstancedMesh[] = [], lo: THREE.InstancedMesh[] = [];
      species.forEach((geo, si) => {
        const list = buckets[ci][si]; if (!list.length) return;
        const order = list.map((_, i) => i).sort((a, b) => hash2(a, ci * 7 + si) - hash2(b, ci * 7 + si));
        for (const [g, set] of [[geo, hi], [speciesLo[si], lo]] as const) {
          const im = new THREE.InstancedMesh(g, cardMat, list.length);
          im.name = `trees-${set === hi ? 'hi' : 'lo'}-c${ci}-s${si}`;
          order.forEach((j, i) => { im.setMatrixAt(i, list[j]); im.setColorAt(i, tints[ci][si][j]); });
          im.computeBoundingSphere();
          scene.add(im);
          set.push(im);
          // the far end of the range thins out on weaker tiers (a backdrop of hundreds of card trees)
          if (zB <= -150) thin.push({ im, full: list.length, f: zB <= -260 ? { low: 0.45, med: 0.85, high: 1 } : { low: 0.8, med: 1, high: 1 } });
        }
      });
      // a tight box for culling (the instanced meshes' bounding spheres are huge and always reach into view)
      const box = new THREE.Box3();
      for (const im of hi) { const g = im.geometry; if (!g.boundingBox) g.computeBoundingBox(); const bb = new THREE.Box3(); for (let i = 0; i < im.count; i++) { im.getMatrixAt(i, m4); box.union(bb.copy(g.boundingBox!).applyMatrix4(m4)); } }
      treeLods.push({ zA, zB, hi, lo, box });
    });
    // soft long "baked" shadows under the corridor trees (the real shadow map only covers the focus area)
    {
      // a canopy's shadow: overlapping soft masses with sun flecks breaking through (dappled, like the photos)
      const cv = document.createElement('canvas'); cv.width = cv.height = 256;
      const g2 = cv.getContext('2d')!;
      const save = seed; seed = 2468;
      for (let i = 0; i < 26; i++) {
        const a = rand() * 6.28, rr = Math.sqrt(rand()) * 70, x = 128 + Math.cos(a) * rr * 0.8, y = 128 + Math.sin(a) * rr, r = 30 + rand() * 30;
        const gr = g2.createRadialGradient(x, y, r * 0.3, x, y, r); gr.addColorStop(0, 'rgba(0,0,0,0.75)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
        g2.fillStyle = gr; g2.fillRect(x - r, y - r, 2 * r, 2 * r);
      }
      g2.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 40; i++) {
        const a = rand() * 6.28, rr = Math.sqrt(rand()) * 80, x = 128 + Math.cos(a) * rr * 0.8, y = 128 + Math.sin(a) * rr, r = 3 + rand() * 9;
        const gr = g2.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(0,0,0,0.85)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
        g2.fillStyle = gr; g2.fillRect(x - r, y - r, 2 * r, 2 * r);
      }
      g2.globalCompositeOperation = 'source-over';
      seed = save;
      const tex = new THREE.CanvasTexture(cv);
      const quad = new THREE.PlaneGeometry(1, 1); quad.rotateX(-Math.PI / 2);
      const sm = new THREE.MeshBasicMaterial({ map: tex, color: lin('#0b1c10'), transparent: true, opacity: 0.62, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      const im = new THREE.InstancedMesh(quad, sm, blobs.length);
      const bake = () => {
        const shadowDir = new THREE.Vector2(-sunDir.x, -sunDir.z).normalize();
        const reach = Math.min(5, 1 / Math.tan(Math.asin(clamp(sunDir.y, 0.05, 1))));
        const ang = Math.atan2(shadowDir.x, shadowDir.y);
        sm.opacity = sunDir.y < 0.3 ? 0.72 : 0.62;
        blobs.forEach((b, i) => {
          const len = b.r * 2 + b.h * reach * 0.55;
          const cx = b.x + shadowDir.x * (len / 2 - b.r * 0.8), cz = b.z + shadowDir.y * (len / 2 - b.r * 0.8);
          p.set(cx, rawHeight(cx, cz) + 0.12, cz);
          q.setFromAxisAngle(up, ang);
          s.set(b.r * 2.1, 1, len);
          im.setMatrixAt(i, m4.compose(p, q, s));
        });
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
      };
      bake(); sunListeners.push(bake);
      im.renderOrder = 1;
      scene.add(im);
    }
    // distant woods on the slopes and hills (no shadows): forests and clearings
    const far: THREE.Matrix4[] = [], farTint: THREE.Color[] = [];
    let tries = 0;
    while (far.length < 1700 && tries++ < 150000) {
      const x = (rand() - 0.5) * 3200, z = 340 - rand() * 2800;
      const out = outside(x, z);
      if (out < 170) continue;
      // inside the woods the canopy mass does the work; trees stand along its edges and alone in the fields
      const raw = forestRaw(x, z);
      const edge = smooth(0.38, 0.5, raw) * (1 - smooth(0.56, 0.66, raw)) + 0.04;
      if (rand() > edge) continue;
      p.set(x, rawHeight(x, z, false) - 0.5, z);
      q.setFromAxisAngle(up, rand() * 6.28);
      const sc2 = 1.1 + rand() * 0.8;
      s.set(sc2, sc2 * (0.85 + rand() * 0.45), sc2);
      far.push(m4.compose(p, q, s).clone());
      farTint.push(tintOf(new THREE.Color(), 1.3));
    }
    // wooded hills: many more trees spread over the big hills on the horizon, so they read as forest, not bare ground
    tries = 0;
    let hillN = 0;
    while (hillN < 1100 && tries++ < 200000) {
      const x = (rand() - 0.5) * 4400, z = 600 - rand() * 4600;
      const r = Math.hypot(x * 0.85, (z + 160) * 0.62);
      if (r < 620 || outside(x, z) < 300) continue;
      // clearings: skip where the large-scale noise is low
      if (fbm(x / 260 + 7.7, z / 260 - 1.3, 3) < 0.42) continue;
      p.set(x, rawHeight(x, z, false) - 0.8, z);
      q.setFromAxisAngle(up, rand() * 6.28);
      const sc2 = 1.8 + rand() * 1.3;
      s.set(sc2, sc2 * (0.85 + rand() * 0.45), sc2);
      far.push(m4.compose(p, q, s).clone());
      farTint.push(tintOf(new THREE.Color(), 1.3).multiplyScalar(0.92));
      hillN++;
    }
    const fgeos = [farTreeGeo(0, buildDetail === 'low'), farTreeGeo(1)];
    // split by species and left / right so each part can be culled
    for (const sp of [0, 1]) for (const sgn of [-1, 1]) {
      const idx = far.map((m, i) => [m, i] as const).filter(([m, i]) => Math.sign(m.elements[12] - fwCenter(m.elements[14])) === sgn && ((hash2(i, 77) < 0.3 ? 1 : 0) === sp))
        .sort((a, b) => hash2(a[1], 31) - hash2(b[1], 31));
      if (!idx.length) continue;
      const im = new THREE.InstancedMesh(fgeos[sp], treeMat, idx.length);
      im.name = `far-trees-${sp}`;
      idx.forEach(([m, i], k) => { im.setMatrixAt(k, m); im.setColorAt(k, farTint[i]); });
      im.computeBoundingSphere();
      scene.add(im);
      thin.push({ im, full: idx.length, f: { low: 0.28, med: 0.5, high: 1 } });
    }
  }

  // grass blades around the tee: real turf in the foreground
  const grassUniforms = { uTime: { value: 0 } };
  let grassPatch: (x: number, z: number, now: number) => void = () => {};
  let relayPatch = () => {};
  const patchAt = new THREE.Vector2(1e9, 0);
  {
    // a curved, tapering blade: 3 segments, darker at the root, lighter and a touch yellow at the tip
    const bladeGeo = new THREE.BufferGeometry();
    {
      const P: number[] = [], N: number[] = [], Cc: number[] = [], I: number[] = [];
      const segs = 2;
      for (let k = 0; k <= segs; k++) {
        const t = k / segs, w = 0.05 * (1 - t * 0.85), bend = 0.22 * t * t;
        const sh = 0.72 + 0.3 * t;
        if (k < segs) { P.push(-w, t, bend, w, t, bend); for (let q = 0; q < 2; q++) { N.push(0, 1, 0.25); Cc.push(sh, sh * 1.0, sh * (0.95 - 0.1 * t)); } }
        else { P.push(0, 1, bend); N.push(0, 1, 0.25); Cc.push(sh * 0.98, sh * 0.99, sh * 0.8); }
      }
      for (let k = 0; k < segs - 1; k++) { const a = k * 2; I.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      const a = (segs - 1) * 2; I.push(a, a + 1, a + 2);
      bladeGeo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      bladeGeo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
      bladeGeo.setAttribute('color', new THREE.Float32BufferAttribute(Cc, 3));
      bladeGeo.setIndex(I);
    }
    const COUNT = 54000;
    const im = new THREE.InstancedMesh(bladeGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide }), COUNT);
    const mat = im.material as THREE.MeshStandardMaterial;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = grassUniforms.uTime;
      sh.uniforms.uFade = (mat.userData.fade ??= { value: new THREE.Vector2(14, 28) });
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform vec2 uFade;')
        .replace('#include <project_vertex>', `
vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
float fade = 1.0 - smoothstep(uFade.x, uFade.y, distance(ip.xz, cameraPosition.xz));
vec4 mvPosition = instanceMatrix * vec4(transformed * vec3(1.0, fade, 1.0), 1.0);
float hgt = position.y * position.y;
float gust = sin(uTime * 1.3 + ip.x * 0.15 + ip.z * 0.09) * 0.5 + 0.5;
float sway = (sin(uTime * 2.6 + ip.x * 1.7 + ip.z * 1.3) * 0.6 + gust) * hgt * instanceMatrix[1][1] * 0.16;
mvPosition.xz += vec2(0.8, -0.35) * sway;
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`);
    };
    mat.onBeforeCompile = ((prev) => (sh: THREE.WebGLProgramParametersWithUniforms, r: THREE.WebGLRenderer) => {
      prev(sh, r);
      sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''));
    })(mat.onBeforeCompile);
    mat.customProgramCacheKey = () => 'range-grass-v4';
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), c = new THREE.Color(), e = new THREE.Euler();
    let n = 0, guard = 0;
    // where the blades go: the front of the tee box (right in front of the camera), the rough lip just past it,
    // and a thinner spread around
    const zones: [number, number, number, number, number][] = [ // x0, x1, z0, z1, share
      // the hero patch round the ball and the golfer's feet (left-hander at +x), then the rest of the tee, the lip and around
      [-16, 16, -14, -5.8, 0.42], [-24, 24, -26, -14, 0.15], [-30, 30, -36, 14, 0.18],
      // the tee itself, in front of the swing camera
      [-3.5, 4.5, -6.5, 2.6, 0.25],
    ];
    // one blade at (x, z) into `target` slot i: tee very short and crisp, fairway short, rough taller, darker and
    // more upright with a few seed heads of dry colour; returns false where no blade belongs
    const blade = (target: THREE.InstancedMesh, i: number, x: number, z: number, hk = 1): boolean => {
      const surf = surfaceAt(x, z);
      if (surf === 'bunker' || surf === 'green') return false;
      const nearEdge = teeSD(x, z) > -0.12 && teeSD(x, z) < 0.25; if (nearEdge) return false;
      if (surf === 'tee' && (Math.hypot(x, z) < 0.05 || (Math.abs(x - 0.9) < 0.38 && Math.abs(z) < 0.5) || (Math.abs(x + 0.9) < 0.38 && Math.abs(z) < 0.5))) return false;
      const rough = surf === 'rough';
      const h = surf === 'tee' ? 0.011 + rand() * 0.011 : surf === 'fairway' ? 0.024 + rand() * 0.02 : 0.045 + rand() * 0.045;
      p.set(x, heightAt(x, z) - 0.002, z);
      const lean = rough ? 0.35 : 0.5;
      e.set((rand() - 0.5) * lean, rand() * Math.PI * 2, (rand() - 0.5) * lean); q.setFromEuler(e);
      s.set(h * (rough ? 0.6 : 1), h * Math.max(0.05, hk), h * (rough ? 0.6 : 1));
      target.setMatrixAt(i, m4.compose(p, q, s));
      groundColorCPU(x, z, c).multiplyScalar((rough ? 0.8 : 0.82) + rand() * (rough ? 0.26 : 0.3));
      if (rand() < (rough ? 0.08 : 0.05)) c.lerp(COL.roughDry, rough ? 0.35 : 0.2);
      target.setColorAt(i, c);
      return true;
    };
    while (n < COUNT && guard++ < 600000) {
      const r0 = rand();
      let acc = 0, zn = zones[zones.length - 1];
      for (const zz of zones) { acc += zz[4]; if (r0 < acc) { zn = zz; break; } }
      const x = zn[0] + rand() * (zn[1] - zn[0]), z = zn[2] + rand() * (zn[3] - zn[2]);
      if (blade(im, n, x, z)) n++;
    }
    im.count = n;
    im.computeBoundingSphere();
    im.receiveShadow = true;
    im.name = 'grass';
    scene.add(im);
    thin.push({ im, full: n, f: { low: 0.3, med: 0.6, high: 1 } });
    // a patch of blades that follows the ball once it is down the range (landing and rest cameras): rough reads
    // tall and breaks the ball's silhouette, fairway reads as cut turf. Re-laid when the ball has moved on.
    const PATCH = 12000, PR = 4;
    const patchMat = mat.clone(); patchMat.customProgramCacheKey = mat.customProgramCacheKey;
    patchMat.onBeforeCompile = (sh, r) => { mat.onBeforeCompile(sh, r); sh.uniforms.uFade = patchMat.userData.fade; };
    patchMat.userData.fade = { value: new THREE.Vector2(30, 46) };
    const patch = new THREE.InstancedMesh(bladeGeo, patchMat, PATCH);
    patch.name = 'grass-patch';
    patch.count = 0; patch.visible = false; patch.receiveShadow = true; patch.frustumCulled = false;
    relayPatch = () => { patchAt.set(1e9, 0); };
    scene.add(patch);
    let lastLay = -1;
    grassPatch = (cx: number, cz: number, now: number) => {
      if (Math.hypot(cx, cz) < 24) { patch.count = 0; patch.visible = false; patchAt.set(1e9, 0); return; } // the tee's own blades cover it
      if (Math.hypot(cx - patchAt.x, cz - patchAt.y) < 2.5 || now - lastLay < 0.25) return;
      lastLay = now; patchAt.set(cx, cz);
      let k = 0;
      const save = seed; seed = (Math.floor(cx * 7.1) * 7919 + Math.floor(cz * 3.3)) | 1;
      const max = Math.round(PATCH * patchMax);
      for (let t = 0; t < max * 2 && k < max; t++) {
        // thicker right round the ball so it sits down in the rough, shorter and thinner out to nothing at the edge
        const a = rand() * Math.PI * 2, r = PR * Math.pow(rand(), 0.8);
        if (blade(patch, k, cx + Math.cos(a) * r, cz + Math.sin(a) * r, 1 - smooth(PR * 0.35, PR, r))) k++;
      }
      seed = save;
      patch.count = k; patch.visible = k > 0;
      patch.instanceMatrix.needsUpdate = true;
      if (patch.instanceColor) patch.instanceColor.needsUpdate = true;
    };
  }

  // contact shadow: a soft dark blob that grounds the golfer (real games bake or compute AO here)
  const contact = (() => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 128;
    const g2 = cv.getContext('2d')!, gr = g2.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(0.35, 'rgba(0,0,0,0.75)'); gr.addColorStop(0.7, 'rgba(0,0,0,0.25)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g2.fillStyle = gr; g2.fillRect(0, 0, 128, 128);
    const geo = new THREE.PlaneGeometry(1, 1); geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), color: lin('#0b1606'), transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, fog: false });
    const m = new THREE.Mesh(geo, mat); m.renderOrder = 2; m.visible = false; m.name = 'contact-shadow';
    scene.add(m);
    return m;
  })();

  function applyDetail(d: Detail) {
    detail = d;
    // low: skip the per-pixel turf bump and the tee divots in the ground shader (fill rate is what phones run out of)
    const low = d === 'low';
    const defs = (gmat.defines ??= {});
    if (low !== ('LOW_DETAIL' in defs)) { if (low) defs.LOW_DETAIL = 1; else delete defs.LOW_DETAIL; gmat.needsUpdate = true; }
    for (const t of thin) t.im.count = Math.max(0, Math.round(t.full * t.f[d]));
    lodFar = DETAIL.lodFar[d];
    patchMax = DETAIL.patch[d]; relayPatch();
    const ms = DETAIL.shadow[d];
    if (sun.shadow.mapSize.x !== ms) { sun.shadow.mapSize.set(ms, ms); sun.shadow.map?.dispose(); sun.shadow.map = null; half = 0; }
  }
  applyDetail(buildDetail);

  // featured target: ease from where it was to where it goes (slides down the range when the club changes)
  function placeFeat(t: number) {
    const e = t * t * (3 - 2 * t);
    FEAT.x = feat.from.x + (feat.to.x - feat.from.x) * e;
    FEAT.z = feat.from.y + (feat.to.y - feat.from.y) * e;
    FEAT.r = feat.r0 + (feat.r1 - feat.r0) * e;
    FEAT_U.value.set(FEAT.x, FEAT.z, FEAT.r, 1);
    const y = rawHeight(FEAT.x, FEAT.z);
    featGroup.position.set(FEAT.x, y, FEAT.z);
    featPin.scale.setScalar(feat.s0 + (feat.s1 - feat.s0) * e);
    featTarget.pos.set(FEAT.x, y, FEAT.z); featTarget.radius = FEAT.r;
  }

  // shadows: a tight box around the golfer while swinging (sharp), a wide box that follows the ball in flight
  let tight: { c: THREE.Vector3; r: number } | null = null;
  const tmp = new THREE.Vector3(), center = new THREE.Vector3();
  let time = 0;
  applyTime('golden');

  return {
    sun,
    targets,
    heightAt,
    surfaceAt,
    get timeOfDay() { return tod; },
    get sunDirection() { return sunDir; },
    get hazeColor() { return fogColor; },
    get avatarEnv() { return avatarRT!.texture; },
    setTimeOfDay(t) { if (t !== tod) applyTime(t); },
    get featured() { return FEAT.on > 0.5 ? featTarget : null; },
    get detail() { return detail; },
    setDetail(d) { applyDetail(d); },
    setWind(v) { windIn.copy(v); },
    setFeaturedTarget(yards) {
      if (yards === null || !(yards > 0)) {
        FEAT.on = 0; FEAT_U.value.w = 0; featGroup.visible = false;
        const i = targets.indexOf(featTarget); if (i >= 0) targets.splice(i, 1);
        return;
      }
      const yd = clamp(yards, 20, 330), z = -yd * YD, r = clamp(7 + yd * 0.04, 8.5, 17);
      // a spot near the line that clears the scenery greens and the bunkers, preferring a little right of centre
      const clear = (x: number) => {
        let c = Infinity;
        for (const g of GREENS) c = Math.min(c, Math.hypot(x - g.x, z - g.z) - g.r * 1.1 - r - FRINGE * 2);
        for (const b of BUNKERS) c = Math.min(c, Math.hypot(x - b.x, z - b.z) - Math.max(b.rx, b.rz) - r - 1.5);
        return c;
      };
      let best = fwCenter(z) + 2, bestC = -Infinity;
      for (const dx of [2, -2, 6, -6, 10, -10, 14, -14, 18, -18]) {
        const x = fwCenter(z) + dx, c = clear(x);
        if (c > 1) { best = x; bestC = c; break; }
        if (c > bestC) { best = x; bestC = c; }
      }
      // a bigger flag than the scenery greens' so it is the one the eye goes to (scaled up, the pole runs on
      // down through the cup bottom, out of sight)
      const s1 = clamp(pinScale(yd).kf / pinScale(150).kf * 1.1, 1.0, 1.35);
      if (FEAT.on < 0.5) { feat.from.set(best, z); feat.r0 = r; feat.s0 = s1; feat.t = 1; targets.push(featTarget); }
      else { feat.from.set(FEAT.x, FEAT.z); feat.r0 = FEAT.r; feat.s0 = featPin.scale.x; feat.t = 0; }
      feat.to.set(best, z); feat.r1 = r; feat.s1 = s1;
      FEAT.on = 1; featGroup.visible = true;
      featTarget.yards = Math.round(yd);
      placeFeat(feat.t >= 1 ? 1 : 0);
    },
    setShadowFocus(c, r = 4) { tight = c ? { c: c.clone(), r } : null; half = 0; },
    contactShadow(pos, strength = 1, radius = 0.55) {
      if (!pos) { contact.visible = false; return; }
      contact.visible = true;
      contact.position.set(pos.x, heightAt(pos.x, pos.z) + 0.004, pos.z);
      contact.scale.set(radius * 2.2, 1, radius * 1.7);
      (contact.material as THREE.MeshBasicMaterial).opacity = 0.6 * clamp(strength, 0, 1);
    },
    normalAt(x, z, out) {
      const e = 0.05;
      return out.set(heightAt(x - e, z) - heightAt(x + e, z), 2 * e, heightAt(x, z - e) - heightAt(x, z + e)).normalize();
    },
    update(dt, camera, focus) {
      time += dt;
      if (FEAT.on > 0.5 && feat.t < 1) { feat.t = Math.min(1, feat.t + dt / 0.9); placeFeat(feat.t); }
      // blades round the ball when it is on the ground down the range and the camera is close to it
      if (!tight && focus.y - heightAt(focus.x, focus.z) < 2.5 && camera.position.distanceTo(focus) < 40) grassPatch(focus.x, focus.z, time);
      // tree detail by distance from the camera to each chunk's stretch of the range
      camera.updateMatrixWorld();
      frustum.setFromProjectionMatrix(projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      for (const t of treeLods) {
        const cz = camera.position.z, d = Math.max(0, cz - t.zA, t.zB - cz) + Math.max(0, camera.position.y - 60);
        const far = d > lodFar, seen = frustum.intersectsBox(t.box);
        for (const m of t.hi) m.visible = seen && !far;
        for (const m of t.lo) m.visible = seen && far;
      }
      su.time.value = time;
      flagUniforms.uTime.value = time;
      updateLife(time);
      {
        // the range's wind (setWind), or a light breeze; strength eases so gusts and changes don't snap
        const w = windIn.lengthSq() > 0.09 ? windIn : BREEZE, sp = Math.hypot(w.x, w.z);
        const U = flagUniforms.uWind.value, k = 1 - Math.exp(-dt * 1.5);
        U.x += (w.x / sp - U.x) * k; U.y += (w.z / sp - U.y) * k;
        U.z += (clamp(sp / 9, 0.2, 1) - U.z) * k;
        treeUniforms.uWindS.value = U.z;
      }
      grassUniforms.uTime.value = time;
      treeUniforms.uTime.value = time;
      treeUniforms.uSunView.value.copy(sunDir).transformDirection(camera.matrixWorldInverse);
      let want: number;
      if (tight) {
        // centre the box between the feet and the tip of the shadow, so the whole shadow is inside it
        const reach = Math.min(9, 1.9 / Math.tan(Math.asin(clamp(sunDir.y, 0.08, 1))));
        center.set(-sunDir.x, 0, -sunDir.z).normalize().multiplyScalar(reach * 0.45).add(tight.c);
        want = tight.r + reach * 0.5;
      } else {
        center.copy(focus);
        // grows a little as the ball gets further from the tee (quantised to avoid texel swim)
        want = Math.ceil(clamp(14 + Math.hypot(focus.x, focus.z) * 0.12, 14, 55) / 4) * 4;
      }
      if (Math.abs(want - half) > 1e-3) {
        half = want;
        sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
        sc.near = 1; sc.far = tight ? 120 : 420;
        sc.updateProjectionMatrix();
        const texel = (2 * half) / sun.shadow.mapSize.x;
        // bias in world units scales with the texel size; soft edges a few texels wide
        sun.shadow.normalBias = texel * 2.2;
        sun.shadow.bias = tight ? -0.00012 : -0.00025;
        sun.shadow.radius = tight ? 5 : 2.5;
      }
      const texel = (2 * half) / sun.shadow.mapSize.x;
      const r = Math.round(center.dot(lightRight) / texel) * texel;
      const u = Math.round(center.dot(lightUp) / texel) * texel;
      const f = center.dot(sunDir);
      tmp.copy(lightRight).multiplyScalar(r).addScaledVector(lightUp, u).addScaledVector(sunDir, f);
      sun.target.position.copy(tmp);
      sun.position.copy(tmp).addScaledVector(sunDir, tight ? 60 : 200);
      sun.target.updateMatrixWorld();
    },
  };
}
