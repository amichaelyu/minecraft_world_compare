// LOD level 0..2 from chunk data, colour table, and 2x2 downsampling. Pure functions shared by
// the server process and the LOD worker. Format: src/shared/tile-format.ts (MCL1).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LOD_CELLS, LOD_NO_DATA } from "../shared/api.ts";
import { encodeLod, stateName } from "../shared/tile-format.ts";
import { parseChunk, unpackLongs } from "./nbt.ts";
import type { RegionStore } from "./region.ts";
import { sectionBits } from "./tiles.ts";
import { CACHE_DIR } from "./worlds.ts";

export const REGION_BLOCKS = 512;
/** Levels built directly from a region's 512x512 top-block grid (tile size 128 << L <= 512). */
export const REGION_LEVELS = 3;
const N = LOD_CELLS * LOD_CELLS;

/** Blocks the top-block scan sees through. */
const EMPTY = new Set([
  "minecraft:air",
  "minecraft:cave_air",
  "minecraft:void_air",
  "minecraft:light",
  "minecraft:barrier",
  "minecraft:structure_void",
]);

// ---------------------------------------------------------------------------------------------
// Colours

const FALLBACK_VERSION = 1;
const WATER: [number, number, number] = [63, 100, 200];

const HAND: Record<string, [number, number, number]> = {
  water: WATER,
  seagrass: WATER,
  tall_seagrass: WATER,
  kelp: WATER,
  kelp_plant: WATER,
  bubble_column: WATER,
  lava: [207, 92, 15],
  grass_block: [110, 160, 70],
  short_grass: [100, 150, 60],
  tall_grass: [100, 150, 60],
  fern: [90, 140, 60],
  moss_block: [90, 110, 45],
  stone: [125, 125, 125],
  smooth_stone: [160, 160, 160],
  cobblestone: [120, 120, 120],
  andesite: [136, 136, 137],
  polished_andesite: [132, 135, 134],
  diorite: [188, 188, 188],
  granite: [150, 105, 90],
  deepslate: [80, 80, 82],
  gravel: [130, 125, 123],
  sand: [219, 207, 163],
  red_sand: [190, 102, 33],
  sandstone: [216, 203, 155],
  dirt: [134, 96, 67],
  coarse_dirt: [119, 85, 59],
  rooted_dirt: [144, 103, 76],
  mud: [60, 57, 60],
  podzol: [91, 63, 24],
  dirt_path: [148, 121, 65],
  farmland: [110, 75, 45],
  clay: [160, 166, 179],
  snow: [249, 254, 254],
  snow_block: [249, 254, 254],
  ice: [145, 183, 253],
  packed_ice: [141, 180, 250],
  oak_leaves: [60, 120, 40],
  birch_leaves: [100, 140, 60],
  spruce_leaves: [50, 90, 50],
  jungle_leaves: [50, 130, 30],
  acacia_leaves: [80, 120, 30],
  dark_oak_leaves: [45, 100, 25],
  mangrove_leaves: [70, 120, 30],
  cherry_leaves: [230, 170, 190],
  azalea_leaves: [90, 115, 45],
  bricks: [150, 74, 58],
  stone_bricks: [122, 121, 122],
  quartz_block: [235, 229, 222],
  smooth_quartz: [235, 229, 222],
  glass: [175, 210, 220],
  iron_block: [220, 220, 220],
  bedrock: [85, 85, 85],
  obsidian: [20, 18, 30],
  netherrack: [98, 38, 38],
  rail: [125, 110, 90],
  powered_rail: [140, 110, 70],
  black_concrete: [8, 10, 15],
};

