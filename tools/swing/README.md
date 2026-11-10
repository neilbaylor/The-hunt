# Swing capture: real 3D motion from video → the game rig

The golfer's swing plays a clip recovered in 3D from pro swing videos. **This is the default.** The old hand-keyed
swing is still there: `?swing=keyed` (golfer.html or the game), or `golfer.swingSource = 'keyed'`.

## What is here
| Path | What |
|---|---|
| `clips/` | Prepared videos that were uploaded: `rory_faceon_clean.mp4` (37 stills, one per frame), `rory_faceon_clean_slow.mp4` (same, slowed for viewing), `faceon_clip2.mp4`, `vanzyl_dtl.mp4`, `rose_dtl.mp4` |
| `raw/*.gvhmr.npz` | Raw GVHMR output per clip: SMPL-X `world_global_orient`, `world_body_pose` (21 joints, axis-angle), `world_transl`, `world_betas`, camera-frame copies, `intrinsics`, `kp2d`, plus `joints_world` / `joints_camera` (22 joints), `joints_rest`, `parents` |
| `data/<clip>.json` | Compact per-frame data in the golf frame: 22 joint positions, 22 global joint rotations (quaternions), lead-arm angle, and the swing events |
| `data/rory_faceon_clean.shaft.json` | Club shaft direction per frame (see "Club") |
| `shaft_annot.json` | The hand-labelled club observations |
| `out/` | Skeleton overlays and comparison sheets |
| `../../src/golfer/swingclip.ts` | GENERATED clip the game plays (40 numbers × 37 frames) |
| `../../src/golfer/mocap.ts` | Samples the clip and maps the game's swing state onto it |

**Golf frame:** +X toward the target, +Y up, +Z the way the golfer faces at address; origin between the ankles at
address. Right-handed golfer, lead side = left. This is the game's character space, and the game mirrors the whole
character for a left-hander, so **nothing is mirrored in the data**: the original right-handed videos were uploaded
as they are.

