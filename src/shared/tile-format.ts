// MCT1 tile blob format (and the MCL1 LOD blob). Implementation owned by the
// server side; decodeTile is used by the client mesher. All multi-byte fields are little-endian.

export const TILE_MAGIC = 0x3154434d; // 'MCT1'
export const LOD_MAGIC = 0x314c434d; // 'MCL1'
export const AIR = "minecraft:air";

export type Section =
  | { kind: 0 } // all air
  | { kind: 1; index: number } // uniform
  | { kind: 2; data: Uint16Array }; // 4096 palette indices, i = y*256 + z*16 + x

export interface DecodedTile {
  tx: number;
  tz: number;
  minSectionY: number;
  numSections: number;
  palette: string[]; // palette[0] === "minecraft:air"
  /** 16 entries, index = lz*4 + lx; null when the chunk is absent */
  chunks: (Section[] | null)[];
}

const SECTION_VOLUME = 4096;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const LE_HOST = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Canonical block state string: properties sorted by key, no brackets when there are none. */
export function canonicalState(name: string, props?: Record<string, string> | null): string {
  if (!props) return name;
  const keys = Object.keys(props).sort();
  if (keys.length === 0) return name;
  return `${name}[${keys.map((k) => `${k}=${props[k]}`).join(",")}]`;
}

/** Parse a canonical block state string back into name + properties. */
export function parseState(state: string): { name: string; props: Record<string, string> } {
  const b = state.indexOf("[");
  if (b < 0) return { name: state, props: {} };
  const props: Record<string, string> = {};
  for (const kv of state.slice(b + 1, -1).split(",")) {
    const e = kv.indexOf("=");
    if (e > 0) props[kv.slice(0, e)] = kv.slice(e + 1);
  }
  return { name: state.slice(0, b), props };
}

/** Block id without properties. */
export function stateName(state: string): string {
  const b = state.indexOf("[");
  return b < 0 ? state : state.slice(0, b);
}

export function encodeTile(tile: DecodedTile): Uint8Array {
  if (tile.palette[0] !== AIR) throw new Error("palette[0] must be minecraft:air");
  if (tile.chunks.length !== 16) throw new Error("tile must have 16 chunks");
  const names = tile.palette.map((s) => textEncoder.encode(s));
  let size = 4 + 4 + 4 + 2 + 2 + 4;
  for (const n of names) size += 2 + n.length;
  for (const c of tile.chunks) {
    size += 1;
    if (!c) continue;
    if (c.length !== tile.numSections) throw new Error("chunk section count != numSections");
    for (const s of c) size += s.kind === 0 ? 1 : s.kind === 1 ? 3 : 1 + SECTION_VOLUME * 2;
  }
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  let o = 0;
  v.setUint32(o, TILE_MAGIC, true);
  v.setInt32(o + 4, tile.tx, true);
  v.setInt32(o + 8, tile.tz, true);
  v.setInt16(o + 12, tile.minSectionY, true);
  v.setUint16(o + 14, tile.numSections, true);
  v.setUint32(o + 16, names.length, true);
  o = 20;
  for (const n of names) {
    v.setUint16(o, n.length, true);
    out.set(n, o + 2);
    o += 2 + n.length;
  }
  for (const c of tile.chunks) {
    if (!c) {
      out[o++] = 0;
      continue;
    }
    out[o++] = 1;
    for (const s of c) {
      out[o++] = s.kind;
      if (s.kind === 1) {
        v.setUint16(o, s.index, true);
        o += 2;
      } else if (s.kind === 2) {
        const d = s.data;
        if (LE_HOST) out.set(new Uint8Array(d.buffer, d.byteOffset, SECTION_VOLUME * 2), o);
        else for (let i = 0; i < SECTION_VOLUME; i++) v.setUint16(o + i * 2, d[i]!, true);
        o += SECTION_VOLUME * 2;
      }
    }
  }
  return out;
}

