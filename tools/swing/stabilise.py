import cv2, numpy as np, sys
from scipy.signal import savgol_filter
src=sys.argv[1]; out=sys.argv[2]
REF=int(sys.argv[3]); corners_ref=np.array(eval(sys.argv[4]),np.float32); NMAX=int(sys.argv[5]) if len(sys.argv)>5 else 10**9
cap=cv2.VideoCapture(src); frames=[]
while True:
    ok,f=cap.read()
    if not ok: break
    frames.append(f)
    if len(frames)>=NMAX: break
print(len(frames))
sift=cv2.SIFT_create(3000, contrastThreshold=0.02)
def feats(f):
    g=cv2.cvtColor(f,cv2.COLOR_BGR2GRAY)
    return sift.detectAndCompute(g,None)
kr,dr=feats(frames[REF])
bf=cv2.BFMatcher()
Hs=[];ninl=[]
for i,f in enumerate(frames):
    k,d=feats(f)
    H=None;n=0
    if d is not None and len(k)>10:
        m=bf.knnMatch(dr,d,k=2)
        good=[a for a,b in m if a.distance<0.75*b.distance]
        if len(good)>=8:
            p0=np.float32([kr[a.queryIdx].pt for a in good]); p1=np.float32([k[a.trainIdx].pt for a in good])
            H,mask=cv2.findHomography(p0,p1,cv2.RANSAC,2.5)
            n=int(mask.sum()) if mask is not None else 0
    Hs.append(H);ninl.append(n)
ninl=np.array(ninl); print('inliers min/med',ninl.min(),np.median(ninl), 'bad',(ninl<15).sum())
C=np.full((len(frames),4,2),np.nan,np.float32)
for i,H in enumerate(Hs):
    if H is not None and ninl[i]>=15:
        C[i]=cv2.perspectiveTransform(corners_ref[None],H)[0]
# interpolate nans, smooth
t=np.arange(len(frames))
for a in range(4):
    for b in range(2):
        v=C[:,a,b]; ok=~np.isnan(v); v=np.interp(t,t[ok],v[ok])
        # median then savgol
        from scipy.signal import medfilt
        v=medfilt(v,7); C[:,a,b]=savgol_filter(v,15,2)
np.save(out+'.corners.npy',C); np.save(out+'.ninl.npy',ninl)
W,Hh=720,1280
dst=np.array([[0,0],[W,0],[W,Hh],[0,Hh]],np.float32)
vw=cv2.VideoWriter(out,cv2.VideoWriter_fourcc(*'mp4v'),30,(W,Hh))
for i,f in enumerate(frames):
    M=cv2.getPerspectiveTransform(C[i].astype(np.float32),dst)
    vw.write(cv2.warpPerspective(f,M,(W,Hh),flags=cv2.INTER_CUBIC))
vw.release()
