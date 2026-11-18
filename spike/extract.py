# THROWAWAY spike: extract per-block heightmaps (MOTION_BLOCKING, MOTION_BLOCKING_NO_LEAVES, OCEAN_FLOOR)
# from every chunk of a world into int16 rasters (top block Y; -32768 = no chunk).
import sys, os, re, zlib, struct, json, numpy as np
from multiprocessing import Pool
MIN_Y = -128; BITS = 10; EPL = 64 // BITS
IDX = np.arange(256); LI = IDX // EPL; SH = ((IDX % EPL) * BITS).astype(np.uint64); MASK = np.uint64((1 << BITS) - 1)
KEYS = [b'MOTION_BLOCKING', b'MOTION_BLOCKING_NO_LEAVES', b'OCEAN_FLOOR']
PAT = {k: b'\x0c' + struct.pack('>H', len(k)) + k for k in KEYS}

def unpack(b, k):
    j = b.find(PAT[k])
    if j < 0: return None
    j += len(PAT[k]); n = struct.unpack('>i', b[j:j+4])[0]
    longs = np.frombuffer(b, dtype='>u8', count=n, offset=j+4).astype(np.uint64)
    v = (longs[LI] >> SH) & MASK
    return (v.astype(np.int16) + (MIN_Y - 1)).reshape(16, 16)  # [z][x]

def work(args):
    path, out, rx, rz, rx0, rz0, W, H = args
    mm = [np.memmap(f'{out}/{k.decode()}.i16', dtype=np.int16, mode='r+', shape=(H, W)) for k in KEYS]
    d = open(path, 'rb').read(); n = 0
    for i in range(1024):
        off = int.from_bytes(d[i*4:i*4+3], 'big')
        if off == 0: continue
        L = struct.unpack('>I', d[off*4096:off*4096+4])[0]; ct = d[off*4096+4]
        if ct != 2: continue
        b = zlib.decompress(d[off*4096+5:off*4096+4+L])
        cx, cz = i % 32, i // 32
        x0 = (rx - rx0) * 512 + cx * 16; z0 = (rz - rz0) * 512 + cz * 16
        for m, k in zip(mm, KEYS):
            a = unpack(b, k)
            if a is not None: m[z0:z0+16, x0:x0+16] = a
        n += 1
    for m in mm: m.flush()
    return n

if __name__ == '__main__':
    regdir, out = sys.argv[1], sys.argv[2]; os.makedirs(out, exist_ok=True)
    files = [(f, *map(int, re.match(r'r\.(-?\d+)\.(-?\d+)\.mca', f).groups())) for f in os.listdir(regdir) if f.endswith('.mca')]
    rxs = [f[1] for f in files]; rzs = [f[2] for f in files]
    rx0, rz0 = min(rxs), min(rzs); W = (max(rxs) - rx0 + 1) * 512; H = (max(rzs) - rz0 + 1) * 512
    for k in KEYS:
        np.memmap(f'{out}/{k.decode()}.i16', dtype=np.int16, mode='w+', shape=(H, W))[:] = -32768
    json.dump({'originX': rx0 * 512, 'originZ': rz0 * 512, 'W': W, 'H': H, 'minY': MIN_Y}, open(f'{out}/meta.json', 'w'))
    jobs = [(os.path.join(regdir, f), out, rx, rz, rx0, rz0, W, H) for f, rx, rz in files]
    with Pool(14) as p:
        total = 0
        for i, n in enumerate(p.imap_unordered(work, jobs)):
            total += n
            if i % 50 == 0: print(f'{i+1}/{len(jobs)} regions, {total} chunks', flush=True)
    print('done', total, 'chunks')
