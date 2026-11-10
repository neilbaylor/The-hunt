// Neil's own bag: a Jones Rover stand bag. A soft, slightly tapered fabric carry bag, oval in section, with gentle
// bulges and creases: very light grey/white top half under a rolled black cuff with dividers, saturated royal blue
// lower half with a big pillowed front pocket that wraps the curve (black piping and zip, the small diamond badge,
// an orange pull tab), a black base, a white padded double strap with black underside padding, two thin black legs
// hinged high at the back and splayed in a V, a white driver headcover with a navy band, two fairway headcovers and
// iron grips. One merged vertex-coloured mesh with a cloth material: one draw call (and one in the shadow pass).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const col = (h: string) => new THREE.Color(h);
const C = {
  white: col('#eceeef'), grey: col('#d6d9dc'), blue: col('#1f3fd8'), blueD: col('#1c37c2'), black: col('#131417'),
  orange: col('#f0962a'), navy: col('#1a2342'), grip: col('#1d1e21'), shaft: col('#b9bec4'),
};

/** non-indexed, position/normal/color only (so everything merges) */
function colored(g0: THREE.BufferGeometry, c: THREE.Color | ((x: number, y: number, z: number) => THREE.Color)): THREE.BufferGeometry {
  if (!g0.getAttribute('normal')) g0.computeVertexNormals();
  const g = g0.index ? g0.toNonIndexed() : g0;
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  const p = g.getAttribute('position'), a = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) { const cc = typeof c === 'function' ? c(p.getX(i), p.getY(i), p.getZ(i)) : c; a[i * 3] = cc.r; a[i * 3 + 1] = cc.g; a[i * 3 + 2] = cc.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

/** a parametric surface over (u, v) in [0,1]², as an indexed grid with smooth normals */
function surface(nu: number, nv: number, f: (u: number, v: number, out: THREE.Vector3) => void): THREE.BufferGeometry {
  const P: number[] = [], I: number[] = [], t = new THREE.Vector3();
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) { f(i / nu, j / nv, t); P.push(t.x, t.y, t.z); }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1; I.push(a, c, b, b, c, d); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setIndex(I); g.computeVertexNormals();
  return g;
}

const H = 0.86, SPLIT = 0.46;
/** the bag's section at height y: an oval, a little narrower at the base, with soft fabric bulges and creases */
function section(y: number) {
  const t = y / H;
  const rx = 0.118 + 0.022 * Math.sin(Math.PI * Math.min(1, t * 1.15)) + 0.012 * t, rz = rx * 0.86;
  return { rx, rz };
}
function bodyPoint(a: number, y: number, out: THREE.Vector3, puff = 0) {
  const { rx, rz } = section(y);
  // soft fabric: broad bulges where the clubs press out, vertical creases, a slight pinch at the colour seam
  const crease = Math.pow(Math.abs(Math.sin(a * 4 + 0.6 + 0.4 * Math.sin(y * 7))), 0.35) - 0.7;
  const pinch = -0.035 * Math.exp(-Math.pow((y - SPLIT) / 0.025, 2));
  const soft = 1 + 0.045 * Math.sin(a * 3 + y * 9) * Math.sin(y * 6.5 + 0.4) + 0.025 * crease + 0.012 * Math.sin(a * 7 - y * 23) + pinch + puff;
  return out.set(Math.sin(a) * rx * soft, y, -Math.cos(a) * rz * soft); // a = 0 is the front (-z)
}

