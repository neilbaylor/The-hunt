// The driving range: Neil on the tee, the swing pad, the ball in flight, the spin ball, the cameras.
import * as THREE from 'three';
import { createRange, type Range } from './world/range';
import { createPost } from './render/post';
import { Golfer, PHI_TOP, PHI_FINISH, SHOT_STYLE, type SwingPhase } from './golfer/golfer';
import { NEIL } from './golfer/profile';
import { loadNeil } from './golfer/assets';
import { CLUB_SPECS } from './golfer/club';
import { Ball, BALL } from './game/ball';
import { planShot, LIES, YD, type ShotPlan } from './game/shot';
import { Tracer } from './game/tracer';
import { Sound } from './game/audio';
import { Hud, viewport, type CardData } from './ui/hud';
import { ballTex, onBallTexUpdate } from './ui/balltex';
import { AimController, aim } from './game/aim';
import { MODES as SHOT_MODES } from './game/shot';

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ── renderer ──
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
const QS = new URLSearchParams(location.search);
let pixelRatio = QS.has('pr') ? +QS.get('pr')! : Math.min(devicePixelRatio, 1.75);
const fixedPR = QS.has('pr');
renderer.setPixelRatio(pixelRatio);
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
try { range = createRange(renderer, scene); range.setTimeOfDay(QS.get('time') === 'midday' ? 'midday' : 'golden'); } catch (e) { console.error('range failed', e); }
// post-processing: high on desktop, medium on phones (falls back to low if frames run long)
const coarse = matchMedia('(pointer: coarse)').matches;
const post = createPost(renderer, scene, camera, { quality: (QS.get('q') as any) ?? (coarse ? 'med' : 'high'), grade: range?.timeOfDay ?? 'golden', toneMapping: 'agx' });
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
// tour ball: hex-packed dimple normal map + sidestamp print (shared with the HUD spin ball)
const ballTexInfo = ballTex();
const ballPrint = new THREE.CanvasTexture(ballTexInfo.printCanvas); ballPrint.colorSpace = THREE.SRGBColorSpace; ballPrint.anisotropy = 4;
const ballNormal = new THREE.CanvasTexture(ballTexInfo.normalCanvas); ballNormal.colorSpace = THREE.NoColorSpace;
onBallTexUpdate(() => { ballPrint.needsUpdate = true; });
const ballMat = new THREE.MeshPhysicalMaterial({ color: '#fbfaf6', roughness: 0.42, clearcoat: 1, clearcoatRoughness: 0.12, normalMap: ballNormal, normalScale: new THREE.Vector2(1, 1) });
ballMat.onBeforeCompile = sh => {
  sh.uniforms.printMap = { value: ballPrint };
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D printMap;')
    .replace('#include <map_fragment>', '#include <map_fragment>\nvec4 pr = texture2D(printMap, vNormalMapUv);\ndiffuseColor.rgb = mix(diffuseColor.rgb, pr.rgb, pr.a);');
};
ballMat.customProgramCacheKey = () => 'tour-ball';
const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(BALL.r, 48, 32), ballMat);
ballMesh.castShadow = true; scene.add(ballMesh);
// a white painted wooden tee: pointed shank, flared neck and a shallow cup with a rolled rim (origin = old centre,
// so the ball's bottom sits in the cup at y = +0.022); most of the shank is pushed into the turf by teeUp()
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
hud.el.classList.add('hidden');
const sound = new Sound();
hud.club = 6; hud.mode = 'full'; hud.lie = 0; hud.render(null);
hud.onClub = i => { sound.ui(); golfer.setClub(i, hud.mode); teeUp(); aimCtl.clubChanged(); };
hud.onMode = m => { sound.ui(); golfer.setClub(hud.club, m); teeUp(); aimCtl.clubChanged(); };
// ── aiming (src/game/aim.ts): ground arrow in the swing cam, overhead aim view with a draggable ring ──
const aimCtl = new AimController({
  scene, camera, canvas: renderer.domElement, range, lefty: golfer.lefty,
  ballPos: () => golfer.ballWorld(new THREE.Vector3()),
  carry: () => { const full = SHOT_MODES[hud.mode].max(CLUB_SPECS[hud.club].id); return { full, min: Math.max(5, Math.round(full * 0.35)), max: Math.round(full * 1.08) }; },
  // the golfer turns to face the aim line (he stands round the ball, which sits at the origin)
  onChange: () => { golfer.root.rotation.y = -aim.dir; golfer.root.updateMatrixWorld(true); if (state === 'ready') teeUp(); },
});
hud.onLie = () => sound.ui();

