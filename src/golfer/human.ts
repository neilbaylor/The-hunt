// The realistic golfer body: a CC0 MakeHuman base human shaped, rigged, clothed and textured offline by
// tools/character/build.py, loaded here into a skinned mesh. Exposes the same Body interface as the
// old code-built body (18 driver bones in the order rig.ts expects), plus hands, fingers and toes.
import * as THREE from 'three';
import type { Body, Skeleton as SkelInfo } from './body';
import type { GolferProfile } from './profile';
import { buildVisor } from './headwear';

export interface HumanData {
  meta: {
    bones: string[]; parents: number[]; joint: number[][]; tail: number[][];
    eye: number[]; headCenter: number[]; visor: { center: number[]; rx: number; rz: number };
    collar: number[][]; belt: { y: number; cx: number; cz: number; rx: number; rz: number };
    feet: Record<'l' | 'r', { heelZ: number; toeZ: number; x: number; halfW: number; ankleY: number }>;
    meshes: Record<string, Record<string, { offset: number; count: number; type: string }>>;
  };
  buf: ArrayBuffer; blobStart: number;
  skin: HTMLImageElement; eyes: HTMLImageElement;
}

const loadImage = (url: string) => new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });

export async function loadHuman(binUrl: string, skinUrl: string, eyesUrl: string): Promise<HumanData> {
  const [buf, skin, eyes] = await Promise.all([fetch(binUrl).then(r => r.arrayBuffer()), loadImage(skinUrl), loadImage(eyesUrl)]);
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'GOLF') throw new Error('bad character file');
  const len = dv.getUint32(4, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, len)));
  const blobStart = (8 + len + 3) & ~3;
  return { meta, buf, blobStart, skin, eyes };
}

export interface HumanExtras {
  hand: { L: number; R: number };          // bone indices
  ball: { L: number; R: number };
  fingers: { L: number[][]; R: number[][] }; // [thumb, index, middle, ring, pinky] × 3 segments
  palm: { L: THREE.Vector3; R: THREE.Vector3 }; // bind palm normals
  curlAxis: { L: THREE.Vector3; R: THREE.Vector3 };
  handDir: { L: THREE.Vector3; R: THREE.Vector3 };
}

function tex(img: HTMLImageElement, srgb = true) {
  const t = new THREE.Texture(img); t.needsUpdate = true; t.flipY = true;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}
function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, srgb = true, repeat = 1) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat); t.anisotropy = 8; return t;
}
let seed = 3; const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

/** normal map for knit / woven fabric */
function fabricNormal(kind: 'pique' | 'twill' | 'leather') {
  return canvasTex(256, 256, g => {
    g.fillStyle = 'rgb(128,128,255)'; g.fillRect(0, 0, 256, 256);
    if (kind === 'pique') {
      for (let y = 0; y < 256; y += 4) for (let x = (y / 4) % 2 ? 2 : 0; x < 256; x += 4) {
        const gr = g.createRadialGradient(x + 2, y + 2, 0, x + 2, y + 2, 2.4);
        gr.addColorStop(0, 'rgba(128,128,255,1)'); gr.addColorStop(1, 'rgba(90,90,230,1)');
        g.fillStyle = gr; g.fillRect(x, y, 4, 4);
      }
    } else if (kind === 'twill') {
      for (let i = -256; i < 512; i += 5) { g.strokeStyle = 'rgba(150,110,255,.6)'; g.lineWidth = 2; g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 256, 256); g.stroke(); g.strokeStyle = 'rgba(105,145,255,.6)'; g.beginPath(); g.moveTo(i + 2.5, 0); g.lineTo(i + 258.5, 256); g.stroke(); }
    } else {
      for (let i = 0; i < 4000; i++) { g.fillStyle = rand() < 0.5 ? 'rgba(140,140,255,.5)' : 'rgba(115,115,255,.5)'; g.beginPath(); g.arc(rand() * 256, rand() * 256, 1 + rand() * 2, 0, 7); g.fill(); }
    }
  }, false, kind === 'pique' ? 60 : kind === 'twill' ? 45 : 20);
}

