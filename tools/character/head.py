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
from PIL import Image
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
ap.add_argument('--neck', default='cap', choices=['cap', 'loft'], help="cap: keep the generator's cap, the body's neck shows below; loft: grow a neck down into the collar")
ap.add_argument('--head-scale', type=float, default=1.0)
ap.add_argument('--head-width', type=float, default=1.0, help='overall width of the whole head (the face reshape sets the face itself)')
ap.add_argument('--head-width-face', type=float, default=0.96, help='starting face width for the reshape fit')
ap.add_argument('--no-reshape', dest='reshape', action='store_false')
ap.add_argument('--face-length', type=float, default=1.08, help='stretch below the nose (the user reads the face as too short)')
ap.add_argument('--forehead', type=float, default=1.12, help='stretch of the brow-to-hairline band (~3 cm)')
ap.add_argument('--cheek-fill', type=float, default=0.0025, help='extra fullness (m) at the cheek apples')
ap.add_argument('--hair-top', type=float, default=0.125, help='top of the hair above the eyes (m)')
ap.add_argument('--crop', type=float, default=0.01, help='metres cut off the bottom of the generated neck stub')
ap.add_argument('--handed', default='left')
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
    wid, temple, jaw, chin, lower, nose = q
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
    for sx_, tip_ in ear_tips:
        we_ = np.clip(1 - np.linalg.norm(P - tip_, axis=1) / 0.03, 0, 1) ** 1.5 * (P[:, 0] * sx_ > abs(tip_[0]) - 0.02)
        P[:, 0] += sx_ * 0.007 * we_
    # (no hollow under the cheekbones: the user wants the cheeks fuller)
    # fuller cheeks where his smile lifts them (the apples, upper/mid cheek), the jaw below stays defined
    apple = np.exp(-(((np.abs(x) - 0.036) / 0.016) ** 2 + ((y - (yN + 0.002)) / 0.016) ** 2)) * front
    P[:, 2] += A.cheek_fill * apple; P[:, 0] += np.sign(x) * 0.6 * A.cheek_fill * apple
    # a slightly taller forehead (the hairline sits higher above the brows)
    fh_ = sstep(eyeYf + 0.012, eyeYf + 0.04, y)
    P[:, 1] += (A.forehead - 1) * np.maximum(y - (eyeYf + 0.012), 0) * (1 - fh_) + (A.forehead - 1) * 0.028 * fh_
    below = y < yN
    P[below, 1] = yN - (yN - y[below]) * lower
    return P
from scipy.optimize import least_squares
r0 = ratios(cam_fit(lm_f))
if A.reshape:
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
    neck_z = SP[(np.abs(SP[:, 1] - (y_seam_at(SP[:, 2]) - 0.012)) < 0.008) & (np.abs(SP[:, 0]) < 0.075)]
    axis_c = np.array([0.0, (neck_z[:, 2].min() + neck_z[:, 2].max()) / 2])
    neckv = neck_z
    na = np.arctan2(neckv[:, 0] - axis_c[0], neckv[:, 2] - axis_c[1]); nr = np.hypot(neckv[:, 0] - axis_c[0], neckv[:, 2] - axis_c[1])
    def neck_r(a):
        da = np.abs((na - a + np.pi) % (2 * np.pi) - np.pi); sel = da < 0.15
        return np.percentile(nr[sel], 75) if sel.sum() > 2 else nr.mean()
    top = LV[loop]
    ta = np.arctan2(top[:, 0] - axis_c[0], top[:, 2] - axis_c[1])
    OVER = 0.012   # the neck runs on past the seam, down inside the collar, over the body's neck
    bot = np.array([[axis_c[0] + math.sin(a) * (neck_r(a) + 0.0015), 0, axis_c[1] + math.cos(a) * (neck_r(a) + 0.0015)] for a in ta]); bot[:, 1] = y_seam_at(bot[:, 2]) - OVER
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
if A.neck == 'cap': kk[:] = 1.0
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
    'jawOpen': {'mouth-open': 0.4},
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
        if name in ('grimace', 'jawOpen', 'smile'): dv *= (1 - teeth_m)[:, None]   # the painted teeth stay rigid; only the lips move
        morph_d[name] = dv
        print(f'  expression {name}: {int((np.linalg.norm(dv, axis=1) > 2e-4).sum())} verts move, max {np.linalg.norm(dv, axis=1).max() * 1000:.1f} mm')
