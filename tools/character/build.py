"""
Build a golfer character from the CC0 MakeHuman / MPFB2 base human.

  python3 tools/character/build.py [--mpfb /path/to/mpfb2/src/mpfb/data] [--profile neil]

Needs the MPFB2 data folder (CC0):
  git clone --depth 1 --filter=blob:none --sparse https://github.com/makehumancommunity/mpfb2 /tmp/mh/mpfb2
  cd /tmp/mh/mpfb2 && git sparse-checkout set src/mpfb/data

What it does:
  1. shapes the base mesh with MakeHuman macro targets (male, ~38, lean, tall) and face detail targets
  2. computes the game-engine skeleton joints from the shaped mesh, and per-vertex skin weights
  3. builds clothing (polo, trousers, shoes, glove) and a hair shell as offset shells of the body, so they
     deform exactly with it
  4. bakes a skin texture: the player's photo projected onto the face, matched procedural skin elsewhere
  5. writes src/assets/<profile>/character.bin (+ skin.jpg, eyes.png) for src/golfer/human.ts

Character space: metres, Y up, faces +Z, the character's left is +X, feet on y = 0.
"""
import argparse, collections, gzip, json, math, os, struct, sys
import numpy as np
from PIL import Image, ImageOps, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ap = argparse.ArgumentParser()
ap.add_argument('--mpfb', default='/tmp/mh/mpfb2/src/mpfb/data')
ap.add_argument('--profile', default='neil')
ap.add_argument('--tex', type=int, default=2048)
args = ap.parse_args()
D = args.mpfb
P = json.load(open(os.path.join(os.path.dirname(__file__), f'{args.profile}.json')))
OUT = os.path.join(ROOT, 'src/assets', args.profile)
os.makedirs(OUT, exist_ok=True)

# ───────────────────────── base mesh ─────────────────────────
verts, uvs, faces = [], [], []
group_verts = collections.defaultdict(set)
g = None
for line in open(f'{D}/3dobjs/base.obj'):
    if line.startswith('v '):
        verts.append([float(a) for a in line.split()[1:4]])
    elif line.startswith('vt '):
        uvs.append([float(a) for a in line.split()[1:3]])
    elif line.startswith('g '):
        g = line[2:].strip()
    elif line.startswith('f '):
        pts = [tuple(int(a) - 1 for a in p.split('/')[:2]) for p in line.split()[1:]]
        faces.append((g, pts))
        for vi, _ in pts:
            group_verts[g].add(vi)
V0 = np.array(verts, dtype=np.float64)
UV = np.array(uvs, dtype=np.float64)
NV = len(V0)

def load_target(path):
    d = np.zeros_like(V0)
    with gzip.open(path, 'rt') as f:
        for line in f:
            if not line.strip() or line[0] == '#':
                continue
            a = line.split()
            d[int(a[0])] = [float(a[1]), float(a[2]), float(a[3])]
    return d

def target(rel):
    p = f'{D}/targets/{rel}.target.gz'
    if not os.path.exists(p):
        print('  (missing target)', rel)
        return None
    return load_target(p)

# ───────────────────────── macro shape ─────────────────────────
M = P['macro']
def two(v, lo, hi):  # weights for a two-part slider (0..0.5 → low..avg, 0.5..1 → avg..high)
    if v < 0.5:
        return {lo: 1 - v / 0.5, 'average': v / 0.5}
    return {'average': 1 - (v - 0.5) / 0.5, hi: (v - 0.5) / 0.5}
age = {'young': 1 - (M['age'] - 0.5) / 0.5, 'old': (M['age'] - 0.5) / 0.5} if M['age'] >= 0.5 else {'young': M['age'] / 0.5, 'child': 1 - M['age'] / 0.5}
mus = {('averagemuscle' if k == 'average' else k): w for k, w in two(M['muscle'], 'minmuscle', 'maxmuscle').items()}
wei = {('averageweight' if k == 'average' else k): w for k, w in two(M['weight'], 'minweight', 'maxweight').items()}
V = V0.copy()
total = 0
for a, wa in age.items():
    if wa <= 0: continue
    for m_, wm in mus.items():
        if wm <= 0: continue
        for w_, ww in wei.items():
            if ww <= 0: continue
            base = wa * wm * ww
            t = target(f'macrodetails/universal-male-{a}-{m_}-{w_}')
            if t is not None: V += base * t; total += base
            if M['height'] > 0.5:
                t = target(f'macrodetails/height/male-{a}-{m_}-{w_}-maxheight')
                if t is not None: V += base * (M['height'] - 0.5) / 0.5 * t
            if M['proportions'] > 0.5:
                t = target(f'macrodetails/proportions/male-{a}-{m_}-{w_}-idealproportions')
                if t is not None: V += base * (M['proportions'] - 0.5) / 0.5 * t
    t = target(f'macrodetails/caucasian-male-{a}')
    if t is not None: V += wa * t
print('macro weight sum', round(total, 3))
for rel, w in P['details'].items():
    t = target(rel)
    if t is not None:
        V += w * t

# expression morphs (deltas), applied on top at runtime
morphs = {}
for name, parts in P['expressions'].items():
    d = np.zeros_like(V0)
    for rel, w in parts.items():
        t = target(rel)
        if t is not None:
            d += w * t
    morphs[name] = d

# ───────────────────────── units, height, floor ─────────────────────────
body_idx = np.array(sorted(group_verts['body']))
V *= 0.1
for k in morphs:
    morphs[k] *= 0.1
top, bottom = V[body_idx, 1].max(), V[body_idx, 1].min()
s = (P['heightM'] - 0.012) / (top - bottom)   # skin height (hair adds ~1 cm)
V = (V - [0, bottom, 0]) * s
for k in morphs:
    morphs[k] *= s
print('height scale', round(s, 4), '→', round((V[body_idx, 1].max()), 3), 'm skin top')

# ───────────────────────── fit the face to the player's own 3D landmarks (MediaPipe) ─────────────────────────
from scipy.spatial import cKDTree
from scipy.interpolate import RBFInterpolator
FS = P.get('faceShape'); lm_idx = None
def lm_file(photo, flip): return photo + ('.mirror' if flip else '') + '.lm.json'
def umeyama(B, A):
    """similarity transform taking point set B onto A: returns aligned B"""
    ma, mb = A.mean(0), B.mean(0); A0, B0 = A - ma, B - mb
    U, S, Vt = np.linalg.svd(A0.T @ B0 / len(A))
    d = np.sign(np.linalg.det(U @ Vt)); Dm = np.diag([1, 1, d]); R = U @ Dm @ Vt
    sc = np.trace(np.diag(S) @ Dm) / ((B0 ** 2).sum() / len(B))
    return (sc * (R @ B0.T)).T + ma
if FS:
    mh_lm = json.load(open(os.path.join(os.path.dirname(__file__), 'data', 'mh_landmarks3d.json')))
    MH = np.array([q if q is not None else [0, 0, 0] for q in mh_lm]); ok = np.array([q is not None for q in mh_lm])
    top_y = V[body_idx, 1].max()
    headish = np.array([vi for vi in body_idx if V[vi, 1] > top_y - 0.33])
    dd, jj = cKDTree(V[headish]).query(MH)
    lm_idx = np.where(ok & (dd < 0.012), headish[jj], -1)
    use = lm_idx >= 0
    photo_lms, wts = [], []
    for v in FS['photos']:
        L = json.load(open(lm_file(v['photo'], P['handed'] == 'left')))
        Q = np.array(L["pts"], float); Q = np.c_[Q[:, 0], -Q[:, 1], Q[:, 2]]   # y up; MediaPipe z already points toward the camera here
        photo_lms.append(Q); wts.append(v['weight'])
    # Fit in MakeHuman's own shape space (anatomical sliders), not a free warp: the head stays a plausible human head.
    from scipy.optimize import lsq_linear
    import glob, re
    unit = 0.1 * s   # target files are in MakeHuman decimetres before our height scale
    groups = {}
    for d in FS['dirs']:
        for f in sorted(glob.glob(f'{D}/targets/{d}/*.target.gz')):
            name = os.path.basename(f)[:-10]
            key = re.sub(r'(^|-)(l|r)-', r'\1x-', name).replace('-left-', '-x-').replace('-right-', '-x-')
            groups.setdefault(key, []).append(f)
    names = sorted(groups); cols = []
    LI = lm_idx[use]
    for k in names:
        dsum = np.zeros((len(LI), 3))
        for f in groups[k]: dsum += load_target(f)[LI] * unit
        cols.append(dsum)
    zw = FS['depth']
    def solve(target_pts, cur):
        A = np.stack([np.c_[c[:, 0], c[:, 1], c[:, 2] * zw].ravel() for c in cols], axis=1)
        r = target_pts - cur; bvec = np.c_[r[:, 0], r[:, 1], r[:, 2] * zw].ravel()
        lam = FS['ridge']
        A2 = np.r_[A, np.sqrt(lam) * np.eye(len(names))]; b2 = np.r_[bvec, np.zeros(len(names))]
        return lsq_linear(A2, b2, bounds=(0, FS['maxWeight'])).x
    wsol = np.zeros(len(names))
    for it in range(3):
        cur = V[LI] + sum(w * c for w, c in zip(wsol, cols))
        shapes = [umeyama(q[use], cur) if False else None for q in []]
        tgt = np.average(np.array([umeyama(Qs[use], cur) for Qs in photo_lms]), axis=0, weights=wts)
        before = np.sqrt(((tgt - cur) ** 2)[:, :2].sum(1).mean()) * 1000
        wsol = solve(tgt, V[LI])
        after = np.sqrt((((V[LI] + sum(w * c for w, c in zip(wsol, cols))) - tgt) ** 2)[:, :2].sum(1).mean()) * 1000
        print(f'face fit iter {it}: landmark rms (x,y) {before:.1f} mm -> {after:.1f} mm')
    top = sorted(zip(wsol, names), reverse=True)[:14]
    print('  sliders:', ', '.join(f'{n} {w:.2f}' for w, n in top if w > 0.02))
    for w, k in zip(wsol, names):
        if w > 1e-3:
            for f in groups[k]: V += w * unit * load_target(f)