const DYES: Record<string, [number, number, number]> = {
  white: [233, 236, 236],
  orange: [240, 118, 19],
  magenta: [189, 68, 179],
  light_blue: [58, 175, 217],
  yellow: [248, 197, 39],
  lime: [112, 185, 25],
  pink: [237, 141, 172],
  gray: [62, 68, 71],
  light_gray: [142, 142, 134],
  cyan: [21, 137, 145],
  purple: [121, 42, 172],
  blue: [53, 57, 157],
  brown: [114, 71, 40],
  green: [84, 109, 27],
  red: [160, 39, 34],
  black: [20, 21, 25],
};
const DYE_NAMES = Object.keys(DYES).sort((a, b) => b.length - a.length); // light_gray before gray

const WOODS: Record<string, [number, number, number]> = {
  oak: [162, 130, 78],
  spruce: [114, 84, 48],
  birch: [196, 179, 123],
  jungle: [160, 115, 80],
  acacia: [168, 90, 50],
  dark_oak: [66, 43, 20],
  mangrove: [117, 54, 48],
  cherry: [226, 178, 172],
  bamboo: [194, 173, 80],
  crimson: [101, 48, 70],
  warped: [43, 104, 99],
  pale_oak: [228, 218, 216],
};
const WOOD_NAMES = Object.keys(WOODS).sort((a, b) => b.length - a.length);

function hashColour(id: string): [number, number, number] {
  const h = Bun.hash.crc32(id);
  const hue = (h % 360) / 360;
  const sat = 0.25 + ((h >>> 9) % 25) / 100;
  const lig = 0.45 + ((h >>> 17) % 20) / 100;
  const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat;
  const p = 2 * lig - q;
  const f = (t: number) => {
    t = (t + 1) % 1;
    const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    return Math.round(v * 255);
  };
  return [f(hue + 1 / 3), f(hue), f(hue - 1 / 3)];
}

/** Heuristic colour from the block id when the asset table has none. */
export function fallbackColour(id: string): [number, number, number] {
  const n = id.startsWith("minecraft:") ? id.slice(10) : id;
  const hand = HAND[n];
  if (hand) return hand;
  if (n.includes("water")) return WATER;
  for (const d of DYE_NAMES) if (n.startsWith(d + "_")) return DYES[d]!;
  if (n.includes("leaves")) return HAND.oak_leaves!;
  for (const w of WOOD_NAMES) if (n.startsWith(w + "_")) return WOODS[w]!;
  const base = n.replace(/_(stairs|slab|wall|fence|fence_gate|door|trapdoor|pressure_plate|button)$/, "");
  if (HAND[base]) return HAND[base]!;
  if (HAND[base + "s"]) return HAND[base + "s"]!;
  if (n.includes("deepslate")) return HAND.deepslate!;
  if (n.includes("sandstone")) return HAND.sandstone!;
  if (n.includes("stone") || n.includes("cobble")) return HAND.stone!;
  if (n.includes("brick")) return HAND.bricks!;
  if (n.includes("quartz")) return HAND.quartz_block!;
  if (n.includes("glass")) return HAND.glass!;
  if (n.includes("copper")) return [192, 107, 79];
  if (n.includes("iron")) return HAND.iron_block!;
  return hashColour(id);
}

export class ColourTable {
  private readonly table: Record<string, [number, number, number]>;
  readonly fingerprint: string;
  private readonly cache = new Map<string, number>();

  constructor(table: Record<string, [number, number, number]> | null) {
    this.table = table ?? {};
    const src = table ? Bun.hash.crc32(JSON.stringify(table)).toString(16) : "none";
    this.fingerprint = `fallback-v${FALLBACK_VERSION};assets-${src}`;
  }

  /** Packed little-endian RGBA (alpha 255) for a block state or id. */
  rgba(state: string): number {
    let v = this.cache.get(state);
    if (v !== undefined) return v;
    const id = stateName(state);
    let c = this.table[id];
    if (id === "minecraft:seagrass" || id === "minecraft:tall_seagrass" || id === "minecraft:kelp" || id === "minecraft:kelp_plant" || id === "minecraft:bubble_column")
      c = this.table["minecraft:water"] ?? WATER;
    c ??= fallbackColour(id);
    v = ((c[0] & 255) | ((c[1] & 255) << 8) | ((c[2] & 255) << 16) | (255 << 24)) >>> 0;
    this.cache.set(state, v);
    return v;
  }
}

