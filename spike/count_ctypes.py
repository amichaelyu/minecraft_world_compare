import os,sys,struct,collections
d=sys.argv[1]; c=collections.Counter(); ext=0
for f in sorted(os.listdir(d))[::20]:
    b=open(os.path.join(d,f),'rb').read()
    for i in range(1024):
        off=int.from_bytes(b[i*4:i*4+3],'big')
        if off==0: continue
        c[b[off*4096+4]]+=1
print(c)
