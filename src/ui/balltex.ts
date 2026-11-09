// A premium tour ball (Pro V1x look): 348 dimples (Fibonacci-packed, near-uniform like a real
// icosahedral pattern), sidestamp, model mark and a red play number. One equirectangular layout
// shared by the HUD spin ball (CPU-shaded) and the in-game ball (three.js normal map + print map).
//
// Layout matches three's SphereGeometry UVs: u = phi / 2PI, v = 1 - theta / PI,
// dir(u, v) = (-cos(phi) sin(theta), cos(theta), sin(phi) sin(theta)). Image row 0 = top (v = 1).
// The sidestamp is centred at u = 0.25, which faces +Z (toward the viewer) with no rotation.

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
const DIMPLE_R = 0.094;     // angular radius of a dimple (rad)
const DIMPLE_SLOPE = 0.46;   // wall steepness at the rim

function buildDimples(normal: Float32Array, ao: Float32Array) {
  // bare sphere first
  for (let row = 0; row < BT_H; row++) {
    const th = ((row + 0.5) / BT_H) * Math.PI, st = Math.sin(th), ct = Math.cos(th);
    for (let col = 0; col < BT_W; col++) {
      const ph = ((col + 0.5) / BT_W) * Math.PI * 2, i = row * BT_W + col;
      normal[i * 3] = -Math.cos(ph) * st; normal[i * 3 + 1] = ct; normal[i * 3 + 2] = Math.sin(ph) * st; ao[i] = 1;
    }
  }
  const ga = Math.PI * (3 - Math.sqrt(5));
  const rim = DIMPLE_R * 1.14;
  for (let k = 0; k < DIMPLE_COUNT; k++) {
    const y = 1 - ((k + 0.5) / DIMPLE_COUNT) * 2, rr = Math.sqrt(1 - y * y), t = ga * k;
    const c = [Math.cos(t) * rr, y, Math.sin(t) * rr];
    const thc = Math.acos(c[1]);
    const r0 = Math.max(0, Math.floor(((thc - rim) / Math.PI) * BT_H)), r1 = Math.min(BT_H - 1, Math.ceil(((thc + rim) / Math.PI) * BT_H));
    const phc = Math.atan2(c[2], -c[0]);
    for (let row = r0; row <= r1; row++) {
      const th = ((row + 0.5) / BT_H) * Math.PI, st = Math.sin(th);
      // columns spanned at this latitude (whole row near the poles)
      const span = st < 0.05 ? Math.PI : Math.min(Math.PI, rim / Math.max(st, 1e-3) * 1.05);
      const c0 = Math.floor(((phc - span) / (Math.PI * 2)) * BT_W), c1 = Math.ceil(((phc + span) / (Math.PI * 2)) * BT_W);
      for (let cc = c0; cc <= c1; cc++) {
        const col = ((cc % BT_W) + BT_W) % BT_W, i = row * BT_W + col;
        const ph = ((col + 0.5) / BT_W) * Math.PI * 2;
        const dx = -Math.cos(ph) * st, dy = Math.cos(th), dz = Math.sin(ph) * st;
        const dot = Math.min(1, dx * c[0] + dy * c[1] + dz * c[2]);
        const d = Math.acos(dot);
        if (d >= rim) continue;
        // tangent at dir pointing away from the dimple centre
        let tx = dx * dot - c[0], ty = dy * dot - c[1], tz = dz * dot - c[2];
        const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
        let s: number;
        if (d < DIMPLE_R) { const q = d / DIMPLE_R; s = -DIMPLE_SLOPE * q; ao[i] = 1 - 0.16 * (1 - q * q) * (0.6 + 0.4 * q); }
        else { const q = (d - DIMPLE_R) / (rim - DIMPLE_R); s = 0.22 * (1 - q) * q * 4 * 0.5; } // rounded land between cups
        const nx = dx + s * tx, ny = dy + s * ty, nz = dz + s * tz, nl = Math.hypot(nx, ny, nz);
        normal[i * 3] = nx / nl; normal[i * 3 + 1] = ny / nl; normal[i * 3 + 2] = nz / nl;
      }
    }
  }
}

/** "Pro V1" in black with a red "x", centred on (x, y) */
function proV1x(g: CanvasRenderingContext2D, x: number, y: number, k: number) {
  g.save();
  g.translate(x, y); g.scale(k, k * 1.2);
  g.textBaseline = 'middle'; g.textAlign = 'left';
  const big = 'italic 700 46px "Barlow Condensed", "Arial Narrow", sans-serif', small = 'italic 700 42px "Barlow Condensed", "Arial Narrow", sans-serif';
  g.font = big; const w1 = g.measureText('Pro V1').width;
  g.font = small; const w2 = g.measureText('x').width;
  const x0 = -(w1 + w2 + 2) / 2;
  g.font = big; g.fillStyle = '#16161a'; g.fillText('Pro V1', x0, 0);
  g.font = small; g.fillStyle = '#c8102e'; g.fillText('x', x0 + w1 + 2, 2);
  g.restore();
}

