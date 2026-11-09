// The generated head: a textured head + upper neck built offline from the player's portrait by
// tools/character/head.py (image-to-3D shape, portrait projected as the texture). It replaces the MakeHuman
// face and scalp: skinned to the body's skeleton (all head bone above the jaw, blending into the body's own neck
// weights at the seam), with the MakeHuman skin above the seam discarded in the shader.
import * as THREE from 'three';

export interface GenHeadData {
  meta: {
    arrays: Record<string, { offset: number; count: number; type: string }>;
    bones: string[]; eye: number[]; ipd: number;
    seam: { point: number[]; normal: number[]; band: number };
    skinTint: number[]; skinColor: number[]; hairColor: number[];
  };
  buf: ArrayBuffer; blobStart: number; tex: HTMLImageElement;
}

const loadImage = (url: string) => new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });

export async function loadGenHead(binUrl: string, texUrl: string): Promise<GenHeadData> {
  const getBin = async () => {
    if (binUrl.startsWith('data:')) { const b = atob(binUrl.slice(binUrl.indexOf(',') + 1)); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u.buffer; }
    return fetch(binUrl).then(r => r.arrayBuffer());
  };
  const [buf, tex] = await Promise.all([getBin(), loadImage(texUrl)]);
  const dv = new DataView(buf);
  if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'HEAD') throw new Error('bad head file');
  const len = dv.getUint32(4, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, len)));
  return { meta, buf, blobStart: 8 + len, tex };
}

export interface GenHead {
  mesh: THREE.SkinnedMesh;
  seam: { p: THREE.Vector3; n: THREE.Vector3 };
  /** visor fit measured on the new head (same form as character.bin's meta.visor) */
  visor: { center: number[]; rx: number; rz: number; profile: number[] };
  tint: THREE.Color;
}

/** builds the head in the body's bind space. eye / ipd: the body's eye centre and eyeball spacing now
 *  (the file was fitted to them; if the body was rebuilt since, the head follows). */