else:
    print('(no MakeHuman data at', A.mpfb, '- no expressions)')
# ───────────────────────── unwrap ─────────────────────────
atlas = xatlas.Atlas(); atlas.add_mesh(LV.astype(np.float32), LF.astype(np.uint32))
co = xatlas.ChartOptions(); co.max_cost = 2.0
po = xatlas.PackOptions(); po.resolution = A.tex; po.padding = 4; po.bilinear = True
atlas.generate(co, po)
vmap, UF, UV = atlas[0]
print('atlas', atlas.width, 'x', atlas.height, len(UV), 'uv verts')
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
    cu = np.stack([map_coordinates(U[..., k], [xy[:, 1] - 0.5, xy[:, 0] - 0.5], order=1, mode='nearest') for k in range(3)], 1)
    ang = np.abs(np.arctan2(cp[:, 0] - hc_[0], cp[:, 2] - hc_[2]))
    wu = np.clip(np.minimum.reduce([xy[:, 0] - 4, UW - 4 - xy[:, 0], xy[:, 1] - 4, UH - 4 - xy[:, 1]]) / 60, 0, 1) ** 1.5   # wide, soft edges
    wu *= np.clip((np.radians(UCFG.get('maxAngle', 105)) - ang) / 0.6, 0, 1) ** 1.5   # a long, soft fade round the back
    wu *= np.clip((cp[:, 1] - (lm_f[152, 1] - 0.05)) / 0.02, 0, 1)
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
hshade = strand * (0.55 + 0.45 * relief); hshade /= np.mean(hshade[hairy]) if hairy.any() else 1   # same level as the textured hair
# where nothing paints it, the side of the head above the ears is hair too (else a skin stripe shows behind the ear)
hair_fill = np.maximum(hair_amt, np.clip((cp[:, 1] - (eyeY + 0.0)) / 0.012, 0, 1) * np.clip((eye_lmh[2] - 0.03 - cp[:, 2]) / 0.02, 0, 1))
fill = hair_fill[:, None] * hair_c * hshade[:, None] + (1 - hair_fill[:, None]) * neck_c * (0.8 + 0.1 * relief[:, None])   # unpainted skin (behind the jaw, the nape) a shade down: the unwrap's skin carries soft baked shading, a flat fill reads too light
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
L_ = out.mean(1); skinL = skin_c.mean()
near_eye = np.minimum(np.linalg.norm(cp - lm_f[IRIS[0]], axis=1), np.linalg.norm(cp - lm_f[IRIS[1]], axis=1)) < 0.03
sideang = np.abs(np.arctan2(cp[:, 0] - eye_lmh[0], cp[:, 2] - (eye_lmh[2] - 0.09)))
near_ear = np.zeros(len(cp), bool)
for e_ in ear_pts: near_ear |= np.linalg.norm((cp - e_) * [1.6, 0.8, 1], axis=1) < 0.04   # the ears stay skin
region = ((cp[:, 1] > eyeY + 0.03) | ((sideang > np.radians(55)) & (cp[:, 1] > eyeY - 0.06))) & ~near_eye
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
if A.neck == 'loft': out = out * nk[:, None] + neck_c * (1 - nk[:, None])
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
fe = np.clip(1 - (h_tex + 0.006) / 0.025, 0, 1) ** 1.5 * (1 - chinfront) * (~hairy)
out_lin = srgb2lin(out / 255)
out_lin = out_lin * (1 - 0.55 * fe[:, None]) + tone_lin * 0.82 * 0.55 * fe[:, None]
out = lin2srgb(out_lin) * 255
seam_tone = list(map(float, tone_lin * 0.82))
# per (uv) vertex hair weight, for the hair cards the game roots on the scalp
hv_sum = np.zeros(len(UV)); hv_n = np.zeros(len(UV))
for k_ in range(3): np.add.at(hv_sum, UF[tt, k_], H_ * tw[:, k_]); np.add.at(hv_n, UF[tt, k_], tw[:, k_])
hair_v = hv_sum / np.maximum(hv_n, 1e-6)
hair_v[(VV - cen) @ pn < 0.01] = 0
tex = np.zeros((T, T, 3), np.float32); have = np.zeros((T, T), np.uint8)
tex[ty, tx] = out; have[ty, tx] = 255
# dilate into the gutters so mips don't bleed black
tex = cv2.inpaint(np.clip(tex, 0, 255).astype(np.uint8), 255 - have, 3, cv2.INPAINT_TELEA)
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
if A.unwrap not in (None, 'none') and os.path.exists(A.unwrap):
    import io
    tiles = []
    for k_, (ic_, ring_) in enumerate(((468, (469, 470, 471, 472)), (473, (474, 475, 476, 477)))):
        cxy = Lu[ic_]; rad = float(np.mean(np.linalg.norm(Lu[list(ring_)] - cxy, axis=1)))
        box = (cxy[0] - rad * 1.25, cxy[1] - rad * 1.25, cxy[0] + rad * 1.25, cxy[1] + rad * 1.25)
        tiles.append(Image.fromarray(U.astype(np.uint8)).crop(tuple(int(round(b_)) for b_ in box)).resize((96, 96), Image.LANCZOS))
        # sclera: between the iris and each corner of the eye
        crn = Lu[[33, 133] if k_ == 0 else [362, 263]]
        pts = [cxy + (c_ - cxy) * f_ for c_ in crn for f_ in (0.55, 0.65)]
        eyes_uv[k_]['sclera'] = list(map(float, np.median(np.array([U[int(y_) - 1:int(y_) + 2, int(x_) - 1:int(x_) + 2].reshape(-1, 3) for x_, y_ in pts]).reshape(-1, 3), 0) / 255))
        eyes_uv[k_]['irisCrop'] = 1.25        # the tile spans ±1.25 iris radii
    sheet_ = Image.new('RGB', (192, 96)); sheet_.paste(tiles[0], (0, 0)); sheet_.paste(tiles[1], (96, 0))
    buf_ = io.BytesIO(); sheet_.save(buf_, 'PNG'); iris_png = np.frombuffer(buf_.getvalue(), np.uint8)
    if DBG: sheet_.save(os.path.join(DBG, 'irises.png'))
    print('  irises from the unwrap; sclera', [np.round(np.array(e_['sclera']) * 255) for e_ in eyes_uv])
