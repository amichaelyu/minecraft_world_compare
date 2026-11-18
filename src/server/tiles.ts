// MCT1 tile builder: 4x4 chunk columns -> palette-indexed sections.

import { AIR, encodeTile, type DecodedTile, type Section } from "../shared/tile-format.ts";
import { TILE_CHUNKS } from "../shared/api.ts";
import { parseChunk, unpackLongs, type ChunkSection } from "./nbt.ts";
import type { RegionStore } from "./region.ts";

/** Block ids drawn as nothing; folded into palette index 0. */
export const AIR_IDS = new Set([AIR, "minecraft:cave_air", "minecraft:void_air"]);

const scratch = new Uint16Array(4096);

/** Bits per entry from the data length (entries never span longs), falling back to the palette size. */
export function sectionBits(sec: ChunkSection): number {
  if (sec.data && sec.data.count > 0) return Math.floor(64 / Math.ceil(4096 / sec.data.count));
  return Math.max(4, Math.ceil(Math.log2(sec.palette.length)));
}

/** Convert one chunk section to tile palette indices. */
function convertSection(sec: ChunkSection, indexOf: (state: string) => number): Section {
  const pal = sec.palette;
  const map = new Uint16Array(pal.length);
  let allAir = true;
  for (let i = 0; i < pal.length; i++) {
    const s = pal[i]!;
    const idx = AIR_IDS.has(s) ? 0 : indexOf(s);
    map[i] = idx;
    if (idx !== 0) allAir = false;
  }
  if (allAir) return { kind: 0 };
  if (pal.length === 1 || !sec.data) return map[0] === 0 ? { kind: 0 } : { kind: 1, index: map[0]! };
  unpackLongs(sec.data, sectionBits(sec), 4096, scratch);
  const out = new Uint16Array(4096);
  const max = map.length - 1;
  let first = -1;
  let uniform = true;
  for (let i = 0; i < 4096; i++) {
    const li = scratch[i]!;
    const v = li <= max ? map[li]! : 0;
    out[i] = v;
    if (first < 0) first = v;
    else if (v !== first) uniform = false;
  }
  if (uniform) return first === 0 ? { kind: 0 } : { kind: 1, index: first };
  return { kind: 2, data: out };
}

/** Decoded tile, or null when none of the 16 chunk columns exist. */
export function buildTileData(store: RegionStore, tx: number, tz: number): DecodedTile | null {
  const palette: string[] = [AIR];
  const pmap = new Map<string, number>([[AIR, 0]]);
  const indexOf = (s: string): number => {
    let i = pmap.get(s);
    if (i === undefined) {
      i = palette.length;
      palette.push(s);
      pmap.set(s, i);
    }
    return i;
  };
  const cols: (Map<number, Section> | null)[] = new Array(16).fill(null);
  let any = false;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let lz = 0; lz < TILE_CHUNKS; lz++) {
    for (let lx = 0; lx < TILE_CHUNKS; lx++) {
      const nbt = store.readChunk(tx * TILE_CHUNKS + lx, tz * TILE_CHUNKS + lz);
      if (!nbt) continue;
      let chunk;
      try {
        chunk = parseChunk(nbt, { props: true });
      } catch (e) {
        console.warn(`[tiles] bad chunk ${tx * 4 + lx},${tz * 4 + lz}: ${(e as Error).message}`);
        continue;
      }
      any = true;
      const secs = new Map<number, Section>();
      for (const s of chunk.sections) {
        const conv = convertSection(s, indexOf);
        if (conv.kind === 0) continue;
        secs.set(s.y, conv);
        if (s.y < minY) minY = s.y;
        if (s.y > maxY) maxY = s.y;
      }
      cols[lz * 4 + lx] = secs;
    }
  }
  if (!any) return null;
  const minSectionY = Number.isFinite(minY) ? minY : 0;
  const numSections = Number.isFinite(minY) ? maxY - minY + 1 : 0;
  const AIR_SECTION: Section = { kind: 0 };
  const chunks = cols.map((m) => {
    if (!m) return null;
    const arr = new Array<Section>(numSections);
    for (let i = 0; i < numSections; i++) arr[i] = m.get(minSectionY + i) ?? AIR_SECTION;
    return arr;
  });
  return { tx, tz, minSectionY, numSections, palette, chunks };
}

/** Gzipped MCT1 blob, or null when the tile has no chunks. */
export function buildTile(store: RegionStore, tx: number, tz: number, level = 6): Uint8Array<ArrayBuffer> | null {
  const t = buildTileData(store, tx, tz);
  if (!t) return null;
  return Bun.gzipSync(encodeTile(t) as Uint8Array<ArrayBuffer>, { level: level as 6 });
}
