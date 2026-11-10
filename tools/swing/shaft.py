"""Estimate the club shaft's 2D direction per frame: a ray search from the hands for the best thin straight line.
Usage: python3 -I shaft.py <video> <gvhmr.npz> <out.json> <sheet.jpg>"""
import sys, json, cv2, numpy as np
vid, npz, out, sheet = sys.argv[1:5]
d = np.load(npz, allow_pickle=False); JC, K = d['joints_camera'], d['intrinsics']
cap = cv2.VideoCapture(vid); fr = []
while True:
    ok, f = cap.read()
    if not ok: break
    fr.append(f)
N = min(len(fr), len(JC)); res = []; tiles = []
def proj(i, P): p = K[i] @ P; return p[:2] / p[2]
for i in range(N):
    f = fr[i]; g = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY).astype(np.float32); g = cv2.GaussianBlur(g, (0, 0), 1.0)
    wl, wr = proj(i, JC[i][20]), proj(i, JC[i][21]); el = proj(i, JC[i][18])
    hands = (wl + wr) / 2 + (wl - el) / max(1, np.linalg.norm(wl - el)) * 0.0
    ppm = np.linalg.norm(proj(i, JC[i][15]) - proj(i, JC[i][0])) / np.linalg.norm(JC[i][15] - JC[i][0])   # px per metre
    L = 1.0 * ppm; r0 = 0.10 * ppm; w = max(2.0, 0.012 * ppm)
    best = (-1, 0, 0); scores = []
    for a in np.arange(0, 360, 1.0):
        dv = np.array([np.cos(np.radians(a)), np.sin(np.radians(a))]); nv = np.array([-dv[1], dv[0]])
        t = np.arange(r0, L, 1.5); P = hands[None] + t[:, None] * dv[None]
        m = w * 1.6 + 2; inb = (P[:, 0] > m) & (P[:, 0] < f.shape[1] - m - 1) & (P[:, 1] > m) & (P[:, 1] < f.shape[0] - m - 1)
        if inb.sum() < 0.35 * len(t): scores.append(0); continue
        P = P[inb]
        s = lambda Q: g[Q[:, 1].round().astype(int), Q[:, 0].round().astype(int)]
        c, l, r = s(P), s(P + nv * w * 1.6), s(P - nv * w * 1.6)
        ridge = np.minimum(np.abs(c - l), np.abs(c - r)) * (np.sign(c - l) == np.sign(c - r))
        # a shaft is a continuous ridge: use the fraction of the ray that is ridge-like, and its strength
        sc = np.mean(ridge > 6) * np.sqrt(np.mean(np.minimum(ridge, 40))) * (len(P) / len(t)) ** 0.5
        scores.append(sc)
        if sc > best[0]: best = (sc, a, len(P) * 1.5)
    sc, a, ln = best; scores = np.array(scores); conf = float(sc / (np.median(scores[scores > 0]) + 1e-6)) if (scores > 0).any() else 0
    res.append({'frame': i, 'angle_deg': float(a), 'conf': round(conf, 2), 'hands': [round(float(v), 1) for v in hands]})
    im = f.copy(); dv = np.array([np.cos(np.radians(a)), np.sin(np.radians(a))])
    cv2.line(im, tuple(int(v) for v in hands + dv * r0), tuple(int(v) for v in hands + dv * L), (0, 255, 255), 2, cv2.LINE_AA)
    cv2.circle(im, tuple(int(v) for v in hands), 5, (0, 0, 255), -1)
    s = 300 / im.shape[0]; im = cv2.resize(im, (int(im.shape[1] * s), 300)); cv2.putText(im, f'{i} c{conf:.1f}', (3, 14), 0, 0.45, (0, 255, 255), 1); tiles.append(im)
json.dump(res, open(out, 'w'))
per = 13; rows = [np.hstack(tiles[k:k + per] + [np.zeros_like(tiles[0])] * (per - len(tiles[k:k + per]))) for k in range(0, len(tiles), per)]
cv2.imwrite(sheet, np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 80])
