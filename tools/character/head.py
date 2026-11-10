"""Generated head for the realistic golfer.

Takes a raw image-to-3D head mesh (e.g. Hunyuan3D-2 shape generation from the player's portrait), cleans it,
fits it onto the MakeHuman body's head (eyes, scale, pitch), blends its neck into the body's neck, decimates it
for phones, unwraps it and bakes a colour texture by projecting the portrait(s) onto it (mirrored for the face's
far side, a hair/skin fill where no photo sees). Writes <out>/head.bin + <out>/head.jpg, which human.ts loads.

  python3 -I tools/character/head.py --raw /path/white_mesh.glb [--photo src/assets/neil/portrait.jpg ...]

Run it again after build.py (it reads character.bin for the eyes, neck and skin weights), or with a new photo
(e.g. a front-on one: pass several --photo; each is posed automatically from its face landmarks).
Needs: trimesh, fast-simplification, xatlas, mediapipe (+ /tmp/face_landmarker.task), opencv, scipy, pillow.
"""
import argparse, json, math, os, struct
import numpy as np, cv2, trimesh, fast_simplification, xatlas
from PIL import Image, ImageOps
from scipy.spatial import cKDTree
from scipy.ndimage import map_coordinates

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
ap = argparse.ArgumentParser()
ap.add_argument('--raw', required=True)
ap.add_argument('--photo', action='append')
ap.add_argument('--out', default=os.path.join(ROOT, 'src/assets/neil'))
ap.add_argument('--bin', default=None, help='character.bin (default <out>/character.bin)')
ap.add_argument('--tris', type=int, default=16000)
ap.add_argument('--tex', type=int, default=2048)
ap.add_argument('--unwrap', default=None, help="front-on cylindrical face texture (+ .lm.json; default: neil.json face.unwrap); 'none' to skip")
ap.add_argument('--hair', default=None, help='hair colour (default: the profile look.hair in src/golfer/profile.ts, else #4a3628)')
ap.add_argument('--unwrap-weight', type=float, default=4.0, help='how strongly the unwrap wins over the portrait where both see')
ap.add_argument('--mpfb', default='/tmp/mh/mpfb2/src/mpfb/data', help='MakeHuman (MPFB2) data, for the expression targets')
ap.add_argument('--neck', default='loft', choices=['cap', 'loft'], help="cap: keep the generator's cap, the body's neck shows below; loft: grow a neck down into the collar")
ap.add_argument('--head-scale', type=float, default=1.0)
ap.add_argument('--head-width', type=float, default=1.0, help='overall width of the whole head (the face reshape sets the face itself)')
ap.add_argument('--head-width-face', type=float, default=0.96, help='starting face width for the reshape fit')
ap.add_argument('--no-reshape', dest='reshape', action='store_false')
ap.add_argument('--face-length', type=float, default=1.08, help='stretch below the nose (the user reads the face as too short)')
ap.add_argument('--forehead', type=float, default=1.12, help='stretch of the brow-to-hairline band (~3 cm)')
ap.add_argument('--cheek-fill', type=float, default=0.0025, help='extra fullness (m) at the cheek apples')
ap.add_argument('--hair-top', type=float, default=0.125, help='top of the hair above the eyes (m)')
ap.add_argument('--rest', default='closed', choices=['closed', 'grin'], help='rest face: a relaxed closed-mouth smile, or the portrait\'s open grin')
ap.add_argument('--rest-smile', type=float, default=0.5, help='smile morph baked into the rest face (the Hunyuan3D-2.1 head has a neutral, slightly downturned mouth: a little smile makes his relaxed rest; the pencil-portrait head needed -0.85)')
ap.add_argument('--real-photos', default='8716142c,ee55797f,efc78715,f9637097', help='his photos the central face is projected from (name prefixes; empty = none)')
ap.add_argument('--skin-lift', type=float, default=6.0, help='Lab L added to the real-photo face')
ap.add_argument('--clean-weight', type=float, default=3.0, help="weight of a photo's relit copy (<photo>.clean.jpg, same geometry) in the face texture; 0 = ignore them")
ap.add_argument('--ear-back', type=float, default=0.0, help='ears swung back about their roots (rad)')
ap.add_argument('--ear-out', type=float, default=1.0, help='ear protrusion scale')
ap.add_argument('--crop', type=float, default=0.01, help='metres cut off the bottom of the generated neck stub')
ap.add_argument('--handed', default='left')
ap.add_argument('--no-lids', dest='lids', action='store_false', help='skip the geometric eyelid blink (the shader draws the lids)')
ap.add_argument('--nose-mirror', default='+', choices=['+', '-', 'none'], help="the side of the nose base (pre-mirror x) whose dark blotches are lifted to match the other side")
ap.add_argument('--debug', default=None, help='directory for debug images')
A = ap.parse_args()
photos = A.photo or [os.path.join(ROOT, 'src/assets/neil/portrait.jpg')]
DBG = A.debug
if DBG: os.makedirs(DBG, exist_ok=True)
def dbg(name, img):
    if DBG: Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(os.path.join(DBG, name))

# ───────────────────────── rasteriser (painter's order, triangle ids) ─────────────────────────
def raster(P2, depth, F, W, H):
    """triangle-id buffer (-1 = empty). P2: (n,2) pixel coords, depth: (n,) larger = farther."""
    img = np.zeros((H, W, 3), np.uint8)
    fz = depth[F].mean(1)
    pts = np.round(P2[F] * 16).astype(np.int32)
    lo, hi = pts.min(1) // 16, pts.max(1) // 16
    vis = (hi[:, 0] >= 0) & (lo[:, 0] < W) & (hi[:, 1] >= 0) & (lo[:, 1] < H)
    for i in np.argsort(-fz):
        if not vis[i]: continue
        k = int(i) + 1
        cv2.fillPoly(img, [pts[i]], (k & 255, (k >> 8) & 255, (k >> 16) & 255), lineType=cv2.LINE_8, shift=4)
    ids = img[..., 0].astype(np.int64) | (img[..., 1].astype(np.int64) << 8) | (img[..., 2].astype(np.int64) << 16)
    return ids - 1

def bary(P2, F, ids, px, py):
    """barycentric coords of pixel centres (px, py) in triangles ids"""
    a, b, c = P2[F[ids, 0]], P2[F[ids, 1]], P2[F[ids, 2]]
    v0, v1 = b - a, c - a; v2 = np.c_[px, py] - a
    d = v0[:, 0] * v1[:, 1] - v1[:, 0] * v0[:, 1]; d = np.where(np.abs(d) < 1e-12, 1e-12, d)
    w1 = (v2[:, 0] * v1[:, 1] - v1[:, 0] * v2[:, 1]) / d
    w2 = (v0[:, 0] * v2[:, 1] - v2[:, 0] * v0[:, 1]) / d
    return np.c_[1 - w1 - w2, w1, w2]

def zbuffer(P2, depth, F, ids):
    H, W = ids.shape; yy, xx = np.nonzero(ids >= 0); t = ids[yy, xx]
    w = bary(P2, F, t, xx + 0.5, yy + 0.5)
    zb = np.full((H, W), np.inf); zb[yy, xx] = (depth[F[t]] * w).sum(1)
    return zb

def shade(V, N, F, P2, depth, W, H, light=(0.25, 0.35, 1.0)):
    ids = raster(P2, depth, F, W, H)
    yy, xx = np.nonzero(ids >= 0); t = ids[yy, xx]; w = bary(P2, F, t, xx + 0.5, yy + 0.5)
    n = (N[F[t]] * w[..., None]).sum(1); n /= np.linalg.norm(n, axis=1, keepdims=True) + 1e-9
    L = np.array(light, float); L /= np.linalg.norm(L)
    img = np.full((H, W, 3), 255.0); v = 40 + 200 * np.clip(n @ L, 0, 1)
    img[yy, xx] = np.c_[v, v * 0.97, v * 0.94]
    return img, ids

def ortho(V, center, scale, S):
    P2 = np.c_[(V[:, 0] - center[0]) * scale + S / 2, (center[1] - V[:, 1]) * scale + S / 2]
    return P2, -V[:, 2]          # camera on +z looking down -z: larger -z = farther

# ───────────────────────── face landmarks (MediaPipe) ─────────────────────────
import mediapipe as mp
from mediapipe.tasks.python import vision, BaseOptions
_det = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
    base_options=BaseOptions(model_asset_path='/tmp/face_landmarker.task'), output_facial_transformation_matrixes=True, num_faces=1))
def landmarks(rgb):
    r = _det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb.astype(np.uint8))))
    if not r.face_landmarks: return None
    H, W = rgb.shape[:2]
    return np.array([[p.x * W, p.y * H] for p in r.face_landmarks[0]])

def mesh_landmarks(V, N, F, name):
    """render the mesh from the front (grey, lit) and lift MediaPipe's landmarks onto its surface"""
    S = 1024
    U = V[np.unique(F)]
    face = U[U[:, 2] > np.percentile(U[:, 2], 40)]
    c = (face.min(0) + face.max(0)) / 2; ext = (face.max(0) - face.min(0))[:2].max()
    scale = S * 0.62 / ext
    P2, dep = ortho(V, c, scale, S)
    img, ids = shade(V, N, F, P2, dep, S, S)
    dbg(f'lm_{name}.png', img)
    lm = landmarks(img)
    if lm is None: raise SystemExit(f'no face found on the {name} render')
    out = np.full((len(lm), 3), np.nan)
    for i, (x, y) in enumerate(lm):
        xi, yi = int(x), int(y)
        if 0 <= xi < S and 0 <= yi < S and ids[yi, xi] >= 0:
            t = ids[yi, xi]; w = bary(P2, F, np.array([t]), np.array([x]), np.array([y]))[0]
            out[i] = (V[F[t]] * w[:, None]).sum(0)
    if DBG:
        for x, y in lm: cv2.circle(img, (int(x), int(y)), 2, (255, 0, 0), -1)
        dbg(f'lm_{name}_pts.png', img)
    return out

def vnormals(V, F):
    return trimesh.Trimesh(V, F, process=False).vertex_normals.copy()

def umeyama_R(B, A):
    """rotation taking centred point set B onto A (no scale)"""
    A0, B0 = A - A.mean(0), B - B.mean(0)
    U, S, Vt = np.linalg.svd(A0.T @ B0)
    d = np.sign(np.linalg.det(U @ Vt)); return U @ np.diag([1, 1, d]) @ Vt

# ───────────────────────── the body (character.bin) ─────────────────────────
binp = A.bin or os.path.join(A.out, 'character.bin')
cb = open(binp, 'rb').read(); n = struct.unpack('<I', cb[4:8])[0]; M = json.loads(cb[8:8 + n]); bs = (8 + n + 3) & ~3
def arr(d): return np.frombuffer(cb, {'float32': np.float32, 'uint32': np.uint32, 'uint16': np.uint16}[d['type']], d['count'], bs + d['offset'])
sk = M['meshes']['skin']
SP = arr(sk['position']).reshape(-1, 3).astype(float); SF = arr(sk['index']).reshape(-1, 3).astype(np.int64)
SI = arr(sk['skinIndex']).reshape(-1, 4); SW = arr(sk['skinWeight']).reshape(-1, 4)
SUV = arr(sk['uv']).reshape(-1, 2)
B = M['bones']; hb, nb = B.index('head'), B.index('neck_01')
eye_mh = np.array(M['eye']); ipd_mh = abs(M['eyeballs']['l']['c'][0] - M['eyeballs']['r']['c'][0])
# MakeHuman head for landmarks: skin above the shoulders, plus the eyeballs
keep = SP[:, 1] > eye_mh[1] - 0.15
fk = keep[SF].all(1); MF = SF[fk]
MV = SP.copy()
eb = []
for sfx in 'lr':
    e = M['eyeballs'][sfx]; sph = trimesh.creation.uv_sphere(e['r'], count=[24, 24]); sph.apply_translation(e['c'])
    eb.append((sph.vertices, sph.faces))
for v_, f_ in eb:
    MF = np.r_[MF, f_ + len(MV)]; MV = np.r_[MV, v_]
lm_mh = mesh_landmarks(MV, vnormals(MV, MF), MF, 'makehuman')

# ───────────────────────── the generated head ─────────────────────────
raw = trimesh.load(A.raw, force='mesh', process=False)
_, first = np.unique(np.sort(raw.faces, 1), axis=0, return_index=True)   # drop repeated faces, keep the winding
f = raw.faces[first]; f = f[(f[:, 0] != f[:, 1]) & (f[:, 1] != f[:, 2]) & (f[:, 0] != f[:, 2])]
g = trimesh.Trimesh(raw.vertices, f, process=True)
g = max(g.split(only_watertight=False), key=lambda m: len(m.faces))
if np.mean(np.einsum('ij,ij->i', g.face_normals, g.triangles_center - g.centroid)) < 0: g.invert()   # outward
print('raw', len(raw.faces), '→ clean', len(g.faces))
del raw
V0, F0 = fast_simplification.simplify(np.asarray(g.vertices, np.float64), np.asarray(g.faces, np.int64), target_count=300000)[:2] if len(g.faces) > 320000 else (g.vertices, g.faces)
hi = trimesh.Trimesh(V0, F0, process=True)
GV, GF = np.asarray(hi.vertices, float), np.asarray(hi.faces, np.int64); GN = hi.vertex_normals.copy()
del g, hi
print('work mesh', len(GF), 'tris')
lm_g = mesh_landmarks(GV, GN, GF, 'generated')

# ───────────────────────── fit onto the body: rotation from the upper face, scale from the eyes ─────────────────────────
IRIS = (468, 473)
ok = ~np.isnan(lm_g).any(1) & ~np.isnan(lm_mh).any(1)
nose_y = lm_mh[4, 1]
upper = ok & (lm_mh[:, 1] > nose_y - 0.004)
# a landmark can land on something behind the face (lashes, an inner surface): drop points far off the face's
# own depth before fitting, then trim the worst fits and refit
for L_ in (lm_mh, lm_g):
    zz = L_[upper, 2]; med = np.median(zz); spread = np.median(np.abs(zz - med)) * 6 + 1e-6
    upper &= ~(np.abs(L_[:, 2] - med) > spread) | ~upper
print('  upper-face landmarks used:', int(upper.sum()), ' MakeHuman depth range', np.round(np.ptp(lm_mh[upper, 2]), 3))
R = umeyama_R(lm_g[upper], lm_mh[upper])
for _ in range(2):
    Bm = (R @ (lm_g[upper] - lm_g[upper].mean(0)).T).T; Am = lm_mh[upper] - lm_mh[upper].mean(0)
    sc_ = (Am * Bm).sum() / (Bm ** 2).sum(); e_ = np.linalg.norm(Am - sc_ * Bm, axis=1)
    keep_ = e_ < np.percentile(e_, 85); idx_ = np.nonzero(upper)[0]; upper[idx_[~keep_]] = False
    R = umeyama_R(lm_g[upper], lm_mh[upper])
ipd_g = np.linalg.norm(lm_g[IRIS[0]] - lm_g[IRIS[1]]); ipd_lm_mh = np.linalg.norm(lm_mh[IRIS[0]] - lm_mh[IRIS[1]])
# scale: the eye spacing and the eye-to-chin length both measured the same way (landmarks on a grey render) on
# both heads; their geometric mean keeps the face proportions of the photo while matching the body's head size
eye_g = (lm_g[IRIS[0]] + lm_g[IRIS[1]]) / 2; eye_lmh = (lm_mh[IRIS[0]] + lm_mh[IRIS[1]]) / 2
s_ipd = ipd_lm_mh / ipd_g
s_len = np.linalg.norm(lm_mh[152] - eye_lmh) / np.linalg.norm(lm_g[152] - eye_g)
A0, B0 = lm_mh[upper] - lm_mh[upper].mean(0), (R @ (lm_g[upper] - lm_g[upper].mean(0)).T).T
s_ume = (A0 * B0).sum() / (B0 ** 2).sum()
# leaning to the eye spacing: on a 6'3" frame the head should read ~1/7.5 of stature, and the eye→chin match alone
# leaves it small; --head-scale / --head-width tune it further (width: across only, the face looked narrow)
s = s_ipd ** 0.75 * s_len ** 0.25 * A.head_scale
WID = np.array([A.head_width, 1.0, 1.0])
print(f'scale candidates: eyes {s_ipd:.4f}, eye→chin {s_len:.4f}, upper face {s_ume:.4f} → {s:.4f}')
eye_g = (lm_g[IRIS[0]] + lm_g[IRIS[1]]) / 2; eye_lmh = (lm_mh[IRIS[0]] + lm_mh[IRIS[1]]) / 2
t = eye_lmh - s * (R @ eye_g) * WID
def place(P): return (s * (R @ P.T)).T * WID + t
FV = place(GV); FN = (R @ GN.T).T / WID; FN /= np.linalg.norm(FN, axis=1, keepdims=True)
lm_f = place(lm_g)
# his hair lies fairly flat (3-5 cm, swept back): the generator's is a tall bush. Squash everything above the
# visor band down so the top sits ~1.3 cm over a skull of the body's size, and press the hair in round the band
eyeYf = (lm_f[468, 1] + lm_f[473, 1]) / 2
yb = eyeYf + 0.045
top_now, top_want = FV[:, 1].max(), eyeYf + A.hair_top
kq = (top_want - yb) / max(top_now - yb, 1e-6)
def flatten(P):
    P = P.copy(); up = P[:, 1] > yb
    P[up, 1] = yb + (P[up, 1] - yb) * kq
    # round the band: pull the hair (sides and back, not the forehead) 4 mm in toward the skull's axis
    cz_ = (FV[:, 2].min() + FV[:, 2].max()) / 2
    a_ = np.abs(np.arctan2(P[:, 0], P[:, 2] - cz_))
    w_ = np.clip((a_ - np.radians(35)) / np.radians(25), 0, 1) * np.clip(1 - np.abs(P[:, 1] - (yb + 0.008)) / 0.03, 0, 1)
    d_ = P[:, [0, 2]] - [0, cz_]; r_ = np.linalg.norm(d_, axis=1, keepdims=True) + 1e-9
    P[:, [0, 2]] -= d_ / r_ * (0.004 * w_)[:, None]
    return P
FV = flatten(FV); lm_f = flatten(lm_f)

# ── face shape: the generator (and the unwrap) make the face rounder and wider than he is. Fit a landmark-guided
#    reshape (overall width, temples, cheeks/jaw below the cheekbones, chin, length below the nose) so the face's
#    proportions, seen from the portrait's own camera, match the portrait's (same MediaPipe landmarks both sides) ──
RAT = {  # name: (pair a, pair b, normaliser)
    'cheek width / face height': ((234, 454), 'FH'),
    'jaw width / cheek width': ((172, 397), 'BZ'),
    'chin width / cheek width': ((148, 377), 'BZ'),
    'nose→chin / face height': ((2, 152), 'FH'),
    'temple width / cheek width': ((54, 284), 'BZ'),
    'nose width (alae) / cheek width': ((98, 327), 'BZ'),
}
def ratios(p2):
    FH = np.linalg.norm(p2[10] - p2[152]); BZ = np.linalg.norm(p2[234] - p2[454])
    return np.array([np.linalg.norm(p2[a] - p2[b]) / (FH if n == 'FH' else BZ) for (a, b), n in RAT.values()])