export function buildGenHead(gh: GenHeadData, boneNames: string[], skeleton: THREE.Skeleton, root: THREE.Object3D,
  eye: THREE.Vector3, ipd: number, visorY: number): GenHead {
  const G = gh.meta;
  const arr = (k: string) => {
    const d = G.arrays[k], o = gh.blobStart + d.offset;
    if (d.type === 'float32') return new Float32Array(gh.buf.slice(o, o + d.count * 4));
    if (d.type === 'uint32') return new Uint32Array(gh.buf.slice(o, o + d.count * 4));
    if (d.type === 'uint16') return new Uint16Array(gh.buf.slice(o, o + d.count * 2));
    return new Uint8Array(gh.buf.slice(o, o + d.count));
  };
  const k = ipd / G.ipd, e0 = new THREE.Vector3(...(G.eye as [number, number, number]));
  const place = (v: THREE.Vector3) => v.sub(e0).multiplyScalar(k).add(eye);
  const pos = arr('position') as Float32Array;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.length; i += 3) { place(v.set(pos[i], pos[i + 1], pos[i + 2])); pos[i] = v.x; pos[i + 1] = v.y; pos[i + 2] = v.z; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(arr('normal'), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(arr('uv'), 2));
  // skin indices: the file names its bones; map them onto this skeleton
  const si = arr('skinIndex') as Uint8Array, map = G.bones.map(n => Math.max(0, boneNames.indexOf(n)));
  const idx = new Uint16Array(si.length); for (let i = 0; i < si.length; i++) idx[i] = map[si[i]];
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(arr('skinWeight'), 4));
  g.setIndex(new THREE.BufferAttribute(arr('index'), 1));
  const t = new THREE.Texture(gh.tex); t.needsUpdate = true; t.flipY = true; t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  // the portrait already carries its own light and shade: a soft, slightly sheeny skin that doesn't add much more
  const mat = new THREE.MeshPhysicalMaterial({ map: t, roughness: 0.62, sheen: 0.3, sheenColor: new THREE.Color('#ff9a7a'), sheenRoughness: 0.55 });
  const mesh = new THREE.SkinnedMesh(g, mat);
  mesh.name = 'gen-head'; mesh.castShadow = mesh.receiveShadow = true; mesh.frustumCulled = false;
  root.add(mesh); mesh.bind(skeleton);

  const seam = { p: place(new THREE.Vector3(...(G.seam.point as [number, number, number]))), n: new THREE.Vector3(...(G.seam.normal as [number, number, number])).normalize() };

  // visor fit on this head: radius round the head along the band (64 angles from the back), as build.py does
  let zmin = 9, zmax = -9, xmin = 9, xmax = -9;
  for (let i = 0; i < pos.length; i += 3) if (Math.abs(pos[i + 1] - visorY) < 0.006) { zmin = Math.min(zmin, pos[i + 2]); zmax = Math.max(zmax, pos[i + 2]); xmin = Math.min(xmin, pos[i]); xmax = Math.max(xmax, pos[i]); }
  const vc = new THREE.Vector3((xmin + xmax) / 2, visorY, (zmin + zmax) / 2);
  const prof: (number | null)[] = [];
  for (let s = 0; s < 64; s++) {
    const a = -Math.PI + (s / 64) * 2 * Math.PI, back = Math.max(0, -Math.cos(a)), front = Math.max(0, Math.cos(a));
    const yb = visorY - 0.006 * front - 0.024 * back;
    let best = -1;
    for (let i = 0; i < pos.length; i += 3) {
      if (Math.abs(pos[i + 1] - yb) > 0.016) continue;
      const dx = pos[i] - vc.x, dz = pos[i + 2] - vc.z;
      const da = Math.abs((((Math.atan2(dx, dz) - a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
      if (da < 0.07) best = Math.max(best, Math.hypot(dx, dz));
    }
    prof.push(best > 0 ? best : null);
  }
  for (let i = 0; i < 64; i++) if (prof[i] === null) for (let j = 1; j < 64; j++) { const q = prof[(i + j) % 64]; if (q !== null) { prof[i] = q; break; } }
  let pr = prof.map(x => x ?? 0.09);
  pr = pr.map((_, i) => Math.max(...[-2, -1, 0, 1, 2].map(j => pr[(i + j + 64) % 64])));
  pr = pr.map((_, i) => (pr[(i + 63) % 64] + pr[i] + pr[(i + 1) % 64]) / 3);
  const visor = { center: [vc.x, vc.y, vc.z], rx: (xmax - xmin) / 2 + 0.0115, rz: (zmax - zmin) / 2 + 0.0125, profile: pr };

  return { mesh, seam, visor, tint: new THREE.Color(G.skinTint[0], G.skinTint[1], G.skinTint[2]) };
}

/** discard the MakeHuman skin above the seam (face, scalp, ears), keeping the neck and everything below.
 *  Works in bind space (the fabric shader's vB), so it holds through the swing. */
export function hideAboveSeam(mat: THREE.Material, seam: { p: THREE.Vector3; n: THREE.Vector3 }) {
  const prev = mat.onBeforeCompile.bind(mat), prevKey = mat.customProgramCacheKey.bind(mat);
  const f = (x: number) => x.toFixed(5);
  mat.onBeforeCompile = (sh, r) => {
    prev(sh, r);
    sh.fragmentShader = sh.fragmentShader.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
      if (dot(vB - vec3(${f(seam.p.x)}, ${f(seam.p.y)}, ${f(seam.p.z)}), vec3(${f(seam.n.x)}, ${f(seam.n.y)}, ${f(seam.n.z)})) > 0.0 && abs(vB.x) < 0.16 && vB.y > ${f(seam.p.y - 0.12)}) discard;`);
  };
  mat.customProgramCacheKey = () => prevKey() + '-genhead';
}