function teeUp() {
  const p = golfer.ballWorld();
  ball.tee(p);
  ballMesh.position.copy(p);
  const driver = CLUB_SPECS[hud.club].kind === 'driver';
  tee.visible = driver;
  tee.position.set(p.x, p.y - BALL.r - 0.03 + 0.008, p.z);
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
  plan = planShot({ power, offMs: SW.off, pushMs: now - SW.tTrans, angle, drift, released, strike: strikePt }, hud.club, hud.mode, LIES[hud.lie], golfer.lefty);
  plan.launch.azimuth += aim.dir; // aimed off the straight line (aim view)
  ball.hit(plan.launch);
  tracer.clear(); tracer.push(ball.pos);
  card = { plan, power, offMs: SW.off, done: false };
  if (dbg) dbg.textContent = `pull ${Math.round(SW.tDeep - SW.t0)} ms · pause ${Math.round(SW.tAt - SW.tDeep)} ms · push ${Math.round(now - SW.tTrans)} ms\nvs top ${dbgRaw > 0 ? '+' : ''}${Math.round(dbgRaw)} ms → graded ${Math.round(SW.off)} ms (${plan.tempoWord})`;
  hud.card(card);
  hud.toast(plan.tempoWord, plan.why, plan.tempoCls);
  sound.strike(CLUB_SPECS[hud.club].kind, 1 - plan.error);
  try { navigator.vibrate?.(18); } catch { /* not allowed */ }
  hitStop = 0.09;
  shake = 0.5;
  Object.assign(G, { phase: 'follow', phi: 0, followT0: now, followTo: PHI_FINISH * (0.55 + 0.45 * power) });
  state = 'flight';
  hud.showSpin(true);
  camMode = 'chase'; chaseT0 = now;
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
  shadowsOnGolfer(true);
  state = 'ready';
  Object.assign(G, { phase: 'address', phi: 0, target: 0, arrived: null, returning: false, idleT: 0 });
  teeUp();
  camMode = 'address';
  snapCamera();
}

// ── cameras ──
type CamMode = 'intro' | 'address' | 'chase' | 'landing' | 'rest';
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
    // phone held upright: tight on the golfer from behind his trail side, like a TV swing cam
    out.set(0.7 * side, 1.75, 3.6);
    look.set(0.45 * side, 0.35, -6);
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

