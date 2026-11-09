// The in-game Pro V1x material: the shared dimple normal map + AO + print (balltex.ts) on a soft, slightly warm
// white urethane cover under a glossy clearcoat that follows the dimples (so each cup catches its own highlight).
import * as THREE from 'three';
import { ballTex, onBallTexUpdate } from './balltex';

export function tourBallMaterial() {
  const T = ballTex();
  const print = new THREE.CanvasTexture(T.printCanvas); print.colorSpace = THREE.SRGBColorSpace; print.anisotropy = 8;
  const normal = new THREE.CanvasTexture(T.normalCanvas); normal.colorSpace = THREE.NoColorSpace; normal.anisotropy = 4;
  const ao = new THREE.CanvasTexture(T.aoCanvas); ao.colorSpace = THREE.NoColorSpace;
  onBallTexUpdate(() => { print.needsUpdate = true; });
  const mat = new THREE.MeshPhysicalMaterial({
    color: '#f3f0e8', roughness: 0.5, normalMap: normal, normalScale: new THREE.Vector2(1.35, 1.35), aoMap: ao, aoMapIntensity: 1,
    clearcoat: 1, clearcoatRoughness: 0.07, clearcoatNormalMap: normal, clearcoatNormalScale: new THREE.Vector2(1.1, 1.1),
  });
  mat.onBeforeCompile = sh => {
    sh.uniforms.printMap = { value: print };
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D printMap;')
      .replace('#include <map_fragment>', '#include <map_fragment>\nvec4 pr = texture2D(printMap, vNormalMapUv);\ndiffuseColor.rgb = mix(diffuseColor.rgb, pr.rgb, pr.a);');
  };
  mat.customProgramCacheKey = () => 'tour-ball';
  return mat;
}
