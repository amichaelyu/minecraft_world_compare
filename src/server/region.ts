// Anvil region file reader with an LRU of open file descriptors. Reads the 8 KiB header once per
// open, then each chunk's byte range on demand.

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, inflateSync } from "node:zlib";

const SECTOR = 4096;

/** Region dir for a world: 26.x layout first, then the classic one. */
export function findRegionDir(worldPath: string): string | null {
  for (const p of [join(worldPath, "dimensions", "minecraft", "overworld", "region"), join(worldPath, "region")]) {
    if (existsSync(p) && statSync(p).isDirectory()) return p;
  }
  return null;
}

/** List region coords present in a region dir (non-empty .mca files). */
export function listRegions(regionDir: string): { rx: number; rz: number; file: string }[] {
  const out: { rx: number; rz: number; file: string }[] = [];
  for (const f of readdirSync(regionDir)) {
    const m = /^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(f);
    if (!m) continue;
    const file = join(regionDir, f);
    if (statSync(file).size < 2 * SECTOR) continue;
    out.push({ rx: Number(m[1]), rz: Number(m[2]), file });
  }
  return out;
}

export function decompressChunk(type: number, payload: Uint8Array): Uint8Array | null {
  switch (type) {
    case 1:
      return gunzipSync(payload);
    case 2:
      return inflateSync(payload);
    case 3:
      return payload;
    default:
      return null; // 4 = lz4 (LZ4Block framing): not supported, chunk treated as absent
  }
}

export class RegionFile {
  readonly path: string;
  readonly rx: number;
  readonly rz: number;
  private fd: number;
  /** 1024 location entries: (sectorOffset << 8) | sectorCount, index = lz*32 + lx */
  readonly locations: Uint32Array;

  constructor(path: string, rx: number, rz: number) {
    this.path = path;
    this.rx = rx;
    this.rz = rz;
    this.fd = openSync(path, "r");
    const hdr = new Uint8Array(SECTOR);
    const n = readSync(this.fd, hdr, 0, SECTOR, 0);
    this.locations = new Uint32Array(1024);
    if (n === SECTOR) {
      const v = new DataView(hdr.buffer);
      for (let i = 0; i < 1024; i++) this.locations[i] = v.getUint32(i * 4);
    }
  }

  has(lx: number, lz: number): boolean {
    return this.locations[lz * 32 + lx]! !== 0;
  }

  /** Raw stored bytes of a chunk (compression type + payload), or null if absent. */
  readRaw(lx: number, lz: number): { type: number; payload: Uint8Array } | null {
    const loc = this.locations[lz * 32 + lx]!;
    if (loc === 0) return null;
    const off = (loc >>> 8) * SECTOR;
    const count = loc & 0xff;
    if (count === 0) return null;
    const buf = new Uint8Array(count * SECTOR);
    const n = readSync(this.fd, buf, 0, buf.length, off);
    if (n < 5) return null;
    const v = new DataView(buf.buffer);
    const len = v.getUint32(0);
    const type = buf[4]!;
    if (type & 0x80) {
      // oversized chunk stored externally as c.<x>.<z>.mcc next to the region file
      const cx = this.rx * 32 + lx;
      const cz = this.rz * 32 + lz;
      const ext = join(this.path, "..", `c.${cx}.${cz}.mcc`);
      if (!existsSync(ext)) return null;
      return { type: type & 0x7f, payload: new Uint8Array(readFileSync(ext)) };
    }
    if (len < 1 || 4 + len > n) return null;
    return { type, payload: buf.subarray(5, 4 + len) };
  }

  /** Decompressed chunk NBT, or null if absent/unsupported. */
  readChunk(lx: number, lz: number): Uint8Array | null {
    const raw = this.readRaw(lx, lz);
    if (!raw) return null;
    try {
      return decompressChunk(raw.type, raw.payload);
    } catch {
      return null;
    }
  }

  close(): void {
    if (this.fd >= 0) closeSync(this.fd);
    this.fd = -1;
  }
}

/** Per-world region access: LRU of open RegionFiles keyed by (rx, rz). */
export class RegionStore {
  readonly dir: string;
  private readonly maxOpen: number;
  private readonly present = new Map<string, string>();
  private readonly open = new Map<string, RegionFile>();

  constructor(dir: string, maxOpen = 16) {
    this.dir = dir;
    this.maxOpen = maxOpen;
    for (const r of listRegions(dir)) this.present.set(`${r.rx},${r.rz}`, r.file);
  }

  regions(): { rx: number; rz: number }[] {
    return [...this.present.keys()].map((k) => {
      const [rx, rz] = k.split(",").map(Number);
      return { rx: rx!, rz: rz! };
    });
  }

  hasRegion(rx: number, rz: number): boolean {
    return this.present.has(`${rx},${rz}`);
  }

  get(rx: number, rz: number): RegionFile | null {
    const key = `${rx},${rz}`;
    const hit = this.open.get(key);
    if (hit) {
      this.open.delete(key);
      this.open.set(key, hit);
      return hit;
    }
    const file = this.present.get(key);
    if (!file) return null;
    const rf = new RegionFile(file, rx, rz);
    this.open.set(key, rf);
    while (this.open.size > this.maxOpen) {
      const oldest = this.open.keys().next().value as string;
      this.open.get(oldest)!.close();
      this.open.delete(oldest);
    }
    return rf;
  }

  /** Decompressed NBT for chunk (cx, cz) in world chunk coords. */
  readChunk(cx: number, cz: number): Uint8Array | null {
    const rf = this.get(cx >> 5, cz >> 5);
    return rf ? rf.readChunk(cx & 31, cz & 31) : null;
  }

  closeAll(): void {
    for (const rf of this.open.values()) rf.close();
    this.open.clear();
  }
}
