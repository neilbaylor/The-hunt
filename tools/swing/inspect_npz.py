import sys, numpy as np
d=np.load(sys.argv[1], allow_pickle=False)
for k in d.files:
    a=d[k]; print(k, a.shape, a.dtype, np.array2string(a.reshape(-1)[:6], precision=3) if a.dtype.kind in 'fi' else a)
if 'joints_world' in d.files:
    J=d['joints_world']; print('y range', J[...,1].min(), J[...,1].max()); print('parents', d['parents'])
    print('frame0 joints\n', J[0].round(2))
