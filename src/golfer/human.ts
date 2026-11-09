// The realistic golfer body: a CC0 MakeHuman base human shaped, rigged, clothed and textured offline by
// tools/character/build.py, loaded here into a skinned mesh. Exposes the same Body interface as the
// old code-built body (18 driver bones in the order rig.ts expects), plus hands, fingers and toes.
import * as THREE from 'three';
import type { Body, Skeleton as SkelInfo } from './body';
import type { GolferProfile } from './profile';
import { buildVisor } from './headwear';
import { applyFabric } from './fabric';
import crestUrl from '../assets/brand/toronto-hunt-crest.png?url';

export interface HumanData {
  meta: {
    bones: string[]; parents: number[]; joint: number[][]; tail: number[][];
    eye: number[]; headCenter: number[]; visor: { center: number[]; rx: number; rz: number; profile?: number[] };
    eyeballs: Record<'l' | 'r', { c: number[]; r: number }>; iris: number[];
    collar: number[][]; belt: { y: number; cx: number; cz: number; rx: number; rz: number };
    feet: Record<'l' | 'r', { heelZ: number; toeZ: number; x: number; halfW: number; ankleY: number }>;
    meshes: Record<string, Record<string, { offset: number; count: number; type: string }>>;
  };
  buf: ArrayBuffer; blobStart: number;
  skin: HTMLImageElement; eyes: HTMLImageElement;
}

const loadImage = (url: string) => new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });

