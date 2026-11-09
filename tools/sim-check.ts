// Distance regression: carry/total per club on flat fairway, with no aftertouch and with max top/back spin.
// Run: npx esbuild tools/sim-check.ts --bundle --platform=node --outfile=/tmp/sim-check.js && node /tmp/sim-check.js
import * as THREE from 'three';
import { Ball } from '../src/game/ball';
import { planShot, LIES, YD } from '../src/game/shot';
import { CLUB_SPECS } from '../src/golfer/club';

const rows: string[] = [];
for (let ci = 0; ci < CLUB_SPECS.length; ci++) {
  const plan = planShot({ power: 1, offMs: 0, pushMs: 200, angle: 0, drift: 0, released: false }, ci, 'full', LIES[0], true);
  const run = (top: number) => {
    const b = new Ball(null); b.tee(new THREE.Vector3(0, 0.02135, 0)); b.hit(plan.launch);
    for (let i = 0; i < 120 * 60 && b.phase !== 'stopped'; i++) { if (b.phase === 'flight' && b.t > 0.5) b.setAftertouch(top, 0); b.step(1 / 120); }
    return [b.carry() / YD, b.total() / YD];
  };
  const [c0, t0] = run(0), [, tt] = run(1), [, tb] = run(-1);
  rows.push(`${CLUB_SPECS[ci].id.padEnd(4)} carry ${c0.toFixed(0).padStart(3)}  total ${t0.toFixed(0).padStart(3)}  max-top ${tt.toFixed(0).padStart(3)} (+${(((tt - t0) / t0) * 100).toFixed(1)}%)  max-back ${tb.toFixed(0).padStart(3)}`);
}
console.log(rows.join('\n'));
