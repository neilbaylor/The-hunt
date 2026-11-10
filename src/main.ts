// The driving range: Neil on the tee, the swing pad, the ball in flight, the spin ball, the cameras.
import * as THREE from 'three';
import { createRange, type Range } from './world/range';
import { createDivots } from './world/divots';
import { createStandBag } from './world/standbag';
import { createPost } from './render/post';
import { PerfGovernor, initialTier } from './render/perf';
import { Golfer, PHI_TOP, PHI_FINISH, SHOT_STYLE, type SwingPhase } from './golfer/golfer';
import { NEIL } from './golfer/profile';
import { loadNeil } from './golfer/assets';
import { CLUB_SPECS } from './golfer/club';
import { Ball, BALL, WIND } from './game/ball';
import { planShot, LIES, YD, type ShotPlan } from './game/shot';
import { Tracer } from './game/tracer';
import { AimPreview } from './game/preview';
import { ShotCam, isLongShot, pickVariant, type ShotCamCtx } from './game/shotcam';
import { Sound } from './game/audio';
import { Hud, viewport, type CardData } from './ui/hud';
import { tourBallMaterial } from './ui/ballmat';
import { FaceBadge, AVATAR_LAYER, type Outcome } from './ui/facebadge';
import { AimController, aim } from './game/aim';
import { MODES as SHOT_MODES, FULL_MIN } from './game/shot';

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ── renderer ──
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
const QS = new URLSearchParams(location.search);
// the starting pixel ratio; PerfGovernor (below) sets it per tier and lowers it when frames run long
renderer.setPixelRatio(QS.has('pr') ? +QS.get('pr')! : Math.min(devicePixelRatio, 1.75));
renderer.setSize(viewport().w, viewport().h);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.getElementById('app')!.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, viewport().w / viewport().h, 0.1, 7000);
let range: Range | null = null;
// performance tier (src/render/perf.ts): ?perf=low|med|high pins it; otherwise device hints, then a frame probe
const perfInit = initialTier(renderer, QS);
try { range = createRange(renderer, scene, { detail: perfInit.tier }); range.setTimeOfDay(QS.get('time') === 'midday' ? 'midday' : 'golden'); } catch (e) { console.error('range failed', e); }
// post-processing: high on desktop, medium on phones (falls back to low if frames run long)
const coarse = matchMedia('(pointer: coarse)').matches;
const post = createPost(renderer, scene, camera, { quality: (QS.get('q') as any) ?? (coarse ? 'med' : 'high'), grade: range?.timeOfDay ?? 'golden', toneMapping: 'agx', finish: QS.get('style') === 'real' ? 'real' : 'hand' });
const _faceHead = new THREE.Vector3();
// tiers drive the pixel-ratio cap, post quality and range detail, and step down while frames run long (>20 ms)
const perf = new PerfGovernor(renderer, { post, range, resize: () => onViewport() }, perfInit, QS);
// sharp, soft-edged shadows around the golfer while he swings; wide ones when the ball flies
function shadowsOnGolfer(on: boolean) {
  if (!range) return;
  if (on) { const feet = golfer.ballWorld().add(new THREE.Vector3(golfer.lefty ? 0.9 : -0.9, 0, 0)); feet.y = 0; range.setShadowFocus(feet, 3.5); range.contactShadow(feet, 1, 0.5); }
  else { range.setShadowFocus(null); range.contactShadow(null); }
}
if (!range) { scene.background = new THREE.Color('#9cc3e0'); scene.add(new THREE.HemisphereLight('#cfe6ff', '#4a6a30', 1.2)); }

