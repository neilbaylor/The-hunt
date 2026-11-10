// The player's live face badge: a small second camera renders just the golfer's head (render layer 5) into a
// 128 px target every other frame; each frame that image is drawn into a circle on the main canvas where the HUD
// badge sits (no read-back to the CPU). Under it, the swing word; beside it, a speech bubble that types out a
// one-liner while the jaw moves. Reactions drive the generated head's expressions (smile via the golfer, the rest
// via body.face) and a little head shake (the badge camera sways).
import * as THREE from 'three';

export const AVATAR_LAYER = 5;

export interface FaceLike {
  setExpression(e: { smile?: number; grimace?: number; browUp?: number; browDown?: number; jawOpen?: number; blink?: number }): void;
  lookAt(t: THREE.Vector3 | null): void;
}
export type Outcome = 'pure' | 'good' | 'ok' | 'bad' | 'shank' | 'near' | 'holed';

const LINES: Record<Outcome, string[]> = {
  pure: ['Right out of the screws!', 'Perfect. Did you hear that?', 'That one felt like butter.'],
  good: ['I\'ll take that all day.', 'Nice and solid.', 'Good swing, that.'],
  ok: ['Not bad. Not great.', 'We go again.', 'Playable.'],
  bad: ['Ugh. Rushed it.', 'That\'s not the one.', 'Hands got quick there.'],
  shank: ['Nobody saw that. Right?', 'Ohhh no. Not the hosel.', 'Let\'s pretend that didn\'t happen.'],
  near: ['Stiff! Pin high!', 'Oh, that\'s tight!', 'Look at that!'],
  holed: ['NO WAY! It went in!', 'GET IN THE HOLE!'],
};

