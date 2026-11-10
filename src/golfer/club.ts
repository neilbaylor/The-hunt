// Golf clubs and the hands that hold them. Built in character space as at address: the face looks at
// the target (+X), the toe points away from the golfer (+Z), the shaft leans back toward the golfer
// (-Z) at the club's lie angle. The club's local origin is the sweet spot on the face.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type ClubKind = 'driver' | 'wood' | 'hybrid' | 'iron' | 'wedge';
export interface ClubSpec { id: string; name: string; kind: ClubKind; length: number; lie: number; loft: number }

const IN = 0.0254;
// standard lengths (+1" for a 6'3" player is added by the golfer)
export const CLUB_SPECS: ClubSpec[] = [
  { id: '1W', name: 'Driver', kind: 'driver', length: 45.5 * IN, lie: 57, loft: 10.5 },
  { id: '3W', name: '3 wood', kind: 'wood', length: 43 * IN, lie: 57.5, loft: 15 },
  { id: '5W', name: '5 wood', kind: 'wood', length: 42 * IN, lie: 58, loft: 18 },
  { id: '4H', name: '4 hybrid', kind: 'hybrid', length: 39.5 * IN, lie: 59.5, loft: 22 },
  { id: '5i', name: '5 iron', kind: 'iron', length: 38 * IN, lie: 61, loft: 26 },
  { id: '6i', name: '6 iron', kind: 'iron', length: 37.5 * IN, lie: 61.5, loft: 29 },
  { id: '7i', name: '7 iron', kind: 'iron', length: 37 * IN, lie: 62, loft: 33 },
  { id: '8i', name: '8 iron', kind: 'iron', length: 36.5 * IN, lie: 62.5, loft: 37 },
  { id: '9i', name: '9 iron', kind: 'iron', length: 36 * IN, lie: 63, loft: 41 },
  { id: 'PW', name: 'Pitching wedge', kind: 'wedge', length: 35.75 * IN, lie: 63.5, loft: 46 },
  { id: '50°', name: '50° wedge', kind: 'wedge', length: 35.5 * IN, lie: 64, loft: 50 },
  { id: '56°', name: '56° wedge', kind: 'wedge', length: 35.25 * IN, lie: 64, loft: 56 },
  { id: '60°', name: '60° wedge', kind: 'wedge', length: 35 * IN, lie: 64, loft: 60 },
];

/** 0 for the shortest club (lob wedge) → 1 for the driver, by length: everything about the set-up that scales with
 *  the club (stand distance, ball position, shoulder tilt, grip) reads this */
export function clubLengthT(spec: ClubSpec) {
  const ls = CLUB_SPECS.map(c => c.length), lo = Math.min(...ls), hi = Math.max(...ls);
  return Math.min(1, Math.max(0, (spec.length - lo) / (hi - lo)));
}
/** Attack angle at impact, degrees (+ = hitting up): driver off a tee +3, a 3 iron (39") level, wedges −5; by length.
 *  Divots and launch can read this (a steeper attack takes a bigger divot). */
export function attackAngleDeg(spec: ClubSpec) {
  const inch = spec.length / IN;
  return inch >= 39 ? Math.min(3, (inch - 39) / (45.5 - 39) * 3) : Math.max(-5, (inch - 39) / (39 - 35.5) * 5);
}

export interface ClubModel {
  spec: ClubSpec;
  group: THREE.Group;        // pose this
  length: number;
  shaftDir: THREE.Vector3;   // unit, hosel → butt, at address (local)
  hosel: THREE.Vector3;      // local
  butt: THREE.Vector3;       // local
  gripLead: THREE.Vector3;   // lead hand centre on the shaft (local)
  gripTrail: THREE.Vector3;
  head: THREE.Mesh;
  sweetToGround: number;     // height of the sweet spot above the sole
}

