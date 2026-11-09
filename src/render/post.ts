// Post-processing: the "broadcast" look. Filmic tone mapping, a warm grade with lift/gamma/gain,
// gentle bloom on the sun and bright sky, ground-contact ambient occlusion on high, and a vignette.
//
//   low  : direct render (renderer tone mapping only) — the safe fallback for weak phones
//   med  : render → depth of field → bloom (half res) → output (tone map + sRGB) → grade + vignette → FXAA → sharpen
//   high : MSAA render → depth of field → GTAO → bloom → output → grade + vignette → sharpen
//
// med/high also run the hand-drawn realism finish (styles.ts HandDrawnPass) right after the scene render: ink contours,
// shadow hatching, paper grain, the face kept clean (setFace). ?style=real turns it off (setFinish('real')); low skips it.
//
// Depth of field is the broadcast "long lens" look, kept subtle: the golfer, the turf, the flags and the side
// trees stay sharp; only the far treeline and the hills soften a touch. Only background pixels are blurred and only background pixels feed the blur,
// so the golfer's silhouette never smears. setDof(0) turns it off (ball-flight cameras).
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { FXAAPass } from 'three/examples/jsm/postprocessing/FXAAPass.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { HandDrawnPass } from './styles';

export type Quality = 'low' | 'med' | 'high';
export type Grade = 'golden' | 'midday';
/** 'hand': the hand-drawn realism finish (styles.ts) on med/high; 'real': the plain realistic render */
export type Finish = 'hand' | 'real';

export interface PostOptions {
  quality?: Quality;
  grade?: Grade;
  /** 'agx' is softer and more filmic in the highlights; 'aces' is punchier */
  toneMapping?: 'agx' | 'aces';
  exposure?: number;
  finish?: Finish;
}

export interface Post {
  render(dt: number): void;
  setSize(w: number, h: number): void;
  setQuality(q: Quality): void;
  setGrade(g: Grade): void;
  /** depth of field: amount 0..1 (eased), sharp out to `start` metres, fully soft by `end` */
  setDof(amount: number, start?: number, end?: number): void;
  setFinish(f: Finish): void;
  /** the golfer's head (world), so the hand-drawn finish keeps the face clean; null for none */
  setFace(pos: THREE.Vector3 | null, radius?: number): void;
  readonly finish: Finish;
  readonly quality: Quality;
}

// background-only depth of field: a 16-tap golden-angle disc whose radius grows with view distance
const DofShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    resolution: { value: new THREE.Vector2(1, 1) },
    cameraNear: { value: 0.1 }, cameraFar: { value: 1000 },
    focusStart: { value: 40 }, focusEnd: { value: 160 },
    maxRadius: { value: 6 }, amount: { value: 1 },
  },
  vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
