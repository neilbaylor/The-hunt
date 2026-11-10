import sys, cv2, numpy as np, mediapipe as mp
from mediapipe.tasks.python import vision, BaseOptions
src,out=sys.argv[1],sys.argv[2]
M='/tmp/claude-0/-home-user/2315be70-f187-593e-a2dc-f420a899e84c/scratchpad/S/mp/model/pose_landmarker_heavy.task'
det=vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(base_options=BaseOptions(model_asset_path=M),running_mode=vision.RunningMode.VIDEO,num_poses=1,min_pose_detection_confidence=0.3,min_tracking_confidence=0.3))
cap=cv2.VideoCapture(src); fps=cap.get(cv2.CAP_PROP_FPS); I=[];W=[];i=0
while True:
    ok,f=cap.read()
    if not ok: break
    r=det.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB,data=cv2.cvtColor(f,cv2.COLOR_BGR2RGB)),int(i*1000/30)); i+=1
    if r.pose_landmarks:
        I.append([[p.x,p.y,p.z,p.visibility] for p in r.pose_landmarks[0]]); W.append([[p.x,p.y,p.z] for p in r.pose_world_landmarks[0]])
    else:
        I.append(np.full((33,4),np.nan).tolist()); W.append(np.full((33,3),np.nan).tolist())
np.savez(out,img=np.array(I),world=np.array(W),fps=fps,size=[f.shape[1] if f is not None else 0,0])
print(out,len(I),'missing',int(np.isnan(np.array(I)[:,0,0]).sum()))
