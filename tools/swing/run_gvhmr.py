"""Run a GVHMR Space on one clip. Usage: run_gvhmr.py <space> <video> <new-empty-outdir> [flip]
Token: $HF_TOKEN or /root/.cache/hf/token (never printed)."""
import sys, os, json
from gradio_client import Client, handle_file
space, video, outdir = sys.argv[1], sys.argv[2], sys.argv[3]
flip = len(sys.argv) > 4 and sys.argv[4] == 'flip'
tok = os.environ.get('HF_TOKEN')
if not tok and os.path.exists('/root/.cache/hf/token'): tok = open('/root/.cache/hf/token').read().strip()
os.makedirs(outdir, exist_ok=False)
c = Client(space, verbose=False, download_files=outdir, token=tok or None)
kw = dict(video_path=handle_file(video), static_camera=True, camera_backend='simplevo', flip_test=flip,
          hub_repo='ryanrudes/gvhmr', hub_revision='', detector='yolo', pose2d='vitpose', backbone='hmr2',
          native_smplx=True, render_overlay=True, intrinsics_file=None, api_name='/run')
if 'phrographica' in space: kw['render_scale'] = 0.5
try:
    res = c.predict(**kw)
except Exception as e:
    msg = str(e)
    if tok: msg = msg.replace(tok, '***')
    print('ERR', type(e).__name__, msg[:1500]); sys.exit(2)
print(json.dumps(res, default=str)[:3000])
