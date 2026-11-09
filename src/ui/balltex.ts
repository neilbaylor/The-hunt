// A premium tour ball (Pro V1x look): 348 dimples (Fibonacci-packed, near-uniform like a real
// icosahedral pattern), sidestamp, model mark and a red play number. One equirectangular layout
// shared by the HUD spin ball (CPU-shaded) and the in-game ball (three.js normal map + print map).
//
// Layout matches three's SphereGeometry UVs: u = phi / 2PI, v = 1 - theta / PI,
// dir(u, v) = (-cos(phi) sin(theta), cos(theta), sin(phi) sin(theta)). Image row 0 = top (v = 1).
// The sidestamp is centred at u = 0.25, which faces +Z (toward the viewer) with no rotation.

import scriptSvg from '../assets/brand/titleist-script.svg?raw';
import markSvg from '../assets/brand/prov1x-mark.svg?raw';

export const BT_W = 1024, BT_H = 512;

export interface BallTex {
  /** perturbed unit normal per texel, ball-local (x, y, z) */
  normal: Float32Array;
  /** ambient occlusion per texel (dimple cups are darker) */
  ao: Float32Array;
  /** print colour (RGBA 0..255) per texel; alpha 0 = bare ball */
  print: Uint8ClampedArray;
  printCanvas: HTMLCanvasElement;
  /** tangent-space normal map for three.js */
  normalCanvas: HTMLCanvasElement;
  /** dimple ambient occlusion for three.js (grey, red channel used) */
  aoCanvas: HTMLCanvasElement;
  version: number;
}

const DIMPLE_COUNT = 348;
const DIMPLE_DEPTH = 0.0092;   // cup depth in ball radii (real: ~0.25 mm on a 21 mm radius): large, shallow cups
const DIMPLE_RC = 0.124;      // rad: cup radius (cells are ~0.102 inscribed, ~0.118 circumscribed)
const CELL_REACH = 0.19;       // rad: how far a dimple's cell can reach (≥ the largest cell's circumradius)
/** print map resolution (2× the normal map, so the script stays crisp up close) */
export const PR_W = 2048, PR_H = 1024;

/** Closely packed round-ish dimples: every texel belongs to its nearest dimple centre (a spherical Voronoi cell,
 *  like the near-hexagonal packing on a real ball); each cell is a shallow cap that rises to a thin rounded land
 *  at the cell border. Normals come from the height field's gradient, so the shading is soft and broad. */
function buildDimples(normal: Float32Array, ao: Float32Array) {
  const n = BT_W * BT_H, d1 = new Float32Array(n).fill(9), d2 = new Float32Array(n).fill(9);
  const ga = Math.PI * (3 - Math.sqrt(5)), C: number[][] = [];
  for (let k = 0; k < DIMPLE_COUNT; k++) { const y = 1 - ((k + 0.5) / DIMPLE_COUNT) * 2, rr = Math.sqrt(1 - y * y), t = ga * k; C.push([Math.cos(t) * rr, y, Math.sin(t) * rr]); }
  for (const c of C) {
    const thc = Math.acos(c[1]), phc = Math.atan2(c[2], -c[0]);
    const r0 = Math.max(0, Math.floor(((thc - CELL_REACH) / Math.PI) * BT_H)), r1 = Math.min(BT_H - 1, Math.ceil(((thc + CELL_REACH) / Math.PI) * BT_H));
    for (let row = r0; row <= r1; row++) {
      const th = ((row + 0.5) / BT_H) * Math.PI, st = Math.sin(th), ct = Math.cos(th);
      const span = st < 0.2 ? Math.PI : Math.min(Math.PI, (CELL_REACH / st) * 1.05);
      const c0 = Math.floor(((phc - span) / (Math.PI * 2)) * BT_W), c1 = Math.ceil(((phc + span) / (Math.PI * 2)) * BT_W);
      for (let cc = c0; cc <= c1; cc++) {
        const col = ((cc % BT_W) + BT_W) % BT_W, i = row * BT_W + col, ph = ((col + 0.5) / BT_W) * Math.PI * 2;
        const dot = -Math.cos(ph) * st * c[0] + ct * c[1] + Math.sin(ph) * st * c[2];
        const d = Math.acos(Math.min(1, Math.max(-1, dot)));
        if (d < d1[i]) { d2[i] = d1[i]; d1[i] = d; } else if (d < d2[i]) d2[i] = d;
      }
    }
  }
  // height: round shallow cups sized just under the cell (so they nearly touch, like the real ball), with a
  // profile whose slope eases to zero at the rim: soft, broad shading with a light rounded land, no hard creases
  const H = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = Math.min(1, d1[i] / DIMPLE_RC), cup = Math.pow(1 - x * x, 1.5);
    H[i] = -DIMPLE_DEPTH * cup;
    ao[i] = 1 - 0.035 * cup;
    void d2;
  }
  const dth = Math.PI / BT_H, dph = (Math.PI * 2) / BT_W;
  for (let row = 0; row < BT_H; row++) {
    const th = ((row + 0.5) / BT_H) * Math.PI, st = Math.sin(th), ct = Math.cos(th), su = Math.max(st, 0.05);
    const rn = Math.min(BT_H - 1, row + 1), rp = Math.max(0, row - 1);
    for (let col = 0; col < BT_W; col++) {
      const i = row * BT_W + col, ph = ((col + 0.5) / BT_W) * Math.PI * 2;
      const cn = (col + 1) % BT_W, cp = (col - 1 + BT_W) % BT_W;
      const gT = (H[rn * BT_W + col] - H[rp * BT_W + col]) / ((rn - rp) * dth);
      const gP = (H[row * BT_W + cn] - H[row * BT_W + cp]) / (2 * dph) / su;
      // n = n0 - grad H  (eθ = ∂dir/∂θ, eφ = ∂dir/∂φ / sinθ)
      const n0x = -Math.cos(ph) * st, n0y = ct, n0z = Math.sin(ph) * st;
      const eTx = -Math.cos(ph) * ct, eTy = -st, eTz = Math.sin(ph) * ct;
      const ePx = Math.sin(ph), ePz = Math.cos(ph);
      const nx = n0x - gT * eTx - gP * ePx, ny = n0y - gT * eTy, nz = n0z - gT * eTz - gP * ePz, l = Math.hypot(nx, ny, nz);
      normal[i * 3] = nx / l; normal[i * 3 + 1] = ny / l; normal[i * 3 + 2] = nz / l;
    }
  }
}

