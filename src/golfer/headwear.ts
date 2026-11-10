// Hats. For now: a classic tour visor (band round the head, open top, curved brim), with an optional
// retro logo on the front. Built in head space: head centre at the origin, face toward +Z, metres.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Headwear } from './profile';
import pizzaHutUrl from '../assets/brand/pizza-hut-classic.svg?url';

let logoImg: HTMLImageElement | null = null;
/** load and decode the visor logo up front, so the band has it from the first frame (slow networks: no blank visor) */
export function preloadVisorLogo(): Promise<void> {
  if (logoImg) return Promise.resolve();
  const img = new Image(); img.src = pizzaHutUrl;
  return img.decode().then(() => { logoImg = img; }).catch(() => new Promise<void>(res => { img.onload = () => { logoImg = img; res(); }; img.onerror = () => res(); }));
}

// The front patch is drawn from the classic logo's vector art (src/assets/brand), so it's sharp at any size.
// The band takes the top 512 rows; the bottom 128 rows hold plain patches (the visor's white and the brim's
// slightly greyer underside), so the whole visor is one mesh with one texture.
export const VISOR_BAND_V0 = 128 / 640;
export const VISOR_PATCH = { top: [0.125, 64 / 640], under: [0.375, 64 / 640] } as const;
function logoTexture(kind: Headwear['logo'], base: string, sx = 1, under = base) {
  const W = 4096, H = 512;
  const c = document.createElement('canvas'); c.width = W; c.height = 640;
  const g = c.getContext('2d')!;
  g.fillStyle = base; g.fillRect(0, 0, W, 640);
  g.fillStyle = under; g.fillRect(W / 4, H, W / 4, 128);
  // twill fabric
  for (let y = 0; y < H; y += 3) for (let x = (y / 3) % 2 ? 0 : 1.5; x < W; x += 6) { g.fillStyle = 'rgba(0,0,0,.035)'; g.fillRect(x, y, 3, 1.4); }
  for (let i = 0; i < 9000; i++) { g.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,.03)' : 'rgba(255,255,255,.06)'; g.fillRect(Math.random() * W, Math.random() * H, 3, 1.5); }
  // two rows of stitching top and bottom
  g.strokeStyle = 'rgba(0,0,0,.16)'; g.setLineDash([12, 9]); g.lineWidth = 3;
  for (const y of [18, 34, H - 18, H - 34]) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
  g.setLineDash([]);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 16;
  if (kind === 'pizza-hut') {
    const draw = (img: HTMLImageElement) => {
      // the patch spans about a fifth of the band, centred on the front (u = 0.5)
      // sx: texture pixels per metre round the band ÷ pixels per metre up it, so the logo keeps its true proportions
      const h = H * 0.86, w = h * (img.width / img.height || 1.254) * sx;
      g.drawImage(img, W / 2 - w / 2, H / 2 - h / 2, w, h);   // dead centre of the band (the whole band face is visible)
      t.needsUpdate = true;
    };
    // preloaded (preloadVisorLogo, awaited with the character): drawn before the first frame; else as soon as it loads
    if (logoImg) draw(logoImg);
    else { const img = new Image(); img.onload = () => draw(img); img.src = pizzaHutUrl; }
  }
  return t;
}

