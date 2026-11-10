"""Club shaft direction per frame of the primary (face-on) clip, in the canonical golf frame, fused from two views.
- H observations (club head visible): weak-perspective foreshortening gives the out-of-image component, its sign from
  the labelled depth flag.
- P observations (direction only): in-image direction from the label, out-of-image component interpolated in time.
- Where the face-on view has nothing (club out of frame), the down-the-line clip's shaft at the same swing event is
  used (events matched by name, interpolated between events).
Writes data/<primary>.shaft.json. Usage: python3 -I shaft_fuse.py"""
import json, os, sys, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract
HERE = os.path.dirname(os.path.abspath(__file__)); AN = json.load(open(f'{HERE}/shaft_annot.json'))
def kabsch(A, B):  # rotation R with R @ a ~ b
    A = A - A.mean(0); B = B - B.mean(0); U, S, Vt = np.linalg.svd(A.T @ B); d = np.sign(np.linalg.det(Vt.T @ U.T))
    return Vt.T @ np.diag([1, 1, d]) @ U.T
def observe(clip, W=720):
    d = np.load(f'{HERE}/raw/{clip}.gvhmr.npz', allow_pickle=False); JC, K = d['joints_camera'].astype(float), d['intrinsics']
    J, _, _, _, _ = extract.load(f'{HERE}/raw/{clip}.gvhmr.npz'); a = AN[clip]; sc = W / a['tile_w']; rows = {}
    for f, (hx, hy, px, py, kind, dep) in a['obs'].items():
        f = int(f); hands = (JC[f][20] + JC[f][21]) / 2; s = K[f][0, 0] / hands[2]          # px per metre at the hands
        v = np.array([px - hx, py - hy]) * sc / s; rows[f] = (v, kind, dep, kabsch(JC[f], J[f]))
    L = max(np.linalg.norm(v) for v, k, _, _ in rows.values() if k == 'H') * 1.02
    out = {}
    for f, (v, kind, dep, R) in rows.items():
        if kind == 'H':
            xy = v / L; z = dep * np.sqrt(max(0, 1 - xy @ xy)); out[f] = ('H', R @ np.array([xy[0], xy[1], z]), R)
        else: out[f] = ('P', v / np.linalg.norm(v), R)
    return out, L, J
def unit(v): return v / np.linalg.norm(v)
if __name__ == '__main__':
    prim, sec = 'rory_faceon_clean', 'vanzyl_dtl'
    P = json.load(open(f'{HERE}/data/{prim}.json')); S = json.load(open(f'{HERE}/data/{sec}.json')); n = P['frames']
    obsP, LP, _ = observe(prim); obsS, LS, _ = observe(sec)
    print('visible club length (hands to head), m:', round(LP, 3), round(LS, 3))
    # secondary clip's shaft on the primary's timeline, via the shared events
    ev = [e for e in P['event_names'] if P['events'][e] is not None and S['events'][e] is not None]
    tP = np.array([P['events'][e] for e in ev]); tS = np.array([S['events'][e] for e in ev])
    secKeys = {float(np.interp(f, tS, tP)): d for f, (k, d, _) in obsS.items()}
    known = {float(f): d for f, (k, d, _) in obsP.items() if k == 'H'}; src = {f: 'face-on (head seen)' for f in known}
    for t, d in secKeys.items():
        if min(abs(t - f) for f in known) > 1.6: known[t] = d; src[t] = 'down-the-line clip, same event'
    ks = sorted(known)
    def interp(t):  # slerp-ish between the neighbouring known directions
        if t <= ks[0]: return known[ks[0]]
        if t >= ks[-1]: return known[ks[-1]]
        i = max(j for j in range(len(ks)) if ks[j] <= t); a, b = known[ks[i]], known[ks[i + 1]]; u = (t - ks[i]) / (ks[i + 1] - ks[i])
        om = np.arccos(np.clip(a @ b, -1, 1))
        return a if om < 1e-4 else (np.sin((1 - u) * om) * a + np.sin(u * om) * b) / np.sin(om)
    D = []; how = []
    for f in range(n):
        if f in obsP and obsP[f][0] == 'H': D.append(unit(obsP[f][1])); how.append('face-on (head seen)')
        elif f in obsP:   # direction only: keep the in-image direction, take the depth share from the interpolation
            _, v2, R = obsP[f]; g = R.T @ interp(f); z = np.clip(g[2], -0.97, 0.97)
            hint = AN[prim]['obs'][str(f)][5]
            if hint: z = float(hint)                     # labelled out-of-image share (camera frame, + = away)
            c = np.sqrt(1 - z * z)
            D.append(unit(R @ np.array([v2[0] * c, v2[1] * c, z]))); how.append('face-on direction + depth interpolated')
        else: D.append(unit(interp(f))); how.append('interpolated' if f not in src else src[f])
    D = np.array(D)
    json.dump({'clip': prim, 'frame': P['frame'], 'club_len_seen_m': round(LP, 3), 'shaft_dir': np.round(D, 4).tolist(), 'source': how,
               'secondary_keys': {str(round(t, 2)): np.round(d, 3).tolist() for t, d in secKeys.items()}}, open(f'{HERE}/data/{prim}.shaft.json', 'w'))
    for f in range(n): print(f, np.round(D[f], 2), how[f])
    # events the figure defines by the club (shaft horizontal): refine them from the fused shaft, keep the arm-only ones
    arm = P.get('events_arm') or dict(P['events']); ev2 = dict(arm); y = D[:, 1]
    def cross(lo, hi, up):
        for i in range(int(np.floor(lo)), int(np.ceil(hi))):
            if (up and y[i] < 0 <= y[i + 1]) or (not up and y[i] > 0 >= y[i + 1]): return round(i + (0 - y[i]) / (y[i + 1] - y[i]), 2)
    for k, lo, hi, up in [('MB', arm['BA'], arm['LBA'], True), ('MD', arm['ED'], arm['BI'], False), ('MF', arm['BI'], arm['LF'], True)]:
        c = cross(lo, hi, up)
        if c is not None: ev2[k] = c
    P['events_arm'] = arm; P['events'] = ev2; json.dump(P, open(f'{HERE}/data/{prim}.json', 'w'), separators=(',', ':'))
    print('events by arm angle :', arm); print('events with the club:', ev2)