# ───────────────────────── skeleton ─────────────────────────
rig = json.load(open(f'{D}/rigs/standard/rig.game_engine.json'))
def cube(name):
    return V[sorted(group_verts[name])].mean(0)
def end(spec):
    if spec['strategy'] == 'CUBE':
        return cube(spec['cube_name'])
    return V[spec['vertex_indices']].mean(0)
heads = {b: end(d['head']) for b, d in rig.items()}
tails = {b: end(d['tail']) for b, d in rig.items()}

# our skeleton: 18 driver bones in the order the rig code expects, then hands, toes and fingers
DRIVERS = ['Root', 'pelvis', 'spine_01', 'spine_02', 'neck_01', 'head',
           'clavicle_l', 'upperarm_l', 'lowerarm_l', 'clavicle_r', 'upperarm_r', 'lowerarm_r',
           'thigh_l', 'calf_l', 'foot_l', 'thigh_r', 'calf_r', 'foot_r']
FINGERS = [f'{f}_0{i}_{s}' for s in 'lr' for f in ['thumb', 'index', 'middle', 'ring', 'pinky'] for i in (1, 2, 3)]
EXTRA = ['hand_l', 'hand_r', 'ball_l', 'ball_r'] + FINGERS
BONES = DRIVERS + EXTRA
MERGE = {'spine_03': 'spine_02'}            # spine_03's skin goes to the chest bone
PARENT_OVERRIDE = {'neck_01': 'spine_02', 'clavicle_l': 'spine_02', 'clavicle_r': 'spine_02'}
parents = []
for b in BONES:
    p = PARENT_OVERRIDE.get(b, rig[b]['parent'])
    parents.append(BONES.index(p) if p else -1)
joint = [heads[b] for b in BONES]
tail = [tails[b] for b in BONES]
tail[BONES.index('spine_02')] = heads['neck_01']   # chest runs to the neck once spine_03 is merged
tail[BONES.index('Root')] = heads['pelvis']

# ───────────────────────── skin weights ─────────────────────────
W = json.load(open(f'{D}/rigs/standard/weights.game_engine.json'))['weights']
vw = collections.defaultdict(dict)
for b, lst in W.items():
    b2 = MERGE.get(b, b)
    if b2 not in BONES:
        continue
    bi = BONES.index(b2)
    for vi, w in lst:
        vw[vi][bi] = vw[vi].get(bi, 0) + w
def top4(vi):
    items = sorted(vw[vi].items(), key=lambda x: -x[1])[:4] or [(0, 1.0)]
    tot = sum(w for _, w in items)
    items = [(b, w / tot) for b, w in items] + [(0, 0.0)] * (4 - len(items))
    return items

# ───────────────────────── mesh assembly helpers ─────────────────────────
def face_list(groups):
    return [pts for gname, pts in faces if gname in groups]

def build_mesh(face_pts, positions, normal_out=0.0, normals=None, keep=None, extra_offset=None):
    """split by (vertex, uv) pairs, triangulate. Returns dict of arrays + source vertex ids."""
    key_to_new, src, uvi, tris = {}, [], [], []
    for pts in face_pts:
        if keep is not None and not all(keep[vi] for vi, _ in pts):
            continue
        ids = []
        for vi, ti in pts:
            k = (vi, ti)
            if k not in key_to_new:
                key_to_new[k] = len(src); src.append(vi); uvi.append(ti)
            ids.append(key_to_new[k])
        for i in range(1, len(ids) - 1):
            tris.append((ids[0], ids[i], ids[i + 1]))
    src = np.array(src); uvi = np.array(uvi)
    pos = positions[src].copy()
    if normals is not None and (normal_out or extra_offset is not None):
        off = extra_offset[src] if extra_offset is not None else normal_out
        pos += normals[src] * np.reshape(off, (-1, 1))
    return {'src': src, 'pos': pos, 'uv': UV[uvi], 'tris': np.array(tris, dtype=np.uint32)}

def vertex_normals(positions, face_pts):
    n = np.zeros_like(positions)
    for pts in face_pts:
        ids = [vi for vi, _ in pts]
        for i in range(1, len(ids) - 1):
            a, b, c = positions[ids[0]], positions[ids[i]], positions[ids[i + 1]]
            fn = np.cross(b - a, c - a)
            for j in (ids[0], ids[i], ids[i + 1]):
                n[j] += fn
    l = np.linalg.norm(n, axis=1, keepdims=True); l[l == 0] = 1
    return n / l

body_faces = face_list({'body'})
N = vertex_normals(V, body_faces)
# make sure normals point out of the body (MakeHuman winds faces counter-clockwise, so this is a safety check)
if np.mean(np.sum(N[body_idx] * (V[body_idx] - V[body_idx].mean(0)), axis=1)) < 0:
    N = -N

def wsum(vi, names):
    return sum(vw[vi].get(BONES.index(n), 0) for n in names if n in BONES)

# region tests on body vertices
pelvis_y = joint[BONES.index('pelvis')][1]
neck_y = joint[BONES.index('neck_01')][1]
ankle_y = {s: joint[BONES.index(f'foot_{s}')][1] for s in 'lr'}
def along(vi, a, b):  # 0 at bone a's head, 1 at b's head
    pa, pb = joint[BONES.index(a)], joint[BONES.index(b)]
    d = pb - pa
    return float(np.dot(V[vi] - pa, d) / np.dot(d, d))

C = P['clothes']
belt_y = pelvis_y + C['beltAbovePelvis']
shirt = np.zeros(NV, bool); pants = np.zeros(NV, bool); shoes = np.zeros(NV, bool); glove = np.zeros(NV, bool)
shirt_off = np.zeros(NV); pants_off = np.zeros(NV); shoe_off = np.zeros(NV)
for vi in body_idx:
    y = V[vi, 1]
    torso = wsum(vi, ['pelvis', 'spine_01', 'spine_02', 'clavicle_l', 'clavicle_r', 'upperarm_l', 'upperarm_r', 'neck_01'])
    arm_l, arm_r = wsum(vi, ['upperarm_l', 'lowerarm_l', 'hand_l']), wsum(vi, ['upperarm_r', 'lowerarm_r', 'hand_r'])
    legs = wsum(vi, ['thigh_l', 'thigh_r', 'calf_l', 'calf_r', 'pelvis'])
    feet = wsum(vi, ['foot_l', 'foot_r', 'ball_l', 'ball_r'])
    neckw = vw[vi].get(BONES.index('neck_01'), 0) + vw[vi].get(BONES.index('head'), 0)
    # shirt: torso and upper arms (short sleeves), from the belt up to the collar
    shirt_lo = belt_y - (C.get('untuckedDrop', 0.0) if C.get('untucked') else 0.035)
    if y > shirt_lo and neckw < 0.5 and y < neck_y + 0.01:
        sleeve_ok = True
        if arm_l > 0.5: sleeve_ok = along(vi, 'upperarm_l', 'lowerarm_l') < C['sleeve']
        if arm_r > 0.5: sleeve_ok = along(vi, 'upperarm_r', 'lowerarm_r') < C['sleeve']
        # (below the waist the untucked shirt also covers the thigh-weighted hips, so its hem goes level all round)
        if sleeve_ok and (torso > 0.3 or arm_l > 0.3 or arm_r > 0.3 or (legs > 0.3 and y < belt_y + 0.03 and max(arm_l, arm_r) < 0.3)):
            shirt[vi] = True
            loose = 1 - min(1, abs(y - (pelvis_y + 0.2)) / 0.3)
            tuck = min(1.0, max(0.0, (y - (belt_y - 0.04)) / 0.08))  # tucked in: hugs the body at the waistband
            if C.get('untucked'):
                tuck = 1.0
                if y < pelvis_y + 0.2: loose = 1.0 + C.get('hemFlare', 0.6) * min(1.0, (pelvis_y + 0.2 - y) / 0.15)  # hangs straight and boxy below the waist
            shirt_off[vi] = C['shirtGap'] * (0.5 + 0.5 * tuck) + C['shirtLoose'] * loose * tuck
    # trousers: belt line down to just above the ankle
    hem_y = (joint[BONES.index('calf_l')][1] + C['shortsAboveKnee']) if C.get('shorts') else min(ankle_y.values()) - 0.012
    if y < belt_y + 0.004 and feet < 0.85 and legs > 0.3 and y > hem_y:
        pants[vi] = True
        knee = min(abs(y - joint[BONES.index('calf_l')][1]), 0.3)
        pants_off[vi] = C['pantsGap'] + C['pantsLoose'] * (0.6 + 0.4 * (1 - knee / 0.3)) * (1.2 if y < joint[BONES.index('calf_l')][1] else 1)
        if y > belt_y - 0.06: pants_off[vi] = max(pants_off[vi], 0.013)  # waistband over the tucked shirt
    # shoes
    if feet > 0.3 or (y < min(ankle_y.values()) + 0.06 and legs > 0.2):
        if y < min(ankle_y.values()) + 0.07:
            shoes[vi] = True
            shoe_off[vi] = C['shoeGap'] + (0.008 if V[vi, 1] < 0.02 else 0)
    # glove on the lead hand (the rig's left; a left-hander is drawn mirrored)
    if wsum(vi, ['hand_l'] + [f for f in FINGERS if f.endswith('_l')]) > 0.5:
        glove[vi] = True

