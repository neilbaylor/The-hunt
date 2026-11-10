"""Print the golfer.html pose list (b/d/f fractions of the hands angle) that lands on each swing event of a clip.
Usage: python3 -I event_poses.py [clip]"""
import json, os, sys, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); clip = sys.argv[1] if len(sys.argv) > 1 else 'rory_faceon_clean'
D = json.load(open(f'{HERE}/data/{clip}.json')); E = D['events']; th = np.array(D['lead_arm_angle_deg'])
at = lambda t: float(np.interp(t, np.arange(len(th)), th)); a = {k: at(v) for k, v in E.items()}
out = []
for k in D['event_names']:
    if k == 'BA': out.append('address')
    elif k in ('MB', 'LBA', 'LB', 'EPR', 'TB'): out.append('b%.3f' % ((a[k] - a['BA']) / (a['TB'] - a['BA'])))
    elif k in ('EDA', 'ED', 'MD', 'BI'): out.append('d%.3f' % max(0, (a[k] - a['BI']) / (a['TB'] - a['BI'])))
    else: out.append('f%.3f' % ((a[k] - a['BI']) / (a['FIN'] - a['BI'])))
print(','.join(out))