ref_img = np.asarray(Image.open(photos[0]).convert('RGB'))
lm_ref = landmarks(ref_img); r_ref = ratios(lm_ref)
okr = ~np.isnan(lm_f).any(1)
Hh_, Ww_ = ref_img.shape[:2]
def cam_fit(L3):
    best = None
    for fm in (1.2, 1.6, 2.0, 2.6, 3.4):
        K = np.array([[fm * Ww_, 0, Ww_ / 2], [0, fm * Ww_, Hh_ / 2], [0, 0, 1]])
        okp, rv, tv = cv2.solvePnP(L3[okr], lm_ref[okr], K, None, flags=cv2.SOLVEPNP_EPNP)
        rv, tv = cv2.solvePnPRefineLM(L3[okr], lm_ref[okr], K, None, rv, tv)
        pr = cv2.projectPoints(L3, rv, tv, K, None)[0][:, 0]; err = np.median(np.linalg.norm(pr[okr] - lm_ref[okr], axis=1))
        if best is None or err < best[0]: best = (err, pr, K, rv, tv)
    return best[1]
def cam_full(L3):
    best = None
    for fm in (1.2, 1.6, 2.0, 2.6, 3.4):
        K = np.array([[fm * Ww_, 0, Ww_ / 2], [0, fm * Ww_, Hh_ / 2], [0, 0, 1]])
        okp, rv, tv = cv2.solvePnP(L3[okr], lm_ref[okr], K, None, flags=cv2.SOLVEPNP_EPNP)
        rv, tv = cv2.solvePnPRefineLM(L3[okr], lm_ref[okr], K, None, rv, tv)
        pr = cv2.projectPoints(L3, rv, tv, K, None)[0][:, 0]; err = np.median(np.linalg.norm(pr[okr] - lm_ref[okr], axis=1))
        if best is None or err < best[0]: best = (err, pr, K, cv2.Rodrigues(rv)[0], tv[:, 0])
    return best[1:]