#include <packing>
uniform sampler2D tDiffuse; uniform sampler2D tDepth; uniform vec2 resolution;
uniform float cameraNear, cameraFar, focusStart, focusEnd, maxRadius, amount;
varying vec2 vUv;
float coc(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  float dist = d >= 0.99999 ? 1e6 : -perspectiveDepthToViewZ(d, cameraNear, cameraFar);
  // a gentle ease so the transition from sharp to soft has no visible band
  float t = clamp((dist - focusStart) / (focusEnd - focusStart), 0.0, 1.0);
  return amount * t * t * (3.0 - 2.0 * t);
}
void main() {
  vec4 c0 = texture2D(tDiffuse, vUv);
  float k0 = coc(vUv);
  if (k0 < 0.02) { gl_FragColor = c0; return; }
  float R = k0 * maxRadius;
  vec4 sum = c0; float wsum = 1.0;
  for (int i = 0; i < 16; i++) {
    float fi = float(i);
    float r = sqrt((fi + 0.5) / 16.0);
    float a = fi * 2.39996323;
    vec2 uv = vUv + vec2(cos(a), sin(a)) * r * R / resolution;
    float ks = coc(uv);
    // only background feeds the blur: a sharp golfer next to the background never bleeds into it
    float w = smoothstep(0.0, 0.25, ks);
    sum += texture2D(tDiffuse, uv) * w; wsum += w;
  }
  gl_FragColor = sum / wsum;
}`,
};

// contrast-adaptive sharpening (after AMD's CAS): sharpens fine detail (leaves, blades, the crest) more where the
// local contrast is low, less at hard edges, so it does not ring or crawl. 5 taps, cheap on phones.
const SharpenShader = {
  name: 'SharpenShader',
  uniforms: { tDiffuse: { value: null as THREE.Texture | null }, resolution: { value: new THREE.Vector2(1, 1) }, amount: { value: 0.55 } },
  vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
uniform sampler2D tDiffuse; uniform vec2 resolution; uniform float amount;
varying vec2 vUv;
void main() {
  vec2 px = 1.0 / resolution;
  vec4 e4 = texture2D(tDiffuse, vUv);
  vec3 e = e4.rgb;
  vec3 b = texture2D(tDiffuse, vUv + vec2(0.0, -px.y)).rgb, d = texture2D(tDiffuse, vUv + vec2(-px.x, 0.0)).rgb;
  vec3 f = texture2D(tDiffuse, vUv + vec2(px.x, 0.0)).rgb, h = texture2D(tDiffuse, vUv + vec2(0.0, px.y)).rgb;
  vec3 mn = min(e, min(min(b, d), min(f, h))), mx = max(e, max(max(b, d), max(f, h)));
  vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, 1e-4), 0.0, 1.0));
  vec3 w = -amp * mix(0.125, 0.2, amount);
  vec3 c = (e + (b + d + f + h) * w) / (1.0 + 4.0 * w);
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), e4.a);
}`,
};

class DofPass extends Pass {
  readonly uniforms: typeof DofShader.uniforms;
  private quad: FullScreenQuad;
  constructor(private camera: THREE.PerspectiveCamera) {
    super();
    this.uniforms = THREE.UniformsUtils.clone(DofShader.uniforms) as typeof DofShader.uniforms;
    this.quad = new FullScreenQuad(new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: DofShader.vertexShader, fragmentShader: DofShader.fragmentShader, depthTest: false, depthWrite: false }));
  }
  setSize(w: number, h: number) { this.uniforms.resolution.value.set(w, h); }
  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    const u = this.uniforms;
    u.tDiffuse.value = readBuffer.texture; u.tDepth.value = readBuffer.depthTexture;
    u.cameraNear.value = this.camera.near; u.cameraFar.value = this.camera.far;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
  dispose() { this.quad.material.dispose(); this.quad.dispose(); }
}

// display-space colour grade (runs after tone mapping, before AA)
const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    lift: { value: new THREE.Vector3() },
    gamma: { value: new THREE.Vector3(1, 1, 1) },
    gain: { value: new THREE.Vector3(1, 1, 1) },
    saturation: { value: 1 },
    contrast: { value: 0 },
    vignette: { value: 0.25 },
    aspect: { value: 1 },
    time: { value: 0 },
  },
  vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
