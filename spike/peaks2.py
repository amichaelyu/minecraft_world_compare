# THROWAWAY spike: rotation search anchored on the tallest landmark, then similarity fit on matched peaks.
import numpy as np, json
from scipy.spatial import cKDTree
from peaks import peaks
A = peaks('sf', 300, F=2, rad=30); B = peaks('arnis', 150, F=2, rad=30)
a0, b0 = A[0], B[0]  # Sutro Tower in both
tree = cKDTree(A[:, [0, 2]])
def tf(P, th, s, t):
    c, sn = np.cos(th), np.sin(th)
    return np.stack([s * (c * P[:, 0] - sn * P[:, 2]) + t[0], s * (sn * P[:, 0] + c * P[:, 2]) + t[1]], 1)
best = None
for thd in np.arange(80, 110, 0.1):
    for s in np.arange(0.96, 1.04, 0.005):
        th = np.radians(thd); q = tf(b0[None], th, s, (0, 0))[0]; t = (a0[0] - q[0], a0[2] - q[1])
        d, j = tree.query(tf(B, th, s, t)); ok = (d < 25) & (np.abs(A[j, 1] - B[:, 1] - 6) < 25)
        sc = ok.sum()
        if best is None or sc > best[0]: best = (sc, thd, s, t)
print('anchor search: matches', best[0], 'of', len(B), 'theta', round(best[1], 2), 's', round(best[2], 3))
sc, thd, s, t = best; th = np.radians(thd)
for it in range(4):
    d, j = tree.query(tf(B, th, s, t)); ok = (d < 30) & (np.abs(A[j, 1] - B[:, 1] - 6) < 25)
    P = B[ok][:, [0, 2]]; Q = A[j[ok]][:, [0, 2]]
    mp, mq = P.mean(0), Q.mean(0); P0, Q0 = P - mp, Q - mq
    U, D, Vt = np.linalg.svd(Q0.T @ P0); R = U @ np.diag([1, np.sign(np.linalg.det(U @ Vt))]) @ Vt
    s = D.sum() / (P0**2).sum(); th = np.arctan2(R[1, 0], R[0, 0]); t = mq - s * R @ mp
    r = np.linalg.norm(tf(B[ok], th, s, t) - Q, axis=1)
    print(f'iter {it}: n={ok.sum()} theta={np.degrees(th):.3f} s={s:.4f} t=({t[0]:.1f},{t[1]:.1f}) resid median={np.median(r):.1f} p90={np.percentile(r, 90):.1f}')
ty = float(np.median(A[j[ok], 1] - B[ok, 1]))
out = dict(s=float(s), thetaDeg=float(np.degrees(th)), tx=float(t[0]), tz=float(t[1]), ty=ty, n=int(ok.sum()))
print(out); json.dump(out, open('out/landmark_fit.json', 'w'), indent=1)
