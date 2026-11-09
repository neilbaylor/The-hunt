"""Run MediaPipe Face Landmarker on each face photo; write 478 3D landmarks (+ head pose matrix) per photo to <photo>.lm.json.
   python3 tools/character/landmarks.py photo1.jpg photo2.jpg ... (needs /tmp/face_landmarker.task)"""
import json, sys
import numpy as np, mediapipe as mp
from PIL import Image, ImageOps
from mediapipe.tasks.python import vision, BaseOptions

opts = vision.FaceLandmarkerOptions(base_options=BaseOptions(model_asset_path='/tmp/face_landmarker.task'),
                                    output_facial_transformation_matrixes=True, num_faces=1)
det = vision.FaceLandmarker.create_from_options(opts)
mirror = '--mirror' in sys.argv
for path in [a for a in sys.argv[1:] if not a.startswith('--')]:
    im = ImageOps.exif_transpose(Image.open(path)).convert('RGB')
    if mirror: im = ImageOps.mirror(im)
    r = det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.asarray(im)))
    if not r.face_landmarks:
        print('no face', path); continue
    W, H = im.size
    pts = [[p.x * W, p.y * H, p.z * W] for p in r.face_landmarks[0]]
    M = np.array(r.facial_transformation_matrixes[0]).tolist()
    json.dump({'size': [W, H], 'pts': pts, 'pose': M}, open(path + ('.mirror' if mirror else '') + '.lm.json', 'w'))
    print(path, len(pts), 'landmarks; yaw/pitch from matrix:', np.degrees(np.arctan2(-M[2][0], M[2][2])).round(1), np.degrees(np.arcsin(M[2][1])).round(1))
