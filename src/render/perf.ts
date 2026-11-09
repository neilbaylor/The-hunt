// Performance tiers for phones: pick a starting tier from what the device says about itself, probe the first
// frames, and step down at runtime while frames keep running long. One knob drives everything that costs:
//
//   tier   pixel-ratio cap   post                          range detail
//   low    1.5               direct render (no DOF/sharpen) coarse terrain, ~40% blades, ~35% far trees, 1024 shadows
//   med    1.75              bloom + grade + DOF + sharpen  ~75% blades, ~70% far trees, 2048 shadows
//   high   2                 + MSAA and ground AO           everything
//
// ?perf=low|med|high pins a tier (no adaptation); ?pr= and ?q= keep pinning the pixel ratio / post quality.
// ?perf or ?debug shows a small stats line (tier, pixel ratio, fps, frame ms, draw calls, triangles).
import * as THREE from 'three';
import type { Post, Quality } from './post';
import type { Detail } from '../world/range';

export type Tier = Detail;
const ORDER: Tier[] = ['low', 'med', 'high'];
export const TIERS: Record<Tier, { prCap: number; post: Quality }> = {
  low: { prCap: 1.5, post: 'low' },
  med: { prCap: 1.75, post: 'med' },
  high: { prCap: 2, post: 'high' },
};

export function gpuName(renderer: THREE.WebGLRenderer): string {
  const gl = renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
}

/** the starting tier; `fixed` when the URL pins it */
export function initialTier(renderer: THREE.WebGLRenderer, qs = new URLSearchParams(location.search)): { tier: Tier; fixed: boolean; why: string } {
  const o = qs.get('perf');
  if (o === 'low' || o === 'med' || o === 'high') return { tier: o, fixed: true, why: '?perf' };
  const gpu = gpuName(renderer).toLowerCase();
  const nav = navigator as Navigator & { deviceMemory?: number };
  const mem = nav.deviceMemory ?? 8, cores = navigator.hardwareConcurrency ?? 8;
  const coarse = matchMedia('(pointer: coarse)').matches;
  // older / budget mobile GPUs
  if (/mali-[gt]?[1-7]\d\b|mali-4|adreno \(tm\) [1-5]\d\d\b|adreno [1-5]\d\d\b|powervr|sgx|videocore/.test(gpu)) return { tier: 'low', fixed: false, why: 'gpu ' + gpu };
  if (mem <= 3 || (coarse && cores <= 4)) return { tier: 'low', fixed: false, why: `mem ${mem} cores ${cores}` };
  // phones and tablets (iPhones report just "Apple GPU"): start in the middle, the frame probe decides from there
  if (coarse) return { tier: 'med', fixed: false, why: 'touch' };
  return { tier: 'high', fixed: false, why: 'desktop' };
}

export interface PerfTargets {
  post: Post;
  range: { setDetail(d: Detail): void } | null;
  /** called after the pixel ratio changes (resize the renderer and post) */
  resize: () => void;
}

export class PerfGovernor {
  tier: Tier;
  pr: number;
  readonly fixed: boolean;
  private times: number[] = [];
  private warm = 0;
  private slow = 0;
  private fast = 0;
  private probed = false;
  private overlay: HTMLElement | null = null;
  private last = { calls: 0, tris: 0, ms: 0 };
  /** pixel ratio / post quality pinned by the URL (?pr= / ?q=) */
  private prFixed: number | null;
  private qFixed: Quality | null;