yN, yC, yZ = lm_f[2, 1], lm_f[152, 1], (lm_f[234, 1] + lm_f[454, 1]) / 2
ear_zf = min(lm_f[234, 2], lm_f[454, 2])
def sstep(a, b, x): t = np.clip((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t)
_eb = FV[(FV[:, 1] > lm_f[13, 1]) & (FV[:, 1] < eyeYf + 0.01)]
ear_tips = [(sx_, _eb[np.argmax(_eb[:, 0] * sx_)].copy()) for sx_ in (-1, 1)]
def reshape(P, q):
    wid, temple, jaw, chin, lower, nose = q[:6]; mid = q[6] if len(q) > 6 else 1.0
    P = P.copy(); x, y, z = P[:, 0], P[:, 1], P[:, 2]
    front = sstep(ear_zf - 0.03, ear_zf + 0.01, z)                       # the face, not the back of the head
    tj = sstep(yZ, yC + 0.012, y)                                        # 0 at the cheekbones, 1 at the jaw line
    tc = sstep(yC + 0.035, yC, y) * np.exp(-(x / 0.03) ** 2 * 0.5)      # the chin
    tt = np.exp(-((y - (eyeYf + 0.035)) / 0.022) ** 2) * front           # the temples
    S = wid * (1 + (temple - 1) * tt) * (1 + (jaw - 1) * tj * (0.4 + 0.6 * front)) * (1 + (chin - 1) * tc)
    tn_ = np.exp(-((y - (yN + 0.006)) / 0.012) ** 2 - (x / 0.028) ** 2) * sstep(lm_f[2, 2] - 0.03, lm_f[2, 2] - 0.01, z)   # the nose
    S = S * (1 + (nose - 1) * tn_)
    P[:, 0] = x * S
    # the ears stand out a little more (the portrait's outline shows them further from the head)
    # ears: his sit close to the head and angle back (his front selfies show mostly the rim): swing each ear back
    # about its root and bring it in (the generator's stand out like handles)
    for sx_, tip_ in ear_tips:
        root_ = tip_ - np.array([sx_ * 0.02, 0, 0])
        we_ = np.clip(1 - np.linalg.norm(P - tip_, axis=1) / 0.035, 0, 1) ** 1.2 * (P[:, 0] * sx_ > abs(tip_[0]) - 0.022)
        th_ = sx_ * A.ear_back * we_; d_ = P - root_
        x2 = d_[:, 0] * np.cos(th_) + d_[:, 2] * np.sin(th_); z2 = -d_[:, 0] * np.sin(th_) + d_[:, 2] * np.cos(th_)
        x2 = x2 * (1 - (1 - A.ear_out) * we_)
        P[:, 0] = root_[0] + x2; P[:, 2] = root_[2] + z2
    # (no hollow under the cheekbones: the user wants the cheeks fuller)
    # fuller cheeks where his smile lifts them (the apples, upper/mid cheek), the jaw below stays defined
    apple = np.exp(-(((np.abs(x) - 0.036) / 0.016) ** 2 + ((y - (yN + 0.002)) / 0.016) ** 2)) * front
    P[:, 2] += A.cheek_fill * apple; P[:, 0] += np.sign(x) * 0.6 * A.cheek_fill * apple
    # a slightly taller forehead (the hairline sits higher above the brows)
    fh_ = sstep(eyeYf + 0.012, eyeYf + 0.04, y)
    P[:, 1] += (A.forehead - 1) * np.maximum(y - (eyeYf + 0.012), 0) * (1 - fh_) + (A.forehead - 1) * 0.028 * fh_
    # lengths: eye→nose base scaled by mid, below the nose by lower (the eyes stay put)
    midz = (y < eyeYf) & (y >= yN); below = y < yN
    P[midz, 1] = eyeYf - (eyeYf - y[midz]) * mid
    P[below, 1] = eyeYf - (eyeYf - yN) * mid - (yN - y[below]) * lower
    return P
from scipy.optimize import least_squares
r0 = ratios(cam_fit(lm_f))
# ── his own photos (front, 3/4, smiling, selfies; neil.json face.views + faceShape.photos) plus the portrait: one
#    shape fitted to all of them at once. Each photo gets its own camera (focal from a sweep, pose by PnP); the shape
#    parameters minimise the landmark reprojection error over every view, real photos weighted highest ──
STABLE = np.ones(478, bool)
for i_ in [0, 267, 269, 270, 409, 37, 39, 40, 185, 17, 314, 405, 321, 375, 84, 181, 91, 146, 13, 14, 312, 311, 310, 415, 82, 81, 80, 191, 317, 402, 318, 324, 87, 178, 88, 95, 78, 308, 61, 291]: STABLE[i_] = False   # lips: the expressions differ
for i_ in [159, 145, 160, 144, 158, 153, 157, 154, 386, 374, 387, 373, 385, 380, 384, 381] + list(range(468, 478)): STABLE[i_] = False   # lids and irises
views = []
try:
    cfg_ = json.load(open(os.path.join(HERE, 'neil.json')))
    seen_ = set()
    for v_ in cfg_['face'].get('views', []) + cfg_.get('faceShape', {}).get('photos', []):
        if v_['photo'] in seen_ or not os.path.exists(v_['photo'] + '.lm.json'): continue
        seen_.add(v_['photo'])
        L_ = json.load(open(v_['photo'] + '.lm.json')); P2_ = np.array(L_['pts'], float)[:, :2]; W_, H_ = L_['size']
        real = 'portrait' not in os.path.basename(v_['photo'])
        views.append({'photo': v_['photo'], 'lm': P2_, 'W': W_, 'H': H_, 'w': (2.0 if real else 0.6) * v_.get('weight', 1.0), 'real': real})
except Exception as e_:
    print('  (no photo views:', e_, ')')
okv = ~np.isnan(lm_f).any(1) & STABLE
def view_cam(L3, v, init=None):
    """focal (sweep, first time) + pose for one photo; returns projected landmarks and the camera"""
    W_, H_ = v['W'], v['H']; best = None
    for fm in ([v['fm']] if 'fm' in v else (0.7, 0.85, 1.0, 1.2, 1.6, 2.0, 2.6, 3.4)):
        K = np.array([[fm * max(W_, H_), 0, W_ / 2], [0, fm * max(W_, H_), H_ / 2], [0, 0, 1]])
        if init is not None and 'fm' in v: okp, rv, tv = cv2.solvePnP(L3[okv], v['lm'][okv], K, None, init[0].copy(), init[1].copy(), True, cv2.SOLVEPNP_ITERATIVE)
        else:
            okp, rv, tv, inl = cv2.solvePnPRansac(L3[okv], v['lm'][okv], K, None, reprojectionError=0.02 * np.linalg.norm(v['lm'][10] - v['lm'][152]), iterationsCount=300, flags=cv2.SOLVEPNP_EPNP)
            if not okp: continue
            rv, tv = cv2.solvePnPRefineLM(L3[okv], v['lm'][okv], K, None, rv, tv)
        pr = cv2.projectPoints(L3, rv, tv, K, None)[0][:, 0]
        err = np.median(np.linalg.norm(pr[okv] - v['lm'][okv], axis=1))
        if best is None or err < best[0]: best = (err, fm, pr, K, rv, tv)
    return best
def mv_resid(L3, cams=None):
    out_ = []
    for k_, v in enumerate(views):
        b_ = view_cam(L3, v, cams[k_] if cams else None)
        fpx = np.linalg.norm(v['lm'][10] - v['lm'][152])
        r_ = np.linalg.norm(b_[2][okv] - v['lm'][okv], axis=1) / fpx
        r_ = np.minimum(r_, 0.08)                                   # a mis-detected landmark can't dominate
        out_.append(r_ * math.sqrt(v['w'] / okv.sum()))
    return np.concatenate(out_)
def mv_report(L3, tag):
    rep = []
    for v in views:
        b_ = view_cam(L3, v); fpx = np.linalg.norm(v['lm'][10] - v['lm'][152])
        rep.append((os.path.basename(v['photo']), float(np.median(np.linalg.norm(b_[2][okv] - v['lm'][okv], axis=1)) / fpx * 100)))
    print(f'  {tag}: landmark error (median, % of face height): ' + ', '.join(f'{n[:8]} {e:.2f}' for n, e in rep))
    return rep
if A.reshape and views:
    for v in views:                                                  # fix each photo's focal at the start shape
        b_ = view_cam(lm_f, v); v['fm'] = b_[1]
    mv_before = mv_report(lm_f, 'before')
    q0 = np.array([A.head_width_face, 1.0, 1.0, 1.0, A.face_length, 1.0, 1.0])
    def resid(q): return np.r_[mv_resid(reshape(lm_f, q)), 0.02 * np.log(q)]
    fit = least_squares(resid, q0, bounds=([0.88, 0.88, 0.8, 0.75, 0.95, 0.9, 0.95], [1.06, 1.08, 1.08, 1.1, 1.15, 1.15, 1.1]), diff_step=2e-3, max_nfev=60)
    qf = fit.x
    # the user reads the face as short: never shorter below the nose than the fit's own answer or his 'face-length'
    FV = reshape(FV, qf); lm_f = reshape(lm_f, qf)
    mv_after = mv_report(lm_f, 'after')
    print('face shape from %d views: width %.3f, temples %.3f, jaw %.3f, chin %.3f, below the nose %.3f, nose width %.3f, eye→nose %.3f' % ((len(views),) + tuple(qf)))
    mv_cams = []
    for v in views:
        b_ = view_cam(lm_f, v)
        mv_cams.append({'photo': v['photo'], 'K': b_[3].tolist(), 'R': cv2.Rodrigues(b_[4])[0].tolist(), 't': b_[5][:, 0].tolist(), 'real': v['real']})
    r1 = ratios(cam_fit(lm_f))
    if DBG: json.dump({'cams': mv_cams, 'before': mv_before, 'after': mv_after, 'q': list(map(float, qf))}, open(os.path.join(DBG, 'views.json'), 'w'))
elif A.reshape:
    q0 = np.array([A.head_width_face, 1.0, 1.0, 1.0, A.face_length, 1.0])
    def resid(q): return np.r_[np.log(ratios(cam_fit(reshape(lm_f, q))) / r_ref), 0.15 * np.log(q)]
    # the face reads round next to the portrait: keep it 2-5 % leaner overall and never shorten the lower face
    # (the landmarks put ours already a little long there); the rest is fitted to the portrait's proportions
    fit = least_squares(resid, q0, bounds=([0.95, 0.88, 0.8, 0.75, A.face_length, 0.95], [0.98, 1.06, 1.06, 1.06, A.face_length + 1e-4, 1.12]), diff_step=1e-3)
    qf = fit.x
    FV = reshape(FV, qf); lm_f = reshape(lm_f, qf)
    # ── then the outline: render our head with the portrait's camera and fit the far cheek/jaw contour to the
    #    portrait's (a smooth width profile over the lower face), twice ──
    hsv_r = cv2.cvtColor(ref_img, cv2.COLOR_RGB2HSV)
    paper = ((ref_img.min(2) > 200) & (hsv_r[..., 1] < 45)).astype(np.uint8)
    nl_, lab_ = cv2.connectedComponents(paper); el_ = set(lab_[0]) | set(lab_[-1]) | set(lab_[:, 0]) | set(lab_[:, -1]); el_.discard(0)
    fg_ref = ~np.isin(lab_, list(el_))
    r_top, r_bot = int(lm_ref[1, 1]), int(lm_ref[152, 1] - 8)
    def outline(V3, L3):
        _, K_, Rm_, tv_ = cam_full(L3)
        c_ = (Rm_ @ V3.T).T + tv_; p2_ = np.c_[K_[0, 0] * c_[:, 0] / c_[:, 2] + K_[0, 2], K_[1, 1] * c_[:, 1] / c_[:, 2] + K_[1, 2]]
        ids_ = raster(p2_, c_[:, 2], GF, Ww_, Hh_)
        return ids_ >= 0, ids_, p2_, c_, K_, Rm_
    sil_before = outline(FV, lm_f)[0]
    for it_ in range(2):
        m_, ids_, p2_, c_, K_, Rm_ = outline(FV, lm_f)
        ys_, ss_ = [], []
        for row in range(r_top, r_bot, 3):
            xs_p = np.nonzero(fg_ref[row, int(lm_ref[1, 0]):])[0]; xs_o = np.nonzero(m_[row, int(lm_ref[1, 0]):])[0]
            if not len(xs_p) or not len(xs_o): continue
            xp, xo = xs_p.max() + int(lm_ref[1, 0]), xs_o.max() + int(lm_ref[1, 0])
            t_ = ids_[row, xo]; v3 = FV[GF[t_]].mean(0); z3 = c_[GF[t_]].mean(0)[2]
            dx_local = (xp - xo) * z3 / K_[0, 0] / max(abs(Rm_[0, 0]), 0.3)
            if abs(v3[0]) < 0.02: continue
            ys_.append(v3[1]); ss_.append(1 + np.clip(dx_local / abs(v3[0]), -0.08, 0.08))
        if len(ys_) < 5: break
        o_ = np.argsort(ys_); ys_, ss_ = np.array(ys_)[o_], np.array(ss_)[o_]
        ss_ = np.convolve(np.pad(ss_, 3, mode='edge'), np.ones(7) / 7, mode='valid')
        def prof(y): return np.interp(y, ys_, ss_, left=ss_[0], right=ss_[-1])
        def outl(P):
            P = P.copy(); fr_ = sstep(ear_zf - 0.03, ear_zf + 0.01, P[:, 2])
            band_ = sstep(yC + 0.008, yC + 0.022, P[:, 1]) * sstep(yN + 0.03, yN, P[:, 1])   # cheeks and jaw, not the chin
            P[:, 0] *= 1 + (prof(P[:, 1]) - 1) * fr_ * band_
            return P
        FV = outl(FV); lm_f = outl(lm_f)
        print(f'  outline fit {it_ + 1}: width profile {ss_.min():.3f}..{ss_.max():.3f} over {len(ys_)} rows')
    sil_after = outline(FV, lm_f)[0]
    if DBG:
        ov_ = ref_img.astype(np.uint8).copy()
        for msk, colr in ((sil_before, (230, 40, 40)), (sil_after, (40, 200, 60))):
            cs_, _ = cv2.findContours(msk.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
            cv2.drawContours(ov_, cs_, -1, colr, 2)
        Image.fromarray(ov_).save(os.path.join(DBG, 'outline_overlay.png'))
    r1 = ratios(cam_fit(lm_f))
    print('face reshape: width %.3f, temples %.3f, jaw %.3f, chin %.3f, length below the nose %.3f, nose width %.3f' % tuple(qf))
else:
    qf = None; r1 = r0
ratio_table = {k: {'portrait': float(a), 'before': float(b), 'after': float(c)} for k, a, b, c in zip(RAT, r_ref, r0, r1)}
def nose_m(p2):
    FH = np.linalg.norm(p2[10] - p2[152]); BZ = np.linalg.norm(p2[234] - p2[454])
    return {'nose length (bridge→base) / face height': np.linalg.norm(p2[168] - p2[2]) / FH, 'nose width (alae) / cheek width': np.linalg.norm(p2[98] - p2[327]) / BZ}
nm_ref, nm_now = nose_m(lm_ref), nose_m(cam_fit(lm_f))
for k in nm_ref:
    if k not in ratio_table: ratio_table[k] = {'portrait': float(nm_ref[k]), 'before': None, 'after': float(nm_now[k])}
for k, v in ratio_table.items():
    bt = f"{v['before']:.3f} ({(v['before'] / v['portrait'] - 1) * 100:+.1f}%)" if v['before'] is not None else '  -  '
    print(f"  {k:28s} portrait {v['portrait']:.3f}  ours before {bt}  after {v['after']:.3f} ({(v['after'] / v['portrait'] - 1) * 100:+.1f}%)")
print(f'hair: top {top_now - eyeYf:.3f} m above the eyes → {top_want - eyeYf:.3f} (above-band scale {kq:.2f})')
res = np.linalg.norm(lm_f[upper] - lm_mh[upper], axis=1)
ang = np.degrees(np.arctan2(R[2, 1], R[1, 1]))
print(f'fit: scale {s:.4f} m/unit, pitch {ang:.1f}°, eye spacing {ipd_mh * 1000:.1f} mm (landmark {ipd_lm_mh * 1000:.1f}), upper-face rms {np.sqrt((res ** 2).mean()) * 1000:.1f} mm')
print('  per-axis upper-face offset (mm)', ((lm_f[upper] - lm_mh[upper]).mean(0) * 1000).round(1), 'rms', (np.sqrt(((lm_f[upper] - lm_mh[upper]) ** 2).mean(0)) * 1000).round(1))
print('  generated bounds', FV.min(0).round(3), FV.max(0).round(3), '| makehuman head', SP[SP[:, 1] > chin_m[1] if False else lm_mh[152, 1] - 0.0].min(0).round(3) if False else '')
mhh = SP[(SP[:, 1] > lm_mh[152, 1]) & keep]; print('  makehuman above chin', mhh.min(0).round(3), mhh.max(0).round(3))
# head height: chin (152) to the top of the head
chin_g, chin_m = lm_f[152], lm_mh[152]
top_g = FV[:, 1].max()
top_m = max(SP[keep, 1].max(), arr(M['meshes']['hair']['position']).reshape(-1, 3)[:, 1].max())
print(f'head height chin→top: generated {(top_g - chin_g[1]) * 1000:.0f} mm, makehuman (with hair shell) {(top_m - chin_m[1]) * 1000:.0f} mm; chin y {chin_g[1]:.3f} vs {chin_m[1]:.3f}')

# ───────────────────────── crop: head + upper neck, open at the bottom ─────────────────────────
# the generator closes the neck with a flat cap: drop it and anything below the neck cut
neck_c = np.array(M['joint'][nb])
y_cut_front = chin_m[1] - 0.035   # the seam: under the jaw at the front, rising slightly to the nape
cap = (FN[:, 1] < -0.85)
lowest = FV[:, 1].min()
capf = cap[GF].all(1) & (FV[GF][:, :, 1].max(1) < lowest + 0.012)
# and the generator's flared rim round the bottom of the neck stub: the loft below takes over from here
capf |= FV[GF][:, :, 1].min(1) < lowest + A.crop
# and everything below the neck cut (3.5 cm under the chin): a generator that went on down the neck (the Hunyuan3D-2.1
# head from his photo has a neck stub flaring into the shirt) would otherwise sit below the collar seam, its rim a flat
# 'bib' that swings out over the collar when he lifts his chin; the loft below grows the neck from this cut instead
capf |= FV[GF][:, :, 1].min(1) < y_cut_front
if A.neck == 'cap': capf[:] = False
GF2 = GF[~capf]
hm = trimesh.Trimesh(FV, GF2, process=False); hm.remove_unreferenced_vertices()
hm = max(hm.split(only_watertight=False), key=lambda m: len(m.faces))
print('cropped', len(hm.faces), 'tris; bottom y', round(hm.vertices[:, 1].min(), 3))

# ───────────────────────── mirror for left-handers (the whole golfer is drawn mirrored) ─────────────────────────
mirror = A.handed == 'left'
def mir(P): return P * np.array([-1, 1, 1]) if mirror else P

# ───────────────────────── decimate, then blend the neck into the body ─────────────────────────
LV, LF = fast_simplification.simplify(np.asarray(hm.vertices), np.asarray(hm.faces, np.int64), target_count=A.tris)[:2]
lo = trimesh.Trimesh(LV, LF, process=True); lo.remove_unreferenced_vertices()
LV, LF = np.asarray(lo.vertices, float).copy(), np.asarray(lo.faces, np.int64)
print('decimated', len(LF), 'tris,', len(LV), 'verts')
# calm the hair's spiky relief (decimated spikes fold over and shade black); the face stays as generated
eyeY0 = (lm_f[468, 1] + lm_f[473, 1]) / 2
hairish = np.clip((LV[:, 1] - (eyeY0 + 0.05)) / 0.02, 0, 1)
hairish = np.maximum(hairish, np.clip(((eye_lmh[2] - 0.08) - LV[:, 2]) / 0.02, 0, 1) * np.clip((LV[:, 1] - (eyeY0 - 0.06)) / 0.02, 0, 1))
nbr = [[] for _ in range(len(LV))]
for a_, b_, c_ in LF: nbr[a_] += [b_, c_]; nbr[b_] += [a_, c_]; nbr[c_] += [a_, b_]
nbr = [np.unique(n_) for n_ in nbr]
for it in range(14):
    lap = np.array([LV[n_].mean(0) - LV[i] if len(n_) else np.zeros(3) for i, n_ in enumerate(nbr)])
    LV += (0.5 if it % 2 == 0 else -0.53) * lap * hairish[:, None]   # Taubin: smooth without shrinking
# a bit more length on top (his hair is longer on top, swept back), most at the front of the crown
_vn0 = vnormals(LV, LF)
lift = np.clip((LV[:, 1] - (eyeY0 + 0.07)) / 0.04, 0, 1) ** 1.2 * (0.7 + 0.3 * np.clip((LV[:, 2] - (eye_lmh[2] - 0.12)) / 0.1, 0, 1))
LV += _vn0 * (0.0 * lift)[:, None]   # (no extra lift: the hair is squashed flat above instead)
if A.neck == 'loft':
    # the generator cuts the head off flat at about chin level: grow a neck down from that cut to the body's own neck
    # (a loft from the cut ring to the body's neck surface just above the collar), so the seam lies on the body's skin
    edges = np.r_[LF[:, [0, 1]], LF[:, [1, 2]], LF[:, [2, 0]]]
    key = np.sort(edges, 1); ue, inv, cnt = np.unique(key, axis=0, return_inverse=True, return_counts=True)
    bed = edges[cnt[inv] == 1]                          # boundary edges, with the faces' direction
    nxt = {int(a): int(b) for a, b in bed}
    loops, seen = [], set()
    for s0 in nxt:
        if s0 in seen: continue
        lp = [s0]; seen.add(s0); c_ = nxt[s0]
        while c_ != s0 and c_ not in seen and c_ in nxt: lp.append(c_); seen.add(c_); c_ = nxt[c_]
        loops.append(lp)
    loop = max(loops, key=len)
    print('cut ring', len(loop), 'verts (', len(loops), 'boundary loops)')
    collar = np.array(M['collar'])
    # the seam follows the collar (low at the front, high at the back, so it stays under the polo at the back and sides)
    cz = np.polyfit(collar[:, 2], collar[:, 1], 1)
    def y_seam_at(z): return cz[0] * z + cz[1] + 0.01
    neck_z = SP[(np.abs(SP[:, 1] - (y_seam_at(SP[:, 2]) - 0.012)) < 0.008) & (np.abs(SP[:, 0]) < 0.062)]   # the neck itself, not the shoulders
    axis_c = np.array([0.0, (neck_z[:, 2].min() + neck_z[:, 2].max()) / 2])
    neckv = neck_z
    na = np.arctan2(neckv[:, 0] - axis_c[0], neckv[:, 2] - axis_c[1]); nr = np.hypot(neckv[:, 0] - axis_c[0], neckv[:, 2] - axis_c[1])
    def neck_r(a):
        da = np.abs((na - a + np.pi) % (2 * np.pi) - np.pi); sel = da < 0.15
        return np.percentile(nr[sel], 50) if sel.sum() > 2 else np.median(nr)   # the body's neck surface there (its median radius)
    top = LV[loop]
    ta = np.arctan2(top[:, 0] - axis_c[0], top[:, 2] - axis_c[1])
    OVER = 0.012   # the neck runs on past the seam, down inside the collar, over the body's neck
    bot = np.array([[axis_c[0] + math.sin(a) * (neck_r(a) - 0.003), 0, axis_c[1] + math.cos(a) * (neck_r(a) - 0.003)] for a in ta])
    # (3 mm INSIDE the body's neck: below the seam the body skin and the collar cover it, never a bib in front of the shirt)
    bot[:, 1] = np.minimum(y_seam_at(bot[:, 2]) - OVER, top[:, 1] - 0.025)   # at the back the collar rides high: the neck still runs down
    assert np.all(bot[:, 1] > top[:, 1].min() - 0.12), 'neck loft runs away below the collar'
    # smooth the bottom ring a little round the neck
    for _ in range(3): bot = 0.5 * bot + 0.25 * (np.roll(bot, 1, 0) + np.roll(bot, -1, 0))
    ROWS = 7
    rows = [np.array(loop)]
    Lv = list(LV)
    for r_ in range(1, ROWS + 1):
        u = r_ / ROWS
        # Hermite: leave the cut heading straight down, arrive at the neck heading straight down
        h00, h10, h01, h11 = 2 * u ** 3 - 3 * u ** 2 + 1, u ** 3 - 2 * u ** 2 + u, -2 * u ** 3 + 3 * u ** 2, u ** 3 - u ** 2
        Ld = np.linalg.norm(bot - top, axis=1, keepdims=True)
        # leave the cut heading toward the neck (under the jaw the neck tucks in), arrive heading straight down
        t0 = (bot - top) * 0.8; t1 = np.array([0, -1.0, 0]) * Ld
        pts = h00 * top + h10 * t0 + h01 * bot + h11 * t1
        rows.append(np.arange(len(Lv), len(Lv) + len(pts))); Lv.extend(pts)
    LV = np.array(Lv)
    nf = []
    for r_ in range(ROWS):
        a, b = rows[r_], rows[r_ + 1]
        for i in range(len(loop)):
            j = (i + 1) % len(loop)
            # boundary edge a[i]→a[j] runs with its face; the new faces run against it
            nf += [[a[j], a[i], b[i]], [a[j], b[i], b[j]]]
    LF = np.r_[LF, np.array(nf, np.int64)]
    lo = trimesh.Trimesh(LV, LF, process=False)
    cen = np.array([axis_c[0], y_seam_at(axis_c[1]), axis_c[1]]); pn = np.array([0, 1.0, -cz[0]]); pn /= np.linalg.norm(pn)
    print('neck loft', len(nf), 'tris from y', round(top[:, 1].mean(), 3), 'down to', round(cen[1], 3), '(tilt', round(math.degrees(math.atan(cz[0])), 1), '°); head now', len(LF), 'tris')
    hgt = (LV - cen) @ pn
    BAND = float(((top - cen) @ pn).mean())   # from the seam up to the cut           # the loft's height: weights and colour blend over it
else:
    # keep the generator's own flat cap under the jaw: the body's neck rises into the head from below (its skin is
    # discarded a few mm inside the cap), so the jaw line and the neck are the real ones, not a lofted tube
    cap_y = LV[:, 1].min()
    nkv = SP[(np.abs(SP[:, 1] - cap_y) < 0.008) & (np.abs(SP[:, 0]) < 0.075)]
    cen = np.array([0.0, cap_y + 0.006, (nkv[:, 2].min() + nkv[:, 2].max()) / 2]); pn = np.array([0, 1.0, 0])
    hgt = (LV - cen) @ pn
    BAND = 0.012
    print('neck: generator cap kept at y', round(cap_y, 3), '; the body neck shows below it')

# skin weights: the body's own weights at the seam, all head from the cut up
tree = cKDTree(SP)
_, nn = tree.query(LV)
wts = []
kk = np.clip(hgt / BAND, 0, 1); kk = kk * kk * (3 - 2 * kk)
# with the jaw cap the body's own neck rises into the head: the head is rigid on the head bone (blending the jaw's
# underside into neck weights pulled the chin about as the neck bent through the swing)
if A.neck == 'cap':
    # rigid, except the back of the neck stub: there the bottom 3 cm blends into the body's neck weights so the flat
    # cap never swings out from behind when he looks down at the ball (the chin and jaw stay rigid)
    backw = sstep(cen[2] + 0.02, cen[2] - 0.01, LV[:, 2])
    kk = 1 - (1 - np.clip((hgt + 0.006) / 0.03, 0, 1) ** 1.5) * backw
for i in range(len(LV)):
    w = {}
    for j in range(4):
        if SW[nn[i], j] > 0: w[int(SI[nn[i], j])] = w.get(int(SI[nn[i], j]), 0) + float(SW[nn[i], j]) * (1 - kk[i])
    w[hb] = w.get(hb, 0) + kk[i]
    top_ = sorted(w.items(), key=lambda x: -x[1])[:4]; tot = sum(v for _, v in top_)
    wts.append([(b_, v / tot) for b_, v in top_] + [(0, 0.0)] * (4 - len(top_)))
used = sorted({b_ for w in wts for b_, v in w if v > 0} | {hb})
print('weights use bones', [B[i] for i in used])

# decimation folds a few hair spikes over: turn those faces back to agree with the surface (else they cull to holes)
_fn = np.cross(LV[LF[:, 1]] - LV[LF[:, 0]], LV[LF[:, 2]] - LV[LF[:, 0]])
_vn = vnormals(LV, LF)
flip = np.einsum('ij,ij->i', _fn, _vn[LF].sum(1)) < 0
LF[flip] = LF[flip][:, ::-1]
print('flipped', int(flip.sum()), 'folded faces')
# ───────────────────────── expressions: MakeHuman's expression units, transferred onto this head ─────────────────────────
# MakeHuman skin vertex → base-mesh vertex (by UV), its target deltas → the body's units (fitted against the baked smile),
# the MakeHuman head warped onto ours by the face landmarks (thin-plate), and each of our vertices takes the deltas of
# the nearest warped MakeHuman vertices.
EXPR = {
    'blink': {'eye-left-closure': 1.0, 'eye-right-closure': 1.0},
    'smile': {'mouth-corner-puller': 0.8, 'mouth-upward-retraction': 0.35, 'eye-left-slit': 0.25, 'eye-right-slit': 0.25},
    'grimace': {'mouth-depression-retraction': 0.6, 'mouth-retraction': 0.3, 'neck-platysma': 0.5, 'eyebrows-left-down': 0.5, 'eyebrows-right-down': 0.5, 'eye-left-slit': 0.4, 'eye-right-slit': 0.4},
    'browUp': {'eyebrows-left-up': 1.0, 'eyebrows-right-up': 1.0},
    'browDown': {'eyebrows-left-down': 0.8, 'eyebrows-right-down': 0.8, 'eyebrows-left-inner-up': 0.2, 'eyebrows-right-inner-up': 0.2},
    'jawOpen': {'mouth-open': 0.5},
    # visemes (with jawOpen and smile): rounded O/U, wide E/I, F/V (lower lip up under the teeth), M/B/P (lips pressed)
    'pucker': {'mouth-pursing': 0.7, 'mouth-protusion': 0.5},
    'wide': {'mouth-retraction': 0.7, 'mouth-corner-puller': 0.15},
    'lipIn': {'mouth-elevation': 0.6},
    'press': {'mouth-compression': 0.6},
}
morph_d = {}
base_obj = os.path.join(A.mpfb, '3dobjs/base.obj')
if os.path.exists(base_obj):
    import gzip
    from scipy.interpolate import RBFInterpolator
    bvt, vt2v = [], {}
    for line in open(base_obj):
        if line.startswith('vt '): bvt.append([float(a) for a in line.split()[1:3]])
        elif line.startswith('f '):
            for q_ in line.split()[1:]:
                a_ = q_.split('/'); vt2v[int(a_[1]) - 1] = int(a_[0]) - 1
    bvt = np.array(bvt)
    duv, jvt = cKDTree(bvt).query(SUV.astype(float))
    skin2base = np.array([vt2v.get(int(j), -1) for j in jvt])
    print(f'makehuman skin→base by uv: max uv miss {duv.max():.2e}, unmapped {(skin2base < 0).sum()}')
    def tgt(name):
        d = {}
        with gzip.open(os.path.join(A.mpfb, f'targets/expression/units/caucasian/{name}.target.gz'), 'rt') as fh:
            for line in fh:
                if line.strip() and line[0] != '#': a_ = line.split(); d[int(a_[0])] = [float(a_[1]), float(a_[2]), float(a_[3])]
        out = np.zeros((len(SP), 3))
        for i, bv in enumerate(skin2base):
            if bv in d: out[i] = d[bv]
        return out
    # units: fit the baked smile morph
    try:
        sm = json.load(open(os.path.join(HERE, 'neil.json')))['expressions']['smile']
        rec = sum(w * tgt(k.split('/')[-1]) for k, w in sm.items() if w)
        stored = arr(sk['morph_smile']).reshape(-1, 3).astype(float)
        kunit = float((rec * stored).sum() / max((rec * rec).sum(), 1e-12))
    except Exception as e_:
        print('  (no smile to fit units against:', e_, ')'); kunit = 0.1 * 1.0
    print(f'target units → metres: {kunit:.5f}')
    # the MakeHuman head warped onto ours by the landmarks
    okw = ~np.isnan(lm_mh).any(1) & ~np.isnan(lm_f).any(1)
    warp = RBFInterpolator(lm_mh[okw], lm_f[okw], kernel='thin_plate_spline', smoothing=1e-5, degree=1)
    headv = np.nonzero(SP[:, 1] > lm_mh[152, 1] - 0.04)[0]
    WV = warp(SP[headv])
    dq, iq = cKDTree(WV).query(LV, k=6)
    wq = 1 / (dq + 1e-4); wq /= wq.sum(1, keepdims=True)
    reach = np.clip((0.014 - dq[:, 0]) / 0.008, 0, 1)        # only where the warped MakeHuman face lies on ours
    # the painted teeth: inside the inner lip line (seen from the front), a little in front of the mouth's depth
    INNER = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95]
    poly = (lm_f[INNER][:, :2] * 1e4).astype(np.float32)
    sd = np.array([cv2.pointPolygonTest(poly, (float(px * 1e4), float(py * 1e4)), True) for px, py in LV[:, :2]]) / 1e4
    teeth_m = np.clip((sd + 0.003) / 0.003, 0, 1) * (np.abs(LV[:, 2] - lm_f[13, 2]) < 0.02)
    print('  teeth kept rigid:', int((teeth_m > 0.5).sum()), 'verts')
    reach *= np.clip(((LV - cen) @ pn - BAND) / 0.01, 0, 1)  # nothing on the neck loft
    for name, parts in EXPR.items():
        d = sum(w * tgt(k) for k, w in parts.items()) * kunit
        dv = (d[headv][iq] * wq[..., None]).sum(1) * reach[:, None]
        if A.rest == 'grin' and name in ('grimace', 'jawOpen', 'smile'): dv *= (1 - teeth_m)[:, None]   # painted teeth stay rigid (only with the open-grin texture)
        morph_d[name] = dv
        print(f'  expression {name}: {int((np.linalg.norm(dv, axis=1) > 2e-4).sum())} verts move, max {np.linalg.norm(dv, axis=1).max() * 1000:.1f} mm')
else:
    print('(no MakeHuman data at', A.mpfb, '- no expressions)')
# two shaped by hand round his own mouth: lift the corners (a pleasant rest), and draw the pouty lower lip in
if len(morph_d) or True:
    mc_l, mc_r, up_, lo_ = lm_f[61], lm_f[291], lm_f[13], lm_f[14]
    cl = np.zeros_like(LV)
    for c_ in (mc_l, mc_r):
        w_ = np.exp(-(np.linalg.norm((LV - c_ - [0, 0.002, 0]) * [1, 1.2, 1], axis=1) / 0.014) ** 2) * (LV[:, 2] > c_[2] - 0.02)
        cl += w_[:, None] * np.array([np.sign(c_[0] - (mc_l[0] + mc_r[0]) / 2) * 0.002, 0.005, -0.0008])   # up, out and a touch back, as the zygomaticus pulls
    morph_d['cornerLift'] = cl
    seam_y = (up_[1] + lo_[1]) / 2; half_w = abs(mc_r[0] - mc_l[0]) / 2
    ll = np.exp(-((LV[:, 0] - (mc_l[0] + mc_r[0]) / 2) / (half_w * 0.75)) ** 2 * 1.5) * np.exp(-((LV[:, 1] - (seam_y - 0.006)) / 0.006) ** 2) * (LV[:, 2] > up_[2] - 0.015)
    morph_d['unpout'] = ll[:, None] * np.array([0, 0.0008, -0.0018])
    print('  rest-mouth morphs: corner lift 5 mm (2 mm out), lower lip in 1.8 mm')
# the rest face: ease the generator's grin toward a relaxed smile before anything is painted on it (the low-res mesh,
# the hi-res surface the texture is projected onto, and the landmarks all move together)
if A.rest == 'closed' and 'smile' in morph_d and A.rest_smile:
    d_lv = morph_d['smile'] * A.rest_smile
    _hv = np.asarray(hm.vertices).copy(); dq_, iq_ = cKDTree(LV).query(_hv, k=4); wq_ = 1 / (dq_ + 1e-4); wq_ /= wq_.sum(1, keepdims=True)
    _hv += (d_lv[iq_] * wq_[..., None]).sum(1); hm = trimesh.Trimesh(_hv, np.asarray(hm.faces), process=False)
    dq_, iq_ = cKDTree(LV).query(lm_f, k=4); wq_ = 1 / (dq_ + 1e-4); wq_ /= wq_.sum(1, keepdims=True)
    lm_f = lm_f + (d_lv[iq_] * wq_[..., None]).sum(1)
    LV = LV + d_lv
    print(f'  rest smile {A.rest_smile:+.2f} of the smile unit (before the bake)')
# ── the lips part: split the mesh along the lip seam (a mesh path from corner to corner hugging the seam), so the
#    lower lip separates as the jaw opens and the mouth's inside (cavity, teeth, tongue: built in genhead.ts) shows ──
mouth_rig = None
STRIP_F0 = None
LIPIN = np.zeros(len(LV))            # inner-lip strips: 0 = face surface, >0 = depth into the mouth (0..1)
# ── local refinement helpers (red-green subdivision; new vertices carry weights and interpolated morphs) ──
def split_faces(LF_, emid):
    # red-green: each face re-triangulated by how many of its edges carry a new vertex (emid[(a, b)] -> id)
    out = []
    for f in LF_:
        f = [int(f[0]), int(f[1]), int(f[2])]
        m = [emid.get((min(f[i], f[(i + 1) % 3]), max(f[i], f[(i + 1) % 3]))) for i in range(3)]
        n = sum(x is not None for x in m)
        if n == 0: out.append(f); continue
        if n == 3:
            out += [[f[0], m[0], m[2]], [f[1], m[1], m[0]], [f[2], m[2], m[1]], [m[0], m[1], m[2]]]; continue
        if n == 1:
            k = [i for i in range(3) if m[i] is not None][0]
            w = [f[k], f[(k + 1) % 3], f[(k + 2) % 3]]; out += [[w[0], m[k], w[2]], [m[k], w[1], w[2]]]; continue
        k = [i for i in range(3) if m[i] is None][0]; r = (k + 1) % 3      # the unsplit edge goes to w[2]→w[0]
        w = [f[r], f[(r + 1) % 3], f[(r + 2) % 3]]; m01, m12 = m[r], m[(r + 1) % 3]
        out += [[m01, w[1], m12], [w[0], m01, m12], [w[0], m12, w[2]]]
    return np.array(out, np.int64)
def add_verts(P, pa, pb, t):
    # new vertices on edges (pa→pb at t): positions given, weights from the nearer end, morphs interpolated
    global LV, wts, LIPIN
    n0 = len(LV); LV = np.r_[LV, P]
    if len(LIPIN) == n0: LIPIN = np.r_[LIPIN, np.zeros(len(P))]
    wts = wts + [wts[a if tt_ < 0.5 else b] for a, b, tt_ in zip(pa, pb, t)]
    for k_ in morph_d: morph_d[k_] = np.r_[morph_d[k_], morph_d[k_][pa] * (1 - t)[:, None] + morph_d[k_][pb] * t[:, None]]
    return np.arange(n0, n0 + len(P))
hi_q = trimesh.proximity.ProximityQuery(hm)
def refine(mask_fn, rounds, tag):
    global LF
    for rnd in range(rounds):
        reg = mask_fn(LV, rnd)
        fsel = reg[LF].all(1)
        keys = np.unique(np.sort(np.r_[LF[fsel][:, [0, 1]], LF[fsel][:, [1, 2]], LF[fsel][:, [2, 0]]], 1), axis=0)
        P = (LV[keys[:, 0]] + LV[keys[:, 1]]) / 2
        cpt, cd, _ = hi_q.on_surface(P); ok = cd < 0.0006; P[ok] = cpt[ok]   # onto the hi-res surface where it lies close
        ids = add_verts(P, keys[:, 0], keys[:, 1], np.full(len(keys), 0.5))
        LF = split_faces(LF, {(int(a), int(b)): int(i) for (a, b), i in zip(keys, ids)})
        print(f'  {tag} subdivided: {int(fsel.sum())} faces → +{len(keys)} verts')
# ── the eyelids: a geometric blink. Each eye in its own frame (corners → across, up, forward), the eyeball's centre
#    9 mm behind the opening; the upper lid (from its margin up toward the crease) and the lower lid rotate about the
#    eyeball's horizontal axis, so they slide over its curve, until both margins meet 25 % of the way up the opening;
#    the eye surface under them sinks a little so the lids stay in front. Both eyes in one morph: they blink together. ──
EYES_LM = ((33, 133, [33, 246, 161, 160, 159, 158, 157, 173, 133], [33, 7, 163, 144, 145, 153, 154, 155, 133]),
           (362, 263, [362, 398, 384, 385, 386, 387, 388, 466, 263], [362, 382, 381, 380, 374, 373, 390, 249, 263]))
def eye_frame(ca, cb):
    c3 = (lm_f[ca] + lm_f[cb]) / 2; X = lm_f[cb] - lm_f[ca]; hw = np.linalg.norm(X) / 2; X = X / (2 * hw)
    Y = np.array([0, 1.0, 0]) - X * X[1]; Y /= np.linalg.norm(Y); Z = np.cross(X, Y)
    if Z[2] < 0: Z = -Z
    return c3, X, Y, Z, hw, c3 - Z * 0.009
if A.lids:
    for ca, cb, _, _ in EYES_LM:
        c3, X, Y, Z, hw, C = eye_frame(ca, cb)
        refine(lambda P, r, c3=c3, X=X, Y=Y, Z=Z, hw=hw: (np.abs((P - c3) @ X) < hw * 1.35) & ((P - c3) @ Y > -0.007) & ((P - c3) @ Y < 0.010) & ((P - c3) @ Z > -0.012), 2, 'eye region')
    lid = np.zeros_like(LV)
    for ca, cb, UPL, LOL in EYES_LM:
        c3, X, Y, Z, hw, C = eye_frame(ca, cb)
        d = LV - C; dx, dy, dz = d @ X, d @ Y, d @ Z
        phi, rho = np.arctan2(dy, dz), np.hypot(dy, dz)
        def contour(ids):
            q = lm_f[ids] - C; xs, ph = q @ X, np.arctan2(q @ Y, q @ Z); o = np.argsort(xs); return xs[o], ph[o]
        xu, pu = contour(UPL); xl, pl = contour(LOL)
        xm = (xu[0] + xu[-1]) / 2
        p_up, p_lo = np.interp(dx, xu, pu), np.interp(dx, xl, pl)
        p_meet = p_lo + 0.25 * (p_up - p_lo)
        wx = np.clip((hw * 1.25 - np.abs(dx - xm)) / (hw * 0.3), 0, 1)
        near = (np.linalg.norm(d, axis=1) < 0.024) & (dz > -0.002) & (wx > 0)
        # one continuous, monotonic remap of each vertex's angle (no fold, so no zig-zag where the landmark margin falls
        # between vertices): the upper lid (margin → 0.6 rad above) stretches down to the meeting curve, the lower lid
        # (margin → 0.45 rad below) up to it, and the eye surface between a margin and the meeting curve collapses onto
        # it, sinking 2 mm behind the lids
        DU, DL = 0.6, 0.45
        phi2 = phi.copy()
        up_l = (phi >= p_up) & (phi < p_up + DU)
        phi2[up_l] = (p_meet + (phi - p_up) * (p_up + DU - p_meet) / DU)[up_l]
        lo_l = (phi <= p_lo) & (phi > p_lo - DL)
        phi2[lo_l] = (p_meet - (p_lo - phi) * (p_meet - (p_lo - DL)) / DL)[lo_l]
        inside = (phi > p_lo) & (phi < p_up)
        phi2[inside] = p_meet[inside]
        # (blend the lid stretch out smoothly at its top/bottom so the crease doesn't kink)
        k_up = sstep(p_up + DU, p_up + 0.6 * DU, phi); k_lo = sstep(p_lo - DL, p_lo - 0.6 * DL, phi)
        phi2 = np.where(up_l, phi + (phi2 - phi) * np.maximum(k_up, (phi < p_up + 0.6 * DU)), phi2)
        phi2 = np.where(lo_l, phi + (phi2 - phi) * np.maximum(k_lo, (phi > p_lo - 0.6 * DL)), phi2)
        sink = np.minimum(np.clip((p_up - phi) / 0.06, 0, 1), np.clip((phi - p_lo) / 0.06, 0, 1)) * inside
        dphi = (phi2 - phi) * wx * near
        phi2 = phi + dphi
        rho2 = rho * (1 + 0.03 * (up_l | lo_l) * wx * near) - 0.002 * sink * wx * near
        nd = np.outer(dx, X) + (rho2 * np.sin(phi2))[:, None] * Y + (rho2 * np.cos(phi2))[:, None] * Z
        lid += np.where(near[:, None], nd - d, 0)
        print(f'  eyelids: {int((np.abs(dphi) > 1e-4).sum())} lid verts rotate (upper {np.degrees((p_meet - p_up).mean()):.0f}°, lower {np.degrees((p_meet - p_lo).mean()):+.0f}°), {int(inside.sum())} eye-surface verts sink')
    morph_d['blink'] = lid
if 'jawOpen' in morph_d:
    # ── the lips part along a smooth curve across the full mouth width (a symmetric even polynomial through the
    #    landmark seam and its mirror, so the opening is centred). The lip region is subdivided twice first
    #    (red-green, crack-free) so the cut runs through ~40 fresh vertices placed exactly on the curve; the lower lip
    #    takes copies of them. Inner-lip strips run back from each cut edge, so an open mouth shows lip, not a hole. ──
    UPIN, LOIN = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308], [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308]
    seam_pts = (lm_f[UPIN] + lm_f[LOIN]) / 2
    cL_, cR_ = lm_f[78], lm_f[308]
    mcx = float((cL_[0] + cR_[0]) / 2); half = float(abs(cR_[0] - cL_[0]) / 2)
    u_ = (seam_pts[:, 0] - mcx) / half; uu_ = np.r_[u_, -u_]; yy_ = np.r_[seam_pts[:, 1], seam_pts[:, 1]]
    co_ = np.linalg.lstsq(np.c_[np.ones_like(uu_), uu_ ** 2, uu_ ** 4], yy_, rcond=None)[0]
    def seam_y_at(x):
        u = np.clip((np.asarray(x) - mcx) / half, -1.3, 1.3); return co_[0] + co_[1] * u ** 2 + co_[2] * u ** 4
    zlip = float(max(lm_f[13, 2], lm_f[14, 2]))
    print(f'  lip curve: centre x {mcx * 1000:.1f} mm, half-width {half * 1000:.1f} mm, sag {co_[1] * 1000:+.2f}/{co_[2] * 1000:+.2f} mm')
    refine(lambda P, rnd: (np.abs(P[:, 0] - mcx) < half + 0.007) & (np.abs(P[:, 1] - seam_y_at(P[:, 0])) < 0.009 - 0.002 * rnd) & (P[:, 2] > zlip - 0.016), 2, 'lip region')
    # the cut: where the curve crosses an edge of the front lip surface, within the corners
    fv = LV[:, 1] - seam_y_at(LV[:, 0]); fv[np.abs(fv) < 1e-7] = 1e-7
    front = (LV[:, 2] > zlip - 0.010) & (np.abs(LV[:, 0] - mcx) < half + 0.004)
    E_ = np.unique(np.sort(np.r_[LF[:, [0, 1]], LF[:, [1, 2]], LF[:, [2, 0]]], 1), axis=0)
    E_ = E_[front[E_].all(1) & (np.sign(fv[E_[:, 0]]) != np.sign(fv[E_[:, 1]]))]
    tq = fv[E_[:, 0]] / (fv[E_[:, 0]] - fv[E_[:, 1]])
    Pc = LV[E_[:, 0]] + (LV[E_[:, 1]] - LV[E_[:, 0]]) * tq[:, None]
    inside = np.abs(Pc[:, 0] - mcx) < half * 0.99
    E_, tq, Pc = E_[inside], tq[inside], Pc[inside]
    Pc[:, 1] = seam_y_at(Pc[:, 0])                                   # exactly on the curve
    up_end = np.where(fv[E_[:, 0]] > 0, E_[:, 0], E_[:, 1]); lo_end = np.where(fv[E_[:, 0]] > 0, E_[:, 1], E_[:, 0])
    cut = add_verts(Pc, E_[:, 0], E_[:, 1], tq)
    LF = split_faces(LF, {(int(a), int(b)): int(i) for (a, b), i in zip(E_, cut)})
    # the chain from corner to corner (by x); its two ends stay joined (the mouth corners)
    o_ = np.argsort(LV[cut, 0]); cut, up_end, lo_end = cut[o_], up_end[o_], lo_end[o_]
    inner_v = cut[1:-1]
    fc = LV[LF].mean(1); below = fc[:, 1] < seam_y_at(fc[:, 0])
    on = set(int(v) for v in inner_v); newid = {}
    n_before = len(LV)
    dup_src = []
    for fi in np.nonzero(below)[0]:
        for k_ in range(3):
            v = int(LF[fi, k_])
            if v in on:
                if v not in newid: newid[v] = n_before + len(dup_src); dup_src.append(v)
                LF[fi, k_] = newid[v]
    LV = np.r_[LV, LV[dup_src]]; wts = wts + [wts[v] for v in dup_src]
    ue = {int(c): int(u) for c, u in zip(cut, up_end)}; le = {int(c): int(l) for c, l in zip(cut, lo_end)}
    for k_ in list(morph_d):
        d2 = np.r_[morph_d[k_], morph_d[k_][dup_src]]
        if k_ in ('jawOpen', 'wide', 'pucker', 'grimace'):      # the rest shapes (and the rest smile) keep the lips together
            for v in dup_src:
                d2[v] = morph_d[k_][ue[v]]; d2[newid[v]] = morph_d[k_][le[v]]
        morph_d[k_] = d2
    # the mouth shapes, smoothed over the lips now that upper and lower are separate surfaces (the MakeHuman transfer is
    # noisy at the seam, and each cut copy took one parent's delta): the open lip edges come out as smooth curves
    _nb = [[] for _ in range(len(LV))]
    for a_, b_, c_ in LF: _nb[a_] += [b_, c_]; _nb[b_] += [a_, c_]; _nb[c_] += [a_, b_]
    _nb = [np.unique(n_) for n_ in _nb]
    _rw = np.clip((half + 0.009 - np.abs(LV[:, 0] - mcx)) / 0.004, 0, 1) * np.clip((0.014 - np.abs(LV[:, 1] - seam_y_at(LV[:, 0]))) / 0.004, 0, 1) * (LV[:, 2] > zlip - 0.016)
    _ri = np.nonzero(_rw > 0)[0]
    for k_ in ('jawOpen', 'wide', 'pucker', 'grimace'):
        if k_ not in morph_d: continue
        D = morph_d[k_]
        for _ in range(25):
            avg = np.array([D[_nb[i]].mean(0) if len(_nb[i]) else D[i] for i in _ri])
            D[_ri] += 0.6 * _rw[_ri, None] * (avg - D[_ri])
        morph_d[k_] = D
    print(f'  mouth shapes smoothed over {len(_ri)} lip verts')
    LIPIN = np.zeros(len(LV))
    # inner-lip strips: two rows back into the mouth from each lip edge (upper rises toward the gum, lower drops)
    chU = [int(cut[0])] + [int(v) for v in inner_v] + [int(cut[-1])]
    chL = [int(cut[0])] + [newid[int(v)] for v in inner_v] + [int(cut[-1])]
    sx = (LV[chU, 0] - mcx) / half; taper = 0.3 + 0.7 * np.clip(1 - sx ** 2, 0, 1) ** 0.5   # never flat to nothing (zero-area faces get no UVs)
    newF = []
    for chain, dy, sgn in ((chU, 0.0007, 1), (chL, -0.0007, -1)):
        prev = chain
        for row, (back, d_y) in enumerate(((0.0035, dy), (0.0075, dy * 2.2))):
            # straight back into the mouth (never up through the lip's own surface), and toward the middle at the corners
            # where the lips wrap round (else the strips poke out through the cheek)
            P = LV[chain] + np.c_[(mcx - LV[chain, 0]) * (1 - taper) * (0.35 + 0.35 * row), d_y * taper, -back * taper]
            ids = np.arange(len(LV), len(LV) + len(chain))
            LV = np.r_[LV, P]; wts = wts + [wts[v] for v in chain]
            for k_ in morph_d: morph_d[k_] = np.r_[morph_d[k_], morph_d[k_][chain]]
            LIPIN = np.r_[LIPIN, (0.5 + 0.5 * row) * np.clip((taper - 0.3) / 0.5, 0, 1)]   # (lip-coloured toward the corners, where the strips stretch into view)
            for i in range(len(chain) - 1):
                a, b, c, d = prev[i], prev[i + 1], ids[i], ids[i + 1]
                for tri in ([a, c, b], [b, c, d]):
                    n_ = np.cross(LV[tri[1]] - LV[tri[0]], LV[tri[2]] - LV[tri[0]])
                    # facing out of the opening: the upper strip looks down and forward, the lower up and forward
                    if n_ @ np.array([0, -sgn, 0.4]) < 0: tri = tri[::-1]
                    newF.append(tri)
            prev = ids
    STRIP_F0 = len(LF); LF = np.r_[LF, np.array(newF, np.int64)]
    jaw_lo = np.array([morph_d['jawOpen'][newid[v]] for v in newid]).mean(0)
    jaw_chin = morph_d['jawOpen'][np.argsort(np.linalg.norm(LV - lm_f[152], axis=1))[:6]].mean(0)
    mc_c = (lm_f[13] + lm_f[14]) / 2
    mouth_rig = {'center': np.array([mcx, seam_y_at(mcx), mc_c[2]]), 'left': lm_f[61], 'right': lm_f[291], 'upper': lm_f[13], 'lower': lm_f[14],
                 'chin': lm_f[152], 'nose': lm_f[2], 'jawLip': jaw_lo, 'jawChin': jaw_chin}
    print(f'  lips cut along a smooth curve: {len(cut)} verts ({len(inner_v)} split); jaw opens the lower lip {np.linalg.norm(jaw_lo) * 1000:.1f} mm at jawOpen 1; {len(newF)} inner-lip tris')