/** a traced print mark (an SVG in lon/lat degrees): its group transform and paths */
function traced(svg: string) {
  const m = (/matrix\(([^)]+)\)/.exec(svg)?.[1] ?? '1,0,0,1,0,0').split(',').map(Number);
  const paths = [...svg.matchAll(/<path d="([^"]+)"/g)].map(x => new Path2D(x[1]));
  return { m, paths };
}
const SCRIPT = traced(scriptSvg), MARK = traced(markSvg);
/** draw a traced mark centred at (x, y) in the 1024 × 512 print space */
function drawTraced(g: CanvasRenderingContext2D, t: ReturnType<typeof traced>, x: number, y: number, degX: number, degY: number) {
  g.save(); g.translate(x, y); g.scale(degX, degY); g.transform(t.m[0], t.m[1], t.m[2], t.m[3], t.m[4], t.m[5]);
  g.fillStyle = '#121214'; for (const p of t.paths) g.fill(p);
  g.restore();
}

function drawPrint(g: CanvasRenderingContext2D, align: boolean) {
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, PR_W, PR_H);
  g.setTransform(PR_W / BT_W, 0, 0, PR_H / BT_H, 0, 0);   // lay out in the 1024 × 512 space
  const cx = 0.25 * BT_W, cy = BT_H / 2, degX = BT_W / 360, degY = BT_H / 180;
  // front: the "Titleist" script, traced from a photo of the real ball and stored in lon/lat degrees (see the SVG)
  drawTraced(g, SCRIPT, cx, cy, degX, degY);
  // the red play number, hand-lettered: a flag at the top, a straight stem and a small foot
  g.save();
  g.translate(cx, cy + 3.5 * degY);
  const h = 11.5 * degY;                                // ~10% of the diameter tall
  g.strokeStyle = '#c4122f'; g.lineCap = 'round'; g.lineJoin = 'round'; g.lineWidth = 3;
  g.beginPath(); g.moveTo(-h * 0.2, -h * 0.34); g.quadraticCurveTo(-h * 0.02, -h * 0.4, h * 0.06, -h * 0.5); g.lineTo(h * 0.02, h * 0.42); g.stroke();
  g.beginPath(); g.moveTo(-h * 0.24, h * 0.47); g.quadraticCurveTo(0, h * 0.4, h * 0.26, h * 0.46); g.stroke();
  g.restore();
  // back: PRO V1x between two long tapered arrow lines on the equator, traced from a photo (see the SVG)
  drawTraced(g, MARK, 0.75 * BT_W, cy, degX, degY);
  void align;
  g.setTransform(1, 0, 0, 1, 0, 0);
}

