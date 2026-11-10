# The Hunt — handoff brief

Read this first in any new session. It is the project's memory: what we are building, what the owner wants, where everything lives, and what is in flight.

## What it is
A realistic-but-hand-drawn 3D golf game in the mobile browser (Three.js 0.186, TypeScript, Vite). **Phone portrait is 99% of players** (iPhone with Safari/Chrome bars visible). Desktop and landscape should still look nice. Single-file build: `npm run build:artifact` → `range-day.html`. The published playable link is the owner's private claude.ai artifact "Range Day": https://claude.ai/artifact/SwaX1NNQRX3PwKnBZHPmsH. Republish to that URL; don't create a new one.

Repo: `neilbaylor/The-hunt`, branch `main`. Commit often (usage limits cut agents off mid-task). Every commit message ends with the session's attribution trailer.

## The golfer = Neil (the owner)
- **Body:** left-handed, 6'3", 180 lb, athletic build (not skinny), long legs, flat stomach.
- **Face:** must look like HIM. Fit and texture from his **real photos** (tools/character/data, listed in neil.json `face.views` / `faceShape.photos`). Real photos have the highest weight, the ChatGPT front unwrap (`face_unwrap3.jpg`) is next, and the ChatGPT ¾ coloured-pencil portrait counts least. Rest face is relaxed with the faintest smile; the big grin is a reaction only. Skin tone, dark-brown messy hair and receding temples come from his photos. Never double features (eyes, teeth). Never upload his photos anywhere.
  - Generated head: `tools/character/head.py` → `src/assets/neil/head.bin`, `head.jpg`; runtime in `src/golfer/genhead.ts`. Profile `head: 'generated' | 'makehuman'`.
  - The generated head's raw shape came from Hunyuan3D-2 (HF Space, seed 1234) on the coloured-pencil portrait, with the owner's OK. Raw mesh: scratchpad `dl/hy2shape_s1234/…/white_mesh.glb`.
