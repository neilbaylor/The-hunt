// Quick check: a left-hander's push curves the mirror way of a right-hander's, and a full swing never carries less
// than FULL_MIN of the club's full carry.   npx tsx tools/shape-check.ts
import { planShot, LIES, FULL_MIN } from '../src/game/shot';
import { simulateShape } from '../src/game/ball';
import { CLUB_SPECS } from '../src/golfer/club';
const ci = CLUB_SPECS.findIndex(c => c.id === '7i');
const run = (angle: number, lefty: boolean, power = 1) => {
  const P = planShot({ power, offMs: 0, pushMs: 200, angle, drift: 0, released: false }, ci, 'full', LIES[0], lefty);
  const S = simulateShape(P.launch);
  return { shape: P.shape, side: +S.side.toFixed(1), carry: +P.targetCarryYds.toFixed(0) };
};
for (const a of [-20, 0, 20]) console.log('angle', a, 'righty', run(a, false), 'lefty', run(a, true));
console.log('7i full swing, tiny pull:', run(0, true, 0.05).carry, 'yds; full pull:', run(0, true, 1).carry, 'yds; min fraction', FULL_MIN);
