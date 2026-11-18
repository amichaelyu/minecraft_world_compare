# THROWAWAY spike: (1) brute-force shift check of the alignment on building footprints,
# (2) preliminary arnis-vs-replica comparison in the replica frame.
import numpy as np, json
from scipy.ndimage import minimum_filter, uniform_filter
from PIL import Image
from common import load
TX, TZ, TY = 4240, -7616, 6  # x_sf = -z_a + TX ; z_sf = x_a + TZ ; y_sf = y_a + TY
ma, mbA, nlA, ofA = load('sf'); mb_, mbB, nlB, ofB = load('arnis')
# arnis rasters resampled into the sf frame over the arnis footprint
Z0, Z1 = 0 + TZ, mb_['W'] + TZ           # z_sf range  (x_a 0..W)
X0, X1 = TX - mb_['H'] + 1, TX + 1       # x_sf range  (z_a H-1..0)
def to_sf(a):  # a[z_a, x_a] -> b[z_sf - Z0, x_sf - X0]
    return np.asarray(a).T[:, ::-1]
def crop_sf(a):
    return np.asarray(a[Z0 - ma['originZ']:Z1 - ma['originZ'], X0 - ma['originX']:X1 - ma['originX']])
A = {k: crop_sf(v).astype(np.int16) for k, v in [('mb', mbA), ('nl', nlA), ('of', ofA)]}
B = {k: (to_sf(v).astype(np.int16) + TY) for k, v in [('mb', mbB), ('nl', nlB), ('of', ofB)]}
for k in B: B[k][to_sf(mbB) <= -129] = -32768
print('overlap raster', A['mb'].shape, B['mb'].shape, flush=True)
def derive(R):
    valid = R['mb'] > -32768
    water = valid & (R['mb'] > R['of'])
    ground = minimum_filter(np.where(valid & ~water, R['nl'], 999).astype(np.int16), size=41)
    bld = valid & ~water & (R['nl'] - ground >= 4)
    tree = valid & (R['mb'] > R['nl']) & ~water
    return valid, water, ground, bld, tree
vA, wA, gA, bA, tA = derive(A); vB, wB, gB, bB, tB = derive(B)
both = vA & vB
# (1) shift check
H, W = bA.shape; rng = np.random.default_rng(1); S = 24; out = []
cands = [(z, x) for z in range(S, H - 1024 - S, 512) for x in range(S, W - 1024 - S, 512)]
dens = [bB[z:z+1024, x:x+1024].mean() for z, x in cands]
for (z, x) in [cands[i] for i in np.argsort(dens)[::-1][:12]]:
    b = bB[z:z+1024, x:x+1024]; best = None; grid = np.zeros((2*S+1, 2*S+1))
    for dz in range(-S, S+1):
        for dx in range(-S, S+1):
            a = bA[z+dz:z+dz+1024, x+dx:x+dx+1024]
            iou = (a & b).sum() / max((a | b).sum(), 1); grid[dz+S, dx+S] = iou
    dz, dx = np.unravel_index(grid.argmax(), grid.shape)
    out.append((z, x, dx - S, dz - S, grid.max(), grid[S, S]))
    print(f'window sf(x={x+X0},z={z+Z0}) best shift dx={dx-S:+d} dz={dz-S:+d} IoU={grid.max():.3f} (at 0,0: {grid[S,S]:.3f})', flush=True)
# (2) stats over overlap
def iou(a, b): return (a & b & both).sum() / max(((a | b) & both).sum(), 1)
gd = (gA - gB)[both & ~wA & ~wB & (gA < 900) & (gB < 900)]
hb = bA & bB & both
stats = dict(
    overlap_km2=float(both.sum() / 1e6),
    water_frac_sf=float(wA[both].mean()), water_frac_arnis=float(wB[both].mean()), water_iou=float(iou(wA, wB)),
    building_frac_sf=float(bA[both].mean()), building_frac_arnis=float(bB[both].mean()), building_iou=float(iou(bA, bB)),
    tree_frac_sf=float(tA[both].mean()), tree_frac_arnis=float(tB[both].mean()), tree_iou=float(iou(tA, tB)),
    ground_dy_median=float(np.median(gd)), ground_dy_mad=float(np.median(np.abs(gd - np.median(gd)))),
    ground_abs_dy_p90=float(np.percentile(np.abs(gd), 90)),
    roof_height_sf_minus_arnis_median=float(np.median((A['nl'] - B['nl'])[hb])),
    roof_height_abs_diff_p50_p90=[float(x) for x in np.percentile(np.abs(A['nl'] - B['nl'])[hb], [50, 90])],
    building_height_above_ground_median_sf=float(np.median((A['nl'] - gA)[bA & both])),
    building_height_above_ground_median_arnis=float(np.median((B['nl'] - gB)[bB & both])),
    shift_check=[dict(x=int(x + X0), z=int(z + Z0), best_dx=int(dx), best_dz=int(dz), iou_best=float(m), iou_zero=float(m0)) for z, x, dx, dz, m, m0 in out])
json.dump(stats, open('out/compare.json', 'w'), indent=1)
for k, v in stats.items():
    if k != 'shift_check': print(k, v)
# images: building overlay (sf only = red, arnis only = cyan, both = white), water blue tint
def overlay(sl, F, path):
    a = bA[sl][::F, ::F]; b = bB[sl][::F, ::F]; w = (wA | wB)[sl][::F, ::F]; v = both[sl][::F, ::F]
    img = np.full(a.shape + (3,), 30, np.uint8); img[w] = [20, 40, 90]
    img[a & ~b] = [230, 60, 60]; img[b & ~a] = [60, 220, 230]; img[a & b] = [240, 240, 240]; img[~v] = [80, 0, 80]
    Image.fromarray(img).save(path)
overlay((slice(None), slice(None)), 8, 'out/overlay_city.png')
# downtown-ish: densest arnis building window
z, x = cands[int(np.argmax(dens))]
overlay((slice(z - 512, z + 1536), slice(x - 512, x + 1536)), 1, 'out/overlay_zoom.png')
print('zoom window sf x', x + X0 - 512, 'z', z + Z0 - 512)
