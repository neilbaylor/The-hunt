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
    skinTint: number[]; skinColor: number[]; hairColor: number[]; skinXform?: number[][]; seamTone?: number[];
    morphs?: string[]; morphUnit?: number;
    mouthRig?: Record<'center' | 'left' | 'right' | 'upper' | 'lower' | 'chin' | 'nose' | 'jawLip' | 'jawChin', number[]> | null;
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
  visor: { center: number[]; rx: number; rz: number; profile: number[]; opts?: { gap?: number; dilate?: boolean; droop?: number; backDrop?: number; reach?: number } };
  tint: THREE.Color;
  skin: { xform?: number[][]; tone?: number[] };
  face: FaceController;
  /** a second, independent instance of this head for the HUD badge: shared geometry and textures, its own material,
   *  mouth and face controller, posed still (bind pose) in its own group, which the caller puts in its own scene.
   *  eye: the eye centre in that group's space (the face looks toward +z). */
  makeBadge(): { group: THREE.Group; mesh: THREE.SkinnedMesh; face: FaceController; eye: THREE.Vector3 };
}

/** the face's clock (s): real time, or a fixed clock for frame-by-frame captures (window.__faceClock) */
const MOUTH_INSIDE = false;
const faceNow = () => ((globalThis as { __faceClock?: number }).__faceClock ?? performance.now() / 1000);

export interface Expression {
  smile?: number; grimace?: number; browUp?: number; browDown?: number; jawOpen?: number; blink?: number;
  /** mouth shapes (visemes use these too) and the rest-mouth shaping: corners lifted, lower lip drawn in */
  pucker?: number; wide?: number; lipIn?: number; press?: number; cornerLift?: number; unpout?: number;
}
export interface FaceController {
  /** expression weights 0..1 (smile adds to the portrait's own smile; blink overrides the idle blink) */
  setExpression(e: Expression): void;
  /** look at a world point (eyes only; null = idle glances) */
  lookAt(target: THREE.Vector3 | null): void;
  /** gaze directly: x = across (+ toward the golfer's left), y = up, each -1..1; null = back to idle */
  setGaze(x: number | null, y?: number): void;
  /** talk: drives the mouth through visemes from the text (letter timing), with jaw motion; durationMs spreads it */
  say(text: string, durationMs?: number): void;
  /** talk from timed visemes (a voice clip's lip-sync: [[tSec, 'A'|'E'|'I'|'O'|'U'|'M'|'F'|'C'|'_'], ...]); jaw: optional
   *  loudness curve 0..1 at fps, which scales the jaw so the mouth opens with the audio */
  sayTimed(vis: [number, string][], durationSec: number, jaw?: number[], fps?: number): void;
  /** true while say() is speaking */
  talking(): boolean;
  /** a small nod (radians, + = chin down) the caller may add to the head while talking */
  nod(): number;
  /** procedural head motion to add on top of the pose (radians: pitch + = chin down, yaw, roll): talking nods,
   *  drifting tilts and turns, emphasis bobs, a lean on questions/exclamations, breathing sway at idle */
  headMotion(): { pitch: number; yaw: number; roll: number };
  /** scale the talking mouth shapes (a small HUD badge wants ~2x) */
  setTalkScale(k: number): void;
  /** advance the face's clock-driven state (blinks, speech, springs); rendering does this too, a paused badge calls it */
  tick(): void;
  /** something is moving (a blink, speech, an expression easing, the eyes): a still badge needn't re-render */
  busy(): boolean;
}

/** builds the head in the body's bind space. eye / ipd: the body's eye centre and eyeball spacing now
 *  (the file was fitted to them; if the body was rebuilt since, the head follows). */
