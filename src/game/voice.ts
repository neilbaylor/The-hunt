// The golfer's voice: short pre-rendered one-liners (src/assets/voice, made by tools/voice/make_voice.py with a generic
// stock TTS voice), picked by shot outcome. speak() plays one and returns its text, duration and lip-sync curves so the
// face can talk in time with the real audio: `jaw` is mouth opening 0..1 at `fps`, `vis` the viseme keys of
// genhead.ts (A E I O U M F C _) with their start times in seconds.
import manifest from '../assets/voice/manifest.json';

export type VoiceOutcome = 'pure' | 'good' | 'ok' | 'bad' | 'shank' | 'near' | 'tracking' | 'holed' | 'intro';

export interface VoiceLine {
  id: string; text: string; outcomes: string[];
  /** false for lines with swearing (a no-swearing mode skips them) */
  clean: boolean;
  /** seconds */
  duration: number;
  fps: number; jaw: number[]; vis: [number, string][];
}

const URLS = import.meta.glob('../assets/voice/*.mp3', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
const urlOf = (id: string) => URLS[`../assets/voice/${id}.mp3`];
const CLIPS = (manifest as { clips: VoiceLine[] }).clips.filter(c => urlOf(c.id));

let cleanOnly = false, volume = 0.9, muted = false;
const audios = new Map<string, HTMLAudioElement>();
const lastId: Partial<Record<VoiceOutcome, string>> = {};
let playing: { line: VoiceLine; el: HTMLAudioElement; t0: number } | null = null;

function audio(id: string) {
  let a = audios.get(id);
  if (!a) { a = new Audio(urlOf(id)); a.preload = 'auto'; audios.set(id, a); }
  return a;
}

export const voice = {
  /** skip the lines with swearing */
  setClean(on: boolean) { cleanOnly = on; },
  setVolume(v: number) { volume = Math.max(0, Math.min(1, v)); },
  setMuted(m: boolean) { muted = m; if (m) voice.stop(); },
  /** call from the first touch: starts loading the clips (mobile browsers only play audio after a gesture) */
  unlock() { for (const c of CLIPS) audio(c.id).load(); },
  lines(outcome?: VoiceOutcome) { return CLIPS.filter(c => (!outcome || c.outcomes.includes(outcome)) && (!cleanOnly || c.clean)); },
  /** play a random line for the outcome (never the same one twice running); returns it, or null if there is none */
  speak(outcome: VoiceOutcome): VoiceLine | null {
    const pool = voice.lines(outcome);
    if (!pool.length) return null;
    const choices = pool.length > 1 ? pool.filter(c => c.id !== lastId[outcome]) : pool;
    const line = choices[Math.floor(Math.random() * choices.length)];
    lastId[outcome] = line.id;
    return voice.play(line);
  },
  play(line: VoiceLine): VoiceLine {
    voice.stop();
    const el = audio(line.id);
    el.currentTime = 0; el.volume = volume;
    if (!muted) void el.play().catch(() => { /* not unlocked yet: the face still lip-syncs to the clock */ });
    playing = { line, el, t0: performance.now() / 1000 };
    return line;
  },
  stop() { if (playing) { playing.el.pause(); playing = null; } },
  /** seconds into the current line (audio clock when it is playing), or -1 when silent */
  time(): number {
    if (!playing) return -1;
    const { line, el, t0 } = playing;
    const t = !el.paused && el.currentTime > 0 ? el.currentTime : performance.now() / 1000 - t0;
    if (t > line.duration) { playing = null; return -1; }
    return t;
  },
  /** the current line's mouth opening 0..1 and viseme key, for the face each frame */
  mouth(): { jaw: number; vis: string } | null {
    const t = voice.time(); if (t < 0 || !playing) return null;
    const { jaw, fps, vis } = playing.line;
    const f = t * fps, i = Math.min(jaw.length - 1, Math.floor(f)), k = f - i;
    const j = jaw.length ? jaw[i] * (1 - k) + (jaw[Math.min(jaw.length - 1, i + 1)] ?? 0) * k : 0;
    let v = '_'; for (const [vt, vk] of vis) { if (vt > t) break; v = vk; }
    return { jaw: j, vis: v };
  },
};

/** shorthand: play a line for the outcome; returns { text, duration } (seconds) or null */
export function speak(outcome: VoiceOutcome) { const l = voice.speak(outcome); return l && { text: l.text, duration: l.duration, line: l }; }
