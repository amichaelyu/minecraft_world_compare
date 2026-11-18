// Fast big-endian NBT reader. Skips subtrees it doesn't need; parseChunk only materialises
// yPos/xPos/zPos/Status, sections[].{Y, block_states} and Heightmaps.MOTION_BLOCKING.

export const TAG_END = 0;
export const TAG_BYTE = 1;
export const TAG_SHORT = 2;
export const TAG_INT = 3;
export const TAG_LONG = 4;
export const TAG_FLOAT = 5;
export const TAG_DOUBLE = 6;
export const TAG_BYTE_ARRAY = 7;
export const TAG_STRING = 8;
export const TAG_LIST = 9;
export const TAG_COMPOUND = 10;
export const TAG_INT_ARRAY = 11;
export const TAG_LONG_ARRAY = 12;

const FIXED_SIZE = [0, 1, 2, 4, 8, 4, 8]; // payload size for END..DOUBLE

const utf8 = new TextDecoder();

export class NbtReader {
  readonly buf: Uint8Array;
  readonly view: DataView;
  pos = 0;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  u8(): number {
    return this.buf[this.pos++]!;
  }
  i8(): number {
    return (this.buf[this.pos++]! << 24) >> 24;
  }
  i16(): number {
    const v = this.view.getInt16(this.pos);
    this.pos += 2;
    return v;
  }
  u16(): number {
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }
  i32(): number {
    const v = this.view.getInt32(this.pos);
    this.pos += 4;
    return v;
  }

  /** Modified UTF-8 string; ASCII fast path. */
  string(): string {
    const len = this.u16();
    const start = this.pos;
    const end = start + len;
    this.pos = end;
    const b = this.buf;
    if (len < 64) {
      let s = "";
      for (let i = start; i < end; i++) {
        const c = b[i]!;
        if (c >= 0x80) return utf8.decode(b.subarray(start, end));
        s += String.fromCharCode(c);
      }
      return s;
    }
    return utf8.decode(b.subarray(start, end));
  }

  skipString(): void {
    const n = this.u16();
    this.pos += n;
  }

  /** Skip the payload of a tag of the given type. */
  skip(type: number): void {
    switch (type) {
      case TAG_END:
        return;
      case TAG_BYTE:
      case TAG_SHORT:
      case TAG_INT:
      case TAG_LONG:
      case TAG_FLOAT:
      case TAG_DOUBLE:
        this.pos += FIXED_SIZE[type]!;
        return;
      case TAG_BYTE_ARRAY: {
        const n = this.i32(); // read before adding: `pos += i32()` would use the stale pos
        this.pos += n;
        return;
      }
      case TAG_STRING:
        this.skipString();
        return;
      case TAG_LIST: {
        const et = this.u8();
        const n = this.i32();
        if (n <= 0) return;
        if (et >= TAG_BYTE && et <= TAG_DOUBLE) {
          this.pos += n * FIXED_SIZE[et]!;
          return;
        }
        for (let i = 0; i < n; i++) this.skip(et);
        return;
      }
      case TAG_COMPOUND:
        for (;;) {
          const t = this.u8();
          if (t === TAG_END) return;
          this.skipString(); // name
          this.skip(t);
        }
      case TAG_INT_ARRAY: {
        const n = this.i32();
        this.pos += n * 4;
        return;
      }
      case TAG_LONG_ARRAY: {
        const n = this.i32();
        this.pos += n * 8;
        return;
      }
      default:
        throw new Error(`bad NBT tag type ${type} at ${this.pos}`);
    }
  }

