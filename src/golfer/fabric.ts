// Fabric and skin shading for the realistic golfer. Everything is computed in the body's bind space
// (the pre-skinning position), so the weave, folds and seams stick to the cloth as it moves.
// Per-vertex `cloth` = (distance to hem, distance to seam, distance to crease, baked ambient occlusion).
import * as THREE from 'three';

export type FabricKind = 'polo' | 'chino' | 'skin' | 'glove';

const NOISE = /* glsl */ `
float fh(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float fn3(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(fh(i), fh(i + vec3(1,0,0)), f.x), mix(fh(i + vec3(0,1,0)), fh(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(fh(i + vec3(0,0,1)), fh(i + vec3(1,0,1)), f.x), mix(fh(i + vec3(0,1,1)), fh(i + vec3(1,1,1)), f.x), f.y), f.z); }
float fbm3(vec3 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * fn3(p); p = p * 2.03 + 11.7; a *= 0.5; } return s; }
// bump from a height field using screen-space derivatives (works on skinned meshes, no tangents needed)
vec3 bumpN(vec3 pos, vec3 n, float h){
  vec3 sx = dFdx(pos), sy = dFdy(pos); vec3 r1 = cross(sy, n), r2 = cross(n, sx);
  float det = dot(sx, r1); vec2 dh = vec2(dFdx(h), dFdy(h));
  vec3 g = sign(det) * (dh.x * r1 + dh.y * r2);
  return normalize(abs(det) * n - g);
}
`;

/** height field + colour tweak per fabric, in bind space (metres). vC = cloth attribute. */
const BODY: Record<FabricKind, string> = {
  polo: /* glsl */ `
    float hem = vC.x, seam = vC.y;
    // pique knit: tiny honeycomb cells; faded out as it gets smaller than a pixel
    vec3 q = vB * 520.0;
    float cell = abs(sin(q.x) * sin(q.y + 0.5 * sin(q.z)));
    float fine = 1.0 - smoothstep(0.0006, 0.0025, fwidth(vB.y));
    h += 0.00014 * cell * fine;
    // soft drape: long horizontal-ish folds, stronger low on the shirt (bloused over the belt)
    float low = 1.0 - smoothstep(0.02, 0.14, hem) * step(vB.y, 1.25);
    float folds = fbm3(vB * vec3(7.0, 19.0, 7.0));
    h += 0.0012 * folds + 0.0007 * low * fbm3(vB * vec3(10.0, 40.0, 10.0));
    // seams: a narrow groove with stitching either side
    float sg = 1.0 - smoothstep(0.0, 0.003, seam);
    h -= 0.00012 * sg;
    float stitch = (1.0 - smoothstep(0.0025, 0.0045, abs(seam - 0.005))) * step(0.5, fract(vB.y * 180.0 + vB.x * 60.0));
    // hems: a turned-back band with a line of stitching 1.5 cm in
    float band = 1.0 - smoothstep(0.016, 0.02, hem);
    h += 0.0008 * band;
    float hemStitch = (1.0 - smoothstep(0.001, 0.0022, abs(hem - 0.014))) * step(0.45, fract(vB.x * 170.0 + vB.z * 170.0 + vB.y * 120.0));
    col *= 1.0 - 0.06 * band;
    col *= 1.0 - 0.03 * sg; stitch += 0.0; hemStitch += 0.0;
    col *= 0.94 + 0.12 * fbm3(vB * 60.0); // melange
  `,
  chino: /* glsl */ `
    float hem = vC.x, seam = vC.y, crease = vC.z;
    // twill weave: diagonal ribs
    float rib = 0.5 + 0.5 * sin((vB.y * 0.7 + vB.x + vB.z) * 1400.0);
    float fine = 1.0 - smoothstep(0.0006, 0.0025, fwidth(vB.y));
    h += 0.00025 * rib * fine;
    // pressed front crease (sharp ridge) and softer back crease
    h += 0.0007 * (1.0 - smoothstep(0.0, 0.005, crease));
    // knee bunching and the break over the shoe: horizontal folds
    float kneeY = uKneeY, ankleY = uAnkleY;
    float knee = exp(-pow((vB.y - kneeY) / 0.06, 2.0));
    float brk = 1.0 - smoothstep(0.0, 0.1, vB.y - ankleY - 0.02);
    float wav = fbm3(vB * vec3(14.0, 30.0, 14.0));
    h += (0.0009 * knee + 0.0014 * brk) * (0.5 + 0.5 * sin(vB.y * 170.0 + wav * 5.0));
    h += 0.0009 * fbm3(vB * vec3(6.0, 11.0, 6.0));
    // seams (outer side seam and inseam): flat-felled look, with stitching
    float sg = 1.0 - smoothstep(0.0, 0.0035, seam);
    h -= 0.0004 * sg;
    float stitch = (1.0 - smoothstep(0.003, 0.0048, abs(seam - 0.006))) * step(0.5, fract(vB.y * 160.0));
    // waistband (top edge) and hems
    float topBand = step(uBeltY - 0.08, vB.y) * (1.0 - smoothstep(0.034, 0.038, hem));
    h += 0.001 * topBand;
    // back pockets: two welts below the waistband
    float back = step(vB.z, uBackZ);
    vec2 pk = vec2(abs(vB.x) - 0.085, vB.y - (uBeltY - 0.075));
    float welt = (1.0 - smoothstep(0.0012, 0.0028, abs(pk.y))) * (1.0 - smoothstep(0.055, 0.058, abs(pk.x))) * back;
    h -= 0.0015 * welt;
    col *= 1.0 - 0.25 * welt;
    col *= 1.0 - 0.07 * sg; stitch += 0.0;
    col *= 0.95 + 0.1 * fbm3(vB * 45.0);
    // a touch of grass and dust at the hem
    col *= 1.0 - 0.08 * brk;
  `,
  skin: /* glsl */ `
    float fine = 1.0 - smoothstep(0.0004, 0.002, fwidth(vB.y));
    h += 0.00012 * fn3(vB * 1800.0) * fine;  // pores
    h += 0.0003 * fbm3(vB * 220.0);
  `,
  glove: /* glsl */ `
    float fine = 1.0 - smoothstep(0.0005, 0.002, fwidth(vB.y));
    h += 0.0002 * fn3(vB * 1200.0) * fine;
    float cuff = 1.0 - smoothstep(0.012, 0.016, vC.x);
    col *= 1.0 - 0.12 * cuff;   // dark tab at the cuff
    h += 0.0006 * cuff;
  `,
};

