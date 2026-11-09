// Post-processing: the "broadcast" look. Filmic tone mapping, a warm grade with lift/gamma/gain,
// gentle bloom on the sun and bright sky, ground-contact ambient occlusion on high, and a vignette.
//
//   low  : direct render (renderer tone mapping only) — the safe fallback for weak phones
//   med  : render → bloom (half res) → output (tone map + sRGB) → grade + vignette → FXAA
//   high : MSAA render → GTAO → bloom → output → grade + vignette
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { FXAAPass } from 'three/examples/jsm/postprocessing/FXAAPass.js';

export type Quality = 'low' | 'med' | 'high';
export type Grade = 'golden' | 'midday';

export interface PostOptions {
  quality?: Quality;
  grade?: Grade;
  /** 'agx' is softer and more filmic in the highlights; 'aces' is punchier */
  toneMapping?: 'agx' | 'aces';
  exposure?: number;
}

export interface Post {
  render(dt: number): void;
  setSize(w: number, h: number): void;
  setQuality(q: Quality): void;
  setGrade(g: Grade): void;
  readonly quality: Quality;
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
  golden: { lift: [0.012, 0.016, 0.03], gamma: [1.02, 1.0, 0.97], gain: [1.06, 1.0, 0.9], saturation: 1.08, contrast: 0.18, vignette: 0.32, bloom: 0.3, exposure: 1.1 },
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
    composer = null; bloom = null; gradePass = null;
    if (quality === 'low') { applyGrade(); return; }
    const pr = renderer.getPixelRatio();
    const rt = new THREE.WebGLRenderTarget(size.x * pr, size.y * pr, { type: THREE.HalfFloatType, samples: quality === 'high' ? 4 : 0 });
    composer = new EffectComposer(renderer, rt);
    composer.setPixelRatio(pr);
    composer.setSize(size.x, size.y);
    composer.addPass(new RenderPass(scene, camera));
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
    applyGrade();
  }
  build();

  return {
    get quality() { return quality; },
    render(dt) {
      time += dt;
      if (!composer) { renderer.render(scene, camera); return; }
      if (gradePass) gradePass.uniforms.time.value = time % 100;
      composer.render(dt);
    },
    setSize(w, h) {
      size.set(w, h);
      if (composer) {
        composer.setPixelRatio(renderer.getPixelRatio());
        composer.setSize(w, h);
        if (gradePass) gradePass.uniforms.aspect.value = w / h;
      }
    },
    setQuality(q) { if (q !== quality) { quality = q; build(); } },
    setGrade(g) { grade = g; applyGrade(); },
  };
}
