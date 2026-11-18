# THROWAWAY spike: street-grid NCC check of an arbitrary transform (arnis resampled into sf frame).
import numpy as np, json, sys
from scipy.ndimage import uniform_filter
from scipy.signal import fftconvolve
from common import load
T = json.load(open(sys.argv[1])); s, th, tx, tz, ty = T['s'], np.radians(T['thetaDeg']), T['tx'], T['tz'], T['ty']
ma, mbA, nlA, ofA = load('sf'); mb_, mbB, nlB, ofB = load('arnis'); NB = np.asarray(nlB)
def hp(a):
    m = a < -128; a0 = np.where(m, 0, a).astype(np.float32)
    lo = uniform_filter(a0, 25) / np.maximum(uniform_filter((~m).astype(np.float32), 25), 1e-3)
    return np.clip(np.where(m, 0, a0 - lo), -12, 12)
S, N = 48, 768; res = []
for X in range(-6500, 2500, 1300):
    for Z in range(-4500, 5000, 1300):
        zz, xx = np.mgrid[Z - S:Z + N + S, X - S:X + N + S].astype(np.float64)
        # inverse: arnis = R^-1 (sf - t) / s
        u, v = (xx + 0.5 - tx) / s, (zz + 0.5 - tz) / s
        xa = np.cos(th) * u + np.sin(th) * v; za = -np.sin(th) * u + np.cos(th) * v
        xi, zi = np.floor(xa).astype(int), np.floor(za).astype(int)
        inb = (xi >= 0) & (xi < NB.shape[1]) & (zi >= 0) & (zi < NB.shape[0])
        if inb.mean() < 0.99: continue
        b = hp(NB[np.clip(zi, 0, NB.shape[0] - 1), np.clip(xi, 0, NB.shape[1] - 1)].astype(np.float32) + ty)[S:S+N, S:S+N]
        a = hp(np.asarray(nlA[Z - S - ma['originZ']:Z + N + S - ma['originZ'], X - S - ma['originX']:X + N + S - ma['originX']]))
        if b.std() < 1.5 or (a < -127).mean() > 0.05: continue
        b = (b - b.mean()) / b.std()
        num = fftconvolve(a, b[::-1, ::-1], 'valid'); s1 = fftconvolve(a, np.ones_like(b), 'valid'); s2 = fftconvolve(a * a, np.ones_like(b), 'valid')
        r = num / np.sqrt(np.maximum(s2 - s1**2 / b.size, 1e-6)) / np.sqrt(b.size)
        dz, dx = np.unravel_index(r.argmax(), r.shape)
        res.append((X, Z, dx - S, dz - S, r.max(), r[S, S]))
        print(f'window sf(x={X:6d}, z={Z:6d}) best shift dx={dx-S:+3d} dz={dz-S:+3d} r={r.max():.3f} (r at 0,0 = {r[S,S]:.3f})', flush=True)
d = np.array([[q[2], q[3]] for q in res if q[4] > 0.2]); print('windows with r>0.2:', len(d), 'of', len(res), 'median shift', np.median(d, 0) if len(d) else None)
