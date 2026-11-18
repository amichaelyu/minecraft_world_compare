import json, numpy as np
def load(name):
    m = json.load(open(f'out/{name}/meta.json'))
    g = lambda k: np.memmap(f'out/{name}/{k}.i16', dtype=np.int16, mode='r', shape=(m['H'], m['W']))
    return m, g('MOTION_BLOCKING'), g('MOTION_BLOCKING_NO_LEAVES'), g('OCEAN_FLOOR')
def block(a, f, fn=np.mean):
    H, W = a.shape[0] // f * f, a.shape[1] // f * f
    return fn(a[:H, :W].reshape(H // f, f, W // f, f), axis=(1, 3))