- **Clothes:**
  - Malbon Fairway Polo, Forest green: plain matte jersey, white script "m" (`src/assets/brand/malbon-m.svg`) on the left chest at 2nd-button height, 2 white buttons, a natural fold-over collar with no back seam, TUCKED IN.
  - Brown leather belt with a silver buckle (Indochino front, Zalando back references).
  - Khaki chino shorts (#c9ad7c) with a proper rise (about 25–27 cm crotch to waistband, waistband at the natural waist), hem about 10 cm above the knee.
  - White ankle socks.
  - White FootJoy Premiere-style wingtips with a tan stacked sole, no red.
  - White one-piece cotton Pizza Hut visor (classic logo, `src/assets/brand/pizza-hut-classic.svg`), logo centred, rounded brim with no V, white back strap.
  - Glove on the RIGHT hand (his lead hand).
- **Bag:** his actual **Jones Rover stand bag** (white top, royal-blue bottom, black trim, orange pull tab) stands near him on the tee.

## Swing (top priority with the face)
- **Code:** keyframed + IK in `src/golfer/golfer.ts`, `rig.ts`, plus the captured swing (`mocap.ts`). Assertion scripts in `tools/swing-check/` (see "Swing state after session 2").
- **References, traced with MediaPipe locally and mirrored for a lefty:**
  - Jaco van Zyl DTL gif, Justin Rose DTL gif
  - Sadlowski DTL + face-on driver pairs
  - Rory face-on slow-mo video (owner's iCloud recording)
  - golfdistillery 8-frame illustration
  - Rory finish photo (the target finish)
- **Known issues being fixed:**
  - Trail (LEFT) arm crumples at delivery: the elbow should be low in front of the trail hip.
  - The finish is chicken-winged and leans right: it should be Rory's tall stacked finish with the lead elbow pointing down.
  - Trail heel lifts slightly at delivery; hands wrap the grip properly; head stays steady.
- **Per-club setup:** driver about 70 cm toe to ball, teed with 3.7 cm of peg; 3-wood on a low tee; 7i about 53 cm. Full swings carry ≥60% of the club's distance. A lefty's path curve is mirrored (hook goes right).
- **Next:** an intro pose facing the camera, then step-in-to-address animation API for the HUD.
- **Idle at address (queued for the next swing agent):** while waiting at address, Neil shouldn't be frozen:
  - small natural movement: breathing, tiny weight shifts, a settle of the feet;
  - every few seconds, a small waggle of the club: the clubhead lifts and swings back a few inches with the wrists, then sets back behind the ball;
  - Rose's opening waggle in tools/refs/swing/rose_dtl.gif is the reference.
  - If the player starts the swing mid-waggle, the swing just goes from wherever the club is: blend smoothly from the current waggle pose straight into the takeaway, with no snap back to address and no delay. Swing input always wins.

### Swing state after session 2 (swing agent)
- **Two swing sources.** `golfer.swingSource = 'mocap'` is the default (the captured Rory swing, `src/golfer/mocap.ts`, `swingclip.ts`); `?swing=keyed` or `swingSource = 'keyed'` gives the hand-keyed one. The captured path blends to the keyed swing at address, around mid-backswing, through impact and into the held finish, so the per-club set-up, the strike, the attack angle and Rory's finish all come from the keyed code.
- **Assertions live in the repo now:** `tools/swing-check/` (copies of the scratchpad scripts; Playwright + swiftshader, Vite on port 5230). `SWING=mocap node check.mjs 6` runs them on the captured swing (default is keyed).
  - `check.mjs [club] [tee]`: lead elbow ≥165° address→top and impact→through, trail elbow in front of the hip and ≤ belt + 5 cm at delivery/impact, steady head (≤4 cm lateral, ≤2.5 cm vertical), trail-foot pivot ≤2 cm, lead flare 20–30°, stacked finish.
  - `events.mjs`: the 12-event figure (`tools/refs/swing/swing_events_12.png`): MB, LBA, TB, ED, MD, BI, MF, LF.
  - `setup.mjs`: per-club stand distance, ball position, shoulder tilt, attack angle, low point, both hands on the grip.
  - `handorder.mjs`, `strip.mjs`, `shot.mjs`, `fincmp.sh` (finish next to Rory), `gripcmp.sh`.
- **Per-club set-up is continuous by club length** (`clubLengthT(spec)` in club.ts, 0 = lob wedge, 1 = driver): stand distance, ball position, shaft lean (driver hands behind the teed ball), trail-shoulder tilt, toe-up lie for the long clubs, grip a touch stronger with the long clubs, weight forward with the short ones.
- **Attack angle:** `golfer.attackAngleDeg()` / `attackAngleDeg(spec)` in club.ts: driver +3°, 3 iron 0°, wedges −5°. The head's path through the ball follows it. Divots and launch can read it; nothing in shot.ts or divots.ts was changed.
- **Arms are 8% longer than the base mesh** (`ARM_SCALE`, `Rig.scaleArms`): the mesh's were short for 6'3" and left no slack to reach the club. The trail shoulder blade can also slide ≤4.5 cm (`BodyPose.shoulderR`).
- **Known gaps:** trail elbow at delivery is 6–8 cm above the belt with the wedges and on the captured swing (limit 5); driver toe-to-ball is 87 cm (the coordinator asked for 75–80; with a straight lead arm and a 46" shaft he can't stand closer); hands are better (index hooks, thumbs down the grip, stronger grip) but still rough close up; the Rory face-on video fusion (item 7) was not done.

### Intro, walk-in and idle waggle API (for main.ts / the HUD)
All on `Golfer` (src/golfer/golfer.ts); works with either swing source.
- **Intro pose:** `golfer.update({ phase: 'address', phi: 0, topPhi: PHI_TOP, idleT: 0, intro: 0, lookAt: camera.position })`. He stands upright a step back from the ball, feet together, both hands on the club stood on the turf in front of him, looking at `lookAt`.
- **Walk-in, either way:**
  - scrub it: pass `intro: u` with u from 0 to 1 (`INTRO_SECONDS` = 1.8 s at natural speed). He looks at the camera, steps in with the lead foot then the trail foot, the club swings down behind the ball, and he bends into the set-up. `intro: 1` (or leaving `intro` out) is the exact address pose.
  - or let him run it: `await golfer.playIntroToAddress()` (optional seconds). Keep calling `update({ phase: 'address', ... })` every frame without `intro`; the promise resolves when he is at address. `golfer.introProgress` is 0..1 while it runs, else null.
  - Until the player taps, keep passing `intro: 0`. Start `idleT` from 0 once he is at address.
- **Idle at address:** driven by `idleT` in the address phase: breathing, a slow weight shift, a look down the range every 6.5 s (first at 4.5 s), and a two-pump waggle every 6.5 s (first at 2.6 s). `golfer.waggling` is true while the club is off the ball.
- **Swing input always wins:** just start sending `phase: 'back'` as usual. If a waggle is in progress the backswing carries on from where the club is (no snap back, no delay); the head start fades out over the first fifth of the backswing.
- golfer.html: `pose=intro&iu=0.4`, `pose=address&idle=3.0`.

## Ball / physics
`src/game/ball.ts`, `shot.ts`.
- Drag and Magnus lift, wind (`WIND`, log height profile).
- Bounce, roll and check by club.
- Strike point: low → higher, inner → draw.
- Aftertouch spin.

## UI / HUD (`src/ui/hud.ts`, `hud.css`, `src/game/shotcam.ts`, `aim.ts`, `main.ts`)
Playful, not corporate, and minimal data (details behind a "Shot details" sheet).
- **Intro:** "THE HUNT" title at the top, Neil's name in a Lobster script, tap anywhere to start. Neil faces the camera, then the camera orbits behind him as he addresses the ball.
- **Swing view:**
  - Club chip with the shot type picker inside (Full/Punch/Pitch/Flop); "Driver", not 1W.
  - Full lie card (navy 0° when flat), wind chip.
  - Live 3D face badge, big (about 84–96 px), stacked vertically: the face, then the "NEIL" name pill, then the timing word (Very early / Early / Slightly early / **Perfect** / Slightly late / Late / Very late) with the shape word under it when it curves (Duck hook / Hook / Draw / Cut / Slice / Banana slice, lefty-aware). Reactions plus a speech bubble to the right.
  - **The badge must ALWAYS show his face, front-on and level**, never the top of the head, the back or a dark side, in every state (intro, address, top, impact, finish, aim, flight, landing). Render it from a stable face camera in head space with the head's pitch and roll cancelled (or a separate head instance driven only by the expression state), with its own key and fill light, framed head and shoulders.
  - Bigger strike ball.
  - Editorial Mono big distance number.
- **Swing stick:** no guide text, a bold growing power ring, not blue.
- **Spin control:** replaces the swing stick in the same centred spot after impact, is big, and visibly spins faster with added backspin.
- **After the shot:** hide everything above the face badge.
- **Aim:** tap anywhere off-controls to enter aim mode (X to exit). Pinch/drag only, no zoom or loft buttons, smooth camera flights in and out.
- **Long-shot cinematic camera:** random variants (freeze-and-orbit at impact, stay behind then cut to a downrange TV cam, behind→face→follow, a low turf cam). Tap skips with a fast camera flight; hold fast-forwards.

## Course (`src/world/range.ts`, `divots.ts`, `src/render/*`)
- Toronto Hunt look from the owner's 3 real photos: big oaks and maples with high canopies and dappled shadows, rich mown turf with stripes, white "claw" bunkers, golden-hour light. No lake yet.
- Yellow pins (7 ft) and flags with the Toronto Hunt crest, waving with the wind.
- Bigger greens.
- The target green auto-moves to the selected club's distance.
- Divots by club (wedges biggest, none with woods/teed shots); they must look like turf, not planks.
- Perf tiers in `src/render/perf.ts` (`?perf=low|med|high`).

## Style
**Why hand-drawn at all:** hyper-realism is "too hard" to get right (skin, face likeness, hands, cloth, trees). The finish exists to make those gaps forgivable, not as a stylistic goal. Use subtle painterly simplification (soften CG sheen and texture noise, gentle brush texture, a small edge-preserving smoothing on skin and cloth) over linework, and keep the face readable. "Hand-drawn but realistic", but only **a bit**: the owner said the full finish was "way too hand-drawn". The post finish is a faint silhouette ink line, almost no hatching, light paper grain, and the face kept clean, as the game default at about 30% intensity (`?ink=0..1` to tune it). `?style=real` turns it off. Style lab: `src/render/styles.ts`, `style.html`.

## Working rules that matter
- Agents edit main.ts concurrently: make targeted edits, re-read before editing, keep `npx tsc --noEmit` clean.
- The machine is shared and slow: render one frame at a time, use one browser.
- Show the owner screenshots of every UI and visual change, often.
- Puffy repo: don't touch it (golf was removed from it on purpose).

## Latest owner feedback (open items as of this handoff)
**Swing**
- Finish: wrap the club further round like Rory. The shaft ends roughly parallel to the shoulder line, behind the neck, with the clubhead out past the trail shoulder, not resting on the shoulder. Hands high, behind the lead ear; the face stays visible.
- Lead (front) foot flared 20–30° toward the target at address, kept through the finish. It isn't square at 90°.
- Glove (RIGHT, lead) hand grip STRONGER: 2.5–3 knuckles showing, the V to the trail shoulder. Refs: Rory, https://thegratefulgolfer.com/wp-content/uploads/2015/01/strong-golf-grips.jpg?w=676
- The clubface looked closed at delivery: square to the plane, toe-up.
- Earlier, done: delivery trail-arm slot, Rory-style stacked finish, driver setup and tee. The assertion scripts live in the swing agent's scratchpad; recreate them (elbow angles, trail elbow in front of the hip, finish stack, foot pivot).

**Face**
- The owner preferred the UNLIT render in the A/B: the face should be shaded mostly from the baked real-photo texture (largely unlit/emissive plus soft lighting for form), with low spec and normal strength.
- Clean up the texture: remove the dark hair strand on the forehead, smooth the artifacts on the lips and nose, and fix the right eyebrow.
- Ears: proper geometry, about 6.5 cm, close to the head, angled back.
- Rest face: a small closed-mouth smile, real painted eyes (no glassy shader iris), hair thinner on top with receding temples and some grey.

**Clothes**
- The shirt is "really bad": it looks like an inflated sack. It needs a fitted polo with shoulder seams, less standoff, real folds. Rory's polo in tools/refs/swing/rory_finish.jpg is the fit reference.
- Shorts: no pocket and hip bulge ("I don't have hands in my pockets"); straight legs, a flat fly with drag folds, and a back seam.

**UI**
- When aiming short of the club's max, show a target line on the swing-stick power meter at the pull depth for that distance (account for FULL_MIN and the mode max), with near-target feedback, and suggest Punch/Pitch when it's below the full-swing minimum.

**Style**: the finish is still "way too hand-drawn" in course renders; the default must be very subtle (no outline, no hatching, light grain, gentle painterly smoothing).

**Bag**: the first Jones Rover model was crude. Rebuild it as a soft, tapered fabric bag and place it further back as a background detail.
- **Face animation (owner wants smiling, blinking and talking):** `body.face.setExpression({smile, grimace, browUp, browDown, jawOpen, blink})`, `lookAt` and `setGaze` exist, and the idle blink works. Next:
  - a mouth interior (teeth, tongue, cavity) so the open mouth and grin look right;
  - about 6 visemes plus `face.say(text)` lip-flap synced to the HUD speech bubble;
  - a full grin with teeth and eye squint.

## State at handoff (session 1 end)
The container restarted and stopped all agents mid-round; their committed work is on main. Playable link republished (version 9).

**Swing: done**
- traced van Zyl and Rose timing and elbow poles;
- delivery slot (trail elbow in front of the hip, heel lift);
- Rory-style stacked finish;
- driver/3W/7i/wedge setup and tee;
- lead foot flared about 29°;
- fingers hooking across the grip.

**Swing: in progress when stopped** (swing agent round "s13"; screenshots only in a lost scratchpad):
- finish club wrap parallel to the shoulders and hands higher behind the lead ear;
- stronger glove-hand grip;
- clubface square at delivery;
- hands round 2 (thumbs, rest curl, visual check);
- steady-head assertions;
- release visibility;
- Rory face-on fusion (tools/refs/swing/rory_faceon_slowmo.mp4);
- Sadlowski driver views;
- the intro pose and step-in API (the HUD waits on it), with the idle waggle.

**Face: done**
- the multi-view shape fit to the real photos;
- the real-photo texture;
- mostly-unlit shading;
- visor height and the preloaded logo;
- the rest smile (1.0);
- the receding hairline.

**Face: next** — ears (clean geometry), the profile fit, then the talk-ready mouth, visemes and `say()`.

**Clothes: done** — shorts rise; belt; the tucked shirt.

**Clothes: next**
- polo: the first fitted pass is in (a0e6f63: less standoff, seams, knit, folds). Keep refining against Rory's polo, checking it in motion;
- shorts: straighter legs and a flat fly are in, but they still flare wide and boxy at the hip and thigh in the swing (s3 render). Slimmer, with no pocket bulge;
- elbow and knee correctives rendered;
- shoes against FootJoy.

**UI: done**
- tap-to-aim;
- the camera variants (orbit, freeze, cut, low);
- the stacked face badge;
- swing words;
- the editorial number;
- the compact lie chip with a % range;
- the bottom-right club chip;
- the preview tracer;
- the power target plus the full mark;
- aim clamped to the reachable range;
- the spin control in the stick's place.

**UI: next**
- the yellow, thicker preview tracer, depth-tested behind the golfer;
- bigger strike ball and club chip (about 80 px);
- club chip colour options (yellow, green, cream, gold; NOT navy) for the owner to pick;
- the face badge always showing the face (the 8-state check);
- the remaining storyboard renders.

**Course: next**
- the bag still reads tall and thin (widen it about 30%, base and legs on the ground);
- softer trees;
- the golden-hour colour match against tools/refs/course;
- the med perf budget.

**Style:** default = "soft"/polished (subtle). Options via `?style=`; the owner hasn't picked.

- **HUD face badge = a SEPARATE head instance (owner's decision):** a second, independent copy of the generated head (head.bin, head.jpg, hair, visor), rendered alone into the badge with its own small camera and light rig.
  - It does NOT follow the golfer's head pose mid-swing. It's always front-on, level and well lit.
  - It has its own expression and animation state: idle blinks, glances at the player, reactions (grin, grimace, brows), and talking (visemes and `say()`) synced to the speech bubble. The golfer in the world doesn't need to do any of that.
  - Share geometry and textures with the main head; only the morph and expression state differs.
  - Keep it cheap: render about every other frame into a 192 px target, and pause when idle and static.

## Backlog (owner asked; don't start until the current golfer is solid)
**More characters:** package the pipeline as a `new-character` skill/script:
- **Inputs:** photos, height and weight, handedness, outfit choices.
- **What it does:** writes the profile JSON, runs build.py and head.py (Hugging Face shape generation needs a token for volume, with a MakeHuman-fit fallback), fits the headwear, and renders a check sheet.
- **Also:** a gear and clothing library with swappable colours and logos; per-player swing personality (tempo, backswing length, finish, waggle, optionally traced from a friend's video); a player picker on the intro screen; a per-player badge face and voice lines.