# smooth the offsets so the shells don't wrinkle at region edges
def smooth_field(field, mask, it=6):
    nb = collections.defaultdict(set)
    for pts in body_faces:
        ids = [vi for vi, _ in pts]
        for a in ids:
            for b in ids:
                if a != b: nb[a].add(b)
    f = field.copy()
    for _ in range(it):
        g2 = f.copy()
        for vi in np.nonzero(mask)[0]:
            ns = [n for n in nb[vi] if mask[n]]
            if ns: g2[vi] = 0.5 * f[vi] + 0.5 * np.mean(f[ns])
        f = g2
    return f, nb
shirt_off, NB = smooth_field(shirt_off, shirt)
pants_off, _ = smooth_field(pants_off, pants)

# smoothed positions for shells: fabric doesn't follow every muscle
def smooth_positions(mask, it, amount=0.5):
    # Taubin smoothing (shrink then inflate) so the fabric smooths out without losing volume
    P2 = V.copy()
    ids = np.nonzero(mask)[0]
    nbs = {vi: [n for n in NB[vi] if mask[n]] for vi in ids}
    for i in range(it * 2):
        lam = amount if i % 2 == 0 else -amount * 1.06
        Q = P2.copy()
        for vi in ids:
            ns = nbs[vi]
            if ns: Q[vi] = P2[vi] + lam * (P2[ns].mean(0) - P2[vi])
        P2 = Q
    return P2
Vshirt = smooth_positions(shirt, 3)
Vpants = smooth_positions(pants, 3)

# relaxed fit: the polo drapes off the chest and shoulder blades and hangs straight down instead of
# shrink-wrapping into the waist, the small of the back and under the pecs; the short sleeves stand off the arm
if C.get('hang', 0) > 0:
    Vs = Vshirt + N * shirt_off[:, None]
    ids = np.nonzero(shirt)[0]
    armw_s = np.array([wsum(vi, ['upperarm_l', 'upperarm_r', 'lowerarm_l', 'lowerarm_r']) for vi in ids])
    tors = ids[armw_s < 0.3]
    chest_y = float(joint[BONES.index('upperarm_l')][1]) - C.get('hangFrom', 0.1)
    band = Vs[tors][np.abs(Vs[tors, 1] - chest_y) < 0.03]
    zc = float((band[:, 2].max() + band[:, 2].min()) / 2)
    th = np.arctan2(Vs[tors, 0], Vs[tors, 2] - zc); rr = np.hypot(Vs[tors, 0], Vs[tors, 2] - zc); yy = Vs[tors, 1]
    NBIN = 90; b = ((th + math.pi) / (2 * math.pi) * NBIN).astype(int) % NBIN
    delta = np.zeros(NV)
    for k in range(NBIN):
        sel = np.nonzero((b == k) | (b == (k + 1) % NBIN) | (b == (k - 1) % NBIN))[0]   # this bin and its neighbours
        own = sel[b[sel] == k]
        if not len(own): continue
        o = np.argsort(-yy[sel]); ys, rs = yy[sel][o], rr[sel][o]
        rs = np.where(ys > chest_y + 0.03, 0, rs); cm = np.maximum.accumulate(rs)   # running max from the chest down
        for i in own:
            if yy[i] > chest_y: continue
            j = np.searchsorted(-ys, -yy[i], side='right') - 1
            rh = cm[max(j, 0)]
            w = min(1.0, (chest_y - yy[i]) / 0.1); w = w * w * (3 - 2 * w) * C['hang']
            delta[tors[i]] = min(C.get('hangMax', 0.02), w * max(0.0, rh - rr[i]))
    delta, _ = smooth_field(delta, shirt, 8)
    for i, vi in enumerate(tors):
        if delta[vi] <= 0: continue
        d = np.array([Vs[vi, 0], 0.0, Vs[vi, 2] - zc]); d /= max(np.linalg.norm(d), 1e-6)
        Vs[vi] += d * delta[vi]
    # sleeves: a rounder, roomier tube that stands off the upper arm towards the hem
    for sfx in 'lr':
        sh_j = joint[BONES.index(f'upperarm_{sfx}')]; el = joint[BONES.index(f'lowerarm_{sfx}')]
        ax = el - sh_j; L2 = float(np.dot(ax, ax))
        arm = [vi for vi in ids if wsum(vi, [f'upperarm_{sfx}', f'lowerarm_{sfx}']) > 0.5]
        tt = np.array([np.dot(Vs[vi] - sh_j, ax) / L2 for vi in arm])
        cc = sh_j + tt[:, None] * ax; rv = Vs[arm] - cc; rl = np.linalg.norm(rv, axis=1)
        rmax = np.array([rl[np.abs(tt - t) < 0.06].max() for t in tt])
        bl = np.clip((tt - 0.12) / 0.3, 0, 1); bl = bl * bl * (3 - 2 * bl)
        want = rl + bl * (C.get('sleeveEase', 0.008) + 0.7 * (rmax - rl))
        Vs[arm] = cc + rv / np.maximum(rl, 1e-6)[:, None] * want[:, None]
    Vshirt = Vs; shirt_off = np.zeros(NV)

# clean, straight hems: the mask's edge follows the body's triangles and comes out jagged, so move the
# boundary vertices onto the hem lines (bottom: a level line; sleeves: square to the arm)
_lo = belt_y - (C.get('untuckedDrop', 0.0) if C.get('untucked') else 0.035)
_bd = [vi for vi in np.nonzero(shirt)[0] if any(not shirt[n] for n in NB[vi])]
for vi in _bd:
    arm = None
    for sfx in 'lr':
        if wsum(vi, [f'upperarm_{sfx}', f'lowerarm_{sfx}', f'hand_{sfx}']) > 0.5: arm = sfx
    if arm:
        a0, a1 = joint[BONES.index(f'upperarm_{arm}')], joint[BONES.index(f'lowerarm_{arm}')]; ax = a1 - a0
        t = float(np.dot(Vshirt[vi] - a0, ax) / np.dot(ax, ax))
        if abs(t - C['sleeve']) < 0.12: Vshirt[vi] = Vshirt[vi] - ax * (t - C['sleeve'])
    elif Vshirt[vi, 1] < _lo + 0.06:
        Vshirt[vi, 1] = _lo

# the untucked shirt hangs over the shorts' waistband: keep it clear of the shorts everywhere they overlap
if C.get('untucked'):
    from scipy.spatial import cKDTree as _KD
    pid = np.nonzero(pants)[0]; Pp = Vpants[pid] + N[pid] * pants_off[pid][:, None]
    kd = _KD(Pp)
    for vi in np.nonzero(shirt)[0]:
        if Vshirt[vi, 1] > belt_y + 0.04: continue
        sp = Vshirt[vi] + N[vi] * shirt_off[vi]
        d, j = kd.query(sp)
        if d > 0.05: continue
        pn = N[pid[j]].copy(); pn[1] = 0; ln = np.linalg.norm(pn)
        if ln < 0.3: continue
        pn /= ln; gap = float(np.dot(sp - Pp[j], pn))      # pushed out sideways only, never down
        if gap < C.get('overPants', 0.008): Vshirt[vi] = Vshirt[vi] + pn * (C.get('overPants', 0.008) - gap)
meshes = {}
# the feet are hidden inside the shoes: drop them from the skin so they never poke through
feet_hidden = np.zeros(NV, bool)
for vi in body_idx:
    if V[vi, 1] < min(ankle_y.values()) + C.get('footHide', 0.03) and wsum(vi, ['foot_l', 'foot_r', 'ball_l', 'ball_r', 'calf_l', 'calf_r']) > 0.5: feet_hidden[vi] = True
meshes['skin'] = build_mesh(body_faces, V, keep=~feet_hidden)
meshes['shirt'] = build_mesh(body_faces, Vshirt, normals=N, keep=shirt, extra_offset=shirt_off)
meshes['pants'] = build_mesh(body_faces, Vpants, normals=N, keep=pants, extra_offset=pants_off)
meshes['glove'] = build_mesh(body_faces, V, normals=N, keep=glove, normal_out=0.0012)
if C.get('socks'):
    socks = np.zeros(NV, bool)
    for vi in body_idx:
        if min(ankle_y.values()) - 0.02 < V[vi, 1] < min(ankle_y.values()) + C['socks'] and wsum(vi, ['calf_l', 'calf_r', 'foot_l', 'foot_r']) > 0.5: socks[vi] = True
    meshes['socks'] = build_mesh(body_faces, V, normals=N, keep=socks, normal_out=0.0015)
meshes['teeth'] = build_mesh(face_list({'helper-upper-teeth', 'helper-lower-teeth', 'helper-tongue'}), V)

# ───────────────────────── cloth detail fields + ambient occlusion ─────────────────────────
from scipy.spatial import cKDTree
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra

def mesh_graph(m):
    t = m['tris']; P_ = m['pos']
    e = np.vstack([t[:, [0, 1]], t[:, [1, 2]], t[:, [2, 0]]])
    w = np.linalg.norm(P_[e[:, 0]] - P_[e[:, 1]], axis=1)
    n = len(P_)
    G = coo_matrix((np.r_[w, w], (np.r_[e[:, 0], e[:, 1]], np.r_[e[:, 1], e[:, 0]])), shape=(n, n)).tocsr()
    return G, e