let colourTable: ColourTable | null = null;

/** Colours from cache/assets/assets.json `colors` when present, else the fallback heuristics. */
export function loadColours(): ColourTable {
  if (colourTable) return colourTable;
  const f = join(CACHE_DIR, "assets", "assets.json");
  let table: Record<string, [number, number, number]> | null = null;
  if (existsSync(f)) {
    try {
      const j = JSON.parse(readFileSync(f, "utf8")) as { colors?: Record<string, [number, number, number]> };
      if (j.colors && Object.keys(j.colors).length > 0) table = j.colors;
    } catch (e) {
      console.warn(`[lod] could not read ${f}: ${(e as Error).message}`);
    }
  }
  colourTable = new ColourTable(table);
  return colourTable;
}

// ---------------------------------------------------------------------------------------------
// Grids

/** A square grid of cells: heights (LOD_NO_DATA = none) and packed RGBA colours (0 = none). */
export interface Grid {
  size: number;
  heights: Int16Array;
  colors: Uint32Array;
}

export function newGrid(size: number): Grid {
  const g = { size, heights: new Int16Array(size * size), colors: new Uint32Array(size * size) };
  g.heights.fill(LOD_NO_DATA);
  return g;
}

/** Top non-air block per column for a whole region, computed from the sections (heightmaps are unreliable). */
export function regionTopGrid(store: RegionStore, rx: number, rz: number, colours: ColourTable): { grid: Grid; chunks: number } {
  const grid = newGrid(REGION_BLOCKS);
  const rf = store.get(rx, rz);
  if (!rf) return { grid, chunks: 0 };
  const idx = new Uint16Array(4096);
  const done = new Uint8Array(256);
  let chunks = 0;
  for (let lz = 0; lz < 32; lz++) {
    for (let lx = 0; lx < 32; lx++) {
      if (!rf.has(lx, lz)) continue;
      const nbt = rf.readChunk(lx, lz);
      if (!nbt) continue;
      let chunk;
      try {
        chunk = parseChunk(nbt, { props: false });
      } catch {
        continue;
      }
      chunks++;
      done.fill(0);
      let remaining = 256;
      const secs = chunk.sections.sort((a, b) => b.y - a.y);
      const ox = lx * 16;
      const oz = lz * 16;
      for (const sec of secs) {
        if (remaining === 0) break;
        const pal = sec.palette;
        const empty = new Uint8Array(pal.length);
        let allEmpty = true;
        for (let i = 0; i < pal.length; i++) {
          empty[i] = EMPTY.has(pal[i]!) ? 1 : 0;
          if (!empty[i]) allEmpty = false;
        }
        if (allEmpty) continue;
        const baseY = sec.y * 16;
        if (pal.length === 1 || !sec.data) {
          if (empty[0]) continue;
          const col = colours.rgba(pal[0]!);
          for (let c = 0; c < 256; c++) {
            if (done[c]) continue;
            const g = (oz + (c >> 4)) * REGION_BLOCKS + ox + (c & 15);
            grid.heights[g] = baseY + 15;
            grid.colors[g] = col;
            done[c] = 1;
          }
          remaining = 0;
          continue;
        }
        unpackLongs(sec.data, sectionBits(sec), 4096, idx);
        const max = pal.length - 1;
        for (let c = 0; c < 256; c++) {
          if (done[c]) continue;
          for (let y = 15; y >= 0; y--) {
            const p = idx[y * 256 + c]!;
            if (p > max || empty[p]) continue;
            const g = (oz + (c >> 4)) * REGION_BLOCKS + ox + (c & 15);
            grid.heights[g] = baseY + y;
            grid.colors[g] = colours.rgba(pal[p]!);
            done[c] = 1;
            remaining--;
            break;
          }
        }
      }
    }
  }
  return { grid, chunks };
}

