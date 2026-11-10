import cv2, numpy as np
cap=cv2.VideoCapture('rory_stab_full.mp4'); fr=[]
while True:
    ok,f=cap.read()
    if not ok: break
    fr.append(f)
sm=[cv2.GaussianBlur(cv2.cvtColor(cv2.resize(f,(180,320)),cv2.COLOR_BGR2GRAY),(0,0),2).astype(np.float32) for f in fr]
d=np.array([0]+[np.percentile(np.abs(sm[i]-sm[i-1]),99.5) for i in range(1,len(sm))])
np.save('rory_diff.npy',d)
print(np.percentile(d,[50,80,90,95,99]))
mp=np.load('rory_mp.npz')['img']; w=(mp[:,15,:2]+mp[:,16,:2])/2; hip=(mp[:,23,:2]+mp[:,24,:2])/2; sh=(mp[:,11,:2]+mp[:,12,:2])/2
rel=(w-sh)/np.linalg.norm(sh-hip,axis=1)[:,None]; ang=np.degrees(np.arctan2(rel[:,0],rel[:,1]))
thr=np.percentile(d,50)*3
cuts=[0]+[i for i in range(1,len(d)) if d[i]>thr and d[i]>=d[max(0,i-3):i+4].max()]+[len(d)]
segs=[(a,b) for a,b in zip(cuts[:-1],cuts[1:]) if b-a>=5]
print('thr',thr,'nseg',len(segs))
out=[]
for a,b in segs:
    m=slice(a+2,b-1); out.append((a,b,float(np.nanmedian(ang[m])))); print(a,b,b-a,'ang %.0f'%np.nanmedian(ang[m]), 'peak %.1f'%d[a])
np.save('rory_segs.npy',np.array(out))