uniform sampler2D tDiffuse; uniform vec3 lift; uniform vec3 gamma; uniform vec3 gain;
uniform float saturation; uniform float contrast; uniform float vignette; uniform float aspect; uniform float time;
varying vec2 vUv;
void main() {
  vec4 t = texture2D(tDiffuse, vUv);
  vec3 c = clamp(t.rgb, 0.0, 1.0);
  c = gain * (c + lift * (1.0 - c));
  c = pow(max(c, 0.0), 1.0 / gamma);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, saturation);
  // soft S-curve around mid grey
  c = mix(c, c * c * (3.0 - 2.0 * c), contrast);
  vec2 d = (vUv - 0.5) * vec2(aspect, 1.0);
  float v = smoothstep(1.05, 0.25, length(d) * (aspect > 1.0 ? 1.0 : 1.15));
  c *= mix(1.0, v, vignette);
  // a whisper of dither so gradients in the sky don't band
  float n = fract(sin(dot(vUv * 1000.0 + time, vec2(12.9898, 78.233))) * 43758.5453);
  c += (n - 0.5) / 255.0;
  gl_FragColor = vec4(c, t.a);
}`,
};

const GRADES: Record<Grade, { lift: [number, number, number]; gamma: [number, number, number]; gain: [number, number, number]; saturation: number; contrast: number; vignette: number; bloom: number; exposure: number }> = {
  // warm highlights, slightly lifted teal-ish shadows, a soft roll-off like broadcast golf at sunset
  golden: { lift: [0.008, 0.02, 0.036], gamma: [1.03, 1.0, 0.95], gain: [1.11, 1.03, 0.84], saturation: 1.16, contrast: 0.22, vignette: 0.3, bloom: 0.34, exposure: 1.12 },
  midday: { lift: [0.006, 0.008, 0.014], gamma: [1.0, 1.0, 1.0], gain: [1.02, 1.01, 0.98], saturation: 1.06, contrast: 0.14, vignette: 0.2, bloom: 0.22, exposure: 1.0 },
};

export function createPost(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, opts: PostOptions = {}): Post {
  let quality: Quality = opts.quality ?? 'med';
  let grade: Grade = opts.grade ?? 'golden';
  renderer.toneMapping = opts.toneMapping === 'aces' ? THREE.ACESFilmicToneMapping : THREE.AgXToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const size = new THREE.Vector2();
  renderer.getSize(size);

  let composer: EffectComposer | null = null;
  let bloom: UnrealBloomPass | null = null;
  let gradePass: ShaderPass | null = null;
  let dofPass: DofPass | null = null;
  let sharpPass: ShaderPass | null = null;
  let handPass: HandDrawnPass | null = null;
  let finish: Finish = opts.finish ?? 'hand';
  let face: { pos: THREE.Vector3; r: number } | null = null;
  const dof = { amount: 0, target: 0, start: 90, end: 420 };
  let time = 0;

  function applyGrade() {
    const G = GRADES[grade];
    renderer.toneMappingExposure = (opts.exposure ?? 1) * G.exposure;
    if (gradePass) {
      const u = gradePass.uniforms;
      u.lift.value.set(...G.lift); u.gamma.value.set(...G.gamma); u.gain.value.set(...G.gain);
      u.saturation.value = G.saturation; u.contrast.value = G.contrast; u.vignette.value = G.vignette;
    }
    if (bloom) bloom.strength = G.bloom;
  }

  function build() {
    composer?.dispose();
    composer = null; bloom = null; gradePass = null; dofPass = null; sharpPass = null; handPass?.dispose(); handPass = null;
    if (quality === 'low') { applyGrade(); return; }
    const pr = renderer.getPixelRatio();
    const rt = new THREE.WebGLRenderTarget(size.x * pr, size.y * pr, { type: THREE.HalfFloatType, samples: quality === 'high' ? 4 : 0 });
    composer = new EffectComposer(renderer, rt);
    composer.setPixelRatio(pr);
    composer.setSize(size.x, size.y);
    // the scene pass keeps its depth so depth of field can read it
    for (const t of [composer.renderTarget1, composer.renderTarget2]) {
      t.depthTexture = new THREE.DepthTexture(t.width, t.height);
      t.depthTexture.type = THREE.UnsignedIntType;
    }
    composer.addPass(new RenderPass(scene, camera));
    // hand-drawn finish straight after the scene render (needs the scene depth intact), before depth of field
    handPass = new HandDrawnPass(camera, quality === 'high' ? 'high' : 'med', () => renderer.toneMappingExposure);
    handPass.setSize(size.x * pr, size.y * pr, pr);
    handPass.enabled = finish === 'hand';
    if (face) handPass.setFace(face.pos, face.r);
    composer.addPass(handPass);
    dofPass = new DofPass(camera);
    // blur radius in render pixels: a subtle ~0.45% of the screen height at full strength (phones: ~3–5 px)
    dofPass.uniforms.maxRadius.value = Math.max(2.5, size.y * pr * 0.0045);
    dofPass.setSize(size.x * pr, size.y * pr);
    dofPass.enabled = dof.amount > 0.01;
    composer.addPass(dofPass);
    if (quality === 'high') {
      const ao = new GTAOPass(scene, camera, size.x * pr, size.y * pr);
      // subtle, local contact occlusion only (feet on turf, club on the ground, under the visor)
      ao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.4, thickness: 1.0, scale: 1.0, samples: 12, distanceFallOff: 1.0 });
      ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, radiusExponent: 1, rings: 2, samples: 12 });
      ao.blendIntensity = 0.7;
      composer.addPass(ao);
    }
    // bloom at half resolution: only the sun disc, sky near it and specular glints cross the threshold
    bloom = new UnrealBloomPass(new THREE.Vector2(size.x * pr * 0.5, size.y * pr * 0.5), 0.3, 0.18, 5.0);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    gradePass = new ShaderPass(GradeShader);
    gradePass.uniforms.aspect.value = size.x / size.y;
    composer.addPass(gradePass);
    if (quality === 'med') composer.addPass(new FXAAPass());
    sharpPass = new ShaderPass(SharpenShader);
    sharpPass.uniforms.resolution.value.set(size.x * pr, size.y * pr);
    sharpPass.uniforms.amount.value = (quality === 'high' ? 0.5 : 0.7) * (finish === 'hand' ? 0.5 : 1);
    composer.addPass(sharpPass);
    applyGrade();
  }
  build();

  return {
    get quality() { return quality; },
    get finish() { return finish; },
    setFinish(f) { if (f !== finish) { finish = f; build(); } },
    setFace(pos, radius = 0.14) { face = pos ? { pos: (face?.pos ?? new THREE.Vector3()).copy(pos), r: radius } : null; handPass?.setFace(pos, radius); },
    render(dt) {
      time += dt;
      if (!composer) { renderer.render(scene, camera); return; }
      if (gradePass) gradePass.uniforms.time.value = time % 100;
      // ease the depth of field in and out so camera cuts don't pop
      dof.amount += (dof.target - dof.amount) * (1 - Math.exp(-dt * 4));
      if (dofPass) {
        dofPass.enabled = dof.amount > 0.01;
        const u = dofPass.uniforms; u.amount.value = dof.amount; u.focusStart.value = dof.start; u.focusEnd.value = dof.end;
      }
      composer.render(dt);
    },
    setSize(w, h) {
      size.set(w, h);
      if (composer) {
        composer.setPixelRatio(renderer.getPixelRatio());
        composer.setSize(w, h);
        if (gradePass) gradePass.uniforms.aspect.value = w / h;
        const pr = renderer.getPixelRatio();
        if (dofPass) { dofPass.setSize(w * pr, h * pr); dofPass.uniforms.maxRadius.value = Math.max(2.5, h * pr * 0.0045); }
        if (sharpPass) sharpPass.uniforms.resolution.value.set(w * pr, h * pr);
        handPass?.setSize(w * pr, h * pr, pr);
      }
    },
    setQuality(q) { if (q !== quality) { quality = q; build(); } },
    setGrade(g) { grade = g; applyGrade(); },
    setDof(amount, start, end) {
      dof.target = THREE.MathUtils.clamp(amount, 0, 1);
      if (start !== undefined) dof.start = start;
      if (end !== undefined) dof.end = end;
      if (dof.amount === 0 && dof.target > 0 && time === 0) dof.amount = dof.target; // first frame: no fade-in
    },
  };
}
