// Hand-drawn / illustrated finishes over the realistic render. The scene keeps its real lighting and
// proportions; a single full-screen pass (two for the painterly look) adds ink, paint or print on top.
// That hides a lot: fabric weave, skin texture, hair detail and small modelling flaws turn into strokes.
//
//   scene → HDR target (+depth) → tone map (AgX) + grade → style pass → screen
//
// Every style is one cheap full-screen pass except Painterly (a Kuwahara filter); all run on phones.
import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

export type StyleId = 0 | 1 | 2 | 3 | 4 | 5;
export interface StyleInfo { id: StyleId; name: string; desc: string; hides: string }

export const STYLES: StyleInfo[] = [
  { id: 0, name: 'Realistic (current)', desc: 'The game as it renders today: tone-mapped and graded, no illustration.', hides: 'Nothing. Every texture and modelling flaw shows.' },
  { id: 1, name: 'Ink & Wash', desc: 'Real lighting with a soft watercolour wash, warm brown ink lines that thicken up close, and paper grain.', hides: 'Fine skin and fabric texture, small seams and tiling. The ink defines the face and body shapes.' },
  { id: 2, name: 'Painterly', desc: 'Oil-paint brushwork over the whole frame, crisp ink edges on the golfer so he stays sharp.', hides: 'Almost all surface detail: cloth weave, hair strands, turf noise and tree cards become paint.' },
  { id: 3, name: 'Sports Poster', desc: 'Three-tone cel shading with soft band edges, bold navy outlines and halftone dots in the shadows.', hides: 'Texture detail and subtle shape errors. Needs clean silhouettes, which we have.' },
  { id: 4, name: 'Gouache', desc: 'Flat opaque paint regions, visible brush direction, a warm palette and outlines tinted from the paint.', hides: 'Most texture and lighting noise. Faces read as a few planes of colour, which is forgiving.' },
  { id: 5, name: 'Graphic Novel', desc: 'Near-photoreal colour with cross-hatching in the shadows and thin ink contours.', hides: 'Shadow noise and flat-looking cloth; hatching adds form. Lit faces still show detail.' },
];

const VERT = /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// tone map + grade: linear HDR scene → display-referred sRGB
const TONE_FRAG = /* glsl */`
#include <common>
#include <tonemapping_pars_fragment>

uniform sampler2D tScene; varying vec2 vUv;
void main() {
  vec3 c = texture2D(tScene, vUv).rgb;
  c = AgXToneMapping(c);
  // warm golden-hour grade: lift the shadows a touch toward warm, gentle S-curve
  c = pow(max(c, 0.0), vec3(0.97, 1.0, 1.04));
  c = mix(c, c * c * (3.0 - 2.0 * c), 0.25);
  gl_FragColor = sRGBTransferOETF(vec4(c, 1.0));
}`;

