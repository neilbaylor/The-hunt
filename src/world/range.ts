// The driving range: sky, light, terrain, turf, greens, flags, yardage boards and trees.
// Everything is generated in code (no asset files) so the game can ship as one HTML file.
//
// World: metres, Y up. The teed ball is at the origin; the target line is -Z.
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type Surface = 'tee' | 'fairway' | 'rough' | 'green' | 'bunker';
export interface RangeTarget { yards: number; pos: THREE.Vector3; radius: number; color: string }
export interface Range {
  sun: THREE.DirectionalLight;
  /** every frame; focus = world point the shadow frustum should centre on (golfer at address, then the ball) */
  update(dt: number, camera: THREE.Camera, focus: THREE.Vector3): void;
  surfaceAt(x: number, z: number): Surface;
  heightAt(x: number, z: number): number;
  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3;
  targets: RangeTarget[];
}

export const YD = 0.9144;

// ───────────────────────── layout ─────────────────────────
// Sun: late afternoon, behind and to the left of the golfer's camera (which looks down -Z).
const SUN_ELEVATION = 27; // degrees
const SUN_AZIMUTH = -32; // degrees from +Z toward +X (negative = toward -X)

const TEE = { cx: 0, cz: 2, hx: 7, hz: 8, r: 1.4 }; // tee box rounded rectangle (x∈[-7,7], z∈[-6,10])
const TEE_DROP = 0.32; // how far the tee box stands above the ground around it
const FW_START = -16, FW_END = -322, CAP0 = 20, CAP1 = 26, FIRST_CUT = 2.6;
const FRINGE = 1.8;

