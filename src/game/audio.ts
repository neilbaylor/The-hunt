// All sound is synthesised: no files to ship. Starts on the first touch (browsers require it).
import type { ClubKind } from '../golfer/club';

export class Sound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private ambienceOn = false;

  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain(); this.master.gain.value = 0.8; this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 2; this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0); for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.ambience();
    } catch { this.ctx = null; }
  }

  private src(dur: number) { const s = this.ctx!.createBufferSource(); s.buffer = this.noise; s.loop = dur > 2; return s; }

  /** the club whooshing through the air; strength 0..1 */
  swoosh(strength: number, dur = 0.32) {
    const c = this.ctx; if (!c) return;
    const t = c.currentTime, s = this.src(dur), bp = c.createBiquadFilter(), g = c.createGain();
    bp.type = 'bandpass'; bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(400, t); bp.frequency.exponentialRampToValueAtTime(1800 + 1600 * strength, t + dur * 0.8);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35 * strength + 0.05, t + dur * 0.75); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(bp).connect(g).connect(this.master); s.start(t); s.stop(t + dur + 0.05);
  }

  /** ball strike: crisp click for irons, a hollow "tink-thwack" for woods */
  strike(kind: ClubKind, quality: number) {
    const c = this.ctx; if (!c) return;
    const t = c.currentTime;
    const wood = kind === 'driver' || kind === 'wood' || kind === 'hybrid';
    // transient
    const s = this.src(0.1), hp = c.createBiquadFilter(), g = c.createGain();
    hp.type = 'highpass'; hp.frequency.value = wood ? 1500 : 2500;
    g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    s.connect(hp).connect(g).connect(this.master); s.start(t); s.stop(t + 0.08);
    // body ring
    for (const [f, a, d] of (wood ? [[1250, 0.35, 0.12], [2650, 0.18, 0.08], [380, 0.3, 0.06]] : [[3100, 0.22, 0.05], [5200, 0.1, 0.03], [600, 0.25, 0.04]]) as number[][]) {
      const o = c.createOscillator(), og = c.createGain();
      o.frequency.value = f * (0.97 + 0.06 * quality); o.type = 'sine';
      og.gain.setValueAtTime(a * (0.6 + 0.4 * quality), t); og.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(og).connect(this.master); o.start(t); o.stop(t + d + 0.02);
    }
    // thump
    const o = c.createOscillator(), og = c.createGain(); o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(60, t + 0.08);
    og.gain.setValueAtTime(0.5, t); og.gain.exponentialRampToValueAtTime(0.0001, t + 0.1); o.connect(og).connect(this.master); o.start(t); o.stop(t + 0.12);
  }

  land(soft: number) {
    const c = this.ctx; if (!c) return;
    const t = c.currentTime, s = this.src(0.2), lp = c.createBiquadFilter(), g = c.createGain();
    lp.type = 'lowpass'; lp.frequency.value = 500 + 600 * (1 - soft);
    g.gain.setValueAtTime(0.25 * (1 - soft * 0.5), t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    s.connect(lp).connect(g).connect(this.master); s.start(t); s.stop(t + 0.15);
  }

  ui() {
    const c = this.ctx; if (!c) return;
    const t = c.currentTime, o = c.createOscillator(), g = c.createGain(); o.frequency.value = 880; o.type = 'triangle';
    g.gain.setValueAtTime(0.06, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06); o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.07);
  }

  /** soft wind bed + occasional birds */
  private ambience() {
    const c = this.ctx; if (!c || this.ambienceOn) return; this.ambienceOn = true;
    const s = this.src(10), lp = c.createBiquadFilter(), g = c.createGain();
    lp.type = 'lowpass'; lp.frequency.value = 380; g.gain.value = 0.05;
    const lfo = c.createOscillator(), lg = c.createGain(); lfo.frequency.value = 0.07; lg.gain.value = 0.03; lfo.connect(lg).connect(g.gain); lfo.start();
    s.connect(lp).connect(g).connect(this.master); s.start();
    const bird = () => {
      if (!this.ctx) return;
      const t = c.currentTime, n = 2 + Math.floor(Math.random() * 4), base = 2600 + Math.random() * 1800;
      for (let i = 0; i < n; i++) {
        const o = c.createOscillator(), og = c.createGain(), t0 = t + i * (0.09 + Math.random() * 0.05);
        o.frequency.setValueAtTime(base, t0); o.frequency.exponentialRampToValueAtTime(base * (1.2 + Math.random() * 0.5), t0 + 0.05);
        og.gain.setValueAtTime(0.0001, t0); og.gain.exponentialRampToValueAtTime(0.025, t0 + 0.01); og.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.07);
        o.connect(og).connect(this.master); o.start(t0); o.stop(t0 + 0.08);
      }
      setTimeout(bird, 3000 + Math.random() * 7000);
    };
    setTimeout(bird, 2000);
  }
}