let mats: Record<string, THREE.Material> | null = null;
function materials() {
  if (mats) return mats;
  const gripTex = (() => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 256; const g = c.getContext('2d')!;
    g.fillStyle = '#1a1a1c'; g.fillRect(0, 0, 64, 256);
    for (let y = 0; y < 256; y += 6) { g.fillStyle = 'rgba(255,255,255,.05)'; g.fillRect(0, y, 64, 2); }
    g.fillStyle = '#b3262e'; g.fillRect(0, 10, 64, 6);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  mats = {
    chrome: new THREE.MeshStandardMaterial({ color: '#d9dde2', metalness: 1, roughness: 0.18 }),
    satin: new THREE.MeshStandardMaterial({ color: '#c9ccd0', metalness: 1, roughness: 0.38 }),
    steel: new THREE.MeshStandardMaterial({ color: '#d4d6d8', metalness: 1, roughness: 0.26, envMapIntensity: 0.8 }),
    graphite: new THREE.MeshPhysicalMaterial({ color: '#1c1f24', metalness: 0.3, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.15 }),
    crown: new THREE.MeshPhysicalMaterial({ color: '#121417', metalness: 0.4, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.08 }),
    face: new THREE.MeshStandardMaterial({ color: '#4a4f57', metalness: 0.9, roughness: 0.35 }),
    grip: new THREE.MeshStandardMaterial({ map: gripTex, roughness: 0.85 }),
    ferrule: new THREE.MeshStandardMaterial({ color: '#111', roughness: 0.4 }),
  };
  return mats;
}

function ironHead(spec: ClubSpec) {
  const wedge = spec.kind === 'wedge';
  const s = new THREE.Shape();
  // profile in (toe-ward z, height y); heel at z=-0.04, toe at z=+0.04
  const heelH = wedge ? 0.034 : 0.03, toeH = wedge ? 0.058 : 0.05;
  s.moveTo(-0.042, 0);
  s.lineTo(0.03, 0);
  s.quadraticCurveTo(0.046, 0.002, 0.045, 0.02);
  s.quadraticCurveTo(0.044, toeH, 0.028, toeH);
  s.lineTo(-0.03, heelH);
  s.quadraticCurveTo(-0.044, heelH - 0.004, -0.044, 0.016);
  s.quadraticCurveTo(-0.045, 0.002, -0.042, 0);
  const depth = wedge ? 0.012 : 0.016;
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.0025, bevelSegments: 3, curveSegments: 10 });
  // extrusion (+Z) becomes the back of the head (-X); the 2D x becomes toe (+Z)
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const loft = THREE.MathUtils.degToRad(spec.loft);
  for (let i = 0; i < p.count; i++) {
    const u = p.getX(i), v = p.getY(i), w = p.getZ(i);
    // cavity back: thicker near the sole
    const back = -w * (1 + (wedge ? 0.6 : 1.2) * Math.max(0, 1 - v / 0.02));
    // loft: the face leans back as it rises
    p.setXYZ(i, back - v * Math.tan(loft) * 0.9, v, u);
  }
  g.computeVertexNormals();
  return g;
}

function woodHead(spec: ClubSpec) {
  const size = spec.kind === 'driver' ? 1 : spec.kind === 'wood' ? 0.8 : 0.66;
  const g = new THREE.SphereGeometry(1, 48, 32);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const loft = THREE.MathUtils.degToRad(spec.loft);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // pear: front (face) at x = +1, flattened; wider toward the back
    let px = (x - 1) * 0.056;
    if (x > 0.55) px = THREE.MathUtils.lerp(px, -0.0252 + (x - 0.55) * 0.003, 0.85);
    const pz = z * 0.06 * (1 + 0.08 * (-x)) + 0.004;
    let py = y * 0.031;
    if (y < 0) py *= spec.kind === 'hybrid' ? 0.7 : 0.62;
    px -= py * Math.tan(loft) * 0.5;
    p.setXYZ(i, px * size * (spec.kind === 'hybrid' ? 0.8 : 1), py * size + 0.019 * size, pz * size);
  }
  g.computeVertexNormals();
  return { g, size };
}