  /** Generic materialisation (for level.dat etc.). Longs become bigint, long arrays BigInt64Array. */
  value(type: number): unknown {
    switch (type) {
      case TAG_BYTE:
        return this.i8();
      case TAG_SHORT:
        return this.i16();
      case TAG_INT:
        return this.i32();
      case TAG_LONG: {
        const v = this.view.getBigInt64(this.pos);
        this.pos += 8;
        return v;
      }
      case TAG_FLOAT: {
        const v = this.view.getFloat32(this.pos);
        this.pos += 4;
        return v;
      }
      case TAG_DOUBLE: {
        const v = this.view.getFloat64(this.pos);
        this.pos += 8;
        return v;
      }
      case TAG_BYTE_ARRAY: {
        const n = this.i32();
        const v = this.buf.slice(this.pos, this.pos + n);
        this.pos += n;
        return v;
      }
      case TAG_STRING:
        return this.string();
      case TAG_LIST: {
        const et = this.u8();
        const n = this.i32();
        const out: unknown[] = [];
        for (let i = 0; i < n; i++) out.push(this.value(et));
        return out;
      }
      case TAG_COMPOUND: {
        const out: Record<string, unknown> = {};
        for (;;) {
          const t = this.u8();
          if (t === TAG_END) return out;
          const name = this.string();
          out[name] = this.value(t);
        }
      }
      case TAG_INT_ARRAY: {
        const n = this.i32();
        const v = new Int32Array(n);
        for (let i = 0; i < n; i++) v[i] = this.i32();
        return v;
      }
      case TAG_LONG_ARRAY: {
        const n = this.i32();
        const v = new BigInt64Array(n);
        for (let i = 0; i < n; i++) {
          v[i] = this.view.getBigInt64(this.pos);
          this.pos += 8;
        }
        return v;
      }
      default:
        throw new Error(`bad NBT tag type ${type} at ${this.pos}`);
    }
  }
}