# ───────────────────────── unwrap ─────────────────────────
# zero-area faces (cut slivers) get no UVs from xatlas and would sample the texture's corner: drop them first
_fa = np.linalg.norm(np.cross(LV[LF[:, 1]] - LV[LF[:, 0]], LV[LF[:, 2]] - LV[LF[:, 0]]), axis=1) / 2
_keepF = _fa > 2e-11
if STRIP_F0 is not None: STRIP_F0 = int(_keepF[:STRIP_F0].sum())
if (~_keepF).any(): print(f'  dropped {int((~_keepF).sum())} zero-area faces before the unwrap')
LF = LF[_keepF]
atlas = xatlas.Atlas(); atlas.add_mesh(LV.astype(np.float32), LF.astype(np.uint32))
co = xatlas.ChartOptions(); co.max_cost = 2.0
po = xatlas.PackOptions(); po.resolution = A.tex; po.padding = 4; po.bilinear = True
atlas.generate(co, po)
vmap, UF, UV = atlas[0]
print('atlas', atlas.width, 'x', atlas.height, len(UV), 'uv verts')
assert len(UF) == len(LF), 'xatlas changed the face count'
UV = UV.astype(float)

# ───────────────────────── bake the colour ─────────────────────────
T = A.tex
UP = UV * T
uv_ids = raster(np.c_[UP[:, 0], (1 - UV[:, 1]) * T], np.zeros(len(UV)), UF, T, T)
ty, tx = np.nonzero(uv_ids >= 0); tt = uv_ids[ty, tx]
tw = bary(np.c_[UP[:, 0], (1 - UV[:, 1]) * T], UF, tt, tx + 0.5, ty + 0.5)
# texel positions on the high-res surface (for detail): nearest point on the cropped hi-res mesh
VV = LV[vmap]                                   # (pre-mirror) fitted positions per uv vertex
tp = (VV[UF[tt]] * tw[..., None]).sum(1)
NN = vnormals(LV, LF)[vmap]
tn = (NN[UF[tt]] * tw[..., None]).sum(1); tn /= np.linalg.norm(tn, axis=1, keepdims=True) + 1e-9
print('texels', len(tt))
# the hi-res surface under each texel: the tangent plane of the nearest hi-res vertices (normals blended)
hv, hvn = np.asarray(hm.vertices), np.asarray(hm.vertex_normals)
dq, iq = cKDTree(hv).query(tp, k=4)
wq = 1 / (dq + 1e-5); wq /= wq.sum(1, keepdims=True)
hiN = (hvn[iq] * wq[..., None]).sum(1); hiN /= np.linalg.norm(hiN, axis=1, keepdims=True) + 1e-9
p0 = (hv[iq] * wq[..., None]).sum(1)
cp = tp - hiN * np.einsum('ij,ij->i', tp - p0, hiN)[:, None]
del dq, iq, wq, p0
off = np.linalg.norm(cp - tp, axis=1) > 0.004     # the neck loft has no hi-res surface: use the low-res one
cp[off] = tp[off]; hiN[off] = tn[off]
col = np.zeros((len(tt), 3)); wsum = np.zeros(len(tt))