// ── golfer, ball, tracer ──
const profile = NEIL;
const golfer = new Golfer(profile, await loadNeil());
scene.add(golfer.root);
const ball = new Ball(range);
// tour ball: Pro V1x print, dimple normals/AO and clearcoat (src/ui/ballmat.ts, shared look with the HUD balls)
const ballMat = tourBallMaterial();
const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(BALL.r, 64, 40), ballMat);
ballMesh.castShadow = true; scene.add(ballMesh);
// a soft halo round the ball in flight so it reads against the sky on a phone
const ballGlow = new THREE.Sprite(new THREE.SpriteMaterial({
  map: (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d')!, gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,250,.9)'); gr.addColorStop(0.25, 'rgba(255,250,235,.45)'); gr.addColorStop(1, 'rgba(255,245,220,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })(),
  transparent: true, depthWrite: false, toneMapped: false,
}));
ballGlow.visible = false; ballGlow.renderOrder = 4; scene.add(ballGlow);
// a white painted wooden tee: pointed shank, flared neck and a shallow cup with a rolled rim (origin = old centre,
// so the ball's bottom sits in the cup at y = +0.022); most of the shank is pushed into the turf by teeUp()
// impact divots (src/world/divots.ts): turf strip, scar and clippings on iron shots; cleared with the next ball
const divots = createDivots(scene, (x, z) => range?.heightAt(x, z) ?? 0);
// Neil's Jones Rover stand bag on the tee, a few metres beyond him and to the side: a background detail in the swing cam, seen in the intro,
// clear of the ball and the line; the front pocket turned toward the swing camera
const standBag = createStandBag();
{ const bx = golfer.lefty ? 2.15 : -2.15, bz = -3.3; standBag.position.set(bx, range?.heightAt(bx, bz) ?? 0, bz);
  standBag.rotation.y = golfer.lefty ? 2.5 : -2.5; scene.add(standBag); } // pocket three-quarter to the swing cam, legs back and out
const tee = new THREE.Mesh(new THREE.LatheGeometry([
  [0.0002, -0.031], [0.0013, -0.027], [0.002, -0.017], [0.0022, 0.006], [0.0027, 0.012], [0.0046, 0.018], [0.0066, 0.0214],
  [0.0074, 0.0231], [0.0068, 0.0236], [0.0058, 0.0226], [0.0036, 0.0212], [0.0, 0.0207],
].map(([r, y]) => new THREE.Vector2(r, y)), 24), new THREE.MeshStandardMaterial({ color: '#f3f0e6', roughness: 0.55 }));
const teeCup = new THREE.Mesh(new THREE.TorusGeometry(0.0071, 0.0006, 6, 24), tee.material);
teeCup.rotation.x = Math.PI / 2; teeCup.position.y = 0.0232;
tee.castShadow = teeCup.castShadow = true; tee.receiveShadow = true;
tee.add(teeCup); scene.add(tee);
const tracer = new Tracer(); scene.add(tracer.mesh);
// a soft key/fill light that follows the camera so the golfer reads in golden-hour backlight (TV-style)
const fill = new THREE.DirectionalLight('#fff3e6', 0.9);
scene.add(fill, fill.target);

// ── HUD + sound ──
const hud = new Hud(document.body, profile);
hud.onSpinTick = lvl => sound.whirr(lvl);
{ const c = QS.get('chip') ?? QS.get('coin'); if (c && /^[abcd]$/.test(c)) document.body.dataset.coin = c; }   // club chip colourway try-outs: ?chip=a|b|c|d (navy until the owner picks)
hud.el.classList.add('hidden');
const sound = new Sound();
hud.club = 6; hud.mode = 'full'; hud.lie = 0; hud.render(null);
hud.onClub = i => { sound.ui(); golfer.setClub(i, hud.mode); teeUp(); aimCtl.clubChanged(); featureTarget(); };
hud.onMode = m => { sound.ui(); golfer.setClub(hud.club, m); teeUp(); aimCtl.clubChanged(); featureTarget(); };
// the range sets a target green (yellow crest flag) at the full carry of the club and shot in hand
function featureTarget() { range?.setFeaturedTarget(SHOT_MODES[hud.mode].max(CLUB_SPECS[hud.club].id)); }
featureTarget();
// ── aiming (src/game/aim.ts): ground arrow in the swing cam, overhead aim view with a draggable ring ──
const aimCtl = new AimController({
  scene, camera, canvas: renderer.domElement, range, lefty: golfer.lefty,
  ballPos: () => golfer.ballWorld(new THREE.Vector3()),
  // the reachable band for the club and shot type: a full swing goes 60-100% of the club's carry; the other modes 30-100% of their own max
  carry: () => { const full = SHOT_MODES[hud.mode].max(CLUB_SPECS[hud.club].id); return { full, min: Math.max(5, Math.round(full * (hud.mode === 'full' ? FULL_MIN : 0.3))), max: full }; },
  // the golfer turns to face the aim line (he stands round the ball, which sits at the origin)
  onChange: () => { golfer.root.rotation.y = -aim.dir; golfer.root.updateMatrixWorld(true); if (state === 'ready') teeUp(); },
  shapeAt: (t, out) => preview.pointAt(t, out),
});
hud.onLie = () => { sound.ui(); teeUp(); };
// ?lie=3 or ?lie=rough: start on that sample lie (HUD checks)
{ const l = QS.get('lie'); if (l) { const i = /^\d+$/.test(l) ? +l : LIES.findIndex(x => x.name.toLowerCase().replace(/\s+/g, '').startsWith(l.toLowerCase())); if (i >= 0 && i < LIES.length) { hud.lie = i; hud.render(null); } } }

function teeUp() {
  // off the tee box: driver teed high (ball's equator at the top of the face, ~3.7 cm of tee showing),
  // 3 wood low (~1.25 cm); everything else from the turf
  const spec = CLUB_SPECS[hud.club], onTee = LIES[hud.lie]?.name === 'Tee box';
  const teeH = !onTee ? 0 : spec.kind === 'driver' ? 0.037 : spec.id === '3W' ? 0.0125 : 0;
  golfer.setTee(teeH);
  const p = golfer.ballWorld();
  ball.tee(p);
  ballMesh.position.copy(p);
  tee.visible = teeH > 0;
  tee.position.set(p.x, p.y - BALL.r - 0.03 + 0.008, p.z);   // the cup (0.022 above the tee's origin) under the ball
}

// ── swing state ──
type GameState = 'intro' | 'ready' | 'swinging' | 'flight' | 'result';
let state: GameState = 'intro';
const G = { phase: 'address' as SwingPhase, phi: 0, target: 0, arrived: null as number | null, topPhi: PHI_TOP, idleT: 0, followT0: 0, followTo: PHI_FINISH, returnT0: 0, returning: false };
const SW = { active: false, phase: 'idle' as 'idle' | 'back' | 'down', press: [0, 0] as [number, number], trailB: [] as [number, number][], trailD: [] as [number, number][], depth: 0, deep: [0, 0] as [number, number], tTrans: 0, t0: 0, tDeep: 0, tAt: 0, off: 0, driftSum: 0, driftN: 0, last: [0, 0] as [number, number] };
let plan: ShotPlan | null = null;
let card: CardData | null = null;
let hitStop = 0;
// ── fast forward (hold the 3D view while the ball is in the air) ──
// Self-contained: its own little pill at the top centre, outside the HUD's DOM, so HUD styling isn't disturbed.
const ff = { held: false, scale: 1, pill: document.createElement('div') };
ff.pill.textContent = '⏩ 3×'; ff.pill.hidden = true; ff.pill.setAttribute('aria-live', 'polite');
ff.pill.style.cssText = 'position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 64px);transform:translateX(-50%);z-index:40;'
  + 'padding:6px 14px;border-radius:999px;background:rgba(20,30,52,.78);color:#fff;font:700 14px/1 system-ui,sans-serif;'
  + 'letter-spacing:.06em;pointer-events:none;box-shadow:0 4px 14px rgba(0,0,0,.25)';
document.body.appendChild(ff.pill);
let resultT = 0;
const style = () => SHOT_STYLE[hud.mode];
const fullBack = () => PHI_TOP * style().back * profile.swing.length;
// Backswing: the golfer follows the finger with a short lag, so the top arrives about when the pull ends.
// tTop caps how fast: a full backswing in ~0.6 s at the default profile tempo (1.1); the takeaway starts gentler.
const tTop = () => 0.6 * (profile.swing.tempo / 1.1) * style().tempo;
const BACK_LAG = 0.075;                                   // s: how closely the golfer trails the finger
const arriveGap = () => Math.max(0.05, 0.05 * fullBack()); // within this of the finger = at the top
function backStep(phi: number, target: number, dt: number, tSince: number) {
  const gap = target - phi;
  if (gap <= 0) return phi;
  const vMax = fullBack() / tTop() * (0.45 + 0.55 * smooth(0, 0.2, tSince));
  return Math.min(target, phi + Math.min(vMax, gap / BACK_LAG) * dt);
}
// ?debug=1: print the last swing's timing so the tempo can be tuned by feel
const dbg = new URLSearchParams(location.search).has('debug') ? document.body.appendChild(Object.assign(document.createElement('div'), {
  style: 'position:fixed;left:6px;bottom:6px;z-index:99;font:11px/1.3 ui-monospace,monospace;color:#fff;background:rgba(0,0,0,.55);padding:4px 6px;border-radius:4px;pointer-events:none;white-space:pre',
})) : null;
let dbgRaw = 0;

hud.pad.addEventListener('pointerdown', e => {
  sound.unlock();
  if (state === 'intro') { startPlay(); return; }
  if (state === 'result') { nextBall(); return; }
  if (state !== 'ready' || SW.active || fading) return;
  hud.closePops();
  hud.pad.setPointerCapture(e.pointerId);
  Object.assign(SW, { active: true, phase: 'back', press: hud.padLocal(e), trailB: [[0, 0]], trailD: [], depth: 0, deep: [0, 0], driftSum: 0, driftN: 0, last: [0, 0], t0: performance.now(), tDeep: performance.now(), tAt: performance.now() });
  Object.assign(G, { phase: 'back', phi: 0, target: 0, arrived: null, returning: false });
  faceBadge.clearWord();
  state = 'swinging';
  e.preventDefault();
});
hud.pad.addEventListener('pointermove', e => {
  if (!SW.active) return;
  const q = hud.padLocal(e), p: [number, number] = [q[0] - SW.press[0], q[1] - SW.press[1]], now = performance.now();
  SW.last = p;
  if (SW.phase === 'back') {
    SW.trailB.push(p);
    if (p[1] > 0) { SW.driftSum += Math.abs(p[0]); SW.driftN++; }
    // tDeep: when the finger stopped going deeper; tAt: the last moment it sat at the bottom (the true start of the push)
    if (p[1] > SW.depth) { if (p[1] > SW.depth + 0.15) SW.tDeep = now; SW.depth = p[1]; SW.deep = p; }
    if (p[1] >= SW.depth - 0.8) SW.tAt = now;
    G.target = fullBack() * clamp(SW.depth / 80, 0, 1);
    if (SW.depth > 12 && p[1] < SW.depth - 10) {
      SW.phase = 'down'; SW.tTrans = now;
      // Rhythm: the pause between the top (golfer AND finger there) and the finger starting back up.
      // Pushed before the golfer got there: minus the time it still needed (same motion law as the animation).
      // Smooth window: raw -150..+220 ms (mapped onto planShot's -70..+160); a 0.5-0.8 s pull with a
      // 50-150 ms pause grades Smooth (checked with a frame-by-frame replica of this code).
      let raw: number;
      if (G.arrived === null) {
        let phi = G.phi, t = 0;
        while (G.target - phi > arriveGap() && t < 2) { phi = backStep(phi, G.target, 1 / 240, (now - SW.t0) / 1000 + t); t += 1 / 240; }
        raw = -(t * 1000 + (now - SW.tAt));
      } else raw = SW.tAt - Math.max(G.arrived, SW.tDeep);
      dbgRaw = raw;
      SW.off = raw >= 0 ? raw * (160 / 220) : raw * (70 / 150);
      G.topPhi = Math.max(0.05, G.phi); G.phase = 'down';
      SW.trailD.push(p);
      sound.swoosh(clamp(SW.depth / 80, 0.2, 1));
    }
  } else if (SW.phase === 'down') {
    SW.trailD.push(p);
    G.phi = G.topPhi * clamp((p[1] + 45) / (SW.deep[1] + 45), 0, 1);
    if (p[1] < -45) strike(now, p, false);
  }
});
const endPointer = (e: PointerEvent) => {
  if (!SW.active) return;
  const q = hud.padLocal(e), p: [number, number] = [q[0] - SW.press[0], q[1] - SW.press[1]];
  if (SW.phase === 'down') strike(performance.now(), p, true);
  else {
    SW.active = false; SW.phase = 'idle';
    G.returning = true; G.returnT0 = performance.now(); G.topPhi = G.phi;
    if (SW.depth > 12) hud.toast('Push up', 'Push up through the ball to swing', 'warn');
    state = 'ready';
    SW.trailB = []; SW.trailD = [];
  }
};
hud.pad.addEventListener('pointerup', endPointer);
hud.pad.addEventListener('pointercancel', endPointer);

function strike(now: number, p: [number, number], released: boolean) {
  SW.active = false; SW.phase = 'idle';
  const power = clamp(SW.depth / 80, 0.05, 1);
  const angle = Math.atan2(p[0] - SW.deep[0], SW.deep[1] - p[1]) * 180 / Math.PI;
  const drift = SW.driftN ? SW.driftSum / SW.driftN / 80 : 0;
  // the pad's left/right is the screen's left/right; for a lefty the ball still curves the way you push
  const strikePt = (hud as unknown as { strike?: { x: number; y: number } }).strike ?? { x: 0, y: 0 };
  plan = planShot({ power, offMs: SW.off, pushMs: now - SW.tTrans, angle, drift, released, strike: strikePt, aim: { curve: aim.curve, loft: aim.loft }, rollLie: true }, hud.club, hud.mode, LIES[hud.lie], golfer.lefty);
  plan.launch.azimuth += aim.dir; // aimed off the straight line (aim view)
  ball.hit(plan.launch);
  { const b = golfer.ballWorld(new THREE.Vector3()); b.y -= BALL.r; const spec = CLUB_SPECS[hud.club];
    divots.divot(b, new THREE.Vector3(Math.sin(aim.dir), 0, -Math.cos(aim.dir)), spec.id, LIES[hud.lie]?.name ?? 'Fairway', hud.mode, power, tee.visible || spec.kind === 'driver' || spec.kind === 'wood'); }
  tracer.clear(); tracer.push(ball.pos);
  shotPath.length = 0; shotPath.push(ball.pos.clone()); shotLand = -1;
  card = { plan, power, offMs: SW.off, done: false };
  if (dbg) dbg.textContent = `pull ${Math.round(SW.tDeep - SW.t0)} ms · pause ${Math.round(SW.tAt - SW.tDeep)} ms · push ${Math.round(now - SW.tTrans)} ms\nvs top ${dbgRaw > 0 ? '+' : ''}${Math.round(dbgRaw)} ms → graded ${Math.round(SW.off)} ms (${plan.tempoWord})`;
  hud.card(card);
  faceBadge.setWord(plan.tempoWord, plan.tempoCls, plan.shapeWord);   // the swing word sits under the face (the why lives in Shot details)
  sound.strike(CLUB_SPECS[hud.club].kind, 1 - plan.error);
  try { navigator.vibrate?.(18); } catch { /* not allowed */ }
  hitStop = 0.09;
  shake = 0.5;
  Object.assign(G, { phase: 'follow', phi: 0, followT0: now, followTo: PHI_FINISH * (0.55 + 0.45 * power) });
  state = 'flight';
  hud.showSpin(true, { rpm: plan.launch.spinRpm, tilt: plan.launch.tilt });
  camMode = 'chase'; chaseT0 = now;
  // long shots get the cinematic: face and follow-through, fly after the ball, settle on the landing
  { const land = ball.predictLanding(14), carry = land ? Math.hypot(land.x - ball.start.x, land.z - ball.start.z) / YD : 0;
    if (isLongShot(hud.mode, carry)) startShotCam(); }
  setTimeout(() => shadowsOnGolfer(false), 900);
  setTimeout(() => { SW.trailB = []; SW.trailD = []; }, 700);
}

const fader = document.createElement('div');
fader.style.cssText = 'position:fixed;inset:0;background:#0b1410;opacity:0;pointer-events:none;transition:opacity .22s';
document.body.appendChild(fader);
let fading = false;
function nextBall() {
  if (fading) return;
  fading = true; fader.style.opacity = '1';
  setTimeout(() => { resetBall(); fader.style.opacity = '0'; fading = false; }, 240);
}
function resetBall() {
  divots.clear();
  shadowsOnGolfer(true);
  windShot();
  state = 'ready';
  Object.assign(G, { phase: 'address', phi: 0, target: 0, arrived: null, returning: false, idleT: 0 });
  teeUp();
  camMode = 'address';
  snapCamera();
}

// ── cameras ──
type CamMode = 'intro' | 'introFly' | 'address' | 'chase' | 'landing' | 'rest' | 'cine';
let camMode: CamMode = 'intro';
let chaseT0 = 0, shake = 0;
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
const want = new THREE.Vector3(), wantLook = new THREE.Vector3();
let landingCam: THREE.Vector3 | null = null;
const side = golfer.lefty ? 1 : -1;
const portrait = () => { const v = viewport(); return v.h > v.w * 1.05; };
/** portrait lens shift: lift the golfer above the swing stick; the stick takes a bigger share of short screens */
const addressShift = () => { const { w, h } = viewport(); const sc = clamp(Math.min(w / 430, h / 800), 0.62, 1.15); const f = (14 + 272 * sc) / h; return clamp(0.06 + 0.45 * f, 0.12, 0.27); };
function addressCam(out: THREE.Vector3, look: THREE.Vector3) {
  if (portrait()) {
    // phone held upright: from behind, down the line, with the golfer near the centre of the frame (camera between
    // the ball and his hips, looking straight down the target line) and pulled back so the club at the top and the
    // finish fit. side: +1 for a left-hander (he stands on +x of the ball), -1 for a right-hander
    out.set(0.95 * side, 2.4, 4.4);   // off to his side and up, so the flight preview reads as an arc curving away
    look.set(0.22 * side, 0.55, -6);
  } else {
    out.set(-0.85 * side, 1.62, 5.6);
    look.set(0.45 * side, 0.92, -22);
  }
  // turn the swing cam with the aim line (round the ball)
  if (aim.dir !== 0) { const b = golfer.ballWorld(new THREE.Vector3()), Y = new THREE.Vector3(0, 1, 0); out.sub(b).applyAxisAngle(Y, -aim.dir).add(b); look.sub(b).applyAxisAngle(Y, -aim.dir).add(b); }
}
let lensShift = 0;
function fitCamera() {
  const { w: vw, h: vh } = viewport();
  camera.aspect = vw / vh;
  camera.fov = portrait() ? (vh / vw < 1.62 ? 56 : 52) : 42;
  // portrait: shift the lens so the golfer sits above the swing stick without tilting the camera
  if (portrait() && lensShift > 0.001) camera.setViewOffset(vw, vh, 0, vh * lensShift, vw, vh);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
fitCamera();
function snapCamera() { addressCam(camPos, camLook); landingCam = null; }
// ── cinematic shot cam (src/game/shotcam.ts) ──
const shotcam = new ShotCam();
let cineLens = false;
const shotCtx: ShotCamCtx = {
  ball, head: new THREE.Vector3(),
  predictLanding: () => ball.predictLanding(8),
  groundAt: (x, z) => range?.heightAt(x, z) ?? 0,
  blocked: (x, z) => range?.targets.some(t => Math.hypot(t.pos.x - x, t.pos.z - z) < t.radius + 14) ?? false,
};
function startShotCam() {
  const Y = new THREE.Vector3(0, 1, 0);
  const faceDir = new THREE.Vector3(-side, 0, 0).applyAxisAngle(Y, -aim.dir);   // towards the ball at address
  const targetDir = new THREE.Vector3(ball.vel.x, 0, ball.vel.z);
  const variant = pickVariant(QS.get('shotcam'));
  shotcam.start(camPos, camLook, faceDir, targetDir, side, variant);
  if (variant === 'freeze') turf.burst(golfer.ballWorld(new THREE.Vector3()), targetDir);
  camMode = 'cine';
}
/** tap during the flight: run the ball on to just before it lands and show the landing */
// a little burst of turf and grass at impact (seen hanging in the air during bullet time)
const turf = (() => {
  const N = 46, pos = new Float32Array(N * 3), vel = new Float32Array(N * 3), col = new Float32Array(N * 3);
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.028, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false }));
  pts.visible = false; pts.frustumCulled = false; scene.add(pts);
  let life = 0;
  return {
    burst(at: THREE.Vector3, dir: THREE.Vector3) {
      const d = dir.clone().setY(0).normalize();
      for (let i = 0; i < N; i++) {
        pos.set([at.x + (Math.random() - 0.5) * 0.06, at.y + 0.01, at.z + (Math.random() - 0.5) * 0.06], i * 3);
        const sp = 1.2 + Math.random() * 2.6, up = 0.8 + Math.random() * 2.2, sd = (Math.random() - 0.5) * 1.2;
        vel.set([d.x * sp - d.z * sd, up, d.z * sp + d.x * sd], i * 3);
        const g = Math.random() < 0.7; col.set(g ? [0.25 + Math.random() * 0.15, 0.5 + Math.random() * 0.2, 0.16] : [0.36, 0.26, 0.15], i * 3);
      }
      (geo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true; life = 1.4; pts.visible = true;
    },
    update(dt: number) {
      if (life <= 0) return; life -= dt; if (life <= 0) { pts.visible = false; return; }
      for (let i = 0; i < N; i++) { vel[i * 3 + 1] -= 9.8 * dt; for (let k = 0; k < 3; k++) pos[i * 3 + k] += vel[i * 3 + k] * dt; if (pos[i * 3 + 1] < 0) { pos[i * 3 + 1] = 0; vel.fill(0, i * 3, i * 3 + 3); } }
      (geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (pts.material as THREE.PointsMaterial).opacity = Math.min(1, life * 2);
    },
  };
})();

// the aim preview: a pure strike's flight in still air for the current club, mode, aim, curve and strike point
const preview = new AimPreview(scene, 240, (x, z) => range?.heightAt(x, z) ?? 0);
function updatePreview() {
  const strikePt = (hud as unknown as { strike?: { x: number; y: number } }).strike ?? { x: 0, y: 0 };
  const key = [hud.club, hud.mode, hud.lie, aim.dir.toFixed(3), aim.distanceYds.toFixed(1), aim.curve.toFixed(2), strikePt.x.toFixed(2), strikePt.y.toFixed(2)].join('|');
  if (key === previewKey) return; previewKey = key;
  const M = SHOT_MODES[hud.mode], max = M.max(CLUB_SPECS[hud.club].id) * LIES[hud.lie].pct / 100, pw = aim.distanceYds / Math.max(1, max);
  const power = clamp(hud.mode === 'full' ? (pw - FULL_MIN) / (1 - FULL_MIN) : pw, 0.05, 1);
  const P = planShot({ power, offMs: 0, pushMs: 200, angle: 0, drift: 0, released: false, strike: strikePt, aim: { curve: aim.curve, loft: aim.loft } }, hud.club, hud.mode, LIES[hud.lie], golfer.lefty);
  P.launch.azimuth += aim.dir;
  const w = WIND.clone(); WIND.set(0, 0, 0);
  const b = new Ball(range); b.tee(golfer.ballWorld()); b.hit(P.launch);
  const pts = [b.pos.clone()];
  for (let i = 0; i < 120 * 14 && b.phase === 'flight'; i++) { b.step(1 / 120); if (i % 3 === 0) pts.push(b.pos.clone()); }
  pts.push(b.pos.clone());
  WIND.copy(w);
  preview.set(key, pts, b.carry() / YD);
}
let previewKey = '';

// the flown path, for the Shot details sketch
const shotPath: THREE.Vector3[] = [new THREE.Vector3()];
let shotLand = -1;

// ── wind: per session, 0–15 mph from a random direction; it shifts a little every few shots and gusts ±20%.
// deg = where it blows TOWARD, clockwise from straight down the range (0 = helping, 180 = into you, 90 = left→right).
// ?wind=mph,deg fixes it for testing. Real flights feel WIND (ball.ts); the planning sims don't, so players allow for it.
const MPH = 0.44704;
const windQ = QS.get('wind')?.split(',').map(Number);
const wind = windQ ? { mph: windQ[0] || 0, deg: windQ[1] || 0, fixed: true } : { mph: Math.round(Math.random() * 15), deg: Math.random() * 360, fixed: false };
let windShots = 0, windGust = 1;
function windShot() {
  if (wind.fixed || ++windShots % 4) return;
  wind.deg += (Math.random() - 0.5) * 70; wind.mph = clamp(wind.mph + (Math.random() - 0.5) * 6, 0, 15);
}
function updateWind(now: number) {
  const t = now / 1000;
  windGust = 1 + 0.2 * (0.6 * Math.sin(t * 0.7) + 0.4 * Math.sin(t * 1.9 + 1.3));
  const d = THREE.MathUtils.degToRad(wind.deg + 6 * Math.sin(t * 0.23)), v = wind.mph * MPH * windGust;
  WIND.set(Math.sin(d) * v, 0, -Math.cos(d) * v);
  hud.setWind(wind.mph * windGust, wind.deg - THREE.MathUtils.radToDeg(aim.dir), windGust);
  aimCtl.setWind(WIND);
}

// swing view ⇄ aim view camera flight
const CAM_FLY_S = 0.75;
const camFly = { aim: false, t0: -1e9, pos: new THREE.Vector3(), look: new THREE.Vector3(), shift: 0, done: true };
let camFlying = false;
/** wall-clock seconds since the last camera update (not the 50 ms-clamped frame dt): the swing/aim camera settles in
 *  real time even when the frame rate drops to a few fps, instead of creeping a fixed fraction per frame */
let camLastNow = -1, camFollow = false, lensFly = false;
/** tap during the flight: fast-forward (sim and cameras together) to just before the ball lands — a quick flight, not a jump */
const skip = { on: false };
function skipToLanding() { if (state === 'flight' && ball.phase === 'flight') skip.on = true; }
/** instant version (debug / tests) */
function skipToLandingNow() {
  if (ball.phase !== 'flight') return;
  for (let i = 0; i < 120 * 20 && ball.phase === 'flight'; i++) {
    const g = range?.heightAt(ball.pos.x, ball.pos.z) ?? 0;
    if (ball.vel.y < 0 && (ball.pos.y - g) / Math.max(1, -ball.vel.y) < 0.55) break;
    ball.setAftertouch(hud.spin.y, hud.spin.x); ball.step(1 / 120); tracer.push(ball.pos);
  }
  if (camMode === 'cine') shotcam.skipToLanding(shotCtx);
}

function updateCamera(dt: number, now: number) {
  const rdt = camLastNow < 0 ? dt : clamp((now - camLastNow) / 1000, 0, 1); camLastNow = now;
  const k = 1 - Math.pow(0.0025, dt);
  if (camMode === 'cine') {
    golfer.body.bones[5].getWorldPosition(shotCtx.head);
    const P = shotcam.update(dt, shotCtx);
    camPos.copy(P.pos); camLook.copy(P.look);
    if (lensShift > 0.001) lensShift = Math.max(0, lensShift - dt * 0.6);
    fitCamera(); camera.fov += P.dFov; camera.updateProjectionMatrix(); cineLens = true;
    camera.position.copy(camPos); camera.lookAt(camLook); camera.rotateZ(P.roll);
    post.setDof(P.dof);
    hud.setCine(shotcam.facing ? 'face' : 'ball');
    return;
  }
  if (cineLens) { cineLens = false; shotcam.stop(); fitCamera(); hud.setCine(null); }
  if (camMode === 'intro' || camMode === 'introFly') {
    introCam(want, wantLook, now);
    if (camMode === 'introFly') {
      // tap: orbit from the front, round his trail side, up and over to the swing cam (ease in-out, a slight rise)
      const k = Math.min(1, (now - introFly.t0) / 1000 / INTRO_FLY_S), e = k * k * k * (k * (k * 6 - 15) + 10);
      const piv = golfer.ballWorld(new THREE.Vector3()).add(new THREE.Vector3(0.45 * side, 0, 0));
      const end = new THREE.Vector3(), endLook = new THREE.Vector3(); addressCam(end, endLook);
      const a0 = Math.atan2(introFly.pos.z - piv.z, introFly.pos.x - piv.x), a1 = Math.atan2(end.z - piv.z, end.x - piv.x);
      let da = a1 - a0; da = Math.atan2(Math.sin(da), Math.cos(da));
      const r0 = Math.hypot(introFly.pos.x - piv.x, introFly.pos.z - piv.z), r1 = Math.hypot(end.x - piv.x, end.z - piv.z);
      const a = a0 + da * e, r = r0 + (r1 - r0) * e;
      want.set(piv.x + Math.cos(a) * r, introFly.pos.y + (end.y - introFly.pos.y) * e + Math.sin(Math.PI * e) * 0.7, piv.z + Math.sin(a) * r);
      want.y = Math.max(want.y, (range?.heightAt(want.x, want.z) ?? 0) + 1.1);
      // keep him in frame through the orbit; the eye only swings down the range at the very end
      const chest = new THREE.Vector3(piv.x, 1.05, piv.z);
      wantLook.lerpVectors(introFly.look, chest, Math.min(1, e * 3)).lerp(endLook, smooth(0.6, 1, e));
      camFlying = true;
      if (k >= 1) { camMode = 'address'; state = 'ready'; hud.el.classList.remove('hidden'); camFly.t0 = -1e9; }
    }
  } else if (camMode === 'address') {
    if (aimCtl.active) aimCtl.cameraWant(want, wantLook); else addressCam(want, wantLook);
    // swing view ⇄ aim view: a timed camera flight through the world (ease in-out), not an exponential snap
    // Time-based end to end: the flight's progress is wall-clock, the last frame of it lands exactly on the target
    // (however few frames there were), and after it the camera follows its target with a real-time ease.
    if (aimCtl.active !== camFly.aim) { camFly.aim = aimCtl.active; camFly.t0 = now; camFly.pos.copy(camPos); camFly.look.copy(camLook); camFly.shift = lensShift; camFly.done = false; }
    const fk = (now - camFly.t0) / 1000 / CAM_FLY_S;
    if (fk < 1) { const e = fk * fk * (3 - 2 * fk); want.lerpVectors(camFly.pos, want, e); wantLook.lerpVectors(camFly.look, wantLook, e); camFlying = lensFly = true; }
    else if (!camFly.done) { camFly.done = true; camFlying = lensFly = true; }   // the flight's last frame: snap onto the target
    else camFollow = true;
  } else if (camMode === 'chase' || camMode === 'landing' || camMode === 'rest') {
    const b = ball.pos;
    const vh = new THREE.Vector3(ball.vel.x, 0, ball.vel.z);
    const since = (now - chaseT0) / 1000;
    if (camMode === 'chase') {
      // stay at the tee for a moment to watch the strike, then chase
      if (since < 0.55) { addressCam(want, wantLook); wantLook.lerp(b, smooth(0.1, 0.55, since)); }
      else {
        const dir = vh.lengthSq() > 1 ? vh.normalize() : new THREE.Vector3(0, 0, -1);
        want.copy(b).addScaledVector(dir, -16).add(new THREE.Vector3(0, 3.5 + b.y * 0.25, 0));
        want.y = Math.max(want.y, (range?.heightAt(want.x, want.z) ?? 0) + 2);
        wantLook.copy(b).addScaledVector(dir, 6);
        // after the apex, if the landing is close, cut to a TV camera near where it comes down
        const land = ball.vel.y < 0 ? ball.predictLanding(6) : null;
        if (land && b.distanceTo(land) < 70 && since > 1.2) {
          const travel = dir.clone();
          const lateral = new THREE.Vector3(-travel.z, 0, travel.x).multiplyScalar(-side);
          // a spot past the landing area, off to the side, that isn't parked behind a flag or a yardage board
          const tries: [number, number][] = [[30, 11], [30, -11], [24, 18], [24, -18], [38, 6], [18, 24]];
          landingCam = land.clone().addScaledVector(travel, 30).addScaledVector(lateral, 11);
          for (const [fw, lat] of tries) {
            const c = land.clone().addScaledVector(travel, fw).addScaledVector(lateral, lat);
            const blocked = range?.targets.some(t => Math.hypot(t.pos.x - c.x, t.pos.z - c.z) < t.radius + 14) ?? false;
            if (!blocked) { landingCam = c; break; }
          }
          landingCam.y = Math.max(land.y, range?.heightAt(landingCam.x, landingCam.z) ?? 0) + 6.5;
          camMode = 'landing';
          camPos.copy(landingCam); // cut
        }
      }
    }
    if (camMode === 'landing' || camMode === 'rest') {
      want.copy(landingCam ?? camPos);
      wantLook.copy(b).add(new THREE.Vector3(0, 0.3, 0));
    }
  }
  const wantShift = portrait() && !aimCtl.active && (camMode === 'address' || camMode === 'intro' || camMode === 'introFly' || (camMode === 'chase' && (now - chaseT0) < 550)) ? (camMode === 'intro' ? 0.0 : camMode === 'introFly' ? addressShift() * Math.min(1, (now - introFly.t0) / 1000 / INTRO_FLY_S) : addressShift()) : 0;
  if (lensFly) {
    // the lens shift rides the swing ⇄ aim flight (same clock, same ease), so the golfer lands framed
    const fk = clamp((now - camFly.t0) / 1000 / CAM_FLY_S, 0, 1), e = fk * fk * (3 - 2 * fk);
    lensShift = camFly.shift + (wantShift - camFly.shift) * e; fitCamera();
  } else if (Math.abs(wantShift - lensShift) > 0.002) { lensShift += (wantShift - lensShift) * (1 - Math.pow(0.02, camMode === 'address' ? rdt : dt)); fitCamera(); }
  const kk = camFlying ? 1 : camMode === 'landing' || camMode === 'rest' ? 1 - Math.pow(0.02, dt) : camFollow ? 1 - Math.pow(0.0025, rdt) : k;
  camFlying = false; camFollow = false; lensFly = false;
  camPos.lerp(want, camMode === 'chase' ? 1 - Math.pow(0.04, dt) : kk);
  camLook.lerp(wantLook, camMode === 'landing' ? 1 - Math.pow(0.0005, dt) : kk);
  camera.position.copy(camPos);
  if (shake > 0) { camera.position.x += (Math.random() - 0.5) * 0.01 * shake; camera.position.y += (Math.random() - 0.5) * 0.01 * shake; shake = Math.max(0, shake - dt * 3); }
  camera.lookAt(camLook);
  // broadcast long-lens look on the golfer cams only: the far treeline and hills soften a touch (eased in post)
  post.setDof((camMode === 'address' || camMode === 'intro') && !aimCtl.active ? 1 : 0);
}

// ── intro overlay ──
const intro = document.createElement('div');
intro.className = 'intro';
// three layouts for the owner to pick from (?intro=a|b|c):
//  a: cinematic close-up of Neil, a clean bottom lockup (crest wordmark, a huge condensed NEIL, a yellow rule)
//  b: a golden-hour wide shot, the name huge and editorial at the top-left (the HUD's big-number voice)
//  c: the live 3D face in a big medallion, name and title stacked under it, the course behind
const INTRO = ((q: string | null) => (q === 'b' || q === 'c' ? q : 'a'))(QS.get('intro'));
intro.dataset.layout = INTRO;
intro.innerHTML = INTRO === 'b'
  ? `<div class="il-top"><span class="il-eyebrow"><i class="crest" aria-hidden="true"></i>The Hunt</span><h1>${profile.name}</h1><i class="il-rule" aria-hidden="true"></i></div><span class="tap">Tap anywhere to start</span>`
  : INTRO === 'c'
  ? `<div class="il-stack"><div class="il-medal" aria-hidden="true"></div><h1>${profile.name}</h1><span class="il-eyebrow"><i class="crest" aria-hidden="true"></i>The Hunt</span></div><span class="tap">Tap anywhere to start</span>`
  : `<div class="il-lock"><span class="il-eyebrow"><i class="crest" aria-hidden="true"></i>The Hunt</span><h1>${profile.name}</h1><i class="il-rule" aria-hidden="true"></i><span class="tap">Tap anywhere to start</span></div>`;
intro.setAttribute('role', 'button'); intro.tabIndex = 0; intro.setAttribute('aria-label', `Start playing as ${profile.name}`);
document.body.appendChild(intro);
// a tap anywhere starts (no button)
intro.addEventListener('click', () => { sound.unlock(); startPlay(); });
intro.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sound.unlock(); startPlay(); } });
// intro: a front ¾ view of Neil framed between the title and his name; a tap flies the camera round to the swing cam
const INTRO_FLY_S = 1.9;
const introFly = { t0: 0, pos: new THREE.Vector3(), look: new THREE.Vector3() };
function introCam(pos: THREE.Vector3, look: THREE.Vector3, now: number) {
  const head = new THREE.Vector3(); golfer.body.bones[5].getWorldPosition(head);
  const piv = golfer.ballWorld(new THREE.Vector3()).add(new THREE.Vector3(0.5 * side, 0, 0));
  if (INTRO === 'a' || INTRO === 'b') {
    // a: a slow push on a head-and-shoulders close-up (a touch low, ¾ to his lead side); b: a wide, high golden-hour shot
    const T = now / 1000, th = (golfer.lefty ? Math.PI : 0) + (INTRO === 'a' ? 0.42 : 0.75) * side + 0.04 * Math.sin(T * 0.25);
    const R = INTRO === 'a' ? 1.75 - 0.06 * Math.sin(T * 0.2) : 8.5;
    pos.set(head.x + Math.cos(th) * R, 0, head.z + Math.sin(th) * R);
    pos.y = INTRO === 'a' ? head.y - 0.06 : 2.6;
    pos.y = Math.max(pos.y, (range?.heightAt(pos.x, pos.z) ?? 0) + 1.0);
    if (INTRO === 'a') look.set(head.x, head.y - 0.2, head.z);   // face in the upper half, the lockup under the chin
    else look.copy(piv).add(new THREE.Vector3(-1.6 * side, 1.9, -0.6));   // him small, low right; the sky and the course take the frame
    return;
  }
  const th = (golfer.lefty ? Math.PI : 0) + 0.32 * side + 0.06 * Math.sin(now / 1000 * 0.25);   // in front of him, a little round
  pos.set(piv.x + Math.cos(th) * 3.8, 0, piv.z + Math.sin(th) * 3.8);
  pos.y = Math.max(1.38 + Math.sin(now / 1000 * 0.18) * 0.04, (range?.heightAt(pos.x, pos.z) ?? 0) + 1.2);
  look.set(piv.x * 0.9 + head.x * 0.1, 0.62, piv.z);   // pulled back a little, aimed low: head under the title, feet above the name card
}
function startPlay() {
  if (state !== 'intro' || camMode !== 'intro') return;
  if (INTRO === 'c') document.getElementById('who')!.appendChild(faceBadge.el);   // the live face goes home to the HUD
  intro.classList.add('gone');
  setTimeout(() => intro.remove(), 900);
  introFly.t0 = last; introFly.pos.copy(camPos); introFly.look.copy(camLook);
  camMode = 'introFly';   // state turns 'ready' and the HUD fades in as the camera arrives
}

