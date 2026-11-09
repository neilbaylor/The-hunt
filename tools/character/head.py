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
ap.add_argument('--unwrap', default=os.path.join(HERE, 'data/face_unwrap.jpg'), help="front-on cylindrical face texture (+ .lm.json); 'none' to skip")
ap.add_argument('--unwrap-weight', type=float, default=4.0, help='how strongly the unwrap wins over the portrait where both see')
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
R = umeyama_R(lm_g[upper], lm_mh[upper])
ipd_g = np.linalg.norm(lm_g[IRIS[0]] - lm_g[IRIS[1]]); ipd_lm_mh = np.linalg.norm(lm_mh[IRIS[0]] - lm_mh[IRIS[1]])
# scale: the eye spacing and the eye-to-chin length both measured the same way (landmarks on a grey render) on
# both heads; their geometric mean keeps the face proportions of the photo while matching the body's head size
eye_g = (lm_g[IRIS[0]] + lm_g[IRIS[1]]) / 2; eye_lmh = (lm_mh[IRIS[0]] + lm_mh[IRIS[1]]) / 2
s_ipd = ipd_lm_mh / ipd_g
s_len = np.linalg.norm(lm_mh[152] - eye_lmh) / np.linalg.norm(lm_g[152] - eye_g)
A0, B0 = lm_mh[upper] - lm_mh[upper].mean(0), (R @ (lm_g[upper] - lm_g[upper].mean(0)).T).T
s_ume = (A0 * B0).sum() / (B0 ** 2).sum()
s = math.sqrt(s_ipd * s_len)
print(f'scale candidates: eyes {s_ipd:.4f}, eye→chin {s_len:.4f}, upper face {s_ume:.4f} → {s:.4f}')
eye_g = (lm_g[IRIS[0]] + lm_g[IRIS[1]]) / 2; eye_lmh = (lm_mh[IRIS[0]] + lm_mh[IRIS[1]]) / 2
t = eye_lmh - s * R @ eye_g
def place(P): return (s * (R @ P.T)).T + t
FV = place(GV); FN = (R @ GN.T).T
lm_f = place(lm_g)
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
for it in range(6):
    lap = np.array([LV[n_].mean(0) - LV[i] if len(n_) else np.zeros(3) for i, n_ in enumerate(nbr)])
    LV += (0.5 if it % 2 == 0 else -0.53) * lap * hairish[:, None]   # Taubin: smooth without shrinking
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
    tdir = np.array([0, -1.0, 0]) * Ld
    pts = h00 * top + h10 * tdir + h01 * bot + h11 * tdir
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

# skin weights: the body's own weights at the seam, all head from the cut up
tree = cKDTree(SP)
_, nn = tree.query(LV)
wts = []
kk = np.clip(hgt / BAND, 0, 1); kk = kk * kk * (3 - 2 * kk)
for i in range(len(LV)):
    w = {}
    for j in range(4):
        if SW[nn[i], j] > 0: w[int(SI[nn[i], j])] = w.get(int(SI[nn[i], j]), 0) + float(SW[nn[i], j]) * (1 - kk[i])
    w[hb] = w.get(hb, 0) + kk[i]
    top_ = sorted(w.items(), key=lambda x: -x[1])[:4]; tot = sum(v for _, v in top_)
    wts.append([(b_, v / tot) for b_, v in top_] + [(0, 0.0)] * (4 - len(top_)))
