import sys,zlib,struct,re
from probe import chunks
for p in sys.argv[1:]:
    for i,ct,b in chunks(p):
        y=b.find(b'\x01\x00\x04yPos'); 
        print(p.split('/')[-1],'yPos',struct.unpack('>b',b[y+7:y+8])[0] if y>=0 else None, end=' ')
        for k in [b'MOTION_BLOCKING',b'OCEAN_FLOOR',b'MOTION_BLOCKING_NO_LEAVES']:
            j=b.find(b'\x0c'+struct.pack('>H',len(k))+k); n=struct.unpack('>i',b[j+3+len(k):j+7+len(k)])[0]; print(k.decode(),n,end=' ')
        print(); break