def pose_photo(img):
    lm = landmarks(img)
    if lm is None: raise SystemExit('no face in photo')
    H, W = img.shape[:2]
    use = ~np.isnan(lm_f).any(1)
    obj, ipt = lm_f[use], lm[use]
    best = None
    for fm in (1.2, 1.6, 2.0, 2.6, 3.4, 4.5, 6.0):
        K = np.array([[fm * W, 0, W / 2], [0, fm * W, H / 2], [0, 0, 1]])
        okp, rv, tv, inl = cv2.solvePnPRansac(obj, ipt, K, None, reprojectionError=6, iterationsCount=500, flags=cv2.SOLVEPNP_EPNP)
        if not okp or inl is None: continue
        inl = inl[:, 0]
        rv, tv = cv2.solvePnPRefineLM(obj[inl], ipt[inl], K, None, rv, tv)
        pr = cv2.projectPoints(obj, rv, tv, K, None)[0][:, 0]
        e = np.linalg.norm(pr - ipt, axis=1); err = np.median(e)
        if best is None or err < best[0]: best = (err, fm, K, rv, tv, len(inl))
    err, fm, K, rv, tv, ni = best
    Rm = cv2.Rodrigues(rv)[0]
    yaw = math.degrees(math.atan2(Rm[2, 0], -Rm[2, 2])); pitch = math.degrees(math.asin(np.clip(Rm[2, 1], -1, 1)))
    print(f'  photo pose: f {fm}W, yaw {yaw:.0f}°, pitch {pitch:.0f}°, median reprojection {err:.1f}px over {ni} landmarks')
    return K, Rm, tv[:, 0], lm

skin_samples, hair_samples = [], []
use_photos = photos if (A.photo or not (A.unwrap not in (None, 'none') or json.load(open(os.path.join(HERE, 'neil.json')))['face'].get('unwrap'))) else []
if not use_photos: print('portrait projection off: the unwrap covers the face (pass --photo to blend it in)')
for ph in use_photos:
    print('photo', ph)
    im = np.asarray(Image.open(ph).convert('RGB')).astype(float)
    H, W = im.shape[:2]
    K, Rm, tv, lm2 = pose_photo(im.astype(np.uint8))
    # below the jaw only skin counts: clothes (dark hoodie, white collar) are grey, skin is saturated
    hsv = cv2.cvtColor(im.astype(np.uint8), cv2.COLOR_RGB2HSV).astype(float)
    below = np.arange(H)[:, None] > lm2[152, 1] + 0.05 * (lm2[152, 1] - lm2[10, 1])
    clothes = (below & ((hsv[..., 1] < 70) | (hsv[..., 2] < 110))).astype(np.uint8)
    clothes = cv2.dilate(clothes, np.ones((7, 7), np.uint8)).astype(float)
    # the paper background (near-white, joined to the frame) and a few pixels round it: edge pixels are half paper
    paper = ((im.min(2) > 200) & (hsv[..., 1] < 45)).astype(np.uint8)
    nlab, lab = cv2.connectedComponents(paper)
    edge_l = set(lab[0]) | set(lab[-1]) | set(lab[:, 0]) | set(lab[:, -1]); edge_l.discard(0)
    paper = np.isin(lab, list(edge_l)).astype(np.uint8)
    clothes = np.maximum(clothes, cv2.GaussianBlur(cv2.dilate(paper, np.ones((9, 9), np.uint8)).astype(float), (5, 5), 1.5))
    def proj(P):
        c = (Rm @ P.T).T + tv; return np.c_[K[0, 0] * c[:, 0] / c[:, 2] + K[0, 2], K[1, 1] * c[:, 1] / c[:, 2] + K[1, 2]], c[:, 2]
    # visibility: depth buffer of the hi-res head in the photo's camera
    hp2, hz = proj(np.asarray(hm.vertices))
    ids = raster(hp2, hz, np.asarray(hm.faces), W, H)
    zb = zbuffer(hp2, hz, np.asarray(hm.faces), ids)
    if DBG:
        ov = im.copy(); sh_, _ = shade(np.asarray(hm.vertices), hm.vertex_normals, np.asarray(hm.faces), hp2, hz, W, H)
        m_ = ids >= 0; ov[m_] = 0.5 * ov[m_] + 0.5 * sh_[m_]; dbg('overlay_' + os.path.basename(ph) + '.png', ov)
    cam = -Rm.T @ tv                                 # camera centre in head space
    for mirrored in (False, True):
        P = cp * np.array([-1, 1, 1]) if mirrored else cp     # the face is near-symmetric: its far side borrows the near side
        Nn = hiN * np.array([-1, 1, 1]) if mirrored else hiN
        p2, z = proj(P)
        xi, yi = np.floor(p2[:, 0]).astype(int), np.floor(p2[:, 1]).astype(int)
        inside = (xi >= 1) & (xi < W - 1) & (yi >= 1) & (yi < H - 1)
        xi, yi = np.clip(xi, 1, W - 2), np.clip(yi, 1, H - 2)
        zmin = np.minimum.reduce([zb[yi + dy, xi + dx] for dy in (-1, 0, 1) for dx in (-1, 0, 1)])
        vis = inside & (z <= zmin + 0.004)
        vdir = cam - P; vdir /= np.linalg.norm(vdir, axis=1, keepdims=True)
        cosv = np.einsum('ij,ij->i', Nn, vdir)
        w = np.clip((cosv - 0.15) / 0.6, 0, 1) ** 1.5 * vis
        # stay off the cut edge of the photo (the hair top is cropped by the frame) and off the white background
        edge = np.clip(np.minimum.reduce([p2[:, 0], p2[:, 1], W - p2[:, 0], H - p2[:, 1]]) / 12, 0, 1)
        w *= edge
        c = np.stack([map_coordinates(im[..., k], [p2[:, 1] - 0.5, p2[:, 0] - 0.5], order=1, mode='nearest') for k in range(3)], 1)
        white = np.clip((c.min(1) - 225) / 20, 0, 1) * np.clip((40 - (c.max(1) - c.min(1))) / 20, 0, 1)
        w *= 1 - white
        w *= 1 - map_coordinates(clothes, [p2[:, 1] - 0.5, p2[:, 0] - 0.5], order=1, mode='nearest')
        if mirrored: w *= 0.35 * (wsum < 0.5)          # only where the real view is weak
        col += c * w[:, None]; wsum += w
# ── the unwrapped face texture (front + ears + hair, cylindrical, evenly lit): fitted by landmarks, like build.py ──
ear_pts = []
try: UCFG = json.load(open(os.path.join(HERE, 'neil.json')))['face'].get('unwrap') or {}
except Exception: UCFG = {}
if A.unwrap is None: A.unwrap = UCFG.get('photo', 'none')
elif A.unwrap != UCFG.get('photo'): UCFG = {}       # another image: its ears aren't known
print('unwrap', A.unwrap)
# head points → (arc round the head centre, height) → thin-plate spline from our mesh's landmarks to the image's
if A.unwrap != 'none' and os.path.exists(A.unwrap):
    from scipy.interpolate import RBFInterpolator
    U = np.asarray(Image.open(A.unwrap).convert('RGB')).astype(float); UH, UW = U.shape[:2]
    Lu = np.array(json.load(open(A.unwrap + '.lm.json'))['pts'], float)[:, :2]     # the true (unmirrored) image: this mesh is true until written
    # a relaxed, closed-mouth rest face: the lips from the cleaned unwrap (build.py writes it, mirrored for the
    # left-hander: flip it back), the open mouth between them painted shut with a soft lip line. No teeth.
    clean_p = os.path.join(HERE, 'data', 'face_unwrap.clean.jpg')
    if A.rest == 'closed' and os.path.exists(clean_p):
        C_ = np.asarray(ImageOps.mirror(Image.open(clean_p).convert('RGB')).resize((UW, UH), Image.LANCZOS)).astype(np.float32)
        OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185]
        UPIN, LOIN = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308], [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308]
        inner = np.r_[Lu[UPIN], Lu[LOIN][::-1]].astype(np.int32)
        gap = np.zeros((UH, UW), np.uint8); cv2.fillPoly(gap, [inner], 255); gap = cv2.dilate(gap, np.ones((5, 5), np.uint8))
        C_ = cv2.inpaint(np.clip(C_, 0, 255).astype(np.uint8), gap, 7, cv2.INPAINT_TELEA).astype(np.float32)
        seam_ = ((Lu[UPIN] + Lu[LOIN]) / 2).astype(np.int32)
        line_ = np.zeros((UH, UW), np.float32); cv2.polylines(line_, [seam_], False, 1.0, 3, cv2.LINE_AA); line_ = cv2.GaussianBlur(line_, (0, 0), 1.5)
        C_ *= (1 - 0.45 * line_)[..., None]
        lips = np.zeros((UH, UW), np.uint8); cv2.fillPoly(lips, [Lu[OUTER].astype(np.int32)], 255)
        mm_ = cv2.GaussianBlur(cv2.dilate(lips, np.ones((25, 25), np.uint8)).astype(np.float32) / 255, (0, 0), 8)[..., None]
        U = U * (1 - mm_) + C_ * mm_
        print('  rest mouth: closed lips from the cleaned unwrap')
    # the cylinder's axis: through the middle of the skull (front to back), so the ears sit near ±90°
    hc_ = np.array([eye_lmh[0], (lm_f[IRIS[0], 1] + lm_f[IRIS[1], 1]) / 2, (FV[:, 2].min() + FV[:, 2].max()) / 2])
    def cyl(P): d = P - hc_; return np.c_[np.arctan2(d[:, 0], d[:, 2]) * 0.09, d[:, 1]]
    okl = ~np.isnan(lm_f).any(1)
    src, dst = cyl(lm_f[okl]), Lu[okl]
    ears_img = UCFG.get('ears')
    if ears_img:
        # the ears painted at the sides: anchor the mesh's outermost points between mouth and eye height to them
        Pm = np.asarray(hm.vertices); mouth_y = lm_f[13, 1]
        aff = np.linalg.lstsq(np.c_[src, np.ones(len(src))], dst, rcond=None)[0]
        for sx in (-1, 1):
            band_ = Pm[(Pm[:, 1] > mouth_y) & (Pm[:, 1] < eyeY0 + 0.01) & ((Pm[:, 0] - hc_[0]) * sx > 0)]
            ep = band_[np.argmax(np.abs(band_[:, 0] - hc_[0]))][None]
            pred = np.c_[cyl(ep), [[1]]] @ aff
            j = int(np.argmin([np.linalg.norm(np.array(e) - pred[0]) for e in ears_img]))
            src = np.r_[src, cyl(ep)]; dst = np.r_[dst, [ears_img[j]]]; ear_pts.append(ep[0])
            print(f'  unwrap ear {sx:+d}: predicted {pred[0].round(0)}, painted {ears_img[j]}')
    uw = RBFInterpolator(src, dst, kernel='thin_plate_spline', smoothing=0.5, degree=1)
    print('unwrap fit residual', np.linalg.norm(uw(src) - dst, axis=1).mean().round(1), 'px over', len(src), 'points')
    xy = uw(cyl(cp))
    U_skin = None
    cu = np.stack([map_coordinates(U[..., k], [xy[:, 1] - 0.5, xy[:, 0] - 0.5], order=1, mode='nearest') for k in range(3)], 1)
    ang = np.abs(np.arctan2(cp[:, 0] - hc_[0], cp[:, 2] - hc_[2]))
    wu = np.clip(np.minimum.reduce([xy[:, 0] - 4, UW - 4 - xy[:, 0], xy[:, 1] - 4, UH - 4 - xy[:, 1]]) / 60, 0, 1) ** 1.5   # wide, soft edges
    wu *= np.clip((np.radians(UCFG.get('maxAngle', 105)) - ang) / 0.6, 0, 1) ** 1.5   # a long, soft fade round the back
    wu *= np.clip((cp[:, 1] - (lm_f[152, 1] - (0.13 if A.neck == 'loft' else 0.05))) / 0.02, 0, 1)   # the unwrap paints the neck right down
    wu[off] = 0                                                   # the lofted neck gets a smooth skin fill, not stretched edge pixels
    # under the jaw only skin-coloured pixels count (no drawn shirt or edge)
    sk_lab = np.array([[0.0, 0, 0]])
    def _lab(c):
        c = np.clip(c / 255, 0, 1); c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
        X = (c @ np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]]).T) / [0.95047, 1.0, 1.08883]
        f = np.where(X > 0.008856, np.cbrt(X), 7.787 * X + 16 / 116); return np.c_[116 * f[:, 1] - 16, 500 * (f[:, 0] - f[:, 1]), 200 * (f[:, 1] - f[:, 2])]
    cheek_ref = _lab(np.median(np.array([U[int(y) - 6:int(y) + 6, int(x) - 6:int(x) + 6].reshape(-1, 3) for x, y in Lu[[50, 280, 101, 330]]]).reshape(-1, 3), 0)[None])
    below_chin = cp[:, 1] < lm_f[152, 1] - 0.005
    dl = np.linalg.norm((_lab(cu) - cheek_ref) * [0.5, 1, 1], axis=1)
    wu[below_chin] *= np.clip((22 - dl[below_chin]) / 10, 0, 1)
    # the unwrap's flat orange margins (round the ears, the corners) are not skin detail
    # where the unwrap sees, the portrait steps back (two lightings side by side read as seams)
    keep_p = 1 - np.clip(wu * 1.5, 0, 1)
    col *= keep_p[:, None]; wsum *= keep_p
    col += cu * (wu * A.unwrap_weight)[:, None]; wsum += wu * A.unwrap_weight
    skin_from_unwrap = np.median(np.array([U[int(y) - 6:int(y) + 6, int(x) - 6:int(x) + 6].reshape(-1, 3) for x, y in Lu[[50, 280, 101, 330]]]).reshape(-1, 3), axis=0)
    print('unwrap skin', skin_from_unwrap.round())
else:
    skin_from_unwrap = None
known = wsum > 0.05
col[known] /= wsum[known, None]
conf = np.clip(wsum / 0.4, 0, 1)

# ── the central face from his REAL photos (neutral, front-ish selfies): projected with the cameras solved in the
#    multi-view fit, shading flattened (÷ blurred luminance), colour-matched to one reference photo, then a weighted
#    median across photos. The unwrap keeps the sides, ears, neck and scalp, colour-transferred to the real skin. ──
def _s2l(c): c = np.clip(c, 0, 1); return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
def _l2s(c): c = np.clip(c, 0, 1); return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)
_MX = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]]); _WP = np.array([0.95047, 1.0, 1.08883])
def rgb2lab(c255):
    X = (_s2l(c255 / 255) @ _MX.T) / _WP; f = np.where(X > 0.008856, np.cbrt(X), 7.787 * X + 16 / 116)
    return np.c_[116 * f[:, 1] - 16, 500 * (f[:, 0] - f[:, 1]), 200 * (f[:, 1] - f[:, 2])]
def lab2rgb(L):
    fy = (L[:, 0] + 16) / 116; f = np.c_[fy + L[:, 1] / 500, fy, fy - L[:, 2] / 200]
    X = np.where(f ** 3 > 0.008856, f ** 3, (f - 16 / 116) / 7.787) * _WP
    return _l2s(np.clip(X @ np.linalg.inv(_MX).T, 0, 1)) * 255
def transfer(c255, mu_s, sd_s, mu_t, sd_t, k=(0.6, 1.4)):
    return lab2rgb((rgb2lab(c255) - mu_s) * np.clip(sd_t / np.maximum(sd_s, 1e-3), *k) + mu_t)
OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109]
real_ok = False
REAL = [n_ for n_ in A.real_photos.split(',') if n_] if A.real_photos else []
if REAL and 'mv_cams' in globals():
    face_c = lm_f[OVAL].mean(0)
    # central-face mask on the mesh: inside the face oval seen from the front, shrunk 6 %, feathered 1.5 cm
    ov2 = ((lm_f[OVAL][:, :2] - face_c[:2]) * 0.94 + face_c[:2])
    sd_ = np.array([cv2.pointPolygonTest((ov2 * 1e4).astype(np.float32), (float(x_ * 1e4), float(y_ * 1e4)), True) for x_, y_ in cp[:, :2]]) / 1e4
    cmask = np.clip(sd_ / 0.015, 0, 1) * (cp[:, 2] > face_c[2] - 0.06)
    samples, weights = [], []
    ref_stats = None
    for cam in mv_cams:
        if not any(n_ in os.path.basename(cam['photo']) for n_ in REAL): continue
        img = np.asarray(ImageOps.exif_transpose(Image.open(cam['photo'])).convert('RGB')).astype(np.float32)
        # a relit / restored copy with the SAME pixel geometry (tools/character/relight.py; kept beside the photo, outside the
        # repo) replaces the colours of that photo and counts --clean-weight times in the median
        cw_ = 1.0; _cl = cam['photo'] + '.clean.jpg'
        if A.clean_weight > 0 and os.path.exists(_cl):
            _ci = np.asarray(Image.open(_cl).convert('RGB')).astype(np.float32)
            if _ci.shape == img.shape: img, cw_ = _ci, A.clean_weight; print('  (using the relit copy of', os.path.basename(cam['photo'])[:8] + ')')
        Hh2, Ww2 = img.shape[:2]
        K_, R_, t_ = np.array(cam['K']), np.array(cam['R']), np.array(cam['t'])
        def proj_(P): c_ = P @ R_.T + t_; return np.c_[K_[0, 0] * c_[:, 0] / c_[:, 2] + K_[0, 2], K_[1, 1] * c_[:, 1] / c_[:, 2] + K_[1, 2]], c_[:, 2]
        hp2_, hz_ = proj_(np.asarray(hm.vertices)); ids_ = raster(hp2_, hz_, np.asarray(hm.faces), Ww2, Hh2); zb_ = zbuffer(hp2_, hz_, np.asarray(hm.faces), ids_)
        p2_, z_ = proj_(cp)
        xi_, yi_ = np.clip(np.floor(p2_[:, 0]).astype(int), 1, Ww2 - 2), np.clip(np.floor(p2_[:, 1]).astype(int), 1, Hh2 - 2)
        zmin_ = np.minimum.reduce([zb_[yi_ + dy, xi_ + dx] for dy in (-1, 0, 1) for dx in (-1, 0, 1)])
        vis_ = (p2_[:, 0] > 1) & (p2_[:, 0] < Ww2 - 2) & (p2_[:, 1] > 1) & (p2_[:, 1] < Hh2 - 2) & (z_ <= zmin_ + 0.004)
        camc_ = -R_.T @ t_; vd_ = camc_ - cp; vd_ /= np.linalg.norm(vd_, axis=1, keepdims=True)
        cosv_ = np.einsum('ij,ij->i', hiN, vd_)
        w_ = np.clip((cosv_ - 0.35) / 0.5, 0, 1) ** 2 * vis_ * cmask
        # flatten the photo's shading: divide by its blurred luminance (scale ~ a sixth of the face)
        fpx = np.median(np.linalg.norm(np.diff(proj_(lm_f[[10, 152]])[0], axis=0)))
        lum = img.mean(2); lb = cv2.GaussianBlur(lum, (0, 0), max(3.0, fpx / 6))
        _fl = (w_ > 0.3); _ly = np.clip(p2_[_fl, 1].astype(int), 0, Hh2 - 1); _lx = np.clip(p2_[_fl, 0].astype(int), 0, Ww2 - 1)
        flat = img * (np.median(lb[_ly, _lx]) / np.maximum(lb, 1))[..., None]   # keep the face's own brightness, lose the gradients
        c_ = np.stack([map_coordinates(flat[..., k], [p2_[:, 1] - 0.5, p2_[:, 0] - 0.5], order=1, mode='nearest') for k in range(3)], 1)
        sel_ = w_ > 0.3
        if sel_.sum() < 1000: continue
        lab_ = rgb2lab(c_[sel_]); st_ = (lab_.mean(0), lab_.std(0))
        if ref_stats is None: ref_stats = st_
        else: c_ = transfer(c_, st_[0], st_[1], ref_stats[0], ref_stats[1], (0.8, 1.25))
        samples.append(c_); weights.append(w_ * cw_)
        print(f'  real photo {os.path.basename(cam["photo"])[:8]}: {int(sel_.sum())} texels')
    if samples:
        S_ = np.stack(samples, 1); Wt_ = np.stack(weights, 1)                 # (texels, photos, 3), (texels, photos)
        # weighted median per channel (few photos: sort, cumulate)
        rc = np.zeros((len(cp), 3))
        for k in range(3):
            o_ = np.argsort(S_[..., k], axis=1); sv = np.take_along_axis(S_[..., k], o_, 1); sw = np.take_along_axis(Wt_, o_, 1)
            cw = np.cumsum(sw, 1); half = cw[:, -1:] / 2; j_ = np.argmax(cw >= half, axis=1)
            rc[:, k] = sv[np.arange(len(cp)), j_]
        rconf = np.clip(Wt_.sum(1) / 0.8, 0, 1)
        if A.skin_lift: rc = lab2rgb(rgb2lab(rc) + [A.skin_lift, 0, 0])   # selfies under-expose a little; he reads lighter
        m_ = rconf * cmask
        # the unwrap (sides, ears, neck, scalp) carried onto the real skin: Lab mean/spread over the cheeks both see
        both = (m_ > 0.5) & (conf > 0.7) & (cp[:, 1] < (lm_f[468, 1] + lm_f[473, 1]) / 2 - 0.01) & (cp[:, 1] > lm_f[152, 1] + 0.01)
        if both.sum() > 500:
            lu_, lr_ = rgb2lab(col[both]), rgb2lab(rc[both])
            col = transfer(col, lu_.mean(0), lu_.std(0), lr_.mean(0), lr_.std(0), (0.7, 1.3))
        # then a plain Lab shift so the sides, ears and neck sit on exactly the real face's skin (no orange collar)
        cheeks_ = (m_ > 0.8) & (cp[:, 1] < lm_f[2, 1]) & (cp[:, 1] > lm_f[152, 1] + 0.012) & (np.abs(cp[:, 0]) > 0.025)
        sides_ = (m_ < 0.2) & (conf > 0.5) & (cp[:, 1] < (lm_f[468, 1] + lm_f[473, 1]) / 2) & (cp[:, 1] > lm_f[152, 1] - 0.05)
        if cheeks_.sum() > 300 and sides_.sum() > 300:
            dlab = np.median(rgb2lab(rc[cheeks_]), 0) - np.median(rgb2lab(col[sides_]), 0)
            col = lab2rgb(rgb2lab(col) + dlab * (1 - m_)[:, None])
            print('  sides shifted onto the real skin by Lab', dlab.round(1))
        # the selfies' mouth corners sit in shadow and read as a frown: lift them toward the cheek tone
        for ci_ in (61, 291):
            wc_ = np.exp(-(np.linalg.norm(cp - lm_f[ci_], axis=1) / 0.007) ** 2) * m_
            rc = rc * (1 - 0.5 * wc_[:, None]) + np.median(rc[cheeks_], 0) * 0.5 * wc_[:, None]
        # and soften the nasolabial lines (nose wing to mouth corner) a little
        for a_i, b_i in ((98, 61), (327, 291)):
            a3, b3 = lm_f[a_i], lm_f[b_i]; ab = b3 - a3; tpar = np.clip(((cp - a3) @ ab) / (ab @ ab), 0, 1)
            dseg = np.linalg.norm(cp - (a3 + tpar[:, None] * ab), axis=1)
            wn_ = np.exp(-(dseg / 0.005) ** 2) * m_ * 0.3
            rc = rc * (1 - wn_[:, None]) + np.median(rc[cheeks_], 0) * wn_[:, None]
        col = col * (1 - m_[:, None]) + rc * m_[:, None]
        conf = np.maximum(conf, m_)
        real_ok = True
        print(f'  central face from {len(samples)} real photos ({int((m_ > 0.5).sum())} texels)')

def snoise(q):
    # smooth value noise (trilinear), q already scaled
    i = np.floor(q).astype(np.int64); f = q - i; f = f * f * (3 - 2 * f)
    def h(o): g = i + o; return (((g[:, 0] * 73856093) ^ (g[:, 1] * 19349663) ^ (g[:, 2] * 83492791)) % 1000003) / 1000003.0
    c = [h(np.array([a, b, c_])) for a in (0, 1) for b in (0, 1) for c_ in (0, 1)]
    x0 = [c[k] * (1 - f[:, 2]) + c[k + 1] * f[:, 2] for k in (0, 2, 4, 6)]
    y0 = [x0[0] * (1 - f[:, 1]) + x0[1] * f[:, 1], x0[2] * (1 - f[:, 1]) + x0[3] * f[:, 1]]
    return y0[0] * (1 - f[:, 0]) + y0[1] * f[:, 0]
# what has no photo: hair above the hairline, skin below it (the nape / behind the ears)
eyeY = (lm_f[IRIS[0], 1] + lm_f[IRIS[1], 1]) / 2
ear_lo = eyeY - 0.045
# short hair: everything above the temples, and behind the ears down to a nape line (lowest at the centre of the
# back), with a ragged soft edge
ear_z = np.mean([e_[2] for e_ in ear_pts]) if ear_pts else eye_lmh[2] - 0.08
xr = np.abs(cp[:, 0] - eye_lmh[0]); back = np.clip(-(cp[:, 2] - (ear_z - 0.012)) / 0.02, 0, 1)   # hair starts just behind the ears
nape = eyeY - 0.045 - 0.03 * np.clip(1 - xr / 0.065, 0, 1) ** 1.5
ragged = 0.0015 * (snoise(cp * 400) - 0.5)
hair_amt = np.clip((cp[:, 1] - nape - ragged) / 0.016 + 0.5, 0, 1) ** 1.3 * back   # a soft, tapered nape line
hair_amt = np.maximum(hair_amt, np.clip((cp[:, 1] - (eyeY + 0.075)) / 0.01, 0, 1))
hairy = hair_amt > 0.5
lum = col.mean(1)
hair_known = known & hairy & (conf > 0.8) & (lum < 150)
skin_known = known & ~hairy & (conf > 0.8) & (lum > 120) & (cp[:, 1] < eyeY - 0.02)
hair_c = np.median(col[hair_known], 0) if hair_known.sum() > 50 else np.array([92, 64, 44.])
skin_c = np.median(col[skin_known], 0) if skin_known.sum() > 50 else np.array([215, 150, 120.])
if skin_from_unwrap is not None: skin_c = skin_from_unwrap
if real_ok: skin_c = np.median(rc[cheeks_], 0)   # his real cheeks
# the neck's own tone (a touch darker than the cheeks): the fill and the fade into the body use it
neck_sel = known & (conf > 0.8) & (cp[:, 1] < lm_f[152, 1] - 0.005) & (cp[:, 1] > lm_f[152, 1] - 0.04)
neck_c = np.median(col[neck_sel], 0) if neck_sel.sum() > 200 else skin_c * 0.95
print('neck colour', neck_c.round())
# pencil highlights and paper flecks in the hair: hold the hair to its own tone
hl = col.mean(1) / max(hair_c.mean(), 1)
tame = hairy & (hl > 1.3)
col[tame] *= (1.3 / hl[tame])[:, None]
print('hair colour', hair_c.round(), 'skin colour', skin_c.round())
# fill: hair gets strand-like noise lit by the hi-res relief, skin gets a flat tone; diffuse the photo colours across the join
rng = np.random.default_rng(3)
def vnoise(p, f):
    g = np.floor(p * f).astype(np.int64); h = ((g[:, 0] * 73856093) ^ (g[:, 1] * 19349663) ^ (g[:, 2] * 83492791)) % 1000003
    return (h / 1000003.0)
relief = np.clip(np.einsum('ij,ij->i', hiN, tn), 0, 1)
# strands follow the way the hair grows: swept straight back on top, down and back at the sides and nape
topk = np.clip((cp[:, 1] - (eyeY + 0.04)) / 0.05, 0, 1)
gd = np.c_[np.zeros(len(cp)), -1 + 1.0 * topk, -0.6 - 0.6 * topk]
gd -= hiN * np.einsum('ij,ij->i', gd, hiN)[:, None]; gd /= np.linalg.norm(gd, axis=1, keepdims=True) + 1e-9
def aniso(F_perp, F_par):
    q = cp * F_perp + gd * np.einsum('ij,ij->i', cp, gd)[:, None] * (F_par - F_perp); return snoise(q)
strand = 0.55 + 0.7 * (0.55 * aniso(2600, 70) + 0.3 * aniso(900, 30) + 0.15 * snoise(cp * 150))
# skin with nothing painted (the lofted neck, behind the jaw, the nape): the painted skin round it, diffused across the
# mesh (per vertex, then interpolated), so it continues the face's own tone with no flat patch or hard edge
_vc = np.zeros((len(LV), 3)); _vn = np.zeros(len(LV))
_good = (conf > 0.7) & (hair_amt < 0.3)
for k_ in range(3):
    np.add.at(_vc, vmap[UF[tt[_good], k_]], col[_good] * tw[_good, k_:k_ + 1]); np.add.at(_vn, vmap[UF[tt[_good], k_]], tw[_good, k_])
_has = _vn > 0.5; _vc[_has] /= _vn[_has, None]
_nb = [[] for _ in range(len(LV))]
for a_, b_, c_ in LF: _nb[a_] += [b_, c_]; _nb[b_] += [a_, c_]; _nb[c_] += [a_, b_]
_nb = [np.unique(n_) for n_ in _nb]
_known = _has.copy(); _cur = _vc.copy()
for it in range(120):
    _new = np.array([(_cur[n_][_known[n_]].mean(0) if _known[n_].any() else _cur[i]) for i, n_ in enumerate(_nb)])
    upd = ~_has & np.array([_known[n_].any() for n_ in _nb])
    _cur[upd] = _new[upd]; _known |= upd
    if _known.all(): break
_cur[~_known] = neck_c
diff_c = (_cur[vmap][UF[tt]] * tw[..., None]).sum(1)
hshade = strand * (0.55 + 0.45 * relief); hshade /= np.mean(hshade[hairy]) if hairy.any() else 1   # same level as the textured hair
# where nothing paints it, the side of the head above the ears is hair too (else a skin stripe shows behind the ear)
hair_fill = np.maximum(hair_amt, np.clip((cp[:, 1] - (eyeY + 0.0)) / 0.012, 0, 1) * np.clip((eye_lmh[2] - 0.03 - cp[:, 2]) / 0.02, 0, 1))
fill = hair_fill[:, None] * hair_c * hshade[:, None] + (1 - hair_fill[:, None]) * diff_c * (0.92 + 0.08 * relief[:, None]) * (0.96 + 0.08 * snoise(cp * 900)[:, None])   # unpainted skin (behind the jaw, the nape) a shade down: the unwrap's skin carries soft baked shading, a flat fill reads too light
# soft hair edge at the nape
out = col * conf[:, None] + fill * (1 - conf[:, None])
# ── hair colour: his own dark brown, whatever the textures say (the unwrap's hair is lighter and redder) ──
def hexrgb(h): h = h.lstrip('#'); return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], float)
hair_hex = A.hair
if hair_hex is None:
    import re
    try: hair_hex = re.search(r"hair:\s*'(#[0-9a-fA-F]{6})'", open(os.path.join(ROOT, 'src/golfer/profile.ts')).read()).group(1)
    except Exception: hair_hex = '#4a3628'
hair_t = hexrgb(hair_hex)
if real_ok and A.hair is None:
    # his real hair: the band above the hairline in the reference photo (median, a touch deeper for the shading flattening)
    for cam in mv_cams:
        if REAL[0] in os.path.basename(cam['photo']):
            im_ = np.asarray(ImageOps.exif_transpose(Image.open(cam['photo'])).convert('RGB')).astype(float)
            L_ = np.array(json.load(open(cam['photo'] + '.lm.json'))['pts'], float)[:, :2]; fh_ = np.linalg.norm(L_[10] - L_[152])
            y0_, y1_ = int(L_[10, 1] - 0.22 * fh_), int(L_[10, 1] - 0.06 * fh_); x0_, x1_ = int(L_[54, 0]), int(L_[284, 0])
            patch = im_[max(0, y0_):y1_, x0_:x1_].reshape(-1, 3)
            patch = patch[patch.mean(1) < np.percentile(patch.mean(1), 60)]
            hair_t = np.median(patch, 0); hair_hex = '#%02x%02x%02x' % tuple(int(v) for v in hair_t)
            print('  hair colour from', os.path.basename(cam['photo']), hair_hex)
L_ = out.mean(1); skinL = skin_c.mean()
near_eye = np.minimum(np.linalg.norm(cp - lm_f[IRIS[0]], axis=1), np.linalg.norm(cp - lm_f[IRIS[1]], axis=1)) < 0.03
sideang = np.abs(np.arctan2(cp[:, 0] - eye_lmh[0], cp[:, 2] - (eye_lmh[2] - 0.09)))
near_ear = np.zeros(len(cp), bool)
for e_ in ear_pts: near_ear |= np.linalg.norm((cp - e_) * [1.6, 0.8, 1], axis=1) < 0.04   # the ears stay skin
# dark texels read as hair only above the temples, at the sideburns (down to the ear's middle) and behind the ears
# above the nape line, never on the neck
region = ((cp[:, 1] > eyeY + 0.03) | ((sideang > np.radians(55)) & (cp[:, 1] > eyeY - 0.03)) | ((back > 0.5) & (cp[:, 1] > nape + 0.006))) & ~near_eye
dark = np.clip((0.8 * skinL - L_) / (0.2 * skinL), 0, 1) * region
# round the ears only clearly dark texels are hair (the ear's own shadows are not)
dark_ear = np.clip((0.6 * skinL - L_) / (0.15 * skinL), 0, 1) * region
dark = np.where(near_ear, dark_ear, dark)
H_ = np.maximum(np.where(near_ear, hair_amt * dark_ear, hair_amt), dark)
H_ = np.maximum(H_, hair_fill * (1 - conf))
H_ = H_ * np.clip(1 - 0.7 * near_eye, 0, 1)
hm_mean = np.median(L_[H_ > 0.8]) if (H_ > 0.8).sum() > 100 else L_.mean()
rec = hair_t[None, :] * np.clip(L_ / max(hm_mean, 1), 0.35, 1.8)[:, None] ** 0.9
# a small thin spot at the crown: a little scalp shows through
crown = np.array([eye_lmh[0], FV[:, 1].max() - 0.012, eye_lmh[2] - 0.11])
cr = np.clip(1 - np.linalg.norm(cp - crown, axis=1) / 0.022, 0, 1) ** 1.5 * 0.35
rec = rec * (1 - cr[:, None]) + skin_c * 0.8 * cr[:, None]
out = out * (1 - H_[:, None]) + rec * H_[:, None]
print('hair recoloured to', hair_hex, 'over', int((H_ > 0.5).sum()), 'texels; source hair lum', round(float(hm_mean), 1))
# the neck band fades to the body's skin tone (the body is tinted to the face below)
nk = np.clip(((LV[vmap][UF[tt]] * tw[..., None]).sum(1) - cen) @ pn / (BAND + 0.012), 0, 1) ** 0.7 if A.neck == 'loft' else np.clip((((LV[vmap][UF[tt]] * tw[..., None]).sum(1) - cen) @ pn + 0.004) / 0.004, 0, 1)
# (loft: the unwrap paints the neck; it only eases to the body's tone below the seam, inside the collar — below)
# ── skin colour across the seam: the body's skin is transferred onto the head's tone (Lab mean and spread), and
#    the head's last few cm above its cap ease toward that body tone so the jaw meets the neck without a step ──
def srgb2lin(c): c = np.clip(c, 0, 1); return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
def lin2srgb(c): c = np.clip(c, 0, 1); return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)
_M = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]]); _W = np.array([0.95047, 1.0, 1.08883])
def lin2lab(c):
    X = (c @ _M.T) / _W; f = np.where(X > 0.008856, np.cbrt(X), 7.787 * X + 16 / 116)
    return np.c_[116 * f[:, 1] - 16, 500 * (f[:, 0] - f[:, 1]), 200 * (f[:, 1] - f[:, 2])]
def lab2lin(L):
    fy = (L[:, 0] + 16) / 116; fx = fy + L[:, 1] / 500; fz = fy - L[:, 2] / 200
    f = np.c_[fx, fy, fz]; X = np.where(f ** 3 > 0.008856, f ** 3, (f - 16 / 116) / 7.787) * _W
    return np.clip(X @ np.linalg.inv(_M).T, 0, 1)