/** the bag, standing with its base at the origin; front pocket toward local -z, legs and straps toward +z */
export function createStandBag(): THREE.Mesh {
  const parts: THREE.BufferGeometry[] = [];
  // ── the body: blue below, white/very light grey above (a soft colour seam), slightly tapered oval ──
  parts.push(colored(surface(56, 34, (u, v, o) => { bodyPoint(u * Math.PI * 2, 0.04 + v * (H - 0.04), o); }), (_x, y) => y < SPLIT ? C.blue : y > H - 0.08 ? C.grey : C.white));
  // a thin blue piping line up the white half (as on the real bag)
  parts.push(colored(surface(2, 10, (u, v, o) => { bodyPoint(0.42 + (u - 0.5) * 0.02, SPLIT + v * (H - SPLIT - 0.06), o, 0.006); }), C.blue));
  // ── the big blue front pocket: a pillow wrapping the front of the curve ──
  const PA = 1.25, PY0 = 0.07, PY1 = SPLIT + 0.06;
  const pocket = (u: number, v: number, o: THREE.Vector3, extra = 0) => bodyPoint((u - 0.5) * PA * 2, PY0 + v * (PY1 - PY0), o, 0.14 * Math.pow(Math.sin(Math.PI * u), 0.6) * Math.pow(Math.sin(Math.PI * v), 0.5) + extra);
  parts.push(colored(surface(24, 18, (u, v, o) => { pocket(u, v, o); }), C.blue));
  // black piping round the pocket, the long zip, the orange pull tab and the diamond badge
  const along = (f: (t: number, o: THREE.Vector3) => void, n: number, r: number, c: THREE.Color) => {
    const pts: THREE.Vector3[] = []; for (let i = 0; i <= n; i++) { const o = new THREE.Vector3(); f(i / n, o); pts.push(o); }
    parts.push(colored(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), n, r, 5, false), c));
  };
  along((t, o) => pocket(t, 0.02, o, 0.004), 16, 0.004, C.black);
  along((t, o) => pocket(t, 0.98, o, 0.004), 16, 0.004, C.black);
  along((t, o) => pocket(0.02, t, o, 0.004), 10, 0.004, C.black);
  along((t, o) => pocket(0.98, t, o, 0.004), 10, 0.004, C.black);
  along((t, o) => pocket(0.68, 0.06 + t * 0.88, o, 0.006), 12, 0.0045, C.black);   // the long zip
  along((t, o) => pocket(0.1 + t * 0.35, 0.8 + t * 0.06, o, 0.006), 8, 0.0035, C.black); // a small zipped pocket
  { const o = new THREE.Vector3(); pocket(0.68, 0.9, o, 0.012); const tab = new THREE.BoxGeometry(0.012, 0.03, 0.006); tab.translate(o.x, o.y, o.z); parts.push(colored(tab, C.orange)); }
  { const o = new THREE.Vector3(); pocket(0.34, 0.62, o, 0.008); const d = new THREE.BoxGeometry(0.028, 0.028, 0.005); d.rotateZ(Math.PI / 4); d.rotateY(-(0.34 - 0.5) * PA * 2); d.translate(o.x, o.y, o.z); parts.push(colored(d, C.navy)); }
  // a zipped pocket on the white half
  along((t, o) => bodyPoint(0.55, SPLIT + 0.06 + t * 0.24, o, 0.012), 8, 0.004, C.black);
  // ── the base and the rolled black cuff with dividers ──
  parts.push(colored(surface(32, 3, (u, v, o) => { const a = u * Math.PI * 2, { rx, rz } = section(0.04); const k = 1.06 - 0.06 * v; o.set(Math.sin(a) * rx * k, v * 0.06, -Math.cos(a) * rz * k); }), C.black));
  parts.push(colored(surface(32, 6, (u, v, o) => { const a = u * Math.PI * 2, { rx, rz } = section(H), b = v * Math.PI * 2, rr = 0.018; const k = 1 + rr * Math.cos(b) / rx; o.set(Math.sin(a) * rx * k, H + rr * Math.sin(b), -Math.cos(a) * rz * k); }), C.black));
  { const top = new THREE.CircleGeometry(1, 24); top.rotateX(-Math.PI / 2); top.scale(section(H).rx, 1, section(H).rz); top.translate(0, H + 0.004, 0); parts.push(colored(top, C.black)); }
  for (const [w, d, x, z] of [[0.22, 0.008, 0, 0.0], [0.008, 0.18, 0.0, 0.0], [0.008, 0.18, -0.06, 0.0]] as const) { const b = new THREE.BoxGeometry(w, 0.03, d); b.translate(x, H + 0.01, z); parts.push(colored(b, C.black)); }
  // the black side handle
  { const o = new THREE.Vector3(); bodyPoint(Math.PI / 2, 0.6, o, 0.02); const h = new THREE.CapsuleGeometry(0.014, 0.1, 3, 6); h.translate(o.x, o.y, o.z); parts.push(colored(h, C.black)); }
  // ── the white padded double strap arcing over the back, black padding underneath ──
  for (const sx of [-1, 1]) {
    const pts = [new THREE.Vector3(sx * 0.05, 0.8, 0.11), new THREE.Vector3(sx * 0.1, 0.72, 0.24), new THREE.Vector3(sx * 0.12, 0.56, 0.27), new THREE.Vector3(sx * 0.09, 0.4, 0.2), new THREE.Vector3(sx * 0.06, 0.32, 0.11)];
    const curve = new THREE.CatmullRomCurve3(pts);
    parts.push(colored(new THREE.TubeGeometry(curve, 18, 0.02, 7, false), C.white));
    const under = new THREE.CatmullRomCurve3(curve.getPoints(18).slice(3, 15).map(p => p.clone().add(new THREE.Vector3(0, 0, -0.012))));
    parts.push(colored(new THREE.TubeGeometry(under, 12, 0.016, 6, false), C.black));
  }
  // ── clubs: a white driver headcover with a navy band, two fairway covers (navy, grey), iron grips ──
  const cover = (x: number, z: number, lean: number, w: number, c: THREE.Color, band?: THREE.Color) => {
    const neck = new THREE.CylinderGeometry(w * 0.55, w * 0.7, 0.12, 12); neck.translate(0, 0.06, 0);
    const head = new THREE.SphereGeometry(w, 14, 10); head.scale(1, 0.9, 1.35); head.translate(0, 0.14, w * 0.25);
    const geos = [colored(neck, c), colored(head, c)];
    if (band) { const b = new THREE.CylinderGeometry(w * 0.64, w * 0.64, 0.022, 12); b.translate(0, 0.08, 0); geos.push(colored(b, band)); }
    for (const g of geos) { g.rotateX(lean); g.rotateZ(-lean * 0.4); g.translate(x, H - 0.02, z); parts.push(g); }
  };
  cover(0.045, 0.03, -0.25, 0.062, C.white, C.navy);
  cover(-0.04, 0.05, -0.12, 0.05, C.navy);
  cover(0.0, 0.08, -0.32, 0.048, C.grey, C.black);
  for (let i = 0; i < 8; i++) {
    const a = -1.2 + (i / 7) * 2.4, r = 0.07, x = Math.sin(a) * r, z = -Math.cos(a) * r * 0.7;
    const g = new THREE.CylinderGeometry(0.0105, 0.0095, 0.16, 7); g.translate(0, 0.08, 0);
    g.rotateX(-0.18 - 0.1 * Math.cos(i * 1.7)); g.rotateZ(0.12 * Math.sin(i * 2.3)); g.translate(x, H - 0.01 + 0.012 * (i % 3), z);
    parts.push(colored(g, C.grip));
  }
  // lean the bag back on its legs (~20°) and sit its base on the turf
  const tilt = new THREE.Matrix4().makeRotationX(0.35);
  for (const g of parts) g.applyMatrix4(tilt);
  let minY = Infinity; for (const g of parts) { g.computeBoundingBox(); minY = Math.min(minY, g.boundingBox!.min.y); }
  for (const g of parts) g.translate(0, -minY, 0);
  // ── the stand: two thin black legs hinged high at the back, splayed in a V to the ground ──
  const hinge = new THREE.Vector3(0, 0.7, section(0.7).rz + 0.01).applyMatrix4(tilt).add(new THREE.Vector3(0, -minY, 0));
  for (const sx of [-1, 1]) {
    const from = hinge.clone().add(new THREE.Vector3(sx * 0.03, 0, 0)), to = new THREE.Vector3(sx * 0.24, 0.0, hinge.z + 0.4);
    const len = from.distanceTo(to), g = new THREE.CylinderGeometry(0.0065, 0.0065, len, 6);
    g.translate(0, len / 2, 0);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize()));
    g.translate(from.x, from.y, from.z);
    parts.push(colored(g, C.black));
    const foot = new THREE.CapsuleGeometry(0.008, 0.025, 2, 6); foot.translate(to.x, 0.012, to.z); parts.push(colored(foot, C.black));
  }
  { const hc = new THREE.CylinderGeometry(0.012, 0.012, 0.07, 8); hc.rotateZ(Math.PI / 2); hc.translate(hinge.x, hinge.y, hinge.z); parts.push(colored(hc, C.black)); }
  const merged = mergeGeometries(parts, false)!;
  merged.computeBoundingSphere();
  // cloth: matte with a soft sheen at grazing angles
  const mat = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.82, metalness: 0, sheen: 0.6, sheenRoughness: 0.7, sheenColor: new THREE.Color('#ffffff') });
  const m = new THREE.Mesh(merged, mat);
  m.castShadow = true; m.receiveShadow = true; m.name = 'stand-bag';
  return m;
}