def weld_ids(P_):
    # uv seams split vertices: map each to a representative at the same position
    key = np.round(P_ * 1e5).astype(np.int64)
    _, rep, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    return rep[inv.ravel()]
def boundary_vertices(m):
    t = m['tris']; rep = weld_ids(m['pos'])
    e = np.sort(np.vstack([rep[t[:, [0, 1]]], rep[t[:, [1, 2]]], rep[t[:, [2, 0]]]]), axis=1)
    u, c = np.unique(e, axis=0, return_counts=True)
    b = set(u[c == 1].ravel().tolist())
    return np.array([i for i in range(len(rep)) if rep[i] in b])
def geodesic_from(m, seeds, limit=0.3):
    if len(seeds) == 0: return np.full(len(m['pos']), 9.0)
    G, _ = mesh_graph(m)
    # tie split (uv-seam) duplicates together with zero-length edges
    rep = weld_ids(m['pos']); n = len(rep)
    extra = coo_matrix((np.full(n, 1e-6), (np.arange(n), rep)), shape=(n, n))
    G = (G + extra + extra.T).tocsr()
    d = dijkstra(G, directed=False, indices=np.unique(seeds), min_only=True, limit=limit)
    d[~np.isfinite(d)] = 9.0
    return d

def bake_ao(m, cloud_pts, cloud_n, radius=0.09):
    tree = cKDTree(cloud_pts)
    P_ = m['pos']; Nn = vertex_normals_tri(m)
    ao = np.ones(len(P_), np.float32)
    nbrs = tree.query_ball_point(P_ + Nn * 0.004, radius)
    for i, lst in enumerate(nbrs):
        if not lst: continue
        q = cloud_pts[lst] - (P_[i] + Nn[i] * 0.004)
        dist = np.linalg.norm(q, axis=1); ok = dist > 0.008
        if not ok.any(): continue
        q, dist = q[ok], dist[ok]
        cosv = (q @ Nn[i]) / dist
        facing = np.clip(-(cloud_n[lst][ok] * q).sum(1) / dist, 0, 1) * 0.5 + 0.5
        occ = np.sum(np.clip(cosv, 0, 1) * (1 - dist / radius) ** 2 * facing)
        ao[i] = np.exp(-occ * 0.055)
    return ao
def vertex_normals_tri(m):
    P_, t = m['pos'], m['tris']
    fn = np.cross(P_[t[:, 1]] - P_[t[:, 0]], P_[t[:, 2]] - P_[t[:, 0]])
    n = np.zeros_like(P_)
    for k in range(3): np.add.at(n, t[:, k], fn)
    rep = weld_ids(P_); acc = np.zeros_like(n); np.add.at(acc, rep, n); n = acc[rep]
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)

print('baking cloth fields + AO…')
cloud = [meshes[k]['pos'] for k in ('skin', 'shirt', 'pants')]
cloud_n = [vertex_normals_tri(meshes[k]) for k in ('skin', 'shirt', 'pants')]
CP, CN = np.vstack(cloud), np.vstack(cloud_n)
# subsample the cloud for speed
sel = np.arange(0, len(CP), 2); CP, CN = CP[sel], CN[sel]
for k in [k for k in ('skin', 'shirt', 'pants', 'glove', 'socks') if k in meshes]:
    meshes[k]['ao'] = bake_ao(meshes[k], CP, CN)
    print('  ao', k, round(float(meshes[k]['ao'].min()), 2), round(float(meshes[k]['ao'].mean()), 3))

def leg_angles(m):
    # angle round each leg's hip→ankle axis (0 = front), the radius, and whether the point is on a leg
    P_ = m['pos']; th = np.full(len(P_), np.nan); rr = np.zeros(len(P_)); tt = np.zeros(len(P_))
    for sfx in 'lr':
        hip = joint[BONES.index(f'thigh_{sfx}')]; ank = joint[BONES.index(f'foot_{sfx}')]
        ax = ank - hip; L2 = float(ax @ ax); side = 1 if sfx == 'l' else -1
        onleg = (np.sign(P_[:, 0]) == side) & (P_[:, 1] < hip[1] - 0.05)
        t = np.clip(((P_ - hip) @ ax) / L2, 0, 1); c = hip + t[:, None] * ax
        d = P_ - c
        a = np.degrees(np.arctan2(d[:, 0] * side, d[:, 2]))  # + = toward the outside
        th[onleg] = a[onleg]; rr[onleg] = np.linalg.norm(d[onleg], axis=1); tt[onleg] = t[onleg]
    return th, rr, tt

# shirt: distance to hems (bottom, sleeves, collar opening) and to the seams (sides, armholes)
m = meshes['shirt']; P_ = m['pos']
edge = geodesic_from(m, boundary_vertices(m))
src = m['src']
armw = np.array([wsum(vi, ['upperarm_l', 'upperarm_r', 'lowerarm_l', 'lowerarm_r']) for vi in src])
torso_c = np.array([0.0, 0.0, float(np.median(P_[:, 2]))])
theta = np.degrees(np.arctan2(P_[:, 0], P_[:, 2] - torso_c[2]))
side_seed = np.nonzero((armw < 0.2) & (np.abs(np.abs(theta) - 90) < 5))[0]
arm_seed = np.nonzero(np.abs(armw - 0.5) < 0.06)[0]
seam = np.minimum(geodesic_from(m, side_seed, 0.1), geodesic_from(m, arm_seed, 0.1))
m['cloth'] = np.c_[edge, seam, np.full(len(P_), 9.0), m['ao']].astype(np.float32)
# pants: hems (waistband + leg hems), side seams / inseam, front and back creases
m = meshes['pants']; P_ = m['pos']
edge = geodesic_from(m, boundary_vertices(m))
th, rr, tt = leg_angles(m)
seamd = np.where(np.isnan(th), 9.0, np.radians(np.abs(np.abs(np.nan_to_num(th)) - 90)) * rr)
crease = np.where(np.isnan(th), 9.0, np.radians(np.minimum(np.abs(np.nan_to_num(th)), 180 - np.abs(np.nan_to_num(th)))) * rr)
crease = np.where(np.nan_to_num(th) * 0 + (np.abs(np.nan_to_num(th)) > 90), crease + 0.02, crease)  # back crease softer
m['cloth'] = np.c_[edge, seamd, crease, m['ao']].astype(np.float32)
m['legT'] = tt.astype(np.float32)
meshes['skin']['cloth'] = np.c_[np.full(len(meshes['skin']['pos']), 9.0), np.full(len(meshes['skin']['pos']), 9.0), np.full(len(meshes['skin']['pos']), 9.0), meshes['skin']['ao']].astype(np.float32)
if 'socks' in meshes: meshes['socks']['cloth'] = np.c_[geodesic_from(meshes['socks'], boundary_vertices(meshes['socks'])), np.full(len(meshes['socks']['pos']), 9.0), np.full(len(meshes['socks']['pos']), 9.0), meshes['socks']['ao']].astype(np.float32)
meshes['glove']['cloth'] = np.c_[geodesic_from(meshes['glove'], boundary_vertices(meshes['glove'])), np.full(len(meshes['glove']['pos']), 9.0), np.full(len(meshes['glove']['pos']), 9.0), meshes['glove']['ao']].astype(np.float32)

# ───────────────────────── hair shell + head measurements ─────────────────────────
head_bi = BONES.index('head')
head_v = np.array([vi for vi in body_idx if vw[vi].get(head_bi, 0) > 0.6])
hc = V[head_v].mean(0)
eye_c = (cube('joint-l-eye') + cube('joint-r-eye')) / 2
# the cranium's centre (for the hairline): above the eyes, set back from them
cran = V[[vi for vi in head_v if V[vi, 1] > eye_c[1]]]
hcr = np.array([0.0, (cran[:, 1].min() + cran[:, 1].max()) / 2 - 0.01, (cran[:, 2].min() + cran[:, 2].max()) / 2])
print('head centre', hc.round(3), 'cranium centre', hcr.round(3), 'eyes', eye_c.round(3))
def hair_mask(p):
    d = p - hcr
    az = math.atan2(d[0], d[2]); el = math.atan2(d[1], math.hypot(d[0], d[2]))
    a = abs(az)
    H = P['hair']
    keys = [tuple(k) for k in H['keys']]
    for i in range(1, len(keys)):
        if a <= keys[i][0]:
            (a0, e0), (a1, e1) = keys[i - 1], keys[i]
            t = (a - a0) / (a1 - a0); t = t * t * (3 - 2 * t)
            e = e0 + (e1 - e0) * t
            break
    return el - e, el

def crown_thin(d):
    # a small thinning spot at the crown (scalp shows through)
    cdir = np.array([0.0, math.sin(1.2), -math.cos(1.2)])
    dn = d / np.maximum(np.linalg.norm(d, axis=-1, keepdims=True), 1e-9)
    ang = np.arccos(np.clip(dn @ cdir, -1, 1))
    return np.clip((ang - 0.2) / 0.16, 0, 1)  # 0 at the centre of the spot, 1 outside
def hair_mask_v(p):
    d = p - hcr
    a = np.abs(np.arctan2(d[:, 0], d[:, 2])); el = np.arctan2(d[:, 1], np.hypot(d[:, 0], d[:, 2]))
    H = P['hair']
    ka = [k[0] for k in H['keys']]
    ke = [k[1] for k in H['keys']]
    return el - np.interp(a, ka, ke)
