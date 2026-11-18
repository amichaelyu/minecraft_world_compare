# THROWAWAY spike: coarse alignment over the 8 axis rotations/flips via masked NCC (float64 FFT)
# of ground elevation and land/water mask at 1/F resolution, then a least-squares fit of the
# arnis->sf similarity transform from the matched cell grid.
import numpy as np, json
from scipy.signal import fftconvolve
from common import load, block
F = 16
def rasters(name):
    m, mb, nl, of = load(name)
    s = (slice(None, None, F), slice(None, None, F))
    a = np.asarray(mb[s]).astype(np.float64); o = np.asarray(of[s]).astype(np.float64)
    valid = (a > -32768) & (a > -129)
    water = (a > o) & valid
    ground = np.where(valid & ~water, o, np.nan)
    Z, X = np.mgrid[0:a.shape[0], 0:a.shape[1]]
    return m, ground, water.astype(np.float64), valid.astype(np.float64), m['originX'] + X * F, m['originZ'] + Z * F
def ncc(A, VA, B, VB):
    Bf = (B * VB)[::-1, ::-1]; Vf = VB[::-1, ::-1]
    n = fftconvolve(VA, Vf, 'valid'); sA = fftconvolve(A * VA, Vf, 'valid'); sA2 = fftconvolve(A * A * VA, Vf, 'valid')
    sB = fftconvolve(VA, Bf, 'valid'); sB2 = fftconvolve(VA, (B * B * VB)[::-1, ::-1], 'valid'); sAB = fftconvolve(A * VA, Bf, 'valid')
    var = (sA2 - sA**2 / n) * (sB2 - sB**2 / n)
    r = np.where((n > 0.3 * VB.sum()) & (var > 1e-6), (sAB - sA * sB / np.maximum(n, 1)) / np.sqrt(np.maximum(var, 1e-6)), -1)
    return r
if __name__ == "__main__":
    ma, ga, wa, va, XA, ZA = rasters('sf'); mb_, gb, wb, vb, XB, ZB = rasters('arnis')
    GA = np.nan_to_num(ga); VGA = (~np.isnan(ga)).astype(float)
    best = None
    for flip in (False, True):
        for k in range(4):
            op = lambda a: np.rot90(a[:, ::-1] if flip else a, k)
            gB = op(gb); VGB = (~np.isnan(gB)).astype(float); GB = np.nan_to_num(gB)
            r = ncc(GA, VGA, GB, VGB); iz, ix = np.unravel_index(np.argmax(r), r.shape)
            print(f'flip={flip} rot={k*90:3d}: elevation NCC peak {r[iz, ix]:.3f} at cell ({ix},{iz})', flush=True)
            if best is None or r[iz, ix] > best[0]: best = (r[iz, ix], flip, k, ix, iz, op)
    r, flip, k, ix, iz, op = best
    xb, zb = op(XB), op(ZB); h, w = xb.shape
    xa, za = XA[iz:iz+h, ix:ix+w], ZA[iz:iz+h, ix:ix+w]
    # fit [xa,za] = M [xb,zb] + t
    P = np.stack([xb.ravel(), zb.ravel(), np.ones(xb.size)], 1)
    sol, *_ = np.linalg.lstsq(P, np.stack([xa.ravel(), za.ravel()], 1), rcond=None)
    M = sol[:2].T; t = sol[2]
    th = np.degrees(np.arctan2(M[1, 0], M[0, 0])); det = np.linalg.det(M)
    gbm = op(gb); dy = np.nanmedian(ga[iz:iz+h, ix:ix+w] - gbm)
    print('best: flip', flip, 'rot', k * 90, 'r', round(r, 3)); print('M', M.round(4).tolist(), 'det', round(det, 3), 'theta', th, 't', t, 'dy', dy)
    json.dump(dict(r=float(r), flip=bool(flip), M=M.tolist(), t=t.tolist(), thetaDeg=float(th), det=float(det), ty=float(dy)), open('out/coarse.json', 'w'), indent=1)
