# THROWAWAY spike: ICP refinement of arnis->sf alignment on 3D edge points (building walls, terrain breaks).
# Model: [x',z'] = s*R(theta)*[x,z] + t (2D similarity), y' = y + ty.  Trimmed point-to-point ICP.
import numpy as np, json, sys
from scipy.spatial import cKDTree
from common import load
def edge_points(name, x0=None, x1=None, z0=None, z1=None, step=1, thr=4):
    m, mb, nl, of = load(name)
    ox, oz = m['originX'], m['originZ']
    X0 = max(0, (x0 - ox) if x0 is not None else 0); X1 = min(m['W'], (x1 - ox) if x1 is not None else m['W'])
    Z0 = max(0, (z0 - oz) if z0 is not None else 0); Z1 = min(m['H'], (z1 - oz) if z1 is not None else m['H'])
    h = np.asarray(nl[Z0:Z1, X0:X1]).astype(np.int32)
    ok = h > -32768
    g = np.zeros_like(h)
    g[:, 1:] = np.maximum(g[:, 1:], np.abs(np.diff(h, axis=1))); g[1:, :] = np.maximum(g[1:, :], np.abs(np.diff(h, axis=0)))
    ok[:, 1:] &= ok[:, :-1]; ok[1:, :] &= ok[:-1, :]
    zz, xx = np.nonzero((g >= thr) & ok)
    if step > 1:
        k = np.random.default_rng(0).random(len(xx)) < 1 / step; zz, xx = zz[k], xx[k]
    return np.stack([xx + X0 + ox + 0.5, h[zz, xx] + 0.5, zz + Z0 + oz + 0.5], 1).astype(np.float64)
def apply(P, T):
    s, th, tx, tz, ty = T; c, sn = np.cos(th), np.sin(th)
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    return np.stack([s * (c * x - sn * z) + tx, y + ty, s * (sn * x + c * z) + tz], 1)
def icp(S, tree, Tg, T, iters=40, radii=(40, 20, 10, 6, 4), trim=0.7, fit_sim=True):
    for r in radii:
        for _ in range(iters // len(radii)):
            Q = apply(S, T); d, j = tree.query(Q, distance_upper_bound=r)
            k = np.isfinite(d)
            if k.sum() < 100: return T, np.inf, 0
            cut = np.quantile(d[k], trim); k &= d <= cut
            A = S[k][:, [0, 2]]; B = Tg[j[k]][:, [0, 2]]
            ma, mb = A.mean(0), B.mean(0); A0, B0 = A - ma, B - mb
            if fit_sim:
                U, D, Vt = np.linalg.svd(B0.T @ A0); R = U @ np.diag([1, np.sign(np.linalg.det(U @ Vt))]) @ Vt
                s = D.sum() / (A0 ** 2).sum() if True else 1.0; th = np.arctan2(R[1, 0], R[0, 0])
            else:
                s, th = T[0], T[1]
                c, sn = np.cos(th), np.sin(th); R = np.array([[c, -sn], [sn, c]])
            t = mb - s * R @ ma
            ty = np.median(Tg[j[k]][:, 1] - S[k][:, 1])
            T = (s, th, t[0], t[1], ty)
    Q = apply(S, T); d, j = tree.query(Q, distance_upper_bound=4)
    return T, float(np.median(d[np.isfinite(d)])), float(np.isfinite(d).mean())
if __name__ == '__main__':
    c = json.load(open('out/coarse.json'))
    assert not c['flip'], 'coarse match found a mirror image; similarity model cannot represent it'
    mb_ = json.load(open('out/arnis/meta.json'))
    S = edge_points('arnis', step=8)
    T0 = (1.0, np.radians(c['thetaDeg']), c['t'][0], c['t'][1], c['ty'])
    corners = apply(np.array([[x, 0, z] for x in (0, mb_['W']) for z in (0, mb_['H'])], float), T0)
    pad = 300
    Tg = edge_points('sf', int(corners[:, 0].min()) - pad, int(corners[:, 0].max()) + pad,
                     int(corners[:, 2].min()) - pad, int(corners[:, 2].max()) + pad, step=2)
    print('src pts', len(S), 'tgt pts', len(Tg), flush=True)
    tree = cKDTree(Tg)
    # translation+Y first, then similarity
    T, med, frac = icp(S, tree, Tg, T0, fit_sim=False); print('translation-only', T, 'median d', med, 'inlier<4', frac, flush=True)
    T, med, frac = icp(S, tree, Tg, T, fit_sim=True); print('similarity', T, 'median d', med, 'inlier<4', frac, flush=True)
    s, th, tx, tz, ty = T
    res = dict(model='[x_sf,z_sf] = s*R(theta)*[x_arnis,z_arnis] + [tx,tz]; y_sf = y_arnis + ty',
               s=s, theta_deg=float(np.degrees(th)), tx=tx, tz=tz, ty=ty, median_resid=med, inlier_frac=frac)
    # per-tile translation-only ICP (2 km tiles) to detect drift
    tiles = []
    for gx in range(0, mb_['W'], 2048):
        for gz in range(0, mb_['H'], 2048):
            k = (S[:, 0] >= gx) & (S[:, 0] < gx + 2048) & (S[:, 2] >= gz) & (S[:, 2] < gz + 2048)
            if k.sum() < 2000: continue
            Tt, mt, ft = icp(S[k], tree, Tg, T, iters=20, radii=(10, 6, 4), fit_sim=False)
            q = np.array([[gx + 1024, 0, gz + 1024]], float)
            dxy = apply(q, Tt)[0] - apply(q, T)[0]
            tiles.append(dict(x=gx, z=gz, n=int(k.sum()), ddx=float(dxy[0]), ddz=float(dxy[2]), ddy=float(Tt[4] - T[4]), med=mt, inl=ft))
            print(f'tile {gx:5d},{gz:5d} n={k.sum():6d} drift dx={dxy[0]:+6.1f} dz={dxy[2]:+6.1f} dy={Tt[4]-T[4]:+5.1f} med={mt:.2f} inl={ft:.2f}', flush=True)
    res['tiles'] = tiles
    json.dump(res, open('out/alignment.json', 'w'), indent=1)