interface Green { yards: number; x: number; z: number; r: number; p: number; color: string }
const GREENS: Green[] = [
  { yards: 50, x: -11, z: -50 * YD, r: 6.5, p: 0.3, color: '#d7263d' },
  { yards: 100, x: 13, z: -100 * YD, r: 8.5, p: 1.7, color: '#ffd23f' },
  { yards: 150, x: -16, z: -150 * YD, r: 10.5, p: 2.9, color: '#f4f4ef' },
  { yards: 200, x: 15, z: -200 * YD, r: 12, p: 4.2, color: '#2f6fdf' },
  { yards: 250, x: -12, z: -250 * YD, r: 13.5, p: 5.1, color: '#ff8a1c' },
  { yards: 300, x: 6, z: -300 * YD, r: 15, p: 0.9, color: '#9b5de5' },
];
interface Bunker { x: number; z: number; rx: number; rz: number; rot: number; p: number }
const BUNKERS: Bunker[] = [
  { x: -6.5, z: -126, rx: 4.8, rz: 2.4, rot: 0.45, p: 0.7 },
  { x: -29, z: -229, rx: 5.2, rz: 3.0, rot: -0.35, p: 2.1 },
  { x: 25, z: -150, rx: 7.5, rz: 2.8, rot: 0.12, p: 3.3 },
  { x: 3, z: -254, rx: 6.2, rz: 2.2, rot: 0.05, p: 4.6 },
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
const wob = (a: number, p: number) => 1 + 0.08 * Math.sin(2 * a + p) + 0.05 * Math.sin(3 * a + 2 * p);
/** normalised distance from a green's centre (1 = edge of the putting surface) */
function greenD(g: Green, x: number, z: number): number {
  const dx = x - g.x, dz = z - g.z;
  return Math.hypot(dx, dz) / (g.r * wob(Math.atan2(dz, dx), g.p));
}
function bunkerD(b: Bunker, x: number, z: number): number {
  const dx = x - b.x, dz = z - b.z, c = Math.cos(b.rot), s = Math.sin(b.rot);
  const u = (dx * c + dz * s) / b.rx, v = (-dx * s + dz * c) / b.rz;
  const a = Math.atan2(v, u);
  return Math.hypot(u, v) / (1 + 0.1 * Math.sin(3 * a + b.p) + 0.06 * Math.sin(5 * a + b.p * 1.7));
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
  h += smooth(650, 1500, r) * (55 + 120 * fbm(x / 520 + 3.1, z / 520 - 2.7, 5));
  if (withCanopy && out > 60) h += canopyAt(x, z);
  // gentle movement inside the corridor, flat at the tee and on the greens
  let flat = smooth(14, 45, Math.hypot(x, z));
  for (const g of GREENS) flat = Math.min(flat, smooth(1.0, 2.2, greenD(g, x, z)));
  h += (1 - a) * flat * (0.35 * Math.sin(x / 31 + 0.7) * Math.sin(z / 47) + 0.25 * Math.sin((x + z) / 63));
  // raised greens with a soft collar
  for (const g of GREENS) {
    const d = greenD(g, x, z);
    if (d < 1.6) h += 0.32 * (1 - smooth(1.0, 1.45, d)) + 0.06 * Math.max(0, 1 - d * d);
  }
  // bunkers dug in
  for (const b of BUNKERS) {
    const d = bunkerD(b, x, z);
    if (d < 1.4) h -= 0.38 * (1 - smooth(0.55, 1.08, d)) - 0.06 * smooth(1.0, 1.12, d) * (1 - smooth(1.12, 1.35, d));
  }
  // the tee box stands proud of its surroundings
  h -= TEE_DROP * (1 - smooth(0, 16, Math.max(teeSD(x, z), 0)));
  return h;
}
function heightAt(x: number, z: number): number { return teeSD(x, z) <= 0 ? 0 : rawHeight(x, z); }
function surfaceAt(x: number, z: number): Surface {
  if (teeSD(x, z) <= 0) return 'tee';
  for (const b of BUNKERS) if (bunkerD(b, x, z) < 1) return 'bunker';
  for (const g of GREENS) { const d = greenD(g, x, z); if (d < 1) return 'green'; if (d < 1 + FRINGE / g.r) return 'fairway'; }
  const h = fwHalf(z, 0);
  if (h > 0 && Math.abs(x - fwCenter(z)) < h) return 'fairway';
  return 'rough';
}

// ───────────────────────── colours ─────────────────────────
const lin = (hex: string) => new THREE.Color(hex); // THREE.Color converts sRGB hex to linear
const COL = {
  rough: lin('#2f5a1d'), roughDry: lin('#6b7230'), meadow: lin('#4f6b28'), cut: lin('#3f7724'),
  fwDark: lin('#3b7321'), fwLight: lin('#548f30'), fringe: lin('#467f28'),
  green: lin('#4a8f2d'), greenLight: lin('#579c36'), tee: lin('#457f28'), teeLight: lin('#518d30'),
  sand: lin('#dccb9b'), sandDark: lin('#b59f72'), lip: lin('#2f5f1c'), forest: lin('#1d3313'), forestLeaf: lin('#1b3412'), forestLeafLight: lin('#3f5f22'),
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

function makeSignAtlas(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  // 4×4 cells of 512×256; cells 0..5 = yardages, cell 6 = board back
  const cv = document.createElement('canvas'); cv.width = 2048; cv.height = 1024;
  const g = cv.getContext('2d')!;
  const cell = (i: number) => [(i % 4) * 512, Math.floor(i / 4) * 256] as const;
  GREENS.forEach((gr, i) => {
    const [x, y] = cell(i);
    g.fillStyle = '#0f3d24'; g.fillRect(x, y, 512, 256);
    g.fillStyle = '#f6f3ea'; g.fillRect(x + 14, y + 14, 484, 228);
    g.fillStyle = gr.color; g.fillRect(x + 14, y + 14, 484, 26);
    g.fillStyle = '#0f3d24'; g.fillRect(x + 14, y + 40, 484, 3);
    g.fillStyle = '#132a1e'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.font = '900 168px "Arial Black", "Helvetica Neue", Arial, sans-serif';
    g.fillText(String(gr.yards), x + 236, y + 214);
    g.font = '700 34px "Arial Narrow", Arial, sans-serif';
    g.save(); g.translate(x + 462, y + 150); g.rotate(-Math.PI / 2); g.fillText('YDS', 0, 0); g.restore();
  });
  const [bx, by] = cell(6);
  g.fillStyle = '#123323'; g.fillRect(bx, by, 512, 256);
  g.strokeStyle = '#0b2418'; g.lineWidth = 10; g.strokeRect(bx + 20, by + 20, 472, 216);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

// ───────────────────────── ground material ─────────────────────────
function groundMaterial(noise: THREE.Texture, forest: THREE.Texture): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  const greens = GREENS.map(g => `vec4(${g.x.toFixed(3)}, ${g.z.toFixed(3)}, ${g.r.toFixed(3)}, ${g.p.toFixed(3)})`).join(', ');
  const bunkA = BUNKERS.map(b => `vec4(${b.x.toFixed(3)}, ${b.z.toFixed(3)}, ${b.rx.toFixed(3)}, ${b.rz.toFixed(3)})`).join(', ');
  const bunkB = BUNKERS.map(b => `vec2(${b.rot.toFixed(4)}, ${b.p.toFixed(3)})`).join(', ');
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNoise = { value: noise };
    sh.uniforms.uForest = { value: forest };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNrm = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWPos;
varying vec3 vWNrm;
uniform sampler2D uNoise;
uniform sampler2D uForest;
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
  vec3 meadow = mix(${v3(COL.meadow)}, ${v3(COL.roughDry)}, clamp(smoothstep(20.0, 140.0, vWPos.y) * 0.6 + slope * 2.0 + (n3 - 0.5) * 0.8, 0.0, 1.0));
  col = mix(col, meadow, wild * 0.85);
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
  col *= 0.76 + 0.44 * var;
  // first cut ring
  float cut = inside(fwSD(p, ${FIRST_CUT.toFixed(1)}), 0.0);
  col = mix(col, ${v3(COL.cut)} * (0.88 + 0.22 * var), cut);
  gRough = 1.0;
  // fairway with mowing stripes across the line and fainter lanes along it
  float fw = inside(fwSD(p, 0.0), 0.0);
  float across = stripes(p.y / 9.144 + 0.5), along = stripes(p.x / 9.0 + 0.5);
  vec3 fwc = mix(${v3(COL.fwDark)}, ${v3(COL.fwLight)}, 0.68 * across + 0.32 * along);
  fwc *= 0.9 + 0.18 * (0.6 * n1 + 0.4 * n2);
  col = mix(col, fwc, fw);
  gRough = mix(gRough, 0.92, fw);
  // greens: fringe collar then the putting surface, both slightly raised in the mesh
  for (int i = 0; i < ${GREENS.length}; i++) {
    vec4 g = GREENS[i];
    vec2 d = p - g.xy;
    float a = atan(d.y, d.x);
    float gd = length(d) / (g.z * (1.0 + 0.08 * sin(2.0 * a + g.w) + 0.05 * sin(3.0 * a + 2.0 * g.w)));
    if (gd > 1.6) continue;
    float fr = inside(gd, 1.0 + ${FRINGE.toFixed(2)} / g.z);
    col = mix(col, ${v3(COL.fringe)} * (0.92 + 0.14 * n1), fr);
    float gm = inside(gd, 1.0);
    vec3 gc = mix(${v3(COL.green)}, ${v3(COL.greenLight)}, 0.45 * stripes(p.y / 2.8) + 0.12 * stripes(p.x / 2.8));
    gc *= 0.95 + 0.08 * n1;
    col = mix(col, gc, gm);
    gRough = mix(gRough, 0.82, gm);
    gBump = mix(gBump, 0.28, gm);
  }
  // bunkers: dark grass lip, then raked sand
  for (int i = 0; i < ${BUNKERS.length}; i++) {
    vec4 b = BUNKA[i]; vec2 bb = BUNKB[i];
    vec2 d = p - b.xy; float c = cos(bb.x), s = sin(bb.x);
    vec2 uv = vec2((d.x * c + d.y * s) / b.z, (-d.x * s + d.y * c) / b.w);
    float a = atan(uv.y, uv.x);
    float bd = length(uv) / (1.0 + 0.1 * sin(3.0 * a + bb.y) + 0.06 * sin(5.0 * a + bb.y * 1.7));
    if (bd > 1.4) continue;
    col = mix(col, ${v3(COL.lip)} * (0.9 + 0.2 * n1), inside(bd, 1.13) * 0.85);
    float sm = inside(bd, 1.0);
    vec3 sc = mix(${v3(COL.sand)}, ${v3(COL.sandDark)}, smoothstep(0.75, 1.0, bd) * 0.7);
    sc *= 0.86 + 0.1 * n4 + 0.08 * n1 + 0.035 * sin(dot(p, vec2(0.8, 2.4)) * 7.0);
    col = mix(col, sc, sm);
    gRough = mix(gRough, 1.0, sm);
    gBump = mix(gBump, 0.5, sm);
  }
  // tee box: short diagonal-cut turf
  float tm = inside(teeSD(p), 0.0);
  vec3 tc = mix(${v3(COL.tee)}, ${v3(COL.teeLight)}, 0.85 * stripes((p.x + p.y) / 1.6));
  tc *= 0.92 + 0.14 * n1 + 0.05 * n4;
  col = mix(col, tc, tm);
  gRough = mix(gRough, 0.9, tm);
  gBump = mix(gBump, 0.75, tm);
  // tiny per-pixel grain so close-up turf isn't plastic
  col *= 0.94 + 0.12 * n4 * (1.0 - smoothstep(4.0, 30.0, length(vWPos - cameraPosition)));
  return col;
}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= groundColor(vWPos.xz);')
      // fine turf bump near the camera so close-up grass catches the light unevenly
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  float fadeB = 1.0 - smoothstep(5.0, 45.0, length(vWPos - cameraPosition));
  if (fadeB > 0.0) {
    vec2 q = vWPos.xz * 2.3;
    float h0 = texture2D(uNoise, q).r, hx = texture2D(uNoise, q + vec2(0.006, 0.0)).r, hz = texture2D(uNoise, q + vec2(0.0, 0.006)).r;
    float g0 = texture2D(uNoise, vWPos.xz * 0.9).a;
    vec3 wb = vec3(h0 - hx, 0.0, h0 - hz) * (5.0 + 4.0 * g0) * fadeB * gBump;
    normal = normalize(normal + (viewMatrix * vec4(wb, 0.0)).xyz);
  }
}`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;')
      // turf is a poor mirror: damp the sky sheen that makes grass look plastic at grazing angles
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nreflectedLight.directSpecular *= 0.3;\nreflectedLight.indirectSpecular *= 0.25;');
  };
  m.customProgramCacheKey = () => 'range-ground-v3';
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
function terrainChunks(): THREE.BufferGeometry[] {
  const xs = axis(-110, 110, 2, -5200, 5200, 1.13);
  const zs = axis(-372, 60, 2, -5600, 4200, 1.13);
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
  const depth = 0.8, bev = 0.07;
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: bev, bevelSize: 0.08, bevelSegments: 3, curveSegments: 6 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, -(depth + bev), 0);
  g.deleteAttribute('uv');
  g.computeVertexNormals();
  return g;
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
function trunk(h: number, r: number, bark: THREE.Color): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r * 0.65, r, h, 7, 2, true).toNonIndexed();
  g.translate(0, h / 2, 0);
  return paint(g, (_x, y, _z, _a, _b, _c, c) => { c.copy(bark).multiplyScalar(0.55 + 0.45 * clamp(y / h, 0, 1)); });
}
function finish(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const clean = parts.map(g => { const n = g.index ? g.toNonIndexed() : g; for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'color') n.deleteAttribute(k); return n; });
  const m = mergeGeometries(clean, false)!;
  m.computeBoundingSphere();
  return m;
}
function broadleafGeo(detail: number): THREE.BufferGeometry {
  const leaf = lin('#355d22'), bark = lin('#4f3f30');
  const C = new THREE.Vector3(0, 6.2, 0);
  const parts = [trunk(4.4, 0.32, bark)];
  const lumps: [number, number, number, number][] = [[0, 6.7, 0, 2.7], [1.8, 5.6, 0.6, 2.0], [-1.7, 5.8, -0.4, 2.1], [0.3, 5.4, -1.8, 1.9], [-0.4, 5.3, 1.7, 1.9]];
  for (const [x, y, z, r] of lumps) parts.push(blob(x, y, z, r, 0.92, detail, C, leaf, 3.6, 9.4));
  return finish(parts);
}
function pineGeo(seg = 11, rows = 3): THREE.BufferGeometry {
  const leaf = lin('#22432a'), bark = lin('#46372a');
  const parts = [trunk(3, 0.26, bark)];
  const tiers: [number, number, number][] = [[2.2, 3.0, 5.0], [4.2, 2.4, 4.4], [6.0, 1.8, 3.8], [7.6, 1.2, 3.2], [9.0, 0.7, 2.4]];
  tiers.forEach(([y, r, h], ti) => {
    const g = new THREE.ConeGeometry(r, h, seg, rows, true).toNonIndexed();
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), yy = p.getY(i), z = p.getZ(i);
      const a = Math.atan2(z, x), edge = yy < -h / 2 + 0.01 ? 1 : 0;
      const k = 1 + 0.12 * Math.sin(a * 5 + ti * 1.7) * (0.4 + 0.6 * edge);
      p.setXYZ(i, x * k, yy + y + h / 2 - 0.4 - edge * 0.35 * (0.5 + 0.5 * Math.sin(a * 7 + ti)), z * k);
    }
    g.computeVertexNormals();
    const nrm = g.getAttribute('normal');
    for (let i = 0; i < nrm.count; i++) { const v = new THREE.Vector3(nrm.getX(i), nrm.getY(i) + 0.35, nrm.getZ(i)).normalize(); nrm.setXYZ(i, v.x, v.y, v.z); }
    parts.push(paint(g, (_x, yy, _z, _a, _b, _c, c) => { const t = clamp((yy - y + h / 2) / h, 0, 1); c.copy(leaf).multiplyScalar(0.5 + 0.65 * t); }));
  });
  return finish(parts);
}
function poplarGeo(detail: number): THREE.BufferGeometry {
  const leaf = lin('#3e6a26'), bark = lin('#5a4c3c');
  const C = new THREE.Vector3(0, 7.5, 0);
  const parts = [trunk(3.2, 0.24, bark)];
  const lumps: [number, number, number, number][] = [[0, 4.8, 0, 1.8], [0.2, 6.9, 0.1, 1.8], [-0.1, 9.0, -0.1, 1.5], [0.1, 10.7, 0, 1.1]];
  for (const [x, y, z, r] of lumps) parts.push(blob(x, y, z, r, 1.25, detail, C, leaf, 3.0, 11.8));
  return finish(parts);
}
function farTreeGeo(): THREE.BufferGeometry {
  const leaf = lin('#2e4f22');
  const C = new THREE.Vector3(0, 5.5, 0);
  const t = new THREE.CylinderGeometry(0.2, 0.3, 2.4, 5, 1, true).toNonIndexed(); t.translate(0, 1.2, 0);
  return finish([paint(t, (_x, _y, _z, _a, _b, _c, c) => c.copy(lin('#3f3326'))), blob(0, 6.0, 0, 3.2, 1.3, 0, C, leaf, 1.8, 10)]);
}

// ───────────────────────── build ─────────────────────────
export function createRange(renderer: THREE.WebGLRenderer, scene: THREE.Scene): Range {
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - SUN_ELEVATION), THREE.MathUtils.degToRad(SUN_AZIMUTH));

  // sky + image-based light
  const skyParams = { turbidity: 5.5, rayleigh: 1.35, mieCoefficient: 0.0055, mieDirectionalG: 0.82 };
  const sky = new Sky();
  sky.scale.setScalar(6000);
  const su = sky.material.uniforms;
  su.turbidity.value = skyParams.turbidity; su.rayleigh.value = skyParams.rayleigh;
  su.mieCoefficient.value = skyParams.mieCoefficient; su.mieDirectionalG.value = skyParams.mieDirectionalG;
  su.sunPosition.value.copy(sunDir);
  su.cloudCoverage.value = 0.32; su.cloudDensity.value = 0.42; su.cloudScale.value = 0.00022; su.cloudSpeed.value = 0.00003; su.cloudElevation.value = 0.55;
  sky.frustumCulled = false;
  scene.add(sky);
  {
    const envScene = new THREE.Scene();
    const envSky = new Sky();
    envSky.scale.setScalar(1000);
    const eu = envSky.material.uniforms;
    for (const k of Object.keys(skyParams) as (keyof typeof skyParams)[]) eu[k].value = skyParams[k];
    eu.sunPosition.value.copy(sunDir); eu.showSunDisc.value = 0; eu.cloudCoverage.value = 0.32; eu.cloudDensity.value = 0.42;
    envScene.add(envSky);
    // a green "ground" below the horizon so turf picks up green bounce light
    const groundDome = new THREE.Mesh(new THREE.SphereGeometry(900, 24, 12, 0, Math.PI * 2, Math.PI / 2 + 0.02, Math.PI / 2), new THREE.MeshBasicMaterial({ color: lin('#3c5a2a'), side: THREE.BackSide }));
    envScene.add(groundDome);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const rt = pmrem.fromScene(envScene, 0.02, 0.1, 5000);
    scene.environment = rt.texture;
    scene.environmentIntensity = 0.5;
    pmrem.dispose();
    envSky.geometry.dispose(); envSky.material.dispose();
  }
  const FOG = new THREE.Color('#c4d3dc');
  scene.fog = new THREE.FogExp2(FOG.getHex(), 0.00042);
  scene.background = FOG.clone();

  // lights
  const hemi = new THREE.HemisphereLight(lin('#cfe0f2'), lin('#4a5a32'), 0.32);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(lin('#ffd29a'), 3.0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.00025;
  sun.shadow.normalBias = 0.035;
  sun.shadow.radius = 2.5;
  const sc = sun.shadow.camera;
  sc.near = 1; sc.far = 420;
  scene.add(sun, sun.target);

  // ground
  const noise = makeNoiseTexture(renderer);
  const gmat = groundMaterial(noise, makeForestTexture());
  for (const g of terrainChunks()) {
    const terrain = new THREE.Mesh(g, gmat);
    terrain.receiveShadow = true;
    terrain.name = 'terrain';
    scene.add(terrain);
  }
  const teeBox = new THREE.Mesh(teeBoxGeometry(), gmat);
  teeBox.receiveShadow = true; teeBox.castShadow = true;
  scene.add(teeBox);

  // tee markers: chunky "golf ball" markers on short stems
  {
    const parts: THREE.BufferGeometry[] = [];
    for (const sx of [-4.9, 4.9]) {
      const ball = new THREE.SphereGeometry(0.11, 18, 12); ball.translate(sx, 0.13, -2.2);
      const stem = new THREE.CylinderGeometry(0.025, 0.03, 0.06, 8); stem.translate(sx, 0.02, -2.2);
      parts.push(paint(ball, (_x, _y, _z, _a, ny, _c, c) => c.copy(lin('#1f5fd6')).multiplyScalar(0.85 + 0.15 * ny)), paint(stem, (_x, _y, _z, _a, _b, _c, c) => c.copy(lin('#d9d9d9'))));
    }
    const m = new THREE.Mesh(finish(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0 }));
    m.castShadow = true;
    scene.add(m);
  }

  // greens: flags, poles, yardage boards
  const targets: RangeTarget[] = GREENS.map(g => ({ yards: g.yards, pos: new THREE.Vector3(g.x, heightAt(g.x, g.z), g.z), radius: g.r, color: g.color }));
  const flagUniforms = { uTime: { value: 0 } };
  {
    const poles: THREE.BufferGeometry[] = [], flags: THREE.BufferGeometry[] = [], boards: THREE.BufferGeometry[] = [], posts: THREE.BufferGeometry[] = [];
    GREENS.forEach((g, i) => {
      const y0 = heightAt(g.x, g.z);
      const k = 1 + g.yards / 150; // targets grow with distance so they read from the tee
      const H = 2.3 * k, fw = 0.62 * k, fh = 0.42 * k, pr = 0.022 * k;
      const pole = new THREE.CylinderGeometry(pr, pr, H, 8, 8, false); pole.translate(g.x, y0 + H / 2, g.z);
      poles.push(paint(pole, (_x, y, _z, _a, _b, _c, c) => c.copy(Math.floor((y - y0) / (H / 8)) % 2 ? lin('#c8282e') : lin('#f2f2ee'))));
      const flag = new THREE.PlaneGeometry(fw, fh, 10, 4); flag.translate(fw / 2, 0, 0);
      const u = new Float32Array(flag.getAttribute('position').count);
      for (let v = 0; v < u.length; v++) u[v] = flag.getAttribute('position').getX(v) / fw;
      flag.setAttribute('aU', new THREE.BufferAttribute(u, 1));
      flag.translate(g.x + pr, y0 + H - fh / 2 - 0.02, g.z);
      flags.push(paint(flag, (_x, _y, _z, _a, _b, _c, c) => c.copy(lin(g.color))));
      // yardage board beside the green, on the outside, facing the tee
      const side = g.x < 0 ? -1 : 1;
      const W = 2.6 + g.yards * 0.021, BH = W * 0.5, lift = 0.7 + W * 0.1;
      const bx = g.x + side * (g.r + W / 2 + 3.5), bz = g.z - 1.5, by = rawHeight(bx, bz);
      const cellUV = (cell: number) => [(cell % 4) * 0.25, 1 - (Math.floor(cell / 4) + 1) * 0.25] as const;
      const face = (cell: number, back: boolean) => {
        const pg = new THREE.PlaneGeometry(W, BH);
        const [u0, v0] = cellUV(cell), uv = pg.getAttribute('uv');
        for (let v = 0; v < uv.count; v++) uv.setXY(v, u0 + uv.getX(v) * 0.25, v0 + uv.getY(v) * 0.25);
        if (back) pg.rotateY(Math.PI);
        pg.rotateY(-side * 0.12);
        pg.translate(bx, by + lift + BH / 2, bz + (back ? -0.03 : 0.03));
        return pg;
      };
      boards.push(face(i, false), face(6, true));
      for (const px of [-W * 0.36, W * 0.36]) {
        const post = new THREE.BoxGeometry(0.12 * (W / 4), lift + BH * 0.9, 0.12 * (W / 4));
        post.translate(bx + px * Math.cos(side * 0.12), by + (lift + BH * 0.9) / 2 - 0.1, bz - 0.12 + px * Math.sin(side * 0.12));
        posts.push(paint(post, (_x, _y, _z, _a, _b, _c, c) => c.copy(lin('#2a2a26'))));
      }
    });
    const poleMesh = new THREE.Mesh(finish(poles), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45 }));
    poleMesh.castShadow = true;
    const flagMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide });
    flagMat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = flagUniforms.uTime;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aU;\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
float ph = position.x * 0.37 + position.z * 0.11;
float wv = sin(aU * 7.5 - uTime * 5.5 + ph) * 0.11 + sin(aU * 13.0 - uTime * 9.0 + ph * 2.0) * 0.03;
transformed.z += wv * aU * (0.6 + 0.4 * sin(uTime * 0.7 + ph));
transformed.y -= aU * aU * 0.05;`);
    };
    flagMat.customProgramCacheKey = () => 'range-flag-v1';
    // flags keep their geometry attribute aU through merging
    const flagGeo = mergeGeometries(flags.map(f => { const n = f.toNonIndexed(); n.deleteAttribute('uv'); return n; }), false)!;
    const flagMesh = new THREE.Mesh(flagGeo, flagMat);
    flagMesh.castShadow = true;
    const atlas = makeSignAtlas(renderer);
    const boardGeo = mergeGeometries(boards.map(b => b.toNonIndexed()), false)!;
    const boardMesh = new THREE.Mesh(boardGeo, new THREE.MeshStandardMaterial({ map: atlas, roughness: 0.7 }));
    boardMesh.castShadow = true;
    const postMesh = new THREE.Mesh(finish(posts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }));
    postMesh.castShadow = true;
    scene.add(poleMesh, flagMesh, boardMesh, postMesh);
  }

  // trees
  const treeLods: { zA: number; zB: number; hi: THREE.InstancedMesh[]; lo: THREE.InstancedMesh[] }[] = [];
  {
    const species = [broadleafGeo(1), pineGeo(), poplarGeo(1)];
    const speciesLo = [broadleafGeo(0), pineGeo(7, 1), poplarGeo(0)];
    const treeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
    // near the corridor: grouped by distance down the range so frustum culling (camera and shadows) works
    const CH = [[200, -40], [-40, -150], [-150, -260], [-260, -720]];
    const buckets: THREE.Matrix4[][][] = CH.map(() => species.map(() => []));
    const tints: THREE.Color[][][] = CH.map(() => species.map(() => []));
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const blocked = (x: number, z: number) => {
      if (teeSD(x, z) < 8) return true;
      for (const g of GREENS) if (greenD(g, x, z) < 2.2) return true;
      for (const g of GREENS) { const side = g.x < 0 ? -1 : 1, W = 2.6 + g.yards * 0.021; if (Math.abs(x - (g.x + side * (g.r + W / 2 + 3.5))) < W && Math.abs(z - g.z) < 8) return true; }
      return false;
    };
    const blobs: { x: number; z: number; r: number; h: number }[] = [];
    const tintOf = (out: THREE.Color, k: number) => {
      // natural spread: most trees a little darker or lighter, some yellower, some bluer
      const b = 0.78 + rand() * 0.42, warm = (rand() - 0.5) * 0.22 * k;
      return out.setRGB(b * (1 + warm), b, b * (1 - warm * 0.8));
    };
    const place = (x: number, z: number, sp: number, scl: number) => {
      if (blocked(x, z)) return;
      const ci = CH.findIndex(([a, b]) => z <= a && z > b); if (ci < 0) return;
      p.set(x, rawHeight(x, z, false) - 0.15, z);
      q.setFromAxisAngle(up, rand() * Math.PI * 2);
      s.set(scl * (0.9 + rand() * 0.2), scl * (0.85 + rand() * 0.35), scl * (0.9 + rand() * 0.2));
      buckets[ci][sp].push(m4.compose(p, q, s).clone());
      tints[ci][sp].push(tintOf(new THREE.Color(), 1));
      blobs.push({ x, z, r: (sp === 1 ? 2.6 : sp === 2 ? 1.9 : 3.2) * s.x, h: (sp === 1 ? 10 : sp === 2 ? 11 : 9) * s.y });
    };
    // two or three loose rows down each side
    for (const side of [-1, 1]) {
      for (let z = 70; z > -400; z -= 4 + rand() * 6) {
        const h = Math.max(fwHalf(z, 0), 22);
        const rows = 1 + Math.floor(rand() * 3);
        for (let r = 0; r < rows; r++) {
          const dx = h + 26 + r * 9 + rand() * 14 + (z > -20 ? 6 : 0);
          const x = fwCenter(z) + side * dx;
          const sp = rand() < 0.5 ? 0 : rand() < 0.6 ? 1 : 2;
          place(x, z + (rand() - 0.5) * 3, sp, 0.85 + rand() * 0.6);
        }
      }
    }
    // the far end and behind the tee
    for (let i = 0; i < 140; i++) { const x = (rand() - 0.5) * 260, z = -345 - rand() * 120; place(x, z, rand() < 0.5 ? 0 : 1, 0.9 + rand() * 0.7); }
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
        for (const [g, set] of [[geo, hi], [speciesLo[si], lo]] as const) {
          const im = new THREE.InstancedMesh(g, treeMat, list.length);
          list.forEach((mm, i) => { im.setMatrixAt(i, mm); im.setColorAt(i, tints[ci][si][i]); });
          im.computeBoundingSphere();
          scene.add(im);
          set.push(im);
        }
      });
      treeLods.push({ zA, zB, hi, lo });
    });
    // soft long "baked" shadows under the corridor trees (the real shadow map only covers the focus area)
    {
      const cv = document.createElement('canvas'); cv.width = cv.height = 128;
      const g2 = cv.getContext('2d')!, gr = g2.createRadialGradient(64, 64, 6, 64, 64, 64);
      gr.addColorStop(0, 'rgba(0,0,0,0.85)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g2.fillStyle = gr; g2.fillRect(0, 0, 128, 128);
      const tex = new THREE.CanvasTexture(cv);
      const quad = new THREE.PlaneGeometry(1, 1); quad.rotateX(-Math.PI / 2);
      const sm = new THREE.MeshBasicMaterial({ map: tex, color: lin('#0d1f08'), transparent: true, opacity: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      const shadowDir = new THREE.Vector2(-sunDir.x, -sunDir.z).normalize();
      const reach = 1 / Math.tan(THREE.MathUtils.degToRad(SUN_ELEVATION));
      const im = new THREE.InstancedMesh(quad, sm, blobs.length);
      const ang = Math.atan2(shadowDir.x, shadowDir.y);
      blobs.forEach((b, i) => {
        const len = b.r * 2 + b.h * reach * 0.55;
        const cx = b.x + shadowDir.x * (len / 2 - b.r * 0.8), cz = b.z + shadowDir.y * (len / 2 - b.r * 0.8);
        p.set(cx, rawHeight(cx, cz) + 0.12, cz);
        q.setFromAxisAngle(up, ang);
        s.set(b.r * 2.1, 1, len);
        im.setMatrixAt(i, m4.compose(p, q, s));
      });
      im.computeBoundingSphere();
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
    const fgeo = farTreeGeo();
    // split left / right so each half can be culled
    for (const sgn of [-1, 1]) {
      const idx = far.map((m, i) => [m, i] as const).filter(([m]) => Math.sign(m.elements[12] - fwCenter(m.elements[14])) === sgn);
      const im = new THREE.InstancedMesh(fgeo, treeMat, idx.length);
      idx.forEach(([m, i], k) => { im.setMatrixAt(k, m); im.setColorAt(k, farTint[i]); });
      im.computeBoundingSphere();
      scene.add(im);
    }
  }

  // grass blades around the tee: real turf in the foreground
  const grassUniforms = { uTime: { value: 0 } };
  {
    const bladeGeo = new THREE.BufferGeometry();
    const w = 0.05;
    bladeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-w, 0, 0, w, 0, 0, -w * 0.7, 0.5, 0.03, w * 0.7, 0.5, 0.03, 0, 1, 0.12]), 3));
    bladeGeo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 1, 0.2, 0, 1, 0.2, 0, 1, 0.2, 0, 1, 0.2, 0, 1, 0.2]), 3));
    bladeGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array([0.72, 0.72, 0.72, 0.72, 0.72, 0.72, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 1.18, 1.18, 1.05]), 3));
    bladeGeo.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4]);
    const COUNT = 26000;
    const im = new THREE.InstancedMesh(bladeGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide }), COUNT);
    const mat = im.material as THREE.MeshStandardMaterial;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = grassUniforms.uTime;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <project_vertex>', `
vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
float fade = 1.0 - smoothstep(16.0, 30.0, distance(ip.xz, cameraPosition.xz));
vec4 mvPosition = instanceMatrix * vec4(transformed * vec3(1.0, fade, 1.0), 1.0);
float hgt = position.y * position.y;
float gust = sin(uTime * 1.3 + ip.x * 0.15 + ip.z * 0.09) * 0.5 + 0.5;
float sway = (sin(uTime * 2.6 + ip.x * 1.7 + ip.z * 1.3) * 0.6 + gust) * hgt * instanceMatrix[1][1] * 0.22;
mvPosition.xz += vec2(0.8, -0.35) * sway;
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`);
    };
    mat.customProgramCacheKey = () => 'range-grass-v1';
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), c = new THREE.Color(), e = new THREE.Euler();
    let n = 0, guard = 0;
    // where the blades go: the front of the tee box (right in front of the camera), the rough lip just past it,
    // and a thinner spread around
    const zones: [number, number, number, number, number][] = [ // x0, x1, z0, z1, share
      [-7, 7, -6.2, 1.5, 0.5], [-16, 16, -18, -5.8, 0.32], [-30, 30, -36, 12, 0.18],
    ];
    while (n < COUNT && guard++ < 400000) {
      const r0 = rand();
      const zn = r0 < zones[0][4] ? zones[0] : r0 < zones[0][4] + zones[1][4] ? zones[1] : zones[2];
      const x = zn[0] + rand() * (zn[1] - zn[0]), z = zn[2] + rand() * (zn[3] - zn[2]);
      const surf = surfaceAt(x, z);
      if (surf === 'bunker' || surf === 'green') continue;
      const nearEdge = teeSD(x, z) > -0.12 && teeSD(x, z) < 0.25; if (nearEdge) continue;
      const h = surf === 'tee' ? 0.016 + rand() * 0.014 : surf === 'fairway' ? 0.022 + rand() * 0.02 : 0.05 + rand() * 0.07;
      p.set(x, heightAt(x, z) - 0.002, z);
      e.set((rand() - 0.5) * 0.5, rand() * Math.PI * 2, (rand() - 0.5) * 0.5); q.setFromEuler(e);
      s.set(h, h, h);
      im.setMatrixAt(n, m4.compose(p, q, s));
      groundColorCPU(x, z, c).multiplyScalar(0.95 + rand() * 0.35);
      if (surf === 'rough' && rand() < 0.08) c.lerp(COL.roughDry, 0.6);
      im.setColorAt(n, c);
      n++;
    }
    im.count = n;
    im.computeBoundingSphere();
    im.receiveShadow = true;
    scene.add(im);
  }

  // shadow camera follows `focus`, snapped to whole shadow texels so it doesn't shimmer
  const lightRight = new THREE.Vector3().crossVectors(up0(), sunDir).normalize();
  const lightUp = new THREE.Vector3().crossVectors(sunDir, lightRight).normalize();
  const tmp = new THREE.Vector3();
  let half = 0;
  let time = 0;

  return {
    sun,
    targets,
    heightAt,
    surfaceAt,
    normalAt(x, z, out) {
      const e = 0.05;
      return out.set(heightAt(x - e, z) - heightAt(x + e, z), 2 * e, heightAt(x, z - e) - heightAt(x, z + e)).normalize();
    },
    update(dt, camera, focus) {
      time += dt;
      // tree detail by distance from the camera to each chunk's stretch of the range
      for (const t of treeLods) {
        const cz = camera.position.z, d = Math.max(0, cz - t.zA, t.zB - cz) + Math.max(0, camera.position.y - 60);
        const far = d > 90;
        for (const m of t.hi) m.visible = !far;
        for (const m of t.lo) m.visible = far;
      }
      su.time.value = time;
      flagUniforms.uTime.value = time;
      grassUniforms.uTime.value = time;
      // frustum grows a little as the ball gets further from the tee (quantised to avoid texel swim)
      const want = Math.ceil(clamp(14 + Math.hypot(focus.x, focus.z) * 0.12, 14, 55) / 4) * 4;
      if (want !== half) {
        half = want;
        sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
        sc.updateProjectionMatrix();
      }
      const texel = (2 * half) / sun.shadow.mapSize.x;
      const r = Math.round(focus.dot(lightRight) / texel) * texel;
      const u = Math.round(focus.dot(lightUp) / texel) * texel;
      const f = focus.dot(sunDir);
      tmp.copy(lightRight).multiplyScalar(r).addScaledVector(lightUp, u).addScaledVector(sunDir, f);
      sun.target.position.copy(tmp);
      sun.position.copy(tmp).addScaledVector(sunDir, 200);
      sun.target.updateMatrixWorld();
    },
  };
  function up0() { return new THREE.Vector3(0, 1, 0); }
}
