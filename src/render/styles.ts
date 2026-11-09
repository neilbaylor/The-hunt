// Hand-drawn / illustrated finishes over the realistic render. The scene keeps its real lighting and
// proportions; a single full-screen pass (two for the painterly look) adds ink, paint or print on top.
// That hides a lot: fabric weave, skin texture, hair detail and small modelling flaws turn into strokes.
//
//   scene → HDR target (+depth) → tone map (AgX) + grade → style pass → screen
//
// Every style is one cheap full-screen pass except Painterly (a Kuwahara filter); all run on phones.
import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';

export type StyleId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export interface StyleInfo { id: StyleId; name: string; desc: string; hides: string }

export const STYLES: StyleInfo[] = [
  { id: 0, name: 'Realistic (current)', desc: 'The game as it renders today: tone-mapped and graded, no illustration.', hides: 'Nothing. Every texture and modelling flaw shows.' },
  { id: 9, name: 'Coloured Pencil', desc: 'Realistic proportions and soft light, drawn in coloured pencil on white paper: grain that fills in with the tone, directional hatching in the darks, a light brown contour.', hides: 'Skin and fabric texture flaws and blotchy shading; strokes carry the form like a hand-drawn portrait.' },
  { id: 7, name: 'Graphic Realism · Light', desc: 'The realistic render with a light hand-drawn finish: fine ink contours with weight variation, a touch of hatching in the deepest shadows, faint paper grain.', hides: 'Blotchy fabric shading and texture noise; edges read cleaner. Faces stay photographic.' },
  { id: 8, name: 'Graphic Realism · Medium', desc: 'Same, pushed further: stronger contours and interior lines, cross-hatching in shadows, crisper highlights, visible paper.', hides: 'Most fabric and turf texture flaws and some modelling softness; the face reads as a drawn portrait.' },
  { id: 1, name: 'Ink & Wash', desc: 'Real lighting with a soft watercolour wash, warm brown ink lines that thicken up close, and paper grain.', hides: 'Fine skin and fabric texture, small seams and tiling. The ink defines the face and body shapes.' },
  { id: 2, name: 'Painterly', desc: 'Oil-paint brushwork over the whole frame, crisp ink edges on the golfer so he stays sharp.', hides: 'Almost all surface detail: cloth weave, hair strands, turf noise and tree cards become paint.' },
  { id: 3, name: 'Sports Poster', desc: 'Three-tone cel shading with soft band edges, bold navy outlines and halftone dots in the shadows.', hides: 'Texture detail and subtle shape errors. Needs clean silhouettes, which we have.' },
  { id: 4, name: 'Gouache', desc: 'Flat opaque paint regions, visible brush direction, a warm palette and outlines tinted from the paint.', hides: 'Most texture and lighting noise. Faces read as a few planes of colour, which is forgiving.' },
  { id: 6, name: 'Cover Art', desc: 'Sports-game cover illustration: flat, saturated colour in a few clean bands, crisp black contours and a bright rim on the edges.', hides: 'Almost all texture; the face reads from its big features (hair shape, nose, jaw, smile), not skin detail.' },
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
float nearW(float z) { return 1.0 - smoothstep(6.0, 60.0, z); }
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
// 4-sector Kuwahara (7x7 taps, spacing r px): flattens texture into paint-like regions, keeps edges
vec3 kuwa(vec2 uv, float r) {
  vec2 o = r / res; vec3 m0 = vec3(0.0), m1 = vec3(0.0), m2 = vec3(0.0), m3 = vec3(0.0), s0 = vec3(0.0), s1 = vec3(0.0), s2 = vec3(0.0), s3 = vec3(0.0);
  for (int j = -3; j <= 3; j++) for (int i = -3; i <= 3; i++) {
    vec3 c = texture2D(tColor, uv + vec2(float(i), float(j)) * o).rgb, c2 = c * c;
    if (i <= 0 && j <= 0) { m0 += c; s0 += c2; } if (i >= 0 && j <= 0) { m1 += c; s1 += c2; }
    if (i <= 0 && j >= 0) { m2 += c; s2 += c2; } if (i >= 0 && j >= 0) { m3 += c; s3 += c2; }
  }
  m0 /= 16.0; m1 /= 16.0; m2 /= 16.0; m3 /= 16.0;
  vec3 v0 = abs(s0 / 16.0 - m0 * m0), v1 = abs(s1 / 16.0 - m1 * m1), v2 = abs(s2 / 16.0 - m2 * m2), v3 = abs(s3 / 16.0 - m3 * m3);
  float a = v0.r + v0.g + v0.b, b = v1.r + v1.g + v1.b, c = v2.r + v2.g + v2.b, d = v3.r + v3.g + v3.b;
  vec3 outc = m0; float best = a;
  if (b < best) { best = b; outc = m1; } if (c < best) { best = c; outc = m2; } if (d < best) { outc = m3; }
  return outc;
}
// paper grain
float paper(vec2 p) { return 0.9 + 0.07 * fbm(p * 0.7) + 0.04 * vnoise(p * vec2(6.0, 0.6)) + 0.03 * hash(p); }
// silhouettes for the graphic-realism styles: only the near subject and big breaks (trees against sky),
// so gentle terrain steps like the tee-box edge never draw a line
float silhouette(vec2 uv, float r) {
  vec2 o = r / res; float c = viewZ(uv);
  float a = viewZ(uv + vec2(o.x, 0.0)), b = viewZ(uv - vec2(o.x, 0.0)), d = viewZ(uv + vec2(0.0, o.y)), e = viewZ(uv - vec2(0.0, o.y));
  float m = min(min(a, b), min(d, e)), jump = (c - m) / max(m, 0.3);
  float gate = max(smoothstep(7.5, 5.0, m), smoothstep(0.5, 0.9, jump));
  return smoothstep(0.1, 0.28, jump) * gate;
}
float skinMask(vec3 c) { // warm skin tones: r > g > b with moderate saturation
  float r = c.r, g = c.g, b = c.b;
  return smoothstep(0.03, 0.09, r - g) * smoothstep(0.0, 0.05, g - b) * smoothstep(0.15, 0.3, r);
}
vec3 graphicRealism(vec2 uv, float S, float crossH) {
  vec2 p = uv * res / px;
  float z = viewZ(uv), nw = nearW(z), near = smoothstep(14.0, 3.0, z);
  vec3 c0 = texture2D(tColor, uv).rgb;
  // de-blotch: edge-preserving smoothing on the near subject removes noisy fabric shading
  vec3 c = mix(c0, kuwa(uv, 0.9 * px), near * (0.45 + 0.35 * S));
  float L = luma(c);
  // lift crushed shadows (no black blotches in folds), crisp highlights, a little contrast
  c += (1.0 - c) * (0.05 + 0.05 * S) * (1.0 - smoothstep(0.0, 0.3, L));
  c = sat(c, 1.0 - 0.06 * S);
  c = (c - 0.5) * (1.0 + 0.1 * S) + 0.5;
  c += 0.07 * S * smoothstep(0.72, 0.95, L);
  // hatching in shadows, relative to the surroundings; light on skin so faces stay clean
  float shade = luma(blur5(uv, 1.5 * px)) / max(localL(uv, 16.0 * px), 0.03);
  float sk = skinMask(c0);
  vec2 d1 = vec2(0.7071, 0.7071), d2 = vec2(0.7071, -0.7071);
  float wob = 0.3 * vnoise(p * 0.05);
  float h1 = 1.0 - smoothstep(0.12, 0.3, abs(fract(dot(p, d1) / 3.2 + wob) - 0.5) * 2.0);
  float h2 = 1.0 - smoothstep(0.12, 0.3, abs(fract(dot(p, d2) / 3.2 + wob) - 0.5) * 2.0);
  float t1 = 1.0 - smoothstep(0.55, 0.82, shade), t2 = (1.0 - smoothstep(0.35, 0.58, shade)) * crossH;
  float h = max(h1 * t1, h2 * t2) * (1.0 - smoothstep(25.0, 90.0, z)) * (1.0 - 0.7 * sk);
  c = mix(c, c * 0.35, h * (0.35 + 0.4 * S));
  // ink: contour weight swells and tapers; interior lines only where tone breaks sharply
  float w = (0.9 + 0.9 * S + 0.8 * near) * px * (0.75 + 0.5 * vnoise(p * 0.07));
  float de = silhouette(uv, w);
  float le = smoothstep(0.3 - 0.08 * S, 0.62 - 0.1 * S, lumaEdge(uv, px)) * near * (0.35 + 0.5 * S) * (1.0 - 0.5 * sk);
  float ink = clamp(max(de, le), 0.0, 1.0) * (0.8 + 0.2 * vnoise(p * 0.4));
  c = mix(c, vec3(0.07, 0.06, 0.06), ink * (0.7 + 0.25 * S));
  c *= mix(1.0, paper(p), 0.35 + 0.45 * S);
  return c;
}
// paper: fibres and tooth
// how much line weight a pixel gets: heavy on the near golfer, light far away
`;

const STYLE_FRAG: Record<Exclude<StyleId, 0>, string> = {
  // ── 1. Ink & Wash: transparent wash, misregistered colour, bold nib lines, cold-press paper ──
  1: /* glsl */`
void main() {
  vec2 uv = vUv; vec2 p = uv * res / px;
  float z = viewZ(uv), nw = nearW(z);
  // colour floats a little off the line work, like a wash laid over an ink drawing
  vec2 drift = (vec2(fbm(p * 0.02), fbm(p * 0.02 + 7.0)) - 0.5) * 6.0 * px / res;
  vec3 c = kuwa(uv + drift, 1.2 * px);
  c = sat(c, 0.8);
  c = 1.0 - (1.0 - c) * 0.82;
  c *= 0.9 + 0.2 * fbm(p * 0.03 + 3.1);                        // uneven pigment
  c *= 1.0 - 0.3 * smoothstep(0.06, 0.3, lumaEdge(uv, 3.0 * px)); // pigment pools at tone edges
  c = mix(c, vec3(0.97, 0.94, 0.86), 0.1 + 0.3 * smoothstep(60.0, 500.0, z));
  float w = (1.5 + 1.6 * nw) * px * (0.75 + 0.5 * vnoise(p * 0.06));
  float de = depthEdge(uv, w);
  float le = smoothstep(0.18, 0.45, lumaEdge(uv, w * 0.8)) * (0.2 + 0.8 * nw);
  float ink = clamp(max(de * (0.35 + 0.65 * nw), le), 0.0, 1.0) * (0.75 + 0.25 * vnoise(p * 0.4));
  c = mix(c, vec3(0.16, 0.1, 0.07), ink * 0.95);
  c *= paper(p * 0.8);
  gl_FragColor = vec4(c, 1.0);
}`,
  // ── 2. Painterly: big oil strokes, canvas, crisp edge on the near subject ──
  2: /* glsl */`
void main() {
  vec2 uv = vUv; vec2 p = uv * res / px;
  float z = viewZ(uv), nw = nearW(z);
  float r = px * mix(3.2, 1.7, nw);
  vec3 c = kuwa(uv, r);
  c = sat(c, 1.12);
  // stroke direction from the paint's own gradient, streaked texture along it
  vec2 o = 2.0 * px / res;
  vec2 g = vec2(luma(texture2D(tColor, uv + vec2(o.x, 0.0)).rgb) - luma(texture2D(tColor, uv - vec2(o.x, 0.0)).rgb),
                luma(texture2D(tColor, uv + vec2(0.0, o.y)).rgb) - luma(texture2D(tColor, uv - vec2(0.0, o.y)).rgb));
  vec2 dir = length(g) > 1e-3 ? normalize(vec2(-g.y, g.x)) : vec2(0.7071, 0.7071);
  vec2 bp = vec2(dot(p, dir), dot(p, vec2(-dir.y, dir.x)));
  c *= 0.9 + 0.2 * vnoise(bp * vec2(0.08, 0.9));
  c *= 0.94 + 0.08 * (0.5 + 0.5 * sin(p.x * 1.6) * sin(p.y * 1.6)); // canvas weave
  float de = depthEdge(uv, 1.3 * px) * smoothstep(14.0, 4.0, z);
  c = mix(c, vec3(0.1, 0.08, 0.07), de * 0.85);
  gl_FragColor = vec4(c, 1.0);
}`,
  // ── 3. Sports Poster: flat cel bands, heavy navy outline, big halftone ──
  3: /* glsl */`
void main() {
  vec2 uv = vUv; vec2 p = uv * res / px;
  float z = viewZ(uv), nw = nearW(z);
  vec3 base = kuwa(uv, 1.0 * px);
  float L = luma(base);
  vec3 chroma = base / max(L, 0.02);
  float q = 0.2 + 0.36 * smoothstep(0.26, 0.29, L) + 0.3 * smoothstep(0.52, 0.55, L) + 0.16 * smoothstep(0.82, 0.85, L);
  float keep = smoothstep(200.0, 1500.0, z);
  vec3 c = mix(mix(chroma * q, base, 0.15), base, keep * 0.85);
  vec2 hp = mat2(0.7071, -0.7071, 0.7071, 0.7071) * p / 4.6;
  float shade = L / max(localL(uv, 14.0 * px), 0.03);
  float dotR = max(1.0 - smoothstep(0.55, 0.85, shade), 1.0 - smoothstep(0.1, 0.3, L)) * 0.45;
  float dotv = 1.0 - smoothstep(dotR - 0.07, dotR, length(fract(hp) - 0.5));
  c = mix(c, vec3(0.08, 0.12, 0.28), dotv * 0.55 * (1.0 - keep));
  float w = (1.6 + 2.2 * nw) * px;
  float de = depthEdge(uv, w);
  float le = smoothstep(0.3, 0.6, lumaEdge(uv, 1.2 * px)) * nw;
  c = mix(c, vec3(0.05, 0.08, 0.2), clamp(max(de * (0.35 + 0.65 * nw), le * 0.8), 0.0, 1.0));
  gl_FragColor = vec4(c, 1.0);
}`,
  // ── 4. Gouache: flat opaque paint in 4 values, visible brush, warm palette, tinted outlines ──
  4: /* glsl */`
void main() {
  vec2 uv = vUv; vec2 p = uv * res / px;
  float z = viewZ(uv), nw = nearW(z);
  vec3 b = kuwa(uv, mix(2.4, 1.4, nw) * px);
  float L = luma(b);
  float steps = 4.0, Lq = (floor(L * steps) + smoothstep(0.3, 0.7, fract(L * steps))) / steps;
  vec3 c = b / max(L, 0.02) * mix(L, Lq, 0.9);
  c = mix(c, c * vec3(0.9, 0.78, 0.86), 1.0 - smoothstep(0.15, 0.5, L));
  c = mix(c, c * vec3(1.08, 1.03, 0.88), smoothstep(0.55, 0.9, L));
  c = sat(c, 1.1);
  vec2 o = 2.0 * px / res;
  vec2 g = vec2(luma(texture2D(tColor, uv + vec2(o.x, 0.0)).rgb) - luma(texture2D(tColor, uv - vec2(o.x, 0.0)).rgb),
                luma(texture2D(tColor, uv + vec2(0.0, o.y)).rgb) - luma(texture2D(tColor, uv - vec2(0.0, o.y)).rgb));
  vec2 dir = length(g) > 1e-3 ? normalize(vec2(-g.y, g.x)) : vec2(0.7071, 0.7071);
  vec2 bp = vec2(dot(p, dir), dot(p, vec2(-dir.y, dir.x)));
  c *= 0.84 + 0.3 * vnoise(bp * vec2(0.05, 0.5));
  float de = depthEdge(uv, (1.2 + 1.2 * nw) * px);
  c = mix(c, sat(c, 1.5) * 0.3, de * (0.3 + 0.6 * nw));
  c *= paper(p) + 0.03;
  gl_FragColor = vec4(c, 1.0);
}`,
  // ── 5. Graphic Novel: high-contrast colour, heavy cross-hatching, thick ink ──
  5: /* glsl */`
float hatch(vec2 p, float ang, float spacing, float width) {
  vec2 d = vec2(cos(ang), sin(ang));
  float v = dot(p, d) / spacing + 0.35 * vnoise(p * 0.05);
  return 1.0 - smoothstep(width - 0.12, width + 0.12, abs(fract(v) - 0.5) * 2.0);
}
void main() {
  vec2 uv = vUv; vec2 p = uv * res / px;
  float z = viewZ(uv), nw = nearW(z);
  vec3 c = mix(texture2D(tColor, uv).rgb, blur5(uv, 1.2 * px), 0.5);
  c = sat(c, 0.82);
  c = (c - 0.5) * 1.18 + 0.5;
  float L = luma(blur5(uv, 1.5 * px));
  float keep = smoothstep(150.0, 900.0, z);
  float shade = L / max(localL(uv, 16.0 * px), 0.03);
  float h1 = hatch(p, 0.785, 3.2, 0.24) * (1.0 - smoothstep(0.72, 0.95, shade));
  float h2 = hatch(p, -0.785, 3.2, 0.24) * (1.0 - smoothstep(0.5, 0.75, shade));
  float h3 = hatch(p, 0.2, 2.6, 0.24) * (1.0 - smoothstep(0.1, 0.2, L));
  float h = max(max(h1, h2), h3) * (1.0 - keep);
  c = mix(c, c * 0.2 + vec3(0.02, 0.02, 0.04), h * 0.9);
  float de = silhouette(uv, px * (1.3 + 1.2 * nw));
  float le = smoothstep(0.25, 0.55, lumaEdge(uv, px)) * nw;
  c = mix(c, vec3(0.04, 0.04, 0.06), clamp(max(de * (0.45 + 0.55 * nw), le * 0.7), 0.0, 1.0));
  gl_FragColor = vec4(c, 1.0);
}`,
  7: /* glsl */`void main() { gl_FragColor = vec4(graphicRealism(vUv, 0.35, 0.0), 1.0); }`,
  8: /* glsl */`void main() { gl_FragColor = vec4(graphicRealism(vUv, 0.75, 1.0), 1.0); }`,
  // ── 9. Coloured Pencil: pencil grain on white paper, hatching in the darks, soft contour ──
  9: /* glsl */`
// streaky pencil texture along a stroke direction: 0..1, high = pigment caught on the paper tooth
float pencil(vec2 p, vec2 dir, float scale) {
  vec2 q = vec2(dot(p, dir), dot(p, vec2(-dir.y, dir.x)));
  float streak = vnoise(q * vec2(0.14, 2.4) / scale) * 0.55 + vnoise(q * vec2(0.05, 0.9) / scale) * 0.45;
  float tooth = hash(floor(p * 0.9)) * 0.35 + vnoise(p * 0.7) * 0.65;
  return clamp(streak * 0.7 + tooth * 0.3, 0.0, 1.0);
}
void main() {
  vec2 uv = vUv; vec2 p = uv * res / px;
  float z = viewZ(uv), near = smoothstep(14.0, 3.0, z), far = smoothstep(80.0, 700.0, z);
  // pigment colour: the realistic render, smoothed on the subject (no blotches), warm and a bit desaturated
  vec3 c0 = texture2D(tColor, uv).rgb;
  vec3 c = mix(c0, kuwa(uv, 1.0 * px), 0.4 + 0.4 * near);
  c = sat(c, 0.8);
  c *= vec3(1.03, 1.0, 0.94);
  float L = luma(c);
  vec3 paperC = vec3(0.985, 0.975, 0.955);
  // pencil coverage: dark tones fill the paper, light tones let it show through the grain
  vec2 dir = normalize(vec2(0.82, -0.57));
  float g = pencil(p, dir, 1.0);
  float pig = clamp((1.0 - L) * 1.35, 0.0, 1.0);
  float cover = smoothstep(g - 0.55, g + 0.05, pig + 0.3);
  cover = mix(cover, 1.0, 0.35 * near);           // the subject is drawn more densely than the background
  cover *= 1.0 - 0.55 * far;                       // distance fades toward the paper, like a sketched background
  vec3 outc = mix(paperC, c * (0.95 + 0.1 * g), cover);
  // directional hatching in the darker tones (relative shadows), cross-hatching in the deepest
  float shade = luma(blur5(uv, 1.5 * px)) / max(localL(uv, 16.0 * px), 0.03);
  float dark = max(1.0 - smoothstep(0.62, 0.9, shade), 1.0 - smoothstep(0.18, 0.38, L));
  float wob = 0.35 * vnoise(p * 0.04);
  float h1 = 1.0 - smoothstep(0.1, 0.35, abs(fract(dot(p, normalize(vec2(0.6, -0.8))) / 2.8 + wob) - 0.5) * 2.0);
  float h2 = 1.0 - smoothstep(0.1, 0.35, abs(fract(dot(p, normalize(vec2(0.8, 0.6))) / 3.1 + wob) - 0.5) * 2.0);
  float hatchv = max(h1 * dark, h2 * (1.0 - smoothstep(0.08, 0.2, L))) * (0.55 + 0.45 * g) * (1.0 - far);
  outc = mix(outc, outc * 0.62, hatchv * 0.6);
  // soft contour: silhouettes and creases, broken by the grain, warm graphite brown
  float w = (0.8 + 0.6 * near) * px;
  float de = silhouette(uv, w);
  vec2 o = w / res; float cz = viewZ(uv);
  float crease = abs(viewZ(uv + vec2(o.x, 0.0)) + viewZ(uv - vec2(o.x, 0.0)) + viewZ(uv + vec2(0.0, o.y)) + viewZ(uv - vec2(0.0, o.y)) - 4.0 * cz) / max(cz, 0.3);
  float cr = smoothstep(0.012, 0.04, crease) * near;
  float le = smoothstep(0.28, 0.6, lumaEdge(uv, px)) * near * 0.5;
  float line = clamp(max(max(de, cr * 0.6), le), 0.0, 1.0) * (0.55 + 0.45 * g);
  outc = mix(outc, vec3(0.28, 0.2, 0.16), line * 0.55);
  // paper tooth over everything
  outc *= 0.97 + 0.03 * vnoise(p * 1.3);
  gl_FragColor = vec4(outc, 1.0);
}`,
  // ── 6. Cover Art: clean illustrated likeness — flat colour, black contours, rim light ──
  6: /* glsl */`
void main() {
  vec2 uv = vUv; vec2 p = uv * res / px;
  float z = viewZ(uv), nw = nearW(z);
  vec3 b = kuwa(uv, mix(2.2, 1.1, nw) * px);
  float L = luma(b);
  vec3 chroma = b / max(L, 0.02);
  // shadow / mid / light / highlight, soft but distinct
  float q = 0.24 + 0.3 * smoothstep(0.2, 0.25, L) + 0.28 * smoothstep(0.46, 0.51, L) + 0.18 * smoothstep(0.76, 0.8, L);
  float keep = smoothstep(80.0, 600.0, z);
  vec3 c = mix(chroma * q, b, 0.2 + 0.6 * keep);
  c = sat(c, 1.2);
  // shadows lean cool, lights warm — the cover-art colour script
  c = mix(c, c * vec3(0.85, 0.9, 1.1), 1.0 - smoothstep(0.2, 0.45, L));
  c = mix(c, c * vec3(1.06, 1.0, 0.92), smoothstep(0.5, 0.85, L));
  // bright rim just inside the silhouette of the near subject
  float rim = depthEdge(uv, 3.0 * px) * (1.0 - depthEdge(uv, 1.0 * px)) * smoothstep(12.0, 3.0, z);
  c += rim * 0.18;
  float de = depthEdge(uv, (1.4 + 1.6 * nw) * px);
  float le = smoothstep(0.22, 0.5, lumaEdge(uv, 1.1 * px)) * smoothstep(20.0, 2.0, z);
  c = mix(c, vec3(0.06, 0.05, 0.06), clamp(max(de * (0.3 + 0.7 * nw), le * 0.85), 0.0, 1.0));
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Game finish: "hand-drawn realism" (styles 0 + 5/7 + 9 blended). An EffectComposer pass that runs on the linear
// HDR scene right after the RenderPass, while the scene depth is still intact (later passes write over it), and
// before depth of field so far ink softens with the background:
//   - a thin warm-brown ink contour from depth silhouettes and creases (normal breaks), fading with distance
//   - light hatching in relative shadows only (cross-hatching in the deepest, on 'high')
//   - a touch of painterly colour: soft value steps, warm highlights, a small Kuwahara on near subjects ('high')
//   - a gentle static paper grain
//   - the golfer's face kept clean: a screen-space mask around the head (setFace) plus a skin-tone mask
// Analysis (luma, steps, skin) uses a cheap tone-mapped proxy of the HDR colour; the changes apply to the HDR colour.

export type HandTier = 'med' | 'high';

const HAND_FRAG = /* glsl */`
#include <packing>
uniform sampler2D tDiffuse; uniform sampler2D tDepth; uniform vec2 res; uniform float px, cNear, cFar, exposure, aspect, strength;
uniform vec4 face; // uv.xy, radius (in screen heights), view depth (0 = none)
varying vec2 vUv;
float viewZ(vec2 uv) { float d = texture2D(tDepth, uv).x; return d >= 0.99999 ? 6000.0 : -perspectiveDepthToViewZ(d, cNear, cFar); }
vec3 disp(vec3 c) { c *= exposure; c = c / (1.0 + c); return sqrt(c); } // proxy for the display image
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float Ld(vec2 uv) { return luma(disp(texture2D(tDiffuse, uv).rgb)); }
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
void main() {
  vec2 uv = vUv; vec2 p = uv * res / px;
  vec3 c = texture2D(tDiffuse, uv).rgb;
  float z = viewZ(uv);
  float near = smoothstep(16.0, 4.0, z), mid = 1.0 - smoothstep(30.0, 120.0, z);
  vec3 d0 = disp(c); float L = luma(d0);
  // face mask: the head's screen circle at the head's depth, softened
  vec2 fd = (uv - face.xy) * vec2(aspect, 1.0);
  float fm = face.w > 0.0 ? (1.0 - smoothstep(face.z * 0.7, face.z, length(fd))) * (1.0 - smoothstep(0.35, 0.8, abs(z - face.w))) : 0.0;
  float skin = smoothstep(0.03, 0.09, d0.r - d0.g) * smoothstep(0.0, 0.05, d0.g - d0.b) * smoothstep(0.25, 0.45, d0.r);
  float keep = 1.0 - max(fm, 0.6 * skin * near);   // 1 = full effect, 0 = untouched

  // depth taps (shared by contour and crease)
  float w = (0.9 + 0.8 * near) * px * (0.8 + 0.4 * vnoise(p * 0.07));
  vec2 o = w / res;
  float za = viewZ(uv + vec2(o.x, 0.0)), zb = viewZ(uv - vec2(o.x, 0.0)), zc = viewZ(uv + vec2(0.0, o.y)), zd = viewZ(uv - vec2(0.0, o.y));

#ifdef HIGH
  // painterly colour on near subjects: 3x3 four-sector Kuwahara (flattens blotchy fabric shading)
  {
    vec2 k = 1.2 * px / res; vec3 m0 = vec3(0.0), m1 = vec3(0.0), m2 = vec3(0.0), m3 = vec3(0.0); float v0 = 0.0, v1 = 0.0, v2 = 0.0, v3 = 0.0;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec3 t = texture2D(tDiffuse, uv + vec2(float(i), float(j)) * k).rgb; float l = luma(disp(t));
      if (i <= 0 && j <= 0) { m0 += t; v0 += l * l - 0.0; } if (i >= 0 && j <= 0) { m1 += t; v1 += l * l; }
      if (i <= 0 && j >= 0) { m2 += t; v2 += l * l; } if (i >= 0 && j >= 0) { m3 += t; v3 += l * l; }
    }
    float l0 = luma(disp(m0 * 0.25)), l1 = luma(disp(m1 * 0.25)), l2 = luma(disp(m2 * 0.25)), l3 = luma(disp(m3 * 0.25));
    float s0 = v0 * 0.25 - l0 * l0, s1 = v1 * 0.25 - l1 * l1, s2 = v2 * 0.25 - l2 * l2, s3 = v3 * 0.25 - l3 * l3;
    vec3 kc = m0; float b = s0; if (s1 < b) { b = s1; kc = m1; } if (s2 < b) { b = s2; kc = m2; } if (s3 < b) { kc = m3; }
    c = mix(c, kc * 0.25, 0.55 * near * (1.0 - fm));
  }
#endif

  // a touch of posterisation (soft value steps) and warm highlights
  float steps = 7.0, Lq = (floor(L * steps) + smoothstep(0.3, 0.7, fract(L * steps))) / steps;
  float Lp = mix(L, Lq, 0.35 * strength * keep);
  c *= pow(max(Lp, 1e-3) / max(L, 1e-3), 2.0);
  c *= mix(vec3(1.0), vec3(1.05, 1.0, 0.9), smoothstep(0.62, 0.95, L) * strength);

  // hatching where it is darker than its surroundings (cast shadows, folds, under arms, tree shade)
  vec2 r = 14.0 * px / res;
  float loc = (Ld(uv + vec2(r.x, 0.0)) + Ld(uv - vec2(r.x, 0.0)) + Ld(uv + vec2(0.0, r.y)) + Ld(uv - vec2(0.0, r.y))
#ifdef HIGH
             + Ld(uv + r * 0.7071) + Ld(uv - r * 0.7071) + Ld(uv + vec2(r.x, -r.y) * 0.7071) + Ld(uv + vec2(-r.x, r.y) * 0.7071)) / 8.0;
#else
             ) / 4.0;
#endif
  float shade = L / max(loc, 0.03);
  float wob = 0.3 * vnoise(p * 0.045);
  float h1 = 1.0 - smoothstep(0.12, 0.34, abs(fract(dot(p, vec2(0.6, -0.8)) / 3.0 + wob) - 0.5) * 2.0);
  float hat = h1 * max(1.0 - smoothstep(0.55, 0.85, shade), 0.6 * (1.0 - smoothstep(0.1, 0.22, L)));
#ifdef HIGH
  float h2 = 1.0 - smoothstep(0.12, 0.34, abs(fract(dot(p, vec2(0.8, 0.6)) / 3.3 + wob) - 0.5) * 2.0);
  hat = max(hat, h2 * (1.0 - smoothstep(0.35, 0.6, shade)));
#endif
  hat *= mid * keep * (0.6 + 0.4 * vnoise(p * 0.5)) * strength;
  c *= 1.0 - 0.42 * hat;

  // ink: silhouettes (relative depth jumps, gated so gentle terrain steps never draw) + creases (normal breaks)
  float m = min(min(za, zb), min(zc, zd));
  float jump = (z - m) / max(m, 0.3);
  float gate = max(smoothstep(8.0, 5.0, m), smoothstep(0.5, 0.9, jump));
  float sil = smoothstep(0.1, 0.28, jump) * gate;
  float crease = abs(za + zb + zc + zd - 4.0 * z) / max(z, 0.3);
  float cr = smoothstep(0.015, 0.05, crease) * near * 0.6;
  float ink = max(sil, cr) * (0.75 + 0.25 * vnoise(p * 0.4));
  ink *= 1.0 - 0.75 * smoothstep(25.0, 300.0, z);                // fades with distance
  ink *= mix(1.0, 0.45, fm);                                     // a lighter line around the face
  c = mix(c, vec3(0.032, 0.018, 0.011), ink * 0.8 * strength);

  // paper grain: static (no shimmer), strongest in the mid tones
  float g = 0.65 * vnoise(p * 0.75) + 0.35 * hash(floor(p));
  c *= 1.0 + (g - 0.5) * 0.09 * strength * (0.4 + 0.6 * (1.0 - abs(L - 0.55) * 1.6)) * (1.0 - 0.7 * fm);
  gl_FragColor = vec4(c, texture2D(tDiffuse, uv).a);
}`;

/** composer pass: reads the scene target's colour + depth and writes the hand-drawn image back into it (via a private
 *  colour target, so nothing samples a depth texture that is also bound for writing). It does not swap, so later
 *  passes (depth of field) still find the scene depth on the read buffer. */
export class HandDrawnPass extends Pass {
  readonly mat: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  private rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  private copy = new FullScreenQuad(new THREE.ShaderMaterial({
    uniforms: { t: { value: null } }, depthTest: false, depthWrite: false,
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `uniform sampler2D t; varying vec2 vUv; void main() { gl_FragColor = texture2D(t, vUv); }`,
  }));
  private faceWorld: THREE.Vector3 | null = null;
  private faceR = 0.14;
  private v = new THREE.Vector3();
  constructor(private camera: THREE.PerspectiveCamera, tier: HandTier, private getExposure: () => number) {
    super();
    this.needsSwap = false;
    this.mat = new THREE.ShaderMaterial({
      defines: tier === 'high' ? { HIGH: 1 } : {},
      uniforms: {
        tDiffuse: { value: null }, tDepth: { value: null }, res: { value: new THREE.Vector2(1, 1) }, px: { value: 1 },
        cNear: { value: 0.1 }, cFar: { value: 1000 }, exposure: { value: 1 }, aspect: { value: 1 }, strength: { value: 1 },
        face: { value: new THREE.Vector4(0, 0, 0, 0) },
      },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: HAND_FRAG, depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.mat);
  }
  /** render size in device pixels and the pixel ratio (line widths and grain scale with it) */
  setSize(w: number, h: number, pr = 1) { this.rt.setSize(w, h); this.mat.uniforms.res.value.set(w, h); this.mat.uniforms.px.value = pr; this.mat.uniforms.aspect.value = w / h; }
  /** the golfer's head (world position, radius in metres) to keep the face clean; null for none */
  setFace(pos: THREE.Vector3 | null, radius = 0.14) { this.faceWorld = pos ? (this.faceWorld ?? new THREE.Vector3()).copy(pos) : null; this.faceR = radius; }
  render(renderer: THREE.WebGLRenderer, _writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    const u = this.mat.uniforms, cam = this.camera;
    u.tDiffuse.value = readBuffer.texture; u.tDepth.value = readBuffer.depthTexture;
    u.cNear.value = cam.near; u.cFar.value = cam.far; u.exposure.value = this.getExposure();
    const f = u.face.value as THREE.Vector4;
    f.set(0, 0, 0, 0);
    if (this.faceWorld) {
      const vz = -this.v.copy(this.faceWorld).applyMatrix4(cam.matrixWorldInverse).z;
      if (vz > cam.near) {
        this.v.copy(this.faceWorld).project(cam);
        // radius in screen heights: r / (depth * tan(fov/2)) * 0.5
        const rh = this.faceR / (vz * Math.tan(THREE.MathUtils.degToRad(cam.getEffectiveFOV()) / 2)) * 0.5;
        f.set(this.v.x * 0.5 + 0.5, this.v.y * 0.5 + 0.5, rh, vz);
      }
    }
    renderer.setRenderTarget(this.rt);
    this.quad.render(renderer);
    (this.copy.material as THREE.ShaderMaterial).uniforms.t.value = this.rt.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    this.copy.render(renderer);
  }
  dispose() { this.mat.dispose(); this.quad.dispose(); this.rt.dispose(); this.copy.material.dispose(); this.copy.dispose(); }
}