used = sorted({b_ for w in wts for b_, v in w if v > 0} | {hb})
print('weights use bones', [B[i] for i in used])

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
for ph in photos:
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
# head points → (arc round the head centre, height) → thin-plate spline from our mesh's landmarks to the image's
if A.unwrap != 'none' and os.path.exists(A.unwrap):
    from scipy.interpolate import RBFInterpolator
    U = np.asarray(Image.open(A.unwrap).convert('RGB')).astype(float); UH, UW = U.shape[:2]
    Lu = np.array(json.load(open(A.unwrap + '.lm.json'))['pts'], float)[:, :2]     # the true (unmirrored) image: this mesh is true until written
    hc_ = np.array(M['headCenter'])
    def cyl(P): d = P - hc_; return np.c_[np.arctan2(d[:, 0], d[:, 2]) * 0.09, d[:, 1]]
    okl = ~np.isnan(lm_f).any(1)
    src, dst = cyl(lm_f[okl]), Lu[okl]
    try: ears_img = json.load(open(os.path.join(HERE, 'neil.json')))['face']['unwrap']['ears']
    except Exception: ears_img = None
    if ears_img:
        # the ears painted at the sides: anchor the mesh's outermost points between mouth and eye height to them
        Pm = np.asarray(hm.vertices); mouth_y = lm_f[13, 1]
        aff = np.linalg.lstsq(np.c_[src, np.ones(len(src))], dst, rcond=None)[0]
        for sx in (-1, 1):
            band_ = Pm[(Pm[:, 1] > mouth_y) & (Pm[:, 1] < eyeY0 + 0.01) & ((Pm[:, 0] - hc_[0]) * sx > 0)]
            ep = band_[np.argmax(np.abs(band_[:, 0] - hc_[0]))][None]
            pred = np.c_[cyl(ep), [[1]]] @ aff
            j = int(np.argmin([np.linalg.norm(np.array(e) - pred[0]) for e in ears_img]))
            src = np.r_[src, cyl(ep)]; dst = np.r_[dst, [ears_img[j]]]
            print(f'  unwrap ear {sx:+d}: predicted {pred[0].round(0)}, painted {ears_img[j]}')
    uw = RBFInterpolator(src, dst, kernel='thin_plate_spline', smoothing=0.5, degree=1)
    print('unwrap fit residual', np.linalg.norm(uw(src) - dst, axis=1).mean().round(1), 'px over', len(src), 'points')
    xy = uw(cyl(cp))
    cu = np.stack([map_coordinates(U[..., k], [xy[:, 1] - 0.5, xy[:, 0] - 0.5], order=1, mode='nearest') for k in range(3)], 1)
    ang = np.abs(np.arctan2(cp[:, 0] - hc_[0], cp[:, 2] - hc_[2]))
    wu = np.clip(np.minimum.reduce([xy[:, 0] - 4, UW - 4 - xy[:, 0], xy[:, 1] - 4, UH - 4 - xy[:, 1]]) / 14, 0, 1)
    wu *= np.clip((np.radians(105) - ang) / 0.25, 0, 1)
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

