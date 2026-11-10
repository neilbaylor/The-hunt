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
  visor: { center: number[]; rx: number; rz: number; profile: number[]; opts?: { gap?: number; dilate?: boolean; droop?: number } };
  tint: THREE.Color;
  skin: { xform?: number[][]; tone?: number[] };
  face: FaceController;
}

export interface Expression { smile?: number; grimace?: number; browUp?: number; browDown?: number; jawOpen?: number; blink?: number }
export interface FaceController {
  /** expression weights 0..1 (smile adds to the portrait's own smile; blink overrides the idle blink) */
  setExpression(e: Expression): void;
  /** look at a world point (eyes only; null = idle glances) */
  lookAt(target: THREE.Vector3 | null): void;
  /** gaze directly: x = across (+ toward the golfer's left), y = up, each -1..1; null = back to idle */
  setGaze(x: number | null, y?: number): void;
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
  g.setAttribute('eyeA', new THREE.BufferAttribute(eyeA, 4)); g.setAttribute('eyeB', new THREE.BufferAttribute(eyeB, 2));
  const t = new THREE.Texture(gh.tex); t.needsUpdate = true; t.flipY = true; t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  // the portrait already carries its own light and shade: a soft, slightly sheeny skin that doesn't add much more
  // the same skin response as the body's skin (human.ts skinMat) so the head and neck don't differ in sheen
  // the texture carries his real (softened) shading from the photos: keep the real-time shading gentle so the two
  // don't stack into mud — matte, little sheen, a soft normal map, and a warm self-fill (below) that lifts the shadow side
  const mat = new THREE.MeshPhysicalMaterial({ map: t, roughness: 0.8, sheen: 0.1, sheenColor: new THREE.Color('#ff9a7a'), sheenRoughness: 0.6, specularIntensity: 0.25 });
  // surface detail baked from the hi-res generated head (ear folds, creases, hair), a JPEG inside head.bin
  if (G.arrays.normalJpg) {
    const jb = arr('normalJpg') as Uint8Array, nurl = URL.createObjectURL(new Blob([jb as BlobPart], { type: 'image/jpeg' })), nim = new Image();
    nim.onload = () => { const nt = new THREE.Texture(nim); nt.needsUpdate = true; nt.flipY = true; nt.anisotropy = 4; mat.normalMap = nt; mat.normalScale.set(0.3, 0.3); mat.needsUpdate = true; URL.revokeObjectURL(nurl); };
    nim.src = nurl;
  }
  const face = { gaze: new THREE.Vector2(), blink: { value: 0 }, gazeU: { value: new THREE.Vector2() }, fill: { value: 0.65 } };
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
  mat.onBeforeCompile = sh => {
    sh.uniforms.uGaze = face.gazeU; sh.uniforms.uBlink = face.blink;
    sh.uniforms.uIris = { value: irisCol }; sh.uniforms.uIrisTex = irisU; sh.uniforms.uSclera = { value: sclera }; sh.uniforms.uLid = { value: new THREE.Color(G.skinColor[0], G.skinColor[1], G.skinColor[2]).convertSRGBToLinear().multiplyScalar(0.85) };
    sh.uniforms.uFill = face.fill;
    // mostly the photo-baked texture itself (it already carries his real light and shade), a soft lit share for form
    sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', 'outgoingLight = mix(outgoingLight, diffuseColor.rgb * vec3(1.0, 0.97, 0.94), uFill);\n#include <opaque_fragment>');
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 eyeA; attribute vec2 eyeB; varying vec4 vEyeA; varying vec2 vEyeB;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEyeA = eyeA; vEyeB = eyeB;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec4 vEyeA; varying vec2 vEyeB; uniform vec2 uGaze; uniform float uBlink; uniform vec3 uIris; uniform vec3 uLid; uniform sampler2D uIrisTex; uniform vec3 uSclera; uniform float uFill;')
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
          float lidY = 1.0 - 2.05 * uBlink;
          float lid = smoothstep(lidY - 0.06, lidY + 0.06, e.y + 0.15 * e.x * e.x);
          vec3 lidc = uLid * (0.85 + 0.15 * smoothstep(1.0, 0.0, e.y));
          eye = mix(eye, lidc, lid);
          eye = mix(eye, vec3(0.06, 0.04, 0.035), (1.0 - smoothstep(0.0, 0.16, abs(e.y + 0.15 * e.x * e.x - lidY))) * step(0.02, uBlink + 0.02) * 0.9);
          diffuseColor.rgb = mix(diffuseColor.rgb, eye, inside);
        }
      }`);
  };
  mat.customProgramCacheKey = () => 'gen-head-eyes';
  const mesh = new THREE.SkinnedMesh(g, mat);
  mesh.name = 'gen-head'; mesh.castShadow = mesh.receiveShadow = true; mesh.frustumCulled = false;
  root.add(mesh); mesh.bind(skeleton);

  const seam = { p: place(new THREE.Vector3(...(G.seam.point as [number, number, number]))), n: new THREE.Vector3(...(G.seam.normal as [number, number, number])).normalize() };

  // visor fit on this head: radius round the head along the band (64 angles from the back), as build.py does
  let zmin = 9, zmax = -9, xmin = 9, xmax = -9;
  for (let i = 0; i < pos.length; i += 3) if (Math.abs(pos[i + 1] - visorY) < 0.006) { zmin = Math.min(zmin, pos[i + 2]); zmax = Math.max(zmax, pos[i + 2]); xmin = Math.min(xmin, pos[i]); xmax = Math.max(xmax, pos[i]); }
  const vc = new THREE.Vector3((xmin + xmax) / 2, visorY, (zmin + zmax) / 2);
  // the head's own cross-section along the band (its tilt: lower at the front, higher at the back), a robust outer
  // radius per angle (90th percentile, so a stray hair spike doesn't push it out); the band then sits 4 mm off it
  const prof: (number | null)[] = [];
  for (let s = 0; s < 64; s++) {
    const a = -Math.PI + (s / 64) * 2 * Math.PI, back = Math.max(0, -Math.cos(a)), front = Math.max(0, Math.cos(a));
    const yb = visorY - 0.006 * front - 0.012 * back;
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
  const visor = { center: [vc.x, vc.y, vc.z], rx: (xmax - xmin) / 2 + 0.0115, rz: (zmax - zmin) / 2 + 0.0125, profile: pr, opts: { gap: 0.004, dilate: false, droop: 0.28 } };

  // ── the face's life: idle blinks every 2–6 s (~120 ms), small glances, a look-at target, expressions ──
  mesh.updateMorphTargets();
  const infl = mesh.morphTargetInfluences ?? [], dict = mesh.morphTargetDictionary ?? {};
  const expr: Required<Expression> = { smile: 0, grimace: 0, browUp: 0, browDown: 0, jawOpen: 0, blink: -1 };
  let target: THREE.Vector3 | null = null, forced: THREE.Vector2 | null = null;
  let nextBlink = 1.5 + Math.random() * 3, blinkT = -1, nextGlance = 1, last = -1;
  const idleGaze = new THREE.Vector2(), cur = new THREE.Vector2();
  const headBone = skeleton.bones[boneNames.indexOf('head')], hbIdx = boneNames.indexOf('head');
  const eyeBind = eye.clone(), m4 = new THREE.Matrix4(), tb = new THREE.Vector3();
  const mirroredX = (G as any).mirrored ? -1 : 1;
  mesh.onBeforeRender = () => {
    const now = performance.now() / 1000, dt = last < 0 ? 0 : Math.min(0.1, now - last); last = now;
    // blink
    if (blinkT < 0 && now > nextBlink) { blinkT = 0; nextBlink = now + 2 + Math.random() * 4; }
    let b = 0;
    if (blinkT >= 0) { blinkT += dt; const t = blinkT / 0.12; b = t < 0.45 ? t / 0.45 : Math.max(0, 1 - (t - 0.45) / 0.55); if (t >= 1) blinkT = -1; }
    face.blink.value = expr.blink >= 0 ? expr.blink : b;
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
    cur.x += (gx - cur.x) * k2; cur.y += (gy - cur.y) * k2; face.gazeU.value.copy(cur);
    for (const n of ['smile', 'grimace', 'browUp', 'browDown', 'jawOpen'] as const) if (dict[n] !== undefined) infl[dict[n]] = expr[n];
    if (dict.blink !== undefined) infl[dict.blink] = face.blink.value * 0.8;
  };
  const ctl: FaceController = {
    // smile < 0 eases the portrait's own smile toward neutral
    setExpression(e) { for (const k3 of Object.keys(e) as (keyof Expression)[]) if (e[k3] !== undefined) (expr as any)[k3] = k3 === 'blink' ? e[k3]! : Math.max(k3 === 'smile' ? -1 : 0, Math.min(1, e[k3]!)); },
    lookAt(t) { target = t ? t.clone() : null; },
    setGaze(x, y = 0) { forced = x === null ? null : new THREE.Vector2(x, y); },
  };
  return { mesh, seam, visor, tint: new THREE.Color(G.skinTint[0], G.skinTint[1], G.skinTint[2]), skin: { xform: G.skinXform, tone: G.seamTone }, face: ctl };
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