hm = np.zeros(NV); hthick = np.zeros(NV)
for vi in head_v:
    m_, el = hair_mask(V[vi])
    mm = min(1, max(0, (m_ + 0.06) / 0.16))
    mm *= 0.3 + 0.7 * float(crown_thin(V[vi] - hcr))
    hm[vi] = mm
    top = min(1, max(0, (el - 0.25) / 0.9))
    hthick[vi] = (0.0025 + P['hair']['volume'] * (0.4 + 0.6 * top)) * (mm ** 0.5) + 0.0008
keep_hair = np.zeros(NV, bool); keep_hair[head_v] = True
hair = build_mesh(body_faces, V, normals=N, keep=keep_hair, extra_offset=hthick)
hair['mask'] = hm[hair['src']]
meshes['hair'] = hair

# a ring round the head at visor height, for fitting hats
band_y = eye_c[1] + P['visorAboveEyes']
ring = V[[vi for vi in body_idx if abs(V[vi, 1] - band_y) < 0.006 and np.linalg.norm(V[vi] - hc) < 0.16]]
print('visor ring', len(ring), 'z', ring[:, 2].min().round(3), ring[:, 2].max().round(3), 'x', ring[:, 0].min().round(3), ring[:, 0].max().round(3))
# radius of the outer surface (hair shell or skin) round the head along the band, 64 angles; the band tilts lower at the back
hp_all = np.vstack([hair['pos'], V[head_v]])
vc = np.array([hc[0], band_y, (ring[:, 2].max() + ring[:, 2].min()) / 2])
prof = []
for i in range(64):
    a = -math.pi + i / 64 * 2 * math.pi
    back = max(0.0, -math.cos(a)); front = max(0.0, math.cos(a))
    yb = band_y - 0.006 * front - 0.024 * back
    d = hp_all - vc
    near = np.abs(hp_all[:, 1] - yb) < 0.016
    ang = np.arctan2(d[:, 0], d[:, 2])
    sel = near & (np.abs(((ang - a + math.pi) % (2 * math.pi)) - math.pi) < 0.07)
    prof.append(float(np.hypot(d[sel, 0], d[sel, 2]).max()) if sel.any() else None)
for i in range(64):  # fill gaps
    if prof[i] is None: prof[i] = next(prof[(i + k) % 64] for k in range(1, 64) if prof[(i + k) % 64] is not None)
# a band is taut: take the max over neighbours, then smooth
prof = [max(prof[(i + k) % 64] for k in (-2, -1, 0, 1, 2)) for i in range(64)]
prof = [sum(prof[(i + k) % 64] for k in (-1, 0, 1)) / 3 for i in range(64)]
visor = {'profile': prof, 'center': [float(hc[0]), float(band_y), float((ring[:, 2].max() + ring[:, 2].min()) / 2)],
         'rx': float((ring[:, 0].max() - ring[:, 0].min()) / 2 + 0.0115),
         'rz': float((ring[:, 2].max() - ring[:, 2].min()) / 2 + 0.0125)}

# ───────────────────────── measurements for collar, belt, shoes ─────────────────────────
def boundary_loop(mesh, ypred):
    from collections import Counter
    t = mesh['tris']; cnt = Counter()
    for a, b, c in t:
        for e in ((a, b), (b, c), (c, a)):
            cnt[tuple(sorted(e))] += 1
    # boundary edges by source vertex (uv seams split vertices, so compare by position)
    pts = [mesh['pos'][i] for e, n in cnt.items() if n == 1 for i in e if ypred(mesh['pos'][i])]
    return np.array(pts)
neck_c = joint[BONES.index('neck_01')]
coll = boundary_loop(meshes['shirt'], lambda q: q[1] > neck_y - 0.09 and abs(q[0]) < 0.12)
ang = np.arctan2(coll[:, 0] - neck_c[0], coll[:, 2] - neck_c[2])
order = np.argsort(ang); coll = coll[order]; ang = ang[order]
# resample to 48 points round the neck
samples = []
for a in np.linspace(-math.pi, math.pi, 48, endpoint=False):
    d = np.abs(((ang - a + math.pi) % (2 * math.pi)) - math.pi)
    w = np.exp(-(d / 0.12) ** 2); samples.append((coll * w[:, None]).sum(0) / w.sum())
collar = [list(map(float, q)) for q in samples]
waist = V[[vi for vi in body_idx if abs(V[vi, 1] - belt_y) < 0.006 and wsum(vi, ['pelvis', 'spine_01', 'thigh_l', 'thigh_r']) > 0.6]]
belt = {'y': float(belt_y), 'cx': float(waist[:, 0].mean()), 'cz': float((waist[:, 2].max() + waist[:, 2].min()) / 2),
        'rx': float((waist[:, 0].max() - waist[:, 0].min()) / 2), 'rz': float((waist[:, 2].max() - waist[:, 2].min()) / 2)}
feet = {}
for sfx in 'lr':
    fv = V[[vi for vi in body_idx if wsum(vi, [f'foot_{sfx}', f'ball_{sfx}']) > 0.5 and V[vi, 1] < 0.12]]
    feet[sfx] = {'heelZ': float(fv[:, 2].min()), 'toeZ': float(fv[:, 2].max()), 'x': float(fv[:, 0].mean()),
                 'halfW': float((np.percentile(fv[:, 0], 98) - np.percentile(fv[:, 0], 2)) / 2), 'ankleY': float(joint[BONES.index(f'foot_{sfx}')][1])}
print('belt', {k: round(v, 3) for k, v in belt.items()}, 'feet', {k: {a: round(b, 3) for a, b in v.items()} for k, v in feet.items()})

# ───────────────────────── skin texture ─────────────────────────
T = args.tex
def raster(mesh, fn, size, bg=(0, 0, 0)):
    """bake fn(pos, nrm) -> rgb over the mesh's UV layout"""
    pos, uv, tris = mesh['pos'], mesh['uv'], mesh['tris']
    nrm = N[mesh['src']] if mesh is meshes['skin'] else None
    P_all, N_all, X_all, Y_all = [], [], [], []
    for a, b, c in tris:
        ua, ub, uc = uv[a] * size, uv[b] * size, uv[c] * size
        x0, x1 = int(max(0, math.floor(min(ua[0], ub[0], uc[0])))), int(min(size - 1, math.ceil(max(ua[0], ub[0], uc[0]))))
        y0, y1 = int(max(0, math.floor(min(ua[1], ub[1], uc[1])))), int(min(size - 1, math.ceil(max(ua[1], ub[1], uc[1]))))
        if x1 < x0 or y1 < y0: continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        xs, ys = xs.ravel(), ys.ravel()
        den = (ub[1] - uc[1]) * (ua[0] - uc[0]) + (uc[0] - ub[0]) * (ua[1] - uc[1])
        if abs(den) < 1e-12: continue
        w0 = ((ub[1] - uc[1]) * (xs - uc[0]) + (uc[0] - ub[0]) * (ys - uc[1])) / den
        w1 = ((uc[1] - ua[1]) * (xs - uc[0]) + (ua[0] - uc[0]) * (ys - uc[1])) / den
        w2 = 1 - w0 - w1
        inside = (w0 >= -0.02) & (w1 >= -0.02) & (w2 >= -0.02)
        if not inside.any(): continue
        w0, w1, w2 = w0[inside], w1[inside], w2[inside]
        P_all.append(w0[:, None] * pos[a] + w1[:, None] * pos[b] + w2[:, None] * pos[c])
        if nrm is not None:
            N_all.append(w0[:, None] * nrm[a] + w1[:, None] * nrm[b] + w2[:, None] * nrm[c])
        X_all.append(xs[inside].astype(int)); Y_all.append(ys[inside].astype(int))
    Pp = np.concatenate(P_all); Xp = np.concatenate(X_all); Yp = np.concatenate(Y_all)
    Np = np.concatenate(N_all) if N_all else None
    rgb = fn(Pp, Np)
    img = np.zeros((size, size, 3), np.float32); filled = np.zeros((size, size), bool)
    img[size - 1 - Yp, Xp] = rgb; filled[size - 1 - Yp, Xp] = True
    # dilate into the gutters so mip-maps don't bleed black seams
    for _ in range(12):
        nf = filled.copy(); acc = np.zeros_like(img); cnt = np.zeros((size, size), np.float32)
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            sh = np.roll(np.roll(filled, dy, 0), dx, 1); si = np.roll(np.roll(img, dy, 0), dx, 1)
            add = sh & ~filled
            acc[add] += si[add]; cnt[add] += 1; nf |= add
        newp = cnt > 0
        img[newp] = acc[newp] / cnt[newp][:, None]
        filled = nf
    img[~filled] = bg
    return img

rng = np.random.default_rng(7)
def value_noise(p, freq, seed=0):
    # cheap 3D value noise via hashed lattice
    q = p * freq + seed * 17.13
    i = np.floor(q).astype(np.int64); f = q - i
    f = f * f * (3 - 2 * f)
    def h(ix, iy, iz):
        n = (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791) ^ (seed * 2654435761)
        n = (n ^ (n >> 13)) * 1274126177
        return ((n ^ (n >> 16)) & 0xFFFF) / 65535.0
    out = 0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (f[:, 0] if dx else 1 - f[:, 0]) * (f[:, 1] if dy else 1 - f[:, 1]) * (f[:, 2] if dz else 1 - f[:, 2])
                out = out + w * h(i[:, 0] + dx, i[:, 1] + dy, i[:, 2] + dz)
    return out

