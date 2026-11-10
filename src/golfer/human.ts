// The realistic golfer body: a CC0 MakeHuman base human shaped, rigged, clothed and textured offline by
// tools/character/build.py, loaded here into a skinned mesh. Exposes the same Body interface as the
// old code-built body (18 driver bones in the order rig.ts expects), plus hands, fingers and toes.
import * as THREE from 'three';
import type { Body, Skeleton as SkelInfo } from './body';
import type { GolferProfile } from './profile';
import { buildVisor, preloadVisorLogo } from './headwear';
import { applyFabric } from './fabric';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildGenHead, buildHairCards, hideAboveSeam, loadGenHead, type GenHeadData, type FaceController } from './genhead';
import crestUrl from '../assets/brand/toronto-hunt-crest.png?url';
import malbonUrl from '../assets/brand/malbon-m.svg?url';

export interface HumanData {
  meta: {
    bones: string[]; parents: number[]; joint: number[][]; tail: number[][];
    eye: number[]; headCenter: number[]; visor: { center: number[]; rx: number; rz: number; profile?: number[] };
    eyeballs: Record<'l' | 'r', { c: number[]; r: number }>; iris: number[]; paintedMouth?: boolean; paintedSmile?: number | null;
    collar: number[][]; belt: { y: number; cx: number; cz: number; rx: number; rz: number };
    feet: Record<'l' | 'r', { heelZ: number; toeZ: number; x: number; halfW: number; ankleY: number }>;
    meshes: Record<string, Record<string, { offset: number; count: number; type: string }>>;
  };
  buf: ArrayBuffer; blobStart: number;
  skin: HTMLImageElement; eyes: HTMLImageElement; skinSmile?: HTMLImageElement;
  head?: GenHeadData;   // the generated head (tools/character/head.py), if loaded
}

const loadImage = (url: string) => new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });

export async function loadHuman(binUrl: string, skinUrl: string, eyesUrl: string, smileUrl?: string): Promise<HumanData> {
  // inlined builds carry the file as a data: URL; decode it directly (some sandboxes block fetch of data: URLs)
  const getBin = async () => {
    if (binUrl.startsWith('data:')) { const b = atob(binUrl.slice(binUrl.indexOf(',') + 1)); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u.buffer; }
    return fetch(binUrl).then(r => r.arrayBuffer());
  };
  const [buf, skin, eyes, skinSmile] = await Promise.all([getBin(), loadImage(skinUrl), loadImage(eyesUrl), smileUrl ? loadImage(smileUrl) : Promise.resolve(undefined)]);
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'GOLF') throw new Error('bad character file');
  const len = dv.getUint32(4, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, len)));
  const blobStart = (8 + len + 3) & ~3;
  return { meta, buf, blobStart, skin, eyes, skinSmile };
}

