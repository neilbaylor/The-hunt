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
- **Code:** keyframed + IK in `src/golfer/golfer.ts`, `rig.ts`. Assertion scripts in the scratchpad (armcheck.js, footcheck.js).
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