// ── loop ──
teeUp();
golfer.update({ phase: 'address', phi: 0, topPhi: PHI_TOP, idleT: 0 });
shadowsOnGolfer(true);
camMode = 'intro';
introCam(camPos, camLook, performance.now());
let last = performance.now();
let manualClock = false;
const frameTimes: number[] = [];
const focus = new THREE.Vector3();
const tmp = new THREE.Vector3();

function frame(now: number) {
  let dt = Math.min(0.05, (now - last) / 1000); last = now;
  frameTimes.push(dt); if (frameTimes.length > 90) frameTimes.shift();
  if (hitStop > 0) { hitStop -= dt; dt *= 0.18; }
  // fast forward: hold the 3D view while the ball is flying/rolling → the ball and cameras run at up to 3×
  if (skip.on) { const g = range?.heightAt(ball.pos.x, ball.pos.z) ?? 0; if (state !== 'flight' || ball.phase !== 'flight' || (ball.vel.y < 0 && (ball.pos.y - g) / Math.max(1, -ball.vel.y) < 0.7)) skip.on = false; }
  ff.scale += ((skip.on ? 6 : ff.held && state === 'flight' ? 3 : 1) - ff.scale) * Math.min(1, dt / (skip.on ? 0.25 : 0.15));
  ff.pill.hidden = !(ff.held && state === 'flight');
  // bullet time (shot cam 'freeze'): the ball, the turf and the golfer's follow-through hold still
  const ts = camMode === 'cine' ? shotcam.timeScale : 1;
  if (ts < 1 && G.phase === 'follow') G.followT0 += dt * 1000 * (1 - ts);
  const simDt = dt * ff.scale * ts;   // the ball sub-steps internally (≤ 4 ms), so 3× stays stable
  turf.update(simDt);

  // golfer
  G.idleT += dt;
  if (G.phase === 'back') {
    // the golfer follows the finger (see backStep); 'arrived' once caught up with a full enough pull
    G.phi = backStep(G.phi, G.target, dt, (now - SW.t0) / 1000);
    if (G.target - G.phi > arriveGap()) G.arrived = null; else if (G.arrived === null && SW.depth > 12) G.arrived = now;
  } else if (G.phase === 'follow') {
    const k = clamp((now - G.followT0) / 820, 0, 1), e = 1 - Math.pow(1 - k, 3);
    G.phi = G.followTo * e;
  }
  if (G.returning) {
    const k = clamp((now - G.returnT0) / 450, 0, 1);
    G.phi = G.topPhi * (1 - smooth(0, 1, k));
    if (k >= 1) { G.returning = false; G.phase = 'address'; G.phi = 0; }
  }
  golfer.update({ phase: G.phase, phi: G.phi, topPhi: G.phase === 'back' ? Math.max(G.phi, 0.01) : G.topPhi, idleT: G.idleT, lookAt: state === 'intro' ? camera.position : undefined });

  // face: smile on the intro, and after a good shot
  const good = state === 'result' && !!plan && plan.tempoWord === 'Perfect' && Math.abs(ball.offline() / YD) < 10;
  faceBadge.update(dt);
  golfer.smileToward(Math.max(state === 'intro' || good ? 1 : 0, faceBadge.smile), dt);

  hud.setState(state === 'ready', state === 'flight', !card);
  hud.el.classList.toggle('in-shot', state === 'flight' || state === 'result');   // the top controls step away for the shot
  // the editorial distance: target at address (live with the aim ring), a ticking carry in the air
  if (state === 'ready' || state === 'swinging' || state === 'intro') {
    hud.edAddress(aim.distanceYds);
    // the stick's power target: the pull that carries the aim distance (full swings map the pull onto 60–100% of carry)
    const M = SHOT_MODES[hud.mode], max = M.max(CLUB_SPECS[hud.club].id) * LIES[hud.lie].pct / 100, pw = aim.distanceYds / Math.max(1, max);
    const f = hud.mode === 'full' ? (pw - FULL_MIN) / (1 - FULL_MIN) : pw;
    hud.setPowerTarget(aim.distanceYds >= max - 1 ? null : clamp(f, 0, 1), aim.distanceYds, '', max);   // the aim is clamped to the reachable band, so f is always valid
  } else {
    hud.setPowerTarget(null, 0, '', 0);
    if (state === 'flight') hud.edLive(Math.hypot(ball.pos.x - ball.start.x, ball.pos.z - ball.start.z) / YD);
  }
  aimCtl.setEnabled(state === 'ready');
  aimCtl.update(dt, false);   // the swing view uses the flight preview instead of the ground arrow

  // swing pad
  if (SW.active || SW.trailB.length) hud.setPad(SW.active ? SW.last : [0, 0], SW.trailB, SW.trailD, SW.active && SW.phase === 'back' && G.arrived !== null && SW.depth > 12);

  // ball
  if (state === 'flight') {
    // spin set on the spin ball ramps in over the rest of the flight
    if (ball.phase === 'flight') ball.setAftertouch(hud.spin.y, hud.spin.x);
    const wasFlight = ball.phase === 'flight';
    ball.step(simDt);
    tracer.push(ball.pos);
    if (shotPath[shotPath.length - 1].distanceToSquared(ball.pos) > 0.6) shotPath.push(ball.pos.clone());
    if (shotLand < 0 && ball.phase !== 'flight') shotLand = shotPath.length - 1;
    if (wasFlight && ball.phase !== 'flight') {
      sound.land(ball.lastSurface === 'green' ? 0.6 : ball.lastSurface === 'rough' ? 0.9 : 0.2);
      hud.spinDone();
      if (card) { card.carry = ball.carry() / YD; card.apex = ball.apex / YD; hud.card(card); }
    }
    if (ball.phase === 'stopped') {
      state = 'result'; resultT = now; if (camMode !== 'cine') camMode = 'rest';
      if (card) {
        // the flight as flown for the Shot details sketch: yards along / across the aim line, curve vs the start line
        shotPath.push(ball.pos.clone());
        const st = ball.start, ad = aim.dir, fx = Math.sin(ad), fz = -Math.cos(ad);
        const path = shotPath.map(p => ({ f: ((p.x - st.x) * fx + (p.z - st.z) * fz) / YD, s: ((p.x - st.x) * -fz + (p.z - st.z) * fx) / YD, h: (p.y - st.y) / YD }));
        const li = shotLand < 0 ? path.length - 1 : shotLand, early = path[Math.min(3, li)], ld = path[li];
        const k = early.f > 0.5 ? early.s / early.f : 0;   // the start line from the first few yards
        Object.assign(card, { done: true, carry: ball.carry() / YD, total: ball.total() / YD, offline: ball.offline() / YD,
          path, land: li, aimYds: aim.distanceYds, curveYds: ld.s - k * ld.f, addSpin: { ...hud.spin }, lefty: golfer.lefty });
        hud.card(card);
      }
      const tot = ball.total() / YD, off = ball.offline() / YD;
      const near = range?.targets.reduce((b, t) => { const d = Math.hypot(t.pos.x - ball.pos.x, t.pos.z - ball.pos.z); return d < b.d ? { d, t } : b; }, { d: Infinity, t: null as any });
      const msg = near && near.t && near.d < near.t.radius ? `On the ${near.t.yards} green · ${(near.d / YD).toFixed(0)} yds from the pin` : `${tot.toFixed(0)} yds · ${Math.abs(off) < 1 ? 'online' : `${Math.abs(off).toFixed(0)} ${off < 0 ? 'left' : 'right'}`}`;
      // Neil reacts (face, word under the badge, a one-liner); the numbers wait behind 'Shot details'
      const onGreen = !!(near && near.t && near.d < near.t.radius), pured = !!plan && plan.tempoWord === 'Perfect' && Math.abs(off) < 8;
      const expect = plan?.targetCarryYds ?? tot;
      const outcome: Outcome = onGreen && near!.d / YD < 1 ? 'holed' : onGreen && near!.d / YD < 5 ? 'near' : Math.abs(off) > 28 || tot < expect * 0.45 ? 'shank'
        : pured ? 'pure' : plan?.tempoCls === 'bad' ? 'bad' : onGreen || plan?.tempoCls === 'good' ? 'good' : 'ok';
      if (outcome === 'shank') faceBadge.setWord('Ouch', 'bad');   // otherwise the timing word (+ shape) from the strike stays
      faceBadge.react(outcome, `${tot.toFixed(0)} yds${onGreen ? ', on the green' : ''}.`);
      const pinFt = near && near.t ? near.d / YD * 3 : 999;
      const how = { pure: 'PERFECT', good: 'SOLID', ok: 'OKAY', bad: 'ROUGH ONE', shank: 'OUCH', near: 'STIFF', holed: 'HOLED' }[outcome];
      hud.edResult(tot, `YARDS · ${how}${onGreen ? ` · ${pinFt < 60 ? Math.round(pinFt) + ' FT FROM THE PIN' : 'ON THE GREEN'}` : Math.abs(off) >= 1 ? ` · ${Math.abs(off).toFixed(0)} ${off < 0 ? 'LEFT' : 'RIGHT'}` : ' · ONLINE'}`);
      if (outcome === 'pure' || outcome === 'near' || outcome === 'holed') hud.celebrate(outcome === 'pure' ? 18 : 34);
      void msg;
    }
  }
  if (state === 'result' && now - resultT > 4200) nextBall();
  ballMesh.position.copy(ball.pos);
  ballMesh.quaternion.copy(ball.spinQuat);
  // keep the ball visible far away: in play it never drops below ~6 px on screen, and in the air it carries a soft halo
  const d = camera.position.distanceTo(ball.pos);
  const worldPerPx = 2 * d * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / viewport().h;
  const inPlay = state === 'flight' || state === 'result';
  ballMesh.scale.setScalar(Math.max(1, d * 0.0035, inPlay ? 6 * worldPerPx / (BALL.r * 2) : 0));
  ballGlow.visible = state === 'flight' && ball.phase === 'flight';
  if (ballGlow.visible) { ballGlow.position.copy(ball.pos); ballGlow.scale.setScalar(26 * worldPerPx); }
  hud.tickSpin(dt, state === 'flight' && ball.phase === 'flight');

  updateCamera(simDt, now);
  { const g = golfer.ballWorld(tmp); fill.target.position.set(g.x + (golfer.lefty ? 0.8 : -0.8), 1.1, g.z); fill.position.copy(camera.position).add(new THREE.Vector3(-1.5, 2.2, 0.5)); fill.intensity += ((state === 'intro' ? 2.4 : 0.9) - fill.intensity) * Math.min(1, dt * 3); }
  tracer.update(camera, state === 'ready' ? 0.6 : 1);
  if (state === 'ready' && !SW.active) updatePreview();
  // one tracer for both views: it lies down onto the ground as the camera flies up to the aim view (and lifts back)
  const aimFk = clamp((now - camFly.t0) / 1000 / CAM_FLY_S, 0, 1), aimE = aimFk * aimFk * (3 - 2 * aimFk);
  preview.update(dt, camera, renderer.domElement, state === 'ready' && !SW.active && camMode === 'address', camFly.aim ? aimE : 1 - aimE);
  focus.copy(state === 'flight' || state === 'result' ? ball.pos : golfer.ballWorld(tmp));
  updateWind(now);
  range?.setWind(WIND); // the flags stream with the ball's wind (a light breeze when there is none)
  range?.update(dt, camera, focus);
  divots.update(dt);

  // dynamic resolution: keep frames under ~20 ms
  perf.frame(frameTimes[frameTimes.length - 1]);
  const r0 = performance.now();
  // the hand-drawn finish keeps his face clean: it needs the head's screen position each frame
  if (post.finish === 'hand' && golfer.body.bones[5]) post.setFace(golfer.body.bones[5].getWorldPosition(_faceHead), 0.15);
  post.render(dt);
  faceBadge.draw((state !== 'intro' || INTRO === 'c' || QS.has('badge')) && (!aimCtl.active || QS.has('badge')) && !document.hidden);   // ?badge: draw it everywhere (badge checks)
  (window as any).__frameMs = performance.now() - r0;
  if (!manualClock) requestAnimationFrame(frame);
}
// size to the visible viewport: phones resize it as the browser's bars show and hide
const onViewport = () => { const { w, h } = viewport(); renderer.setSize(w, h); post.setSize(w, h); fitCamera(); };
addEventListener('resize', onViewport);
window.visualViewport?.addEventListener('resize', onViewport);
addEventListener('orientationchange', () => setTimeout(onViewport, 250));
// a tap anywhere during the result skips ahead; holding the view during a shot fast-forwards it
renderer.domElement.addEventListener('pointerdown', e => {
  sound.unlock();
  if (state === 'result') { nextBall(); return; }
  if (state === 'flight') { ff.held = true; pressT = performance.now(); try { renderer.domElement.setPointerCapture(e.pointerId); } catch { /* not supported */ } }
});
// a quick tap (not a hold) during the flight skips to the landing
let pressT = 0;
renderer.domElement.addEventListener('pointerup', () => { if (state === 'flight' && pressT && performance.now() - pressT < 230) skipToLanding(); pressT = 0; });
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) renderer.domElement.addEventListener(ev, () => { ff.held = false; });
// the live face badge: the head (and the lights) also live on the badge camera's layer
const faceBadge = new FaceBadge(renderer, scene, () => golfer.body.bones[5] ?? null, () => (golfer.body as { face?: import('./ui/facebadge').FaceLike }).face, document.getElementById('who')!, profile.name, () => golfer.char);
golfer.root.traverse(o => o.layers.enable(AVATAR_LAYER));
// intro layout c shows the live 3D face (the badge) in its medallion until the tap
if (INTRO === 'c') intro.querySelector('.il-medal')?.appendChild(faceBadge.el);
requestAnimationFrame(t => { last = t; frame(t); });
(window as any).__game = { faceBadge, wind, camera, range,
  golfer, ball, hud, aim, aimCtl, shotcam, get state() { return state; }, skipToLanding, skipToLandingNow,
  /** debug (storyboards): stop the RAF loop and step the game by hand: manual(true); tick(ms) */
  manual(on: boolean) { manualClock = on; if (!on) requestAnimationFrame(t => { last = t; frame(t); }); },
  tick(ms: number) { frame(last + ms); },
  /** debug (framing checks): hold the golfer at the top of a full backswing, or in the finish, on the swing camera */
  pose(which: 'top' | 'finish' | 'address') {
    if (which === 'top') Object.assign(G, { phase: 'back', target: fullBack(), phi: 0 }), SW.t0 = last;
    else if (which === 'finish') Object.assign(G, { phase: 'follow', followT0: last, followTo: PHI_FINISH, phi: 0 });
    else Object.assign(G, { phase: 'address', phi: 0 });
  },
  /** debug: a full-power, on-tempo swing with the current club, as if pushed through the pad */
  demoShot() {
    if (state !== 'ready') return;
    Object.assign(SW, { active: true, phase: 'down', depth: 80, deep: [0, 80], off: 30, tTrans: last - 180, driftSum: 0, driftN: 0, trailB: [], trailD: [] });
    G.topPhi = fullBack(); G.phi = 0; state = 'swinging';
    strike(last, [0, -60], false);
  },
  /** debug: plan and fly a shot on the real range terrain, synchronously (distances in yards) */
  sim(club: number, mode: 'full' | 'punch' | 'pitch' | 'flop' = 'full', lie = 0, top = 0, strike = { x: 0, y: 0 }) {
    const P = planShot({ power: 1, offMs: 0, pushMs: 200, angle: 0, drift: 0, released: false, strike, aim: { curve: aim.curve, loft: aim.loft } }, club, mode, LIES[lie], golfer.lefty);
    const b = new Ball(range); b.tee(golfer.ballWorld()); b.hit(P.launch);
    for (let i = 0; i < 120 * 40 && b.phase !== 'stopped'; i++) { if (b.phase === 'flight' && b.t > 0.5) b.setAftertouch(top, 0); b.step(1 / 120); }
    return { carry: b.carry() / YD, total: b.total() / YD, roll: b.roll() / YD, apex: b.apex / YD, surface: b.lastSurface };
  },
};