/** loadHuman plus the generated head */
export async function loadHumanWithHead(binUrl: string, skinUrl: string, eyesUrl: string, smileUrl: string | undefined, headBin: string, headTex: string): Promise<HumanData> {
  const [h, head] = await Promise.all([loadHuman(binUrl, skinUrl, eyesUrl, smileUrl), loadGenHead(headBin, headTex).catch(e => { console.warn('generated head failed to load', e); return undefined; }), preloadVisorLogo()]);
  return { ...h, head };
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
/** Merge parts with different materials into ONE geometry + ONE atlas texture (one draw call): every textured
 *  part's canvas is packed into the atlas (tinted by its material colour), every plain-coloured part gets a small
 *  solid patch, and each part's UVs are remapped into its slot. Parts' own transforms are applied. */
type AtlasItem = { key: string; w: number; h: number; draw: (g: CanvasRenderingContext2D, x: number, y: number) => void; x: number; y: number; pad: number };
type AtlasLayout = { items: Map<string, AtlasItem>; tex: THREE.CanvasTexture; AW: number; AH: number };
function bakeAtlas(parts: THREE.Mesh[], AW = 2048, reuse?: AtlasLayout) {
  type Item = AtlasItem;
  const items = reuse ? reuse.items : new Map<string, Item>();
  const keyOf = (m: THREE.MeshStandardMaterial) => {
    const col = m.color ? m.color.getHexString() : 'ffffff';
    const key = (m.map ? m.map.uuid : 'c') + col;
    if (!items.has(key)) {
      if (m.map) {
        if (reuse) throw new Error('bakeAtlas: part not in the reused atlas');
        const cv = m.map.image as HTMLCanvasElement, sc = Math.min(1, (cv.width > 8 * cv.height ? AW / 3 : AW / 2) / cv.width);   // long strips go a third wide
        const w = Math.round(cv.width * sc), h = Math.max(8, Math.round(cv.height * sc));
        items.set(key, { key, w, h, x: 0, y: 0, pad: 4, draw: (g, x, y) => {
          // smear the image's edge pixels out into the padding, so filtering at the part's UV edges never pulls in
          // the atlas's empty (white) gutter, which shows as a white outline (e.g. round the shirt placket)
          g.drawImage(cv, x - 4, y - 4, w + 8, h + 8);
          g.drawImage(cv, x, y, w, h);
          if (col !== 'ffffff') { g.save(); g.globalCompositeOperation = 'multiply'; g.fillStyle = '#' + col; g.fillRect(x - 4, y - 4, w + 8, h + 8); g.restore(); }
        } });
      } else if (reuse) throw new Error('bakeAtlas: colour not in the reused atlas');
      else items.set(key, { key, w: 24, h: 24, x: 0, y: 0, pad: 12, draw: (g, x, y) => { g.fillStyle = '#' + col; g.fillRect(x - 12, y - 12, 48, 48); } });
    }
    return key;
  };
  const keys = parts.map(p => keyOf(p.material as THREE.MeshStandardMaterial));
  let AH: number, tex: THREE.CanvasTexture;
  if (reuse) { AH = reuse.AH; tex = reuse.tex; }
  else {
    // shelf packing, tallest first; short items stack in columns under each other within a row
    let x = 0, y = 0, rowH = 0, colX = -1, colY = 0, colW = 0;
    for (const it of [...items.values()].sort((a, b) => b.h - a.h)) {
      const W = it.w + 2 * it.pad, H = it.h + 2 * it.pad;
      if (colX >= 0 && colY + H <= y + rowH && W <= colW) { it.x = colX + it.pad; it.y = colY + it.pad; colY += H; continue; }
      if (x + W > AW) { x = 0; y += rowH; rowH = 0; colX = -1; }
      it.x = x + it.pad; it.y = y + it.pad; rowH = Math.max(rowH, H);
      colX = x; colY = y + H; colW = W; x += W;
    }
    AH = Math.ceil((y + rowH) / 4) * 4;
    tex = canvasTex(AW, AH, g => { g.fillStyle = '#808080'; g.fillRect(0, 0, AW, AH); for (const it of items.values()) it.draw(g, it.x, it.y); }, true, 1);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; tex.repeat.set(1, 1);
  }
  const geos = parts.map((p, i) => {
    p.updateMatrix();
    let g = p.geometry.clone().applyMatrix4(p.matrix);
    if (!g.index) { const n = g.getAttribute('position').count; g.setIndex([...Array(n).keys()]); }
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const it = items.get(keys[i])!, n = g.getAttribute('position').count, uvIn = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
    const uv = new Float32Array(n * 2), solid = !(p.material as THREE.MeshStandardMaterial).map;
    for (let k = 0; k < n; k++) {
      const u = solid || !uvIn ? 0.5 : Math.min(1, Math.max(0, uvIn.getX(k))), v = solid || !uvIn ? 0.5 : Math.min(1, Math.max(0, uvIn.getY(k)));
      uv[k * 2] = (it.x + u * it.w) / AW; uv[k * 2 + 1] = 1 - (it.y + (1 - v) * it.h) / AH;
    }
    const out = new THREE.BufferGeometry(); out.setIndex(g.index); out.setAttribute('position', g.getAttribute('position')); out.setAttribute('normal', g.getAttribute('normal')); out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g = out; return g;
  });
  return { geometry: mergeGeometries(geos)!, texture: tex, layout: { items, tex, AW, AH } as AtlasLayout };
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

export function buildHumanBody(data: HumanData, p: GolferProfile): Body & { extras: HumanExtras; face?: FaceController } {
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
  const smileAmt = { value: 0 };
  // the generated head (from the portrait, which already smiles) replaces the MakeHuman face; profile.head = 'makehuman' switches back
  const genOn = !!data.head && p.head !== 'makehuman';
  applyFabric(skinMat, 'skin', data.skinSmile && !genOn ? { ...fu, smile: { map: tex(data.skinSmile), amount: smileAmt } } : fu);
  const skin = add('skin', skinMat)!;
  // corrective shapes for bent elbows and knees: each blends in with the joint's bend, measured from the bone
  // directions (so forearm roll doesn't count), so the olecranon / kneecap make a point and the volume holds
  {
    const keys = Object.keys(M.meshes.skin).filter(k => k.startsWith('morph_'));
    const B = (n: string) => bones[M.bones.indexOf(n)];
    const cors = (['l', 'r'] as const).flatMap(sx => [['elbow', 'upperarm', 'lowerarm', 'hand'], ['knee', 'thigh', 'calf', 'foot']].map(([n, a, b, c]) => {
      const i = keys.indexOf(`morph_cor_${n}_${sx}`);
      const ja = J[M.bones.indexOf(`${a}_${sx}`)], jb = J[M.bones.indexOf(`${b}_${sx}`)], jc = J[M.bones.indexOf(`${c}_${sx}`)];
      return { i, a: B(`${a}_${sx}`), b: B(`${b}_${sx}`), c: B(`${c}_${sx}`), rest: jb.clone().sub(ja).angleTo(jc.clone().sub(jb)) };
    })).filter(o => o.i >= 0);
    if (cors.length && skin.morphTargetInfluences) {
      const pa = new THREE.Vector3(), pb = new THREE.Vector3(), pc = new THREE.Vector3(), u = new THREE.Vector3(), w = new THREE.Vector3();
      skin.onBeforeRender = () => {
        for (const o of cors) {
          o.a.getWorldPosition(pa); o.b.getWorldPosition(pb); o.c.getWorldPosition(pc);
          const bend = u.subVectors(pb, pa).angleTo(w.subVectors(pc, pb)) - o.rest;
          const t = Math.min(1, Math.max(0, (bend - 0.15) / 1.45));
          skin.morphTargetInfluences![o.i] = t * t * (3 - 2 * t);
        }
      };
    }
  }
  const eyeL = M.eyeballs.l.c, eyeR = M.eyeballs.r.c;
  const gen = genOn ? buildGenHead(data.head!, M.bones, skeleton, root, new THREE.Vector3(...(M.eye as [number, number, number])), Math.hypot(eyeL[0] - eyeR[0], eyeL[1] - eyeR[1], eyeL[2] - eyeR[2]), M.visor.center[1], p.look.eyes) : null;
  if (gen) { hideAboveSeam(skinMat, gen.seam, gen.skin); skinMat.color.copy(gen.tint); meshes.push(gen.mesh); }
  // strand-level hair on the generated head (cards rooted on its scalp, flattened under the visor band)
  const genHair = gen ? buildHairCards(gen, { color: p.look.hair, eye: new THREE.Vector3(...(M.eye as [number, number, number])), band: O.headwear ? { y: gen.visor.center[1] } : undefined }) : null;
  if (genHair) { const hb = M.bones.indexOf('head'); genHair.geometry.translate(-J[hb].x, -J[hb].y, -J[hb].z); bones[hb].add(genHair); meshes.push(genHair); }
  const shirtMat = new THREE.MeshPhysicalMaterial({ color: O.shirt, roughness: 0.86, sheen: 0.2, sheenColor: new THREE.Color('#ffffff').lerp(new THREE.Color(O.shirt), 0.6), sheenRoughness: 0.6, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  {
    // the crest sits on the wearer's left chest; a left-hander is drawn mirrored, so it goes on the rig's right and is flipped back
    // the Malbon script 'm' (vector, traced from the brand artwork) as white embroidery: a soft thread shadow,
    // the white satin fill and a fine diagonal stitch texture. The crest square maps to size × size/1.2 on
    // the chest (see fabric.ts), so the art is drawn 1.2× taller here to keep its true proportions.
    const crest = O.chestLogo === 'malbon-m' ? canvasTex(1024, 1024, g => g.clearRect(0, 0, 1024, 1024), true, 1) : new THREE.TextureLoader().load(crestUrl);
    if (O.chestLogo === 'malbon-m') {
      const img = new Image();
      img.onload = () => {
        const cv = crest.image as HTMLCanvasElement, g = cv.getContext('2d')!, N = 1024;
        const ar = (img.height || 800) / (img.width || 1000), w = N * 0.86, h = w * ar * 1.2, x = (N - w) / 2, y = (N - h) / 2;
        const shape = document.createElement('canvas'); shape.width = shape.height = N;
        const sg = shape.getContext('2d')!; sg.drawImage(img, x, y, w, h);
        // a touch bolder than the trace (about one font-weight step): stamp the letter round a small ring
        const thick = document.createElement('canvas'); thick.width = thick.height = N; const tg = thick.getContext('2d')!;
        for (let k = 0; k < 12; k++) { const a = k / 12 * Math.PI * 2; tg.drawImage(img, x + Math.cos(a) * 6, y + Math.sin(a) * 6, w, h); }
        tg.drawImage(img, x, y, w, h); sg.clearRect(0, 0, N, N); sg.drawImage(thick, 0, 0);
        const tint = (col: string) => { const c = document.createElement('canvas'); c.width = c.height = N; const cg = c.getContext('2d')!; cg.drawImage(shape, 0, 0); cg.globalCompositeOperation = 'source-in'; cg.fillStyle = col; cg.fillRect(0, 0, N, N); return c; };
        g.clearRect(0, 0, N, N);
        g.save(); g.filter = 'blur(5px)'; g.globalAlpha = 0.35; g.drawImage(tint('#000'), 5, 8); g.restore();   // thread shadow on the knit
        g.drawImage(tint('#f5f3ee'), 0, 0);
        // satin stitches: fine diagonal lines across the thread, clipped to the letter
        const st = tint('rgba(0,0,0,0)'), stg = st.getContext('2d')!;
        stg.globalCompositeOperation = 'source-over'; stg.drawImage(shape, 0, 0); stg.globalCompositeOperation = 'source-in';
        for (let k = -N; k < N * 2; k += 7) { stg.strokeStyle = 'rgba(150,145,135,.35)'; stg.lineWidth = 2; stg.beginPath(); stg.moveTo(k, 0); stg.lineTo(k - N * 0.6, N); stg.stroke(); }
        g.drawImage(st, 0, 0);
        crest.needsUpdate = true;
      };
      img.src = malbonUrl;
    }
    crest.colorSpace = THREE.SRGBColorSpace; crest.anisotropy = 8; crest.wrapS = crest.wrapT = THREE.ClampToEdgeWrapping; crest.repeat.set(1, 1);
    const chest = J[M.bones.indexOf('spine_02')];
    const side = p.handed === 'left' ? -1 : 1;
    const cz = M.collar.reduce((a, c) => Math.max(a, c[2]), -9) - 0.01;
    applyFabric(shirtMat, 'polo', { ...fu, crest: { tex: crest, c: O.chestLogo === 'malbon-m' ? new THREE.Vector3(side * 0.088, M.collar.reduce((a, c) => (c[2] > a[2] ? c : a))[1] - 0.092, cz)   /* as on the shirt: ~9 cm out, its foot level with the foot of the placket */ : new THREE.Vector3(side * 0.085, chest.y + 0.12, cz), size: O.chestLogo === 'malbon-m' ? 0.04 : 0.07, flip: p.handed === 'left' }, tipping: new THREE.Color(O.topTrim ?? '#ffffff') });
  }
  const shirtMesh = add('shirt', shirtMat);
  // the shells are split along their UV seams; average the normals across those splits so the fabric shades
  // smoothly (otherwise every seam shows as a hard line)
  const weldNormals = (m: THREE.Mesh | null) => {
    if (!m) return;
    const pa = m.geometry.getAttribute('position') as THREE.BufferAttribute, na = m.geometry.getAttribute('normal') as THREE.BufferAttribute;
    const groups = new Map<string, number[]>();
    for (let i = 0; i < pa.count; i++) { const k = `${Math.round(pa.getX(i) * 1e4)},${Math.round(pa.getY(i) * 1e4)},${Math.round(pa.getZ(i) * 1e4)}`; const g = groups.get(k); if (g) g.push(i); else groups.set(k, [i]); }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const n = new THREE.Vector3(); for (const i of g) n.x += na.getX(i), n.y += na.getY(i), n.z += na.getZ(i);
      n.normalize(); for (const i of g) na.setXYZ(i, n.x, n.y, n.z);
    }
    na.needsUpdate = true;
  };
  weldNormals(shirtMesh);
  const pantsMat = new THREE.MeshPhysicalMaterial({ color: O.pants, roughness: 0.85, sheen: 0.15, sheenColor: new THREE.Color('#ffffff').lerp(new THREE.Color(O.pants), 0.8), sheenRoughness: 0.5, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  applyFabric(pantsMat, 'chino', fu);
  const pantsMesh = add('pants', pantsMat); weldNormals(pantsMesh);
  const glove = new THREE.MeshPhysicalMaterial({ color: O.glove, roughness: 0.55, sheen: 0.3, sheenColor: new THREE.Color('#ffffff'), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  applyFabric(glove, 'glove', fu);
  add('glove', glove);
  const sockMat = new THREE.MeshPhysicalMaterial({ color: '#f2f1ec', roughness: 0.95, sheen: 0.6, sheenColor: new THREE.Color('#ffffff'), side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  applyFabric(sockMat, 'glove', fu);
  add('socks', sockMat);
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
  // hair cards: thousands of short strand strips rooted in the scalp, lying the way the hair grows
  // (swept back on top, down and back at the sides), like modern sports games do short hair
  {
    const hg = (scene_hairGeo());
    function scene_hairGeo() { return geo('hair'); }
    const P = hg.getAttribute('position') as THREE.BufferAttribute, Nn = hg.getAttribute('normal') as THREE.BufferAttribute, Mk = hg.getAttribute('mask') as THREE.BufferAttribute;
    const idx = hg.getIndex()!.array;
    const strandTex = canvasTex(256, 256, g => {
      g.clearRect(0, 0, 256, 256);
      for (let i = 0; i < 70; i++) {
        const x0 = 8 + rand() * 240, w = 1 + rand() * 2.2, len = 140 + rand() * 116, bend = (rand() - 0.5) * 18;
        const grad = g.createLinearGradient(0, 256, 0, 256 - len);
        grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.75, 'rgba(255,255,255,.85)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.strokeStyle = grad; g.lineWidth = w; g.lineCap = 'round';
        g.beginPath(); g.moveTo(x0, 256); g.quadraticCurveTo(x0 + bend, 256 - len / 2, x0 + bend * 1.6, 256 - len); g.stroke();
      }
    }, false, 1);
    strandTex.wrapS = strandTex.wrapT = THREE.ClampToEdgeWrapping; strandTex.repeat.set(1, 1);
    const tint = canvasTex(64, 64, g => { g.fillStyle = '#fff'; g.fillRect(0, 0, 64, 64); }, true, 1);
    // area-weighted roots
    const tris: number[] = [], cum: number[] = []; let tot = 0;
    const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i], b = idx[i + 1], c = idx[i + 2];
      const m = (Mk.getX(a) + Mk.getX(b) + Mk.getX(c)) / 3; if (m < 0.45) continue;
      va.fromBufferAttribute(P, a); vb.fromBufferAttribute(P, b); vc.fromBufferAttribute(P, c);
      const area = vb.clone().sub(va).cross(vc.clone().sub(va)).length() / 2 * Math.min(1, (m - 0.45) / 0.3);
      tot += area; tris.push(i); cum.push(tot);
    }
    const crown = new THREE.Vector3(...(M.headCenter as [number, number, number]));
    const N = 7000, SEG = 3, pos: number[] = [], uv: number[] = [], col: number[] = [], ind: number[] = [];
    const root = new THREE.Vector3(), nrm = new THREE.Vector3(), gdir = new THREE.Vector3(), side = new THREE.Vector3(), p = new THREE.Vector3();
    const hc = hairCol.clone();
    const grey = new THREE.Color('#9a958e');
    for (let k = 0; k < N; k++) {
      const r = rand() * tot; let lo = 0, hi = cum.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < r) lo = mid + 1; else hi = mid; }
      const i = tris[lo], a = idx[i], b = idx[i + 1], c = idx[i + 2];
      let u = rand(), v = rand(); if (u + v > 1) { u = 1 - u; v = 1 - v; }
      va.fromBufferAttribute(P, a); vb.fromBufferAttribute(P, b); vc.fromBufferAttribute(P, c);
      root.copy(va).multiplyScalar(1 - u - v).addScaledVector(vb, u).addScaledVector(vc, v);
      nrm.fromBufferAttribute(Nn, a).multiplyScalar(1 - u - v).addScaledVector(new THREE.Vector3().fromBufferAttribute(Nn, b), u).addScaledVector(new THREE.Vector3().fromBufferAttribute(Nn, c), v).normalize();
      const rel = root.clone().sub(crown);
      const top = THREE.MathUtils.smoothstep(rel.y, 0.02, 0.09);          // 0 at the sides, 1 on top
      // growth: back on top (swept back), down and back at the sides and the nape, with a little noise
      // at the front hairline the hair is pushed up and back off the forehead
      const front = THREE.MathUtils.smoothstep(rel.z, 0.03, 0.09);
      gdir.set((rand() - 0.5) * 0.35, -1 + top * 0.85 + front * 0.9, -0.6 - top * 0.6 - front * 0.6);
      gdir.addScaledVector(nrm, -gdir.dot(nrm)).normalize();
      side.crossVectors(nrm, gdir).normalize();
      // under the visor band the hair is pressed flat
      const vy = M.visor.center[1], underBand = (O.headwear && root.y > vy - 0.03 && root.y < vy + 0.026) ? 1 : 0;
      const L = (0.014 + 0.026 * top) * (0.7 + 0.6 * rand()) * (underBand ? 0.55 : 1), W = 0.006 + 0.004 * rand();
      const lift = underBand ? 0.15 : 1;
      const base = pos.length / 3;
      const shade = 0.75 + 0.45 * rand(); const c0 = hc.clone().multiplyScalar(shade).lerp(grey, 0);
      for (let s = 0; s <= SEG; s++) {
        const t = s / SEG;
        // rises off the scalp then lies down onto it
        p.copy(root).addScaledVector(gdir, L * t).addScaledVector(nrm, 0.0012 + (0.004 + 0.006 * top) * lift * Math.sin(t * Math.PI * 0.8));
        const w = W * (1 - 0.35 * t);
        pos.push(p.x - side.x * w / 2, p.y - side.y * w / 2, p.z - side.z * w / 2, p.x + side.x * w / 2, p.y + side.y * w / 2, p.z + side.z * w / 2);
        const ux = rand() * 0.6;
        uv.push(ux, t, ux + 0.4, t);
        for (let q = 0; q < 2; q++) col.push(c0.r * (0.7 + 0.3 * t), c0.g * (0.7 + 0.3 * t), c0.b * (0.7 + 0.3 * t));
      }
      for (let s = 0; s < SEG; s++) { const q = base + s * 2; ind.push(q, q + 2, q + 1, q + 1, q + 2, q + 3); }
    }
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); cg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); cg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    cg.setIndex(ind);
    // every card is lit like the scalp under it (outward normal), so no card flips bright or dark
    { const nn: number[] = []; const pa = cg.getAttribute('position') as THREE.BufferAttribute; const hcv = new THREE.Vector3(...(M.headCenter as [number, number, number])); const t = new THREE.Vector3();
      for (let i = 0; i < pa.count; i++) { t.fromBufferAttribute(pa, i).sub(hcv).normalize(); nn.push(t.x, t.y, t.z); }
      cg.setAttribute('normal', new THREE.Float32BufferAttribute(nn, 3)); }
    const headBi0 = M.bones.indexOf('head');
    cg.translate(-J[headBi0].x, -J[headBi0].y, -J[headBi0].z);
    const cm = new THREE.MeshStandardMaterial({ map: tint, alphaMap: strandTex, vertexColors: true, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.7 });
    const cards = new THREE.Mesh(cg, cm); cards.name = 'hair-shell'; cards.castShadow = true; cards.receiveShadow = true;
    bones[headBi0].add(cards); meshes.push(cards);
    void Mk;
  }

  // the rig expects these 18 driver bones first (see build.py DRIVERS)
  const skel: SkelInfo = {
    joint: J.slice(0, 18), tail: Tl.slice(0, 18),
    headCenter: new THREE.Vector3(...(M.headCenter as [number, number, number])),
    eye: new THREE.Vector3(...(M.eye as [number, number, number])),
  };

  // Lay small parts onto a skinned shell and skin them like it. `surfaceOf` indexes the shell's bind-space
  // vertices in a region; `near` gives the smoothed nearest surface point + outward normal; `skinned` turns a
  // bind-space geometry into a SkinnedMesh with the weights of the nearest shell vertices (minus `exclude` bones).
  const surfaceOf = (sm: THREE.SkinnedMesh, keep: (x: number, y: number, z: number) => boolean, inside: (q: THREE.Vector3) => THREE.Vector3, exclude = new Set<number>()) => {
    const sp = sm.geometry.getAttribute('position') as THREE.BufferAttribute, sn = sm.geometry.getAttribute('normal') as THREE.BufferAttribute;
    const cand: number[] = [];
    for (let i = 0; i < sp.count; i++) if (keep(sp.getX(i), sp.getY(i), sp.getZ(i))) cand.push(i);
    // a 2 cm grid over the candidates, so the many lookups (laying the collar on the shirt) stay cheap
    const H = 0.02, cell = new Map<number, number[]>(), ck = (x: number, y: number, z: number) => ((x + 512) * 1024 + y + 512) * 1024 + z + 512;
    for (const i of cand) { const k = ck(Math.floor(sp.getX(i) / H), Math.floor(sp.getY(i) / H), Math.floor(sp.getZ(i) / H)); const l = cell.get(k); if (l) l.push(i); else cell.set(k, [i]); }
    const nearest6 = (p: THREE.Vector3) => {
      const best: [number, number][] = [];
      const consider = (i: number) => {
        const d = (sp.getX(i) - p.x) ** 2 + (sp.getY(i) - p.y) ** 2 + (sp.getZ(i) - p.z) ** 2;
        if (best.length < 6 || d < best[5][0]) { best.push([d, i]); best.sort((x, y) => x[0] - y[0]); if (best.length > 6) best.pop(); }
      };
      const cx = Math.floor(p.x / H), cy = Math.floor(p.y / H), cz = Math.floor(p.z / H);
      // grow the search box until it holds six points that are certainly the nearest (closer than the box's walls)
      for (let r = 1; r <= 4; r++) {
        best.length = 0;
        for (let x = cx - r; x <= cx + r; x++) for (let y = cy - r; y <= cy + r; y++) for (let z = cz - r; z <= cz + r; z++) { const l = cell.get(ck(x, y, z)); if (l) for (const i of l) consider(i); }
        if (best.length === 6 && best[5][0] <= (r * H) ** 2) return best;
      }
      best.length = 0; for (const i of cand) consider(i);
      return best;
    };
    const ssi = sm.geometry.getAttribute('skinIndex') as THREE.BufferAttribute, ssw = sm.geometry.getAttribute('skinWeight') as THREE.BufferAttribute;
    const skinned = (geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[]) => {
      const pa = geo.getAttribute('position') as THREE.BufferAttribute, si = new Uint16Array(pa.count * 4), sw = new Float32Array(pa.count * 4), v = new THREE.Vector3();
      for (let k = 0; k < pa.count; k++) {
        v.fromBufferAttribute(pa, k); const acc = new Map<number, number>();
        for (const [d, i] of nearest6(v)) { const w = 1 / (Math.sqrt(d) + 0.002); for (let c = 0; c < 4; c++) { const b = ssi.getComponent(i, c), ww = ssw.getComponent(i, c) * w; if (ww > 0 && !exclude.has(b)) acc.set(b, (acc.get(b) ?? 0) + ww); } }
        const top4 = [...acc].sort((a, b) => b[1] - a[1]).slice(0, 4), tot = top4.reduce((s, x) => s + x[1], 0) || 1;
        top4.forEach(([b, w], c) => { si[k * 4 + c] = b; sw[k * 4 + c] = w / tot; });
      }
      geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4)); geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
      const m = new THREE.SkinnedMesh(geo, mat); m.frustumCulled = false; m.castShadow = m.receiveShadow = true;
      root.add(m); m.bind(skeleton); meshes.push(m); return m;
    };
    const near = (p: THREE.Vector3) => {   // smoothed nearest surface point + normal (6 nearest, inverse-distance weighted)
      const best = nearest6(p);
      const q = new THREE.Vector3(), n = new THREE.Vector3(); let ws = 0;
      for (const [d, i] of best) { const w = 1 / (Math.sqrt(d) + 0.002); ws += w; q.x += sp.getX(i) * w; q.y += sp.getY(i) * w; q.z += sp.getZ(i) * w; n.x += sn.getX(i) * w; n.y += sn.getY(i) * w; n.z += sn.getZ(i) * w; }
      q.multiplyScalar(1 / ws); n.normalize();
      if (n.dot(q.clone().sub(inside(q))) < 0) n.negate();   // the normal points out of the body
      return { q, n };
    };
    return { near, skinned, nearest6 };
  };
  // polo collar (Malbon Fairway: a self-fabric jersey collar, same smooth matte green as the body): one continuous
  // folded piece round the neck, no seam at the back. Built as a closed cross-section swept round the neckline:
  // the stand rises off the neckline hugging the neck (a few mm clear of it), rolls over a soft, visibly thick
  // fold (doubled fabric), and the leaf drapes down over the stand and onto the shirt, ending in an outer edge
  // that turns under (1.6 mm thick) to a darker underside. At the front the leaf ends in two long straight-edged
  // points that nearly meet over the top of the placket and point down and slightly out, lying on the chest.
  // A thin dark skirt under every free edge reads as the soft shadow line on the shirt; the stand's foot is dark
  // (the neck opening), the roll and outer edge a touch lighter where the fold catches the light.
  {
    const V3 = THREE.Vector3;
    const ring0 = M.collar.map(a => new V3(a[0], a[1], a[2]));
    const c = ring0.reduce((a, b) => a.add(b), new V3()).multiplyScalar(1 / ring0.length);
    const loY = Math.min(...ring0.map(q => q.y)) - 0.16, hiY = Math.max(...ring0.map(q => q.y));
    const inside = new V3(c.x, c.y - 0.16, c.z - 0.02);
    const armBone = new Set(M.bones.map((n, i) => (/upperarm|lowerarm|hand/.test(n) ? i : -1)).filter(i => i >= 0));   // the collar never follows the arms
    // collar, placket and buttons are skinned like the shirt under them, so they move with the fabric through the swing
    const { near, skinned } = surfaceOf(shirtMesh!, (x, y, z) => y > loY && Math.hypot(x - c.x, z - c.z) < 0.24, () => inside, armBone);
    // the neck and upper back (skin), so the stand hugs the neck and nothing of the collar cuts into the body
    // (and the generated head's own neck, which comes down over it to the shirt)
    const bodyKeep = (x: number, y: number, z: number) => y > loY + 0.08 && y < hiY + 0.04 && Math.hypot(x - c.x, z - c.z) < 0.17, bodyIn = (q: THREE.Vector3) => new V3(c.x, q.y - 0.04, c.z);
    const skinNear = surfaceOf(skin, bodyKeep, bodyIn).near, genNear = gen ? surfaceOf(gen.mesh as THREE.SkinnedMesh, bodyKeep, bodyIn).near : null;
    // the neckline as a smooth closed curve: radius and height against angle round the neck
    const sam = ring0.map(q => ({ a: Math.atan2(q.x - c.x, q.z - c.z), r: Math.hypot(q.x - c.x, q.z - c.z), y: q.y })).sort((x, y) => x.a - y.a);
    // the shirt's neckline has a small notch at the centre back (a dip of ~3 cm over 2 cm): the collar's line
    // ignores it (fitted to the ring without it); the leaf covers it, laid clear of the body there
    const notch = sam.filter((o, i) => { const nb = [-3, 3].map(d => sam[(i + d + sam.length) % sam.length].y); return o.y < Math.min(...nb) - 0.01; });
    const fitSam = sam.map((o, i) => {
      if (!notch.includes(o)) return o;
      const side = (d: number) => { let j = i; do j = (j + d + sam.length) % sam.length; while (notch.includes(sam[j])); return sam[j]; };
      return { ...o, y: (side(-1).y + side(1).y) / 2 };
    });
    // resampled at even angles round the neck and blurred a few degrees, read back by interpolation
    const fit = (key: 'r' | 'y') => {
      const NT = 180, tab = new Float64Array(NT), at = (t: number) => -Math.PI + (t / NT) * 2 * Math.PI;
      for (let t = 0; t < NT; t++) {
        const a = at(t); let j = fitSam.findIndex(o => o.a > a); if (j < 0) j = 0;
        const o1 = fitSam[j], o0 = fitSam[(j - 1 + fitSam.length) % fitSam.length];
        const span = (((o1.a - o0.a) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) || 1, f = ((((a - o0.a) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / span;
        tab[t] = o0[key] + (o1[key] - o0[key]) * Math.min(1, Math.max(0, f));
      }
      for (let pass = 0; pass < 12; pass++) { const t0 = tab.slice(); for (let t = 0; t < NT; t++) tab[t] = 0.5 * t0[t] + 0.25 * (t0[(t + NT - 1) % NT] + t0[(t + 1) % NT]); }
      return (a: number) => { const x = (((a + Math.PI) / (2 * Math.PI)) % 1 + 1) % 1 * NT, i = Math.floor(x) % NT, f = x - Math.floor(x); return tab[i] + (tab[(i + 1) % NT] - tab[i]) * f; };
    };
    const R = fit('r'), Y = fit('y');
    const neck = (a: number, dr = 0, dy = 0) => new V3(c.x + Math.sin(a) * (R(a) + dr), Y(a) + dy, c.z + Math.cos(a) * (R(a) + dr));
    const radial = (a: number) => new V3(Math.sin(a), 0, Math.cos(a));
    const offSurf = (nr: typeof near) => (v: THREE.Vector3, gap: number) => { const { q, n } = nr(v); const d = v.clone().sub(q).dot(n); if (d < gap) v.addScaledVector(n, gap - d); return v; };
    const shirtLift = offSurf(near), skinOnly = offSurf(skinNear), genLift = genNear ? offSurf(genNear) : null;
    const skinLift = (v: THREE.Vector3, gap: number) => { skinOnly(v, gap); if (genLift) genLift(v, gap); return v; };
    const onShirt = (v: THREE.Vector3, gap: number) => { const { q, n } = near(v); return v.addScaledVector(n, gap - v.clone().sub(q).dot(n)); };
    // from the neckline, `dist` along the shirt surface, outward and down (over the shoulders, down the back)
    const walk = (a: number, dist: number) => {
      const p = onShirt(neck(a, 0.003, -0.002), 0), dir = radial(a).add(new V3(0, -0.8, 0)).normalize();
      for (let left = dist; left > 1e-5; left -= 0.003) {
        const { n } = near(p), d = dir.clone().addScaledVector(n, -dir.dot(n)).normalize();
        onShirt(p.addScaledVector(d, Math.min(0.003, left)), 0);
      }
      return p;
    };
    const COLS = 128, NS = 5, NF = 6, NL = 16, KU = 5;            // columns; stand, fold, leaf rows; the underside runs back to leaf row KU
    const rr = 0.0022, thick = 0.0016;                              // roll radius (the doubled fabric over the fold), leaf thickness at the edge
    const open = 0.012 / R(0);                                      // the collar ends open a small V over the placket
    const A: number[] = [], S: THREE.Vector3[] = [], P: THREE.Vector3[] = [], SH: number[] = [], EW: number[] = [];
    for (let i = 0; i <= COLS; i++) {
      const s = i / COLS, a = open + s * (2 * Math.PI - 2 * open);   // a = 0 at the front, PI at the back
      const endw = Math.max(0, 1 - Math.min(s, 1 - s) / 0.17), fr = Math.max(0, Math.cos(a));
      // stand: 3 cm at the back, a little lower round the front of the neck, down to ~8 mm where the ends meet
      const back = Math.max(0, -Math.cos(a)), sh = 0.024 + 0.008 * back * back - 0.004 * fr - 0.003 * Math.abs(Math.sin(a)) - 0.013 * Math.pow(endw, 1.4);   // ~3.2 cm at the nape, ~2.1 cm at the sides
      A.push(a); EW.push(endw); SH.push(sh);
      S.push(neck(a, -0.004, -0.006));                               // the foot of the stand, tucked into the neckline
      // the top of the stand: hugging the neck 4.5 mm clear of it (the neck narrows above the shirt's opening)
      const G = neck(a, -0.002, sh), { q, n } = skinNear(G), H = q.addScaledVector(n, 0.0045);
      const hug = 1 - endw * endw;
      P.push(new V3(G.x + (H.x - G.x) * hug, G.y, G.z + (H.z - G.z) * hug));
    }
    for (let pass = 0; pass < 4; pass++) {   // a smooth stand line
      const p0 = P.map(v => v.clone());
      for (let i = 1; i < COLS; i++) { P[i].x = 0.5 * p0[i].x + 0.25 * (p0[i - 1].x + p0[i + 1].x); P[i].z = 0.5 * p0[i].z + 0.25 * (p0[i - 1].z + p0[i + 1].z); }
    }
    // keep the stand clear of the neck (and the generated head's neck, which bulges at the back): the outward push
    // each row needs is spread smoothly along the collar (widened, then blurred), so a local bulge lifts the
    // stand in a gentle swell rather than denting it
    const SR = S.map((s0, i) => [...Array(NS).keys()].map(k => s0.clone().lerp(P[i], k / (NS - 1))));
    {
      const out0 = S.map((s0, i) => { const r = radial(A[i]); return r.addScaledVector(P[i].clone().sub(s0).normalize(), -r.dot(P[i].clone().sub(s0).normalize())).normalize(); });
      for (let k = 1; k < NS; k++) {
        let push = SR.map((rw, i) => { const v = rw[k].clone(); skinLift(v, k === NS - 1 ? 0.0035 : 0.003); return Math.max(0, v.sub(rw[k]).dot(out0[i])); });
        const W = 7; push = push.map((_, i) => Math.max(...push.slice(Math.max(0, i - W), i + W + 1)));
        for (let pass = 0; pass < 40; pass++) push = push.map((v, i) => (i && i < COLS ? 0.5 * v + 0.25 * (push[i - 1] + push[i + 1]) : v));
        SR.forEach((rw, i) => rw[k].addScaledVector(out0[i], push[i]));
      }
      SR.forEach((rw, i) => P[i].copy(rw[NS - 1]));
    }
    // each column's frame: up the stand, and out (away from the neck)
    const TU = P.map((p, i) => p.clone().sub(S[i]).normalize());
    const OU = TU.map((t, i) => { const r = radial(A[i]); return r.addScaledVector(t, -r.dot(t)).normalize(); });
    // the leaf's outer edge: ~4.2 cm from the fold all round (so ~1.4 cm onto the shirt beyond the stand's foot);
    // at the front it runs straight from over the shoulder down to the point. The points: ~7.5 cm from the side
    // of the neck to the tip, tips 3.5 cm either side of the centre and 4.7 cm below the neckline's front
    const a1 = 1.15;
    const E = A.map((a, i) => walk(a, Math.max(0.008, 0.042 + 0.004 * Math.max(0, -Math.cos(a)) + 0.002 * Math.abs(Math.sin(a)) - SH[i])));
    for (let pass = 0; pass < 2; pass++) {
      const e0 = E.map(v => v.clone());
      for (let i = 1; i < COLS; i++) onShirt(E[i].copy(e0[i]).multiplyScalar(0.5).addScaledVector(e0[i - 1], 0.25).addScaledVector(e0[i + 1], 0.25), 0);
    }
    for (const sg of [1, -1]) {
      const tip = onShirt(new V3(c.x + sg * 0.035, Y(0) - 0.047, c.z + R(0) + 0.02), 0);
      const base = walk(sg > 0 ? a1 : 2 * Math.PI - a1, Math.max(0.008, 0.046 - 0.03 + 0.005 * Math.cos(a1)));
      for (let i = 0; i <= COLS; i++) {
        const al = sg > 0 ? A[i] : 2 * Math.PI - A[i];
        if (al > a1 || (sg > 0) !== (A[i] < Math.PI)) continue;
        const t = (al - open) / (a1 - open);
        E[i] = onShirt(tip.clone().lerp(base, t), 0);
      }
    }
    // the leaf's outer surface: from the outside of the roll, down over the stand, out onto the shirt to the edge
    const L: THREE.Vector3[][] = [];
    for (let i = 0; i <= COLS; i++) {
      const t = TU[i], o = OU[i], L0 = P[i].clone().addScaledVector(o, 2 * rr);
      const B1 = L0.clone().addScaledVector(t, -SH[i] * 0.55);
      const B2 = neck(A[i], 0.002, 0.003).addScaledVector(o, 2 * rr + 0.003);
      const col: THREE.Vector3[] = [L0];
      for (let k = 1; k <= NL; k++) {
        const u = k / NL, w = 1 - u;
        col.push(L0.clone().multiplyScalar(w * w * w).addScaledVector(B1, 3 * w * w * u).addScaledVector(B2, 3 * w * u * u).addScaledVector(E[i], u * u * u));
      }
      L.push(col);
    }
    // the stand's rows (lifted clear of the neck), and a check that keeps the leaf outside them (the leaf lies on
    // the stand's outside with the doubled fabric between)
    const clearStand = (i: number, v: THREE.Vector3) => {
      const t = v.clone().sub(S[i]).dot(TU[i]), st = SR[i].map(q => { const d = q.clone().sub(S[i]); return [d.dot(TU[i]), d.dot(OU[i])]; });
      if (t < st[0][0] - 0.004 || t > st[NS - 1][0]) return;
      let k = 0; while (k < NS - 2 && t > st[k + 1][0]) k++;
      const f = Math.min(1, Math.max(0, (t - st[k][0]) / (st[k + 1][0] - st[k][0] || 1))), need = st[k][1] + (st[k + 1][1] - st[k][1]) * f + 2.3 * rr;
      const have = v.clone().sub(S[i]).dot(OU[i]); if (have < need) v.addScaledVector(OU[i], need - have);
    };
    const gapAt = (i: number, k: number) => { const u = k / NL; return 0.0018 + 0.0006 * u * u * u + 0.0006 * EW[i] * u * u; };   // the edges, and most the points, lift a hair
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i <= COLS; i++) for (let k = 1; k <= NL; k++) {
        clearStand(i, L[i][k]);
        if (k >= 0.3 * NL) shirtLift(L[i][k], gapAt(i, k));
      }
      if (pass === 2) break;
      const l0 = L.map(cl => cl.map(v => v.clone()));
      for (let i = 1; i < COLS; i++) for (let k = 1; k <= NL; k++) L[i][k].copy(l0[i][k]).multiplyScalar(0.5).addScaledVector(l0[i - 1][k], 0.25).addScaledVector(l0[i + 1][k], 0.25);
      for (let i = 0; i <= COLS; i++) for (let k = 2; k < NL; k++) L[i][k].lerp(l0[i][k - 1].clone().add(l0[i][k + 1]).multiplyScalar(0.5), 0.3);
    }
    // keep the leaf clear of the neck and the body (round the back the neck's base shows through the shirt's notch)
    // in a smooth swell (the push each row needs, widened and blurred along the collar), so it doesn't take the body's lumps
    for (let k = 1; k <= NL; k++) {
      const up = k < NL / 2, dir = L.map((cl, i) => (up ? OU[i] : near(cl[k]).n));
      let push = L.map((cl, i) => Math.max(0, skinLift(cl[k].clone(), up ? 0.008 : 0.0045).sub(cl[k]).dot(dir[i])));
      const W = 6; push = push.map((_, i) => Math.max(...push.slice(Math.max(0, i - W), i + W + 1)));
      for (let pass = 0; pass < 30; pass++) push = push.map((v, i) => (i && i < COLS ? 0.5 * v + 0.25 * (push[i - 1] + push[i + 1]) : v));
      L.forEach((cl, i) => cl[k].addScaledVector(dir[i], push[i]));
    }
    // the leaf's normals (out of the body), for its thickness
    const LN = L.map((cl, i) => cl.map((v, k) => {
      const ds = L[Math.min(COLS, i + 1)][k].clone().sub(L[Math.max(0, i - 1)][k]), du = cl[Math.min(NL, k + 1)].clone().sub(cl[Math.max(0, k - 1)]);
      return du.cross(ds).normalize();
    }));
    { const mid = COLS >> 1; if (LN[mid][NL].dot(near(L[mid][NL]).n) < 0) LN.forEach(cl => cl.forEach(n => n.negate())); }
    // the cross-section, in order: stand (inner face) → roll → leaf → turned edge → underside back up the leaf
    const vs: number[] = [];
    for (let k = 0; k < NS; k++) vs.push(0.18 * k / (NS - 1));
    for (let k = 1; k <= NF; k++) vs.push(0.18 + 0.08 * k / NF);
    for (let k = 1; k <= NL; k++) vs.push(0.26 + 0.54 * k / NL);
    vs.push(0.815, 0.835);
    for (let k = NL; k >= KU; k--) vs.push(0.85 + 0.15 * (NL - k) / (NL - KU));
    const ROWS = vs.length, sec: THREE.Vector3[][] = [];
    for (let i = 0; i <= COLS; i++) {
      const t = TU[i], o = OU[i], row: THREE.Vector3[] = [];
      for (let k = 0; k < NS; k++) row.push(SR[i][k].clone());
      for (let k = 1; k <= NF; k++) { const ph = Math.PI * k / NF; row.push(P[i].clone().addScaledVector(o, rr * (1 - Math.cos(ph))).addScaledVector(t, rr * Math.sin(ph))); }
      row[NS + NF - 1] = L[i][0].clone();
      for (let k = 1; k <= NL; k++) row.push(L[i][k].clone());
      const e = L[i][NL], n = LN[i][NL], d = e.clone().sub(L[i][NL - 1]).normalize();
      for (const ph of [Math.PI / 3, 2 * Math.PI / 3]) row.push(e.clone().addScaledVector(n, -thick / 2 + (thick / 2) * Math.cos(ph)).addScaledVector(d, (thick / 2) * Math.sin(ph)));
      for (let k = NL; k >= KU; k--) row.push(L[i][k].clone().addScaledVector(LN[i][k], -thick * (0.4 + 0.6 * Math.min(1, (k - KU) / 4))));
      sec.push(row);
    }
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let i = 0; i <= COLS; i++) for (let r = 0; r < ROWS; r++) { const v = sec[i][r]; pos.push(v.x, v.y, v.z); uv.push(i / COLS, vs[r]); }
    for (let i = 0; i < COLS; i++) for (let r = 0; r < ROWS - 1; r++) { const a = i * ROWS + r, b = a + ROWS; idx.push(a, a + 1, b, a + 1, b + 1, b); }   // wound so the outer faces are front faces
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
    // end caps: close the cross-section at the two front ends (the points' front edges show their thickness);
    // their own vertices, so their normals don't bend the leaf's
    const capP: number[] = [], capU: number[] = [], capI: number[] = [];
    for (const i of [0, COLS]) {
      const loop = sec[i], o0 = loop[0], ex = loop[NS + NF - 1 + NL].clone().sub(o0).normalize(), ey = loop[NS - 1].clone().sub(o0);
      ey.addScaledVector(ex, -ey.dot(ex)).normalize();
      const tri = THREE.ShapeUtils.triangulateShape(loop.map(v => new THREE.Vector2(v.clone().sub(o0).dot(ex), v.clone().sub(o0).dot(ey))), []);
      const base = capP.length / 3;
      loop.forEach((v, r) => { capP.push(v.x, v.y, v.z); capU.push(0.5, vs[r]); });
      for (const [x, y, z] of tri) capI.push(base + x, base + y, base + z);
    }
    const capG = new THREE.BufferGeometry(); capG.setAttribute('position', new THREE.Float32BufferAttribute(capP, 3)); capG.setAttribute('uv', new THREE.Float32BufferAttribute(capU, 2)); capG.setIndex(capI); capG.computeVertexNormals();
    // the collar's colour down the cross-section, painted (not lit): a dark neck opening at the stand's foot, the
    // inside of the stand in its own shade, the roll and the outer edge a touch lighter, a dark underside
    const shirtC = new THREE.Color(O.shirt);
    const ramp = (stops: [number, number][], h: number) => canvasTex(4, h, gx => {
      for (let y = 0; y < h; y++) {
        const v = 1 - (y + 0.5) / h; let j = 0; while (j < stops.length - 2 && v > stops[j + 1][0]) j++;
        const [v0, m0] = stops[j], [v1, m1] = stops[j + 1], f = Math.min(1, Math.max(0, (v - v0) / (v1 - v0 || 1)));
        const m = m0 + (m1 - m0) * f * f * (3 - 2 * f), cc = shirtC.clone().multiplyScalar(m);
        gx.fillStyle = '#' + cc.getHexString(); gx.fillRect(0, y, 4, 1);
      }
    }, true, 1);
    const collarTex = ramp([[0, 0.22], [0.05, 0.62], [0.16, 0.86], [0.2, 0.97], [0.27, 1.0], [0.7, 1.02], [0.79, 1.1], [0.835, 0.85], [0.86, 0.5], [1, 0.42]], 512);
    collarTex.wrapS = collarTex.wrapT = THREE.ClampToEdgeWrapping; collarTex.repeat.set(1, 1);
    const collarMat = new THREE.MeshPhysicalMaterial({ map: collarTex, roughness: 0.9, sheen: 0.2, sheenColor: new THREE.Color('#ffffff').lerp(shirtC, 0.6), sheenRoughness: 0.6, side: THREE.DoubleSide });
    const bits: THREE.Mesh[] = [new THREE.Mesh(g, collarMat), new THREE.Mesh(capG, collarMat)];   // collar, its shadow line, placket and buttons: baked into one mesh below
    // the shadow line: a thin skirt from under every free edge down onto the shirt, dark at the edge fading out
    {
      const sp: number[] = [], su: number[] = [], si: number[] = [];
      const strip = (tops: THREE.Vector3[], feet: THREE.Vector3[]) => {
        const b = sp.length / 3;
        tops.forEach((t, j) => { sp.push(t.x, t.y, t.z, feet[j].x, feet[j].y, feet[j].z); su.push(j / (tops.length - 1), 1, j / (tops.length - 1), 0); });
        for (let j = 0; j < tops.length - 1; j++) { const q = b + j * 2; si.push(q, q + 2, q + 1, q + 1, q + 2, q + 3); }
      };
      const foot = (v: THREE.Vector3, away: THREE.Vector3) => onShirt(v.clone().addScaledVector(away, 0.0016), 0.0006);
      const under = (i: number, k: number) => L[i][k].clone().addScaledVector(LN[i][k], -thick * 0.9);
      // along the outer edge, the whole way round
      strip(L.map((_, i) => under(i, NL)), L.map((cl, i) => foot(cl[NL], cl[NL].clone().sub(cl[NL - 1]).normalize())));
      // along each point's front edge, from the neck down to the tip
      for (const [i, j] of [[0, 1], [COLS, COLS - 1]]) {
        const ks = [...Array(NL - KU + 1).keys()].map(k => k + KU);
        strip(ks.map(k => under(i, k)), ks.map(k => foot(L[i][k], L[i][k].clone().sub(L[j][k]).normalize())));
      }
      const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3)); sg.setAttribute('uv', new THREE.Float32BufferAttribute(su, 2)); sg.setIndex(si); sg.computeVertexNormals();
      const shadowTex = ramp([[0, 0.5], [0.5, 0.35], [1, 0.22]], 32);
      shadowTex.wrapS = shadowTex.wrapT = THREE.ClampToEdgeWrapping; shadowTex.repeat.set(1, 1);
      bits.push(new THREE.Mesh(sg, new THREE.MeshPhysicalMaterial({ map: shadowTex })));
    }
    // placket: a stitched strip laid on the shirt from the neckline down, with two white four-hole buttons
    const top = neck(0);
    const plkTex = canvasTex(64, 256, g => { g.fillStyle = '#fff'; g.fillRect(0, 0, 64, 256); g.strokeStyle = 'rgba(0,0,0,.32)'; g.setLineDash([5, 3]); g.lineWidth = 1.6; g.strokeRect(4, -10, 56, 261); g.beginPath(); g.moveTo(4, 236); g.lineTo(60, 236); g.stroke(); }, true, 1);   // edge stitching, a stitched box at the foot
    plkTex.wrapS = plkTex.wrapT = THREE.ClampToEdgeWrapping; plkTex.repeat.set(1, 1);
    const plkMat = new THREE.MeshPhysicalMaterial({ color: O.shirt, map: plkTex, roughness: 0.84, sheen: 0.35, sheenColor: collarMat.sheenColor, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const pg = new THREE.PlaneGeometry(0.033, 0.12, 4, 16);
    const pa = pg.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pa.count; i++) {
      const v = new THREE.Vector3(top.x + pa.getX(i), top.y - 0.06 + pa.getY(i), top.z + 0.02);
      const { q, n } = near(v); v.sub(n.clone().multiplyScalar(v.clone().sub(q).dot(n) - 0.0012));   // onto the surface, 1.2 mm proud
      pa.setXYZ(i, v.x, v.y, v.z);
    }
    pg.computeVertexNormals();
    bits.push(new THREE.Mesh(pg, plkMat));
    const btnTex = canvasTex(64, 64, g => { g.fillStyle = '#f4f2ec'; g.beginPath(); g.arc(32, 32, 30, 0, 7); g.fill(); g.strokeStyle = 'rgba(0,0,0,.18)'; g.lineWidth = 3; g.beginPath(); g.arc(32, 32, 24, 0, 7); g.stroke(); g.fillStyle = 'rgba(0,0,0,.45)'; for (const [x, y] of [[26, 26], [38, 26], [26, 38], [38, 38]]) { g.beginPath(); g.arc(x, y, 3, 0, 7); g.fill(); } }, true, 1);
    btnTex.wrapS = btnTex.wrapT = THREE.ClampToEdgeWrapping; btnTex.repeat.set(1, 1);
    const rimMat = new THREE.MeshStandardMaterial({ color: '#e8e5dc', roughness: 0.35 }), faceMat = new THREE.MeshStandardMaterial({ map: btnTex, roughness: 0.3 });
    for (const dy of [-0.02, -0.072]) {   // the top one just under the collar points, the second ~5 cm lower
      const { q, n } = near(new THREE.Vector3(top.x, top.y + dy, top.z + 0.02));
      const xf = new THREE.Matrix4().compose(q.clone().addScaledVector(n, 0.0028), new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n), new THREE.Vector3(1, 1, 1));
      bits.push(new THREE.Mesh(new THREE.CylinderGeometry(0.0056, 0.0056, 0.0024, 20, 1, true).applyMatrix4(xf), rimMat));
      bits.push(new THREE.Mesh(new THREE.CircleGeometry(0.0056, 20).rotateX(-Math.PI / 2).translate(0, 0.0012, 0).applyMatrix4(xf), faceMat));
    }
    // one skinned mesh, one atlas: one draw call; too small to need a shadow of its own
    const baked = bakeAtlas(bits, 512);
    const bitsMat = new THREE.MeshPhysicalMaterial({ map: baked.texture, roughness: 0.95, specularIntensity: 0.7, envMapIntensity: 0.35, sheen: 0.18, sheenColor: collarMat.sheenColor, sheenRoughness: 0.8, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const cm = skinned(baked.geometry, bitsMat); cm.name = 'collar'; cm.castShadow = false;
    // the collar rides on the shoulders more than the shirt's neckline does (40% of the neck's weight), so the
    // lead point isn't dragged round by the chin at the top
    // and its weights are blurred over ~1.5 cm, so neighbouring vertices that took their weights from different
    // shirt vertices (e.g. either side of the centre back) don't pull apart into dents when the shoulders move
    { const ni = M.bones.indexOf('neck_01'), si = cm.geometry.getAttribute('skinIndex') as THREE.BufferAttribute, sw = cm.geometry.getAttribute('skinWeight') as THREE.BufferAttribute;
      const pa = cm.geometry.getAttribute('position') as THREE.BufferAttribute, n = pa.count, Hc = 0.015, grid = new Map<number, number[]>();
      const key = (x: number, y: number, z: number) => ((Math.floor(x / Hc) + 512) * 1024 + Math.floor(y / Hc) + 512) * 1024 + Math.floor(z / Hc) + 512;
      for (let v = 0; v < n; v++) { const k = key(pa.getX(v), pa.getY(v), pa.getZ(v)); const l = grid.get(k); if (l) l.push(v); else grid.set(k, [v]); }
      const outI = new Uint16Array(n * 4), outW = new Float32Array(n * 4);
      for (let v = 0; v < n; v++) {
        const x = pa.getX(v), y = pa.getY(v), z = pa.getZ(v), acc = new Map<number, number>();
        const cx = Math.floor(x / Hc), cy = Math.floor(y / Hc), cz = Math.floor(z / Hc);
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c2 = -1; c2 <= 1; c2++) {
          const l = grid.get(((cx + a + 512) * 1024 + cy + b + 512) * 1024 + cz + c2 + 512); if (!l) continue;
          for (const u of l) {
            const d2 = (pa.getX(u) - x) ** 2 + (pa.getY(u) - y) ** 2 + (pa.getZ(u) - z) ** 2; if (d2 > Hc * Hc) continue;
            const g = Math.exp(-d2 / (0.5 * Hc * Hc));
            for (let k = 0; k < 4; k++) { const bi = si.getComponent(u, k), w = sw.getComponent(u, k) * g * (bi === ni ? 0.4 : 1); if (w > 0) acc.set(bi, (acc.get(bi) ?? 0) + w); }
          }
        }
        const top = [...acc].sort((p1, p2) => p2[1] - p1[1]).slice(0, 4), tot = top.reduce((t, e) => t + e[1], 0) || 1;
        top.forEach(([bi, w], k) => { outI[v * 4 + k] = bi; outW[v * 4 + k] = w / tot; });
      }
      // the collar proper (above the neckline: stand, roll, the leaf round the neck) turns partly with the neck, so
      // it keeps its shape and stays clear of the chin when the head turns and tilts; the points and the placket
      // below stay with the chest
      for (let v = 0; v < n; v++) {
        const x = pa.getX(v), y = pa.getY(v), z = pa.getZ(v), a = Math.atan2(x - c.x, z - c.z);
        const t = THREE.MathUtils.smoothstep(y - Y(a), -0.004, 0.02), sN = 0.5 * t;
        if (sN <= 0) continue;
        const ws: [number, number][] = [];
        for (let k = 0; k < 4; k++) if (outI[v * 4 + k] !== ni && outW[v * 4 + k] > 0) ws.push([outI[v * 4 + k], outW[v * 4 + k]]);
        ws.sort((p1, p2) => p2[1] - p1[1]); ws.length = Math.min(3, ws.length);
        const rest = ws.reduce((q, e) => q + e[1], 0) || 1;
        for (let k = 0; k < 4; k++) { outI[v * 4 + k] = 0; outW[v * 4 + k] = 0; }
        ws.forEach(([bi, w], k) => { outI[v * 4 + k] = bi; outW[v * 4 + k] = w / rest * (1 - sN); });
        outI[v * 4 + 3] = ni; outW[v * 4 + 3] = ws.length ? sN : 1;
      }
      cm.geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(outI, 4)); cm.geometry.setAttribute('skinWeight', new THREE.BufferAttribute(outW, 4));
    }
    bits.forEach(b => b.geometry.dispose());
  }
  // belt (tucked-in shirt): a 3.5 cm mid-brown pebbled leather belt laid on the shorts' waistband and skinned
  // like it: stitched edges, a square brushed-silver buckle with a single prong at the front, the tip through a
  // leather keeper with three punched holes showing; khaki belt loops either side of the fly, at the sides and
  // either side of the centre back; the back pockets' buttons. One skinned mesh, one atlas: one draw call.
  if (!O.untucked && pantsMesh) {
    const B = M.belt, H = 0.035, SEG = 128;
    const axis = (q: THREE.Vector3) => new THREE.Vector3(B.cx, q.y, B.cz);
    const { near, skinned } = surfaceOf(pantsMesh, (_x, y) => Math.abs(y - B.y) < 0.09, axis);
    const shirtNear = surfaceOf(shirtMesh!, (_x, y) => Math.abs(y - B.y) < 0.06, axis).near;
    const brown = '#74412a';
    const leatherCanvas = (holes: boolean) => canvasTex(holes ? 512 : 2048, 64, g => {
      const W = holes ? 512 : 2048;
      g.fillStyle = brown; g.fillRect(0, 0, W, 64);
      for (let i = 0; i < W * 4; i++) { const x = rand() * W, y = rand() * 64, r = 0.9 + rand() * 1.1; g.fillStyle = rand() < 0.5 ? 'rgba(0,0,0,.045)' : 'rgba(255,220,190,.035)'; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); }   // a fine, even pebble
      g.fillStyle = 'rgba(40,18,8,.55)'; g.fillRect(0, 0, W, 3); g.fillRect(0, 61, W, 3);           // darker burnished edges
      g.strokeStyle = 'rgba(205,170,130,.75)'; g.lineWidth = 1.6; g.setLineDash([6, 4]);
      for (const y of [8, 56]) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
      g.setLineDash([]);
      if (holes) for (let k = 0; k < 3; k++) { const x = 150 + k * 95; g.fillStyle = '#1c0f08'; g.beginPath(); g.ellipse(x, 32, 7, 7, 0, 0, 7); g.fill(); g.strokeStyle = 'rgba(0,0,0,.4)'; g.lineWidth = 2; g.beginPath(); g.arc(x, 32, 10, 0, 7); g.stroke(); }
    }, true, 1);
    const bandTex = leatherCanvas(false), tipTex = leatherCanvas(true);
    // the belt's centre line: the waistband surface round the waist, smoothed, 2.5 mm proud
    const ring: { p: THREE.Vector3; n: THREE.Vector3 }[] = [];
    for (let i = 0; i < SEG; i++) {
      const a = (i / SEG) * Math.PI * 2, guess = new THREE.Vector3(B.cx + Math.sin(a) * (B.rx + 0.03), B.y, B.cz + Math.cos(a) * (B.rz + 0.03));
      const { q, n } = near(guess); n.y = 0; n.normalize();
      // the belt rides outside both the waistband and the shirt just above it (so the blouse never cuts through it)
      let rad = Math.hypot(q.x - B.cx, q.z - B.cz);
      for (const dy of [0, H / 2 + 0.002]) { const s2 = shirtNear(new THREE.Vector3(guess.x, B.y + dy, guess.z)); rad = Math.max(rad, Math.hypot(s2.q.x - B.cx, s2.q.z - B.cz)); }
      const dir = new THREE.Vector3(q.x - B.cx, 0, q.z - B.cz).normalize();
      ring.push({ p: new THREE.Vector3(B.cx, B.y, B.cz).addScaledVector(dir, rad + 0.0035), n });
    }
    for (let pass = 0; pass < 3; pass++) { const r0 = ring.map(r => r.p.clone()); ring.forEach((r, i) => r.p.copy(r0[(i + SEG - 1) % SEG]).add(r0[(i + 1) % SEG]).multiplyScalar(0.25).addScaledVector(r0[i], 0.5)); }
    const at = (a: number) => {   // interpolated point + outward normal round the belt at angle a (0 = front)
      const t = ((((a / (Math.PI * 2)) % 1) + 1) % 1) * SEG, i = Math.floor(t) % SEG, f = t - Math.floor(t), j = (i + 1) % SEG;
      return { p: ring[i].p.clone().lerp(ring[j].p, f), n: ring[i].n.clone().lerp(ring[j].n, f).normalize() };
    };
    const strip = (a0: number, a1: number, h: number, off: number, n: number, taperEnd = false) => {   // a band following the belt
      const pos: number[] = [], uv: number[] = [], idx: number[] = [];
      for (let k = 0; k <= n; k++) {
        const t = k / n, a = a0 + (a1 - a0) * t, { p, n: nn } = at(a);
        const hh = taperEnd && t > 0.85 ? h * (1 - (t - 0.85) / 0.15 * 0.55) : h;   // the tip comes to a soft point
        const q = p.clone().addScaledVector(nn, off);
        pos.push(q.x, q.y - hh / 2, q.z, q.x, q.y + hh / 2, q.z); uv.push(t, 0, t, 1);
      }
      for (let k = 0; k < n; k++) { const b = k * 2; idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
      return g;
    };
    const mat = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(o);
    const parts: THREE.Mesh[] = [];
    const side = p.handed === 'left' ? -1 : 1;                         // the tip runs to the wearer's left
    parts.push(new THREE.Mesh(strip(0, Math.PI * 2, H, 0, SEG), mat({ map: bandTex })));
    // top edge of the leather (its thickness), seen from above
    { const g = strip(0, Math.PI * 2, 0.0001, -0.0015, SEG); const pa = g.getAttribute('position') as THREE.BufferAttribute;
      for (let k = 0; k < pa.count; k += 2) { const { n } = at((k / 2 / SEG) * Math.PI * 2); pa.setXYZ(k, pa.getX(k) - n.x * 0.0015, pa.getY(k) + H / 2, pa.getZ(k) - n.z * 0.0015); pa.setXYZ(k + 1, pa.getX(k + 1) + n.x * 0.0015, pa.getY(k + 1) + H / 2, pa.getZ(k + 1) + n.z * 0.0015); }
      g.computeVertexNormals(); parts.push(new THREE.Mesh(g, mat({ color: '#4a2716' }))); }
    // the tip: from the buckle over the belt, through the keeper, three holes showing
    parts.push(new THREE.Mesh(strip(side * 0.02, side * 0.36, H * 0.98, 0.0028, 24, true), mat({ map: tipTex })));
    // keeper loop just past the buckle
    { const { p: kp, n: kn } = at(side * 0.15); const g = new THREE.BoxGeometry(0.011, H + 0.006, 0.0075);
      g.applyMatrix4(new THREE.Matrix4().compose(kp.clone().addScaledVector(kn, 0.0035), new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), kn), new THREE.Vector3(1, 1, 1)));
      parts.push(new THREE.Mesh(g, mat({ color: '#673722' }))); }
    // buckle: a square brushed-silver frame with a single prong
    { const { p: bp, n: bn } = at(0); const fr = new THREE.Matrix4().compose(bp.clone().addScaledVector(bn, 0.0055), new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), bn), new THREE.Vector3(1, 1, 1));
      const bw = 0.046, bh = 0.044, t = 0.0055, silver = mat({ color: '#cfd2d6' });
      for (const [x, y, w, h] of [[0, bh / 2 - t / 2, bw, t], [0, -bh / 2 + t / 2, bw, t], [-bw / 2 + t / 2, 0, t, bh], [bw / 2 - t / 2, 0, t, bh], [-0.004, 0, bw * 0.55, 0.0025]] as number[][]) {
        const g = new THREE.BoxGeometry(w, h, 0.006); g.translate(x, y, 0.001); g.applyMatrix4(fr); parts.push(new THREE.Mesh(g, silver));
      } }
    // belt loops: khaki strips over the belt
    const khaki = mat({ color: O.pants });
    const r0 = Math.hypot(at(0).p.x - B.cx, at(0).p.z - B.cz);
    for (const a of [Math.asin(Math.min(0.9, 0.07 / r0)), -Math.asin(Math.min(0.9, 0.07 / r0)), 1.62, -1.62, 2.72, -2.72]) {
      const { p: lp, n: ln } = at(a), pos: number[] = [], idx: number[] = [];
      const prof: [number, number][] = [[-H / 2 - 0.008, 0.0005], [-H / 2 - 0.001, 0.0045], [H / 2 + 0.001, 0.0045], [H / 2 + 0.006, 0.0005]];
      const tang = new THREE.Vector3(0, 1, 0).cross(ln).normalize();
      for (const [y, o] of prof) for (const s2 of [-1, 1]) { const q = lp.clone().addScaledVector(ln, o).addScaledVector(tang, s2 * 0.006); pos.push(q.x, q.y + y, q.z); }
      for (let k = 0; k < prof.length - 1; k++) { const b = k * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
      parts.push(new THREE.Mesh(g, khaki));
    }
    // back pocket buttons (the welts themselves are in the chino shader)
    for (const sx of [-1, 1]) {
      const { q, n } = near(new THREE.Vector3(B.cx + sx * 0.085, B.y - 0.088, B.cz - B.rz - 0.03));
      const g = new THREE.CylinderGeometry(0.0045, 0.0045, 0.002, 12).applyMatrix4(new THREE.Matrix4().compose(q.clone().addScaledVector(n, 0.0015), new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n), new THREE.Vector3(1, 1, 1)));
      parts.push(new THREE.Mesh(g, mat({ color: '#9a7f55' })));
    }
    const baked = bakeAtlas(parts, 2048);
    baked.texture.anisotropy = 8;
    const beltMesh = skinned(baked.geometry, new THREE.MeshPhysicalMaterial({ map: baked.texture, bumpMap: baked.texture, bumpScale: 0.25, roughness: 0.45, clearcoat: 0.45, clearcoatRoughness: 0.3, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    beltMesh.name = 'belt'; beltMesh.castShadow = false;
    parts.forEach(m => m.geometry.dispose());
  }
  // shoes: classic white longwing golf shoes (FootJoy Premiere style). A sleek last with an elongated, rounded
  // toe and toe spring, a low-cut collar round the ankle, a lace panel and tongue; smooth white leather with a
  // wingtip toe cap, long wings back to the heel, brogue punching and stitching; a stacked brown sole with a welt.
  // Upper UVs: u = a / PI round the shoe (0 = outer side at the sole, 0.5 = over the top, 1 = inner side), v = heel → toe.
  const smooth = (keys: [number, number][]) => (t: number) => {          // monotone-ish smooth curve through keys
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 0; i < keys.length - 1; i++) { const [t0, y0] = keys[i], [t1, y1] = keys[i + 1]; if (t <= t1) { const f = (t - t0) / (t1 - t0); return y0 + (y1 - y0) * f * f * (3 - 2 * f); } }
    return keys[keys.length - 1][1];
  };
  const widthK = smooth([[0.12, 0.7], [0.24, 0.72], [0.4, 0.66], [0.56, 0.86], [0.7, 1.0], [0.76, 1.0]]);
  const plan = (t: number) => {                                          // half-width (relative) of the last in plan
    if (t < 0.12) return 0.7 * Math.sqrt(Math.max(0, 1 - ((0.12 - t) / 0.12) ** 2));          // rounded heel
    if (t > 0.74) { const k = (t - 0.74) / 0.26; return Math.pow(Math.max(0, 1 - Math.pow(k, 2.1)), 1 / 2.1) * (1 - 0.3 * k); }  // long, sleek rounded toe
    return widthK(t);
  };
  const hRel = smooth([[0, 0.06], [0.08, 0.058], [0.28, 0.041], [0.42, 0.058], [0.5, 0.074], [0.6, 0.064], [0.7, 0.049], [0.8, 0.034], [0.88, 0.025], [0.94, 0.017], [0.98, 0.009], [1, 0.003]]);
  // cross-section fullness: square-shouldered round the heel and quarters, a rounder, lower crown down the vamp to the toe
  const crown = (t: number) => { const k = Math.min(1, Math.max(0, (t - 0.55) / 0.3)); return 0.8 + 0.5 * k * k * (3 - 2 * k); };
  const spring = (t: number) => (t > 0.68 ? ((t - 0.68) / 0.32) ** 2 * 0.022 : 0);
  const SOLE_TOP = 0.016;
  const heelLift = smooth([[0.22, 0.008], [0.42, 0.0]]);            // a low stacked heel
  const T0 = 0.045, T1 = 0.5;                                            // the ankle opening runs from T0 back... to T1 (the throat)
  const xOpen = (t: number, W: number) => { const k = (t - (T0 + T1) / 2) / ((T1 - T0) / 2); return Math.abs(k) >= 1 ? 0 : Math.min(0.9 * W, 0.036 * Math.sqrt(1 - k * k)); };
  const shoeDims = (f: { heelZ: number; toeZ: number; halfW: number }) => ({ len: f.toeZ - f.heelZ + 0.02, z0: f.heelZ - 0.012, hw: f.halfW + 0.012 });
  // one half of a cross-section: angle range and the arch height for that half
  const half = (t: number, W: number, outer: boolean) => {
    const xo = xOpen(t, W);
    const aEnd = xo > 0 ? Math.acos(Math.min(1, xo / Math.max(W, 1e-5))) : Math.PI / 2;
    const top = hRel(t) / Math.pow(Math.max(Math.sin(aEnd), 1e-3), 0.8);
    return { aEnd: outer ? aEnd : Math.PI - aEnd, top };
  };
  const NT = 46, HJ = 14;
  const tAt = (k: number) => 0.5 - 0.5 * Math.cos(Math.PI * k / NT);   // denser at heel and toe
  // the topline (edge of the ankle opening) in u, for drawing its stitching
  const d0 = shoeDims(M.feet.l);
  const shoeTex = canvasTex(1024, 2048, g => {
    const W = 1024, H = 2048, X = (u: number) => u * W, Yv = (v: number) => (1 - v) * H;
    g.fillStyle = '#e4e3de'; g.fillRect(0, 0, W, H);
    // pebbled leather: small soft grains, each a light top and a darker edge (also drives the bump map)
    for (let i = 0; i < 90000; i++) { const x = rand() * W, y = rand() * H, r = 2 + rand() * 2.5; g.fillStyle = 'rgba(0,0,0,.055)'; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); g.fillStyle = 'rgba(255,255,255,.5)'; g.beginPath(); g.arc(x - r * 0.25, y - r * 0.25, r * 0.6, 0, 7); g.fill(); }
    // and a faint, fine grain and a soft sheen variation
    for (let i = 0; i < 60000; i++) { const x = rand() * W, y = rand() * H; g.fillStyle = rand() < 0.5 ? 'rgba(0,0,0,.018)' : 'rgba(255,255,255,.35)'; g.fillRect(x, y, 1 + rand() * 2, 1 + rand() * 1.5); }
    for (let i = 0; i < 400; i++) { const x = rand() * W, y = rand() * H, r = 20 + rand() * 60; const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(0,0,0,.012)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r); }
    const curve = (pts: [number, number][], n = 120) => {                // Catmull-Rom through (u, v) points → canvas points
      const out: [number, number][] = [];
      for (let i = 0; i < pts.length - 1; i++) for (let k = 0; k < n / (pts.length - 1); k++) {
        const f = k / (n / (pts.length - 1)), p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
        const cr = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * f + (2 * a - 5 * b + 4 * c - d) * f * f + (-a + 3 * b - 3 * c + d) * f * f * f);
        out.push([X(cr(p0[0], p1[0], p2[0], p3[0])), Yv(cr(p0[1], p1[1], p2[1], p3[1]))]);
      }
      const l = pts[pts.length - 1]; out.push([X(l[0]), Yv(l[1])]); return out;
    };
    const offset = (c: [number, number][], d: number) => c.map(([x, y], i) => { const a = c[Math.max(0, i - 1)], b = c[Math.min(c.length - 1, i + 1)]; let nx = -(b[1] - a[1]), ny = b[0] - a[0]; const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l; return [x + nx * d, y + ny * d] as [number, number]; });
    const line = (c: [number, number][], style: string, w: number, dash: number[] = []) => { g.strokeStyle = style; g.lineWidth = w; g.setLineDash(dash); g.beginPath(); c.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke(); g.setLineDash([]); };
    const holes = (c: [number, number][], step: number, r: number) => {
      let acc = 0;
      for (let i = 1; i < c.length; i++) {
        const [x0, y0] = c[i - 1], [x1, y1] = c[i], L = Math.hypot(x1 - x0, y1 - y0);
        while (acc <= L) { const f = acc / L, x = x0 + (x1 - x0) * f, y = y0 + (y1 - y0) * f; g.fillStyle = '#3a3632'; g.beginPath(); g.moveTo(x, y - r * 1.15); g.lineTo(x + r, y); g.lineTo(x, y + r * 1.15); g.lineTo(x - r, y); g.closePath(); g.fill(); acc += step; }
        acc -= L;
      }
    };
    // a seam: overlapping edge (soft shadow line), stitching beside it, and a row of brogue holes (punched with a
    // finer row beside the big one where `fancy`). side = which side of the edge the overlapping piece lies
    const seam = (pts: [number, number][], side = 1, punch = true, fancy = false) => {
      const c = curve(pts);
      line(offset(c, -side * 5), 'rgba(0,0,0,.2)', 11);
      line(c, 'rgba(55,50,44,.85)', 4);
      line(offset(c, side * 10), 'rgba(85,78,70,.75)', 3, [9, 6]);
      line(offset(c, side * 44), 'rgba(85,78,70,.6)', 3, [9, 6]);
      if (punch) { holes(offset(c, side * 23), 24, 9); if (fancy) holes(offset(c, side * 38), 16, 5); }
    };
    for (const m of [1, -1]) {
      const U = (u: number) => (m > 0 ? u : 1 - u);
      // toe cap: from the top centre it swings forward and out, then down the side to the wing tip
      seam([[0.5, 0.715], [U(0.42), 0.745], [U(0.33), 0.77], [U(0.24), 0.765], [U(0.17), 0.73], [U(0.12), 0.69]], m, true, true);
      // the long wing: from the wing tip right back along the side, low, to the heel
      seam([[U(0.12), 0.69], [U(0.1), 0.6], [U(0.095), 0.48], [U(0.11), 0.35], [U(0.16), 0.2], [U(0.22), 0.08], [U(0.26), 0.0]], -m, true, true);   // low across the midfoot, sweeping up to the heel
      // upper edge of the wing: from the wing tip up and back, then along under the collar to the heel
      seam([[U(0.12), 0.69], [U(0.2), 0.64], [U(0.27), 0.57], [U(0.3), 0.48], [U(0.31), 0.36], [U(0.33), 0.22], [U(0.36), 0.1], [U(0.38), 0.0]], m, true, true);
      // lace panel (eyestay): its outline round the throat, and five eyelets
      seam([[U(0.37), 0.47], [U(0.385), 0.56], [U(0.42), 0.635], [U(0.465), 0.68], [0.5, 0.692]], -m, true, false);   // a slim, curved lace panel
      for (let i = 0; i < 5; i++) { const v = 0.515 + i * 0.037, u = U(0.455 - i * 0.003); g.fillStyle = 'rgba(40,36,32,.9)'; g.beginPath(); g.arc(X(u), Yv(v), 5, 0, 7); g.fill(); g.strokeStyle = 'rgba(0,0,0,.25)'; g.lineWidth = 2; g.beginPath(); g.arc(X(u), Yv(v), 8, 0, 7); g.stroke(); }
      // stitching along the collar (topline)
      const tl: [number, number][] = [];
      for (let k = 0; k <= 40; k++) { const t = T0 + (T1 - T0) * (k / 40), Wt = plan(t) * d0.hw, xo = xOpen(t, Wt); const a = xo > 0 ? Math.acos(Math.min(1, xo / Wt)) : Math.PI / 2; tl.push([U(a / Math.PI - 0.022), t]); }
      line(curve(tl, 80), 'rgba(110,104,96,.55)', 1.6, [6, 5]);
    }
    // heel counter: a curved seam round the back, and a back-stay strip up the centre of the heel
    seam([[0.15, 0.0], [0.2, 0.05], [0.3, 0.1], [0.4, 0.12], [0.5, 0.125], [0.6, 0.12], [0.7, 0.1], [0.8, 0.05], [0.85, 0.0]], 1, false);
    // a small plain metal badge on the outer side
    g.fillStyle = '#b9b3a6'; g.fillRect(X(0.21), Yv(0.47), 22, 26); g.fillStyle = 'rgba(255,255,255,.5)'; g.fillRect(X(0.21) + 3, Yv(0.47) + 3, 16, 4);
  }, true, 1);
  shoeTex.wrapS = shoeTex.wrapT = THREE.ClampToEdgeWrapping; shoeTex.repeat.set(1, 1); shoeTex.anisotropy = 8;
  const upperMat = new THREE.MeshPhysicalMaterial({ map: shoeTex, bumpMap: shoeTex, bumpScale: 0.8, roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.35, side: THREE.DoubleSide });
  // stacked leather sole: a strip texture round the sole edge (u = along the edge, v = bottom → top)
  const soleTex = canvasTex(2048, 64, g => {
    g.fillStyle = '#a0703f'; g.fillRect(0, 0, 2048, 64);   // tan stacked leather
    for (let y = 8; y < 56; y += 3 + Math.floor(rand() * 3)) { g.fillStyle = rand() < 0.5 ? 'rgba(60,32,14,.35)' : 'rgba(200,150,100,.25)'; g.fillRect(0, y, 2048, 1 + rand() * 1.5); }
    for (let i = 0; i < 3000; i++) { g.fillStyle = 'rgba(40,20,8,.12)'; g.fillRect(rand() * 2048, 8 + rand() * 48, 6 + rand() * 30, 1); }
    g.fillStyle = '#2e2018'; g.fillRect(0, 0, 2048, 9);          // the welt (top of the sole), dark brown
    g.strokeStyle = 'rgba(210,190,160,.7)'; g.setLineDash([7, 5]); g.lineWidth = 1.5; g.beginPath(); g.moveTo(0, 5); g.lineTo(2048, 5); g.stroke(); g.setLineDash([]);
    g.fillStyle = '#231a14'; g.fillRect(0, 58, 2048, 6);          // dark outsole edge
  }, true, 1);
  soleTex.wrapS = THREE.RepeatWrapping; soleTex.wrapT = THREE.ClampToEdgeWrapping; soleTex.repeat.set(1, 1);
  const soleMat = new THREE.MeshStandardMaterial({ map: soleTex, roughness: 0.55 });
  const weltMat = new THREE.MeshStandardMaterial({ color: '#2e2018', roughness: 0.6 });
  const outsoleMat = new THREE.MeshStandardMaterial({ color: '#7f5434', roughness: 0.7 });
  const laceMat = new THREE.MeshStandardMaterial({ color: '#f4f3ef', roughness: 0.75 });
  const liningMat = new THREE.MeshStandardMaterial({ color: '#f2f1ec', roughness: 0.95, side: THREE.DoubleSide });
  const spikeMat = new THREE.MeshStandardMaterial({ color: '#8a7350', roughness: 0.5, metalness: 0.35 });   // bronze-tone soft spikes, not black
  let botTexShared: THREE.CanvasTexture | null = null, shoeAtlas: AtlasLayout | undefined, shoeMat: THREE.MeshPhysicalMaterial | undefined;
  for (const sfx of ['l', 'r'] as const) {
    const f = M.feet[sfx], fb = M.bones.indexOf(`foot_${sfx}`);
    const { len, z0, hw } = shoeDims(f);
    const so = Math.sign(f.x) || 1;                                  // +x is the outside of this foot
    const xc = (t: number) => f.x - so * 0.005 * t * t;              // the toe points a touch inwards
    const wOut = (t: number) => plan(t) * hw, wIn = (t: number) => plan(t) * hw * 0.96;
    const zAt = (t: number) => z0 + t * len;
    const base = (t: number) => SOLE_TOP + heelLift(t) + spring(t);
    const grp = new THREE.Group();
    // ── upper: two halves (outer, inner) lofted heel → toe, meeting over the top except at the ankle opening
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    const edgeL: number[] = [], edgeR: number[] = [];
    for (const outer of [true, false]) {
      for (let k = 0; k <= NT; k++) {
        const t = tAt(k), W = outer ? wOut(t) : wIn(t), hs = half(t, W, outer);
        for (let j = 0; j <= HJ; j++) {
          const a = outer ? (j / HJ) * hs.aEnd : Math.PI - (j / HJ) * (Math.PI - hs.aEnd);
          const c = Math.cos(a), sn = Math.max(0, Math.sin(a));
          const bulge = 1 + 0.035 * Math.sin(Math.min(1, sn * 1.6) * Math.PI);   // the leather swells a little above the welt
          pos.push(xc(t) + so * W * c * bulge, base(t) + hs.top * Math.pow(sn, crown(t)), zAt(t));
          uv.push(a / Math.PI, t);
        }
        (outer ? edgeL : edgeR).push(pos.length / 3 - 1);
      }
    }
    const R1 = HJ + 1, HALF = (NT + 1) * R1;
    for (const h0 of [0, HALF]) for (let k = 0; k < NT; k++) for (let j = 0; j < HJ; j++) {
      const a = h0 + k * R1 + j, b = a + R1;
      if ((h0 === 0) === (so > 0)) idx.push(a, a + 1, b, a + 1, b + 1, b); else idx.push(a, b, a + 1, a + 1, b, b + 1);   // outward-facing
    }
    const upper = new THREE.BufferGeometry(); upper.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); upper.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); upper.setIndex(idx); upper.computeVertexNormals();
    { // the two halves meet over the top: share their normals there so there's no crease
      const nrm = upper.getAttribute('normal') as THREE.BufferAttribute;
      for (let k = 0; k <= NT; k++) { const i = edgeL[k], j = edgeR[k]; if (xOpen(tAt(k), wOut(tAt(k))) > 0) continue; const n = new THREE.Vector3(nrm.getX(i) + nrm.getX(j), nrm.getY(i) + nrm.getY(j), nrm.getZ(i) + nrm.getZ(j)).normalize(); nrm.setXYZ(i, n.x, n.y, n.z); nrm.setXYZ(j, n.x, n.y, n.z); }
    }
    grp.add(new THREE.Mesh(upper, upperMat));
    // the sock inside the opening (so you never look into an empty shoe)
    {
      const lp: number[] = [], li: number[] = []; let n = 0;
      for (let k = 0; k <= NT; k++) { const t = tAt(k); if (t < T0 - 0.02 || t > T1 + 0.02) continue; const i = edgeL[k] * 3, j = edgeR[k] * 3; lp.push(pos[i], pos[i + 1] - 0.005, pos[i + 2], pos[j], pos[j + 1] - 0.005, pos[j + 2]); n++; }
      for (let k = 0; k < n - 1; k++) { const a = k * 2; li.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
      const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3)); lg.setIndex(li); lg.computeVertexNormals();
      grp.add(new THREE.Mesh(lg, liningMat));
    }
    // a padded collar: a soft roll round the edge of the opening
    {
      const pts: THREE.Vector3[] = [];
      const ks = [...Array(NT + 1).keys()].filter(k => tAt(k) >= T0 - 0.01 && tAt(k) <= T1 + 0.01);
      for (const k of ks) pts.push(new THREE.Vector3(pos[edgeL[k] * 3], pos[edgeL[k] * 3 + 1] - 0.001, pos[edgeL[k] * 3 + 2]));
      for (const k of ks.slice().reverse()) pts.push(new THREE.Vector3(pos[edgeR[k] * 3], pos[edgeR[k] * 3 + 1] - 0.001, pos[edgeR[k] * 3 + 2]));
      grp.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 120, 0.0026, 8, true), new THREE.MeshStandardMaterial({ color: '#f1f0eb', roughness: 0.55 })));
    }
    // tongue: rises out of the throat and leans back against the shin
    {
      const tp: number[] = [], ti: number[] = [], tu: number[] = [], RW = 6;
      const tz = zAt(T1 - 0.01), ty = base(T1) + hRel(T1) - 0.004;
      for (let r = 0; r <= RW; r++) for (let i = 0; i <= 6; i++) {
        const v = r / RW, x = (i / 6 - 0.5) * 0.034 * (1 - 0.25 * v);
        tp.push(xc(T1) + x, ty + v * 0.02 - Math.abs(x) * 0.25, tz - v * 0.016 - v * v * 0.004 + (1 - Math.cos((i / 6 - 0.5) * Math.PI)) * 0.003);
        tu.push(0.5, 0.5);
      }
      for (let r = 0; r < RW; r++) for (let i = 0; i < 6; i++) { const a = r * 7 + i, b = a + 7; ti.push(a, a + 1, b, a + 1, b + 1, b); }
      const tg = new THREE.BufferGeometry(); tg.setAttribute('position', new THREE.Float32BufferAttribute(tp, 3)); tg.setIndex(ti); tg.computeVertexNormals();
      grp.add(new THREE.Mesh(tg, new THREE.MeshPhysicalMaterial({ color: '#f3f2ee', roughness: 0.45, clearcoat: 0.3, side: THREE.DoubleSide })));
    }
    // laces: five white cross laces arched over the lace panel, from eyelet to eyelet
    for (let i = 0; i < 5; i++) {
      const t = 0.515 + i * 0.037, W = wOut(t), hs = half(t, W, true), pts: THREE.Vector3[] = [];
      const ua = 0.455 - i * 0.003;
      for (let k = 0; k <= 8; k++) {
        const a = Math.PI * (ua + (1 - 2 * ua) * (k / 8)), c = Math.cos(a), sn = Math.sin(a);
        pts.push(new THREE.Vector3(xc(t) + so * W * c * 1.0, base(t) + hs.top * Math.pow(sn, crown(t)) + 0.0025, zAt(t) + (k / 8 - 0.5) * 0.006 * (i % 2 ? 1 : -1)));
      }
      grp.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.0018, 6), laceMat));
    }
    // ── sole: the plan outline pushed out 4 mm for the welt, an edge wall (stacked leather), top and bottom caps
    {
      const ring: THREE.Vector2[] = [], ts: number[] = [];
      const N = 60;
      for (let k = 0; k <= N; k++) { const t = 0.5 - 0.5 * Math.cos(Math.PI * k / N); ring.push(new THREE.Vector2(xc(t) + so * wOut(t), zAt(t))); ts.push(t); }
      for (let k = N - 1; k >= 1; k--) { const t = 0.5 - 0.5 * Math.cos(Math.PI * k / N); ring.push(new THREE.Vector2(xc(t) - so * wIn(t), zAt(t))); ts.push(t); }
      // offset outwards along the outline normal
      const cen = ring.reduce((a, b) => a.clone().add(b), new THREE.Vector2()).multiplyScalar(1 / ring.length);
      const out = ring.map((p, i) => {
        const a = ring[(i - 1 + ring.length) % ring.length], b = ring[(i + 1) % ring.length];
        const n = new THREE.Vector2(b.y - a.y, -(b.x - a.x)).normalize();
        if (n.dot(p.clone().sub(cen)) < 0) n.negate();
        return p.clone().addScaledVector(n, 0.0045);
      });
      const yTop = (t: number) => base(t) + 0.001, yBot = (t: number) => 0.003 + (t > 0.27 && t < 0.56 ? 0.006 * Math.sin(Math.PI * (t - 0.27) / 0.29) ** 0.5 : 0) + spring(t);   // heel block, arch gap under the waist, toe spring
      const wp: number[] = [], wu: number[] = [], wi: number[] = [];
      let per = 0;
      for (let i = 0; i <= out.length; i++) {
        const p = out[i % out.length], t = ts[i % out.length];
        if (i) per += p.distanceTo(out[(i - 1) % out.length]);
        wp.push(p.x, yBot(t), p.y, p.x, yTop(t), p.y); wu.push(per, 0, per, 1);
      }
      for (let i = 0; i < wu.length; i += 2) wu[i] /= per;   // 0..1 round the sole
      for (let i = 0; i < out.length; i++) { const a = i * 2; wi.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      const wall = new THREE.BufferGeometry(); wall.setAttribute('position', new THREE.Float32BufferAttribute(wp, 3)); wall.setAttribute('uv', new THREE.Float32BufferAttribute(wu, 2)); wall.setIndex(wi); wall.computeVertexNormals();
      grp.add(new THREE.Mesh(wall, new THREE.MeshStandardMaterial({ map: soleTex, roughness: 0.55, side: THREE.DoubleSide })));
      const tris = THREE.ShapeUtils.triangulateShape(out, []);
      // the leather outsole: tan-brown, a slightly darker heel block, a stitch line round the edge
      const minX = Math.min(...out.map(p => p.x)), maxX = Math.max(...out.map(p => p.x)), minZ = Math.min(...out.map(p => p.y)), maxZ = Math.max(...out.map(p => p.y));
      const UVx = (x: number) => (x - minX) / (maxX - minX), UVz = (z: number) => (z - minZ) / (maxZ - minZ);
      const botTex = botTexShared ??= canvasTex(256, 768, g => {
        const W = 256, H = 768, X = (x: number) => UVx(x) * W, Y = (z: number) => (1 - UVz(z)) * H;
        g.fillStyle = '#93653c'; g.fillRect(0, 0, W, H);
        for (let i = 0; i < 2500; i++) { g.fillStyle = rand() < 0.5 ? 'rgba(60,34,16,.10)' : 'rgba(200,150,100,.08)'; g.fillRect(rand() * W, rand() * H, 2 + rand() * 6, 1 + rand()); }
        // heel block (darker, stacked leather/rubber top-lift) and its breast line
        const hb = Y(zAt(0.255));
        g.save(); g.beginPath(); out.forEach((p, i) => (i ? g.lineTo(X(p.x), Y(p.y)) : g.moveTo(X(p.x), Y(p.y)))); g.closePath(); g.clip();
        g.fillStyle = 'rgba(70,40,20,.38)'; g.fillRect(0, hb, W, H - hb);
        g.strokeStyle = 'rgba(50,28,12,.6)'; g.lineWidth = 3; g.beginPath(); g.moveTo(0, hb); g.lineTo(W, hb); g.stroke();
        // fine cross-hatch tread on the forefoot, very subtle
        g.strokeStyle = 'rgba(60,34,16,.12)'; g.lineWidth = 1.5;
        for (let k = -H; k < H; k += 12) { g.beginPath(); g.moveTo(0, k); g.lineTo(W, k + W * 0.6); g.stroke(); g.beginPath(); g.moveTo(0, k + W * 0.6); g.lineTo(W, k); g.stroke(); }
        g.restore();
        // edge stitching, inset from the outline
        const inset = out.map(p => { const d = new THREE.Vector2(p.x - (minX + maxX) / 2, 0).setLength(0.0045); return new THREE.Vector2(p.x - d.x, p.y); });
        g.strokeStyle = 'rgba(225,200,160,.75)'; g.setLineDash([6, 5]); g.lineWidth = 2; g.beginPath();
        inset.forEach((p, i) => (i ? g.lineTo(X(p.x), Y(p.y)) : g.moveTo(X(p.x), Y(p.y)))); g.closePath(); g.stroke(); g.setLineDash([]);
      }, true, 1);
      botTex.wrapS = botTex.wrapT = THREE.ClampToEdgeWrapping; botTex.repeat.set(1, 1);
      const cap = (y: (t: number) => number, mat: THREE.Material, down: boolean) => {
        const cp: number[] = [], cu: number[] = []; out.forEach((p, i) => { cp.push(p.x, y(ts[i]), p.y); cu.push(UVx(p.x), UVz(p.y)); });
        const build = (flip: boolean) => { const ci: number[] = []; tris.forEach(([a, b, c]) => (flip ? ci.push(a, c, b) : ci.push(a, b, c))); return ci; };
        const cg = new THREE.BufferGeometry(); cg.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3)); cg.setAttribute('uv', new THREE.Float32BufferAttribute(cu, 2));
        cg.setIndex(build(false)); cg.computeVertexNormals();
        // face the right way (bottom: down, top: up), checked rather than assumed, so it's lit as a front face
        const na = cg.getAttribute('normal') as THREE.BufferAttribute; let ny = 0; for (let i = 0; i < na.count; i++) ny += na.getY(i);
        if ((ny < 0) !== down) { cg.setIndex(build(true)); cg.computeVertexNormals(); }
        grp.add(new THREE.Mesh(cg, mat));
      };
      cap(yTop, new THREE.MeshStandardMaterial({ color: '#3a281b', roughness: 0.6 }), false);
      cap(yBot, new THREE.MeshStandardMaterial({ map: botTex, roughness: 0.7 }), true);
      void soleMat; void weltMat; void outsoleMat;
      // soft spikes under the heel and forefoot
      for (const [t, xo] of [[0.1, -0.45], [0.1, 0.45], [0.2, 0], [0.56, -0.55], [0.56, 0.55], [0.68, -0.15], [0.68, 0.5], [0.8, -0.4], [0.8, 0.35], [0.9, 0]] as [number, number][]) {
        const sp = new THREE.Mesh(new THREE.CylinderGeometry(0.0075, 0.005, 0.004, 10), spikeMat);
        sp.position.set(xc(t) + xo * wOut(t) * 0.75, 0.002 + spring(t) * 0.9, zAt(t)); grp.add(sp);
      }
    }
    // bake the whole shoe into one mesh, one material, one atlas: one draw call per pass
    const parts = grp.children.filter(o => (o as THREE.Mesh).isMesh) as THREE.Mesh[];
    const baked = bakeAtlas(parts, 2048, shoeAtlas);          // the second shoe reuses the first one's atlas
    shoeAtlas = baked.layout; baked.texture.anisotropy = 8;
    shoeMat ??= new THREE.MeshPhysicalMaterial({ map: baked.texture, bumpMap: baked.texture, bumpScale: 0.8, roughness: 0.55, clearcoat: 0.25, clearcoatRoughness: 0.35, side: THREE.DoubleSide });
    const shoe = new THREE.Mesh(baked.geometry, shoeMat); shoe.name = `shoe_${sfx}`;
    shoe.castShadow = true; shoe.receiveShadow = true;
    shoe.position.copy(J[fb]).negate();
    for (const pm of parts) { pm.geometry.dispose(); }
    bones[fb].add(shoe); meshes.push(shoe);
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
    const v = gen ? gen.visor : M.visor;
    const g = buildVisor(O.headwear, v.rx, v.rz, 0, 0, p.handed === 'left', v.profile, (v as { opts?: { gap?: number; dilate?: boolean; droop?: number; backDrop?: number; reach?: number } }).opts);
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
    // a painted face (unwrapped texture) is warped onto one fixed smile, so the mouth shape stays put
    // the generated head's smile is the portrait's own: the hidden MakeHuman face stays neutral
    const v = gen ? 0 : M.paintedMouth ? (M.paintedSmile ?? 0.9) : 0.22 + 0.78 * v0; // a hint of a smile at rest
    if (skin.morphTargetInfluences) skin.morphTargetInfluences[0] = v;
    if (teeth?.morphTargetInfluences) teeth.morphTargetInfluences[0] = v;
    smileAmt.value = Math.min(1, Math.max(0, (v - 0.15) * 1.3));
    if (teeth) teeth.visible = v > 0.08 && !M.paintedMouth && !gen; // closed mouth: keep teeth from showing through the lips
    gen?.face.setExpression({ smile: 0.4 + Math.max(0, v0 - 0.25) / 0.75 * 0.6 });   // rest: corners lifted, cheeks up a touch (the grin is the reaction, via setExpression)   // a relaxed, pleasant rest smile (lips closed); more on top
  };
  // with the generated head: its own hair, eyes and teeth replace the MakeHuman scalp shell, hair cards, eyeballs and teeth
  if (gen) root.traverse(o => { if (['hair', 'hair-shell', 'eye', 'teeth'].includes(o.name)) o.visible = false; });
  // face: expressions, gaze and blinks on the generated head (setExpression({smile, grimace, browUp, browDown, jawOpen, blink}), lookAt, setGaze)
  return { root, bones, skel, meshes, materials: { skin: skinMat, glove }, setSmile, extras, face: gen?.face };
}