export interface FabricUniforms { kneeY: number; ankleY: number; beltY: number; backZ: number }

export function applyFabric(mat: THREE.MeshPhysicalMaterial | THREE.MeshStandardMaterial, kind: FabricKind, u: FabricUniforms, bumpScale = 1) {
  mat.onBeforeCompile = sh => {
    sh.uniforms.uKneeY = { value: u.kneeY }; sh.uniforms.uAnkleY = { value: u.ankleY };
    sh.uniforms.uBeltY = { value: u.beltY }; sh.uniforms.uBackZ = { value: u.backZ };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 cloth;\nvarying vec3 vB;\nvarying vec4 vC;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvB = position; vC = cloth;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vB;\nvarying vec4 vC;\nuniform float uKneeY, uAnkleY, uBeltY, uBackZ;\n${NOISE}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        float h = 0.0; vec3 col = diffuseColor.rgb;
        ${BODY[kind]}
        diffuseColor.rgb = col;
        float fabricH = h * ${(3.0 * bumpScale).toFixed(2)};`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = bumpN(-vViewPosition, normal, fabricH);`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        float bakedAO = clamp(vC.w, 0.0, 1.0);
        reflectedLight.indirectDiffuse *= bakedAO;
        reflectedLight.indirectSpecular *= mix(1.0, bakedAO, 0.7);
        reflectedLight.directDiffuse *= mix(1.0, bakedAO, 0.35);`);
  };
  mat.customProgramCacheKey = () => 'fabric-' + kind;
}