# ── the photos: several views of the face, each with its own head turn, blended by which sees a point best ──
F = P.get('face')
PAINT = (F or {}).get('painted')   # clean painted face: photos give soft tone only, features are drawn
views = []
if F:
    mouth_d = np.linalg.norm(load_target(f'{D}/targets/expression/units/caucasian/mouth-parling.target.gz'), axis=1)
    lips = np.array([vi for vi in body_idx if mouth_d[vi] > np.percentile(mouth_d[body_idx], 99.6)])
    mouth_c = V[lips].mean(0)
    face_front = [vi for vi in head_v if V[vi, 2] > hc[2] and abs(V[vi, 0] - hc[0]) < 0.02]
    chin_cands = [vi for vi in body_idx if abs(V[vi, 0]) < 0.006 and V[vi, 2] > mouth_c[2] - 0.04 and mouth_c[1] - 0.09 < V[vi, 1] < mouth_c[1]]
    chin_vi = min(chin_cands, key=lambda vi: V[vi, 1] + (0 if N[vi, 2] > 0.05 else 9))
    nose_vi = max(face_front, key=lambda vi: V[vi, 2])
    # mesh landmarks (3D), in the order: subject's right eye, left eye, nose tip, mouth, chin
    L3 = np.array([cube('joint-r-eye'), cube('joint-l-eye'), V[nose_vi], mouth_c, V[chin_vi]])
    def rot(pts, yaw, pitch):
        d = pts - hc
        cy, sy, cp, sp = math.cos(yaw), math.sin(yaw), math.cos(pitch), math.sin(pitch)
        x = d[:, 0] * cy + d[:, 2] * sy; z = -d[:, 0] * sy + d[:, 2] * cy
        y = d[:, 1] * cp - z * sp; z2 = d[:, 1] * sp + z * cp
        return np.c_[x, y, z2]
    samples = []
    for vdef in F['views']:
        im = ImageOps.exif_transpose(Image.open(vdef['photo'])).convert('RGB')
        sk = np.median(np.asarray(im.crop(tuple(vdef['skinSample']))).reshape(-1, 3).astype(np.float32) / 255.0, axis=0)
        lm = {k: list(vdef[k]) for k in ('eyeR', 'eyeL', 'nose', 'mouth', 'chin')}
        for mirror in ([False, True] if vdef.get('mirrorToo') else [False]):
            img, L = im, {k: list(v) for k, v in lm.items()}
            dense = None
            flip0 = (P['handed'] == 'left') != mirror
            if lm_idx is not None and os.path.exists(lm_file(vdef['photo'], flip0)):
                Ld = np.array(json.load(open(lm_file(vdef['photo'], flip0)))['pts'], float)
                dense = (V[lm_idx[lm_idx >= 0]], Ld[lm_idx >= 0, :2])
            # a left-hander is drawn mirrored, so project mirrored photos (the render then reads true);
            # 'mirrorToo' adds the flipped photo as a view of the other side of the face
            flip = (P['handed'] == 'left') != mirror
            if flip:
                img = ImageOps.mirror(im); W0 = im.width
                for k in L: L[k] = [W0 - L[k][0], L[k][1]]
                L['eyeR'], L['eyeL'] = L['eyeL'], L['eyeR']
            dst = np.array([L['eyeR'], L['eyeL'], L['nose'], L['mouth'], L['chin']], dtype=np.float64)
            src3 = L3
            if dense is not None: src3, dst = dense
            best = None
            for yaw in np.radians(np.arange(-55, 55.1, 1.0)):
                for pitch in np.radians(np.arange(-20, 20.1, 2.0)):
                    q = rot(src3, yaw, pitch)
                    A = np.c_[q[:, 0], q[:, 1], np.ones(len(q))]
                    aff, *_ = np.linalg.lstsq(A, dst, rcond=None)
                    r = np.linalg.norm(A @ aff - dst, axis=1).mean()
                    if best is None or r < best[0]: best = (r, yaw, pitch, aff)
            r, yaw, pitch, aff = best
            warp = None
            if dense is not None:
                q = rot(src3, yaw, pitch); proj2 = np.c_[q[:, 0], q[:, 1], np.ones(len(q))] @ aff
                warp = RBFInterpolator(q[:, :2], dst - proj2, kernel='thin_plate_spline', smoothing=0.5, neighbors=60)
            print(f"view {os.path.basename(vdef['photo'])}{' (mirrored)' if mirror else ''}: yaw {math.degrees(yaw):.0f}°, pitch {math.degrees(pitch):.0f}°, residual {r:.1f}px")
            # a photo can be told to skip the subject's left eye (odd shape in that shot); mirrored photos land on the mesh's other side
            skipEye = None
            if vdef.get('excludeLeftEye'): skipEye = cube('joint-r-eye') if flip else cube('joint-l-eye')
            views.append({'skipEye': skipEye, 'noMouth': vdef.get('excludeMouth', False), 'warp': warp, 'img': np.asarray(img.filter(ImageFilter.GaussianBlur(PAINT['blur'] * img.width)) if PAINT else img).astype(np.float32) / 255.0, 'yaw': yaw, 'pitch': pitch, 'aff': aff,
                          'weight': vdef.get('weight', 1.0) * (vdef.get('mirrorWeight', 0.6) if mirror else 1.0), 'skin': sk})
            samples.append(sk)
    skin_rgb = np.mean([v['skin'] for v in views[:1]], axis=0)  # the main (first) photo sets the tone
    for v in views:
        v['gain'] = (skin_rgb / np.maximum(v['skin'], 1e-3)) ** 0.85
    print('skin', (skin_rgb * 255).round())
else:
    skin_rgb = np.array([0.86, 0.66, 0.56])


# ── painted face features, drawn from the mesh's own landmarks (MediaPipe indices on the base mesh) ──
BROW = {'r': [46, 53, 52, 65, 55, 107, 66, 105, 63, 70], 'l': [276, 283, 282, 295, 285, 336, 296, 334, 293, 300]}
BROW_PATH = {'r': [70, 63, 105, 66, 107], 'l': [300, 293, 334, 296, 336]}
LIP_UP = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291]
LIP_LO = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291]
LID_UP = {'r': [33, 246, 161, 160, 159, 158, 157, 173, 133], 'l': [263, 466, 388, 387, 386, 385, 384, 398, 362]}
def seg_dist(p, pts):
    """distance from each p to a 3D polyline, and the arc parameter (0..1) of the closest point"""
    best = np.full(len(p), 9.0); tpar = np.zeros(len(p)); L = np.r_[0, np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))]
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]; ab = b - a
        t = np.clip(((p - a) @ ab) / max(ab @ ab, 1e-12), 0, 1)
        dd = np.linalg.norm(p - (a + t[:, None] * ab), axis=1)
        m = dd < best; best[m] = dd[m]; tpar[m] = (L[i] + t[m] * (L[i + 1] - L[i])) / L[-1]
    return best, tpar
def lmp(i):
    return V[lm_idx[i]] if lm_idx is not None and lm_idx[i] >= 0 else None
def paint_face(p, n, base):
    if lm_idx is None: return base
    out = base.copy(); C = PAINT
    hcol = np.array(P['hair']['color']) / 255.0
    near = np.linalg.norm(p - hc, axis=1) < 0.16
    if not near.any(): return out
    q = p[near]; o = out[near]
    # eyebrows: tapered strokes along the brow line, a little grainy, darker and fuller at the inner end
    for k in 'rl':
        path = np.array([lmp(i) for i in BROW_PATH[k] if lmp(i) is not None])
        if len(path) < 3: continue
        path = path + np.array([0, C['browDrop'], 0.0015])
        dd, t = seg_dist(q, path)
        inner = t if k == 'r' else t   # path runs outer → inner
        width = C['browWidth'] * (0.55 + 0.6 * inner) * (1 - 0.35 * np.clip((0.15 - inner) / 0.15, 0, 1))
        grain = 0.75 + 0.5 * value_noise(q * np.array([1, 6, 1]), 900, 7)
        a = np.clip(1 - dd / width, 0, 1) ** 0.8 * grain * C['browDark']
        o = o * (1 - a[:, None]) + (hcol * 0.85) * a[:, None]
    # upper lash line and a soft lid crease / socket shadow
    for k in 'rl':
        lid = np.array([lmp(i) for i in LID_UP[k] if lmp(i) is not None])
        if len(lid) < 4: continue
        dd, t = seg_dist(q, lid + np.array([0, 0.0008, 0.001]))
        a = np.clip(1 - dd / 0.0022, 0, 1) * (0.4 + 0.6 * np.sin(np.pi * t)) * C['lash']
        o = o * (1 - a[:, None]) + np.array([0.16, 0.11, 0.09]) * a[:, None]
        dd2, _ = seg_dist(q, lid + np.array([0, 0.0065, -0.002]))
        a2 = np.exp(-(dd2 / 0.0045) ** 2) * C['socket']
        o *= (1 - a2[:, None] * np.array([0.22, 0.28, 0.24]))
    # lips: a soft rose tint inside the lip outline, slightly darker at the parting line
    up = np.array([lmp(i) for i in LIP_UP if lmp(i) is not None]); lo = np.array([lmp(i) for i in LIP_LO if lmp(i) is not None])
    if len(up) > 5 and len(lo) > 5:
        mid = (up + lo) / 2
        dm, tm = seg_dist(q, mid)
        sep = np.linalg.norm(up - lo, axis=1) * 0.5
        arc = np.r_[0, np.cumsum(np.linalg.norm(np.diff(mid, axis=0), axis=1))]; arc /= arc[-1]
        thick = np.interp(tm, arc, sep) + 0.0006          # local half-height of the lips
        inlip = np.clip(1 - (dm - thick) / 0.0012, 0, 1) * (np.abs(q[:, 2] - mid[:, 2].mean()) < 0.03)
        o = o * (1 - inlip[:, None] * C['lip']) + (o * np.array([0.95, 0.62, 0.60])) * (inlip[:, None] * C['lip'])
        part = np.exp(-(dm / 0.0012) ** 2) * 0.3
        o *= 1 - part[:, None]
    # stubble: a faint cool shadow on the jaw, chin and upper lip
    mo = mouth_c; ch = V[chin_vi]
    jaw = (q[:, 1] < mo[1] + 0.022) & (q[:, 2] > hc[2] - 0.03)
    below_cheek = np.clip((mo[1] + 0.025 - q[:, 1]) / 0.025, 0, 1) * np.clip((q[:, 1] - (ch[1] - 0.04)) / 0.03, 0, 1)
    lipzone = np.exp(-((np.linalg.norm((q - mo) * [1.0, 1.6, 1.0], axis=1) - 0.0) / 0.035) ** 2)
    st = below_cheek * jaw * C['stubble'] * (0.7 + 0.6 * value_noise(q, 700, 9)) * (1 - 0.6 * np.exp(-(np.linalg.norm((q - mo) * [1.0, 2.5, 1.0], axis=1) / 0.018) ** 2))
    st = np.maximum(st, lipzone * 0 )
    o = o * (1 - st[:, None]) + (o * np.array([0.72, 0.70, 0.72])) * st[:, None]
    # warmth on the cheeks, nose and ears (outdoorsy)
    for sx in (-1, 1):
        cc = hc + np.array([sx * 0.045, -0.035, 0.07])
        a = np.exp(-(np.linalg.norm(q - cc, axis=1) / 0.025) ** 2) * C['blush']
        o = o * (1 - a[:, None]) + (o * np.array([1.04, 0.86, 0.84])) * a[:, None]
    nt = V[nose_vi]; a = np.exp(-(np.linalg.norm(q - nt, axis=1) / 0.014) ** 2) * C['blush'] * 0.8
    o = o * (1 - a[:, None]) + (o * np.array([1.04, 0.88, 0.86])) * a[:, None]
    out[near] = o
    return out