export function buildHumanBody(data: HumanData, p: GolferProfile): Body & { extras: HumanExtras } {
  const M = data.meta;
  const J = M.joint.map(a => new THREE.Vector3(a[0], a[1], a[2]));
  const Tl = M.tail.map(a => new THREE.Vector3(a[0], a[1], a[2]));
  const bones = M.bones.map(n => { const b = new THREE.Bone(); b.name = n; return b; });
  bones.forEach((b, i) => { const par = M.parents[i]; if (par < 0) b.position.copy(J[i]); else { b.position.subVectors(J[i], J[par]); bones[par].add(b); } });
  const skeleton = new THREE.Skeleton(bones);
  const root = new THREE.Group(); root.name = `golfer-${p.id}`;
  root.add(bones[0]); root.updateMatrixWorld(true);

  const arr = (d: { offset: number; count: number; type: string }) => {
    const o = data.blobStart + d.offset;
    if (d.type === 'float32') return new Float32Array(data.buf, o, d.count);
    if (d.type === 'uint32') return new Uint32Array(data.buf, o, d.count);
    return new Uint16Array(data.buf, o, d.count);
  };
  const geo = (name: string) => {
    const d = M.meshes[name]; const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr(d.position), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(arr(d.uv), 2));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(arr(d.skinIndex) as Uint16Array, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(arr(d.skinWeight), 4));
    if (d.mask) g.setAttribute('mask', new THREE.BufferAttribute(arr(d.mask), 1));
    g.setIndex(new THREE.BufferAttribute(arr(d.index), 1));
    g.computeVertexNormals();
    const morphs = Object.keys(d).filter(k => k.startsWith('morph_'));
    if (morphs.length) { g.morphAttributes.position = morphs.map(k => new THREE.BufferAttribute(arr(d[k]), 3)); g.morphTargetsRelative = true; }
    return g;
  };
  const meshes: THREE.Object3D[] = [];
  const add = (name: string, mat: THREE.Material) => {
    if (!M.meshes[name]) return null;
    const m = new THREE.SkinnedMesh(geo(name), mat);
    m.name = name; m.castShadow = m.receiveShadow = true; m.frustumCulled = false;
    root.add(m); m.bind(skeleton); meshes.push(m);
    return m;
  };

  const O = p.outfit;
  const skinMat = new THREE.MeshPhysicalMaterial({ map: tex(data.skin), roughness: 0.56, sheen: 0.35, sheenColor: new THREE.Color('#ff9f80'), sheenRoughness: 0.45, clearcoat: 0.04, clearcoatRoughness: 0.5 });
  const skin = add('skin', skinMat)!;
  const shirtMat = new THREE.MeshPhysicalMaterial({ color: O.shirt, roughness: 0.86, normalMap: fabricNormal('pique'), normalScale: new THREE.Vector2(0.45, 0.45), sheen: 0.7, sheenColor: new THREE.Color('#ffffff').lerp(new THREE.Color(O.shirt), 0.4), sheenRoughness: 0.6, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  add('shirt', shirtMat);
  const pantsMat = new THREE.MeshPhysicalMaterial({ color: O.pants, roughness: 0.8, normalMap: fabricNormal('twill'), normalScale: new THREE.Vector2(0.35, 0.35), sheen: 0.5, sheenColor: new THREE.Color('#ffffff').lerp(new THREE.Color(O.pants), 0.5), sheenRoughness: 0.55, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  add('pants', pantsMat);
  const glove = new THREE.MeshPhysicalMaterial({ color: O.glove, roughness: 0.6, normalMap: fabricNormal('leather'), normalScale: new THREE.Vector2(0.3, 0.3), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  add('glove', glove);
  const eyeMat = new THREE.MeshPhysicalMaterial({ map: tex(data.eyes), roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.02 });
  add('eyes', eyeMat);
  const teeth = add('teeth', new THREE.MeshStandardMaterial({ color: '#e8e0d2', roughness: 0.35 }));
  add('lashes', new THREE.MeshStandardMaterial({ color: '#241812', roughness: 0.9, side: THREE.DoubleSide }));
  // hair: per-pixel ragged edge from the baked mask
  const hairCol = new THREE.Color(p.look.hair);
  const strands = canvasTex(512, 512, g => {
    g.fillStyle = '#' + hairCol.getHexString(); g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 9000; i++) { const x = rand() * 512, y = rand() * 512, l = 4 + rand() * 10; g.strokeStyle = rand() < 0.5 ? 'rgba(120,90,60,.35)' : 'rgba(8,5,3,.4)'; g.lineWidth = 1; g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rand() - 0.5) * 3, y + l); g.stroke(); }
  }, true, 6);
  const hairMat = new THREE.MeshStandardMaterial({ map: strands, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  hairMat.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float mask;\nvarying float vMask;\nvarying vec3 vObj;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvMask = mask; vObj = position;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vMask;\nvarying vec3 vObj;')
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n float hn = fract(sin(dot(floor(vObj.xy * 3000.0) + floor(vObj.z * 3000.0), vec2(12.9898, 78.233))) * 43758.5453);\n if (vMask < 0.3 + 0.45 * hn) discard;');
  };
  hairMat.customProgramCacheKey = () => 'human-hair';
  add('hair', hairMat);

  // the rig expects these 18 driver bones first (see build.py DRIVERS)
  const skel: SkelInfo = {
    joint: J.slice(0, 18), tail: Tl.slice(0, 18),
    headCenter: new THREE.Vector3(...(M.headCenter as [number, number, number])),
    eye: new THREE.Vector3(...(M.eye as [number, number, number])),
  };

  // polo collar: a stand-up band that folds over, open at the front, riding on the chest
  const chestBi = M.bones.indexOf('spine_02'), pelvisBi = M.bones.indexOf('pelvis');
  {
    const ring = M.collar.map(a => new THREE.Vector3(a[0], a[1], a[2]));
    const c = ring.reduce((a, b) => a.add(b), new THREE.Vector3()).multiplyScalar(1 / ring.length);
    // profile across the collar: (outward, up) from the neckline, stand then fold
    const prof: [number, number][] = [[-0.003, -0.004], [0.0, 0.026], [0.004, 0.033], [0.012, 0.03], [0.026, 0.012], [0.034, 0.0]];
    const pos: number[] = [], idx: number[] = [];
    const n = ring.length, rows = prof.length;
    const sorted = ring.map(p => ({ p, a: Math.atan2(p.x - c.x, p.z - c.z) })).sort((a, b) => a.a - b.a);
    const open = 0.32; // radians either side of the front left open (placket)
    const pts = sorted.filter(o => Math.abs(o.a) > open);
    // order from the left of the opening round the back to the right
    pts.sort((a, b) => ((a.a + 2 * Math.PI) % (2 * Math.PI)) - ((b.a + 2 * Math.PI) % (2 * Math.PI)));
    for (const { p, a } of pts) {
      const out = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
      const front = Math.max(0, Math.cos(a)); // collar points spread and drop at the front
      for (const [o, u] of prof) pos.push(p.x + out.x * (o + 0.006 * front), p.y + u - 0.012 * front * (u > 0.02 ? 0 : 1), p.z + out.z * (o + 0.006 * front));
    }
    for (let i = 0; i < pts.length - 1; i++) for (let r = 0; r < rows - 1; r++) { const a = i * rows + r, b = a + rows; idx.push(a, b, a + 1, a + 1, b, b + 1); }
    void n;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    g.translate(-J[chestBi].x, -J[chestBi].y, -J[chestBi].z);
    const col = new THREE.Mesh(g, shirtMat.clone()); (col.material as THREE.MeshPhysicalMaterial).side = THREE.DoubleSide;
    col.castShadow = col.receiveShadow = true; bones[chestBi].add(col); meshes.push(col);
    // placket: a short strip with two buttons
    const front = sorted.reduce((b, o) => (Math.abs(o.a) < Math.abs(b.a) ? o : b)).p;
    const plk = new THREE.Mesh(new THREE.PlaneGeometry(0.03, 0.1), shirtMat.clone());
    plk.position.set(front.x, front.y - 0.055, front.z + 0.004).sub(J[chestBi]); plk.rotation.x = -0.12; bones[chestBi].add(plk);
    for (const dy of [-0.035, -0.075]) { const b = new THREE.Mesh(new THREE.CircleGeometry(0.0055, 16), new THREE.MeshStandardMaterial({ color: '#f2f0ea', roughness: 0.3 })); b.position.set(front.x, front.y + dy, front.z + 0.0065).sub(J[chestBi]); b.rotation.x = -0.12; bones[chestBi].add(b); }
  }
  // belt: a leather band round the waist with a buckle, on the pelvis
  {
    const B = M.belt, seg = 64, h = 0.034, pos: number[] = [], idx: number[] = [];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2, x = B.cx + Math.sin(a) * (B.rx + 0.011), z = B.cz + Math.cos(a) * (B.rz + 0.011);
      pos.push(x, B.y - h / 2, z, x, B.y + h / 2, z);
    }
    for (let i = 0; i < seg; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    g.translate(-J[pelvisBi].x, -J[pelvisBi].y, -J[pelvisBi].z);
    const leather = new THREE.MeshPhysicalMaterial({ color: (O as any).belt ?? '#2a1d14', roughness: 0.45, clearcoat: 0.3, side: THREE.DoubleSide });
    const belt = new THREE.Mesh(g, leather); belt.castShadow = true; bones[pelvisBi].add(belt); meshes.push(belt);
    const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.036, 0.006), new THREE.MeshStandardMaterial({ color: '#c9ccd1', metalness: 1, roughness: 0.25 }));
    buckle.position.set(B.cx, B.y, B.cz + B.rz + 0.014).sub(J[pelvisBi]); bones[pelvisBi].add(buckle);
  }
  // shoes: proper golf shoes sized to the feet, on the foot bones
  for (const sfx of ['l', 'r'] as const) {
    const f = M.feet[sfx], fb = M.bones.indexOf(`foot_${sfx}`);
    const len = f.toeZ - f.heelZ + 0.03, hw = f.halfW + 0.016;
    const prof: [number, number, number][] = [ // t along the foot, half width, height
      [0, 0.55, 0.075], [0.04, 0.8, 0.09], [0.15, 0.92, 0.1], [0.32, 0.98, 0.1], [0.5, 1.0, 0.078], [0.66, 1.0, 0.062],
      [0.8, 0.93, 0.05], [0.9, 0.78, 0.042], [0.96, 0.55, 0.034], [1.0, 0.2, 0.026]];
    const seg = 22, pos: number[] = [], col: number[] = [], idx: number[] = [];
    const base = new THREE.Color(O.shoes), trim = new THREE.Color(O.shoeTrim), sole = new THREE.Color('#2a2a2c');
    prof.forEach(([t, w, hgt]) => {
      const z = f.heelZ - 0.012 + t * len;
      for (let j = 0; j <= seg; j++) {
        const a = (j / seg) * Math.PI * 2, cs = Math.cos(a), sn = Math.sin(a);
        const ex = Math.sign(cs) * Math.pow(Math.abs(cs), 0.75), ey = Math.sign(sn) * Math.pow(Math.abs(sn), 0.8);
        const y = Math.max(0, hgt / 2 + ey * hgt / 2);
        pos.push(f.x + ex * hw * w, y, z);
        const cc = y < 0.012 ? sole : y < 0.022 && t > 0.1 && t < 0.85 ? trim : base;
        col.push(cc.r, cc.g, cc.b);
      }
    });
    for (let r = 0; r < prof.length - 1; r++) for (let j = 0; j < seg; j++) { const a = r * (seg + 1) + j, b = a + seg + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
    // caps at heel and toe
    for (const r of [0, prof.length - 1]) { const ci = pos.length / 3; const z = pos[(r * (seg + 1)) * 3 + 2]; pos.push(f.x, prof[r][2] / 2, z); col.push(base.r, base.g, base.b); for (let j = 0; j < seg; j++) { const a = r * (seg + 1) + j; if (r === 0) idx.push(ci, a + 1, a); else idx.push(ci, a, a + 1); } }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx); g.computeVertexNormals();
    g.translate(-J[fb].x, -J[fb].y, -J[fb].z);
    const shoe = new THREE.Mesh(g, new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.38, clearcoat: 0.6, clearcoatRoughness: 0.25, side: THREE.DoubleSide }));
    shoe.castShadow = shoe.receiveShadow = true; bones[fb].add(shoe); meshes.push(shoe);
  }

  // hat
  const headBi = M.bones.indexOf('head');
  if (O.headwear?.kind === 'visor') {
    const v = M.visor;
    const g = buildVisor(O.headwear, v.rx, v.rz, 0, 0, p.handed === 'left');
    g.position.set(v.center[0], v.center[1], v.center[2]).sub(J[headBi]);
    bones[headBi].add(g); meshes.push(g);
  }

  // hands: bind palm normals and finger curl axes
  const bi = (n: string) => M.bones.indexOf(n);
  const extras: HumanExtras = {
    hand: { L: bi('hand_l'), R: bi('hand_r') }, ball: { L: bi('ball_l'), R: bi('ball_r') },
    fingers: { L: [], R: [] }, palm: { L: new THREE.Vector3(), R: new THREE.Vector3() }, curlAxis: { L: new THREE.Vector3(), R: new THREE.Vector3() }, handDir: { L: new THREE.Vector3(), R: new THREE.Vector3() },
  };
  for (const s of ['L', 'R'] as const) {
    const sfx = s === 'L' ? 'l' : 'r';
    extras.fingers[s] = ['thumb', 'index', 'middle', 'ring', 'pinky'].map(f => [1, 2, 3].map(i => bi(`${f}_0${i}_${sfx}`)));
    const h = J[bi(`hand_${sfx}`)], dir = Tl[bi(`hand_${sfx}`)].clone().sub(h).normalize();
    const across = J[bi(`index_01_${sfx}`)].clone().sub(J[bi(`pinky_01_${sfx}`)]).normalize();
    const n = new THREE.Vector3().crossVectors(dir, across).normalize();
    // the palm faces the thigh at rest: toward -x for the left hand, +x for the right
    if ((s === 'L' && n.x > 0) || (s === 'R' && n.x < 0)) n.negate();
    extras.palm[s].copy(n);
    extras.curlAxis[s].crossVectors(dir, n).normalize(); // rotating fingers about this bends them toward the palm
    extras.handDir[s].copy(dir);
  }

  const setSmile = (v: number) => {
    if (skin.morphTargetInfluences) skin.morphTargetInfluences[0] = v;
    if (teeth?.morphTargetInfluences) teeth.morphTargetInfluences[0] = v;
  };
  return { root, bones, skel, meshes, materials: { skin: skinMat, glove }, setSmile, extras };
}