# what has no photo: hair above the hairline, skin below it (the nape / behind the ears)
eyeY = (lm_f[IRIS[0], 1] + lm_f[IRIS[1], 1]) / 2
ear_lo = eyeY - 0.045
# short hair: everything above the temples, and behind the ears down to a nape line (lowest at the centre of the
# back), with a ragged soft edge
xr = np.abs(cp[:, 0] - eye_lmh[0]); back = np.clip(-(cp[:, 2] - (eye_lmh[2] - 0.075)) / 0.03, 0, 1)
nape = eyeY - 0.045 - 0.03 * np.clip(1 - xr / 0.065, 0, 1) ** 1.5
ragged = 0.006 * (np.sin(cp[:, 0] * 900) * 0.5 + np.sin(cp[:, 0] * 2300 + 1.3) * 0.5)
hair_amt = np.clip((cp[:, 1] - nape - ragged) / 0.008 + 0.5, 0, 1) * back
hair_amt = np.maximum(hair_amt, np.clip((cp[:, 1] - (eyeY + 0.075)) / 0.01, 0, 1))
hairy = hair_amt > 0.5
lum = col.mean(1)
hair_known = known & hairy & (conf > 0.8) & (lum < 150)
skin_known = known & ~hairy & (conf > 0.8) & (lum > 120) & (cp[:, 1] < eyeY - 0.02)
hair_c = np.median(col[hair_known], 0) if hair_known.sum() > 50 else np.array([92, 64, 44.])
skin_c = np.median(col[skin_known], 0) if skin_known.sum() > 50 else np.array([215, 150, 120.])
if skin_from_unwrap is not None: skin_c = skin_from_unwrap
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
strand = 0.75 + 0.5 * (0.6 * vnoise(cp * [1, 0.35, 1], 900) + 0.4 * vnoise(cp, 300))
fill = hair_amt[:, None] * hair_c * strand[:, None] * (0.55 + 0.45 * relief[:, None]) + (1 - hair_amt[:, None]) * skin_c * (0.92 + 0.08 * relief[:, None])
# soft hair edge at the nape
out = col * conf[:, None] + fill * (1 - conf[:, None])
# the neck band fades to the body's skin tone (the body is tinted to the face below)
nk = np.clip(((LV[vmap][UF[tt]] * tw[..., None]).sum(1) - cen) @ pn / (BAND + 0.012), 0, 1) ** 0.7
out = out * nk[:, None] + skin_c * 0.93 * (1 - nk[:, None])
tex = np.zeros((T, T, 3), np.float32); have = np.zeros((T, T), np.uint8)
tex[ty, tx] = out; have[ty, tx] = 255
# dilate into the gutters so mips don't bleed black
tex = cv2.inpaint(np.clip(tex, 0, 255).astype(np.uint8), 255 - have, 3, cv2.INPAINT_TELEA)
Image.fromarray(tex).save(os.path.join(A.out, 'head.jpg'), quality=88, optimize=True)
dbg('head_tex.png', tex)

# ───────────────────────── skin tone for the body ─────────────────────────
# the body's skin texture at the forearms/neck vs the face's skin: a multiplier for the body skin material
sk_img = np.asarray(Image.open(os.path.join(os.path.dirname(binp), 'skin.jpg')).convert('RGB')).astype(float)
la = B.index('lowerarm_l')
arm = np.nonzero((SI[:, 0] == la) & (SW[:, 0] > 0.8))[0]
uvs = SUV[arm]; px_ = np.clip((uvs[:, 0] * sk_img.shape[1]).astype(int), 0, sk_img.shape[1] - 1); py_ = np.clip(((1 - uvs[:, 1]) * sk_img.shape[0]).astype(int), 0, sk_img.shape[0] - 1)
arm_c = np.median(sk_img[py_, px_], 0)
tint = np.clip((skin_c / 255) ** 2.2 / np.maximum((arm_c / 255) ** 2.2, 1e-3), 0.5, 1.6)
print('body arm colour', arm_c.round(), '→ tint (linear)', tint.round(3))

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
put('skinIndex', bidx.ravel()); put('skinWeight', bw.ravel()); put('seam', seamw)
meta = {
    'arrays': desc, 'bones': [B[i] for i in bones_used],
    'eye': list(map(float, eye_mh)), 'ipd': float(ipd_mh),
    'seam': {'point': list(map(float, mir(cen))), 'normal': list(map(float, mir(pn))), 'band': BAND},
    'skinTint': list(map(float, tint)), 'skinColor': list(map(float, skin_c / 255)), 'hairColor': list(map(float, hair_c / 255)),
    'mirrored': mirror, 'source': os.path.basename(A.raw), 'photos': [os.path.basename(p) for p in photos],
    'tris': int(len(UF)), 'tex': T,
}
mj = json.dumps(meta).encode()
while (8 + len(mj)) % 4: mj += b' '
with open(os.path.join(A.out, 'head.bin'), 'wb') as fh:
    fh.write(b'HEAD'); fh.write(struct.pack('<I', len(mj))); fh.write(mj); fh.write(blob)
print('wrote head.bin', os.path.getsize(os.path.join(A.out, 'head.bin')) // 1024, 'KB, head.jpg', os.path.getsize(os.path.join(A.out, 'head.jpg')) // 1024, 'KB;', len(UF), 'tris')