function drawPrint(g: CanvasRenderingContext2D, align: boolean) {
  g.clearRect(0, 0, BT_W, BT_H);
  const cx = 0.25 * BT_W, cy = BT_H / 2;
  // front: the thin black script sidestamp with the play number under it (as on the real ball)
  g.save();
  g.translate(cx, cy - 4); g.scale(1.06, 1.18);
  g.fillStyle = '#16161a'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '60px "Yellowtail", "Brush Script MT", "Segoe Script", cursive';
  g.fillText('Titleist', 0, 0);
  // the real wordmark is a fine pen script: shave the strokes thinner
  g.globalCompositeOperation = 'destination-out'; g.lineWidth = 2.4; g.lineJoin = 'round'; g.strokeText('Titleist', 0, 0); g.globalCompositeOperation = 'source-over';
  g.restore();
  g.save();
  g.translate(cx + 4, cy + 62); g.scale(1, 1.3);
  g.fillStyle = '#c8102e'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '500 40px "Barlow", "Arial", sans-serif';
  g.fillText('1', 0, 0);
  g.globalCompositeOperation = 'destination-out'; g.lineWidth = 0.9; g.strokeText('1', 0, 0); g.globalCompositeOperation = 'source-over';
  g.restore();
  // back: the model mark with a thin alignment line under it
  const bx = 0.75 * BT_W;
  proV1x(g, bx, cy, 0.82);
  g.fillStyle = '#16161a';
  g.fillRect(bx - 62, cy + 30, 124, 1.8);
  if (align) { g.fillRect(bx - 150, cy + 36, 300, 2.2); }
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
  const printCanvas = document.createElement('canvas'); printCanvas.width = BT_W; printCanvas.height = BT_H;
  const normalCanvas = document.createElement('canvas'); normalCanvas.width = BT_W; normalCanvas.height = BT_H;
  bakeTangentMap(normal, normalCanvas);
  const pg = printCanvas.getContext('2d', { willReadFrequently: true })!;
  drawPrint(pg, align);
  const aoCanvas = document.createElement('canvas'); aoCanvas.width = BT_W; aoCanvas.height = BT_H;
  { const ag = aoCanvas.getContext('2d')!, img = ag.createImageData(BT_W, BT_H); for (let i = 0; i < ao.length; i++) { const v = ao[i] * 255; img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; } ag.putImageData(img, 0, 0); }
  shared = { normal, ao, print: pg.getImageData(0, 0, BT_W, BT_H).data, printCanvas, normalCanvas, aoCanvas, version: 1 };
  const refresh = () => { drawPrint(pg, align); shared!.print = pg.getImageData(0, 0, BT_W, BT_H).data; shared!.version++; listeners.forEach(f => f()); };
  try {
    Promise.all(['64px "Yellowtail"', 'italic 700 46px "Barlow Condensed"', '700 58px "Barlow"'].map(f => document.fonts.load(f))).then(refresh, () => {});
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
  const L = [-0.42, 0.62, 0.66], ll = Math.hypot(...L); L[0] /= ll; L[1] /= ll; L[2] /= ll;
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
      const nx = m[0] * lx + m[1] * ly + m[2] * lz, ny = m[3] * lx + m[4] * ly + m[5] * lz, nz = m[6] * lx + m[7] * ly + m[8] * lz;
      const ndl = nx * L[0] + ny * L[1] + nz * L[2];
      const diff = Math.max(0, (ndl + 0.45) / 1.45);
      const amb = 0.42 + 0.08 * ny;
      const ndh = Math.max(0, nx * H[0] + ny * H[1] + nz * H[2]);
      const spec = Math.pow(ndh, 120) * 0.75 + Math.pow(Math.max(0, vx * H[0] + vy * H[1] + vz * H[2]), 14) * 0.07;
      const fres = Math.pow(1 - vz, 3) * 0.18;
      const ao = AO[i];
      const lit = (0.66 * diff + amb) * ao;
      let rC = 0.972 * lit, gC = 0.963 * lit, bC = 0.94 * lit;   // soft, slightly warm white
      const pa = P[i * 4 + 3] / 255;
      if (pa > 0) { rC = rC * (1 - pa) + (P[i * 4] / 255) * lit * pa; gC = gC * (1 - pa) + (P[i * 4 + 1] / 255) * lit * pa; bC = bC * (1 - pa) + (P[i * 4 + 2] / 255) * lit * pa; }
      rC += spec + fres * 0.75; gC += spec + fres * 0.82; bC += spec + fres;
      d[o] = Math.min(255, rC * 255); d[o + 1] = Math.min(255, gC * 255); d[o + 2] = Math.min(255, bC * 255);
      d[o + 3] = r2 >= 1 ? Math.max(0, 1 - (Math.sqrt(r2) - 1) * R) * 255 : 255;
    }
  }
  cv.getContext('2d')!.putImageData(img, 0, 0);
  return cv;
}