function updateCamera(dt: number, now: number) {
  const k = 1 - Math.pow(0.0025, dt);
  if (camMode === 'intro') {
    // circle slowly in front of the golfer
    const th = (golfer.lefty ? Math.PI : 0) + 0.6 * Math.sin(now / 1000 * 0.22) + 0.35 * side;
    const head = new THREE.Vector3(); golfer.body.bones[5].getWorldPosition(head);
    want.set(head.x + Math.cos(th) * 2.7, 1.42 + Math.sin(now / 1000 * 0.15) * 0.08, head.z + Math.sin(th) * 2.7);
    wantLook.set(head.x * 0.85, 1.22, head.z);
  } else if (camMode === 'address') {
    if (aimCtl.active) aimCtl.cameraWant(want, wantLook); else addressCam(want, wantLook);
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
  const wantShift = portrait() && !aimCtl.active && (camMode === 'address' || camMode === 'intro' || (camMode === 'chase' && (now - chaseT0) < 550)) ? (camMode === 'intro' ? 0.0 : addressShift()) : 0;
  if (Math.abs(wantShift - lensShift) > 0.002) { lensShift += (wantShift - lensShift) * (1 - Math.pow(0.02, dt)); fitCamera(); }
  const kk = camMode === 'landing' || camMode === 'rest' ? 1 - Math.pow(0.02, dt) : k;
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
intro.innerHTML = `<div class="intro-card"><span class="brand"><i class="crest" aria-hidden="true"></i><b>The Hunt</b></span>
  <span class="kick">Player 1</span><h1>${profile.name}</h1>
  <button type="button" id="play"><span class="ball" aria-hidden="true"></span>Hit balls</button></div>`;
document.body.appendChild(intro);
intro.querySelector('#play')!.addEventListener('click', () => { sound.unlock(); startPlay(); });
function startPlay() {
  if (state !== 'intro') return;
  intro.classList.add('gone');
  setTimeout(() => intro.remove(), 600);
  state = 'ready'; camMode = 'address';
  hud.el.classList.remove('hidden');
}

// ── loop ──
teeUp();
golfer.update({ phase: 'address', phi: 0, topPhi: PHI_TOP, idleT: 0 });
shadowsOnGolfer(true);
camMode = 'intro';
camPos.set(3, 1.5, 3); camLook.set(0, 1, 0);
let last = performance.now();
const frameTimes: number[] = [];
const focus = new THREE.Vector3();
const tmp = new THREE.Vector3();

function frame(now: number) {
  let dt = Math.min(0.05, (now - last) / 1000); last = now;
  frameTimes.push(dt); if (frameTimes.length > 90) frameTimes.shift();
  if (hitStop > 0) { hitStop -= dt; dt *= 0.18; }
  // fast forward: hold the 3D view while the ball is flying/rolling → the ball and cameras run at up to 3×
  ff.scale += ((ff.held && state === 'flight' ? 3 : 1) - ff.scale) * Math.min(1, dt / 0.15);
  ff.pill.hidden = !(ff.held && state === 'flight');
  const simDt = dt * ff.scale;   // the ball sub-steps internally (≤ 4 ms), so 3× stays stable

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
  const good = state === 'result' && !!plan && plan.tempoWord === 'Smooth' && Math.abs(ball.offline() / YD) < 10;
  golfer.smileToward(state === 'intro' || good ? 1 : 0, dt);

  hud.setState(state === 'ready', state === 'flight', !card);
  aimCtl.setEnabled(state === 'ready');
  aimCtl.update(dt, state === 'ready' || state === 'swinging');

  // swing pad
  if (SW.active || SW.trailB.length) hud.setPad(SW.active ? SW.last : [0, 0], SW.trailB, SW.trailD, SW.active && SW.phase === 'back' && G.arrived !== null && SW.depth > 12);

  // ball
  if (state === 'flight') {
    // spin set on the spin ball ramps in over the rest of the flight
    if (ball.phase === 'flight') ball.setAftertouch(hud.spin.y, hud.spin.x);
    const wasFlight = ball.phase === 'flight';
    ball.step(simDt);
    tracer.push(ball.pos);
    if (wasFlight && ball.phase !== 'flight') {
      sound.land(ball.lastSurface === 'green' ? 0.6 : ball.lastSurface === 'rough' ? 0.9 : 0.2);
      hud.spinDone();
      if (card) { card.carry = ball.carry() / YD; card.apex = ball.apex / YD; hud.card(card); }
    }
    if (ball.phase === 'stopped') {
      state = 'result'; resultT = now; camMode = 'rest';
      if (card) { Object.assign(card, { done: true, carry: ball.carry() / YD, total: ball.total() / YD, offline: ball.offline() / YD }); hud.card(card); }
      const tot = ball.total() / YD, off = ball.offline() / YD;
      const near = range?.targets.reduce((b, t) => { const d = Math.hypot(t.pos.x - ball.pos.x, t.pos.z - ball.pos.z); return d < b.d ? { d, t } : b; }, { d: Infinity, t: null as any });
      const msg = near && near.t && near.d < near.t.radius ? `On the ${near.t.yards} green · ${(near.d / YD).toFixed(0)} yds from the pin` : `${tot.toFixed(0)} yds · ${Math.abs(off) < 1 ? 'online' : `${Math.abs(off).toFixed(0)} ${off < 0 ? 'left' : 'right'}`}`;
      hud.toast(near && near.t && near.d < near.t.radius ? 'Green!' : `${tot.toFixed(0)} yds`, msg, near && near.t && near.d < near.t.radius ? 'good' : 'warn');
    }
  }
  if (state === 'result' && now - resultT > 4200) nextBall();
  ballMesh.position.copy(ball.pos);
  ballMesh.quaternion.copy(ball.spinQuat);
  // keep the ball visible far away
  const d = camera.position.distanceTo(ball.pos);
  ballMesh.scale.setScalar(Math.max(1, d * 0.0035));
  hud.tickSpin(dt, state === 'flight' && ball.phase === 'flight');

  updateCamera(simDt, now);
  { const g = golfer.ballWorld(tmp); fill.target.position.set(g.x + (golfer.lefty ? 0.8 : -0.8), 1.1, g.z); fill.position.copy(camera.position).add(new THREE.Vector3(-1.5, 2.2, 0.5)); fill.intensity += ((state === 'intro' ? 2.4 : 0.9) - fill.intensity) * Math.min(1, dt * 3); }
  tracer.update(camera, state === 'ready' ? 0.6 : 1);
  focus.copy(state === 'flight' || state === 'result' ? ball.pos : golfer.ballWorld(tmp));
  range?.update(dt, camera, focus);

  // dynamic resolution: keep frames under ~20 ms
  if (frameTimes.length === 90 && !fixedPR) {
    const avg = frameTimes.reduce((a, b) => a + b, 0) / 90;
    if (avg > 0.024 && pixelRatio > 1) { pixelRatio = Math.max(1, pixelRatio - 0.25); renderer.setPixelRatio(pixelRatio); post.setSize(viewport().w, viewport().h); if (pixelRatio <= 1 && post.quality !== 'low') post.setQuality('low'); frameTimes.length = 0; }
    else if (avg < 0.0135 && pixelRatio < Math.min(devicePixelRatio, 2)) { pixelRatio = Math.min(Math.min(devicePixelRatio, 2), pixelRatio + 0.25); renderer.setPixelRatio(pixelRatio); frameTimes.length = 0; }
  }
  const r0 = performance.now();
  post.render(dt);
  (window as any).__frameMs = performance.now() - r0;
  requestAnimationFrame(frame);
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
  if (state === 'flight') { ff.held = true; try { renderer.domElement.setPointerCapture(e.pointerId); } catch { /* not supported */ } }
});
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) renderer.domElement.addEventListener(ev, () => { ff.held = false; });
requestAnimationFrame(t => { last = t; frame(t); });
(window as any).__game = {
  golfer, ball, hud, aim, aimCtl, get state() { return state; },
  /** debug: plan and fly a shot on the real range terrain, synchronously (distances in yards) */
  sim(club: number, mode: 'full' | 'punch' | 'pitch' | 'flop' = 'full', lie = 0, top = 0, strike = { x: 0, y: 0 }) {
    const P = planShot({ power: 1, offMs: 0, pushMs: 200, angle: 0, drift: 0, released: false, strike }, club, mode, LIES[lie], golfer.lefty);
    const b = new Ball(range); b.tee(golfer.ballWorld()); b.hit(P.launch);
    for (let i = 0; i < 120 * 40 && b.phase !== 'stopped'; i++) { if (b.phase === 'flight' && b.t > 0.5) b.setAftertouch(top, 0); b.step(1 / 120); }
    return { carry: b.carry() / YD, total: b.total() / YD, roll: b.roll() / YD, apex: b.apex / YD, surface: b.lastSurface };
  },
};
