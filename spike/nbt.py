import struct
def parse(b):
    pos = [0]
    def rd(fmt, n):
        v = struct.unpack_from(fmt, b, pos[0]); pos[0] += n; return v[0]
    def name():
        n = rd('>H', 2); s = b[pos[0]:pos[0]+n].decode('utf-8', 'replace'); pos[0] += n; return s
    def payload(t):
        if t == 1: return rd('>b', 1)
        if t == 2: return rd('>h', 2)
        if t == 3: return rd('>i', 4)
        if t == 4: return rd('>q', 8)
        if t == 5: return rd('>f', 4)
        if t == 6: return rd('>d', 8)
        if t == 7:
            n = rd('>i', 4); v = b[pos[0]:pos[0]+n]; pos[0] += n; return v
        if t == 8: return name()
        if t == 9:
            et = rd('>b', 1); n = rd('>i', 4); return [payload(et) for _ in range(n)]
        if t == 10:
            d = {}
            while True:
                tt = rd('>b', 1)
                if tt == 0: return d
                k = name(); d[k] = payload(tt)
        if t == 11:
            n = rd('>i', 4); v = (pos[0], n); pos[0] += 4 * n; return v
        if t == 12:
            n = rd('>i', 4); v = ('L', pos[0], n); pos[0] += 8 * n; return v
        raise ValueError(t)
    t = rd('>b', 1); name(); return payload(t)