/** forged iron finish: satin-blasted face with milled score lines, polished back and topline, brushed sole, cavity badge */
const ironMats: Record<string, THREE.MeshStandardMaterial> = {};
function ironMaterial(wedge: boolean) {
  const key = wedge ? 'w' : 'i';
  if (ironMats[key]) return ironMats[key];
  const m = new THREE.MeshStandardMaterial({ color: wedge ? '#b9b7b2' : '#cfd0d1', metalness: 1, roughness: 0.2, envMapIntensity: 0.75 });
  m.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vP; varying vec3 vN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvP = position; vN = normal;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vP; varying vec3 vN;')
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        vec3 on = normalize(vN);
        float face = smoothstep(0.55, 0.8, on.x);              // the hitting face looks toward +x
        float sole = smoothstep(0.5, 0.8, -on.y);
        float back = smoothstep(0.3, 0.7, -on.x);
        // face: bead-blasted satin, darker, with milled score lines across it
        float inZone = step(0.004, vP.y) * step(vP.y, 0.036) * step(abs(vP.z + 0.002), 0.031);
        float groove = (1.0 - smoothstep(0.0003, 0.0007, abs(fract(vP.y / 0.0034) - 0.5) * 0.0034)) * inZone;
        float mill = 0.5 + 0.5 * sin(vP.z * 9000.0 + vP.y * 400.0);
        roughnessFactor = mix(roughnessFactor, ${wedge ? '0.62' : '0.5'} + 0.06 * mill, face);
        diffuseColor.rgb *= mix(1.0, ${wedge ? '0.7' : '0.78'} - 0.45 * groove, face);
        // sole: brushed, scuffed from turf
        roughnessFactor = mix(roughnessFactor, 0.45, sole);
        diffuseColor.rgb *= mix(1.0, 0.82, sole);
        // back: polished, with a dark badge in the cavity
        vec2 bp = vec2(vP.z - 0.006, vP.y - 0.018);
        float badge = back * (1.0 - smoothstep(0.011, 0.0125, length(bp * vec2(0.5, 1.7))));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.1, 0.12, 0.16), badge * 0.75);
        roughnessFactor = mix(roughnessFactor, 0.35, badge);
        roughnessFactor = mix(roughnessFactor, ${wedge ? '0.4' : '0.12'}, back * (1.0 - badge));`)
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.4, badge);');
  };
  m.customProgramCacheKey = () => 'iron-' + key;
  ironMats[key] = m;
  return m;
}

export function buildClub(spec: ClubSpec, extraLength: number, gloveMat: THREE.Material, skinMat: THREE.Material): ClubModel {
  const M = materials();
  const group = new THREE.Group(); group.name = `club-${spec.id}`;
  const L = spec.length + extraLength;
  const lie = THREE.MathUtils.degToRad(spec.lie);
  const shaftDir = new THREE.Vector3(0, Math.sin(lie), -Math.cos(lie));
  const wood = spec.kind === 'driver' || spec.kind === 'wood' || spec.kind === 'hybrid';
  let head: THREE.Mesh, sweet: number, hosel: THREE.Vector3;
  if (wood) {
    const { g, size } = woodHead(spec);
    head = new THREE.Mesh(g, M.crown);
    // the face: a separate slightly lighter plate
    const face = new THREE.Mesh(new THREE.CircleGeometry(1, 32), M.face);
    face.scale.set(0.022 * size, 0.05 * size, 1); face.rotation.y = Math.PI / 2; face.position.set(0.0005, 0.019 * size, 0.004 * size);
    face.rotation.z = 0; face.rotateX(Math.PI / 2);
    head.add(face);
    sweet = 0.019 * size + 0.002;
    hosel = new THREE.Vector3(-0.022 * size, 0.025 * size, -0.058 * size);
  } else {
    head = new THREE.Mesh(ironHead(spec), ironMaterial(spec.kind === 'wedge'));
    sweet = 0.018;
    hosel = new THREE.Vector3(-0.012, 0.026, -0.043);
  }
  // shift so the sweet spot is the local origin (face plane at x ≈ 0)
  head.position.set(0, -sweet, 0);
  hosel.y -= sweet;
  group.add(head);

  // hosel, shaft, grip
  const hoselLen = wood ? 0.05 : 0.065;
  const parts: [THREE.BufferGeometry, THREE.Material][] = [];
  const along = (r0: number, r1: number, from: number, to: number, mat: THREE.Material, seg = 14) => {
    const c = new THREE.CylinderGeometry(r1, r0, to - from, seg, 1, false);
    c.translate(0, (from + to) / 2, 0);
    parts.push([c, mat]);
  };
  along(0.0072, 0.0062, -0.01, hoselLen, wood ? M.crown : (spec.kind === 'wedge' ? M.satin : M.chrome));
  along(0.0064, 0.0064, hoselLen, hoselLen + 0.012, M.ferrule);
  const gripLen = 0.27;
  along(0.0046, 0.0074, hoselLen, L - gripLen + 0.01, wood ? M.graphite : M.steel, 12);
  along(0.0098, 0.0128, L - gripLen, L, M.grip, 18);
  const cap = new THREE.SphereGeometry(0.0128, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2); cap.scale(1, 0.4, 1); cap.translate(0, L, 0);
  parts.push([cap, M.grip]);
  const shaftGroup = new THREE.Group();
  for (const [g, m] of parts) shaftGroup.add(new THREE.Mesh(g, m));
  // orient the shaft: local +Y → shaftDir, starting at the hosel
  shaftGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), shaftDir);
  shaftGroup.position.copy(hosel);
  group.add(shaftGroup);

  const butt = hosel.clone().addScaledVector(shaftDir, L);
  const gripLead = butt.clone().addScaledVector(shaftDir, -0.05);
  const gripTrail = butt.clone().addScaledVector(shaftDir, -0.14);
  group.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  void gloveMat; void skinMat;
  return { spec, group, length: L, shaftDir, hosel, butt, gripLead, gripTrail, head, sweetToGround: sweet };
}

/**
 * Hands gripping the club, in club-local space. `toward` is the direction (local) from each grip
 * point to its wrist; the hands are shaped to fill that gap. Returns the wrist points (local).
 */
export function buildHands(club: ClubModel, towardLead: THREE.Vector3, towardTrail: THREE.Vector3, glove: THREE.Material, skin: THREE.Material) {
  const s = club.shaftDir;
  const make = (center: THREE.Vector3, toward: THREE.Vector3, lead: boolean) => {
    const geos: THREE.BufferGeometry[] = [];
    const tw = toward.clone().addScaledVector(s, -toward.dot(s)).normalize(); // perpendicular to the shaft, toward the arm
    const side = new THREE.Vector3().crossVectors(s, tw).normalize();
    const basis = new THREE.Matrix4().makeBasis(side, s, tw);
    const blob = (rx: number, ry: number, rz: number, off: THREE.Vector3, segs = 16) => {
      const g = new THREE.SphereGeometry(1, segs, Math.round(segs * 0.75)); g.scale(rx, ry, rz); g.translate(off.x, off.y, off.z); g.applyMatrix4(basis); g.translate(center.x, center.y, center.z); geos.push(g);
    };
    // fist around the grip: palm on the arm side, fingers wrapped round the far side
    blob(0.036, 0.047, 0.034, new THREE.Vector3(0, 0, 0.012), 20);
    // knuckle ridge on the far side
    blob(0.03, 0.04, 0.016, new THREE.Vector3(0.0, -0.004, -0.02));
    // thumb along the shaft, pointing down it
    blob(0.011, 0.03, 0.011, new THREE.Vector3(lead ? -0.016 : -0.014, -0.03, 0.006));
    // back of the hand / wrist bridge toward the forearm
    const wrist = center.clone().addScaledVector(toward.clone().normalize(), 0.075);
    const mid = center.clone().lerp(wrist, 0.55);
    const g = new THREE.SphereGeometry(1, 14, 10); g.scale(0.03, 0.028, 0.045);
    const look = new THREE.Matrix4().lookAt(mid, wrist, s); g.applyMatrix4(look); g.translate(mid.x, mid.y, mid.z); geos.push(g);
    const mesh = new THREE.Mesh(mergeGeometries(geos), lead ? glove : skin);
    mesh.castShadow = mesh.receiveShadow = true;
    return { mesh, wrist };
  };
  const L = make(club.gripLead, towardLead, true), R = make(club.gripTrail, towardTrail, false);
  const group = new THREE.Group(); group.add(L.mesh, R.mesh);
  return { group, wristLead: L.wrist, wristTrail: R.wrist };
}