# ── an unwrapped, evenly lit face texture (front + ears, cylindrical), mapped by landmarks onto the smiling head ──
UNWRAP = None
if F and F.get('unwrap') and lm_idx is not None:
    U0 = F['unwrap']; uim = Image.open(U0['photo']).convert('RGB')
    flipU = P['handed'] == 'left'
    if flipU: uim = ImageOps.mirror(uim)
    Lu = np.array(json.load(open(lm_file(U0['photo'], flipU)))['pts'], float)[:, :2]
    ok = lm_idx >= 0
    smile_d = morphs.get('smile', np.zeros_like(V)) * U0.get('smileK', 0.9)
    head_vi = np.array([vi for vi in body_idx if np.linalg.norm(V[vi] - hc) < 0.2])
    smile_tree = cKDTree(V[head_vi])
    def smiling(pts):
        dd, jj = smile_tree.query(pts, k=4); w = 1 / np.maximum(dd, 1e-4); w /= w.sum(1, keepdims=True)
        return pts + np.einsum('nk,nkj->nj', w, smile_d[head_vi][jj])
    def cyl(pts):
        d = pts - hc
        return np.c_[np.arctan2(d[:, 0], d[:, 2]), d[:, 1]]
    # the unwrap's mouth is open (teeth showing) but the mesh mouth is closed: drop the lip landmarks and pin the
    # painted mouth's centre to the mesh's lip seam, with the corners at the mesh's corners
    LIPS = {0, 267, 269, 270, 409, 37, 39, 40, 185, 17, 314, 405, 321, 375, 84, 181, 91, 146,
            13, 14, 312, 311, 310, 415, 82, 81, 80, 191, 317, 402, 318, 324, 87, 178, 88, 95, 78, 308}
    keep = ok & ~np.isin(np.arange(len(lm_idx)), list(LIPS))
    Ms = V[lm_idx[keep]] + smile_d[lm_idx[keep]]
    src = cyl(Ms); dst = Lu[keep]
    if lm_idx[13] >= 0 and lm_idx[14] >= 0:
        seam = (V[lm_idx[13]] + smile_d[lm_idx[13]] + V[lm_idx[14]] + smile_d[lm_idx[14]]) / 2
        src = np.r_[src, cyl(seam[None])]; dst = np.r_[dst, ((Lu[13] + Lu[14]) / 2)[None]]
    A = np.c_[src, np.ones(len(src))]; aff, *_ = np.linalg.lstsq(A, dst, rcond=None)
    print('unwrap affine residual', np.linalg.norm(A @ aff - dst, axis=1).mean().round(1), 'px')
    # ears: anchor the mesh's ear centres to the ears painted at the sides of the unwrap
    if U0.get('ears'):
        ear_pts = []
        for sx in (-1, 1):
            cand = [vi for vi in head_vi if (V[vi, 0] - hc[0]) * sx > 0 and mouth_c[1] - 0.005 < V[vi, 1] < eye_c[1] + 0.015]
            ear_pts.append(V[max(cand, key=lambda vi: abs(V[vi, 0] - hc[0]))])
        ear_pts = np.array(ear_pts); W0 = uim.width
        img_ears = np.array([[W0 - e[0], e[1]] if flipU else e for e in U0['ears']], float)
        pred = np.c_[cyl(ear_pts), np.ones(2)] @ aff
        for i in range(2):
            j = int(np.argmin(np.linalg.norm(img_ears - pred[i], axis=1)))
            src = np.r_[src, cyl(ear_pts[i:i + 1])]; dst = np.r_[dst, img_ears[j:j + 1]]
        print('ears: predicted', pred.round(0).tolist(), '→ painted', img_ears.tolist())
    uwarp = RBFInterpolator(src, dst, kernel='thin_plate_spline', smoothing=U0.get('smoothing', 2.0), degree=1)
    # the 3D eyeballs show through the lid openings and the mesh mouth is closed: paint the eye openings and the open
    # mouth out of the unwrap (skin over the eyes with a lash line, lips over the teeth) so nothing appears twice
    import cv2
    ua = np.asarray(uim).copy()
    EYE = {'r': [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7],
           'l': [263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390, 249]}
    INNER_LIP = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95]
    hole = np.zeros(ua.shape[:2], np.uint8)
    for k in EYE: cv2.fillPoly(hole, [np.round(Lu[EYE[k]]).astype(np.int32)], 255)
    hole_e = cv2.dilate(hole, np.ones((5, 5), np.uint8))
    ua = cv2.inpaint(ua, hole_e, 6, cv2.INPAINT_TELEA)
    mouth = np.zeros(ua.shape[:2], np.uint8); cv2.fillPoly(mouth, [np.round(Lu[INNER_LIP]).astype(np.int32)], 255)
    lipcol = np.median(np.asarray(uim)[(cv2.dilate(mouth, np.ones((9, 9), np.uint8)) > 0) & (mouth == 0)], axis=0)
    ua[mouth > 0] = lipcol
    ua = cv2.inpaint(ua, cv2.dilate(mouth, np.ones((3, 3), np.uint8)), 4, cv2.INPAINT_TELEA)
    # a soft lip line through the middle of the closed smile
    mid = (Lu[[78, 81, 13, 311, 308]] + Lu[[78, 178, 14, 402, 308]]) / 2
    ln = np.zeros(ua.shape[:2], np.float32); cv2.polylines(ln, [np.round(mid).astype(np.int32)], False, 1.0, 2, cv2.LINE_AA)
    ln = cv2.GaussianBlur(ln, (5, 5), 1.2)[..., None]
    ua = (ua * (1 - 0.35 * ln)).astype(np.uint8)
    # upper lash lines (the eyeball itself comes from the 3D eye)
    for k, upper in (('r', [33, 246, 161, 160, 159, 158, 157, 173, 133]), ('l', [263, 466, 388, 387, 386, 385, 384, 398, 362])):
        cv2.polylines(ua, [np.round(Lu[upper]).astype(np.int32)], False, (52, 36, 30), 2, cv2.LINE_AA)
    Image.fromarray(ua).save(os.path.join(os.path.dirname(__file__), 'data', 'face_unwrap.clean.jpg'), quality=92)
    uarr = ua.astype(np.float32) / 255.0
    cheeks = [50, 280, 101, 330]
    cs = [Lu[i] for i in cheeks]
    skin_rgb = np.median(np.array([uarr[int(y) - 6:int(y) + 6, int(x) - 6:int(x) + 6].reshape(-1, 3) for x, y in cs]).reshape(-1, 3), axis=0)
    print('unwrap skin', (skin_rgb * 255).round())
    UNWRAP = {'warp': uwarp, 'img': uarr, 'cyl': cyl, 'smiling': smiling, 'cfg': U0}
def unwrap_layer(p, base):
    if UNWRAP is None: return base
    near = (np.linalg.norm(p - hc, axis=1) < 0.19)
    if not near.any(): return base
    q = p[near]; ps = UNWRAP['smiling'](q); c = UNWRAP['cyl'](ps)
    xy = UNWRAP['warp'](c); img = UNWRAP['img']; Hh, Ww = img.shape[:2]
    x, y = xy[:, 0], xy[:, 1]
    x0 = np.clip(np.floor(x).astype(int), 0, Ww - 2); y0 = np.clip(np.floor(y).astype(int), 0, Hh - 2)
    fx = np.clip(x - x0, 0, 1)[:, None]; fy = np.clip(y - y0, 0, 1)[:, None]
    col = (img[y0, x0] * (1 - fx) + img[y0, x0 + 1] * fx) * (1 - fy) + (img[y0 + 1, x0] * (1 - fx) + img[y0 + 1, x0 + 1] * fx) * fy
    m = 4.0
    w = np.clip(np.minimum.reduce([x - m, Ww - m - x, y - m, Hh - m - y]) / 14.0, 0, 1)
    w *= np.clip((np.radians(UNWRAP['cfg'].get('maxAngle', 105)) - np.abs(c[:, 0])) / 0.25, 0, 1)
    w *= np.clip((q[:, 1] - (V[chin_vi, 1] - 0.07)) / 0.03, 0, 1)   # stop above the collar
    o = base.copy(); o[near] = base[near] * (1 - w[:, None]) + col * w[:, None]
    return o

