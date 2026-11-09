// Hats. For now: a classic tour visor (band round the head, open top, curved brim), with an optional
// retro logo on the front. Built in head space: head centre at the origin, face toward +Z, metres.
import * as THREE from 'three';
import type { Headwear } from './profile';

function logoTexture(kind: Headwear['logo'], base: string) {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 160;
  const g = c.getContext('2d')!;
  g.fillStyle = base; g.fillRect(0, 0, 1024, 160);
  // a little fabric texture
  for (let i = 0; i < 5000; i++) { g.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,.025)' : 'rgba(255,255,255,.05)'; g.fillRect(Math.random() * 1024, Math.random() * 160, 2, 1); }
  // stitched edges top and bottom
  g.strokeStyle = 'rgba(0,0,0,.12)'; g.setLineDash([6, 5]); g.lineWidth = 2;
  g.beginPath(); g.moveTo(0, 10); g.lineTo(1024, 10); g.moveTo(0, 150); g.lineTo(1024, 150); g.stroke(); g.setLineDash([]);
  if (kind === 'pizza-hut') {
    const cx = 512;
    // the red roof
    g.fillStyle = '#d62d20';
    g.beginPath(); g.moveTo(cx - 84, 44); g.lineTo(cx - 48, 22); g.lineTo(cx - 28, 22); g.lineTo(cx - 17, 10); g.lineTo(cx + 17, 10); g.lineTo(cx + 28, 22); g.lineTo(cx + 48, 22); g.lineTo(cx + 84, 44); g.closePath(); g.fill();
    // the words, in a chunky brush-script feel
    g.fillStyle = '#1b1715'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.font = 'italic 900 40px "Brush Script MT", "Georgia", serif';
    g.fillText('Pizza', cx - 4, 80);
    g.font = 'italic 900 38px "Brush Script MT", "Georgia", serif';
    g.fillText('Hut', cx + 8, 114);
    g.font = '700 10px Arial, sans-serif'; g.fillText('®', cx + 44, 108);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

/** A visor sized for a head of half-widths rx (side) and rz (front/back) at band height. */
export function buildVisor(h: Headwear, rx = 0.08, rz = 0.104, zc = 0.004, y0 = 0.032, mirrored = false) {
  const group = new THREE.Group(); group.name = 'visor';
  const fabric = new THREE.MeshStandardMaterial({ map: logoTexture(h.logo, h.color), roughness: 0.85, side: THREE.DoubleSide });
  // band: an open ring, a bit taller at the front, tilted so the front sits lower on the forehead
  const seg = 96, height = 0.038, pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = -Math.PI + (i / seg) * Math.PI * 2;   // a = 0 at the front
    const back = Math.max(0, -Math.cos(a)), sideB = Math.abs(Math.sin(a));
    // the strap sits proud of the hair at the sides and back
    const fr = Math.max(0, Math.cos(a));
    const x = Math.sin(a) * (rx + 0.005 * sideB + 0.004 * back), z = Math.cos(a) * (rz + 0.011 * back + 0.008 * fr) + zc;
    const front = 0.5 + 0.5 * Math.cos(a);
    const hh = height * (0.55 + 0.45 * front);
    const tilt = -0.012 * front;                    // front lower
    pos.push(x, y0 + tilt - hh / 2, z, x * 0.985, y0 + tilt + hh / 2, z * 0.985 + zc * 0.015);
    const u = mirrored ? 1 - i / seg : i / seg; // a left-hander's body is mirrored, so mirror the logo back
    uv.push(u, 0, u, 1);
  }
  for (let i = 0; i < seg; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const band = new THREE.BufferGeometry();
  band.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  band.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  band.setIndex(idx); band.computeVertexNormals();
  group.add(new THREE.Mesh(band, fabric));
  // sweatband inside, a soft rolled top edge
  const roll = new THREE.Mesh(new THREE.TorusGeometry(1, 0.0032 / rx, 6, 72), new THREE.MeshStandardMaterial({ color: h.color, roughness: 0.8 }));
  roll.scale.set(rx * 0.985, rz * 0.985, rx); roll.rotation.x = Math.PI / 2; roll.position.set(0, y0 + height / 2 - 0.006, zc);
  group.add(roll);
  // brim: a curved, slightly drooping shell with a white top and dark underside
  const bs = 48, rows = 8, bp: number[] = [], bidx: number[] = [], under: number[] = [];
  for (let r = 0; r <= rows; r++) for (let i = 0; i <= bs; i++) {
    const a = -1.32 + (i / bs) * 2.64;
    const L = 0.064 * Math.pow(Math.cos(a * 0.95), 0.8) * (r / rows);
    const bx = Math.sin(a) * rx, bz = Math.cos(a) * rz + zc;
    const dx = Math.sin(a), dz = Math.cos(a) * 1.15;
    const t = r / rows;
    const side = Math.abs(Math.sin(a));
    const yb = y0 - height * 0.42 - 0.006 * (0.5 + 0.5 * Math.cos(a));
    bp.push(bx + dx * L * 0.55, yb - L * (0.06 + 0.45 * side) - 0.006 * t * t, bz + dz * L);
    under.push(0);
  }
  for (let r = 0; r < rows; r++) for (let i = 0; i < bs; i++) { const a = r * (bs + 1) + i, b = a + 1, c = a + bs + 1, d = c + 1; bidx.push(a, c, b, b, c, d); }
  const brim = new THREE.BufferGeometry();
  brim.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3));
  brim.setIndex(bidx); brim.computeVertexNormals();
  const top = new THREE.Mesh(brim, new THREE.MeshStandardMaterial({ color: h.color, roughness: 0.75, side: THREE.FrontSide }));
  const bottom = new THREE.Mesh(brim.clone().translate(0, -0.0025, 0), new THREE.MeshStandardMaterial({ color: h.under, roughness: 0.9, side: THREE.BackSide }));
  group.add(top, bottom);
  // edge piping round the front of the brim
  const edge: THREE.Vector3[] = [];
  for (let i = 0; i <= bs; i++) { const k = (rows * (bs + 1) + i) * 3; edge.push(new THREE.Vector3(bp[k], bp[k + 1] - 0.0012, bp[k + 2])); }
  group.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(edge), 64, 0.0018, 6), new THREE.MeshStandardMaterial({ color: h.color, roughness: 0.7 })));
  group.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return group;
}