# the head's skin under the jaw and on the lower cheeks
skin_zone = (~hairy) & (hair_amt < 0.2) & (cp[:, 1] < yN - 0.015) & (cp[:, 1] > cen[1] - 0.005) & (np.abs(cp[:, 0]) > 0.02) & ~near_eye
tgt = lin2lab(srgb2lin(out[skin_zone] / 255))
mu_t, sd_t = tgt.mean(0), tgt.std(0)
# the body's skin texture over the visible body skin (below the seam)
sk_img = np.asarray(Image.open(os.path.join(os.path.dirname(binp), 'skin.jpg')).convert('RGB')).astype(float)
body_v = np.nonzero(((SP - cen) @ pn) < -0.01)[0]
pxs = np.clip((SUV[body_v, 0] * sk_img.shape[1]).astype(int), 0, sk_img.shape[1] - 1); pys = np.clip(((1 - SUV[body_v, 1]) * sk_img.shape[0]).astype(int), 0, sk_img.shape[0] - 1)
src_lin = srgb2lin(sk_img[pys, pxs] / 255); src = lin2lab(src_lin)
mu_s, sd_s = src.mean(0), src.std(0)
moved = lab2lin((src - mu_s) * np.clip(sd_t / np.maximum(sd_s, 1e-3), 0.6, 1.4) + mu_t)
Aff, *_ = np.linalg.lstsq(np.c_[src_lin, np.ones(len(src_lin))], moved, rcond=None)     # 4x3: linear RGB affine
skin_xform = Aff.T                                                                       # 3x4
print('skin Lab: head', mu_t.round(1), '±', sd_t.round(1), '| body', mu_s.round(1), '±', sd_s.round(1))
# the head's own last 2.5 cm above its cap: ease toward the (transferred) body tone; a soft shadow under the jaw
tone_lin = lab2lin(mu_t[None])[0]
h_tex = ((LV[vmap][UF[tt]] * tw[..., None]).sum(1) - cen) @ pn
chinfront = sstep(lm_f[152, 2] - 0.035, lm_f[152, 2] - 0.01, cp[:, 2])
fe = (np.clip(-h_tex / 0.012, 0, 1) if A.neck == 'loft' else np.clip(1 - (h_tex + 0.006) / 0.025, 0, 1) ** 1.5 * (1 - chinfront)) * (~hairy)
out_lin = srgb2lin(out / 255)
out_lin = out_lin * (1 - 0.55 * fe[:, None]) + tone_lin * 0.82 * 0.55 * fe[:, None]
out = lin2srgb(out_lin) * 255
seam_tone = list(map(float, tone_lin * 0.82))
# per (uv) vertex hair weight, for the hair cards the game roots on the scalp
hv_sum = np.zeros(len(UV)); hv_n = np.zeros(len(UV))
for k_ in range(3): np.add.at(hv_sum, UF[tt, k_], H_ * tw[:, k_]); np.add.at(hv_n, UF[tt, k_], tw[:, k_])
hair_v = hv_sum / np.maximum(hv_n, 1e-6)
hair_v[(VV - cen) @ pn < 0.01] = 0
# ── surface detail the 16k mesh loses (ear folds, hair, creases): a tangent-space normal map baked from the hi-res
#    surface (tangent frame from the UVs, as three.js derives it without tangents), and crevices darkened a touch ──
P0, P1, P2 = VV[UF[:, 0]], VV[UF[:, 1]], VV[UF[:, 2]]
U0_, U1_, U2_ = UV[UF[:, 0]], UV[UF[:, 1]], UV[UF[:, 2]]
d1, d2 = P1 - P0, P2 - P0; e1, e2 = U1_ - U0_, U2_ - U0_
den = e1[:, 0] * e2[:, 1] - e2[:, 0] * e1[:, 1]; den = np.where(np.abs(den) < 1e-12, 1e-12, den)
Tt = (d1 * e2[:, 1:2] - d2 * e1[:, 1:2]) / den[:, None]; Bt = (d2 * e1[:, 0:1] - d1 * e2[:, 0:1]) / den[:, None]
Tx, Bx = Tt[tt], Bt[tt]
Tx = Tx - tn * np.einsum('ij,ij->i', Tx, tn)[:, None]; Tx /= np.linalg.norm(Tx, axis=1, keepdims=True) + 1e-12
Bx = Bx - tn * np.einsum('ij,ij->i', Bx, tn)[:, None]; Bx /= np.linalg.norm(Bx, axis=1, keepdims=True) + 1e-12
nts = np.c_[np.einsum('ij,ij->i', hiN, Tx), np.einsum('ij,ij->i', hiN, Bx), np.einsum('ij,ij->i', hiN, tn)]
nts[:, 2] = np.maximum(nts[:, 2], 0.25); nts /= np.linalg.norm(nts, axis=1, keepdims=True)
# the generator's grin creases (nasolabial folds, the open lips) don't belong on the relaxed mouth: flatten the detail there
mouth_c = (lm_f[61] + lm_f[291]) / 2
mfl = np.exp(-(((cp[:, 0] - mouth_c[0]) / 0.04) ** 2 + ((cp[:, 1] - mouth_c[1] - 0.008) / 0.025) ** 2)) * (cp[:, 2] > mouth_c[2] - 0.04)
nts = nts * (1 - mfl[:, None]) + np.array([0, 0, 1.0]) * mfl[:, None]; nts /= np.linalg.norm(nts, axis=1, keepdims=True)
if STRIP_F0 is not None: nts[tt >= STRIP_F0] = [0, 0, 1.0]             # the inner-lip strips: no photo relief
nmap = np.zeros((T, T, 3), np.float32); nmap[..., 2] = 1.0
nmap[ty, tx] = nts
nimg = ((nmap * 0.5 + 0.5) * 255).astype(np.uint8)
NT = 1024
nhave = np.zeros((T, T), np.uint8); nhave[ty, tx] = 255
nimg = cv2.inpaint(nimg, 255 - nhave, 2, cv2.INPAINT_TELEA)
nimg = cv2.resize(nimg, (NT, NT), interpolation=cv2.INTER_AREA)
import io
_b = io.BytesIO(); Image.fromarray(nimg).save(_b, 'JPEG', quality=90); normal_jpg = np.frombuffer(_b.getvalue(), np.uint8)
print(f'  normal map {NT}px: {len(normal_jpg) // 1024} KB')
# crevices (the hi-res surface sits below the low-res one): concha, behind the ear, the nose and mouth corners
dep = np.einsum('ij,ij->i', cp - tp, tn)
ao = 1 - np.clip(-dep / 0.004, 0, 1) * 0.35 * (cp[:, 1] > lm_f[152, 1] - 0.003)   # not on the neck (the generator's cut rim)
out = out * ao[:, None]
tex = np.zeros((T, T, 3), np.float32); have = np.zeros((T, T), np.uint8)
tex[ty, tx] = out; have[ty, tx] = 255
# dilate into the gutters so mips don't bleed black
# first grow each chart's own colours outward a few texels (so bilinear/mip samples at a chart's edge, and sliver
# triangles with no texel centre of their own, read their own chart, not a neighbour's hair), then fill the rest
_hv = (have > 0).astype(np.float32); _tx = tex * _hv[..., None]
for _ in range(32):
    _cs = cv2.blur(_tx, (3, 3)); _cn = cv2.blur(_hv, (3, 3))
    _new = (_hv == 0) & (_cn > 0)
    _tx[_new] = _cs[_new] / _cn[_new][:, None]; _hv[_new] = 1
tex = _tx; have = np.where(_hv > 0, 255, 0).astype(np.uint8)
tex = cv2.inpaint(np.clip(tex, 0, 255).astype(np.uint8), 255 - have, 3, cv2.INPAINT_TELEA)
# clean-up of the photo-built face: a light edge-preserving smoothing over the face, a stronger despeckle on the lips,
# nose and brows (the selfies' compression noise and stray pixels read as artifacts up close)
def _near(idx, r):
    d = np.min(np.stack([np.linalg.norm(cp - lm_f[i], axis=1) for i in idx]), 0); return np.clip(1 - d / r, 0, 1)
w_face = (m_ if real_ok else np.zeros(len(cp)))
w_spot = np.maximum.reduce([_near([0, 17, 61, 291, 13, 14, 37, 267, 84, 314], 0.012), _near([1, 2, 4, 5, 98, 327, 48, 278], 0.012), _near([105, 66, 107, 334, 296, 336, 70, 300], 0.01)]) * (w_face > 0.2)
Mf = np.zeros((T, T), np.float32); Ms = np.zeros((T, T), np.float32); Mf[ty, tx] = w_face; Ms[ty, tx] = w_spot
Mf = cv2.GaussianBlur(Mf, (0, 0), 2)[..., None]; Ms = cv2.GaussianBlur(Ms, (0, 0), 2)[..., None]
bil = cv2.bilateralFilter(tex, 7, 22, 3).astype(np.float32); med = cv2.medianBlur(cv2.bilateralFilter(tex, 9, 30, 4), 5).astype(np.float32)
tex = np.clip(tex * (1 - 0.6 * Mf) + bil * 0.6 * Mf, 0, 255)
tex = np.clip(tex * (1 - Ms) + med * Ms, 0, 255)
# under the nose: the columella and the top of the philtrum to skin (a dark blend there read as a third nostril);
# the two nostrils (landmarks near 98/327, inside the alae) stay dark
nl_, nr_ = (lm_f[98] * 0.6 + lm_f[2] * 0.4), (lm_f[327] * 0.6 + lm_f[2] * 0.4)
col_c = (lm_f[2] * 0.7 + lm_f[164] * 0.3)
w_col = np.exp(-(((cp[:, 0] - col_c[0]) / 0.0045) ** 2 + ((cp[:, 1] - col_c[1]) / 0.006) ** 2)) * (cp[:, 2] > col_c[2] - 0.015) * (w_face > 0.2)
w_col *= np.clip(np.minimum(np.linalg.norm(cp - nl_, axis=1), np.linalg.norm(cp - nr_, axis=1)) / 0.004 - 0.6, 0, 1)
Mc = np.zeros((T, T), np.float32); Mc[ty, tx] = w_col; Mc = cv2.GaussianBlur(Mc, (0, 0), 1.5)[..., None]
_lip_skin = np.median(out[(np.abs(cp[:, 0] - col_c[0]) < 0.012) & (cp[:, 1] < col_c[1] - 0.006) & (cp[:, 1] > lm_f[0][1] + 0.002) & (w_face > 0.5)], 0) if True else skin_c
tex = np.clip(tex * (1 - 0.85 * Mc) + np.array(_lip_skin, np.float32) * 0.85 * Mc, 0, 255)
# brows: the photo median leaves them as flat dark bands; soften (blur) and lift them a touch toward the skin
w_brow = _near([70, 63, 105, 66, 107, 336, 296, 334, 293, 300, 46, 53, 52, 65, 55, 276, 283, 282, 295, 285], 0.012) * (w_face > 0.2)
Mb = np.zeros((T, T), np.float32); Mb[ty, tx] = w_brow; Mb = cv2.GaussianBlur(Mb, (0, 0), 3)[..., None]
soft = cv2.GaussianBlur(tex.astype(np.float32), (0, 0), 2.2) * 0.85 + np.array(skin_c, np.float32) * 0.15
tex = np.clip(tex * (1 - 0.7 * Mb) + soft * 0.7 * Mb, 0, 255).astype(np.uint8)
# the nose wings: the photos bake a dark blotch along each alar crease (it read as a second nostril on one side).
# Lift texels darker than the wing's own skin to a soft, subtle crease; the nostril openings themselves stay dark.
# ── the nose: the photos draw one side of it cleanly and the other with a red, mottled band down its wall and dark
#    blotches round the wing (the selfie's own shadow side). The bad side takes the mirror image of the good side's
#    colour (same place on the face, across the midline) wherever the two differ: exactly two nostrils, where the
#    good side has its one, and an even tone down both walls of the nose. ──
_texF = tex.astype(np.float32); _texC = _texF[ty, tx]
_cx = float(np.median(lm_f[[1, 2, 4, 5, 6, 168, 164, 0], 0]))
_sgn = {'+': 1.0, '-': -1.0}.get(A.nose_mirror, 0.0)
if _sgn:
    _y0, _y1 = lm_f[2, 1] - 0.008, min(lm_f[133, 1], lm_f[362, 1]) - 0.003
    _ty = np.clip((cp[:, 1] - _y0) / (_y1 - _y0), 0, 1)
    _xmax = 0.021 - 0.009 * _ty                                         # wide at the wings, narrowing up the wall
    _xr = (cp[:, 0] - _cx) * _sgn
    _zone = (cp[:, 1] > _y0) & (cp[:, 1] < _y1) & (cp[:, 2] > lm_f[2, 2] - 0.035)
    _good = np.nonzero(_zone & (_xr < 0) & (_xr > -0.026))[0]
    _sel = np.nonzero(_zone & (_xr > 0.0003) & (_xr < _xmax + 0.003))[0]
    _mir = cp[_sel].copy(); _mir[:, 0] = 2 * _cx - _mir[:, 0]
    _dm, _im = cKDTree(cp[_good]).query(_mir, k=8)
    _wq = 1 / (_dm + 2e-4); _wq /= _wq.sum(1, keepdims=True)
    _cm = (_texC[_good][_im] * _wq[..., None]).sum(1)
    _w = np.clip((_xr[_sel] - 0.0003) / 0.002, 0, 1) * np.clip((_xmax[_sel] + 0.003 - _xr[_sel]) / 0.003, 0, 1)
    _w *= np.clip(1 - (_dm[:, 0] - 0.0015) / 0.002, 0, 1)             # only where the mirror point lies on the surface
    _w *= np.clip((cp[_sel, 1] - _y0) / 0.003, 0, 1) * np.clip((_y1 - cp[_sel, 1]) / 0.004, 0, 1)
    _diff = np.linalg.norm(_texC[_sel] - _cm, axis=1)
    _w *= np.clip((_diff - 10) / 14, 0, 1)
    _wm = np.zeros((T, T), np.float32); _wm[ty[_sel], tx[_sel]] = _w; _wm = cv2.GaussianBlur(_wm, (0, 0), 1.5)[..., None]
    _cmi = _texF.copy(); _cmi[ty[_sel], tx[_sel]] = _cm
    tex = np.clip(_texF * (1 - _wm) + _cmi * _wm, 0, 255).astype(np.uint8)
    print(f'  nose: {int((_w > 0.5).sum())} texels on the x{"+" if _sgn > 0 else "-"} side repainted from the mirrored side')
# ── systematic clean-up of the photo-built face: dark outliers (the selfies' shadows and compression blotches) are
#    found against a local median and inpainted toward the surrounding skin, outside protected features (nostrils,
#    eye openings and lash lines, the lip line, the brow hair). Then the brows: a clean band of brow hair with soft
#    edges, the shadowed skin round them (orbital shadows) lifted toward neutral, and both sides matched in tone. ──
def _poly_d(P, pts):
    d = np.full(len(P), 9.0)
    for a3, b3 in zip(pts[:-1], pts[1:]):
        ab = b3 - a3; t_ = np.clip(((P - a3) @ ab) / max(ab @ ab, 1e-12), 0, 1)
        d = np.minimum(d, np.linalg.norm(P - (a3 + t_[:, None] * ab), axis=1))
    return d
def _tex_map(vals, blur=0):
    m_ = np.zeros((T, T), np.float32); m_[ty, tx] = vals
    return cv2.GaussianBlur(m_, (0, 0), blur) if blur else m_
_hair_t = H_ if 'H_' in globals() else np.zeros(len(cp))
# the face (real-photo or unwrap-sourced alike): in front of the cheek sides, chin to the brow-top, no hair
_faceF = ((_hair_t < 0.3) | (cp[:, 1] < min(lm_f[133, 1], lm_f[362, 1]) - 0.01)) & (cp[:, 2] > min(lm_f[234, 2], lm_f[454, 2]) + 0.005) & (cp[:, 1] > lm_f[152, 1] + 0.004) & (cp[:, 1] < lm_f[10, 1] - 0.01)
# protected features
_prot = np.zeros(len(cp))
# the nose base, wing to wing (its nostrils and creases are settled by the mirrored repaint above)
_prot = np.maximum(_prot, np.clip(1.15 - np.linalg.norm((cp - (lm_f[2] + [0, 0.002, 0]))[:, :2] / [abs(lm_f[358, 0] - lm_f[129, 0]) / 2 + 0.003, 0.009], axis=1), 0, 1) * 6).clip(0, 1) * (cp[:, 2] > lm_f[2, 2] - 0.035)
_EYEC = ([33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7, 33], [362, 398, 384, 385, 386, 387, 388, 466, 263, 249, 390, 373, 374, 380, 381, 382, 362])
for _ec in _EYEC:                                                             # eye openings and lash lines (1.5 mm round)
    _prot = np.maximum(_prot, np.clip(1 - (_poly_d(cp, lm_f[_ec]) - 0.0015) / 0.001, 0, 1))
    _o = lm_f[_ec]; _cc = _o.mean(0)
    _inside = np.linalg.norm((cp - _cc)[:, :2] / [np.ptp(_o[:, 0]) / 2 + 1e-6, np.ptp(_o[:, 1]) / 2 + 1e-6], axis=1) < 1.05
    _prot = np.maximum(_prot, _inside * (np.abs(cp[:, 2] - _cc[2]) < 0.012))
_LIPL = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308]; _LIPL2 = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308]
_lipline = (lm_f[_LIPL] + lm_f[_LIPL2]) / 2
_prot = np.maximum(_prot, np.clip(1 - (_poly_d(cp, _lipline) - 0.0012) / 0.001, 0, 1))
# the lips themselves (inside the outer lip contour, 1 mm round): their own colour, never "dark outliers"
_LIPO = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185, 61]
_lpoly = (lm_f[_LIPO][:, :2] * 1e4).astype(np.float32)
_lsd = np.array([cv2.pointPolygonTest(_lpoly, (float(x_ * 1e4), float(y_ * 1e4)), True) for x_, y_ in cp[_faceF & (np.abs(cp[:, 1] - lm_f[13, 1]) < 0.025), :2]]) / 1e4
_lm_ = np.zeros(len(cp)); _lm_[_faceF & (np.abs(cp[:, 1] - lm_f[13, 1]) < 0.025)] = np.clip((_lsd + 0.0015) / 0.001, 0, 1)
_prot = np.maximum(_prot, _lm_ * (cp[:, 2] > lm_f[13, 2] - 0.02))
_BROW_U = ([70, 63, 105, 66, 107], [300, 293, 334, 296, 336]); _BROW_L = ([46, 53, 52, 65, 55], [276, 283, 282, 295, 285])
_brow_core = np.zeros(len(cp)); _brow_near = np.zeros(len(cp))
for _bu, _bl in zip(_BROW_U, _BROW_L):
    _cl = (lm_f[_bu] + lm_f[_bl]) / 2                                       # centre line, lateral (tail) → medial (head)
    # the painted brow hair sits a few mm off the landmark line: slide the line (up/down) onto the darkness's centre
    _d0 = _poly_d(cp, _cl); _nr = (_d0 < 0.011) & (np.abs(cp[:, 0] - _cl[:, 0].mean()) < np.ptp(_cl[:, 0]) / 2) & (cp[:, 2] > _cl[:, 2].min() - 0.015)
    _Lr = tex[ty[_nr], tx[_nr]].astype(np.float32).mean(1); _dk = np.clip(np.percentile(_Lr, 60) - _Lr, 0, None) ** 2
    _dy = float(((cp[_nr, 1] - np.interp(cp[_nr, 0], *(lambda o: (_cl[o, 0], _cl[o, 1]))(np.argsort(_cl[:, 0])))) * _dk).sum() / max(_dk.sum(), 1e-9))
    _cl = _cl + [0, np.clip(_dy, -0.005, 0.005), 0]; print(f'  brow line moved {_dy * 1000:+.1f} mm onto the painted hair')
    _hh = np.linalg.norm(lm_f[_bu] - lm_f[_bl], axis=1) / 2                  # half-height along it
    _db = _poly_d(cp, _cl)
    # the half-height at each texel's nearest point along the line (interpolated by the param along the brow)
    _ax = _cl[-1] - _cl[0]; _s = np.clip(((cp - _cl[0]) @ _ax) / (_ax @ _ax), 0, 1)
    _hs = np.interp(_s, np.linspace(0, 1, len(_hh)), np.clip(_hh * 1.25, 0.0022, 0.0038) * np.linspace(0.7, 1.0, len(_hh)))
    _brow_core = np.maximum(_brow_core, np.clip(1 - (_db - _hs) / 0.0012, 0, 1))
    _brow_near = np.maximum(_brow_near, np.clip(1 - (_db - _hs) / 0.010, 0, 1))