  constructor(private renderer: THREE.WebGLRenderer, private t: PerfTargets, init: { tier: Tier; fixed: boolean; why: string }, qs = new URLSearchParams(location.search)) {
    this.tier = init.tier;
    this.prFixed = qs.has('pr') ? +qs.get('pr')! : null;
    const q = qs.get('q'); this.qFixed = q === 'low' || q === 'med' || q === 'high' ? q : null;
    // a pinned pixel ratio or post quality (test harnesses) also pins the tier, as the old dynamic resolution did
    this.fixed = init.fixed || this.prFixed !== null || this.qFixed !== null;
    this.pr = this.prFixed ?? Math.min(devicePixelRatio, TIERS[this.tier].prCap);
    // totals over a whole frame (the composer renders several passes)
    renderer.info.autoReset = false;
    if (qs.has('perf') || qs.has('debug')) {
      this.overlay = document.body.appendChild(Object.assign(document.createElement('div'), {
        style: 'position:fixed;left:6px;bottom:calc(6px + env(safe-area-inset-bottom));z-index:99;font:10px/1.3 ui-monospace,monospace;color:#fff;background:rgba(0,0,0,.55);padding:3px 6px;border-radius:4px;pointer-events:none;white-space:pre',
      }));
    }
    this.apply(this.tier, true);
    console.info(`[perf] start ${this.tier} (${init.why}${this.fixed ? ', pinned' : ''}) · ${gpuName(renderer)}`);
  }

  /** set a tier: pixel-ratio cap, post quality, range detail */
  apply(tier: Tier, first = false) {
    this.tier = tier;
    if (this.prFixed === null) this.pr = Math.min(devicePixelRatio, TIERS[tier].prCap);
    this.renderer.setPixelRatio(this.pr);
    if (!this.qFixed) this.t.post.setQuality(TIERS[tier].post);
    this.t.range?.setDetail(tier);
    if (!first) this.t.resize();
    this.times.length = 0;
  }

  /** call once per frame, before rendering, with the frame's real (unscaled) dt in seconds */
  frame(dt: number) {
    const info = this.renderer.info.render;
    this.last.calls = info.calls; this.last.tris = info.triangles;
    this.renderer.info.reset();
    const ms = dt * 1000;
    this.last.ms += (ms - this.last.ms) * 0.1;
    if (this.overlay && (this.warm++ % 15 === 0)) {
      this.overlay.textContent = `${this.tier}${this.fixed ? '*' : ''} · pr ${this.pr.toFixed(2)} · ${(1000 / Math.max(1, this.last.ms)).toFixed(0)} fps ${this.last.ms.toFixed(1)} ms · ${this.last.calls} calls · ${(this.last.tris / 1000).toFixed(0)}k tris`;
    }
    if (this.fixed) return;
    // ignore the first frames (shader compiles, texture uploads) and hidden-tab gaps
    if (this.warm < 30 || ms > 250) return;
    this.times.push(ms);
    const N = this.probed ? 90 : 60;
    if (this.times.length < N) return;
    const sorted = [...this.times].sort((a, b) => a - b), med = sorted[N >> 1], avg = this.times.reduce((a, b) => a + b, 0) / N;
    this.times.length = 0;
    const heavy = Math.max(med, avg * 0.9) > 20;
    if (!this.probed) { this.probed = true; if (heavy) this.down(); return; }
    if (heavy) { this.fast = 0; if (++this.slow >= 2) { this.slow = 0; this.down(); } }
    else if (avg < 12) { this.slow = 0; if (++this.fast >= 4) { this.fast = 0; this.up(); } }
    else { this.slow = 0; this.fast = 0; }
  }

  /** a step down: the tier first, then (at low) the pixel ratio down to 1 */
  private down() {
    const i = ORDER.indexOf(this.tier);
    if (i > 0) { this.apply(ORDER[i - 1]); console.info(`[perf] → ${this.tier}`); return; }
    if (this.prFixed === null && this.pr > 1) { this.pr = Math.max(1, this.pr - 0.25); this.renderer.setPixelRatio(this.pr); this.t.resize(); console.info(`[perf] pr → ${this.pr}`); }
  }
  /** headroom: give back resolution within the tier's cap (never a tier, to avoid see-sawing) */
  private up() {
    const cap = Math.min(devicePixelRatio, TIERS[this.tier].prCap);
    if (this.prFixed === null && this.pr < cap) { this.pr = Math.min(cap, this.pr + 0.25); this.renderer.setPixelRatio(this.pr); this.t.resize(); }
  }

  get stats() { return { tier: this.tier, pr: this.pr, ms: this.last.ms, calls: this.last.calls, triangles: this.last.tris }; }
}