/** 2x2 downsample: max height and mean colour over present cells. */
export function down2(src: Grid): Grid {
  const n = src.size >> 1;
  const out = newGrid(n);
  downInto(src, out, 0, 0);
  return out;
}

/** Downsample src (size 2m) into the m x m block of dst at (ox, oz). */
export function downInto(src: Grid, dst: Grid, ox: number, oz: number): void {
  const s = src.size;
  const m = s >> 1;
  const sh = src.heights;
  const sc = src.colors;
  for (let z = 0; z < m; z++) {
    for (let x = 0; x < m; x++) {
      let h = LOD_NO_DATA;
      let r = 0, g = 0, b = 0, n = 0;
      const i0 = 2 * z * s + 2 * x;
      for (let k = 0; k < 4; k++) {
        const i = i0 + (k & 1) + (k >> 1) * s;
        const c = sc[i]!;
        if (c >>> 24 === 0) continue;
        if (sh[i]! > h) h = sh[i]!;
        r += c & 255;
        g += (c >>> 8) & 255;
        b += (c >>> 16) & 255;
        n++;
      }
      if (n === 0) continue;
      const d = (oz + z) * dst.size + ox + x;
      dst.heights[d] = h;
      dst.colors[d] = (Math.round(r / n) | (Math.round(g / n) << 8) | (Math.round(b / n) << 16) | (255 << 24)) >>> 0;
    }
  }
}

/** Copy a 128x128 window out of a larger grid. */
export function window(src: Grid, ox: number, oz: number): Grid {
  const out = newGrid(LOD_CELLS);
  for (let z = 0; z < LOD_CELLS; z++) {
    const s = (oz + z) * src.size + ox;
    out.heights.set(src.heights.subarray(s, s + LOD_CELLS), z * LOD_CELLS);
    out.colors.set(src.colors.subarray(s, s + LOD_CELLS), z * LOD_CELLS);
  }
  return out;
}

export function gridEmpty(g: Grid): boolean {
  for (let i = 0; i < g.colors.length; i++) if (g.colors[i] !== 0) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Cache files

export function lodCacheRoot(worldId: string): string {
  return join(CACHE_DIR, "lod", worldId);
}

export function lodPath(root: string, L: number, tx: number, tz: number): string {
  return join(root, String(L), String(tx), `${tz}.bin`);
}

/** Gzipped MCL1 bytes for a 128x128 grid, or null when it has no data. */
export function lodBlob(L: number, tx: number, tz: number, g: Grid): Uint8Array<ArrayBuffer> | null {
  if (gridEmpty(g)) return null;
  const raw = encodeLod({ level: L, tx, tz, heights: g.heights, colors: new Uint8Array(g.colors.buffer, g.colors.byteOffset, N * 4) });
  return Bun.gzipSync(raw, { level: 6 });
}

/** Write a cache entry; empty tiles are stored as zero-byte files. */
export function writeLod(root: string, L: number, tx: number, tz: number, blob: Uint8Array | null): void {
  const p = lodPath(root, L, tx, tz);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, blob ?? new Uint8Array(0));
}

/** Build and cache LOD levels 0..2 for one region. */
export function buildRegionLods(store: RegionStore, root: string, rx: number, rz: number, colours: ColourTable): { chunks: number } {
  const { grid, chunks } = regionTopGrid(store, rx, rz, colours);
  let g = grid;
  for (let L = 0; L < REGION_LEVELS; L++) {
    if (L > 0) g = down2(g);
    const per = REGION_BLOCKS >> (7 + L); // tiles per region side at this level
    for (let tz = 0; tz < per; tz++) {
      for (let tx = 0; tx < per; tx++) {
        const w = window(g, tx * LOD_CELLS, tz * LOD_CELLS);
        writeLod(root, L, rx * per + tx, rz * per + tz, lodBlob(L, rx * per + tx, rz * per + tz, w));
      }
    }
  }
  return { chunks };
}
