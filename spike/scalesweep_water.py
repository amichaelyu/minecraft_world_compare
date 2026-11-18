# THROWAWAY spike: sweep anisotropic scale of arnis (in its own x/z) with the 90° rotation fixed;
# masked NCC of ground elevation at 1/F; report best scale + offset.
import numpy as np, json, sys
from scipy.ndimage import zoom
from coarse import rasters, ncc
F = 16
ma, ga, wa, va, XA, ZA = rasters('sf'); mb_, gb, wb, vb, XB, ZB = rasters('arnis')
GA = wa; VGA = va
res = []
grid = [float(v) for v in sys.argv[1].split(',')]
for sx in grid:
    for sz in grid:
        g = zoom(np.where(vb > 0, wb, -9999), (sz, sx), order=0)
        g = np.where(g < -9000, np.nan, g)
        gB = np.rot90(g, 3); VGB = (~np.isnan(gB)).astype(float)
        r = ncc(GA, VGA, np.nan_to_num(gB), VGB); iz, ix = np.unravel_index(np.argmax(r), r.shape)
        res.append((r[iz, ix], sx, sz, ix, iz)); print(f'sx={sx:.3f} sz={sz:.3f} r={r[iz, ix]:.4f} cell=({ix},{iz})', flush=True)
best = max(res); print('BEST', best)
json.dump([list(map(float, q)) for q in res], open('out/scalesweep_water.json', 'w'))
