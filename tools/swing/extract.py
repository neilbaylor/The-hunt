"""GVHMR npz -> canonical golf frame + swing events -> compact JSON.

Canonical frame (same as the game's character space, right-handed golfer): +X = toward the target (trail ankle ->
lead ankle at address), +Y up, +Z = the way the golfer faces at address (toward the ball). Origin = mid-ankles at
address on the ground. Lead side = SMPL left. No mirroring here: the game mirrors the whole character for a lefty.

Usage: python3 -I extract.py raw/<clip>.gvhmr.npz data/<clip>.json [address_frame]
"""
import sys, json, numpy as np
NAMES = ['pelvis','l_hip','r_hip','spine1','l_knee','r_knee','spine2','l_ankle','r_ankle','spine3','l_foot','r_foot',
         'neck','l_collar','r_collar','head','l_shoulder','r_shoulder','l_elbow','r_elbow','l_wrist','r_wrist']
EVENTS = ['BA','MB','LBA','LB','EPR','TB','EDA','ED','MD','BI','MF','LF','FIN']
def rodrigues(a):
    th = np.linalg.norm(a, axis=-1, keepdims=True); k = a / np.maximum(th, 1e-9)
    K = np.zeros(a.shape[:-1] + (3, 3)); K[..., 0, 1] = -k[..., 2]; K[..., 0, 2] = k[..., 1]; K[..., 1, 0] = k[..., 2]
    K[..., 1, 2] = -k[..., 0]; K[..., 2, 0] = -k[..., 1]; K[..., 2, 1] = k[..., 0]
    s, c = np.sin(th)[..., None], np.cos(th)[..., None]
    return np.eye(3) + s * K + (1 - c) * (K @ K)
def mat2quat(R):  # xyzw
    from scipy.spatial.transform import Rotation
    return Rotation.from_matrix(R.reshape(-1, 3, 3)).as_quat().reshape(R.shape[:-2] + (4,))
def load(path, addr=None):
    d = np.load(path, allow_pickle=False)
    J = d['joints_world'].astype(float); par = d['parents']; n = len(J)
    aa = np.concatenate([d['world_global_orient'][:, None], d['world_body_pose'].reshape(n, 21, 3)], 1).astype(float)
    Rl = rodrigues(aa); Rg = np.zeros_like(Rl)
    for j in range(22): Rg[:, j] = Rl[:, j] if par[j] < 0 else Rg[:, par[j]] @ Rl[:, j]
    a = 0 if addr is None else addr
    A = J[a:a + 3].mean(0)
    x = A[7] - A[8]; x[1] = 0; x /= np.linalg.norm(x); y = np.array([0, 1., 0]); z = np.cross(x, y)
    Rc = np.stack([x, y, z])                       # rows: canonical axes in world coords
    o = (A[7] + A[8]) / 2; o[1] = min(J[:, 10, 1].min(), J[:, 11, 1].min())
    Jc = (J - o) @ Rc.T; Rgc = Rc @ Rg
    return Jc, Rgc, float(d['fps']), d['joints_rest'].astype(float), par
def arm_angle(J):
    """lead arm angle in the frontal plane, degrees: 0 = hanging straight down, + = toward the trail side (backswing),
    wraps past 180 over the top; unwrapped so it is continuous"""
    v = J[:, 20] - J[:, 16]
    return np.degrees(np.unwrap(np.arctan2(-v[:, 0], -v[:, 1])))
def cross_at(t, v, level, lo, hi, rising):
    """first fractional index in [lo,hi] where v crosses level in the given direction"""
    for i in range(int(lo), int(hi)):
        a, b = v[i], v[i + 1]
        if (rising and a < level <= b) or (not rising and a > level >= b): return i + (level - a) / (b - a)
    return None
def events(J):
    th = arm_angle(J); n = len(th); hy = (J[:, 20, 1] + J[:, 21, 1]) / 2; hx = (J[:, 20, 0] + J[:, 21, 0]) / 2
    top = int(np.argmax(th)); thT = th[top]
    # impact: the hands' lowest point after the top (they pass under the chin at the bottom of the arc), refined
    # to where the hands get back to the lead thigh
    after = np.arange(top, n); lowest = after[np.argmin(hy[top:])]
    bi = cross_at(None, th, th[0] - 6, top, min(n - 2, lowest + 3), False) or float(lowest)
    # start: last frame before the hands leave address for good
    ba = 0.0
    for i in range(top, 0, -1):
        if abs(th[i] - th[0]) < 2.5 and np.hypot(hx[i] - hx[0], hy[i] - hy[0]) < 0.03: ba = float(i); break
    E = {'BA': ba}
    E['MB'] = cross_at(None, th, 40, ba, top, True); E['LBA'] = cross_at(None, th, 90, ba, top, True)
    E['LB'] = cross_at(None, th, 90 + 0.45 * (thT - 90), ba, top, True); E['EPR'] = cross_at(None, th, 90 + 0.85 * (thT - 90), ba, top, True)
    E['TB'] = float(top)
    E['EDA'] = cross_at(None, th, 90 + 0.6 * (thT - 90), top, n - 2, False); E['ED'] = cross_at(None, th, 90, top, n - 2, False)
    E['MD'] = cross_at(None, th, 30, top, n - 2, False); E['BI'] = float(bi)
    b = int(np.floor(bi))
    E['MF'] = cross_at(None, th, -45, b, n - 2, False); E['LF'] = cross_at(None, th, -90, b, n - 2, False)
    # finish: where the hands stop moving after the follow-through
    sp = np.linalg.norm(np.diff(J[:, 20], axis=0), axis=1); lf = int(E['LF'] or b)
    fin = n - 1
    for i in range(lf + 1, n - 1):
        if sp[i:].max() < 0.02: fin = i; break
    E['FIN'] = float(fin)
    return {k: (None if v is None else round(float(v), 2)) for k, v in E.items()}, th
if __name__ == '__main__':
    src, out = sys.argv[1], sys.argv[2]; addr = int(sys.argv[3]) if len(sys.argv) > 3 else None
    J, R, fps, rest, par = load(src, addr); E, th = events(J)
    json.dump({'source': src.split('/')[-1], 'model': 'GVHMR (SMPL-X body, 22 joints)', 'fps': fps, 'frames': len(J),
               'frame': '+X target, +Y up, +Z facing (toward the ball); origin mid-ankles at address; right-handed golfer, lead = left',
               'joint_names': NAMES, 'parents': par.tolist(), 'event_names': EVENTS, 'events': E,
               'lead_arm_angle_deg': np.round(th, 1).tolist(), 'rest_joints': np.round(rest, 4).tolist(),
               'joints': np.round(J, 4).tolist(), 'rot_xyzw': np.round(mat2quat(R), 4).tolist()}, open(out, 'w'), separators=(',', ':'))
    print(out, len(J), 'frames'); print(' '.join(f'{k}={v}' for k, v in E.items())); print('arm angle', np.round(th).astype(int).tolist())
