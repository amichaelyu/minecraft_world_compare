# THROWAWAY spike: real lat/lon -> arnis blocks (its local projection) -> sf frame (alignment), checked
# against sf geometry; prints TypeScript Landmark entries with a camera pose looking at each one.
import json, math, numpy as np
from common import load
meta = json.load(open('/dev/stdin'))
T = json.load(open('alignment-arnis.json'))
s, th, tx, tz, ty = T['s'], math.radians(T['thetaDeg']), T['tx'], T['tz'], T['ty']
lenX, lenZ = meta['maxMcX'] + 1, meta['maxMcZ'] + 1
def to_sf(lat, lon):
    xa = (lon - meta['minGeoLon']) / (meta['maxGeoLon'] - meta['minGeoLon']) * lenX
    za = (1 - (lat - meta['minGeoLat']) / (meta['maxGeoLat'] - meta['minGeoLat'])) * lenZ
    return s * (math.cos(th) * xa - math.sin(th) * za) + tx, s * (math.sin(th) * xa + math.cos(th) * za) + tz
ma, mb, nl, of = load('sf')
def column(x, z, r):
    i, j = int(z) - ma['originZ'], int(x) - ma['originX']
    a = np.asarray(mb[i - r:i + r + 1, j - r:j + r + 1]).astype(int); a[a < -129] = -999
    k = np.unravel_index(a.argmax(), a.shape)
    g = np.asarray(nl[i - r:i + r + 1, j - r:j + r + 1]).astype(int); g = g[g > -129]
    return int(a.max()), int(x - r + k[1]), int(z - r + k[0]), int(np.percentile(g, 10)) if g.size else 0
# name, lat, lon, kind ('tower': snap to tallest point within r; 'area': overview), view distance, camera height above ground
L = [
    ('Ferry Building', 37.79553, -122.39370, 'tower', 40, 160, 40),
    ('Transamerica Pyramid', 37.79518, -122.40278, 'tower', 40, 320, 80),
    ('Salesforce Tower', 37.78977, -122.39689, 'tower', 40, 420, 120),
    ('Coit Tower', 37.80239, -122.40583, 'tower', 40, 180, 60),
    ('Sutro Tower', 37.75524, -122.45276, 'tower', 40, 420, 120),
    ('Twin Peaks', 37.75440, -122.44770, 'area', 0, 250, 160),
    ('Golden Gate Park', 37.76940, -122.48620, 'area', 0, 900, 450),
    ('Painted Ladies (Alamo Sq)', 37.77620, -122.43280, 'area', 0, 120, 35),
    ('City Hall', 37.77927, -122.41924, 'tower', 30, 220, 60),
    ('Oracle Park', 37.77857, -122.38927, 'area', 0, 260, 90),
    ('Lombard St (crooked)', 37.80214, -122.41874, 'area', 0, 120, 50),
    ('Palace of Fine Arts', 37.80286, -122.44836, 'area', 0, 180, 60),
    ('Golden Gate Bridge (south)', 37.80880, -122.47530, 'area', 0, 500, 200),
    ('Mission Dolores', 37.76443, -122.42695, 'area', 0, 120, 40),
]
out = []
for name, lat, lon, kind, snap, dist, h in L:
    x, z = to_sf(lat, lon)
    top, px, pz, ground = column(x, z, snap) if snap else (*column(x, z, 0)[:1], int(x), int(z), column(x, z, 60)[3])
    note = f'snapped {math.hypot(px - x, pz - z):.0f} blocks to top y={top}' if snap else f'surface y={top}'
    # camera: back off along a fixed bearing (from the sf-frame south-west of the target), look at the target
    yaw = -135.0; dx, dz = -math.sin(math.radians(yaw)), math.cos(math.radians(yaw))
    cx, cz = px - dx * dist, pz - dz * dist
    cy = max(ground, column(cx, cz, 2)[0]) + h
    aim = (top + ground) / 2 if kind == 'tower' else ground
    pitch = math.degrees(math.atan2(cy - aim, dist))
    print(f'{name:28s} geo->sf ({x:7.0f},{z:7.0f})  {note}  ground~{ground}')
    out.append(f'  {{ name: "{name}", x: {cx:.0f}, y: {cy:.0f}, z: {cz:.0f}, yaw: {yaw:.0f}, pitch: {pitch:.0f} }},')
open('out/landmarks.ts.txt', 'w').write('\n'.join(out) + '\n')
