# THROWAWAY spike: tallest-structure landmarks in each world -> match -> fit affine/similarity.
import numpy as np, json
from scipy.ndimage import maximum_filter
from scipy.spatial import cKDTree
from common import load
TX, TZ, TY = 4240, -7616, 6
def peaks(name, n=60, F=4, rad=40):
    m, mb, nl, of = load(name)
    a = np.asarray(nl[::F, ::F]).astype(np.int32)
    mx = maximum_filter(a, size=2 * rad + 1)
    zz, xx = np.nonzero((a == mx) & (a > -100))
    h = a[zz, xx]; o = np.argsort(-h)
    pts = []
    for i in o:
        x, z = m['originX'] + xx[i] * F, m['originZ'] + zz[i] * F
        if all((x - p[0])**2 + (z - p[2])**2 > (rad * F)**2 for p in pts): pts.append((x, int(h[i]), z))
        if len(pts) >= n: break
    return np.array(pts, float)
A = peaks('sf', 120); B = peaks('arnis', 60)
Bt = np.stack([-B[:, 2] + TX, B[:, 1] + TY, B[:, 0] + TZ], 1)
for i in range(15): print('arnis peak', B[i].astype(int), '-> sf frame', Bt[i].astype(int))
print('sf top', A[:15].astype(int).tolist())
tree = cKDTree(A[:, [0, 2]])
d, j = tree.query(Bt[:, [0, 2]])
ok = (d < 800) & (np.abs(A[j, 1] - Bt[:, 1]) < 40)
print('matched', ok.sum(), 'of', len(B)); 
for k in np.nonzero(ok)[0][:30]: print(f'  arnis {B[k].astype(int)} h={B[k,1]:.0f}  sf {A[j[k]].astype(int)}  resid {(A[j[k]][[0,2]] - Bt[k][[0,2]]).astype(int)}')
# robust affine fit sf_xz = M @ arnis_xz + t
P = B[ok][:, [0, 2]]; Q = A[j[ok]][:, [0, 2]]
for it in range(5):
    X = np.c_[P, np.ones(len(P))]; sol, *_ = np.linalg.lstsq(X, Q, rcond=None)
    r = np.linalg.norm(X @ sol - Q, axis=1); keep = r < max(3 * np.median(r), 30)
    P, Q = P[keep], Q[keep]
M = sol[:2].T; t = sol[2]; U, S, Vt = np.linalg.svd(M)
print('affine M', M.round(4).tolist(), 't', t.round(1), 'singular values (scales)', S.round(4), 'rot', np.degrees(np.arctan2(M[1,0], M[0,0])).round(3), 'n', len(P), 'resid median', np.median(r[keep]).round(1))
json.dump(dict(M=M.tolist(), t=t.tolist(), n=int(len(P))), open('out/peaks_fit.json', 'w'))