function bakeTangentMap(normal: Float32Array, out: HTMLCanvasElement) {
  const g = out.getContext('2d')!, img = g.createImageData(BT_W, BT_H), d = img.data;
  for (let row = 0; row < BT_H; row++) {
    const th = ((row + 0.5) / BT_H) * Math.PI, st = Math.sin(th), ct = Math.cos(th);
    for (let col = 0; col < BT_W; col++) {
      const ph = ((col + 0.5) / BT_W) * Math.PI * 2, i = row * BT_W + col;
      const N = [-Math.cos(ph) * st, ct, Math.sin(ph) * st];
      const T = [Math.sin(ph), 0, Math.cos(ph)];
      const B = [Math.cos(ph) * ct, st, -Math.sin(ph) * ct];
      const n = [normal[i * 3], normal[i * 3 + 1], normal[i * 3 + 2]];
      const x = n[0] * T[0] + n[1] * T[1] + n[2] * T[2], y = n[0] * B[0] + n[1] * B[1] + n[2] * B[2], z = n[0] * N[0] + n[1] * N[1] + n[2] * N[2];
      d[i * 4] = (x * 0.5 + 0.5) * 255; d[i * 4 + 1] = (y * 0.5 + 0.5) * 255; d[i * 4 + 2] = (z * 0.5 + 0.5) * 255; d[i * 4 + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
}

let shared: BallTex | null = null;
const listeners: (() => void)[] = [];

/** Shared ball textures. The print is redrawn once the web fonts load; `onBallTexUpdate` fires then. */
export function ballTex(align = false): BallTex {
  if (shared) return shared;
  const normal = new Float32Array(BT_W * BT_H * 3), ao = new Float32Array(BT_W * BT_H);
  buildDimples(normal, ao);
  const printCanvas = document.createElement('canvas'); printCanvas.width = PR_W; printCanvas.height = PR_H;
  const normalCanvas = document.createElement('canvas'); normalCanvas.width = BT_W; normalCanvas.height = BT_H;
  bakeTangentMap(normal, normalCanvas);
  const pg = printCanvas.getContext('2d', { willReadFrequently: true })!;
  drawPrint(pg, align);
  const aoCanvas = document.createElement('canvas'); aoCanvas.width = BT_W; aoCanvas.height = BT_H;
  { const ag = aoCanvas.getContext('2d')!, img = ag.createImageData(BT_W, BT_H); for (let i = 0; i < ao.length; i++) { const v = ao[i] * 255; img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; } ag.putImageData(img, 0, 0); }
  shared = { normal, ao, print: pg.getImageData(0, 0, PR_W, PR_H).data, printCanvas, normalCanvas, aoCanvas, version: 1 };
  const refresh = () => { drawPrint(pg, align); shared!.print = pg.getImageData(0, 0, PR_W, PR_H).data; shared!.version++; listeners.forEach(f => f()); };
  try {
    Promise.all(['italic 700 46px "Barlow Condensed"', '700 58px "Barlow"'].map(f => document.fonts.load(f))).then(refresh, () => {});
    document.fonts.ready.then(refresh, () => {});
    document.fonts.addEventListener('loadingdone', refresh);
  } catch { /* no font loading API */ }
  return shared;
}
export function onBallTexUpdate(f: () => void) { listeners.push(f); }

// ── CPU shading of the ball for the HUD spin ball ──
export type Mat3 = number[]; // row-major 3x3, ball-local → view
export const mat3Identity = (): Mat3 => [1, 0, 0, 0, 1, 0, 0, 0, 1];
/** premultiply by rotation about view X by ax, then about view Y by ay */
export function mat3Rotate(m: Mat3, ax: number, ay: number) {
  const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay);
  // Rx: y' = y cx - z sx, z' = y sx + z cx ; Ry: x' = x cy + z sy, z' = -x sy + z cy
  for (let c = 0; c < 3; c++) {
    let x = m[c], y = m[3 + c], z = m[6 + c];
    const y2 = y * cx - z * sx, z2 = y * sx + z * cx; y = y2; z = z2;
    const x2 = x * cy + z * sy; z = -x * sy + z * cy;
    m[c] = x2; m[3 + c] = y; m[6 + c] = z;
  }
  // re-orthonormalise occasionally (cheap Gram-Schmidt on rows)
  const r0 = [m[0], m[1], m[2]], r1 = [m[3], m[4], m[5]];
  const l0 = Math.hypot(...r0); r0[0] /= l0; r0[1] /= l0; r0[2] /= l0;
  const d = r0[0] * r1[0] + r0[1] * r1[1] + r0[2] * r1[2]; r1[0] -= d * r0[0]; r1[1] -= d * r0[1]; r1[2] -= d * r0[2];
  const l1 = Math.hypot(...r1); r1[0] /= l1; r1[1] /= l1; r1[2] /= l1;
  const r2 = [r0[1] * r1[2] - r0[2] * r1[1], r0[2] * r1[0] - r0[0] * r1[2], r0[0] * r1[1] - r0[1] * r1[0]];
  m.splice(0, 9, ...r0, ...r1, ...r2);
}

let scratch: { cv: HTMLCanvasElement; img: ImageData } | null = null;
/** Shade the ball into a square of `size` px; returns a canvas to drawImage. */
export function shadeBall(size: number, m: Mat3): HTMLCanvasElement {
  const T = ballTex();
  if (!scratch || scratch.cv.width !== size) {
    const cv = document.createElement('canvas'); cv.width = cv.height = size;
    scratch = { cv, img: cv.getContext('2d')!.createImageData(size, size) };
  }
  const { cv, img } = scratch, d = img.data, R = size / 2 - 1, c = size / 2;
  const L = [-0.22, 0.72, 0.66], ll = Math.hypot(...L); L[0] /= ll; L[1] /= ll; L[2] /= ll;
  const H = [L[0], L[1], L[2] + 1], hl = Math.hypot(...H); H[0] /= hl; H[1] /= hl; H[2] /= hl;
  const N = T.normal, AO = T.ao, P = T.print;
  for (let py = 0; py < size; py++) {
    const vy = -(py + 0.5 - c) / R;
    for (let px = 0; px < size; px++) {
      const o = (py * size + px) * 4;
      const vx = (px + 0.5 - c) / R, r2 = vx * vx + vy * vy;
      if (r2 >= 1.0) {
        // anti-aliased edge
        const e = (Math.sqrt(r2) - 1) * R;
        if (e > 1) { d[o + 3] = 0; continue; }
      }
      const vz = Math.sqrt(Math.max(0, 1 - r2));
      // view → ball-local (transpose)
      const bx = m[0] * vx + m[3] * vy + m[6] * vz, by = m[1] * vx + m[4] * vy + m[7] * vz, bz = m[2] * vx + m[5] * vy + m[8] * vz;
      let ph = Math.atan2(bz, -bx); if (ph < 0) ph += Math.PI * 2;
      const th = Math.acos(Math.max(-1, Math.min(1, by)));
      const col = Math.min(BT_W - 1, (ph / (Math.PI * 2) * BT_W) | 0), row = Math.min(BT_H - 1, (th / Math.PI * BT_H) | 0), i = row * BT_W + col;
      // perturbed normal back to view space
      const lx = N[i * 3], ly = N[i * 3 + 1], lz = N[i * 3 + 2];
      let nx = m[0] * lx + m[1] * ly + m[2] * lz, ny = m[3] * lx + m[4] * ly + m[5] * lz, nz = m[6] * lx + m[7] * ly + m[8] * lz;
      // the shaded lower half reads softer on the real ball: ease the dimples back toward the smooth sphere there
      { const f = 0.4 * Math.max(0, -vy); if (f > 0) { nx += (vx - nx) * f; ny += (vy - ny) * f; nz += (vz - nz) * f; const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l; } }
      const ndl = nx * L[0] + ny * L[1] + nz * L[2];
      const diff = Math.max(0, (ndl + 0.6) / 1.6);                 // wrapped: a soft studio falloff
      const amb = 0.5 + 0.06 * ny;
      const ndh = Math.max(0, nx * H[0] + ny * H[1] + nz * H[2]);
      const spec = Math.pow(ndh, 36) * 0.2 + Math.pow(ndh, 160) * 0.12;   // a gentle broad sheen
      const fres = Math.pow(1 - vz, 3) * 0.12;
      const ao = AO[i];
      const lit = (0.56 * diff + amb) * ao;
      let rC = 0.955 * lit, gC = 0.962 * lit, bC = 0.975 * lit;   // bright, clean, slightly cool white
      const pcol = Math.min(PR_W - 1, (ph / (Math.PI * 2) * PR_W) | 0), prow = Math.min(PR_H - 1, (th / Math.PI * PR_H) | 0), j = (prow * PR_W + pcol) * 4;
      const pa = P[j + 3] / 255;
      if (pa > 0) { rC = rC * (1 - pa) + (P[j] / 255) * lit * pa; gC = gC * (1 - pa) + (P[j + 1] / 255) * lit * pa; bC = bC * (1 - pa) + (P[j + 2] / 255) * lit * pa; }
      rC += spec + fres * 0.8; gC += spec + fres * 0.85; bC += spec + fres;
      d[o] = Math.min(255, rC * 255); d[o + 1] = Math.min(255, gC * 255); d[o + 2] = Math.min(255, bC * 255);
      d[o + 3] = r2 >= 1 ? Math.max(0, 1 - (Math.sqrt(r2) - 1) * R) * 255 : 255;
    }
  }
  cv.getContext('2d')!.putImageData(img, 0, 0);
  return cv;
}
