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
    // matte performance jersey: a fine knit only up close, clear seams (shoulder/armhole, sides) with a line of
    // stitching, a turned hem, and a few soft drape folds: vertical ones gathering into the waistband (tucked),
    // and broad diagonal tension folds across the torso
    float fine = 1.0 - smoothstep(0.0005, 0.0018, fwidth(vB.y));
    vec3 kq = vB * 900.0;
    h += 0.00003 * abs(sin(kq.x) * sin(kq.y + 0.5 * sin(kq.z))) * fine;
    float sg = 1.0 - smoothstep(0.0, 0.0018, seam);
    float sst = (1.0 - smoothstep(0.0006, 0.0014, abs(seam - 0.0045))) * step(0.45, fract((vB.x + vB.y + vB.z) * 220.0));
    h -= 0.00035 * sg;
    col *= 1.0 - 0.05 * sg - 0.035 * sst;
    float band = 1.0 - smoothstep(0.014, 0.018, hem);
    col *= 1.0 - 0.035 * band;
    h += 0.00015 * smoothstep(0.012, 0.016, hem) * band;
    float wy2 = vB.y - uBeltY;
    float ang = atan(vB.x, vB.z - uBackZ);
    float gather = smoothstep(0.14, 0.02, wy2) * step(-0.02, wy2);
    h += 0.0007 * gather * (0.5 + 0.5 * sin(ang * 13.0 + 3.0 * fbm3(vB * 7.0)));
    float torso = smoothstep(uBeltY + 0.05, uBeltY + 0.15, vB.y) * (1.0 - smoothstep(uBeltY + 0.35, uBeltY + 0.45, vB.y));
    h += 0.0003 * torso * (0.5 + 0.5 * sin((vB.y + 0.7 * abs(vB.x)) * 38.0 + 2.5 * fbm3(vB * 5.0)));
    // embroidered crest on the chest (planar projection from the front)
    vec2 cuv = vec2((vB.x - uCrestC.x) / uCrestS + 0.5, (vB.y - uCrestC.y) / abs(uCrestS) * 1.2 + 0.5);
    float inC = step(uCrestC.z - 0.03, vB.z) * step(0.0, cuv.x) * step(cuv.x, 1.0) * step(0.0, cuv.y) * step(cuv.y, 1.0);
    vec4 cr = texture2D(uCrest, clamp(cuv, 0.0, 1.0));   // sampled outside any branch so mip selection is well-defined
    col = mix(col, cr.rgb * 0.95, cr.a * inC);
    h += 0.0005 * cr.a * inC; // raised embroidery
  `,
  chino: /* glsl */ `
    float hem = vC.x, seam = vC.y, crease = vC.z;
    // twill weave: diagonal ribs
    float rib = 0.5 + 0.5 * sin((vB.y * 0.7 + vB.x + vB.z) * 1400.0);
    float fine = 1.0 - smoothstep(0.0006, 0.0025, fwidth(vB.y));
    rib *= fine;   // no twill bump: even a faint one reads as moire stripes up close
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
    float front = 1.0 - back;
    float wy = vB.y - uBeltY;                                   // height relative to the waist (belt line)
    // fly: a seam down the centre front with the J-stitch curving in at the bottom, flat and clean
    float flyLen = 0.15;
    float jx = 0.032 * (1.0 - smoothstep(-flyLen + 0.035, -flyLen, wy));   // the J: straight, then curving to the centre
    float onFly = step(-flyLen - 0.005, wy) * step(wy, -0.02) * front;
    float jst = (1.0 - smoothstep(0.0007, 0.0016, abs(vB.x - jx))) * onFly * step(0.5, fract(wy * 160.0));
    float flyEdge = (1.0 - smoothstep(0.0, 0.0018, abs(vB.x))) * step(-flyLen, wy) * step(wy, 0.0) * front;
    h -= 0.0006 * flyEdge;
    col *= 1.0 - 0.18 * flyEdge - 0.25 * jst;
    // slanted side pockets: diagonal seams from the waistband out and down to the side seam
    vec2 pa0 = vec2(0.105, -0.01), pa1 = vec2(0.17, -0.135), pq = vec2(abs(vB.x), wy);
    float tq = clamp(dot(pq - pa0, pa1 - pa0) / dot(pa1 - pa0, pa1 - pa0), 0.0, 1.0);
    float pd = length(pq - (pa0 + (pa1 - pa0) * tq));
    float pocket = (1.0 - smoothstep(0.0008, 0.0022, pd)) * front;
    float pst = (1.0 - smoothstep(0.0006, 0.0014, abs(pd - 0.006))) * front * step(0.5, fract((vB.y + abs(vB.x)) * 150.0));
    h -= 0.0012 * pocket;
    col *= 1.0 - 0.22 * pocket - 0.15 * pst;
    // centre-back seam
    float cb = (1.0 - smoothstep(0.0, 0.0018, abs(vB.x))) * back * step(wy, 0.0) * step(-0.24, wy);
    h -= 0.0006 * cb; col *= 1.0 - 0.15 * cb;
    // soft drag folds from the crotch on the front
    float drag = front * smoothstep(-0.13, -0.2, wy) * (1.0 - smoothstep(-0.28, -0.34, wy)) * (1.0 - smoothstep(0.03, 0.09, abs(vB.x)));
    h += 0.0007 * drag * sin((abs(vB.x) * 1.4 + wy) * 90.0);
    col *= 1.0 - 0.07 * sg; stitch += 0.0;
    col *= 0.95 + 0.1 * fbm3(vB * 45.0);
    // a touch of grass and dust at the hem
    col *= 1.0 - 0.08 * brk;
  `,
  skin: /* glsl */ `
    float fine = 1.0 - smoothstep(0.0004, 0.002, fwidth(vB.y));
    h += 0.00002 * fn3(vB * 1800.0) * fine;  // pores (subtle)
    h += 0.00008 * fbm3(vB * 160.0);
  `,
  glove: /* glsl */ `
    float fine = 1.0 - smoothstep(0.0005, 0.002, fwidth(vB.y));
    h += 0.00005 * fn3(vB * 900.0) * fine;  // soft leather grain (stronger reads as sparkle)
    float cuff = 1.0 - smoothstep(0.008, 0.011, vC.x);
    col *= 1.0 - 0.05 * cuff;   // a narrow hemmed cuff
    h += 0.0003 * cuff;
    float dors = vC.z < 1.5 ? clamp((vC.z - 0.45) / 0.3, 0.0, 1.0) : 0.0;   // back of the hand (gloves only)
    // velcro tab: a stitched rectangle on the back of the wrist, slightly raised
    float tab = dors * (1.0 - smoothstep(0.03, 0.033, vC.x)) * step(0.004, vC.x);
    float tabEdge = tab * (1.0 - smoothstep(0.0, 0.0025, min(abs(vC.x - 0.005), abs(vC.x - 0.031))));
    col *= 1.0 - 0.06 * tab - 0.15 * tabEdge;
    h += 0.0007 * tab;
    // small perforations across the back of the hand, above the tab
    vec3 pp = vB * 260.0; vec3 pc = fract(pp) - 0.5;
    float perf = dors * step(0.045, vC.x) * (1.0 - smoothstep(0.12, 0.2, length(pc.xy))) * step(0.5, fract(floor(pp.z) * 0.5)) * fine;
    col *= 1.0 - 0.28 * perf;
    h -= 0.00015 * perf;
  `,
};

export interface FabricUniforms { kneeY: number; ankleY: number; beltY: number; backZ: number;
  /** skin only: a second face texture blended in by smile amount */ smile?: { map: THREE.Texture; amount: { value: number } };
  /** chest crest: texture, centre (bind space), size (m), mirror for left-handers */ crest?: { tex: THREE.Texture; c: THREE.Vector3; size: number; flip: boolean };
  tipping?: THREE.Color }

export function applyFabric(mat: THREE.MeshPhysicalMaterial | THREE.MeshStandardMaterial, kind: FabricKind, u: FabricUniforms, bumpScale = 1) {
  mat.onBeforeCompile = sh => {
    sh.uniforms.uKneeY = { value: u.kneeY }; sh.uniforms.uAnkleY = { value: u.ankleY };
    sh.uniforms.uBeltY = { value: u.beltY }; sh.uniforms.uBackZ = { value: u.backZ };
    sh.uniforms.uCrest = { value: u.crest?.tex ?? null }; sh.uniforms.uCrestC = { value: u.crest?.c ?? new THREE.Vector3(0, -9, 0) };
    sh.uniforms.uSmileMap = { value: u.smile?.map ?? null }; sh.uniforms.uSmileAmt = u.smile?.amount ?? { value: 0 };
    sh.uniforms.uCrestS = { value: u.crest ? u.crest.size * (u.crest.flip ? -1 : 1) : 1 }; sh.uniforms.uTip = { value: u.tipping ?? new THREE.Color('#ffffff') };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 cloth;\nvarying vec3 vB;\nvarying vec4 vC;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvB = position; vC = cloth;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vB;\nvarying vec4 vC;\nuniform float uKneeY, uAnkleY, uBeltY, uBackZ;\nuniform sampler2D uCrest; uniform vec3 uCrestC; uniform float uCrestS; uniform vec3 uTip; uniform sampler2D uSmileMap; uniform float uSmileAmt;\n${NOISE}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        ${kind === 'skin' && u.smile ? '#ifdef USE_MAP\n diffuseColor.rgb = mix(diffuseColor.rgb, texture2D(uSmileMap, vMapUv).rgb, uSmileAmt);\n#endif' : ''}
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
  mat.customProgramCacheKey = () => 'fabric-' + kind + (u.smile ? '-smile' : '');
}
