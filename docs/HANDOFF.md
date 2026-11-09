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
  - Live 3D face badge with the swing word under it ("Smooth" / "Pured it") and reactions plus a speech bubble.
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
"Hand-drawn but realistic": a post finish (soft ink contours, light shadow hatching, paper grain, face kept clean) is the game default; `?style=real` turns it off. Style lab: `src/render/styles.ts`, `style.html`.

## Working rules that matter
- Agents edit main.ts concurrently: make targeted edits, re-read before editing, keep `npx tsc --noEmit` clean.
- The machine is shared and slow: render one frame at a time, use one browser.
- Show the owner screenshots of every UI and visual change, often.
- Puffy repo: don't touch it (golf was removed from it on purpose).