export function buildGenHead(gh: GenHeadData, boneNames: string[], skeleton: THREE.Skeleton, root: THREE.Object3D,
  eye: THREE.Vector3, ipd: number, visorY: number, irisHex = '#7d97a8'): GenHead {
  const G = gh.meta;
  const arr = (k: string) => {
    const d = G.arrays[k], o = gh.blobStart + d.offset;
    if (d.type === 'float32') return new Float32Array(gh.buf.slice(o, o + d.count * 4));
    if (d.type === 'uint32') return new Uint32Array(gh.buf.slice(o, o + d.count * 4));
    if (d.type === 'uint16') return new Uint16Array(gh.buf.slice(o, o + d.count * 2));
    if (d.type === 'int16') return new Int16Array(gh.buf.slice(o, o + d.count * 2));
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
  const nv = pos.length / 3;
  // expressions (MakeHuman expression units transferred by head.py), stored sparse
  const morphNames = (G.morphs ?? []).filter(n => G.arrays['morph_' + n + '_i']);
  if (morphNames.length) {
    g.morphAttributes.position = morphNames.map(n => {
      const ii = arr('morph_' + n + '_i'), dd = arr('morph_' + n + '_d') as Int16Array, a = new Float32Array(nv * 3), u = (G.morphUnit ?? 1e-5) * k;
      for (let j = 0; j < ii.length; j++) for (let c = 0; c < 3; c++) a[ii[j] * 3 + c] = dd[j * 3 + c] * u;
      const at = new THREE.BufferAttribute(a, 3); at.name = n; return at;
    });
    g.morphTargetsRelative = true;
  }
  // eyes: per-vertex eye coordinates (across, up, up-per-across, distance off the eye's plane) + resting iris centre
  const eyeA = new Float32Array(nv * 4).fill(9), eyeB = new Float32Array(nv * 2);
  if (G.arrays.eye_i) {
    const ii = arr('eye_i'), vv = arr('eye_v') as Float32Array;
    for (let j = 0; j < ii.length; j++) { for (let c = 0; c < 4; c++) eyeA[ii[j] * 4 + c] = vv[j * 6 + c]; eyeB[ii[j] * 2] = vv[j * 6 + 4]; eyeB[ii[j] * 2 + 1] = Math.min(0.3, Math.max(-0.2, vv[j * 6 + 5])); }
  }
  if (G.arrays.hair) g.setAttribute('hair', new THREE.BufferAttribute(arr('hair'), 1));   // 0..255 hair weight (for the hair cards)
  // mouth: per-vertex (across, up, off-plane) round the lip seam; the shader draws the inside as the lips part
  const mouthA = new Float32Array(nv * 3).fill(9);
  if (G.arrays.mouth_i) { const ii = arr('mouth_i'), vv = arr('mouth_v') as Float32Array; for (let j = 0; j < ii.length; j++) for (let c = 0; c < 3; c++) mouthA[ii[j] * 3 + c] = vv[j * 3 + c]; }
  g.setAttribute('mouthA', new THREE.BufferAttribute(mouthA, 3));
  g.setAttribute('eyeA', new THREE.BufferAttribute(eyeA, 4)); g.setAttribute('eyeB', new THREE.BufferAttribute(eyeB, 2));
  const t = new THREE.Texture(gh.tex); t.needsUpdate = true; t.flipY = true; t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  // the portrait already carries its own light and shade: a soft, slightly sheeny skin that doesn't add much more
  // the same skin response as the body's skin (human.ts skinMat) so the head and neck don't differ in sheen
  // the texture carries his real (softened) shading from the photos: keep the real-time shading gentle so the two
  // don't stack into mud — matte, little sheen, a soft normal map, and a warm self-fill (below) that lifts the shadow side
  // surface detail baked from the hi-res generated head (ear folds, creases, hair), a JPEG inside head.bin; shared by
  // every instance of the head (the golfer's and the HUD badge's)
  let normalTex: THREE.Texture | null = null; const wantsNormal: THREE.MeshPhysicalMaterial[] = [];
  const giveNormal = (m: THREE.MeshPhysicalMaterial) => { m.normalMap = normalTex; m.normalScale.set(0.3, 0.3); m.needsUpdate = true; };
  if (G.arrays.normalJpg) {
    const jb = arr('normalJpg') as Uint8Array, nurl = URL.createObjectURL(new Blob([jb as BlobPart], { type: 'image/jpeg' })), nim = new Image();
    nim.onload = () => { normalTex = new THREE.Texture(nim); normalTex.needsUpdate = true; normalTex.flipY = true; normalTex.anisotropy = 4; wantsNormal.forEach(giveNormal); URL.revokeObjectURL(nurl); };
    nim.src = nurl;
  }
  // the irises cropped from the unwrap (a small PNG inside head.bin); a flat blue-grey until it decodes
  const c0 = document.createElement('canvas'); c0.width = c0.height = 2; const g0 = c0.getContext('2d')!; g0.fillStyle = '#7d97a8'; g0.fillRect(0, 0, 2, 2);
  const irisTex = new THREE.Texture(c0); irisTex.colorSpace = THREE.SRGBColorSpace; irisTex.needsUpdate = true;
  const irisU: { value: THREE.Texture<any> } = { value: irisTex };
  if (G.arrays.irisPng) {
    const png = arr('irisPng') as Uint8Array, url = URL.createObjectURL(new Blob([png as BlobPart], { type: 'image/png' })), im = new Image();
    // a new texture once it decodes (a texture's size is fixed at its first upload)
    im.onload = () => { const t2 = new THREE.Texture(im); t2.colorSpace = THREE.SRGBColorSpace; t2.needsUpdate = true; irisU.value = t2; URL.revokeObjectURL(url); }; im.src = url;
  }
  const scl = ((G as any).eyes?.[0]?.sclera as number[] | undefined) ?? [0.72, 0.62, 0.58];
  const sclera = new THREE.Color(scl[0] * 1.15, scl[1] * 1.15, scl[2] * 1.15).convertSRGBToLinear();
  const irisCol = new THREE.Color(irisHex);
  const seam = { p: place(new THREE.Vector3(...(G.seam.point as [number, number, number]))), n: new THREE.Vector3(...(G.seam.normal as [number, number, number])).normalize() };

  // visor fit on this head: radius round the head along the band (64 angles from the back), as build.py does
  let zmin = 9, zmax = -9, xmin = 9, xmax = -9;
  for (let i = 0; i < pos.length; i += 3) if (Math.abs(pos[i + 1] - visorY) < 0.006) { zmin = Math.min(zmin, pos[i + 2]); zmax = Math.max(zmax, pos[i + 2]); xmin = Math.min(xmin, pos[i]); xmax = Math.max(xmax, pos[i]); }
  const vc = new THREE.Vector3((xmin + xmax) / 2, visorY, (zmin + zmax) / 2);
  // the head's own cross-section along the band (its tilt: lower at the front, higher at the back), a robust outer
  // radius per angle (90th percentile, so a stray hair spike doesn't push it out); the band then sits 4 mm off it
  const prof: (number | null)[] = [];
  for (let s = 0; s < 64; s++) {
    const a = -Math.PI + (s / 64) * 2 * Math.PI, back = Math.max(0, -Math.cos(a));
    const yb = visorY - 0.004 * (0.5 + 0.5 * Math.cos(a)) - 0.03 * back;   // the band's own tilt (backDrop below)
    const rs: number[] = [];
    for (let i = 0; i < pos.length; i += 3) {
      if (Math.abs(pos[i + 1] - yb) > 0.02 * (0.55 + 0.45 * (0.5 + 0.5 * Math.cos(a)))) continue;   // the band's whole height there
      const dx = pos[i] - vc.x, dz = pos[i + 2] - vc.z;
      const da = Math.abs((((Math.atan2(dx, dz) - a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
      if (da < 0.06) rs.push(Math.hypot(dx, dz));
    }
    rs.sort((p, q) => p - q);
    prof.push(rs.length ? rs[Math.min(rs.length - 1, Math.floor(rs.length * 0.97))] : null);
  }
  for (let i = 0; i < 64; i++) if (prof[i] === null) for (let j = 1; j < 64; j++) { const q = prof[(i + j) % 64]; if (q !== null) { prof[i] = q; break; } }
  const pr = prof.map(x => x ?? 0.09);
  const visor = { center: [vc.x, vc.y, vc.z], rx: (xmax - xmin) / 2 + 0.0115, rz: (zmax - zmin) / 2 + 0.0125, profile: pr, opts: { gap: 0.004, dilate: false, droop: 0.22, backDrop: 0.03, reach: 0.06 } };

  // ── one instance of the head: its own material (own shader uniforms: gaze, blink, mouth), mouth inside and face
  //    controller, on a skeleton (the golfer's, or a still one for the HUD badge) over the shared geometry and textures ──
  const makeInstance = (skeleton: THREE.Skeleton, root: THREE.Object3D) => {
  const mat = new THREE.MeshPhysicalMaterial({ map: t, roughness: 0.8, sheen: 0.1, sheenColor: new THREE.Color('#ff9a7a'), sheenRoughness: 0.6, specularIntensity: 0.25 });
  if (normalTex) giveNormal(mat); else wantsNormal.push(mat);
  const face = { gaze: new THREE.Vector2(), blink: { value: 0 }, gazeU: { value: new THREE.Vector2() }, fill: { value: 0.65 }, mouthOpen: { value: 0 }, teeth: { value: 0.4 } };
  mat.onBeforeCompile = sh => {
    sh.uniforms.uGaze = face.gazeU; sh.uniforms.uBlink = face.blink;
    sh.uniforms.uIris = { value: irisCol }; sh.uniforms.uIrisTex = irisU; sh.uniforms.uSclera = { value: sclera }; sh.uniforms.uLid = { value: new THREE.Color(G.skinColor[0], G.skinColor[1], G.skinColor[2]).convertSRGBToLinear().multiplyScalar(0.85) };
    sh.uniforms.uFill = face.fill; sh.uniforms.uMouthOpen = face.mouthOpen; sh.uniforms.uTeeth = face.teeth;
    // mostly the photo-baked texture itself (it already carries his real light and shade), a soft lit share for form
    sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', 'outgoingLight = mix(outgoingLight, diffuseColor.rgb * vec3(1.05, 0.96, 0.88), uFill);\n#include <opaque_fragment>');
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 eyeA; attribute vec2 eyeB; varying vec4 vEyeA; varying vec2 vEyeB; attribute vec3 mouthA; varying vec3 vMouth;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEyeA = eyeA; vEyeB = eyeB; vMouth = mouthA;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec4 vEyeA; varying vec2 vEyeB; uniform vec2 uGaze; uniform float uBlink; uniform vec3 uIris; uniform vec3 uLid; uniform sampler2D uIrisTex; uniform vec3 uSclera; uniform float uFill; varying vec3 vMouth; uniform float uMouthOpen; uniform float uTeeth;')
      .replace('#include <map_fragment>', `#include <map_fragment>
      {
        // the eye opening, drawn here so it can look around and blink: e = (across, up), |e| < 1 inside
        vec2 e = vEyeA.xy; float asp = vEyeA.z;
        float rr = length(e);
        float inside = (1.0 - smoothstep(0.78, 1.0, rr)) * (1.0 - smoothstep(0.004, 0.007, abs(vEyeA.w)));
        if (inside > 0.0) {
          vec2 ic = vEyeB + uGaze * vec2(0.32, 0.22);
          vec2 q = vec2(e.x - ic.x, (e.y - ic.y) * asp);          // in across-units, round
          float d = length(q) / 0.475;                            // 1 at the iris edge (6.2 mm on a 13 mm half-eye)
          // the unwrap's own iris (blue-grey, fibres, darker limbal ring), cropped by head.py to ±1.25 radii
          vec2 tuv = clamp(vec2(0.25 + q.x / (0.475 * 1.25) * 0.25, 0.5 + q.y / (0.475 * 1.25) * 0.5), vec2(0.01), vec2(0.49, 0.99));
          vec3 iris = texture2D(uIrisTex, tuv).rgb;
          iris = mix(iris, iris * 0.55, smoothstep(0.82, 1.0, d));                     // limbal ring
          float corner = smoothstep(0.45, 1.0, abs(e.x));
          vec3 sclera = uSclera * mix(1.0, 0.75, corner);
          vec3 eye = mix(iris, sclera, smoothstep(0.97, 1.05, d));
          eye *= 1.0 - 0.6 * smoothstep(-0.2, 0.85, e.y);                              // the upper lid and lashes shade the top
          eye *= 1.0 - 0.25 * smoothstep(-0.5, -0.95, e.y);                            // and the lower lid a little
          eye += vec3(0.35) * smoothstep(0.16, 0.02, length(vec2(e.x - 0.1, (e.y - 0.25) * asp)));   // a soft wet highlight (stays put)
          // at rest (eyes ahead) the painted eye from his photos shows; the drawn one takes over as the eyes move
          eye = mix(diffuseColor.rgb, eye, smoothstep(0.06, 0.3, length(uGaze)));
          // toward the lids the painted texture (lids, lashes, corners) takes over again
          eye = mix(eye, diffuseColor.rgb, smoothstep(0.62, 0.92, rr));
          // blink: the upper lid comes down to the lower; a lash line at its edge
          // the upper lid comes down over the eyeball (its edge stays curved: an arc that flattens as it closes), the
          // lower lid rises ~15 %; lashes make a dark line along the meeting edge, a soft crease shows above
          float bl = uBlink;
          float meet = -0.2;                                               // where the lids meet, a little below centre
          float upY = mix(1.0, meet, bl), loY = mix(-1.0, -0.82, bl);
          float arc = (1.0 - 0.75 * bl) * 0.35 * e.x * e.x;                   // the lid edge's curve over the eyeball
          float up = smoothstep(upY - 0.05, upY + 0.05, e.y + arc);
          float lo = 1.0 - smoothstep(loY - 0.05, loY + 0.05, e.y - 0.1 * e.x * e.x);
          float lidMask = max(up, lo) * step(0.001, bl);
          vec3 lidc = uLid * (0.88 + 0.12 * smoothstep(1.0, meet, e.y));
          lidc *= 1.0 - 0.18 * smoothstep(0.25, 0.0, abs(e.y - (upY + 0.55))) * bl;     // the crease above the lowered lid
          eye = mix(eye, lidc, lidMask);
          float lash = (1.0 - smoothstep(0.0, 0.1, abs(e.y + arc - upY))) * smoothstep(0.05, 0.3, bl);
          eye = mix(eye, vec3(0.05, 0.035, 0.03), lash * 0.85);
          diffuseColor.rgb = mix(diffuseColor.rgb, eye, inside);
        }
      }
      {
        // the inside of the mouth, where the lip seam opens (rest-pose mouth coordinates: the band round the seam
        // stretches as the lower lip comes down): dark cavity, upper teeth along the top, lower teeth and tongue below
        vec3 m = vMouth; float ax = abs(m.x);
        float band = 0.26 * (1.0 - smoothstep(0.7, 1.0, ax));
        float inM = (1.0 - smoothstep(band * 0.25, band * 1.15, abs(m.y))) * step(abs(m.z), 0.012) * smoothstep(0.0, 0.12, uMouthOpen);   // soft: the seam's triangles stretch unevenly
        if (inM > 0.0) {
          float yy = m.y / max(band, 1e-3);                                     // -1 (lower lip) .. 1 (upper lip)
          vec3 cav = vec3(0.10, 0.03, 0.03) * (0.6 + 0.4 * (1.0 - ax));
          vec3 teeth = vec3(0.82, 0.79, 0.72) * (0.85 + 0.15 * (1.0 - ax));
          float upT = smoothstep(-0.1, 0.7, yy) * (1.0 - smoothstep(0.45, 0.9, ax)) * uTeeth * 0.85;
          float loT = smoothstep(0.0, -0.8, yy) * (1.0 - smoothstep(0.35, 0.75, ax)) * uTeeth * 0.5;
          float tongue = smoothstep(-0.1, -0.6, yy) * (1.0 - loT) * smoothstep(0.25, 0.6, uMouthOpen);
          vec3 inside = mix(cav, teeth, max(upT, loT));
          inside = mix(inside, vec3(0.45, 0.16, 0.15), tongue * 0.7);
          diffuseColor.rgb = mix(diffuseColor.rgb, inside, inM);
        }
      }`);
  };
  mat.customProgramCacheKey = () => 'gen-head-eyes';
  const mesh = new THREE.SkinnedMesh(g, mat);
  mesh.name = 'gen-head'; mesh.castShadow = mesh.receiveShadow = true; mesh.frustumCulled = false;
  root.add(mesh); mesh.bind(skeleton);
  // ── the inside of the mouth (the lips are split along the seam in head.py): a dark cavity, an upper row of teeth
  //    fixed to the head, lower teeth and tongue riding down with the jaw. Built in bind space, carried by the head bone.
  let mouthParts: { lower: THREE.Group; lowerBase: THREE.Vector3; jaw: THREE.Vector3 } | null = null;
  const MR = G.mouthRig;
  const hbI = boneNames.indexOf('head');
  if (MR && hbI >= 0) {
    const P = (k: keyof NonNullable<typeof MR>) => place(new THREE.Vector3(...(MR[k] as [number, number, number])));
    const c = P('center'), L = P('left'), Rr = P('right'), U = P('upper'), Lo = P('lower');
    const jaw = new THREE.Vector3(...(MR.jawLip as [number, number, number])).multiplyScalar(k);
    const w = L.distanceTo(Rr), fwd = new THREE.Vector3(0, 0, 1);
    const rig = new THREE.Group(); rig.name = 'mouth-inside';
    const cav = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.07, 0.02, 0.02), side: THREE.BackSide }));
    cav.scale.set(w * 0.52, 0.02, 0.022); cav.position.copy(c).addScaledVector(fwd, -0.022); rig.add(cav);
    const teethMat = new THREE.MeshLambertMaterial({ color: '#857b6c' });   // in the mouth's shade (matte, no sky reflection): never stark white
    const arc = (y0: number, h: number, back: number, span: number) => {
      // a row of teeth: a curved strip following the dental arch, facing out
      const R0 = w * 0.5, seg = 18, pos: number[] = [], idx: number[] = [];
      const cz = c.z - back - R0;
      for (let i = 0; i <= seg; i++) {
        const a = -span + (2 * span * i) / seg, x = c.x + Math.sin(a) * R0, z = cz + Math.cos(a) * R0;
        pos.push(x, y0, z, x, y0 - h, z);
      }
      for (let i = 0; i < seg; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3); }
      const g2 = new THREE.BufferGeometry(); g2.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g2.setIndex(idx); g2.computeVertexNormals();
      return new THREE.Mesh(g2, teethMat);
    };
    rig.add(arc(U.y + 0.001, 0.0056, 0.0105, 0.7));                         // upper teeth, recessed behind the upper lip (and its inner strip)
    const lower = new THREE.Group();
    lower.add(arc(Lo.y - 0.0008, 0.0068, 0.012, 0.6));                      // lower teeth, a little further back
    const tongue = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), new THREE.MeshLambertMaterial({ color: '#8a4844' }));
    tongue.scale.set(w * 0.3, 0.005, 0.016); tongue.position.set(c.x, Lo.y - 0.005, c.z - 0.034); lower.add(tongue);   // well behind the lower teeth
    rig.add(lower);
    teethMat.side = THREE.DoubleSide;
    // into the head bone's space (as the hair cards are)
    rig.applyMatrix4(skeleton.boneInverses[hbI]);
    skeleton.bones[hbI].add(rig);
    mouthParts = { lower, lowerBase: lower.position.clone(), jaw };   // (the rig's own space is bind space)
  }

  // ── the face's life: idle blinks every 2–6 s (~120 ms), small glances, a look-at target, expressions ──
  mesh.updateMorphTargets();
  const infl = mesh.morphTargetInfluences ?? [], dict = mesh.morphTargetDictionary ?? {};
  // rest: corners lifted and the lower lip drawn in (a relaxed, pleasant mouth); everything else neutral
  const expr: Required<Expression> = { smile: 0, grimace: 0, browUp: 0, browDown: 0, jawOpen: 0, blink: -1, pucker: 0, wide: 0, lipIn: 0, press: 0, cornerLift: 1, unpout: 1 };
  const MORPHS = ['smile', 'grimace', 'browUp', 'browDown', 'jawOpen', 'pucker', 'wide', 'lipIn', 'press', 'cornerLift', 'unpout'] as const;
  type MK = typeof MORPHS[number];
  // talking: visemes from letters, ~70 ms a letter, pauses at spaces and punctuation
  const VIS: Record<string, Partial<Record<MK, number>>> = {
    A: { jawOpen: 0.75 }, E: { wide: 0.7, jawOpen: 0.35 }, I: { wide: 0.85, jawOpen: 0.2 }, O: { pucker: 0.8, jawOpen: 0.45 },
    U: { pucker: 1.0, jawOpen: 0.15 }, M: { press: 0.9 }, F: { lipIn: 0.85, jawOpen: 0.08 }, C: { jawOpen: 0.25, wide: 0.25 }, _: {},
  };
  const vOf = (ch: string) => 'a'.includes(ch) ? 'A' : 'e'.includes(ch) ? 'E' : 'iy'.includes(ch) ? 'I' : 'o'.includes(ch) ? 'O' : 'uwq'.includes(ch) ? 'U'
    : 'mbp'.includes(ch) ? 'M' : 'fv'.includes(ch) ? 'F' : /[a-z]/.test(ch) ? 'C' : '_';
  let speech: { t: number; v: string }[] = [], speechT0 = 0, speechEnd = 0;
  let jawCurve: number[] | null = null, jawFps = 30;
  const vis: Record<MK, number> = Object.fromEntries(MORPHS.map(k => [k, 0])) as Record<MK, number>;
  let nodV = 0, lastGx = 0, blinkTwice = false, talkK = 1;
  // head motion: critically damped springs toward targets made of layered slow noise + speech events
  const hm = { p: 0, y: 0, r: 0, vp: 0, vy: 0, vr: 0 };
  let lean = 0, emph = 0, browE = 0;
  const nz = (t: number, f: number, ph: number) => Math.sin(t * f + ph) * 0.6 + Math.sin(t * f * 2.13 + ph * 1.7) * 0.3 + Math.sin(t * f * 4.7 + ph * 0.3) * 0.1;
  const spring = (x: number, v: number, target: number, w: number, dt: number) => { const a = w * w * (target - x) - 2 * w * v; v += a * dt; return [x + v * dt, v]; };
  let target: THREE.Vector3 | null = null, forced: THREE.Vector2 | null = null;
  let nextBlink = 1.5 + Math.random() * 3, blinkT = -1, nextGlance = 1, last = -1;
  const idleGaze = new THREE.Vector2(), cur = new THREE.Vector2();
  const headBone = skeleton.bones[boneNames.indexOf('head')], hbIdx = boneNames.indexOf('head');
  const eyeBind = eye.clone(), m4 = new THREE.Matrix4(), tb = new THREE.Vector3();
  const mirroredX = (G as any).mirrored ? -1 : 1;
  let lastChange = -9, gazeLeft = 0, blinkNow = 0;
  const lidMorph = !!(G as { lidMorph?: boolean }).lidMorph;
  const tick = () => {
    const now = faceNow(); const dt = last < 0 ? 0 : Math.max(0, Math.min(0.1, now - last)); last = now;
    // blink
    // natural blinks: every 2-6 s, sometimes twice in a row
    if (blinkT < 0 && now > nextBlink) { blinkT = 0; blinkTwice = Math.random() < 0.2; nextBlink = now + 2 + Math.random() * 4; }
    let b = 0;
    if (blinkT >= 0) { blinkT += dt; const ms = blinkT * 1000, t = blinkT / 0.14;
      // a real blink: the lid drops fast (40 ms, accelerating), holds 20 ms, rises slower (80 ms, easing out)
      b = ms < 40 ? (ms / 40) ** 1.6 : ms < 60 ? 1 : Math.max(0, 1 - (1 - (1 - (ms - 60) / 80) ** 2)); if (t >= 1) { blinkT = blinkTwice ? -0.12 : -1; if (blinkTwice) { blinkTwice = false; } } }
    if (blinkT < -0.01 && blinkT > -0.5) { blinkT += dt; if (blinkT >= 0) blinkT = 0; }   // the second of a double blink, ~0.12 s later
    const bl = expr.blink >= 0 ? expr.blink : b; blinkNow = bl;
    face.blink.value = lidMorph ? 0 : bl;                              // geometric lids (head.py) close the eyes; else the shader draws them
    // gaze: a forced gaze, else the target, else idle glances (saccades: quick moves, then hold)
    let gx = 0, gy = 0;
    if (forced) { gx = forced.x; gy = forced.y; }
    else if (target && headBone) {
      m4.multiplyMatrices(headBone.matrixWorld, skeleton.boneInverses[hbIdx]).invert();   // world → bind
      tb.copy(target).applyMatrix4(m4).sub(eyeBind);
      gx = mirroredX * Math.atan2(tb.x, tb.z) / 0.6; gy = Math.atan2(tb.y, Math.hypot(tb.x, tb.z)) / 0.45;
    } else {
      if (now > nextGlance) { idleGaze.set(0, 0); /* no idle glances: at rest the real painted eyes show; lookAt / setGaze move them */ nextGlance = now + 0.8 + Math.random() * 2.2; }
      gx = idleGaze.x; gy = idleGaze.y;
    }
    gx = Math.max(-1, Math.min(1, gx)); gy = Math.max(-1, Math.min(1, gy));
    const k2 = 1 - Math.exp(-dt * 30);                                  // saccade: ~0.1 s
    // a big look-away gets a blink, as people do
    if (Math.abs(gx - lastGx) > 0.5 && blinkT < 0) { blinkT = 0; } lastGx = gx;
    cur.x += (gx - cur.x) * k2; cur.y += (gy - cur.y) * k2; face.gazeU.value.copy(cur); gazeLeft = Math.abs(gx - cur.x) + Math.abs(gy - cur.y);
    // speech: the current viseme (eased in and out), jaw motion with it, small nods on stressed vowels
    const tgt: Partial<Record<MK, number>> = {};
    if (speech.length && now < speechEnd && now >= speechT0) {
      const st = now - speechT0; let k = 0; while (k < speech.length - 1 && speech[k + 1].t <= st) k++;
      // the lips part along a smooth cut (head.py): the jaw drops for real while talking (jawOpen 1 ≈ 9 mm at the lower lip)
      // a voice clip's loudness (when given) scales the jaw: loud syllables open wider, quiet ones barely part the lips
      const loud = jawCurve ? 0.35 + 1.0 * (jawCurve[Math.min(jawCurve.length - 1, Math.floor(st * jawFps))] ?? 0) : 1;
      for (const [m_, w_] of Object.entries(VIS[speech[k].v] ?? {})) tgt[m_ as MK] = m_ === 'jawOpen' ? Math.min(0.8, w_ * talkK * 0.6 * loud) : Math.min(1.2, w_ * talkK);
      nodV += ((speech[k].v === 'A' || speech[k].v === 'O' ? 0.035 : 0) - nodV) * (1 - Math.exp(-dt * 6));
    } else nodV += (0 - nodV) * (1 - Math.exp(-dt * 4));
    {
      const talkingH = now < speechEnd;
      const amp = talkingH ? 1 : 0.35;                                  // idle: breathing sway and small drifts
      let tp = (talkingH ? 0.035 * nz(now, 1.3, 0.4) : 0.012 * Math.sin(now * 1.6)) + nodV * 1.2 + 0.05 * emph - 0.03 * lean;
      let ty = 0.1 * amp * nz(now, 0.45, 1.1), tr = 0.05 * amp * nz(now, 0.37, 2.3);
      emph *= Math.exp(-dt * 5); lean += ((talkingH ? lean : 0) - lean) * (1 - Math.exp(-dt * 1.5));
      if (!talkingH) { tp = tp * 0.6; }
      const w = 7, dts = Math.min(dt, 0.05);
      [hm.p, hm.vp] = spring(hm.p, hm.vp, tp, w, dts); [hm.y, hm.vy] = spring(hm.y, hm.vy, ty, w * 0.7, dts); [hm.r, hm.vr] = spring(hm.r, hm.vr, tr, w * 0.7, dts);
      browE += (emph * 0.8 - browE) * (1 - Math.exp(-dt * 10));
    }
    const kv = 1 - Math.exp(-dt * 22);
    for (const n of MORPHS) vis[n] += ((tgt[n] ?? 0) - vis[n]) * kv;
    const talkingNow = now < speechEnd + 0.15;
    for (const n of MORPHS) if (dict[n] !== undefined) {
      let v = expr[n] + vis[n] + (n === 'browUp' ? browE * 0.6 : 0) + (n === 'browDown' ? 0.15 * blinkNow : 0) + (n === 'smile' ? 0.06 * blinkNow : 0);   // brows drop a hair, cheeks lift, as the lids close
      if (talkingNow && (n === 'cornerLift' || n === 'unpout')) v *= 0.6;          // talking relaxes the rest shaping
      if (n === 'press' && (expr.jawOpen + vis.jawOpen) > 0.2) v = 0;
      infl[dict[n]] = Math.max(-1, Math.min(1.2, v));
    }
    // the mouth opens with the jaw (and a little with the smile); teeth show on a big grin or when open
    // (the painted mouth-inside reads as a zig-zag along the decimated lip seam; off until the mesh gets a real lip
    //  split with 3D teeth and a mouth cavity behind it)
    face.mouthOpen.value = MOUTH_INSIDE ? Math.min(1, expr.jawOpen + vis.jawOpen + Math.max(0, expr.smile - 0.6) * 0.5 + vis.wide * 0.15) : 0;
    face.teeth.value = Math.min(1, 0.4 + face.mouthOpen.value);
    // the geometric lids (both eyes in one morph, head.py) blink; without them the shader draws the lids
    if (dict.blink !== undefined) infl[dict.blink] = lidMorph ? blinkNow : 0;
    if (mouthParts) { const jo = expr.jawOpen + vis.jawOpen; mouthParts.lower.parent!.visible = jo > 0.02 || expr.smile > 0.85 || vis.wide > 0.05; }
    if (mouthParts) mouthParts.lower.position.copy(mouthParts.lowerBase).addScaledVector(mouthParts.jaw, Math.max(0, expr.jawOpen + vis.jawOpen) + 0.25 * vis.pucker);
  };
  mesh.onBeforeRender = tick;
  const ctl: FaceController = {
    // smile < 0 eases the portrait's own smile toward neutral
    setExpression(e) { for (const k3 of Object.keys(e) as (keyof Expression)[]) if (e[k3] !== undefined) { const v3 = k3 === 'blink' ? e[k3]! : Math.max(k3 === 'smile' ? -1 : 0, Math.min(1, e[k3]!)); if (Math.abs((expr as any)[k3] - v3) > 1e-3) lastChange = faceNow(); (expr as any)[k3] = v3; } },
    lookAt(t) { target = t ? t.clone() : null; },
    setGaze(x, y = 0) { forced = x === null ? null : new THREE.Vector2(x, y); },
    say(text, durationMs) {
      const chars = text.toLowerCase().split(''); const per = durationMs ? durationMs / 1000 / Math.max(1, chars.length) : 0.07;
      speech = []; let t = 0;
      for (const ch of chars) { const v = vOf(ch); speech.push({ t, v }); t += v === '_' ? (/[,.!?;:]/.test(ch) ? per * 3.5 : per * 1.4) : per; }
      speech.push({ t, v: '_' });
      speechT0 = faceNow(); speechEnd = speechT0 + t; jawCurve = null;
      emph = 1; lean = /[?!]/.test(text) ? 1 : 0.3;                  // an emphasis bob at the start, a lean in on ?/!
    },
    sayTimed(v, durationSec, jaw, fps = 30) {
      speech = v.filter(e => e && typeof e[0] === 'number').map(([t, x]) => ({ t, v: VIS[x] ? x : 'C' })).sort((a, b) => a.t - b.t);
      if (!speech.length || speech[0].t > 0) speech.unshift({ t: 0, v: '_' });
      speech.push({ t: durationSec, v: '_' });
      speechT0 = faceNow(); speechEnd = speechT0 + durationSec; jawCurve = jaw?.length ? jaw : null; jawFps = fps;
      emph = 1; lean = 0.3;
    },
    talking() { return faceNow() < speechEnd; },
    nod() { return nodV; },
    headMotion() { return { pitch: hm.p, yaw: hm.y, roll: hm.r }; },
    setTalkScale(k) { talkK = k; },
    tick() { tick(); },
    busy() { const now = faceNow(); return blinkT >= 0 || (blinkT < -0.01 && blinkT > -0.5) || now < speechEnd + 0.3 || now - lastChange < 0.8 || gazeLeft > 0.01; },
  };
  return { mesh, face: ctl };
  };
  const main = makeInstance(skeleton, root);
  const eyeBindPos = eye.clone();
  const makeBadge = () => {
    // a still skeleton (every bone at the origin, identity inverses): the head sits in its bind pose, in the group's space
    const group = new THREE.Group(); group.name = 'badge-head';
    const bones = boneNames.map(n => { const b = new THREE.Bone(); b.name = n; group.add(b); return b; });
    group.updateMatrixWorld(true);
    const inst = makeInstance(new THREE.Skeleton(bones), group);
    return { group, mesh: inst.mesh, face: inst.face, eye: eyeBindPos.clone() };
  };
  main.mesh.userData.makeBadge = makeBadge;
  return { mesh: main.mesh, seam, visor, tint: new THREE.Color(G.skinTint[0], G.skinTint[1], G.skinTint[2]), skin: { xform: G.skinXform, tone: G.seamTone }, face: main.face, makeBadge };
}

