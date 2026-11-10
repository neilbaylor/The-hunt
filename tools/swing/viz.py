"""Strip: video frames with the recovered SMPL-X skeleton overlaid (camera projection), plus the same pose
from the side/top in world space. Usage: python3 -I viz.py <video> <gvhmr.npz> <out.jpg> [n=10] [f0 f1]"""
import sys, cv2, numpy as np
vid, npz, out = sys.argv[1:4]; n = int(sys.argv[4]) if len(sys.argv) > 4 else 10
d = np.load(npz, allow_pickle=False); JC, JW, K, par = d['joints_camera'], d['joints_world'], d['intrinsics'], d['parents']
cap = cv2.VideoCapture(vid); fr = []
while True:
    ok, f = cap.read()
    if not ok: break
    fr.append(f)
N = min(len(fr), len(JC)); f0 = int(sys.argv[5]) if len(sys.argv) > 5 else 0; f1 = int(sys.argv[6]) if len(sys.argv) > 6 else N - 1
idx = np.linspace(f0, f1, n).round().astype(int)
H = 360; LEFT = {1, 4, 7, 10, 13, 16, 18, 20}
def draw(img, P2, th=2):
    for j in range(1, 22):
        p = par[j]; c = (60, 60, 255) if j in LEFT else (255, 160, 40) if j in {2, 5, 8, 11, 14, 17, 19, 21} else (230, 230, 230)
        cv2.line(img, tuple(int(v) for v in P2[p]), tuple(int(v) for v in P2[j]), c, th, cv2.LINE_AA)
    return img
rows = [[], [], []]
for i in idx:
    f = fr[i].copy(); p = (K[i] @ JC[i].T).T; p = p[:, :2] / p[:, 2:]
    draw(f, p); s = H / f.shape[0]; f = cv2.resize(f, (int(f.shape[1] * s), H)); cv2.putText(f, str(i), (4, 16), 0, 0.5, (0, 255, 255), 1)
    rows[0].append(f); w = f.shape[1]
    J = JW[i] - JW[i][0] * [1, 0, 1]
    # orthographic views of the world pose: rotated 90 deg about vertical relative to camera, and from above
    fwd = JC[i][0] / np.linalg.norm(JC[i][0])  # camera->pelvis in camera frame (not world); use world axes instead
    for r, (a, b) in enumerate([((0, 0, 1), (0, 1, 0)), ((1, 0, 0), (0, 1, 0))]):
        im = np.full((H, w, 3), 30, np.uint8); P2 = np.stack([J @ np.array(a) * 150 + w / 2, H - 20 - J @ np.array(b) * 170], 1)
        rows[r + 1].append(draw(im, P2))
cv2.imwrite(out, np.vstack([np.hstack(r) for r in rows]), [cv2.IMWRITE_JPEG_QUALITY, 85])
