"""Side-by-side sheet: reference video frames at each swing event (mirrored for the lefty) over the game's render strip.
Usage: python3 -I compare.py <strip.png from swing-check/strip.mjs> <out.jpg> [clip] [label] [second strip.png]"""
import json, os, sys, cv2, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); strip, out = sys.argv[1], sys.argv[2]
clip = sys.argv[3] if len(sys.argv) > 3 else 'rory_faceon_clean'; label = sys.argv[4] if len(sys.argv) > 4 else 'mocap'
D = json.load(open(f'{HERE}/data/{clip}.json')); names = D['event_names']; n = len(names)
cap = cv2.VideoCapture(f'{HERE}/clips/{clip}.mp4'); fr = []
while True:
    ok, f = cap.read()
    if not ok: break
    fr.append(f)
def tiles(path):
    im = cv2.imread(path)[22:]; w = im.shape[1] // n; return [im[:, i * w:(i + 1) * w] for i in range(n)]
rows = [tiles(strip)] + ([tiles(sys.argv[5])] if len(sys.argv) > 5 else []); labels = [label] + (['hand-keyed'] if len(sys.argv) > 5 else [])
tw, th = rows[0][0].shape[1], rows[0][0].shape[0]; cols = []
for i, k in enumerate(names):
    f = cv2.flip(fr[int(round(D['events'][k]))], 1); s = tw / f.shape[1]; f = cv2.resize(f, (tw, int(f.shape[0] * s)))
    y0 = int(f.shape[0] * 0.02); f = f[y0:y0 + th] if f.shape[0] >= th + y0 else cv2.copyMakeBorder(f, 0, th - f.shape[0], 0, 0, cv2.BORDER_CONSTANT)
    cv2.rectangle(f, (0, 0), (tw, 26), (0, 0, 0), -1); cv2.putText(f, f'{k}  ref (mirrored)', (6, 19), 0, 0.55, (0, 255, 255), 1, cv2.LINE_AA)
    col = [f]
    for r, lab in zip(rows, labels):
        t = r[i].copy(); cv2.rectangle(t, (0, 0), (tw, 26), (0, 0, 0), -1); cv2.putText(t, f'{k}  {lab}', (6, 19), 0, 0.55, (255, 255, 255), 1, cv2.LINE_AA); col.append(t)
    cols.append(np.vstack(col))
half = (n + 1) // 2; a = np.hstack(cols[:half]); b = np.hstack(cols[half:] + [np.zeros_like(cols[0])] * (half - (n - half)))
cv2.imwrite(out, np.vstack([a, b]), [cv2.IMWRITE_JPEG_QUALITY, 86]); print('wrote', out)
