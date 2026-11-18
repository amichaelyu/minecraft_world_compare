# THROWAWAY spike: comparison images with the refined arbitrary-rotation transform.
import numpy as np, json
from scipy.ndimage import uniform_filter
from PIL import Image
from common import load
T = json.load(open('alignment-arnis.json')); s, th, tx, tz, ty = T['s'], np.radians(T['thetaDeg']), T['tx'], T['tz'], T['ty']
ma, mbA, nlA, ofA = load('sf'); mb_, mbB, nlB, ofB = load('arnis')
MB, NB, OB = np.asarray(mbB), np.asarray(nlB), np.asarray(ofB)
def sample_b(X0, Z0, w, h, F):
    zz, xx = np.mgrid[Z0:Z0 + h:F, X0:X0 + w:F].astype(np.float64)
    u, v = (xx + 0.5 - tx) / s, (zz + 0.5 - tz) / s
    xa = np.floor(np.cos(th) * u + np.sin(th) * v).astype(int); za = np.floor(-np.sin(th) * u + np.cos(th) * v).astype(int)
    inb = (xa >= 0) & (xa < NB.shape[1]) & (za >= 0) & (za < NB.shape[0]); xa, za = np.clip(xa, 0, NB.shape[1] - 1), np.clip(za, 0, NB.shape[0] - 1)
    f = lambda a: np.where(inb, a[za, xa].astype(np.int32) + ty, -32768)
    return f(MB), f(NB), f(OB)
def sample_a(X0, Z0, w, h, F):
    sl = (slice(Z0 - ma['originZ'], Z0 - ma['originZ'] + h, F), slice(X0 - ma['originX'], X0 - ma['originX'] + w, F))
    return [np.asarray(a[sl]).astype(np.int32) for a in (mbA, nlA, ofA)]
def bld(mb, nl, of, F):
    v = mb > -129; w = v & (mb > of); k = max(3, 61 // F)
    lo = uniform_filter(np.where(v & ~w, nl, 0).astype(np.float32), k) / np.maximum(uniform_filter((v & ~w).astype(np.float32), k), 1e-3)
    return v, w, v & ~w & (nl - lo >= 4)
def overlay(X0, Z0, w, h, F, path):
    vA, wA, bA = bld(*sample_a(X0, Z0, w, h, F), F); vB, wB, bB = bld(*sample_b(X0, Z0, w, h, F), F)
    img = np.full(bA.shape + (3,), 30, np.uint8); img[wA | wB] = [20, 40, 90]
    img[bA & ~bB] = [230, 60, 60]; img[bB & ~bA] = [60, 220, 230]; img[bA & bB] = [240, 240, 240]; img[~(vA & vB)] = [80, 0, 80]
    Image.fromarray(img).save(path)
def hill(X0, Z0, N, path):
    a = sample_a(X0, Z0, N, N, 1)[1].astype(np.float32); b = sample_b(X0, Z0, N, N, 1)[1].astype(np.float32)
    sh = lambda h: np.clip(128 + 40 * (np.gradient(h, axis=1) - np.gradient(h, axis=0)), 0, 255).astype(np.uint8)
    Image.fromarray(np.concatenate([sh(a), np.full((N, 8), 255, np.uint8), sh(b)], 1)).save(path)
overlay(-7500, -6000, 11500, 12500, 8, 'out/v2_overlay_city.png')
overlay(-1500, 1200, 2048, 2048, 1, 'out/v2_overlay_downtown.png')
hill(-2623, 3440, 512, 'out/v2_win1.png'); hill(449, -5776, 512, 'out/v2_win2.png')
print('ok')