export async function loadHuman(binUrl: string, skinUrl: string, eyesUrl: string): Promise<HumanData> {
  // inlined builds carry the file as a data: URL; decode it directly (some sandboxes block fetch of data: URLs)
  const getBin = async () => {
    if (binUrl.startsWith('data:')) { const b = atob(binUrl.slice(binUrl.indexOf(',') + 1)); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u.buffer; }
    return fetch(binUrl).then(r => r.arrayBuffer());
  };
  const [buf, skin, eyes] = await Promise.all([getBin(), loadImage(skinUrl), loadImage(eyesUrl)]);
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
    if (d.cloth) g.setAttribute('cloth', new THREE.BufferAttribute(arr(d.cloth), 4));
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
  const fu = { kneeY: J[M.bones.indexOf('calf_l')].y, ankleY: J[M.bones.indexOf('foot_l')].y, beltY: M.belt.y, backZ: M.belt.cz };
  const skinMat = new THREE.MeshPhysicalMaterial({ map: tex(data.skin), roughness: 0.5, sheen: 0.4, sheenColor: new THREE.Color('#ff8e6e'), sheenRoughness: 0.5, clearcoat: 0.06, clearcoatRoughness: 0.45 });
  applyFabric(skinMat, 'skin', fu);
  const skin = add('skin', skinMat)!;
  const shirtMat = new THREE.MeshPhysicalMaterial({ color: O.shirt, roughness: 0.86, sheen: 0.4, sheenColor: new THREE.Color('#ffffff').lerp(new THREE.Color(O.shirt), 0.6), sheenRoughness: 0.6, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  {
    // the crest sits on the wearer's left chest; a left-hander is drawn mirrored, so it goes on the rig's right and is flipped back
    const crest = new THREE.TextureLoader().load(crestUrl); crest.colorSpace = THREE.SRGBColorSpace; crest.anisotropy = 8;
    const chest = J[M.bones.indexOf('spine_02')];
    const side = p.handed === 'left' ? -1 : 1;
    const cz = M.collar.reduce((a, c) => Math.max(a, c[2]), -9) - 0.01;
    applyFabric(shirtMat, 'polo', { ...fu, crest: { tex: crest, c: new THREE.Vector3(side * 0.085, chest.y + 0.12, cz), size: 0.07, flip: p.handed === 'left' }, tipping: new THREE.Color(O.topTrim ?? '#ffffff') });
  }
  add('shirt', shirtMat);
  const pantsMat = new THREE.MeshPhysicalMaterial({ color: O.pants, roughness: 0.82, sheen: 0.3, sheenColor: new THREE.Color('#ffffff').lerp(new THREE.Color(O.pants), 0.6), sheenRoughness: 0.5, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  applyFabric(pantsMat, 'chino', fu);
  add('pants', pantsMat);
  const glove = new THREE.MeshPhysicalMaterial({ color: O.glove, roughness: 0.55, sheen: 0.3, sheenColor: new THREE.Color('#ffffff'), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  applyFabric(glove, 'glove', fu);
  add('glove', glove);
  void fabricNormal;
  void data.eyes;
  const teeth = add('teeth', new THREE.MeshStandardMaterial({ color: '#e8e0d2', roughness: 0.35 }));
  // hair: per-pixel ragged edge from the baked mask
  const hairCol = new THREE.Color(p.look.hair);
  const strands = canvasTex(512, 512, g => {
    g.fillStyle = '#' + hairCol.getHexString(); g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 16000; i++) { const x = rand() * 512, y = rand() * 512, l = 5 + rand() * 14; g.strokeStyle = rand() < 0.45 ? 'rgba(150,112,78,.38)' : 'rgba(12,8,5,.42)'; g.lineWidth = 0.8 + rand() * 0.8; g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + (rand() - 0.5) * 6, y + l / 2, x + (rand() - 0.5) * 4, y + l); g.stroke(); }
  }, true, 7);
  const hairMat = new THREE.MeshPhysicalMaterial({ map: strands, roughness: 0.62, sheen: 0.8, sheenColor: new THREE.Color('#b58a5e'), sheenRoughness: 0.35, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  hairMat.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float mask;\nvarying float vMask;\nvarying vec3 vObj;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvMask = mask; vObj = position;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vMask;\nvarying vec3 vObj;')
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n float hn = fract(sin(dot(floor(vObj.xy * 3000.0) + floor(vObj.z * 3000.0), vec2(12.9898, 78.233))) * 43758.5453);\n if (vMask < 0.3 + 0.45 * hn) discard;');
  };
  hairMat.customProgramCacheKey = () => 'human-hair';
  add('hair', hairMat);
  // fur-style shells over the hair cap: each layer keeps fewer, finer strands, so the hair gets depth and a soft edge
  {
    const base = M.meshes.hair;
    for (let layer = 1; layer <= 4; layer++) {
      const m = new THREE.MeshStandardMaterial({ color: hairCol.clone().multiplyScalar(0.9 + layer * 0.09), roughness: 0.55, transparent: false });
      const L = layer;
      m.onBeforeCompile = sh => {
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float mask;\nvarying float vMask;\nvarying vec3 vObj;')
          .replace('#include <begin_vertex>', `#include <begin_vertex>\nvMask = mask; vObj = position;
            float tus = sin(position.x * 91.0 + sin(position.z * 57.0) * 2.0) * sin(position.z * 83.0 + position.y * 40.0);
            transformed += objectNormal * (${(0.0016 * L).toFixed(5)} + 0.0035 * max(0.0, tus) * ${(L / 4).toFixed(2)}) * mask;`);
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\nvarying float vMask;\nvarying vec3 vObj;
float hh(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }`)
          .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
            // strands: cells elongated down and back (the way short hair lies)
            vec3 q = vObj * vec3(2600.0, 900.0, 1500.0);
            float s = hh(floor(q));
            if (vMask < 0.55 || s < ${(0.35 + 0.15 * L).toFixed(2)}) discard;`)
          .replace('#include <aomap_fragment>', `#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= ${(0.55 + 0.11 * L).toFixed(2)};`);
      };
      m.customProgramCacheKey = () => 'hair-shell-' + L;
      void base;
      const sh = add('hair', m); if (sh) sh.name = 'hair-shell';
    }
  }

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
      const a = (i / seg) * Math.PI * 2, x = B.cx + Math.sin(a) * (B.rx + 0.017), z = B.cz + Math.cos(a) * (B.rz + 0.017);
      pos.push(x, B.y - h / 2, z, x, B.y + h / 2, z);
    }
    for (let i = 0; i < seg; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    g.translate(-J[pelvisBi].x, -J[pelvisBi].y, -J[pelvisBi].z);
    const leather = new THREE.MeshPhysicalMaterial({ color: (O as any).belt ?? '#2a1d14', roughness: 0.45, clearcoat: 0.3, side: THREE.DoubleSide });
    const belt = new THREE.Mesh(g, leather); belt.castShadow = true; bones[pelvisBi].add(belt); meshes.push(belt);
    const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.036, 0.006), new THREE.MeshStandardMaterial({ color: '#c9ccd1', metalness: 1, roughness: 0.25 }));
    buckle.position.set(B.cx, B.y, B.cz + B.rz + 0.02).sub(J[pelvisBi]); bones[pelvisBi].add(buckle);
  }
  // shoes: modern spikeless golf shoes sized to the feet (on the foot bones): rubber sole, leather upper,
  // laces, toe perforations and an accent stripe, all from one UV-mapped texture
  const shoeTex = canvasTex(512, 256, g => {
    // u: round the shoe (0 = outer side bottom → top → inner side), v: heel (0) → toe (1)
    const base = O.shoes, trim = O.shoeTrim;
    g.fillStyle = base; g.fillRect(0, 0, 512, 256);
    for (let i = 0; i < 3000; i++) { g.fillStyle = rand() < 0.5 ? 'rgba(0,0,0,.025)' : 'rgba(255,255,255,.05)'; g.fillRect(rand() * 512, rand() * 256, 2, 2); }
    // heel counter panel
    g.fillStyle = 'rgba(0,0,0,.06)'; g.fillRect(0, 0, 512, 46);
    // accent stripe sweeping up both sides
    g.fillStyle = trim;
    for (const x0 of [60, 452]) { g.beginPath(); g.moveTo(x0 - 26, 60); g.quadraticCurveTo(x0, 120, x0 + (x0 < 256 ? 70 : -70), 180); g.lineTo(x0 + (x0 < 256 ? 82 : -82), 168); g.quadraticCurveTo(x0 + 6, 104, x0 - 10, 52); g.fill(); }
    // toe cap seam + perforations
    g.strokeStyle = 'rgba(0,0,0,.18)'; g.lineWidth = 2; g.beginPath(); g.moveTo(90, 200); g.quadraticCurveTo(256, 170, 422, 200); g.stroke();
    g.fillStyle = 'rgba(0,0,0,.22)';
    for (let r = 0; r < 4; r++) for (let i = 0; i < 18; i++) { const x = 150 + i * 12 + (r % 2) * 6, y = 210 + r * 9; g.beginPath(); g.arc(x, y, 1.6, 0, 7); g.fill(); }
    // stitching lines
    g.strokeStyle = 'rgba(0,0,0,.12)'; g.setLineDash([4, 4]); g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(0, 52); g.lineTo(512, 52); g.moveTo(90, 206); g.quadraticCurveTo(256, 176, 422, 206); g.stroke(); g.setLineDash([]);
  }, true, 1);
  shoeTex.wrapS = shoeTex.wrapT = THREE.ClampToEdgeWrapping; shoeTex.repeat.set(1, 1);
  const upperMat = new THREE.MeshPhysicalMaterial({ map: shoeTex, roughness: 0.42, clearcoat: 0.55, clearcoatRoughness: 0.28, sheen: 0.2 });
  const soleMat = new THREE.MeshStandardMaterial({ color: '#efeee9', roughness: 0.7 });
  const outsoleMat = new THREE.MeshStandardMaterial({ color: '#3a3b3e', roughness: 0.9 });
  const laceMat = new THREE.MeshStandardMaterial({ color: '#f4f3ef', roughness: 0.75 });
  for (const sfx of ['l', 'r'] as const) {
    const f = M.feet[sfx], fb = M.bones.indexOf(`foot_${sfx}`);
    const len = f.toeZ - f.heelZ + 0.026, hw = f.halfW + 0.014, z0 = f.heelZ - 0.016;
    const grp = new THREE.Group();
    // sole: a flat slab following the outline, slight toe spring
    const outline = (t: number) => { // half width of the sole along the foot
      const w = t < 0.15 ? 0.62 + 0.38 * Math.sin((t / 0.15) * Math.PI / 2) : t < 0.7 ? 1.0 - 0.06 * Math.sin(((t - 0.15) / 0.55) * Math.PI) : 1.0 - 0.15 * ((t - 0.7) / 0.3) ** 1.5;
      return hw * w * (t > 0.92 ? Math.sqrt(Math.max(0, 1 - ((t - 0.92) / 0.085) ** 2)) * 0.9 + 0.1 : 1);
    };
    const spring = (t: number) => (t > 0.8 ? ((t - 0.8) / 0.2) ** 2 * 0.012 : 0);
    {
      const shape = new THREE.Shape(); const N = 40;
      for (let i = 0; i <= N; i++) { const t = i / N; const z = z0 + t * len; if (i === 0) shape.moveTo(-outline(t), z); else shape.lineTo(-outline(t), z); }
      for (let i = N; i >= 0; i--) { const t = i / N; shape.lineTo(outline(t), z0 + t * len); }
      const sole = new THREE.ExtrudeGeometry(shape, { depth: 0.017, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.003, bevelSegments: 2, curveSegments: 4 });
      sole.rotateX(Math.PI / 2); sole.translate(f.x, 0.02, 0);
      const pa = sole.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < pa.count; i++) { const t = (pa.getZ(i) - z0) / len; pa.setY(i, pa.getY(i) + spring(t)); }
      sole.computeVertexNormals();
      const m = new THREE.Mesh(sole, [soleMat, soleMat]); grp.add(m);
      const out = new THREE.Mesh(sole.clone().scale(1, 0.18, 1), outsoleMat); out.position.y = -0.0045 * 0; grp.add(out);
    }
    // upper: lofted rings, heel to toe
    const prof: [number, number][] = [[0, 0.068], [0.05, 0.088], [0.16, 0.097], [0.3, 0.102], [0.44, 0.097], [0.58, 0.086], [0.7, 0.074], [0.8, 0.066], [0.88, 0.058], [0.95, 0.048], [0.99, 0.036], [1.0, 0.03]];
    const seg = 24, pos: number[] = [], uv: number[] = [], idx: number[] = [];
    prof.forEach(([t, top]) => {
      const z = z0 + 0.004 + t * (len - 0.008), w = outline(t) * 0.97, base = 0.019 + spring(t);
      for (let j = 0; j <= seg; j++) {
        const a = Math.PI * (j / seg); // 0 = outer side at the sole, PI = inner side
        const sx = -Math.cos(a), sy = Math.sin(a);
        // a rounded arch: full width low down, narrowing over the top of the foot
        pos.push(f.x + sx * w * (sfx === 'l' ? 1 : -1) * (1 - 0.16 * sy * sy), base + sy * (top - base), z);
        uv.push(j / seg, t);
      }
    });
    for (let r = 0; r < prof.length - 1; r++) for (let j = 0; j < seg; j++) { const a = r * (seg + 1) + j, b = a + seg + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
    // close the toe
    { const ci = pos.length / 3, r = prof.length - 1; pos.push(f.x, 0.03 + spring(1), z0 + len - 0.002); uv.push(0.5, 1); for (let j = 0; j < seg; j++) { const a = r * (seg + 1) + j; idx.push(a, ci, a + 1); } }
    const upper = new THREE.BufferGeometry(); upper.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); upper.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); upper.setIndex(idx); upper.computeVertexNormals();
    const um = new THREE.Mesh(upper, upperMat); (um.material as THREE.Material).side = THREE.DoubleSide; grp.add(um);
    // laces: five short bars across the instep
    for (let i = 0; i < 5; i++) {
      const t = 0.4 + i * 0.065, top = 0.098 - i * 0.008 + 0.012, z = z0 + t * len;
      const lace = new THREE.Mesh(new THREE.CapsuleGeometry(0.0022, 0.03 - i * 0.002, 2, 6), laceMat);
      lace.rotation.z = Math.PI / 2; lace.rotation.y = (i % 2 ? 0.25 : -0.25); lace.position.set(f.x, top, z); grp.add(lace);
    }
    grp.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    grp.position.sub(J[fb]);
    bones[fb].add(grp); meshes.push(grp);
  }

  // hat
  const headBi = M.bones.indexOf('head');
  // eyeballs: sclera, iris, pupil and a glossy cornea, looking straight ahead (+Z)
  {
    const ir = M.iris;
    const eyeTex = canvasTex(256, 128, g => {
      // equirectangular: u = longitude, v = latitude; the front (+Z) is u = 0.25 for three's sphere UVs
      g.fillStyle = '#bfb2a6'; g.fillRect(0, 0, 256, 128);
      const cx = 0.25 * 256, cy = 64;
      for (let i = 0; i < 30; i++) { g.strokeStyle = 'rgba(190,90,80,.25)'; g.lineWidth = 0.6; g.beginPath(); const a = rand() * 7; g.moveTo(cx + Math.cos(a) * 60, cy + Math.sin(a) * 30); g.lineTo(cx + Math.cos(a) * 24, cy + Math.sin(a) * 12); g.stroke(); }
      const gr = g.createRadialGradient(cx, cy, 2, cx, cy, 23);
      gr.addColorStop(0, `rgb(${ir[0] * 0.6},${ir[1] * 0.65},${ir[2] * 0.65})`); gr.addColorStop(0.55, `rgb(${ir[0]},${ir[1]},${ir[2]})`); gr.addColorStop(0.9, `rgb(${ir[0] * 0.7},${ir[1] * 0.75},${ir[2] * 0.8})`); gr.addColorStop(1, 'rgb(40,46,52)');
      g.fillStyle = gr; g.beginPath(); g.ellipse(cx, cy, 23, 23, 0, 0, 7); g.fill();
      for (let i = 0; i < 60; i++) { const a = rand() * 7; g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 0.7; g.beginPath(); g.moveTo(cx + Math.cos(a) * 8, cy + Math.sin(a) * 8); g.lineTo(cx + Math.cos(a) * 18, cy + Math.sin(a) * 18); g.stroke(); }
      g.fillStyle = '#0b0b0d'; g.beginPath(); g.arc(cx, cy, 8, 0, 7); g.fill();
      // the upper lid shades the top of the eye
      const lid = g.createLinearGradient(0, 0, 0, cy); lid.addColorStop(0, 'rgba(40,24,20,.85)'); lid.addColorStop(0.7, 'rgba(40,24,20,.35)'); lid.addColorStop(1, 'rgba(40,24,20,0)');
      g.fillStyle = lid; g.fillRect(0, 0, 256, cy);
    }, true, 1);
    eyeTex.wrapS = eyeTex.wrapT = THREE.ClampToEdgeWrapping; eyeTex.repeat.set(1, 1);
    const eyeMat = new THREE.MeshPhysicalMaterial({ map: eyeTex, roughness: 0.4, clearcoat: 0.6, clearcoatRoughness: 0.08, envMapIntensity: 0.25 });
    for (const sfx of ['l', 'r'] as const) {
      const e = M.eyeballs[sfx];
      const ball = new THREE.Mesh(new THREE.SphereGeometry(e.r * 0.98, 32, 20), eyeMat);
      ball.name = 'eye';
      ball.position.set(e.c[0], e.c[1], e.c[2] - 0.0015).sub(J[headBi]);
      bones[headBi].add(ball); meshes.push(ball);
    }
  }
  if (O.headwear?.kind === 'visor') {
    const v = M.visor;
    const g = buildVisor(O.headwear, v.rx, v.rz, 0, 0, p.handed === 'left', v.profile);
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
    // the palm is the side the fingertips curl toward: the finger chain bends that way in the bind pose
    const tip = Tl[bi(`middle_03_${sfx}`)].clone().sub(J[bi(`middle_01_${sfx}`)]);
    if (tip.dot(n) < 0) n.negate();
    extras.palm[s].copy(n);
    extras.curlAxis[s].crossVectors(dir, n).normalize(); // rotating fingers about this bends them toward the palm
    extras.handDir[s].copy(dir);
  }

  const setSmile = (v0: number) => {
    const v = v0;
    if (skin.morphTargetInfluences) skin.morphTargetInfluences[0] = v;
    if (teeth?.morphTargetInfluences) teeth.morphTargetInfluences[0] = v;
    if (teeth) teeth.visible = v > 0.08; // closed mouth: keep teeth from showing through the lips
  };
  return { root, bones, skel, meshes, materials: { skin: skinMat, glove }, setSmile, extras };
}
