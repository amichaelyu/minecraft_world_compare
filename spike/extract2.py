# THROWAWAY spike: per-column surfaces computed from block sections (heightmaps are missing/unreliable).
# MOTION_BLOCKING = top non-air; OCEAN_FLOOR = top non-air non-water; MOTION_BLOCKING_NO_LEAVES = top "solid"
# (not air/water/leaves/plants). Same raster layout as extract.py.
import sys, os, re, zlib, struct, json, math, numpy as np
from multiprocessing import Pool
from nbt import parse
AIR = {'minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:light', 'minecraft:structure_void', 'minecraft:barrier'}
WATER = {'minecraft:water', 'minecraft:bubble_column', 'minecraft:kelp', 'minecraft:kelp_plant', 'minecraft:seagrass', 'minecraft:tall_seagrass'}
SOFT = re.compile(r'leaves|grass$|^minecraft:(short_grass|tall_grass|fern|large_fern|dead_bush|vine|snow|.*flower.*|.*_sapling|dandelion|poppy|.*tulip|azure_bluet|oxeye_daisy|cornflower|allium|blue_orchid|lily_of_the_valley|sugar_cane|.*carpet|torch|wall_torch|lantern|rail|powered_rail|redstone_wire|lily_pad|bush|leaf_litter|.*button|.*pressure_plate|.*sign|.*banner|.*fence|.*_wall|.*pane|iron_bars|chain|.*head|.*skull|flower_pot|.*potted.*)$')
def cat(n):
    if n in AIR: return 0
    if n in WATER: return 1
    if SOFT.search(n) and n != 'minecraft:grass_block': return 2
    return 3
CACHE = {}
def cats_of(palette):
    out = np.empty(len(palette), np.uint8)
    for i, p in enumerate(palette):
        n = p.get('Name', 'minecraft:air'); c = CACHE.get(n)
        if c is None: c = CACHE[n] = cat(n)
        out[i] = c
    return out
KEYS = ['MOTION_BLOCKING', 'MOTION_BLOCKING_NO_LEAVES', 'OCEAN_FLOOR']
def work(args):
    path, out, rx, rz, rx0, rz0, W, H = args
    mm = [np.memmap(f'{out}/{k}.i16', dtype=np.int16, mode='r+', shape=(H, W)) for k in KEYS]
    d = open(path, 'rb').read(); n = 0
    for i in range(1024):
        off = int.from_bytes(d[i*4:i*4+3], 'big')
        if off == 0: continue
        L = struct.unpack('>I', d[off*4096:off*4096+4])[0]
        b = zlib.decompress(d[off*4096+5:off*4096+4+L]); root = parse(b)
        secs = sorted([s for s in root.get('sections', []) if 'block_states' in s], key=lambda s: -s['Y'])
        res = [np.full((16, 16), -32768, np.int16) for _ in KEYS]
        todo = [np.ones((16, 16), bool) for _ in KEYS]
        for s in secs:
            bs = s['block_states']; pal = bs.get('palette', [])
            if not pal: continue
            c = cats_of(pal)
            if 'data' in bs:
                _, p0, cnt = bs['data']; bits = max(4, math.ceil(math.log2(len(pal))))
                epl = 64 // bits; longs = np.frombuffer(b, '>u8', cnt, p0).astype(np.uint64)
                idx = np.arange(4096); v = (longs[idx // epl] >> ((idx % epl) * bits).astype(np.uint64)) & np.uint64((1 << bits) - 1)
                cc = c[np.minimum(v.astype(np.int64), len(c) - 1)].reshape(16, 16, 16)
            else:
                if c[0] == 0: continue
                cc = np.full((16, 16, 16), c[0], np.uint8)
            base = s['Y'] * 16
            for k, thr in enumerate([(1, 2, 3), (3,), (2, 3)]):  # MB, NL, OF
                if not todo[k].any(): continue
                m = np.isin(cc, thr)[::-1]  # top-down
                has = m.any(0); top = 15 - m.argmax(0)
                sel = has & todo[k]; res[k][sel] = base + top[sel]; todo[k] &= ~has
            if not any(t.any() for t in todo): break
        cx, cz = i % 32, i // 32
        x0 = (rx - rx0) * 512 + cx * 16; z0 = (rz - rz0) * 512 + cz * 16
        for m_, r_ in zip(mm, res):
            r_[r_ == -32768] = -129  # empty column (chunk exists)
            m_[z0:z0+16, x0:x0+16] = r_
        n += 1
    for m_ in mm: m_.flush()
    return n
if __name__ == '__main__':
    regdir, out = sys.argv[1], sys.argv[2]; os.makedirs(out, exist_ok=True)
    files = [(f, *map(int, re.match(r'r\.(-?\d+)\.(-?\d+)\.mca', f).groups())) for f in os.listdir(regdir) if f.endswith('.mca')]
    rxs = [f[1] for f in files]; rzs = [f[2] for f in files]
    rx0, rz0 = min(rxs), min(rzs); W = (max(rxs) - rx0 + 1) * 512; H = (max(rzs) - rz0 + 1) * 512
    for k in KEYS: np.memmap(f'{out}/{k}.i16', dtype=np.int16, mode='w+', shape=(H, W))[:] = -32768
    json.dump({'originX': rx0 * 512, 'originZ': rz0 * 512, 'W': W, 'H': H, 'minY': -128}, open(f'{out}/meta.json', 'w'))
    jobs = sorted([(os.path.join(regdir, f), out, rx, rz, rx0, rz0, W, H) for f, rx, rz in files], key=lambda j: -os.path.getsize(j[0]))
    with Pool(14) as p:
        total = 0
        for i, n in enumerate(p.imap_unordered(work, jobs)):
            total += n
            if i % 100 == 0: print(f'{i+1}/{len(jobs)} regions, {total} chunks', flush=True)
    print('done', total)