/** discard the MakeHuman skin above the seam (face, scalp, ears), keeping the neck and everything below.
 *  Works in bind space (the fabric shader's vB), so it holds through the swing. */
/** hair cards on the generated head's scalp: thousands of short strand strips, swept straight back with some length
 *  on top, short and tapered at the sides and back, flattened under a visor band. Bind space; the caller parents it. */
export function buildHairCards(head: GenHead, opts: { color: string; eye: THREE.Vector3; band?: { y: number }; count?: number }) {
  const g = head.mesh.geometry, P = g.getAttribute('position') as THREE.BufferAttribute, Nn = g.getAttribute('normal') as THREE.BufferAttribute;
  const Hm = g.getAttribute('hair') as THREE.BufferAttribute | undefined;
  if (!Hm) return null;
  const idx = g.getIndex()!.array;
  let seed = 11; const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  // strand alpha: a bundle of fine tapering strands
  const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d')!;
  for (let i = 0; i < 90; i++) {
    const x0 = 6 + rand() * 244, w = 0.8 + rand() * 1.8, len = 150 + rand() * 106, bend = (rand() - 0.5) * 16;
    const gr = x.createLinearGradient(0, 256, 0, 256 - len); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.7, 'rgba(255,255,255,.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    x.strokeStyle = gr; x.lineWidth = w; x.lineCap = 'round'; x.beginPath(); x.moveTo(x0, 256); x.quadraticCurveTo(x0 + bend, 256 - len / 2, x0 + bend * 1.6, 256 - len); x.stroke();
  }
  const alpha = new THREE.CanvasTexture(c); alpha.wrapS = alpha.wrapT = THREE.ClampToEdgeWrapping;
  // area-weighted roots where the scalp is hair
  const tris: number[] = [], cum: number[] = []; let tot = 0;
  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
  for (let i = 0; i < idx.length; i += 3) {
    const m = (Hm.getX(idx[i]) + Hm.getX(idx[i + 1]) + Hm.getX(idx[i + 2])) / (3 * 255); if (m < 0.55) continue;
    va.fromBufferAttribute(P, idx[i]); vb.fromBufferAttribute(P, idx[i + 1]); vc.fromBufferAttribute(P, idx[i + 2]);
    tot += vb.clone().sub(va).cross(vc.clone().sub(va)).length() / 2 * Math.min(1, (m - 0.55) / 0.3); tris.push(i); cum.push(tot);
  }
  if (!tris.length) return null;
  const e = opts.eye, base = new THREE.Color(opts.color), N = opts.count ?? 2600, SEG = 3;
  const pos: number[] = [], uv: number[] = [], col: number[] = [], nrmA: number[] = [], ind: number[] = [];
  const root = new THREE.Vector3(), nrm = new THREE.Vector3(), gdir = new THREE.Vector3(), side = new THREE.Vector3(), p = new THREE.Vector3(), tn = new THREE.Vector3();
  let skipped = 0;
  for (let k = 0; k < N; k++) {
    const r = rand() * tot; let lo = 0, hi = cum.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < r) lo = mid + 1; else hi = mid; }
    const i = tris[lo]; let u = rand(), v = rand(); if (u + v > 1) { u = 1 - u; v = 1 - v; }
    va.fromBufferAttribute(P, idx[i]); vb.fromBufferAttribute(P, idx[i + 1]); vc.fromBufferAttribute(P, idx[i + 2]);
    root.copy(va).multiplyScalar(1 - u - v).addScaledVector(vb, u).addScaledVector(vc, v);
    nrm.fromBufferAttribute(Nn, idx[i]).add(tn.fromBufferAttribute(Nn, idx[i + 1])).add(tn.fromBufferAttribute(Nn, idx[i + 2])).normalize();
    // the short back and sides below the band read better as the painted scalp: cards only from the band up
    if (root.y < (opts.band ? opts.band.y - 0.012 : e.y + 0.02)) { k--; if (++skipped > N * 20) break; continue; }
    const rel = root.clone().sub(e);
    // thinner at the crown (a little scalp shows), and thinning toward the temples
    if (rel.y > 0.1 && rel.z < -0.04 && rand() < 0.45) { k--; if (++skipped > N * 20) break; continue; }
    // no strays over the forehead: the front hairline is the painted one
    if (rel.z > -0.01 && rel.y < 0.085) { k--; if (++skipped > N * 20) break; continue; }
    // a natural, slightly receding front: bare temples, a lighter fringe
    if ((rel.z > -0.02 && Math.abs(rel.x) > 0.032 && rel.y < 0.105) || (rel.z > 0.0 && rand() < 0.5)) { k--; if (++skipped > N * 20) break; continue; }
    const top = THREE.MathUtils.smoothstep(rel.y, 0.045, 0.085);           // 0 at the sides and back, 1 on top
    const front = THREE.MathUtils.smoothstep(rel.z, -0.03, 0.02);          // the front of the top: pushed up and back
    // growth: straight back on top (and up off the forehead), down and back at the sides and nape
    gdir.set((rand() - 0.5) * 0.2, -1 + top * 0.95, -0.35 - top * 0.8);   // on top: straight back
    gdir.addScaledVector(nrm, -gdir.dot(nrm)).normalize();
    side.crossVectors(nrm, gdir).normalize();
    const under = opts.band && Math.abs(root.y - opts.band.y) < 0.022 ? 1 : 0;
    // lying fairly flat: modest length on top, a hair's lift off the scalp; a few fine stray strands break the outline
    const fine = rand() < 0.1 ? 1 : 0;
    const L = (0.006 + 0.014 * top * (0.7 + 0.3 * front)) * (0.7 + 0.6 * rand()) * (under ? 0.5 : 1) * (fine ? 1.4 : 1);
    const W = fine ? 0.0012 + 0.0008 * rand() : (0.0025 + 0.002 * rand()) * (0.7 + 0.3 * top);
    const lift = (0.0006 + 0.0015 * top * (0.6 + 0.4 * front)) * (under ? 0.1 : 1) + fine * 0.002 * top;
    const b0 = pos.length / 3, shade = 0.7 + 0.5 * rand();
    for (let s2 = 0; s2 <= SEG; s2++) {
      const t = s2 / SEG;
      // bend round the skull (radius ~9 cm) so the strand lies on the head instead of leaving it on a tangent
      p.copy(root).addScaledVector(gdir, L * t).addScaledVector(nrm, 0.001 + lift * Math.sin(t * Math.PI * 0.75) - (L * t) ** 2 / (2 * 0.09));
      const w = W * (1 - 0.4 * t);
      pos.push(p.x - side.x * w / 2, p.y - side.y * w / 2, p.z - side.z * w / 2, p.x + side.x * w / 2, p.y + side.y * w / 2, p.z + side.z * w / 2);
      const ux = rand() * 0.6; uv.push(ux, t, ux + 0.4, t);
      const cc = base.clone().multiplyScalar(shade * (0.75 + 0.35 * t));
      for (let q = 0; q < 2; q++) { col.push(cc.r, cc.g, cc.b); nrmA.push(nrm.x, nrm.y, nrm.z); }
    }
    for (let s2 = 0; s2 < SEG; s2++) { const q = b0 + s2 * 2; ind.push(q, q + 2, q + 1, q + 1, q + 2, q + 3); }
  }
  const cg = new THREE.BufferGeometry();
  cg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); cg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  cg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); cg.setAttribute('normal', new THREE.Float32BufferAttribute(nrmA, 3)); cg.setIndex(ind);
  const mat = new THREE.MeshStandardMaterial({ alphaMap: alpha, vertexColors: true, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.62 });
  const m = new THREE.Mesh(cg, mat); m.name = 'gen-hair'; m.castShadow = true; m.receiveShadow = true;
  return m;
}

