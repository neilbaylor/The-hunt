"""Build the clean forward pass of the Rory face-on recording from the stabilised video: the source steps through
~39 held stills (20 frames each) with rewinds; take pass A (address..impact) + pass C (release..finish), one
temporal-median frame per still."""
import cv2, numpy as np, sys
src, out = sys.argv[1], sys.argv[2]
d=np.load('rory_diff.npy'); thr=6.0
cuts=[0]+[i for i in range(1,len(d)) if d[i]>15 and d[i]>=d[max(0,i-3):i+4].max()]+[len(d)]
segs=[(a,b) for a,b in zip(cuts[:-1],cuts[1:]) if b-a>=12]
keep=[s for s in segs if (347<=s[0] and s[1]<=847) or (1225<=s[0] and s[1]<=1498)]
print(len(keep), keep)
cap=cv2.VideoCapture(src); fr=[]
while True:
    ok,f=cap.read()
    if not ok: break
    fr.append(f)
vw=cv2.VideoWriter(out+'.tmp.mp4',cv2.VideoWriter_fourcc(*'mp4v'),30,(720,1280)); stills=[]
for a,b in keep:
    m=np.median(np.stack(fr[a+3:b-2]),axis=0).astype(np.uint8)
    m=cv2.addWeighted(m,1.5,cv2.GaussianBlur(m,(0,0),3),-0.5,0)   # light unsharp
    stills.append(m); vw.write(m)
vw.release(); np.save(out+'.stills.npy',np.array(keep))
sheet=np.hstack([cv2.resize(s,(135,240)) for s in stills]); cv2.imwrite(out+'.sheet.jpg',np.vstack([sheet[:,:135*20],np.hstack([sheet[:,135*20:],np.zeros((240,135*(40-len(stills)),3),np.uint8)])]))