/** Parse a whole NBT document (root compound) into plain JS objects. */
export function parseNbt(buf: Uint8Array): Record<string, unknown> {
  const r = new NbtReader(buf);
  const t = r.u8();
  if (t !== TAG_COMPOUND) throw new Error(`NBT root is tag ${t}, expected compound`);
  r.skipString();
  return r.value(TAG_COMPOUND) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------
// Chunk-specific parser

/** A long array left in place in the decompressed buffer: `count` big-endian longs at `off`. */
export interface LongArrayRef {
  view: DataView;
  off: number;
  count: number;
}

export interface ChunkSection {
  y: number;
  /** canonical block state strings (or bare names when parsed with names-only) */
  palette: string[];
  data: LongArrayRef | null;
}

export interface ChunkData {
  xPos: number;
  zPos: number;
  yPos: number;
  status: string;
  sections: ChunkSection[];
  /** present in only ~40% of sf chunks (edited chunks drop Heightmaps), so LOD scans sections instead */
  motionBlocking: LongArrayRef | null;
}

export interface ParseChunkOptions {
  /** include block state properties in palette strings (needed for tiles, not for LOD colours) */
  props: boolean;
  /** skip sections entirely (heightmap-only reads) */
  sections?: boolean;
}

function readLongArrayRef(r: NbtReader): LongArrayRef {
  const count = r.i32();
  const ref = { view: r.view, off: r.pos, count };
  r.pos += count * 8;
  return ref;
}

/** Read a block_states palette entry compound {Name, Properties?} as a canonical string. */
function readPaletteEntry(r: NbtReader, props: boolean): string {
  let name = "";
  let keys: string[] | null = null;
  let vals: string[] | null = null;
  for (;;) {
    const t = r.u8();
    if (t === TAG_END) break;
    const key = r.string();
    if (t === TAG_STRING && key === "Name") {
      name = r.string();
    } else if (props && t === TAG_COMPOUND && key === "Properties") {
      keys = [];
      vals = [];
      for (;;) {
        const pt = r.u8();
        if (pt === TAG_END) break;
        const pk = r.string();
        if (pt === TAG_STRING) {
          keys.push(pk);
          vals.push(r.string());
        } else r.skip(pt);
      }
    } else r.skip(t);
  }
  if (!keys || keys.length === 0) return name;
  if (keys.length === 1) return `${name}[${keys[0]}=${vals![0]}]`;
  const order = keys.map((_, i) => i).sort((a, b) => (keys![a]! < keys![b]! ? -1 : keys![a]! > keys![b]! ? 1 : 0));
  let s = name + "[";
  for (let i = 0; i < order.length; i++) {
    if (i) s += ",";
    s += keys[order[i]!] + "=" + vals![order[i]!];
  }
  return s + "]";
}

function readSection(r: NbtReader, props: boolean): ChunkSection | null {
  let y = -9999;
  let palette: string[] | null = null;
  let data: LongArrayRef | null = null;
  for (;;) {
    const t = r.u8();
    if (t === TAG_END) break;
    const key = r.string();
    if (key === "Y" && t === TAG_BYTE) y = r.i8();
    else if (key === "Y" && t === TAG_INT) y = r.i32();
    else if (key === "block_states" && t === TAG_COMPOUND) {
      for (;;) {
        const bt = r.u8();
        if (bt === TAG_END) break;
        const bk = r.string();
        if (bk === "palette" && bt === TAG_LIST) {
          const et = r.u8();
          const n = r.i32();
          if (et !== TAG_COMPOUND) {
            for (let i = 0; i < n; i++) r.skip(et);
            continue;
          }
          palette = new Array<string>(n);
          for (let i = 0; i < n; i++) palette[i] = readPaletteEntry(r, props);
        } else if (bk === "data" && bt === TAG_LONG_ARRAY) {
          data = readLongArrayRef(r);
        } else r.skip(bt);
      }
    } else r.skip(t);
  }
  if (palette === null || palette.length === 0 || y === -9999) return null;
  return { y, palette, data };
}

export function parseChunk(buf: Uint8Array, opts: ParseChunkOptions): ChunkData {
  const r = new NbtReader(buf);
  const rootType = r.u8();
  if (rootType !== TAG_COMPOUND) throw new Error("chunk root is not a compound");
  r.skipString();
  const out: ChunkData = { xPos: 0, zPos: 0, yPos: 0, status: "", sections: [], motionBlocking: null };
  const wantSections = opts.sections !== false;
  for (;;) {
    const t = r.u8();
    if (t === TAG_END) break;
    const key = r.string();
    switch (key) {
      case "xPos":
        if (t === TAG_INT) out.xPos = r.i32();
        else r.skip(t);
        break;
      case "zPos":
        if (t === TAG_INT) out.zPos = r.i32();
        else r.skip(t);
        break;
      case "yPos":
        if (t === TAG_INT) out.yPos = r.i32();
        else r.skip(t);
        break;
      case "Status":
        if (t === TAG_STRING) out.status = r.string();
        else r.skip(t);
        break;
      case "sections":
        if (t === TAG_LIST && wantSections) {
          const et = r.u8();
          const n = r.i32();
          if (et !== TAG_COMPOUND) {
            for (let i = 0; i < n; i++) r.skip(et);
            break;
          }
          for (let i = 0; i < n; i++) {
            const s = readSection(r, opts.props);
            if (s) out.sections.push(s);
          }
        } else r.skip(t);
        break;
      case "Heightmaps":
        if (t === TAG_COMPOUND) {
          for (;;) {
            const ht = r.u8();
            if (ht === TAG_END) break;
            const hk = r.string();
            if (hk === "MOTION_BLOCKING" && ht === TAG_LONG_ARRAY) out.motionBlocking = readLongArrayRef(r);
            else r.skip(ht);
          }
        } else r.skip(t);
        break;
      default:
        r.skip(t);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Packed long arrays (1.16+ layout: entries never span two longs; entry k at bits (k%per)*bits)

/** Unpack `n` entries of `bits` bits each into out. */
export function unpackLongs(ref: LongArrayRef, bits: number, n: number, out: Uint16Array | Int32Array): void {
  const per = Math.floor(64 / bits);
  const mask = (1 << bits) - 1;
  const v = ref.view;
  let o = ref.off;
  let k = 0;
  const longs = Math.min(ref.count, Math.ceil(n / per));
  for (let li = 0; li < longs; li++, o += 8) {
    const hi = v.getUint32(o);
    const lo = v.getUint32(o + 4);
    for (let j = 0, pos = 0; j < per && k < n; j++, pos += bits, k++) {
      let x: number;
      if (pos + bits <= 32) x = lo >>> pos;
      else if (pos >= 32) x = hi >>> (pos - 32);
      else x = (lo >>> pos) | (hi << (32 - pos));
      out[k] = x & mask;
    }
  }
  for (; k < n; k++) out[k] = 0;
}
