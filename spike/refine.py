# THROWAWAY spike: fold the per-window street-grid shifts into the similarity transform.
import numpy as np, json, subprocess, re, sys
src, dst = sys.argv[1], sys.argv[2]
T = json.load(open(src)); log = subprocess.run(['uv', 'run', 'python', 'verify.py', src], capture_output=True, text=True).stdout
rows = [tuple(map(float, m)) for m in re.findall(r'x=\s*(-?\d+), z=\s*(-?\d+)\) best shift dx=\s*([+-]?\d+) dz=\s*([+-]?\d+) r=([\d.]+)', log)]
W = np.array([r for r in rows if r[4] > 0.2]); c = W[:, :2] + 384  # window centres (sf frame)
s, th = T['s'], np.radians(T['thetaDeg']); R = np.array([[np.cos(th), -np.sin(th)], [np.sin(th), np.cos(th)]]); t = np.array([T['tx'], T['tz']])
P = (np.linalg.inv(R) @ (c - t).T).T / s           # arnis coords of the window centres
Q = c + W[:, 2:4]                                    # where those features really are in sf
mp, mq = P.mean(0), Q.mean(0); P0, Q0 = P - mp, Q - mq
U, D, Vt = np.linalg.svd(Q0.T @ P0); R2 = U @ np.diag([1, np.sign(np.linalg.det(U @ Vt))]) @ Vt
s2 = D.sum() / (P0**2).sum(); th2 = np.arctan2(R2[1, 0], R2[0, 0]); t2 = mq - s2 * R2 @ mp
res = np.linalg.norm((s2 * (R2 @ P.T)).T + t2 - Q, axis=1)
out = dict(s=float(s2), thetaDeg=float(np.degrees(th2)), tx=float(t2[0]), tz=float(t2[1]), ty=T['ty'])
print('refined', out, 'window residual median', np.median(res).round(2), 'max', res.max().round(2))
json.dump(out, open(dst, 'w'), indent=1)
