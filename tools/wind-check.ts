// Quick check of wind on a 7-iron (165 yd carry):   npx tsx tools/wind-check.ts
import * as THREE from 'three';
import { Ball, WIND, speedForCarry } from '../src/game/ball';
const flat: any = { heightAt: () => 0, normalAt: (_x: number, _z: number, n: THREE.Vector3) => n.set(0, 1, 0), surfaceAt: () => 'fairway' };
const L = { speed: speedForCarry(165 * 0.9144, 17 * Math.PI / 180, 6000), launch: 17 * Math.PI / 180, azimuth: 0, spinRpm: 6000, tilt: 0 };
for (const [name, w] of [['calm', [0, 0, 0]], ['10 mph into', [0, 0, 4.47]], ['10 mph helping', [0, 0, -4.47]], ['10 mph left→right', [4.47, 0, 0]]] as const) {
  WIND.set(w[0], w[1], w[2]);
  const b = new Ball(flat); b.tee(new THREE.Vector3(0, 0.02135, 0)); b.hit(L);
  for (let i = 0; i < 2400 && !b.landing; i++) b.step(1 / 120);
  console.log(name.padEnd(18), 'carry', (b.carry() / 0.9144).toFixed(0), 'yds, side', (b.landing!.x / 0.9144).toFixed(1), 'yds');
}
