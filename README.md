# The Hunt

A realistic 3D golf game for the browser, phones first.

## Play it

`range-day.html` is the whole game in one file (also published as a claude.ai artifact).

```bash
npm install
npm run dev              # http://localhost:5173 (on your LAN too, for phones)
npm run build:artifact   # rebuild range-day.html
```

Dev pages: `golfer.html?pose=address|half|top|down|impact|through|finish|stand&view=game|gameclose|face|dtl|close|three&club=0..12&mode=full|punch|pitch|flop`
to look at the golfer, and `env.html?view=tee|flight|green|top|side` for the range.

## Code map

```
src/main.ts            game loop: swing input, cameras, flight, result
src/golfer/profile.ts  who a golfer is (Neil is the first): body, face, outfit, swing tempo
src/golfer/body.ts     builds the body from a profile: skeleton, skinned hoodie/pants, head, face paint, hair
src/golfer/rig.ts      posing: spine turn, two-bone IK for arms and legs, head look-at
src/golfer/golfer.ts   the swing: address set-up per club, keyframes per shot type, club on the swing plane
src/golfer/club.ts     driver to 60° wedge, and the hands built around the grip
src/game/ball.ts       ball physics: drag, spin lift, aftertouch, bounce, check-up, roll
src/game/shot.ts       swing → launch (club data, modes, lies, tempo penalties)
src/world/range.ts     the range: sky, terrain, grass, trees, greens, flags, signs
src/ui/hud.ts/.css     HUD (three looks), swing pad, spin ball
src/game/audio.ts      synthesised sound
```

## Adding a friend

Copy `NEIL` in `src/golfer/profile.ts`: height, weight, handedness, skin/hair/eye colours, face length,
hairline, nose, stubble, outfit colours and swing tempo. Next step is a face texture from a photo.

## Concepts

- `concepts/swing-hud.html`: playable swing pad on a 2D stand-in range, three HUD looks
  (A Broadcast, B Clubhouse, C Y2K Pro Tour), swing-mode rules and swing scoring. It is a page fragment
  for hosting as a claude.ai artifact.

## Tech plan

- **Rendering:** WebGL 2 through [Three.js](https://threejs.org) (0.186). Three.js gives us PBR materials, shadows, glTF
  characters and skinned animation without writing a renderer.
- **Language/build:** TypeScript + Vite, same as Puffy.
- **Ball flight:** our own small physics step (gravity, drag, Magnus lift from spin, bounce and roll on the
  terrain), not a general physics engine. It is a few dozen lines, deterministic, and easy to tune.
- **Terrain:** height-map course with splat textures (fairway, rough, sand, green). The lie card reads
  lie type and slope straight from the height map under the ball.
- **Characters:** glTF models with shared skeletons, so every golfer can use every swing animation.
  Each friend gets a body, a face texture and a swing style (tempo to the top, backswing length, finish).
- **HUD:** plain HTML/CSS over the canvas (sharp text at any size, cheap to restyle).
- **Performance targets:** 60 fps on a mid-range phone. Instanced trees and grass, baked lighting
  for the course, one shadow-casting light, dynamic resolution if a frame runs long.

## Swing rules (from the concept)

| Mode  | Clubs              | Max carry            |
|-------|--------------------|----------------------|
| Full  | All                | Club's full yardage  |
| Punch | All but driver     | About 78% of full    |
| Pitch | PW, 50°, 56°, 60°  | 65 yds (PW) to 47    |
| Flop  | 56° or 60°         | 30 yds (56°), 26     |

- Pull down = backswing; pull length is power.
- Push up when the golfer reaches the top. Window: 70 ms early to 160 ms late. Outside it the ball goes
  a bit left/right, high/low and short, at random, more the further out you are.
- Push angle: left = draw then hook (past 12°), right = fade then slice.
- Sideways drift on the pull-back adds a little random miss.
- In the air, swipe the spin ball: down = backspin, up = topspin, sideways bends the flight.
