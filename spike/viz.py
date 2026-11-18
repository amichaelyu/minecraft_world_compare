import numpy as np
from PIL import Image
from common import load, block
F=16
for name in ['sf','arnis']:
    m, mb, nl, of = load(name)
    s = (slice(None,None,F), slice(None,None,F))
    a = np.asarray(mb[s]).astype(np.float32); o = np.asarray(of[s]).astype(np.float32)
    valid = a > -32768; water = (a > o) & valid
    h = np.clip((o + 70) / 200, 0, 1)
    img = np.zeros(a.shape + (3,), np.uint8)
    img[..., 0] = img[..., 1] = img[..., 2] = (h * 255).astype(np.uint8)
    img[water] = [40, 80, 200]; img[~valid] = [255, 0, 255]
    Image.fromarray(img).save(f'out/{name}_overview.png')
    print(name, a.shape, 'water frac', water[valid].mean(), 'ground y pctl', np.percentile(o[valid & ~water], [1,50,99]))
