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
  visor: { center: number[]; rx: number; rz: number; profile: number[] };
  tint: THREE.Color;
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
  g.setAttribute('eyeA', new THREE.BufferAttribute(eyeA, 4)); g.setAttribute('eyeB', new THREE.BufferAttribute(eyeB, 2));
  const t = new THREE.Texture(gh.tex); t.needsUpdate = true; t.flipY = true; t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  // the portrait already carries its own light and shade: a soft, slightly sheeny skin that doesn't add much more
  const mat = new THREE.MeshPhysicalMaterial({ map: t, roughness: 0.62, sheen: 0.3, sheenColor: new THREE.Color('#ff9a7a'), sheenRoughness: 0.55 });
  const face = { gaze: new THREE.Vector2(), blink: { value: 0 }, gazeU: { value: new THREE.Vector2() } };
  const irisCol = new THREE.Color(irisHex);
  mat.onBeforeCompile = sh => {
    sh.uniforms.uGaze = face.gazeU; sh.uniforms.uBlink = face.blink;
    sh.uniforms.uIris = { value: irisCol }; sh.uniforms.uLid = { value: new THREE.Color(G.skinColor[0], G.skinColor[1], G.skinColor[2]).convertSRGBToLinear().multiplyScalar(0.85) };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 eyeA; attribute vec2 eyeB; varying vec4 vEyeA; varying vec2 vEyeB;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEyeA = eyeA; vEyeB = eyeB;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec4 vEyeA; varying vec2 vEyeB; uniform vec2 uGaze; uniform float uBlink; uniform vec3 uIris; uniform vec3 uLid;')
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
          float corner = smoothstep(0.55, 1.0, abs(e.x));
          vec3 sclera = mix(vec3(0.80, 0.74, 0.70), vec3(0.62, 0.42, 0.38), corner);
          vec3 iris = uIris * (0.55 + 0.45 * smoothstep(1.0, 0.35, d)) * (0.9 + 0.2 * fract(sin(atan(q.y, q.x) * 23.0) * 43758.5));
          iris = mix(iris, vec3(0.02), smoothstep(0.42, 0.36, d));                      // pupil
          iris = mix(iris, uIris * 0.35, smoothstep(0.8, 1.0, d));                      // limbal ring
          vec3 eye = mix(iris, sclera, smoothstep(0.98, 1.04, d));
          eye *= 1.0 - 0.55 * smoothstep(-0.1, 0.9, e.y);                              // the upper lid's shadow
          eye += vec3(0.5) * smoothstep(0.12, 0.0, length(q - vec2(0.12, 0.10) * 0.475)); // catchlight
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
      if (now > nextGlance) { idleGaze.set((Math.random() - 0.5) * 0.9, (Math.random() - 0.5) * 0.4); if (Math.random() < 0.4) idleGaze.set(0, 0); nextGlance = now + 0.8 + Math.random() * 2.2; }
      gx = idleGaze.x; gy = idleGaze.y;
    }
    gx = Math.max(-1, Math.min(1, gx)); gy = Math.max(-1, Math.min(1, gy));
    const k2 = 1 - Math.exp(-dt * 30);                                  // saccade: ~0.1 s
    cur.x += (gx - cur.x) * k2; cur.y += (gy - cur.y) * k2; face.gazeU.value.copy(cur);
    for (const n of ['smile', 'grimace', 'browUp', 'browDown', 'jawOpen'] as const) if (dict[n] !== undefined) infl[dict[n]] = expr[n];
    if (dict.blink !== undefined) infl[dict.blink] = face.blink.value * 0.8;
  };
  const ctl: FaceController = {
    setExpression(e) { for (const k3 of Object.keys(e) as (keyof Expression)[]) if (e[k3] !== undefined) (expr as any)[k3] = k3 === 'blink' ? e[k3]! : Math.max(0, Math.min(1, e[k3]!)); },
    lookAt(t) { target = t ? t.clone() : null; },
    setGaze(x, y = 0) { forced = x === null ? null : new THREE.Vector2(x, y); },
  };
  return { mesh, seam, visor, tint: new THREE.Color(G.skinTint[0], G.skinTint[1], G.skinTint[2]), face: ctl };
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