/** A visor sized for a head of half-widths rx (side) and rz (front/back) at band height. */
export function buildVisor(h: Headwear, rx = 0.08, rz = 0.104, zc = 0.004, y0 = 0.032, mirrored = false, profile?: number[],
  opts: { gap?: number; dilate?: boolean; droop?: number; backDrop?: number; reach?: number } = {}) {
  // gap: how far the band stands off the measured surface; dilate: widen the profile over its neighbours first (a
  // measured hair shell is ragged); droop: how much the brim tips down at the front (seen from the front it shows)
  const GAP = opts.gap ?? 0.011, DROOP = opts.droop ?? 0.06, BACK = opts.backDrop ?? 0.012, REACH = opts.reach ?? 0.068;
  // measured radius of the head/hair round the band (64 angles from the back, a = -PI)
  // smoothed (closing: dilate then blur) so the band is a clean curve that never dips into the hair
  let prof = profile;
  if (profile && opts.dilate === false) prof = profile.map((_, i) => (profile[(i + profile.length - 1) % profile.length] + 2 * profile[i] + profile[(i + 1) % profile.length]) / 4);
  else if (profile) {
    const n = profile.length, dil = profile.map((_, i) => Math.max(...[-2, -1, 0, 1, 2].map(k => profile[(i + k + n) % n])));
    prof = dil;
    for (let pass = 0; pass < 3; pass++) prof = prof.map((_, i) => [-3, -2, -1, 0, 1, 2, 3].reduce((s, k) => s + prof![(i + k + n) % n] * Math.exp(-(k * k) / 4), 0) / [-3, -2, -1, 0, 1, 2, 3].reduce((s, k) => s + Math.exp(-(k * k) / 4), 0));
  }
  const rAt = (a: number) => { if (!prof) return null; const n = prof.length, t = ((a + Math.PI) / (2 * Math.PI)) * n; const i = Math.floor(t) % n, f = t - Math.floor(t); return prof[i] * (1 - f) + prof[(i + 1) % n] * f; };
  const group = new THREE.Group(); group.name = 'visor';
  // band: an open ring, a bit taller at the front, tilted so the front sits lower on the forehead
  const seg = 96, height = 0.038, pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = -Math.PI + (i / seg) * Math.PI * 2;   // a = 0 at the front
    const back = Math.max(0, -Math.cos(a)), sideB = Math.abs(Math.sin(a));
    // the strap sits proud of the hair at the sides and back
    const fr = Math.max(0, Math.cos(a));
    const pr = rAt(a);
    const x = pr !== null ? Math.sin(a) * (pr + GAP) : Math.sin(a) * (rx + 0.009 * sideB + 0.006 * back);
    const z = pr !== null ? Math.cos(a) * (pr + GAP) + zc : Math.cos(a) * (rz + 0.016 * back + 0.008 * fr) + zc;
    const front = 0.5 + 0.5 * Math.cos(a);
    const hh = height * (0.55 + 0.45 * front);
    const tilt = -0.004 * front - BACK * back;                     // round the back it drops onto the head above the occiput
    pos.push(x, y0 + tilt - hh / 2, z, x * 0.985, y0 + tilt + hh / 2, z * 0.985 + zc * 0.015);
    const u = mirrored ? 1 - i / seg : i / seg; // a left-hander's body is mirrored, so mirror the logo back
    uv.push(u, 0, u, 1);
  }
  for (let i = 0; i < seg; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  let perim = 0;
  for (let i = 0; i < seg; i++) perim += Math.hypot(pos[(i * 2 + 2) * 3] - pos[i * 2 * 3], pos[(i * 2 + 2) * 3 + 2] - pos[i * 2 * 3 + 2]);
  const underCol = new THREE.Color(h.color).multiplyScalar(0.86);   // one white cotton piece: the underside is the same fabric, a touch greyer
  const fabric = new THREE.MeshStandardMaterial({ map: logoTexture(h.logo, h.color, (height / perim) * (4096 / 512), '#' + underCol.getHexString()), roughness: 0.85, side: THREE.DoubleSide });
  const band = new THREE.BufferGeometry();
  band.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  band.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  band.setIndex(idx); band.computeVertexNormals();
  group.add(new THREE.Mesh(band, fabric));
  // sweatband inside, a soft rolled top edge
  const roll = new THREE.Mesh(new THREE.TorusGeometry(1, 0.0032 / rx, 6, 72), new THREE.MeshStandardMaterial({ color: h.color, roughness: 0.8 }));
  roll.scale.set(rx * 0.985, rz * 0.985, rx); roll.rotation.x = Math.PI / 2; roll.position.set(0, y0 + height / 2 - 0.006, zc);
  if (!profile) group.add(roll);
  else {
    // closed top edge: a lip from the band's top edge in to the hair, so you never see through the gap
    const lp: number[] = [], li: number[] = [];
    // a rolled, bound top edge: the band's fabric turns over itself and tucks in against the hair
    const RW = 5; // rows across the roll
    for (let i = 0; i <= seg; i++) {
      const x = pos[(i * 2 + 1) * 3], y = pos[(i * 2 + 1) * 3 + 1], z = pos[(i * 2 + 1) * 3 + 2];
      const a = -Math.PI + (i / seg) * Math.PI * 2, pr = rAt(a)!;
      const ox = Math.sin(a), oz = Math.cos(a), rOut = Math.hypot(x, z - zc);
      for (let r = 0; r <= RW; r++) {
        const t = r / RW, th = t * Math.PI;                    // half-round bead over the top
        const rr = rOut - 0.0035 + 0.0035 * Math.cos(th) - t * Math.max(0, rOut - pr - 0.004) * 1.0;
        lp.push(ox * rr, y + 0.0028 * Math.sin(th) - t * 0.003, oz * rr + zc);
      }
    }
    for (let i = 0; i < seg; i++) for (let r = 0; r < RW; r++) { const a = i * (RW + 1) + r, b = a + RW + 1; li.push(a, b, a + 1, a + 1, b, b + 1); }
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3)); lg.setIndex(li); lg.computeVertexNormals();
    group.add(new THREE.Mesh(lg, new THREE.MeshStandardMaterial({ color: h.color, roughness: 0.85, side: THREE.DoubleSide })));
  }
  // brim: one smooth, rounded front edge (an ellipse in plan, no point), joined to the band's bottom edge,
  // curving down a little towards the sides; white on top, darker underneath
  const bs = 64, rows = 10, bp: number[] = [];
  const AE = 1.38;                                     // the brim runs round to just behind the temples
  const bandAt = (a: number) => {                      // the band's bottom edge at angle a (same formulas as above)
    const pr = rAt(a), sideB = Math.abs(Math.sin(a)), back = Math.max(0, -Math.cos(a)), fr = Math.max(0, Math.cos(a));
    const x = pr !== null ? Math.sin(a) * (pr + GAP) : Math.sin(a) * (rx + 0.009 * sideB + 0.006 * back);
    const z = pr !== null ? Math.cos(a) * (pr + GAP) + zc : Math.cos(a) * (rz + 0.016 * back + 0.008 * fr) + zc;
    const front = 0.5 + 0.5 * Math.cos(a), hh = height * (0.55 + 0.45 * front), tilt = -0.004 * front - BACK * back;
    return new THREE.Vector3(x, y0 + tilt - hh / 2, z);
  };
  const side0 = bandAt(Math.PI / 2), front0 = bandAt(0);
  const Xo = Math.abs(side0.x) + 0.012, Zo = front0.z - zc + REACH;  // outer edge: half-width and reach of the brim
  for (let r = 0; r <= rows; r++) for (let i = 0; i <= bs; i++) {
    const s = -1 + (i / bs) * 2, a = s * AE, t = r / rows;
    const inner = bandAt(a);
    // outer edge on an ellipse round the head centre, eased into the band at the two ends
    const ox = Math.sin(a) * Xo, oz = Math.cos(a) * Zo + zc;
    const w = Math.min(1, (1 - Math.abs(s)) / 0.32), ease = w * w * (3 - 2 * w);
    const ex = inner.x + (ox - inner.x) * ease, ez = inner.z + (oz - inner.z) * ease;
    const L = Math.hypot(ex - inner.x, ez - inner.z) * t;
    const side = Math.abs(Math.sin(a));
    const tt = t * t * (3 - 2 * t) * 0.35 + t * 0.65;
    bp.push(inner.x + (ex - inner.x) * tt, inner.y + 0.0006 - L * (DROOP * (1 - side) + 0.3 * side) - (0.004 + 0.008 * side) * t * t, inner.z + (ez - inner.z) * tt);   // slopes gently down and away, so it never hides the band
  }
  const tri = (flip: boolean) => { const o: number[] = []; for (let r = 0; r < rows; r++) for (let i = 0; i < bs; i++) { const a = r * (bs + 1) + i, b = a + 1, c = a + bs + 1, d = c + 1; if (flip) o.push(a, b, c, b, d, c); else o.push(a, c, b, b, c, d); } return o; };
  // the top surface faces up (checked, not assumed), the underside is a copy 2.5 mm below facing down
  const brim = new THREE.BufferGeometry();
  brim.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3));
  brim.setIndex(tri(false)); brim.computeVertexNormals();
  const ny = (brim.getAttribute('normal') as THREE.BufferAttribute).getY(Math.floor(rows / 2) * (bs + 1) + bs / 2);
  if (ny < 0) { brim.setIndex(tri(true)); brim.computeVertexNormals(); }
  const under = brim.clone().translate(0, -0.0025, 0); under.setIndex(tri(ny >= 0)); under.computeVertexNormals();
  const top = new THREE.Mesh(brim, new THREE.MeshStandardMaterial({ color: h.color, roughness: 0.75 }));
  const bottom = new THREE.Mesh(under, new THREE.MeshStandardMaterial({ color: underCol, roughness: 0.9 }));
  group.add(top, bottom);
  // a soft rolled edge round the brim
  const edge: THREE.Vector3[] = [];
  for (let i = 0; i <= bs; i++) { const k = (rows * (bs + 1) + i) * 3; edge.push(new THREE.Vector3(bp[k], bp[k + 1] - 0.0012, bp[k + 2])); }
  group.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(edge), 96, 0.0017, 8), new THREE.MeshStandardMaterial({ color: h.color, roughness: 0.7 })));
  // merge everything into one mesh with the band's texture (one draw call per pass): the band keeps its UVs
  // (moved into the band rows), every other part samples a plain patch
  const parts = group.children.filter(o => (o as THREE.Mesh).isMesh) as THREE.Mesh[];
  const geos = parts.map(m => {
    m.updateMatrix();
    const g = m.geometry.clone().applyMatrix4(m.matrix);
    if (!g.index) g.setIndex([...Array(g.getAttribute('position').count).keys()]);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const n = g.getAttribute('position').count, uv = new Float32Array(n * 2), src = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
    const mat = m.material as THREE.MeshStandardMaterial, isBand = mat === fabric;
    const patch = mat.color && mat.color.getHex() === underCol.getHex() ? VISOR_PATCH.under : VISOR_PATCH.top;
    for (let k = 0; k < n; k++) {
      if (isBand && src) { uv[k * 2] = src.getX(k); uv[k * 2 + 1] = VISOR_BAND_V0 + (1 - VISOR_BAND_V0) * src.getY(k); }
      else { uv[k * 2] = patch[0]; uv[k * 2 + 1] = patch[1]; }
    }
    const out = new THREE.BufferGeometry(); out.setIndex(g.index); out.setAttribute('position', g.getAttribute('position')); out.setAttribute('normal', g.getAttribute('normal')); out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return out;
  });
  group.clear();
  const visor = new THREE.Mesh(mergeGeometries(geos)!, fabric); visor.name = 'visor-mesh';
  visor.castShadow = true; visor.receiveShadow = true; group.add(visor);
  return group;
}
