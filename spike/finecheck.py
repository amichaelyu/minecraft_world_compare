# THROWAWAY spike: fine shift check via NCC of high-pass surface height (street grid / building edges).
import numpy as np, json
from scipy.ndimage import uniform_filter
from scipy.signal import fftconvolve
from common import load
TX, TZ, TY = 4240, -7616, 6
ma, mbA, nlA, ofA = load('sf'); mb_, mbB, nlB, ofB = load('arnis')
Z0 = TZ; X0 = TX - mb_['H'] + 1
A = np.asarray(nlA[Z0 - ma['originZ']:Z0 + mb_['W'] - ma['originZ'], X0 - ma['originX']:X0 + mb_['H'] - ma['originX']]).astype(np.float32)
B = np.asarray(nlB).T[:, ::-1].astype(np.float32) + TY
def hp(a):
    a = np.where(a < -128, np.nan, a); m = np.isnan(a); a0 = np.where(m, 0, a)
    lo = uniform_filter(a0, 25) / np.maximum(uniform_filter((~m).astype(np.float32), 25), 1e-3)
    return np.clip(np.where(m, 0, a0 - lo), -12, 12), ~m
hA, vA = hp(A); hB, vB = hp(B)
slope = np.abs(np.gradient(uniform_filter(np.where(vA, A, 0), 65))[0]) + np.abs(np.gradient(uniform_filter(np.where(vA, A, 0), 65))[1])
S, N = 48, 768; H, W = A.shape; res = []
for z in range(S + 256, H - N - S, 1536):
    for x in range(S + 256, W - N - S, 1536):
        if vB[z:z+N, x:x+N].mean() < 0.95 or vA[z:z+N, x:x+N].mean() < 0.95: continue
        if np.median(slope[z:z+N, x:x+N]) > 0.15 or hB[z:z+N, x:x+N].std() < 1.5: continue
        b = hB[z:z+N, x:x+N]; a = hA[z-S:z+N+S, x-S:x+N+S]
        b = (b - b.mean()) / b.std()
        num = fftconvolve(a, b[::-1, ::-1], 'valid')
        s1 = fftconvolve(a, np.ones_like(b), 'valid'); s2 = fftconvolve(a * a, np.ones_like(b), 'valid')
        r = num / np.sqrt(np.maximum(s2 - s1**2 / b.size, 1e-6)) / np.sqrt(b.size)
        dz, dx = np.unravel_index(r.argmax(), r.shape); dz -= S; dx -= S
        rs = np.sort(r.ravel())[::-1]
        res.append(dict(x=int(x + X0), z=int(z + Z0), dx=int(dx), dz=int(dz), r=float(r.max()), r0=float(r[S, S])))
        print(f'window sf(x={x+X0:6d}, z={z+Z0:6d})  best shift dx={dx:+3d} dz={dz:+3d}  r={r.max():.3f}  (r at 0,0 = {r[S,S]:.3f})', flush=True)
json.dump(res, open('out/finecheck.json', 'w'), indent=1)
d = np.array([[q['dx'], q['dz']] for q in res if q['r'] > 0.25])
print('n', len(d), 'median shift', np.median(d, 0) if len(d) else None)