_prot = np.maximum(_prot, _brow_core)
_texF = tex.astype(np.float32); _Lt = _texF.mean(2)
_med = cv2.medianBlur(np.clip(_Lt, 0, 255).astype(np.uint8), 15).astype(np.float32)
_rat = _Lt[ty, tx] / np.maximum(_med[ty, tx], 1)
# and blotches wider than that window: against a 41 px median (a little milder threshold)
_med2 = cv2.medianBlur(np.clip(_Lt, 0, 255).astype(np.uint8), 41).astype(np.float32)
_rat2 = _Lt[ty, tx] / np.maximum(_med2[ty, tx], 1)
_out = np.maximum(np.clip((0.78 - _rat) / 0.08, 0, 1), np.clip((0.82 - _rat2) / 0.08, 0, 1)) * _faceF * (1 - _prot)
_om = (_tex_map(_out) > 0.3).astype(np.uint8) * 255
_om = cv2.dilate(_om, np.ones((3, 3), np.uint8))
_inp = cv2.inpaint(np.clip(_texF, 0, 255).astype(np.uint8), _om, 6, cv2.INPAINT_TELEA).astype(np.float32)
_ow = cv2.GaussianBlur(_om.astype(np.float32) / 255, (0, 0), 1.2)[..., None]
_texF = _texF * (1 - _ow) + _inp * _ow
print(f'  clean-up: {int((_out > 0.3).sum())} dark outlier texels inpainted')
# the brows and the orbits: the skin round the brow band (and the upper lids, the sockets) lifted toward the
# cheek/forehead skin's lightness; the brow band itself kept, its edges softened, both brows matched in tone
_Lt = _texF.mean(2)[ty, tx]
_ref = np.median(_Lt[_faceF & (_prot == 0) & (_brow_near == 0) & (cp[:, 1] < lm_f[168, 1]) & (cp[:, 1] > lm_f[164, 1])])   # cheeks and nose, between the brow root and the lip
_orb = np.zeros(len(cp))
for _ec, _bu in zip(_EYEC, _BROW_U):
    _o = lm_f[_ec]; _cc = _o.mean(0); _bc = lm_f[_bu].mean(0)
    # from just under the eye up to the brow: an ellipse over the socket
    _c2 = np.array([_cc[0], (_cc[1] + _bc[1]) / 2 - 0.002, _cc[2]]); _rx = np.ptp(_o[:, 0]) / 2 + 0.008; _ry = (_bc[1] - _cc[1]) / 2 + 0.012
    _orb = np.maximum(_orb, np.clip(1.2 - np.linalg.norm((cp - _c2)[:, :2] / [_rx, _ry], axis=1), 0, 1) * (cp[:, 2] > _cc[2] - 0.02))
_skinz = np.maximum(_orb * 0.7, _brow_near) * (1 - _prot) * _faceF     # (_prot includes the brow core); strongest right round the brow band
# fade out toward the lash lines (the lids keep their own fold shading)
_dl = np.min(np.stack([_poly_d(cp, lm_f[_ec]) for _ec in _EYEC]), 0)
_skinz = _skinz * np.clip((_dl - 0.002) / 0.003, 0, 1)
_refc = np.median(_texF[ty, tx][_faceF & (_prot == 0) & (_brow_near == 0) & (cp[:, 1] < lm_f[168, 1]) & (cp[:, 1] > lm_f[164, 1])], 0)
_lift = np.zeros(len(cp))
# brows: one tone for both (the mean of their medians), applied as a gain inside the band only
_bg = np.ones(len(cp))
_sideL = cp[:, 0] < lm_f[168, 0]
_bm = [np.median(_Lt[(_brow_core > 0.7) & (_sideL == sd)]) if ((_brow_core > 0.7) & (_sideL == sd)).sum() > 30 else np.nan for sd in (True, False)]
if not np.isnan(_bm).any():
    _bt = (_bm[0] + _bm[1]) / 2
    _bg = np.where(_sideL, _bt / _bm[0], _bt / _bm[1])
    print(f'  brows: tone {np.round(_bm, 1)} → {_bt:.1f}; orbital/brow skin blended toward {_refc.round()}')
_gmap = _tex_map((_bg - 1) * _brow_core, 1.5)[..., None]
_texF = _texF * (1 + _gmap)
# the shadowed skin: blended toward the skin colour, keeping its own fine texture (lightness over a local blur)
_Lb = cv2.GaussianBlur(_texF.mean(2), (0, 0), 4)
_detail = (_texF.mean(2) / np.maximum(_Lb, 1))[..., None]
_ow2 = _tex_map(np.clip((_ref * 0.95 - _Lt) / (_ref * 0.3), 0, 1) * _skinz * 0.9, 2.0)[..., None]
_texF = _texF * (1 - _ow2) + np.clip(_refc[None, None] * _detail, 0, 255) * _ow2
# and their hue (the selfies' olive and tan casts round the sockets and over the brow ridge): toward the skin's own
# hue at the texel's own lightness, whatever its darkness
_Lc = _texF.mean(2, keepdims=True)
_hue = np.clip(_refc[None, None] / max(_refc.mean(), 1) * _Lc, 0, 255)
_ow3 = _tex_map(_skinz * 0.6, 2.0)[..., None]
_texF = _texF * (1 - _ow3) + _hue * _ow3
# soften the brow band's edges (a gentle blur where core falls off), leaving the hair texture in the middle
_edge = _tex_map(np.clip(_brow_core * (1 - _brow_core) * 4, 0, 1) * _faceF, 1.0)[..., None]
_texF = _texF * (1 - 0.6 * _edge) + cv2.GaussianBlur(_texF, (0, 0), 1.6) * 0.6 * _edge
tex = np.clip(_texF, 0, 255).astype(np.uint8)
if DBG:   # the clean-up's masks painted on the texture (red: outliers, green: shadow lift, blue: protected)
    _dm = tex.astype(np.float32) * 0.6
    _dm[..., 0] += 255 * 0.4 * _tex_map(_out); _dm[..., 1] += 255 * 0.4 * _tex_map(_skinz); _dm[..., 2] += 255 * 0.4 * _tex_map(_prot)
    Image.fromarray(np.clip(_dm, 0, 255).astype(np.uint8)).save(os.path.join(DBG, 'head_maskdbg.jpg'), quality=90)
# the mouth corners: his photos carry a downturned shadow below and outside each corner (the 'glum' read); lighten it
# halfway toward the cheek's skin tone
_mar = np.zeros(len(cp))
for _ci, _sx in ((61, -1), (291, 1)):
    _sx = np.sign(lm_f[_ci, 0] - (lm_f[61, 0] + lm_f[291, 0]) / 2)
    _mc = lm_f[_ci] + np.array([0.004 * _sx, -0.009, -0.002])
    _mar = np.maximum(_mar, np.exp(-(np.linalg.norm((cp - _mc) * [1, 0.8, 1], axis=1) / 0.009) ** 2) * (cp[:, 2] > _mc[2] - 0.02))
_mar *= (1 - _prot)
_tf = tex.astype(np.float32); _Lm_ = _tf.mean(2)[ty, tx]
_wm = _tex_map(np.clip((_ref * 0.97 - _Lm_) / (_ref * 0.25), 0, 1) * _mar * 0.55, 2.0)[..., None]
_Lb2 = cv2.GaussianBlur(_tf.mean(2), (0, 0), 4); _det2 = (_tf.mean(2) / np.maximum(_Lb2, 1))[..., None]
tex = np.clip(_tf * (1 - _wm) + np.clip(_refc[None, None] * _det2, 0, 255) * _wm, 0, 255).astype(np.uint8)
# the inner-lip strips: wet lip colour at the lip edge, darker and redder going back into the mouth
if STRIP_F0 is not None:
    _st = tt >= STRIP_F0
    _lw = (LIPIN[vmap][UF[tt]] * tw).sum(1)
    _lipc = np.median(tex[ty, tx][(np.linalg.norm(cp - lm_f[14], axis=1) < 0.003) | (np.linalg.norm(cp - lm_f[13], axis=1) < 0.003)].astype(np.float32), 0)
    _inn = np.clip(_lipc[None] * np.array([1.0, 0.9, 0.9]) * (1.0 - 0.5 * np.clip(_lw[_st] - 0.3, 0, 1))[:, None], 0, 255)   # lip colour at the edge (no dark line at rest), darker only deep in
    _tf = tex.astype(np.float32); _tf[ty[_st], tx[_st]] = _inn
    tex = np.clip(_tf, 0, 255).astype(np.uint8)
    print(f'  inner lips: {int(_st.sum())} texels, lip colour {_lipc.round()}')
Image.fromarray(tex).save(os.path.join(A.out, 'head.jpg'), quality=88, optimize=True)
dbg('head_tex.png', tex)

# ── the eyes: per-vertex eye coordinates (e = (across, up), the eye opening is |e| < 1), so the shader can draw
#    sclera, iris and lids and move them (gaze, blink) whatever the UV charts do round the eyes ──
eyeA = np.tile([9.0, 9.0, 1.0, 0.4], (len(LV), 1)); eyeB = np.zeros((len(LV), 2))
eyes_info = []
for (ca, cb, up, lo_, ir) in ((33, 133, 159, 145, 468), (362, 263, 386, 374, 473)):   # both 'across' axes point to +x (true)
    c3 = (lm_f[ca] + lm_f[cb]) / 2; X = (lm_f[cb] - lm_f[ca]) / 2
    Y = (lm_f[up] - lm_f[lo_]) / 2; Y = Y - X * (Y @ X) / (X @ X)
    Y = Y / np.linalg.norm(Y) * max(np.linalg.norm(Y), 0.0035)        # a squinted sculpt: keep a readable opening
    d = LV - c3
    ex, ey = d @ X / (X @ X), d @ Y / (Y @ Y)
    nrm = np.cross(X, Y); depth = np.abs(d @ nrm / np.linalg.norm(nrm))
    # generous: every triangle touching the opening must carry true (linear) coordinates, or it smears across it
    near = (np.abs(ex) < 3.5) & (np.abs(ey) < 9) & (depth < 0.02)
    eyeA[near, 0], eyeA[near, 1] = ex[near], ey[near]
    eyeA[near, 2] = np.linalg.norm(Y) / np.linalg.norm(X)             # up-units per across-unit
    eyeA[near, 3] = (d @ (nrm / np.linalg.norm(nrm)))[near]           # signed distance off the eye's plane (the shader keeps to |d| < 5 mm)
    di = lm_f[ir] - c3; eyeB[near] = [di @ X / (X @ X), di @ Y / (Y @ Y)]
    eyes_info.append({'halfWidthMM': float(np.linalg.norm(X) * 1000), 'halfOpenMM': float(np.linalg.norm(Y) * 1000), 'iris': [float(di @ X / (X @ X)), float(di @ Y / (Y @ Y))]})
    print(f"  eye: half-width {np.linalg.norm(X) * 1000:.1f} mm, half-opening {np.linalg.norm(Y) * 1000:.1f} mm, iris at {np.round(eyeB[near][0], 2) if near.any() else '-'}, {int(near.sum())} verts")
# colours the shader paints with, from the texture round the eyes
eyes_uv = eyes_info
# the unwrap's own irises (blue-grey, limbal ring, fibres), cropped for the shader, and its sclera tone
iris_png = None
# (with his real photos in use, the irises and sclera come from his front photo instead)
_Uiris, _Liris, _src = (U, Lu, 'the unwrap') if A.unwrap not in (None, 'none') and os.path.exists(A.unwrap) else (None, None, '')
if real_ok:
    for cam in mv_cams:
        if REAL[0] in os.path.basename(cam['photo']):
            _Uiris = np.asarray(ImageOps.exif_transpose(Image.open(cam['photo'])).convert('RGB')).astype(np.float32)
            _Liris = np.array(json.load(open(cam['photo'] + '.lm.json'))['pts'], float)[:, :2]; _src = os.path.basename(cam['photo'])
if _Uiris is not None:
    U, Lu = _Uiris, _Liris
    import io
    tiles = []
    for k_, (ic_, ring_) in enumerate(((468, (469, 470, 471, 472)), (473, (474, 475, 476, 477)))):
        cxy = Lu[ic_]; rad = float(np.mean(np.linalg.norm(Lu[list(ring_)] - cxy, axis=1)))
        box = (cxy[0] - rad * 1.25, cxy[1] - rad * 1.25, cxy[0] + rad * 1.25, cxy[1] + rad * 1.25)
        tiles.append(Image.fromarray(U.astype(np.uint8)).crop(tuple(int(round(b_)) for b_ in box)).resize((96, 96), Image.LANCZOS))
        # sclera: between the iris and each corner of the eye
        crn = Lu[[33, 133] if k_ == 0 else [362, 263]]
        pts = [cxy + (c_ - cxy) * f_ for c_ in crn for f_ in (0.55, 0.65)]
        eyes_uv[k_]['sclera'] = list(map(float, np.clip(np.median(np.array([U[int(y_) - 1:int(y_) + 2, int(x_) - 1:int(x_) + 2].reshape(-1, 3) for x_, y_ in pts]).reshape(-1, 3), 0) / 255 * (1.2 if real_ok else 1.0), 0, 0.8)))
        eyes_uv[k_]['irisCrop'] = 1.25        # the tile spans ±1.25 iris radii
    sheet_ = Image.new('RGB', (192, 96)); sheet_.paste(tiles[0], (0, 0)); sheet_.paste(tiles[1], (96, 0))
    buf_ = io.BytesIO(); sheet_.save(buf_, 'PNG'); iris_png = np.frombuffer(buf_.getvalue(), np.uint8)
    if DBG: sheet_.save(os.path.join(DBG, 'irises.png'))
    print('  irises from', _src, '; sclera', [np.round(np.array(e_['sclera']) * 255) for e_ in eyes_uv])
# (the body's skin colour: skin_xform above; a flat tint is kept for older loaders)
tint = np.ones(3)   # (superseded by skinXform; kept so older loaders still read a tint)

# ── sanity: every vertex weighted (summing to 1) to the head and neck chain only, nothing far below the jaw ──
_wsum = np.array([sum(v for _, v in w) for w in wts]); assert np.allclose(_wsum, 1, atol=1e-3), 'skin weights must sum to 1'
_ok_b = {B.index(n_) for n_ in ('head', 'neck_01', 'spine_02', 'spine_03') if n_ in B}   # never the clavicles or arms: rounding the shoulders at address dragged the neck out over the collar
_bad_w = [i for i, w in enumerate(wts) if any(v > 0 and b_ not in _ok_b for b_, v in w)]
if _bad_w: print(f'  re-weighting {len(_bad_w)} verts that leaned on shoulder/arm bones to their spine/neck/head share')
for i in _bad_w:
    w = [(b_, v) for b_, v in wts[i] if b_ in _ok_b and v > 0] or [(hb, 1.0)]; t_ = sum(v for _, v in w)
    wts[i] = [(b_, v / t_) for b_, v in w] + [(0, 0.0)] * (4 - len(w))
assert LV[:, 1].min() > lm_f[152, 1] - 0.2, f'a vertex {lm_f[152, 1] - LV[:, 1].min():.2f} m below the chin'
# a stray piece (not connected to the head) is dropped
_cc = trimesh.Trimesh(LV, LF, process=False).face_adjacency
import scipy.sparse as _sp, scipy.sparse.csgraph as _cg
_ncomp, _lab = _cg.connected_components(_sp.coo_matrix((np.ones(len(_cc)), (_cc[:, 0], _cc[:, 1])), shape=(len(LF), len(LF))), directed=False)
if _ncomp > 1:
    _sizes = np.bincount(_lab); _main = _sizes.argmax(); _small = _sizes < 0.02 * len(LF)
    _drop = _small[_lab]
    if _drop.any():
        print(f'  dropping {int(_drop.sum())} faces in {int(_small.sum())} stray pieces')
        UF = UF[~_drop]                                                # (UF is LF's faces, in order)
# ───────────────────────── write head.bin ─────────────────────────
# the rest face: ease the portrait's open grin toward a relaxed smile (after the bake, so the texture rides along)
PV = mir(VV).astype(np.float32)
PN = mir(NN).astype(np.float32)
IDX = UF[:, ::-1] if mirror else UF                  # mirroring flips the winding
sw = [wts[i] for i in vmap]
bones_used = used
bidx = np.array([[used.index(b_) if v > 0 else 0 for b_, v in w] for w in sw], np.uint8)
bw = np.array([[v for _, v in w] for w in sw], np.float32)
seamw = np.clip(((VV - cen) @ pn) / BAND, 0, 1).astype(np.float32)
blob = bytearray(); desc = {}
def put(name, a):
    global blob
    while len(blob) % 4: blob += b'\0'
    desc[name] = {'offset': len(blob), 'count': int(a.size), 'type': a.dtype.name}; blob += np.ascontiguousarray(a).tobytes()
put('position', PV.ravel()); put('normal', PN.ravel()); put('uv', UV.astype(np.float32).ravel())
put('index', IDX.astype(np.uint16 if len(UV) < 65536 else np.uint32).ravel())
put('hair', np.round(np.clip(hair_v, 0, 1) * 255).astype(np.uint8))
if iris_png is not None: put('irisPng', iris_png)
put('normalJpg', normal_jpg)
put('skinIndex', bidx.ravel()); put('skinWeight', bw.ravel()); put('seam', seamw)
# the mouth: per-vertex (across, up, off-plane) round the lip seam (the shader draws the mouth's inside as it opens)
mc_c = (lm_f[13] + lm_f[14]) / 2; MX = (lm_f[291] - lm_f[61]) / 2; MY = (lm_f[0] - lm_f[17]) / 2; MY = MY - MX * (MY @ MX) / (MX @ MX)
dmo = LV - mc_c; mx_, my_ = dmo @ MX / (MX @ MX), dmo @ MY / (MY @ MY); mnrm = np.cross(MX, MY); mnrm /= np.linalg.norm(mnrm); mdep = dmo @ mnrm
mouthA = np.tile([9.0, 9.0, 9.0], (len(LV), 1)); mnear = (np.abs(mx_) < 2.5) & (np.abs(my_) < 3) & (np.abs(mdep) < 0.03)
mouthA[mnear] = np.c_[mx_, my_, mdep][mnear]
_ma = mouthA[vmap]; _mi = np.nonzero(_ma[:, 0] < 8)[0]
put('mouth_i', _mi.astype(np.uint16 if len(UV) < 65536 else np.uint32)); put('mouth_v', _ma[_mi].astype(np.float32).ravel())
_ea, _eb = eyeA[vmap], eyeB[vmap]; _ei = np.nonzero(_ea[:, 0] < 8)[0]          # sparse: only the verts round the eyes
put('eye_i', _ei.astype(np.uint16 if len(UV) < 65536 else np.uint32)); put('eye_v', np.c_[_ea[_ei], _eb[_ei]].astype(np.float32).ravel())
# expressions: sparse, int16 in 10 µm units
mnames = []
for name, dv in morph_d.items():
    d = mir(dv[vmap])
    nz = np.nonzero(np.abs(d).max(1) > 1e-5)[0]
    put('morph_' + name + '_i', nz.astype(np.uint16 if len(UV) < 65536 else np.uint32)); put('morph_' + name + '_d', np.round(d[nz] / 1e-5).astype(np.int16).ravel())
    mnames.append(name)
meta = {
    'mouthRig': ({k_: list(map(float, mir(np.asarray(v_)[None])[0])) for k_, v_ in mouth_rig.items()} if mouth_rig else None),
    'faceShape': {'params': (list(map(float, qf)) if qf is not None else None), 'ratios': ratio_table},
    'arrays': desc, 'bones': [B[i] for i in bones_used],
    'eye': list(map(float, eye_mh)), 'ipd': float(ipd_mh),
    'seam': {'point': list(map(float, mir(cen - pn * (0.010 if A.neck == 'loft' else 0.0)))), 'normal': list(map(float, mir(pn))), 'band': BAND},
    'skinTint': list(map(float, tint)), 'skinXform': [list(map(float, r_)) for r_ in skin_xform], 'seamTone': seam_tone, 'skinColor': list(map(float, skin_c / 255)), 'hairColor': list(map(float, hair_c / 255)),
    'mirrored': mirror, 'source': os.path.basename(A.raw), 'photos': [os.path.basename(p) for p in photos],
    'tris': int(len(UF)), 'tex': T, 'lidMorph': bool(A.lids), 'morphs': mnames, 'morphUnit': 1e-5, 'eyes': eyes_uv,
}
mj = json.dumps(meta).encode()
while (8 + len(mj)) % 4: mj += b' '
with open(os.path.join(A.out, 'head.bin'), 'wb') as fh:
    fh.write(b'HEAD'); fh.write(struct.pack('<I', len(mj))); fh.write(mj); fh.write(blob)
print('wrote head.bin', os.path.getsize(os.path.join(A.out, 'head.bin')) // 1024, 'KB, head.jpg', os.path.getsize(os.path.join(A.out, 'head.jpg')) // 1024, 'KB;', len(UF), 'tris')
