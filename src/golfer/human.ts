// The realistic golfer body: a CC0 MakeHuman base human shaped, rigged, clothed and textured offline by
// tools/character/build.py, loaded here into a skinned mesh. Exposes the same Body interface as the
// old code-built body (18 driver bones in the order rig.ts expects), plus hands, fingers and toes.
import * as THREE from 'three';
import type { Body, Skeleton as SkelInfo } from './body';
import type { GolferProfile } from './profile';
import { buildVisor } from './headwear';
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
  const [h, head] = await Promise.all([loadHuman(binUrl, skinUrl, eyesUrl, smileUrl), loadGenHead(headBin, headTex).catch(e => { console.warn('generated head failed to load', e); return undefined; })]);
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
          g.drawImage(cv, x, y, w, h);
          if (col !== 'ffffff') { g.save(); g.globalCompositeOperation = 'multiply'; g.fillStyle = '#' + col; g.fillRect(x, y, w, h); g.restore(); }
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
  const eyeL = M.eyeballs.l.c, eyeR = M.eyeballs.r.c;
  const gen = genOn ? buildGenHead(data.head!, M.bones, skeleton, root, new THREE.Vector3(...(M.eye as [number, number, number])), Math.hypot(eyeL[0] - eyeR[0], eyeL[1] - eyeR[1], eyeL[2] - eyeR[2]), M.visor.center[1] - 0.022, p.look.eyes) : null;
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
    applyFabric(shirtMat, 'polo', { ...fu, crest: { tex: crest, c: O.chestLogo === 'malbon-m' ? new THREE.Vector3(side * 0.07, M.collar.reduce((a, c) => (c[2] > a[2] ? c : a))[1] - 0.088, cz)   /* level with the second button */ : new THREE.Vector3(side * 0.085, chest.y + 0.12, cz), size: O.chestLogo === 'malbon-m' ? 0.06 : 0.07, flip: p.handed === 'left' }, tipping: new THREE.Color(O.topTrim ?? '#ffffff') });
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
  const pantsMat = new THREE.MeshPhysicalMaterial({ color: O.pants, roughness: 0.82, sheen: 0.3, sheenColor: new THREE.Color('#ffffff').lerp(new THREE.Color(O.pants), 0.6), sheenRoughness: 0.5, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
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
    const nearest6 = (p: THREE.Vector3) => {
      const best: [number, number][] = [];
      for (const i of cand) {
        const d = (sp.getX(i) - p.x) ** 2 + (sp.getY(i) - p.y) ** 2 + (sp.getZ(i) - p.z) ** 2;
        if (best.length < 6 || d < best[5][0]) { best.push([d, i]); best.sort((x, y) => x[0] - y[0]); if (best.length > 6) best.pop(); }
      }
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
  // polo collar: one continuous piece of shirt fabric round the neck (no seam at the back). A stand rises off
  // the neckline, rolls softly over and falls as a leaf onto the shoulders, ending in two points that lie on the
  // collarbones either side of the placket. The leaf is laid onto the shirt surface so it never cuts into it.
  {
    // the shirt surface near the neck (bind space), for laying things onto it
    const ring0 = M.collar.map(a => new THREE.Vector3(a[0], a[1], a[2]));
    const c = ring0.reduce((a, b) => a.add(b), new THREE.Vector3()).multiplyScalar(1 / ring0.length);
    const loY = Math.min(...ring0.map(q => q.y)) - 0.16;
    const inside = new THREE.Vector3(c.x, c.y - 0.16, c.z - 0.02);
    const armBone = new Set(M.bones.map((n, i) => (/upperarm|lowerarm|hand/.test(n) ? i : -1)).filter(i => i >= 0));   // the collar never follows the arms
    // collar, placket and buttons are skinned like the shirt under them, so they move with the fabric through the swing
    const { near, skinned } = surfaceOf(shirtMesh!, (x, y, z) => y > loY && Math.hypot(x - c.x, z - c.z) < 0.24, () => inside, armBone);
    // the neckline as a smooth closed curve: a low-order Fourier fit of radius and height against angle round the neck
    const sam = ring0.map(q => ({ a: Math.atan2(q.x - c.x, q.z - c.z), r: Math.hypot(q.x - c.x, q.z - c.z), y: q.y })).sort((x, y) => x.a - y.a);
    const fit = (key: 'r' | 'y', NH = 3) => {
      const co: [number, number][] = [];
      for (let k = 0; k <= NH; k++) {
        let ca = 0, sa = 0;
        sam.forEach((o, i) => { const a0 = sam[(i - 1 + sam.length) % sam.length].a, a1 = sam[(i + 1) % sam.length].a; const da = (((a1 - a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / 2; ca += o[key] * Math.cos(k * o.a) * da; sa += o[key] * Math.sin(k * o.a) * da; });
        co.push([ca / (k ? Math.PI : 2 * Math.PI), sa / Math.PI]);
      }
      return (a: number) => co.reduce((s, [ca, sa], k) => s + ca * Math.cos(k * a) + (k ? sa * Math.sin(k * a) : 0), 0);
    };
    const R = fit('r'), Y = fit('y');
    const neck = (a: number, dr = 0, dy = 0) => new THREE.Vector3(c.x + Math.sin(a) * (R(a) + dr), Y(a) + dy, c.z + Math.cos(a) * (R(a) + dr));
    const open = Math.asin(Math.min(0.9, 0.0165 / R(0)));      // the opening is the placket's width
    const COLS = 120, pos: number[] = [], idx: number[] = [];
    let rows = 0;
    for (let i = 0; i <= COLS; i++) {
      const s = i / COLS, a = open + s * (2 * Math.PI - 2 * open);       // a = 0 at the front, PI at the back
      const sg = Math.sin(a) >= 0 ? 1 : -1;
      const end = Math.max(0, 1 - Math.min(s, 1 - s) / 0.16);             // 1 at the collar points, 0 away from them
      const fr = Math.max(0, Math.cos(a));
      const standH = 0.026 - 0.008 * fr, rr = 0.0034;
      // the leaf falls over the stand and spreads out onto the shoulders; longer towards the points
      const leafH = 0.045 + 0.008 * Math.abs(Math.sin(a)) + 0.022 * end * end, leafOut = 0.024 + 0.012 * Math.abs(Math.sin(a)) + 0.012 * fr;
      // cross-section (out, up) from the neck seam: stand, the soft roll over the top, then the leaf
      const prof: [number, number, number][] = [];   // [out, up, u along the leaf for the point's sweep]
      prof.push([-0.0025, -0.004, 0], [-0.0028, standH * 0.5, 0], [-0.0025, standH - 0.002, 0]);
      const cx = -0.0025 + rr;
      for (let k = 1; k <= 5; k++) { const ph = Math.PI - (k / 6) * Math.PI; prof.push([cx + rr * Math.cos(ph), standH - 0.002 + rr * Math.sin(ph), 0]); }
      const L0 = cx + rr;
      for (let k = 0; k <= 8; k++) { const u = k / 8; prof.push([L0 + leafOut * Math.sin(u * Math.PI / 2), standH - 0.002 - leafH * Math.pow(u, 1.15), u]); }
      rows = prof.length;
      for (const [o, up, u] of prof) {
        // towards the points the leaf turns out to the side, so the points lie on the collarbones
        const aa = a + sg * 0.55 * end * end * u;
        const q = neck(aa, o, up);
        pos.push(q.x, q.y, q.z);
      }
    }
    // lay the leaf on the shirt: anything inside the fabric (+3 mm) is pushed out along the surface normal
    const P = (i: number, r: number) => new THREE.Vector3(pos[(i * rows + r) * 3], pos[(i * rows + r) * 3 + 1], pos[(i * rows + r) * 3 + 2]);
    const setP = (i: number, r: number, v: THREE.Vector3) => { pos[(i * rows + r) * 3] = v.x; pos[(i * rows + r) * 3 + 1] = v.y; pos[(i * rows + r) * 3 + 2] = v.z; };
    const lift = (v: THREE.Vector3, gap: number) => { const { q, n } = near(v); const d = v.clone().sub(q).dot(n); if (d < gap) v.addScaledVector(n, gap - d); return v; };
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i <= COLS; i++) for (let r = 9; r < rows; r++) setP(i, r, lift(P(i, r), 0.0035));
      // relax along the collar so the laid leaf stays smooth
      const cp = pos.slice();
      for (let i = 1; i < COLS; i++) for (let r = 9; r < rows; r++) for (let k = 0; k < 3; k++) {
        const j = (i * rows + r) * 3 + k; pos[j] = 0.5 * cp[j] + 0.25 * (cp[j - rows * 3] + cp[j + rows * 3]);
      }
    }
    for (let i = 0; i < COLS; i++) for (let r = 0; r < rows - 1; r++) { const a = i * rows + r, b = a + rows; idx.push(a, b, a + 1, a + 1, b, b + 1); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    const collarMat = new THREE.MeshPhysicalMaterial({ color: O.shirt, roughness: 0.86, sheen: 0.2, sheenColor: new THREE.Color('#ffffff').lerp(new THREE.Color(O.shirt), 0.6), sheenRoughness: 0.6, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const bits: THREE.Mesh[] = [new THREE.Mesh(g, collarMat)];   // collar, rolled edge, placket and buttons: baked into one mesh below
    // a little thickness: a soft rolled edge along the leaf's outer edge
    const rim: THREE.Vector3[] = [];
    for (let i = 0; i <= COLS; i++) rim.push(P(i, rows - 1));
    bits.push(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rim), COLS, 0.0016, 6), collarMat));
    // placket: a stitched strip laid on the shirt from the neckline down, with two white four-hole buttons
    const top = neck(0);
    const plkTex = canvasTex(64, 256, g => { g.fillStyle = '#fff'; g.fillRect(0, 0, 64, 256); g.strokeStyle = 'rgba(0,0,0,.28)'; g.setLineDash([5, 4]); g.lineWidth = 1.5; g.strokeRect(5, -10, 54, 258); g.beginPath(); g.moveTo(32, -10); g.lineTo(32, 250); g.stroke(); }, true, 1);
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
    for (const dy of [-0.032, -0.088]) {
      const { q, n } = near(new THREE.Vector3(top.x, top.y + dy, top.z + 0.02));
      const xf = new THREE.Matrix4().compose(q.clone().addScaledVector(n, 0.0028), new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n), new THREE.Vector3(1, 1, 1));
      bits.push(new THREE.Mesh(new THREE.CylinderGeometry(0.0056, 0.0056, 0.0024, 20, 1, true).applyMatrix4(xf), rimMat));
      bits.push(new THREE.Mesh(new THREE.CircleGeometry(0.0056, 20).rotateX(-Math.PI / 2).translate(0, 0.0012, 0).applyMatrix4(xf), faceMat));
    }
    // one skinned mesh, one atlas: one draw call; too small to need a shadow of its own
    const baked = bakeAtlas(bits, 512);
    const bitsMat = new THREE.MeshPhysicalMaterial({ map: baked.texture, roughness: 0.84, sheen: 0.2, sheenColor: collarMat.sheenColor, sheenRoughness: 0.6, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const cm = skinned(baked.geometry, bitsMat); cm.name = 'collar'; cm.castShadow = false;
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
    const brown = '#74412a';
    const leatherCanvas = (holes: boolean) => canvasTex(holes ? 512 : 2048, 64, g => {
      const W = holes ? 512 : 2048;
      g.fillStyle = brown; g.fillRect(0, 0, W, 64);
      for (let i = 0; i < W * 6; i++) { const x = rand() * W, y = rand() * 64, r = 0.8 + rand() * 1.4; g.fillStyle = rand() < 0.5 ? 'rgba(0,0,0,.10)' : 'rgba(255,220,190,.07)'; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); }
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
      ring.push({ p: new THREE.Vector3(q.x, B.y, q.z).addScaledVector(n, 0.0035), n });
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
      const bw = 0.046, bh = 0.044, t = 0.0045, silver = mat({ color: '#c3c6ca' });
      for (const [x, y, w, h] of [[0, bh / 2 - t / 2, bw, t], [0, -bh / 2 + t / 2, bw, t], [-bw / 2 + t / 2, 0, t, bh], [bw / 2 - t / 2, 0, t, bh], [-0.004, 0, bw * 0.55, 0.0025]] as number[][]) {
        const g = new THREE.BoxGeometry(w, h, 0.004); g.translate(x, y, 0); g.applyMatrix4(fr); parts.push(new THREE.Mesh(g, silver));
      } }
    // belt loops: khaki strips over the belt
    const khaki = mat({ color: O.pants });
    const r0 = Math.hypot(at(0).p.x - B.cx, at(0).p.z - B.cz);
    for (const a of [Math.asin(Math.min(0.9, 0.07 / r0)), -Math.asin(Math.min(0.9, 0.07 / r0)), 1.62, -1.62, 2.72, -2.72]) {
      const { p: lp, n: ln } = at(a), pos: number[] = [], idx: number[] = [];
      const prof: [number, number][] = [[-H / 2 - 0.008, 0.0005], [-H / 2 - 0.001, 0.0045], [H / 2 + 0.001, 0.0045], [H / 2 + 0.006, 0.0005]];
      const tang = new THREE.Vector3(0, 1, 0).cross(ln).normalize();
      for (const [y, o] of prof) for (const s2 of [-1, 1]) { const q = lp.clone().addScaledVector(ln, o).addScaledVector(tang, s2 * 0.0055); pos.push(q.x, q.y + y, q.z); }
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
    const beltMesh = skinned(baked.geometry, new THREE.MeshPhysicalMaterial({ map: baked.texture, bumpMap: baked.texture, bumpScale: 0.4, roughness: 0.5, clearcoat: 0.25, clearcoatRoughness: 0.4, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
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
    if (t > 0.74) { const k = (t - 0.74) / 0.26; return Math.pow(Math.max(0, 1 - Math.pow(k, 2.3)), 1 / 2.3) * (1 - 0.18 * k); }  // long rounded toe
    return widthK(t);
  };
  const hRel = smooth([[0, 0.06], [0.08, 0.058], [0.28, 0.041], [0.42, 0.058], [0.5, 0.074], [0.6, 0.064], [0.7, 0.049], [0.8, 0.036], [0.88, 0.028], [0.94, 0.02], [0.98, 0.012], [1, 0.004]]);
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
    g.fillStyle = '#8b5a34'; g.fillRect(0, 0, 2048, 64);
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
        g.fillStyle = '#7f5434'; g.fillRect(0, 0, W, H);
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
    // a painted face (unwrapped texture) is warped onto one fixed smile, so the mouth shape stays put
    // the generated head's smile is the portrait's own: the hidden MakeHuman face stays neutral
    const v = gen ? 0 : M.paintedMouth ? (M.paintedSmile ?? 0.9) : 0.22 + 0.78 * v0; // a hint of a smile at rest
    if (skin.morphTargetInfluences) skin.morphTargetInfluences[0] = v;
    if (teeth?.morphTargetInfluences) teeth.morphTargetInfluences[0] = v;
    smileAmt.value = Math.min(1, Math.max(0, (v - 0.15) * 1.3));
    if (teeth) teeth.visible = v > 0.08 && !M.paintedMouth && !gen; // closed mouth: keep teeth from showing through the lips
    gen?.face.setExpression({ smile: Math.max(0, v0 - 0.25) / 0.75 * 0.7 });   // the generated head already smiles; more on top
  };
  // with the generated head: its own hair, eyes and teeth replace the MakeHuman scalp shell, hair cards, eyeballs and teeth
  if (gen) root.traverse(o => { if (['hair', 'hair-shell', 'eye', 'teeth'].includes(o.name)) o.visible = false; });
  // face: expressions, gaze and blinks on the generated head (setExpression({smile, grimace, browUp, browDown, jawOpen, blink}), lookAt, setGaze)
  return { root, bones, skel, meshes, materials: { skin: skinMat, glove }, setSmile, extras, face: gen?.face };
}
