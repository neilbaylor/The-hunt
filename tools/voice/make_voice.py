"""Golfer voice lines -> src/assets/voice/<id>.mp3 + manifest.json (text, outcomes, clean flag, duration, lip-sync).

Speech is synthesised LOCALLY with Kokoro-82M (onnx, generic stock voice `am_michael`; not a clone of anyone):
  pip install kokoro-onnx soundfile
  model files: https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0 (kokoro-v1.0.onnx, voices-v1.0.bin)
  python3 tools/voice/make_voice.py --model <dir with the two files> [--voice am_michael] [--only id1,id2]

Lip-sync per clip (no service needed):
  jaw: mouth opening 0..1 sampled at `fps`, from the clip's smoothed loudness;
  vis: [[t, V], ...] viseme keys for genhead.ts (A E I O U M F C _), from the espeak phonemes of the spoken text,
       spread over the voiced parts of the audio in proportion to typical phoneme lengths.
"""
import argparse, json, os, subprocess, tempfile
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
ap = argparse.ArgumentParser()
ap.add_argument('--model', required=True)
ap.add_argument('--voice', default='am_michael')
ap.add_argument('--lines', default=os.path.join(HERE, 'lines.json'))
ap.add_argument('--out', default=os.path.join(ROOT, 'src/assets/voice'))
ap.add_argument('--only', default='')
ap.add_argument('--fps', type=int, default=30)
ap.add_argument('--kbps', type=int, default=40)
A = ap.parse_args()

from kokoro_onnx import Kokoro
import soundfile as sf
K = Kokoro(os.path.join(A.model, 'kokoro-v1.0.onnx'), os.path.join(A.model, 'voices-v1.0.bin'))
os.makedirs(A.out, exist_ok=True)
L = json.load(open(A.lines)); only = set(filter(None, A.only.split(',')))
mpath = os.path.join(A.out, 'manifest.json')
old = {c['id']: c for c in json.load(open(mpath))['clips']} if os.path.exists(mpath) else {}

# ── phoneme → viseme class and relative length ──
VOW = {'A': 'aɑæʌɐ', 'E': 'eɛəɜɚᵻ', 'I': 'iɪ', 'O': 'oɔɒ', 'U': 'uʊ'}
def classify(ph):
    out = []
    for ch in ph:
        if ch in 'ˈˌːˑ‿ʰ̃':
            if ch == 'ː' and out: out[-1] = (out[-1][0], out[-1][1] * 1.5)
            continue
        if ch in ' ': out.append(('_', 0.6)); continue
        if ch in ',.!?;:—…': out.append(('_', 2.0)); continue
        v = next((k for k, s in VOW.items() if ch in s), None)
        if v: out.append((v, 1.0)); continue
        if ch in 'mbp': out.append(('M', 0.8)); continue
        if ch in 'fv': out.append(('F', 0.8)); continue
        if ch in 'wɹr': out.append(('U' if ch == 'w' else 'C', 0.5)); continue
        if ch in 'j': out.append(('I', 0.4)); continue
        if ch.isalpha() or ch in 'ʃʒθðŋɾʔɡʤʧ': out.append(('C', 0.6)); continue
    # merge runs of the same viseme
    m = []
    for v, w in out:
        if m and m[-1][0] == v: m[-1] = (v, m[-1][1] + w)
        else: m.append((v, w))
    return m

def lipsync(a, sr, text_ph):
    hop = sr // 100; n = len(a) // hop
    rms = np.sqrt(np.array([np.mean(a[i * hop:(i + 1) * hop] ** 2) for i in range(n)]) + 1e-12)
    db = 20 * np.log10(rms / (rms.max() + 1e-9))
    voiced = db > -32
    # jaw at fps from loudness (attack fast, release slower), 0..1
    env = np.clip((db + 40) / 34, 0, 1) ** 1.3
    sm = np.zeros_like(env); s = 0
    for i, e in enumerate(env): s = s + (e - s) * (0.6 if e > s else 0.25); sm[i] = s
    T = len(a) / sr; ts = np.arange(0, T, 1 / A.fps)
    jaw = np.interp(ts, (np.arange(n) + 0.5) / 100, sm)
    # visemes: map cumulative phoneme weight onto cumulative voiced time
    seq = [x for x in classify(text_ph)]
    while seq and seq[0][0] == '_': seq.pop(0)
    while seq and seq[-1][0] == '_': seq.pop()
    vt = np.cumsum(voiced) / 100.0; tot_v = vt[-1] if n else 0
    W = np.cumsum([0] + [w for _, w in seq]); W = W / max(W[-1], 1e-9)
    vis = []
    for (v, _), w0 in zip(seq, W[:-1]):
        target = w0 * tot_v
        i = int(np.searchsorted(vt, target + 1e-6)); t = round(min(i, n) / 100.0, 3)
        if v == '_' and vis and vis[-1][1] == '_': continue
        vis.append([t, v])
    if n: last = np.nonzero(voiced)[0]; vis.append([round((last[-1] + 1) / 100 if len(last) else T, 3), '_'])
    return [round(float(x), 2) for x in jaw], vis

clips = []
for l in L:
    if only and l['id'] not in only:
        if l['id'] in old: clips.append(old[l['id']])
        continue
    say = l.get('say', l['text'])
    a, sr = K.create(say, voice=l.get('voice', A.voice), speed=l.get('speed', 1.0), lang='en-us')
    a = np.asarray(a, np.float32)
    # trim silence (keep 40 ms), normalise to -1 dBFS
    db = 20 * np.log10(np.abs(a) + 1e-9); idx = np.nonzero(db > -40)[0]
    pad = int(0.04 * sr); a = a[max(0, idx[0] - pad):min(len(a), idx[-1] + pad)] if len(idx) else a
    a = a / (np.abs(a).max() + 1e-9) * 0.89
    f = np.linspace(0, 1, int(0.01 * sr)); a[:len(f)] *= f; a[-len(f):] *= f[::-1]
    ph = K.tokenizer.phonemize(say, 'en-us')
    jaw, vis = lipsync(a, sr, ph)
    dst = os.path.join(A.out, l['id'] + '.mp3')
    with tempfile.NamedTemporaryFile(suffix='.wav') as tf:
        sf.write(tf.name, a, sr)
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', tf.name, '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', f'{A.kbps}k',
                        '-map_metadata', '-1', dst], check=True)
    c = {'id': l['id'], 'file': l['id'] + '.mp3', 'text': l['text'], 'outcomes': l['outcomes'], 'clean': l['clean'],
         'duration': round(len(a) / sr, 3), 'fps': A.fps, 'jaw': jaw, 'vis': vis, 'phonemes': ph}
    clips.append(c); print(f"{l['id']:14s} {c['duration']:.2f}s {os.path.getsize(dst) // 1024} KB  {ph}")
json.dump({'voice': f'Kokoro-82M {A.voice} (generic stock voice)', 'clips': clips}, open(mpath, 'w'), indent=0, ensure_ascii=False)
print(mpath, len(clips), 'clips')