// shared helpers for the style passes (input is sRGB display colour)
const COMMON = /* glsl */`
#include <packing>
uniform sampler2D tColor; uniform sampler2D tDepth; uniform vec2 res; uniform float cNear, cFar, px, time;
varying vec2 vUv;
float viewZ(vec2 uv) { float d = texture2D(tDepth, uv).x; return d >= 0.99999 ? 6000.0 : -perspectiveDepthToViewZ(d, cNear, cFar); }
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.07; a *= 0.5; } return s; }
// silhouette edges: relative depth jumps (scale-free, so far trees and the near golfer both outline)
float depthEdge(vec2 uv, float r) {
  vec2 o = r / res; float c = viewZ(uv);
  float a = viewZ(uv + vec2(o.x, 0.0)), b = viewZ(uv - vec2(o.x, 0.0)), d = viewZ(uv + vec2(0.0, o.y)), e = viewZ(uv - vec2(0.0, o.y));
  float m = min(min(a, b), min(d, e));
  float lap = abs(a + b + d + e - 4.0 * c) / max(c, 0.5);
  float jump = (c - m) / max(m, 0.5);
  return max(smoothstep(0.14, 0.32, jump), smoothstep(0.3, 0.6, lap));
}
// interior lines: luminance Sobel
float lumaEdge(vec2 uv, float r) {
  vec2 o = r / res;
  float tl = luma(texture2D(tColor, uv + vec2(-o.x, o.y)).rgb), t = luma(texture2D(tColor, uv + vec2(0.0, o.y)).rgb), tr = luma(texture2D(tColor, uv + o).rgb);
  float l = luma(texture2D(tColor, uv - vec2(o.x, 0.0)).rgb), rr = luma(texture2D(tColor, uv + vec2(o.x, 0.0)).rgb);
  float bl = luma(texture2D(tColor, uv - o).rgb), b = luma(texture2D(tColor, uv - vec2(0.0, o.y)).rgb), br = luma(texture2D(tColor, uv + vec2(o.x, -o.y)).rgb);
  float gx = -tl - 2.0 * l - bl + tr + 2.0 * rr + br, gy = -bl - 2.0 * b - br + tl + 2.0 * t + tr;
  return length(vec2(gx, gy));
}
vec3 blur5(vec2 uv, float r) { vec2 o = r / res; return (texture2D(tColor, uv).rgb * 2.0 + texture2D(tColor, uv + vec2(o.x, 0.0)).rgb + texture2D(tColor, uv - vec2(o.x, 0.0)).rgb + texture2D(tColor, uv + vec2(0.0, o.y)).rgb + texture2D(tColor, uv - vec2(0.0, o.y)).rgb) / 6.0; }
float localL(vec2 uv, float r) { vec2 o = r / res; float s = 0.0;
  for (int i = 0; i < 8; i++) { float a = float(i) * 0.785398; s += luma(texture2D(tColor, uv + vec2(cos(a), sin(a)) * o).rgb); }
  return s / 8.0; }
vec3 sat(vec3 c, float s) { return mix(vec3(luma(c)), c, s); }
// paper: fibres and tooth
float paper(vec2 p) { return 0.93 + 0.05 * fbm(p * 0.9) + 0.03 * vnoise(p * vec2(6.0, 0.6)) + 0.02 * hash(p); }
// how much line weight a pixel gets: heavy on the near golfer, light far away
float nearW(float z) { return 1.0 - smoothstep(6.0, 60.0, z); }
`;

