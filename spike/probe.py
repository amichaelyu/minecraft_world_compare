import sys, zlib, struct
def chunks(path):
    d=open(path,'rb').read()
    for i in range(1024):
        off=int.from_bytes(d[i*4:i*4+3],'big'); n=d[i*4+3]
        if off==0: continue
        L=struct.unpack('>I',d[off*4096:off*4096+4])[0]; ct=d[off*4096+4]
        raw=d[off*4096+5:off*4096+4+L]
        yield i, ct, (zlib.decompress(raw) if ct==2 else raw)
