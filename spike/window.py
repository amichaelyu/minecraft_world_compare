import numpy as np, sys
from PIL import Image
from common import load
TX, TZ, TY = 4240, -7616, 6
ma, mbA, nlA, ofA = load('sf'); mb_, mbB, nlB, ofB = load('arnis')
X, Z, N = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])  # sf frame window corner
a = np.asarray(nlA[Z - ma['originZ']:Z - ma['originZ'] + N, X - ma['originX']:X - ma['originX'] + N]).astype(np.float32)
# arnis sample for each sf cell: x_a = Z - TZ, z_a = TX - X
zz, xx = np.mgrid[Z:Z+N, X:X+N]
b = np.asarray(nlB)[TX - xx, zz - TZ].astype(np.float32) + TY
def shade(h):
    gx = np.gradient(h, axis=1); gz = np.gradient(h, axis=0)
    s = np.clip(128 + 40 * (gx - gz), 0, 255)
    return s.astype(np.uint8)
img = np.concatenate([shade(a), np.full((N, 8), 255, np.uint8), shade(b)], 1)
Image.fromarray(img).save(sys.argv[4])
print('a range', np.percentile(a, [5, 50, 95]), 'b range', np.percentile(b, [5, 50, 95]))
