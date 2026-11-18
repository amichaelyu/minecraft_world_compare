// TEMPORARY dev stub for the mesher pool: one flat-coloured cube per visible block, meshed on the
// main thread. Only used until src/client/mesher/ lands; see mesher-source.ts for the switch.
import type { AssetBundle, MeshBuffers, MesherPool, TileMesh } from "../shared/mesh-types.ts";
import { decodeTile } from "../shared/tile-format.ts";

const AIRS = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);
const TRANSLUCENT = /water|ice$|stained_glass$|slime_block|honey_block/;
const CUTOUT =
  /glass|leaves|pane|grass$|fern|flower|tulip|poppy|dandelion|torch|rail|sapling|vine|bars|fence|door|sign|lantern|button|carpet|snow$|slab|stairs|_wall$|ladder|kelp|lily|mushroom$|bush|orchid|allium|daisy|cornflower|rose|peony|lilac|sunflower|bamboo|sugar_cane|cactus|chain|candle|pot$|banner|head$|skull|_bed$|plate$|lever|wire|repeater|comparator/;

// face dirs: +x -x +y -y +z -z
const DIRS = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
] as const;
// unit-cube corners per face, CCW seen from outside
const FACES = [
  [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
  [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]],
  [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]],
  [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
  [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]],
  [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]],
] as const;

function hashColor(s: string): [number, number, number] {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return [96 + (h & 127), 96 + ((h >>> 8) & 127), 96 + ((h >>> 16) & 127)];
}

class Bucket {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  toBuffers(uv: [number, number]): MeshBuffers | null {
    if (!this.idx.length) return null;
    const nv = this.pos.length / 3;
    const uvs = new Float32Array(nv * 2);
    for (let i = 0; i < nv; i++) {
      uvs[i * 2] = uv[0];
      uvs[i * 2 + 1] = uv[1];
    }
    return {
      positions: new Float32Array(this.pos),
      normals: new Int8Array(this.nrm),
      uvs,
      colors: new Uint8Array(this.col),
      indices: new Uint32Array(this.idx),
    };
  }
}

function meshTile(buf: ArrayBuffer, assets: AssetBundle): TileMesh {
  const t = decodeTile(buf);
  const NY = t.numSections * 16;
  const vol = new Uint16Array(64 * 64 * NY); // (y*64 + z)*64 + x
  for (let c = 0; c < 16; c++) {
    const secs = t.chunks[c];
    if (!secs) continue;
    const ox = (c & 3) * 16, oz = (c >> 2) * 16;
    for (let s = 0; s < secs.length; s++) {
      const sec = secs[s]!;
      if (sec.kind === 0) continue;
      for (let y = 0; y < 16; y++)
        for (let z = 0; z < 16; z++) {
          const row = ((s * 16 + y) * 64 + oz + z) * 64 + ox;
          if (sec.kind === 1) vol.fill(sec.index, row, row + 16);
          else for (let x = 0; x < 16; x++) vol[row + x] = sec.data[y * 256 + z * 16 + x]!;
        }
    }
  }
  // class per palette entry: 0 air, 1 opaque, 2 cutout, 3 translucent
  const cls = new Uint8Array(t.palette.length);
  const cols: [number, number, number][] = [];
  t.palette.forEach((state, i) => {
    const name = state.split("[")[0]!;
    const short = name.replace("minecraft:", "");
    cls[i] = AIRS.has(name) ? 0 : TRANSLUCENT.test(short) ? 3 : CUTOUT.test(short) ? 2 : 1;
    cols[i] = short === "water" ? [63, 118, 228] : (assets.colors?.[name] ?? hashColor(name));
  });

  const buckets = [new Bucket(), new Bucket(), new Bucket()];
  const y0 = t.minSectionY * 16;
  for (let y = 0; y < NY; y++)
    for (let z = 0; z < 64; z++)
      for (let x = 0; x < 64; x++) {
        const p = vol[(y * 64 + z) * 64 + x]!;
        const k = cls[p]!;
        if (k === 0) continue;
        for (let f = 0; f < 6; f++) {
          const [dx, dy, dz] = DIRS[f]!;
          const nx = x + dx, ny = y + dy, nz = z + dz;
          if (nx < 0 || nx >= 64 || nz < 0 || nz >= 64 || ny < 0) continue; // treat outside as solid
          let nk = 0, np = 0;
          if (ny < NY) {
            np = vol[(ny * 64 + nz) * 64 + nx]!;
            nk = cls[np]!;
          }
          if (nk === 1 || np === p || (k === 3 && nk === 3)) continue;
          const b = buckets[k - 1]!;
          const base = b.pos.length / 3;
          const [r, g, bl] = cols[p]!;
          for (const [cx, cy, cz] of FACES[f]!) {
            b.pos.push(x + cx, y0 + y + cy, z + cz);
            b.nrm.push(dx * 127, dy * 127, dz * 127);
            b.col.push(r, g, bl);
          }
          b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
      }

  // point every vertex at a near-white atlas texel so the vertex colour shows through
  const white = assets.textures?.["minecraft:block/white_concrete"];
  const W = assets.atlas?.width || 1, Hh = assets.atlas?.height || 1;
  const uv: [number, number] = white ? [(white[0] + white[2] / 2) / W, (white[1] + white[3] / 2) / Hh] : [0, 0];
  return {
    tx: t.tx,
    tz: t.tz,
    opaque: buckets[0]!.toBuffers(uv),
    cutout: buckets[1]!.toBuffers(uv),
    translucent: buckets[2]!.toBuffers(uv),
  };
}

export function createMesherPool(assets: AssetBundle, _workers: number): MesherPool {
  let chain = Promise.resolve();
  return {
    mesh(blob: ArrayBuffer): Promise<TileMesh> {
      // serialise and yield to the frame loop between tiles
      const job = chain.then(() => new Promise<TileMesh>((res, rej) => setTimeout(() => {
        try {
          res(meshTile(blob, assets));
        } catch (e) {
          rej(e);
        }
      }, 0)));
      chain = job.then(() => undefined, () => undefined);
      return job;
    },
    dispose() {},
  };
}
