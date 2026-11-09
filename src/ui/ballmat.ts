// The in-game Pro V1x material: the shared dimple normal map + AO + print (balltex.ts) on a soft, slightly warm
// bright, clean, slightly cool white urethane cover with a broad soft clearcoat sheen that follows the dimples.
import * as THREE from 'three';
import { ballTex, onBallTexUpdate } from './balltex';

export function tourBallMaterial() {
  const T = ballTex();
  const print = new THREE.CanvasTexture(T.printCanvas); print.colorSpace = THREE.SRGBColorSpace; print.anisotropy = 8;
  const normal = new THREE.CanvasTexture(T.normalCanvas); normal.colorSpace = THREE.NoColorSpace; normal.anisotropy = 4;
  const ao = new THREE.CanvasTexture(T.aoCanvas); ao.colorSpace = THREE.NoColorSpace;
  onBallTexUpdate(() => { print.needsUpdate = true; });
  const mat = new THREE.MeshPhysicalMaterial({
    color: '#f1f3f6', roughness: 0.42, normalMap: normal, normalScale: new THREE.Vector2(1.5, 1.5), aoMap: ao, aoMapIntensity: 1,
    clearcoat: 0.8, clearcoatRoughness: 0.22, clearcoatNormalMap: normal, clearcoatNormalScale: new THREE.Vector2(0.8, 0.8),
  });
  mat.onBeforeCompile = sh => {
    sh.uniforms.printMap = { value: print };
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D printMap;')
      .replace('#include <map_fragment>', '#include <map_fragment>\nvec4 pr = texture2D(printMap, vNormalMapUv);\ndiffuseColor.rgb = mix(diffuseColor.rgb, pr.rgb, pr.a);');
  };
  mat.customProgramCacheKey = () => 'tour-ball';
  return mat;
}
