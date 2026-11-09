// Neil's own bag: a Jones Rover stand bag — white/very light grey top half, royal blue lower half with the big front
// pocket, black cuff, base, zips and side handle, a white double strap with black padding, a small orange pull tab,
// the dark diamond Jones badge, black stand legs out at ~20°, a white driver headcover with a navy band and iron grips
// poking out of the top. One merged vertex-coloured mesh: a single draw call (and one in the shadow pass).
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const C = {
  white: new THREE.Color('#eef0f1'), grey: new THREE.Color('#d9dcdf'), blue: new THREE.Color('#1f3fd8'), blueD: new THREE.Color('#1a35b8'),
  black: new THREE.Color('#141518'), orange: new THREE.Color('#f08a24'), navy: new THREE.Color('#1b2340'), grip: new THREE.Color('#1e1f22'),
};

function colored(g0: THREE.BufferGeometry, col: THREE.Color | ((y: number) => THREE.Color)): THREE.BufferGeometry {
  const g = g0.index ? g0.toNonIndexed() : g0;
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  const p = g.getAttribute('position'), c = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) { const cc = typeof col === 'function' ? col(p.getY(i)) : col; c[i * 3] = cc.r; c[i * 3 + 1] = cc.g; c[i * 3 + 2] = cc.b; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

/** the bag, standing with its base at the origin; front pocket toward local -z, legs and straps toward +z */
export function createStandBag(): THREE.Mesh {
  const body: THREE.BufferGeometry[] = [];
  const at = (g: THREE.BufferGeometry, x: number, y: number, z: number) => { g.translate(x, y, z); return g; };
  // the bag itself: blue lower half, white upper half, black base and cuff
  body.push(colored(at(new THREE.CylinderGeometry(0.124, 0.118, 0.42, 22, 1), 0, 0.27, 0), C.blue));
  body.push(colored(at(new THREE.CylinderGeometry(0.13, 0.124, 0.37, 22, 1), 0, 0.665, 0), (y) => y > 0.8 ? C.grey : C.white));
  body.push(colored(at(new THREE.CylinderGeometry(0.122, 0.112, 0.065, 22, 1), 0, 0.03, 0), C.black));
  { const cuff = new THREE.TorusGeometry(0.128, 0.024, 8, 26); cuff.rotateX(Math.PI / 2); body.push(colored(at(cuff, 0, 0.855, 0), C.black)); }
  { const top = new THREE.CircleGeometry(0.11, 22); top.rotateX(-Math.PI / 2); body.push(colored(at(top, 0, 0.85, 0), C.black)); }
  // the big blue front pocket with a black zip, the orange pull tab and the diamond badge
  body.push(colored(at(new RoundedBoxGeometry(0.19, 0.32, 0.07, 3, 0.025), 0, 0.27, -0.135), C.blueD));
  body.push(colored(at(new THREE.BoxGeometry(0.005, 0.29, 0.006), 0.07, 0.27, -0.172), C.black));
  body.push(colored(at(new THREE.BoxGeometry(0.014, 0.028, 0.008), 0.07, 0.42, -0.176), C.orange));
  { const d = new THREE.BoxGeometry(0.03, 0.03, 0.006); d.rotateZ(Math.PI / 4); body.push(colored(at(d, -0.035, 0.17, -0.172), C.navy)); }
  // a zipped pocket on the white upper half, and the black side handle
  body.push(colored(at(new THREE.BoxGeometry(0.005, 0.2, 0.006), 0.05, 0.64, -0.132), C.black));
  body.push(colored(at(new RoundedBoxGeometry(0.035, 0.13, 0.04, 2, 0.012), 0.138, 0.6, 0), C.black));
  // the double strap on the back: white straps with black padding
  for (const sx of [-1, 1]) {
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(sx * 0.05, 0.8, 0.12), new THREE.Vector3(sx * 0.1, 0.68, 0.24), new THREE.Vector3(sx * 0.11, 0.52, 0.26), new THREE.Vector3(sx * 0.07, 0.38, 0.13)]);
    body.push(colored(new THREE.TubeGeometry(curve, 14, 0.011, 6, false), C.white));
    const pad = new THREE.CatmullRomCurve3(curve.getPoints(14).slice(4, 11));
    body.push(colored(new THREE.TubeGeometry(pad, 8, 0.02, 6, false), C.black));
  }
  // the driver's white headcover with a navy band, and the iron grips poking out of the top
  { const hc = new THREE.SphereGeometry(0.068, 14, 10); hc.scale(1, 1.05, 1.3); body.push(colored(at(hc, 0.035, 0.99, 0.01), C.white)); }
  body.push(colored(at(new THREE.CylinderGeometry(0.042, 0.048, 0.1, 12), 0.03, 0.9, 0.01), C.white));
  body.push(colored(at(new THREE.CylinderGeometry(0.05, 0.05, 0.022, 12), 0.03, 0.925, 0.01), C.navy));
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 1.3 + 2.2, r = 0.065;
    const g = new THREE.CylinderGeometry(0.0115, 0.0105, 0.17, 7); g.rotateZ((Math.random() - 0.5) * 0.12); g.rotateX((Math.random() - 0.5) * 0.12);
    body.push(colored(at(g, Math.cos(a) * r, 0.92 + 0.02 * (i % 3), Math.sin(a) * r - 0.02), C.grip));
  }
  // lean the bag back on its legs (~20°)
  const tilt = new THREE.Matrix4().makeRotationX(0.35);
  for (const g of body) g.applyMatrix4(tilt);
  // and sit its (tilted) base on the turf
  let minY = Infinity; for (const g of body) { g.computeBoundingBox(); minY = Math.min(minY, g.boundingBox!.min.y); }
  for (const g of body) g.translate(0, -minY, 0);
  // the stand legs: from high on the back down to the ground behind, splayed
  const legs: THREE.BufferGeometry[] = [];
  const attach = new THREE.Vector3(0, 0.66, 0.12).applyMatrix4(tilt).add(new THREE.Vector3(0, -minY, 0));
  for (const sx of [-1, 1]) {
    const from = attach.clone().add(new THREE.Vector3(sx * 0.07, 0, 0)), to = new THREE.Vector3(sx * 0.26, 0, attach.z + 0.36);
    const len = from.distanceTo(to), g = new THREE.CylinderGeometry(0.0075, 0.0075, len, 6);
    g.translate(0, len / 2, 0);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize()));
    g.translate(from.x, from.y, from.z);
    legs.push(colored(g, C.black));
    legs.push(colored(at(new THREE.SphereGeometry(0.012, 6, 4), to.x, 0.008, to.z), C.black)); // rubber feet
  }
  const merged = mergeGeometries([...body, ...legs], false)!;
  const m = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0 }));
  m.castShadow = true; m.receiveShadow = true; m.name = 'stand-bag';
  return m;
}