# (the body's skin colour: skin_xform above; a flat tint is kept for older loaders)
tint = np.ones(3)   # (superseded by skinXform; kept so older loaders still read a tint)

# ───────────────────────── write head.bin ─────────────────────────
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
put('skinIndex', bidx.ravel()); put('skinWeight', bw.ravel()); put('seam', seamw)
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
    'faceShape': {'params': (list(map(float, qf)) if qf is not None else None), 'ratios': ratio_table},
    'arrays': desc, 'bones': [B[i] for i in bones_used],
    'eye': list(map(float, eye_mh)), 'ipd': float(ipd_mh),
    'seam': {'point': list(map(float, mir(cen))), 'normal': list(map(float, mir(pn))), 'band': BAND},
    'skinTint': list(map(float, tint)), 'skinXform': [list(map(float, r_)) for r_ in skin_xform], 'seamTone': seam_tone, 'skinColor': list(map(float, skin_c / 255)), 'hairColor': list(map(float, hair_c / 255)),
    'mirrored': mirror, 'source': os.path.basename(A.raw), 'photos': [os.path.basename(p) for p in photos],
    'tris': int(len(UF)), 'tex': T, 'morphs': mnames, 'morphUnit': 1e-5, 'eyes': eyes_uv,
}
mj = json.dumps(meta).encode()
while (8 + len(mj)) % 4: mj += b' '
with open(os.path.join(A.out, 'head.bin'), 'wb') as fh:
    fh.write(b'HEAD'); fh.write(struct.pack('<I', len(mj))); fh.write(mj); fh.write(blob)
print('wrote head.bin', os.path.getsize(os.path.join(A.out, 'head.bin')) // 1024, 'KB, head.jpg', os.path.getsize(os.path.join(A.out, 'head.jpg')) // 1024, 'KB;', len(UF), 'tris')