export function hideAboveSeam(mat: THREE.Material, seam: { p: THREE.Vector3; n: THREE.Vector3 }, skin?: { xform?: number[][]; tone?: number[] }) {
  const prev = mat.onBeforeCompile.bind(mat), prevKey = mat.customProgramCacheKey.bind(mat);
  const f = (x: number) => x.toFixed(5);
  const X = skin?.xform, T = skin?.tone;
  mat.onBeforeCompile = (sh, r) => {
    prev(sh, r);
    const d = `dot(vB - vec3(${f(seam.p.x)}, ${f(seam.p.y)}, ${f(seam.p.z)}), vec3(${f(seam.n.x)}, ${f(seam.n.y)}, ${f(seam.n.z)}))`;
    sh.fragmentShader = sh.fragmentShader.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
      if (${d} > 0.0 && abs(vB.x) < 0.16 && vB.y > ${f(seam.p.y - 0.12)}) discard;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
      ${X ? `// the body's skin carried onto the head's tone (head.py: a Lab mean/spread transfer, as a linear-RGB affine)
      diffuseColor.rgb = max(mat3(${f(X[0][0])}, ${f(X[1][0])}, ${f(X[2][0])}, ${f(X[0][1])}, ${f(X[1][1])}, ${f(X[2][1])}, ${f(X[0][2])}, ${f(X[1][2])}, ${f(X[2][2])}) * diffuseColor.rgb + vec3(${f(X[0][3])}, ${f(X[1][3])}, ${f(X[2][3])}), 0.0);` : ''}
      ${T ? `{ // the top of the neck, just under the jaw: warmed and shaded toward the head's under-jaw tone
        float nd = ${d}; float nk = (1.0 - smoothstep(0.0, 0.03, -nd)) * step(nd, 0.0) * step(${f(seam.p.y - 0.08)}, vB.y) * step(abs(vB.x), 0.12);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${f(T[0])}, ${f(T[1])}, ${f(T[2])}), 0.55 * nk) * (1.0 - 0.12 * nk * nk);
      }` : ''}`)
      // the neck under the head shares the head's mostly-unlit look, fading out down the neck
      .replace('#include <opaque_fragment>', `{ float un = 0.65 * (1.0 - smoothstep(0.0, 0.1, -(${d}))) * step(${f(seam.p.y - 0.15)}, vB.y) * step(abs(vB.x), 0.13);
        outgoingLight = mix(outgoingLight, diffuseColor.rgb * vec3(1.0, 0.97, 0.94), un); }
      #include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => prevKey() + '-genhead';
}