export class FaceBadge {
  readonly el: HTMLDivElement;
  private badge: HTMLDivElement; private word: HTMLSpanElement; private bubble: HTMLDivElement;
  private rt = new THREE.WebGLRenderTarget(192, 192, { samples: 4 });
  private cam = new THREE.PerspectiveCamera(17, 1, 0.84, 3);   // a long lens from 1 m with the near clip just short of the visor: an arm or the club in front never blocks the face
  private up = new THREE.Vector3(0, 1, 0); private fwdInit = false;
  private key = new THREE.DirectionalLight('#fff4e6', 1.8); private fill = new THREE.DirectionalLight('#dbe9ff', 0.6);
  private blitScene = new THREE.Scene(); private blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private bg = new THREE.Color('#7fb3d6');
  private frame = 0;
  private fwd = new THREE.Vector3(0, 0, 1);
  private t = 0;
  // expression timeline
  private ex = { smile: 0, grimace: 0, browUp: 0, jawOpen: 0 };
  private exT = { smile: 0, grimace: 0, browUp: 0, jawOpen: 0 };
  private hold = 0; private shake = 0;
  private typing: { text: string; i: number; acc: number } | null = null; private bubbleT = 0;

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene, private head: () => THREE.Object3D | null,
    private face: () => FaceLike | undefined, host: HTMLElement, name: string, _body: () => THREE.Object3D | null = () => null) {
    this.rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this.cam.layers.set(AVATAR_LAYER);
    for (const l of [this.key, this.fill]) { l.layers.set(AVATAR_LAYER); scene.add(l, l.target); }
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: this.rt.texture } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `uniform sampler2D map; varying vec2 vUv;
        void main(){ vec2 d = vUv - 0.5; float r = length(d); if (r > 0.5) discard;
          gl_FragColor = texture2D(map, vUv); gl_FragColor.a = 1.0 - smoothstep(0.485, 0.5, r);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true, depthTest: false, depthWrite: false, toneMapped: true,
    });
    this.blitScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
    this.el = document.createElement('div'); this.el.className = 'face-wrap';
    this.el.innerHTML = `<div class="face-badge" aria-hidden="true"></div><b class="face-name">${name}</b><span class="face-word" aria-live="polite"></span><div class="face-bubble" role="status" aria-live="polite"></div>`;
    host.innerHTML = ''; host.appendChild(this.el);
    this.badge = this.el.querySelector('.face-badge')!; this.word = this.el.querySelector('.face-word')!; this.bubble = this.el.querySelector('.face-bubble')!;
  }

  /** the swing word under the face; stays until the next swing */
  setWord(text: string, cls: string, sub = '') {
    this.word.className = 'face-word ' + cls; this.word.textContent = text;
    if (sub) { const s = document.createElement('small'); s.className = 'face-shape'; s.textContent = sub; this.word.appendChild(s); }
    this.word.classList.remove('in'); void this.word.offsetWidth; this.word.classList.add('in');
  }
  clearWord() { this.word.textContent = ''; this.word.className = 'face-word'; this.bubble.classList.remove('on'); }

  /** react to a shot: expression, head shake, a one-liner typed into the bubble */
  react(o: Outcome, extra = '') {
    const pick = LINES[o][Math.floor(Math.random() * LINES[o].length)];
    const E = this.exT; E.smile = 0; E.grimace = 0; E.browUp = 0; E.jawOpen = 0;
    if (o === 'pure') { E.smile = 1; E.browUp = 0.3; }
    else if (o === 'good') E.smile = 0.7;
    else if (o === 'ok') E.smile = 0.25;
    else if (o === 'bad') { E.grimace = 0.6; }
    else if (o === 'shank') { E.grimace = 1; this.shake = 1; }
    else if (o === 'near' || o === 'holed') { E.browUp = 1; E.jawOpen = o === 'holed' ? 0.8 : 0.55; E.smile = 0.5; }
    this.hold = 3.2;
    this.typing = { text: extra ? `${pick} ${extra}` : pick, i: 0, acc: 0 };
    this.bubble.textContent = ''; this.bubble.classList.add('on'); this.bubbleT = 0;
  }
  /** the smile target for golfer.smileToward (the golfer drives the smile channel) */
  get smile() { return this.ex.smile; }

  update(dt: number) {
    this.t += dt;
    if (this.hold > 0) { this.hold -= dt; if (this.hold <= 0) { this.exT.smile = 0; this.exT.grimace = 0; this.exT.browUp = 0; this.exT.jawOpen = 0; } }
    const k = 1 - Math.exp(-dt * 7);
    for (const key of Object.keys(this.ex) as (keyof typeof this.ex)[]) this.ex[key] += (this.exT[key] - this.ex[key]) * k;
    let jaw = this.ex.jawOpen;
    if (this.typing) {
      const T = this.typing; T.acc += dt;
      while (T.acc > 0.035 && T.i < T.text.length) { T.acc -= 0.035; T.i++; }
      this.bubble.textContent = T.text.slice(0, T.i);
      jaw = Math.max(jaw, 0.32 * (0.5 + 0.5 * Math.sin(this.t * 19)) * (/[aeiouAEIOU!]/.test(T.text[T.i - 1] ?? '') ? 1 : 0.55));
      if (T.i >= T.text.length) { this.typing = null; this.bubbleT = 2.6; }
    } else if (this.bubbleT > 0) { this.bubbleT -= dt; if (this.bubbleT <= 0) this.bubble.classList.remove('on'); }
    this.face()?.setExpression({ grimace: this.ex.grimace, browUp: this.ex.browUp, jawOpen: jaw });
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 0.9);
  }

  /** after the main frame is on screen: refresh the head image every other frame and draw it into the badge */
  draw(visible: boolean) {
    if (!visible) return;
    const r = this.badge.getBoundingClientRect(); if (r.width < 4) return;
    const canvas = this.renderer.domElement.getBoundingClientRect();
    const R = this.renderer;
    if ((this.frame++ & 1) === 0) {
      const h = this.head(); if (!h) return;
      // stopgap until the separate badge head lands: a face camera along the head's forward axis with the head's
      // pitch and roll cancelled (forward flattened onto the ground, world up), so bowed over the ball, at the top
      // or at the finish the badge looks him in the face, level, instead of at the top of his head or the visor
      const eye = h.localToWorld(new THREE.Vector3(0, 0.085, 0.06));
      const fwd = new THREE.Vector3(0, 0, 1).transformDirection(h.matrixWorld); fwd.y = 0;
      if (fwd.lengthSq() < 1e-4) fwd.copy(this.fwd); fwd.normalize();
      if (this.fwdInit) this.fwd.lerp(fwd, 0.5).normalize(); else { this.fwd.copy(fwd); this.fwdInit = true; }
      this.up.set(0, 1, 0);
      const right = new THREE.Vector3().crossVectors(this.up, this.fwd).normalize();
      const sway = this.shake > 0 ? Math.sin(this.t * 22) * 0.1 * this.shake : 0;
      const look = eye.clone().addScaledVector(this.up, -0.05);                     // nose height: face + a little shoulder
      this.cam.position.copy(look).addScaledVector(this.fwd, 0.98).addScaledVector(right, 0.16 + sway).addScaledVector(this.up, -0.04);   // level, slight ¾, a touch low to see under the visor
      this.cam.up.copy(this.up); this.cam.lookAt(look);
      // its own key and fill, riding with the camera, so it's never dark
      this.key.position.copy(this.cam.position).addScaledVector(this.up, 0.5).addScaledVector(right, -0.4); this.key.target.position.copy(look);
      this.fill.position.copy(this.cam.position).addScaledVector(right, 0.6).addScaledVector(this.up, -0.1); this.fill.target.position.copy(look);
      this.key.target.updateMatrixWorld(); this.fill.target.updateMatrixWorld();
      const prevBg = this.scene.background, prevFog = this.scene.fog, shadowAuto = R.shadowMap.autoUpdate;
      this.scene.background = this.bg; this.scene.fog = null; R.shadowMap.autoUpdate = false;
      R.setRenderTarget(this.rt); R.clear(); R.render(this.scene, this.cam); R.setRenderTarget(null);
      this.scene.background = prevBg; this.scene.fog = prevFog; R.shadowMap.autoUpdate = shadowAuto;
    }
    // blit into the badge's circle on the main canvas
    const x = r.left - canvas.left, y = canvas.bottom - r.bottom;
    const auto = R.autoClear; R.autoClear = false;
    R.setScissorTest(true); R.setScissor(x, y, r.width, r.height); R.setViewport(x, y, r.width, r.height);
    R.render(this.blitScene, this.blitCam);
    R.setScissorTest(false); R.setViewport(0, 0, canvas.width, canvas.height); R.autoClear = auto;
  }
}