export function decodeTile(buf: ArrayBuffer): DecodedTile {
  const v = new DataView(buf);
  const bytes = new Uint8Array(buf);
  if (v.getUint32(0, true) !== TILE_MAGIC) throw new Error("not an MCT1 tile");
  const tx = v.getInt32(4, true);
  const tz = v.getInt32(8, true);
  const minSectionY = v.getInt16(12, true);
  const numSections = v.getUint16(14, true);
  const paletteCount = v.getUint32(16, true);
  let o = 20;
  const palette = new Array<string>(paletteCount);
  for (let i = 0; i < paletteCount; i++) {
    const len = v.getUint16(o, true);
    palette[i] = textDecoder.decode(bytes.subarray(o + 2, o + 2 + len));
    o += 2 + len;
  }
  const chunks: (Section[] | null)[] = new Array(16);
  for (let c = 0; c < 16; c++) {
    if (bytes[o++] === 0) {
      chunks[c] = null;
      continue;
    }
    const secs = new Array<Section>(numSections);
    for (let s = 0; s < numSections; s++) {
      const kind = bytes[o++];
      if (kind === 0) secs[s] = { kind: 0 };
      else if (kind === 1) {
        secs[s] = { kind: 1, index: v.getUint16(o, true) };
        o += 2;
      } else if (kind === 2) {
        let data: Uint16Array;
        if (LE_HOST) data = new Uint16Array(buf.slice(o, o + SECTION_VOLUME * 2));
        else {
          data = new Uint16Array(SECTION_VOLUME);
          for (let i = 0; i < SECTION_VOLUME; i++) data[i] = v.getUint16(o + i * 2, true);
        }
        secs[s] = { kind: 2, data };
        o += SECTION_VOLUME * 2;
      } else throw new Error(`bad section kind ${kind}`);
    }
    chunks[c] = secs;
  }
  return { tx, tz, minSectionY, numSections, palette, chunks };
}

// ---------------------------------------------------------------------------------------------
// MCL1 LOD heightfield tiles

export const LOD_TILE_CELLS = 128;
export const LOD_HEADER_BYTES = 13; // u32 magic, u8 L, i32 tx, i32 tz
const LOD_N = LOD_TILE_CELLS * LOD_TILE_CELLS;

export interface DecodedLod {
  level: number;
  tx: number;
  tz: number;
  /** 128*128, i = cz*128 + cx; -32768 = no data */
  heights: Int16Array;
  /** 128*128*4 RGBA8; alpha 0 = no data */
  colors: Uint8Array;
}

export function encodeLod(lod: DecodedLod): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(LOD_HEADER_BYTES + LOD_N * 2 + LOD_N * 4);
  const v = new DataView(out.buffer);
  v.setUint32(0, LOD_MAGIC, true);
  out[4] = lod.level;
  v.setInt32(5, lod.tx, true);
  v.setInt32(9, lod.tz, true);
  let o = LOD_HEADER_BYTES;
  for (let i = 0; i < LOD_N; i++, o += 2) v.setInt16(o, lod.heights[i]!, true);
  out.set(lod.colors.subarray(0, LOD_N * 4), o);
  return out;
}

/** Decode an (uncompressed) MCL1 blob. Copies the arrays out (the i16 block sits at an odd offset). */
export function decodeLod(buf: ArrayBuffer): DecodedLod {
  const v = new DataView(buf);
  if (v.getUint32(0, true) !== LOD_MAGIC) throw new Error("not an MCL1 LOD tile");
  const level = new Uint8Array(buf)[4]!;
  const tx = v.getInt32(5, true);
  const tz = v.getInt32(9, true);
  const heights = new Int16Array(LOD_N);
  let o = LOD_HEADER_BYTES;
  for (let i = 0; i < LOD_N; i++, o += 2) heights[i] = v.getInt16(o, true);
  const colors = new Uint8Array(buf.slice(o, o + LOD_N * 4));
  return { level, tx, tz, heights, colors };
}