const STYLE_FRAG: Record<Exclude<StyleId, 0>, string> = {
  // ── 1. Ink & Wash ──
  1: /* glsl */`
void main() {
  vec2 uv = vUv; vec2 p = uv * res / px;
  float z = viewZ(uv), nw = nearW(z);
  // wash: soften texture, slightly desaturate and pool pigment at edges of tone changes
  vec3 c = mix(texture2D(tColor, uv).rgb, blur5(uv, 2.5 * px), 0.75);
  c = sat(c, 0.82);
  c = 1.0 - (1.0 - c) * 0.9; // watercolour is transparent: lift toward the paper
  float bleed = fbm(p * 0.035 + 3.1);
  c *= 0.94 + 0.12 * bleed;
  // pigment pools darker at tone boundaries
  c *= 1.0 - 0.18 * smoothstep(0.08, 0.35, lumaEdge(uv, 3.0 * px));
  c = mix(c, vec3(0.98, 0.95, 0.88), 0.07 + 0.15 * smoothstep(80.0, 600.0, z)); // distance fades into the paper
  // ink: silhouettes + interior lines, line width wobbles like a nib
  float w = (1.0 + 0.6 * nw) * px * (0.85 + 0.3 * vnoise(p * 0.08));
  float de = depthEdge(uv, w);
  float le = smoothstep(0.22, 0.55, lumaEdge(uv, w)) * (0.25 + 0.75 * nw);
  float ink = clamp(max(de * (0.35 + 0.65 * nw), le * 0.8), 0.0, 1.0);
  ink *= 0.7 + 0.3 * vnoise(p * 0.35);
  c = mix(c, vec3(0.17, 0.12, 0.09), ink * 0.9);
  c *= paper(p);
  gl_FragColor = vec4(c, 1.0);
}`,
  // ── 2. Painterly (Kuwahara + crisp near outlines) ──
  2: /* glsl */`
vec3 kuwa(vec2 uv, float r) {
  vec2 o = 1.0 / res;
  vec3 m[4]; vec3 s[4];
  for (int k = 0; k < 4; k++) { m[k] = vec3(0.0); s[k] = vec3(0.0); }
  for (int j = -3; j <= 3; j++) for (int i = -3; i <= 3; i++) {
    vec3 c = texture2D(tColor, uv + vec2(float(i), float(j)) * o * r).rgb;
    vec3 c2 = c * c;
    if (i <= 0 && j <= 0) { m[0] += c; s[0] += c2; }
    if (i >= 0 && j <= 0) { m[1] += c; s[1] += c2; }
    if (i <= 0 && j >= 0) { m[2] += c; s[2] += c2; }
    if (i >= 0 && j >= 0) { m[3] += c; s[3] += c2; }
  }
  float best = 1e9; vec3 outc = vec3(0.0);
  for (int k = 0; k < 4; k++) {
    vec3 mu = m[k] / 16.0; vec3 v = abs(s[k] / 16.0 - mu * mu);
    float sv = v.r + v.g + v.b;
    if (sv < best) { best = sv; outc = mu; }
  }
  return outc;
}
void main() {
  vec2 uv = vUv; vec2 p = uv * res / px;
  float z = viewZ(uv), nw = nearW(z);
  // brush size: bigger strokes far away, finer on the golfer
  float r = px * mix(2.6, 1.15, nw);
  vec3 c = kuwa(uv, r);
  c = sat(c, 1.08);
  // canvas weave
  float weave = 0.5 + 0.5 * sin(p.x * 1.9) * sin(p.y * 1.9);
  c *= 0.965 + 0.045 * weave;
  // impasto: lighten stroke ridges a touch along the paint's luminance gradient
  float le = lumaEdge(uv, r);
  c += 0.025 * smoothstep(0.05, 0.3, le) * (vnoise(p * 0.5) - 0.5);
  // crisp dark edge only on near objects (the golfer, ball, club)
  float de = depthEdge(uv, px) * smoothstep(12.0, 5.0, z);
  c = mix(c, vec3(0.12, 0.1, 0.09), de * 0.85);
  gl_FragColor = vec4(c, 1.0);
}`,
  // ── 3. Sports Poster: cel bands + halftone + bold outlines ──
  3: /* glsl */`
void main() {
  vec2 uv = vUv; vec2 p = uv * res / px;
  float z = viewZ(uv), nw = nearW(z);
  vec3 base = blur5(uv, 1.5 * px);
  float L = luma(base);
  vec3 chroma = base / max(L, 0.02);
  // three soft-edged value bands (shadow / mid / light) plus a highlight band
  float q = 0.18 + 0.32 * smoothstep(0.24, 0.3, L) + 0.28 * smoothstep(0.5, 0.56, L) + 0.18 * smoothstep(0.8, 0.86, L);
  float keep = smoothstep(200.0, 1500.0, z); // sky and far hills stay smooth gradients
  vec3 c = mix(mix(chroma * q, base, 0.35), base, keep * 0.85);
  // halftone dots where it's in shadow relative to its surroundings (cast shadows, folds, under the arms)
  vec2 hp = mat2(0.7071, -0.7071, 0.7071, 0.7071) * p / 3.6;
  float shade = L / max(localL(uv, 14.0 * px), 0.03);
  float dotR = (1.0 - smoothstep(0.55, 0.85, shade)) * 0.4;
  float dotv = 1.0 - smoothstep(dotR - 0.08, dotR, length(fract(hp) - 0.5));
  c = mix(c, c * 0.45, dotv * (1.0 - keep));
  // bold outlines, heavier near
  float w = (1.2 + 1.3 * nw) * px;
  float de = depthEdge(uv, w);
  float le = smoothstep(0.35, 0.7, lumaEdge(uv, px)) * nw;
  c = mix(c, vec3(0.06, 0.09, 0.2), clamp(max(de * (0.3 + 0.7 * nw), le * 0.7), 0.0, 1.0));
  gl_FragColor = vec4(c, 1.0);
}`,
  // ── 4. Gouache: flat opaque paint, brush direction, warm palette, tinted outlines ──
  4: /* glsl */`
void main() {
  vec2 uv = vUv; vec2 p = uv * res / px;
  float z = viewZ(uv), nw = nearW(z);
  // flatten: average a small cross then pull values toward 6 soft steps
  vec3 b = (blur5(uv, 2.5 * px) + blur5(uv, 5.0 * px) + blur5(uv, 1.2 * px)) / 3.0;
  float L = luma(b);
  float steps = 5.0, Lq = (floor(L * steps) + smoothstep(0.35, 0.65, fract(L * steps))) / steps;
  vec3 c = b / max(L, 0.02) * mix(L, Lq, 0.75);
  // warm palette: shadows toward plum-brown, lights toward cream
  c = mix(c, c * vec3(0.92, 0.82, 0.86), 1.0 - smoothstep(0.15, 0.5, L));
  c = mix(c, c * vec3(1.06, 1.02, 0.9), smoothstep(0.55, 0.9, L));
  c = sat(c, 1.05);
  // brush strokes: short streaks, direction follows the screen-space value gradient's normal
  vec2 o = 2.0 * px / res;
  vec2 g = vec2(luma(texture2D(tColor, uv + vec2(o.x, 0.0)).rgb) - luma(texture2D(tColor, uv - vec2(o.x, 0.0)).rgb),
                luma(texture2D(tColor, uv + vec2(0.0, o.y)).rgb) - luma(texture2D(tColor, uv - vec2(0.0, o.y)).rgb));
  vec2 dir = length(g) > 1e-3 ? normalize(vec2(-g.y, g.x)) : vec2(0.7071, 0.7071);
  vec2 bp = vec2(dot(p, dir), dot(p, vec2(-dir.y, dir.x)));
  float stroke = vnoise(bp * vec2(0.06, 0.55));
  c *= 0.9 + 0.2 * stroke;
  // outlines tinted from the paint (a darker, richer version of the local colour)
  float de = depthEdge(uv, (1.0 + nw) * px);
  c = mix(c, sat(c, 1.4) * 0.35, de * (0.25 + 0.6 * nw));
  // paper showing through at the frame edges
  c *= paper(p) + 0.02;
  gl_FragColor = vec4(c, 1.0);
}`,
  // ── 5. Graphic Novel: photoreal colour, cross-hatched shadows, thin ink ──
  5: /* glsl */`
float hatch(vec2 p, float ang, float spacing, float width) {
  vec2 d = vec2(cos(ang), sin(ang));
  float v = dot(p, d) / spacing + 0.35 * vnoise(p * 0.05);
  return 1.0 - smoothstep(width - 0.12, width + 0.12, abs(fract(v) - 0.5) * 2.0);
}
void main() {
  vec2 uv = vUv; vec2 p = uv * res / px;
  float z = viewZ(uv), nw = nearW(z);
  vec3 c = texture2D(tColor, uv).rgb;
  c = mix(c, blur5(uv, 1.2 * px), 0.5);
  c = sat(c, 0.95);
  c = (c - 0.5) * 1.08 + 0.5; // a little contrast
  float L = luma(blur5(uv, 1.5 * px));
  float keep = smoothstep(150.0, 900.0, z);
  float shade = L / max(localL(uv, 16.0 * px), 0.03);
  float h1 = hatch(p, 0.785, 3.4, 0.2) * (1.0 - smoothstep(0.7, 0.92, shade));
  float h2 = hatch(p, -0.785, 3.4, 0.2) * (1.0 - smoothstep(0.45, 0.7, shade));
  float h3 = hatch(p, 0.2, 2.8, 0.2) * (1.0 - smoothstep(0.08, 0.16, L));
  float h = max(max(h1, h2), h3) * (1.0 - keep);
  c = mix(c, c * 0.25 + vec3(0.02, 0.02, 0.04), h * 0.85);
  float de = depthEdge(uv, px * (0.9 + 0.5 * nw));
  float le = smoothstep(0.3, 0.65, lumaEdge(uv, px)) * nw;
  c = mix(c, vec3(0.05, 0.05, 0.07), clamp(max(de * (0.4 + 0.6 * nw), le * 0.55), 0.0, 1.0));
  gl_FragColor = vec4(c, 1.0);
}`,
};