## Run it again
The Hugging Face token is read from `$HF_TOKEN` or `/root/.cache/hf/token`. It is never written anywhere here.
Only the pro clips in `clips/` may be uploaded (owner's consent); never the owner's photos.

```bash
cd tools/swing
# 1. prep (already done; outputs are in clips/)
python3 stabilise.py ../refs/swing/rory_faceon_slowmo.mp4 rory_stab_full.mp4 700 "[[88.3,183.3],[261.7,165.0],[258.3,446.7],[88.3,441.7]]"
python3 mp_pose.py rory_stab_full.mp4 rory_mp.npz        # local MediaPipe, only used to find the held stills
python3 rory_stills.py && python3 rory_clean.py rory_stab_full.mp4 rory_clean   # -> rory_clean.tmp.mp4, re-encode with ffmpeg
ffmpeg -i ../refs/swing/vanzyl_dtl.gif -vf "scale=720:720:flags=lanczos,setpts=N/30/TB" -r 30 -pix_fmt yuv420p -c:v libx264 -crf 16 clips/vanzyl_dtl.mp4

# 2. capture (about 15 s of ZeroGPU per clip; each download goes in its own new directory)
for c in rory_faceon_clean vanzyl_dtl rose_dtl faceon_clip2; do
  python3 run_gvhmr.py tigretibu/gvhmr-demo clips/$c.mp4 /tmp/gvhmr_$c && cp /tmp/gvhmr_$c/*/motion.npz raw/$c.gvhmr.npz
done

# 3. extract + events, club, retarget (-I: the npz files are untrusted data, loaded with numpy only, no pickle)
for c in rory_faceon_clean vanzyl_dtl rose_dtl faceon_clip2; do python3 -I extract.py raw/$c.gvhmr.npz data/$c.json; done
python3 -I shaft_fuse.py
python3 -I retarget.py            # writes src/golfer/swingclip.ts

# 4. look at it (dev server on :5230)
python3 -I viz.py clips/vanzyl_dtl.mp4 raw/vanzyl_dtl.gvhmr.npz out/skeleton_vanzyl_dtl.jpg 10
P=$(python3 -I event_poses.py)
node ../swing-check/strip.mjs /tmp/mocap.png "view=pgame&club=0&swing=mocap" $P 300 560
node ../swing-check/strip.mjs /tmp/keyed.png "view=pgame&club=0" $P 300 560
python3 -I compare.py /tmp/mocap.png out/mocap_vs_keyed_gamecam.jpg rory_faceon_clean mocap /tmp/keyed.png
```
Space notes: `tigretibu/gvhmr-demo` and `phrographica/gvhmr-demo` work (ZeroGPU, 60 s cap per call; the Space asks
for 20 s + 3.5 s per second of video, so keep clips under about 10 s). Anonymous quota is about a minute a day.
`ryanrudes/gvhmr-demo` (CPU) fails at start-up; WHAM, HMR2.0, HaMeR, SMPLer-X and multi-hmr Spaces were paused or broken.

## The Rory clip
`rory_faceon_slowmo.mp4` is a phone recording of a laptop playing a swing *sequence*: 37 stills held 20 frames each,
with rewinds. `stabilise.py` tracks the screen (SIFT + homography) and rectifies the player panel to 720×1280;
`rory_clean.py` takes the temporal median of each held still (address→impact from the pass at frames 367–847, release→finish
from 1225–1498). So this clip has real poses but **no real timing**; timing comes from the game.

## Swing events
The clips are labelled with the 12 events of Haddas et al. (`../refs/swing/swing_events_12.png`) plus the finish,
detected from the lead-arm angle in the frontal plane (0° = hanging down, + = backswing): MB 40°, LBA 90°, LB and EPR
45% and 85% of the way from 90° to the top, TB the maximum, EDA back at 60%, ED 90°, MD 30°, BI hands back past
address, MF −45°, LF −90°, FIN where the hands stop. Frame numbers (fractional = between frames):

| Clip | BA | MB | LBA | LB | EPR | TB | EDA | ED | MD | BI | MF | LF | FIN |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rory_faceon_clean | 0 | 6.51 (arm-only 4.86) | 9.85 | 11.91 | 13.99 | 16 | 18.77 | 20.09 | 22.43 | 23.59 | 25.67 | 27.58 | 36 |
| vanzyl_dtl | 1 | 7.74 | 12.41 | 14.1 | 15.94 | 17 | 20.13 | 21.45 | 24.0 | 25.17 | 26.74 | 28.81 | 41 |
| rose_dtl | 24 | 34.29 | 40.53 | 42.03 | 43.7 | 45 | 48.05 | 49.16 | 51.46 | 52.33 | 53.97 | 56.08 | 76 |
| faceon_clip2 | 21 | 26.86 | 32.92 | 34.81 | 37.1 | 39 | 42.35 | 44.03 | 46.79 | 47.71 | 50.04 | 52.59 | 62 |

The figure defines MB, MD and MF by the club being horizontal. For the Rory clip, which has a shaft direction per
frame, those three are refined to the frame where the shaft crosses horizontal (`shaft_fuse.py`; the arm-only values
are kept as `events_arm` in the JSON). The other three clips have no per-frame shaft, so theirs are by arm angle only.

## Club
GVHMR recovers the body only. The shaft direction comes from **hand-labelled** club positions in the video frames
(`shaft_annot.json`): where the club head is visible, its foreshortening gives the out-of-image part of the direction
(sign labelled per frame); where only part of the shaft is visible, the in-image direction is used and the depth is
interpolated. Rory's panel crops the club in the mid-backswing (frames 7–10), so there the shaft comes from the van Zyl
down-the-line clip at the same event. The automatic detector (`shaft.py`) only gets the first few frames right and is
not used. The club's roll about its shaft is not observed: the game solves it so the lead hand continues the forearm.

## Retarget (retarget.py → swingclip.ts → mocap.ts → Golfer.updateMocap)
- Body: pelvis and chest turn / tilt / side bend are read from the SMPL-X pelvis and spine3 rotations in the rig's own
  angle conventions, and applied as the **change from the clip's address** on top of the game's address for the club
  in hand, so the per-club set-up is untouched.
- View fusion: pelvis slide and height from the face-on clip; pelvis depth from the down-the-line clip (a face-on
  camera can't see it; raw face-on depth was ±15 cm of noise).
- Arms: lead-arm direction and extension, and both elbow directions, in the chest's frame; scaled by the rig's arm
  length. The trail hand follows the club.
- Legs: feet stay planted through the game's own foot code; trail heel lift from the clip's foot pitch; lead knee from
  the clip's thigh.
- Club: shaft as above, carried by the lead hand; blended to the keyed club at address (BA→MB) and through impact
  (MD→BI→MF) so the head sits behind the ball and meets it.
- Club roll (face): follows the plane. The face normal is shaft × lead forearm, which gives toe up at MB, and at the
  top the face parallel to the lead forearm, toe hanging down, leading edge ~45° and the head down the target line.
  Around MF the toe is held straight up (the forearm rule would leave the face rolled over there). Square at BI comes
  from the impact pin. `node clubcheck.mjs 0 out/clubheads_events.png` asserts this at every event and renders
  clubhead close-ups (face-on over down-the-line).
- Mid-backswing: the owner prefers the hand-keyed MB, so around MB the pose blends to the hand-keyed swing at the same
  hands angle (body, arms and club), feathered in from 20% of the way BA→MB and out by 75% of the way MB→LBA.
- Timeline: the game's hands angle maps onto the clip by lead-arm angle (back BA→TB, down TB→BI, follow BI→FIN).

## Known limits
- Rory's downswing is only 5 stills from top to impact, so the club path there is interpolated.
- The finish follows Rory's last still (club dropped behind the back), not a hand-tuned "held" pose.
- One swing plane (a driver's) is used for every club between the pins.
- Fingers are not captured (HaMeR/WiLoR Spaces were not run); the game's grip code poses them.