SMILE_BAKE = False
def skin_fn(p, n):
    base = np.tile(skin_rgb, (len(p), 1)).astype(np.float32)
    # subtle variation: blotchy noise and pores
    nz = value_noise(p, 40) * 0.6 + value_noise(p, 140, 1) * 0.4
    base *= (0.94 + 0.1 * nz)[:, None]
    base *= 1 + 0.03 * (value_noise(p, 9, 2) - 0.5)[:, None]
    if views:
        d = p - hc
        acc = np.zeros_like(base); wsum = np.zeros(len(p), np.float32)
        near = (np.linalg.norm(d, axis=1) < 0.17) & (p[:, 1] > V[chin_vi, 1] - 0.05)
        yband = np.clip((p[:, 1] - (V[chin_vi, 1] - 0.035)) / 0.03, 0, 1) * np.clip(((hc[1] + F['foreheadTop']) - p[:, 1]) / 0.02, 0, 1)
        for v in views:
            q = rot(p, v['yaw'], v['pitch'])
            # which way this camera looks at the head, in head space
            cy, sy, cp, sp = math.cos(v['yaw']), math.sin(v['yaw']), math.cos(v['pitch']), math.sin(v['pitch'])
            camdir = np.array([-sy * cp, sp, cy * cp]); camdir /= np.linalg.norm(camdir)
            facing = np.clip((n @ camdir - 0.3) / 0.5, 0, 1) ** 4
            xy = np.c_[q[:, 0], q[:, 1], np.ones(len(p))] @ v['aff']
            if v['warp'] is not None and near.any():
                xy[near] += v['warp'](q[near, :2])
            img = v['img']
            inside = (xy[:, 0] > 2) & (xy[:, 0] < img.shape[1] - 3) & (xy[:, 1] > 2) & (xy[:, 1] < img.shape[0] - 3)
            px = np.clip(xy[:, 0], 0, img.shape[1] - 1).astype(int); py = np.clip(xy[:, 1], 0, img.shape[0] - 1).astype(int)
            col = img[py, px] * v['gain']
            # only trust pixels that look like skin (not the kitchen behind, not hair)
            # stubble and shadow are darker/greyer than bare skin: be more forgiving low on the face
            sig = np.where(p[:, 1] < hc[1] - 0.03, 0.26, 0.15)
            skinlike = np.exp(-np.sum((col - skin_rgb) ** 2, axis=1) / (2 * sig ** 2))
            w = facing * yband * near * inside * v['weight'] * skinlike
            if v is not views[0]:  # side views never paint the nose/mouth/chin strip (avoids double features)
                w *= np.clip((np.abs(d[:, 0]) - 0.022) / 0.02, 0, 1)
            if v.get('skipEye') is not None:
                w *= np.clip((np.linalg.norm(p - v['skipEye'], axis=1) - 0.022) / 0.012, 0, 1)
            mouthzone = 1 - np.clip((np.linalg.norm((p - mouth_c) * [1.0, 1.3, 1.0], axis=1) - 0.03) / 0.02, 0, 1)
            if SMILE_BAKE:   # smile texture: the mouth comes from the smiling photos only
                w *= (mouthzone * 3.0 + (1 - mouthzone)) if v['noMouth'] else (1 - mouthzone)
            elif v['noMouth']:  # neutral texture: a smiling photo gives cheeks, temples and jaw, not its mouth
                w *= 1 - mouthzone
            if PAINT: w *= 1 - np.clip(mouthzone * 1.4, 0, 1)   # painted mode: lips are drawn, not photographed
            acc += col * w[:, None]; wsum += w
        cov = np.clip(wsum / 0.35, 0, 1)[:, None]
        ph = acc / np.maximum(wsum, 1e-6)[:, None]
        if PAINT: cov = cov * PAINT['photoMix']
        base = base * (1 - cov) + ph * cov
        if PAINT and UNWRAP is None: base = paint_face(p, n, base)
    base = unwrap_layer(p, base)
    # painted short hair under the hair shell (soft hairline)
    hp = P['hair']
    hcol = np.array(hp['color']) / 255.0
    mm = hair_mask_v(p)
    hw = np.clip((mm + 0.03) / 0.06, 0, 1)[:, None] * (np.linalg.norm(p - hcr, axis=1) < 0.16)[:, None]
    hw = hw * (0.45 + 0.55 * crown_thin(p - hcr))[:, None]
    base = base * (1 - 0.92 * hw) + hcol * 0.92 * hw
    return np.clip(base, 0, 1)

print('baking skin texture…')
SMILE_BAKE = False
skin_img = raster(meshes['skin'], skin_fn, T)
Image.fromarray((skin_img * 255).astype(np.uint8)).save(f'{OUT}/skin.jpg', quality=86)
if any(v['noMouth'] for v in views):
    print('baking smile texture…')
    SMILE_BAKE = True
    smile_img = raster(meshes['skin'], skin_fn, T)
    Image.fromarray((smile_img * 255).astype(np.uint8)).save(f'{OUT}/skin_smile.jpg', quality=86)
    SMILE_BAKE = False

# eyes: iris colour from the profile, a little radial detail
iris = np.array(P['eyes']) / 255.0
eye_l, eye_r = cube('joint-l-eye'), cube('joint-r-eye')
def eye_fn(p, n):
    c = np.where((p[:, 0] > 0)[:, None], eye_l, eye_r)
    d = p - c; d /= np.linalg.norm(d, axis=1, keepdims=True)
    ang = np.degrees(np.arccos(np.clip(d[:, 2], -1, 1)))
    out = np.tile([0.74, 0.68, 0.64], (len(p), 1)).astype(np.float32)
    rad = value_noise(np.c_[np.arctan2(d[:, 1], d[:, 0]) * 3, ang * 0.2, d[:, 2]], 6, 3)
    iris_c = iris * (0.75 + 0.4 * rad)[:, None]
    ir = (ang < 30)[:, None]; ring = ((ang > 27) & (ang < 30.5))[:, None]; pupil = (ang < 11)[:, None]
    out = np.where(ir, iris_c, out); out = np.where(ring, iris * 0.45, out); out = np.where(pupil, [0.03, 0.03, 0.035], out)
    return out
Image.new('RGB', (4, 4), (230, 225, 220)).save(f'{OUT}/eyes.png')

# ───────────────────────── write the binary ─────────────────────────
blobs = bytearray(); desc = {}
def put(arr, dtype):
    global blobs
    a = np.ascontiguousarray(arr, dtype=dtype)
    while len(blobs) % 4: blobs += b'\0'
    off = len(blobs); blobs += a.tobytes()
    return {'offset': off, 'count': int(a.size), 'type': np.dtype(dtype).name}
for name, m in meshes.items():
    sw = [top4(vi) for vi in m['src']]
    d = {'position': put(m['pos'], np.float32), 'uv': put(m['uv'], np.float32), 'index': put(m['tris'].ravel(), np.uint32),
         'skinIndex': put([[b for b, _ in s] for s in sw], np.uint16), 'skinWeight': put([[w for _, w in s] for s in sw], np.float32)}
    if name == 'skin':
        for mn, md in morphs.items():
            d['morph_' + mn] = put(md[m['src']], np.float32)
    if name == 'teeth':
        for mn, md in morphs.items():
            d['morph_' + mn] = put(md[m['src']], np.float32)
    if 'mask' in m:
        d['mask'] = put(m['mask'], np.float32)
    if 'cloth' in m:
        d['cloth'] = put(m['cloth'], np.float32)
    if 'legT' in m:
        d['legT'] = put(m['legT'], np.float32)
    desc[name] = d
    print(f'  {name}: {len(m["pos"])} verts, {len(m["tris"])} tris')
meta = {
    'bones': BONES, 'parents': parents,
    'joint': [list(map(float, j)) for j in joint], 'tail': [list(map(float, t)) for t in tail],
    'eye': list(map(float, eye_c)), 'headCenter': list(map(float, hc)), 'visor': visor,
    'collar': collar, 'belt': belt, 'feet': feet,
    'eyeballs': {sfx: {'c': list(map(float, V[sorted(group_verts[f'helper-{sfx}-eye'])].mean(0))),
                       'r': float(np.linalg.norm(V[sorted(group_verts[f'helper-{sfx}-eye'])] - V[sorted(group_verts[f'helper-{sfx}-eye'])].mean(0), axis=1).mean())} for sfx in 'lr'},
    'iris': P['eyes'],
    'paintedMouth': UNWRAP is not None, 'paintedSmile': (UNWRAP['cfg'].get('smileK', 0.9) if UNWRAP else None),
    'meshes': desc, 'heightM': P['heightM'],
}
mj = json.dumps(meta).encode()
with open(f'{OUT}/character.bin', 'wb') as f:
    f.write(b'GOLF'); f.write(struct.pack('<I', len(mj))); f.write(mj)
    while (8 + len(mj)) % 4: f.write(b' '); mj += b' '
    f.write(blobs)
print('wrote', OUT, os.path.getsize(f'{OUT}/character.bin') // 1024, 'KB')