export interface Styler {
  render(): void;
  setSize(w: number, h: number): void;
  setStyle(id: StyleId): void;
  readonly style: StyleId;
}

export function createStyler(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, initial: StyleId = 1): Styler {
  renderer.toneMapping = THREE.NoToneMapping;
  const size = new THREE.Vector2();
  const pr = () => renderer.getPixelRatio();
  renderer.getSize(size);
  const W = () => Math.max(1, Math.round(size.x * pr())), H = () => Math.max(1, Math.round(size.y * pr()));
  const depth = new THREE.DepthTexture(W(), H()); depth.type = THREE.FloatType;
  const rtScene = new THREE.WebGLRenderTarget(W(), H(), { type: THREE.HalfFloatType, depthTexture: depth });
  const rtLDR = new THREE.WebGLRenderTarget(W(), H(), { type: THREE.UnsignedByteType });
  const tone = new FullScreenQuad(new THREE.ShaderMaterial({
    uniforms: { tScene: { value: rtScene.texture }, toneMappingExposure: { value: 1.0 } },
    vertexShader: VERT, fragmentShader: TONE_FRAG, depthTest: false, depthWrite: false,
  }));
  const mats = new Map<StyleId, THREE.ShaderMaterial>();
  const matFor = (id: Exclude<StyleId, 0>) => {
    let m = mats.get(id);
    if (!m) {
      m = new THREE.ShaderMaterial({
        uniforms: { tColor: { value: rtLDR.texture }, tDepth: { value: depth }, res: { value: new THREE.Vector2(W(), H()) }, cNear: { value: camera.near }, cFar: { value: camera.far }, px: { value: pr() }, time: { value: 0 } },
        vertexShader: VERT, fragmentShader: COMMON + STYLE_FRAG[id], depthTest: false, depthWrite: false,
      });
      mats.set(id, m);
    }
    return m;
  };
  const quad = new FullScreenQuad();
  const copy = new THREE.ShaderMaterial({ uniforms: { tColor: { value: rtLDR.texture } }, vertexShader: VERT, fragmentShader: 'uniform sampler2D tColor; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tColor, vUv); }', depthTest: false, depthWrite: false });
  let style = initial;
  const clock = new THREE.Clock();
  return {
    get style() { return style; },
    setStyle(id) { style = id; },
    setSize(w, h) {
      size.set(w, h);
      rtScene.setSize(W(), H()); rtLDR.setSize(W(), H());
      depth.image.width = W(); depth.image.height = H();
      for (const m of mats.values()) { m.uniforms.res.value.set(W(), H()); m.uniforms.px.value = pr(); }
    },
    render() {
      renderer.setRenderTarget(rtScene); renderer.render(scene, camera);
      renderer.setRenderTarget(rtLDR); tone.render(renderer);
      renderer.setRenderTarget(null);
      if (style === 0) { quad.material = copy; }
      else { const m = matFor(style); m.uniforms.cNear.value = camera.near; m.uniforms.cFar.value = camera.far; m.uniforms.time.value = clock.getElapsedTime(); quad.material = m; }
      quad.render(renderer);
    },
  };
}
