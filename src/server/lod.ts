// MCL1 LOD tiles: on-demand builder with a disk cache and a worker pool, plus a prebuild CLI:
//   bun run src/server/lod.ts --world sf --prebuild [--force]
// Levels 0..2 are built per region (512x512 blocks) in workers; levels >= 3 are composed from
// the four children one level down.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOD_CELLS } from "../shared/api.ts";
import { decodeLod } from "../shared/tile-format.ts";
import {
  REGION_LEVELS,
  downInto,
  loadColours,
  lodBlob,
  lodCacheRoot,
  lodPath,
  newGrid,
  writeLod,
  type Grid,
} from "./lod-core.ts";
import type { RegionJob, RegionJobResult } from "./lod-worker.ts";
import { getWorlds, type ServerWorld } from "./worlds.ts";

/** Bump when the LOD algorithm changes so stale caches are discarded. */
const LOD_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// Worker pool

class RegionPool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: { job: Omit<RegionJob, "id">; resolve: (r: RegionJobResult) => void }[] = [];
  private readonly pending = new Map<number, (r: RegionJobResult) => void>();
  private nextId = 1;

  constructor(private readonly size: number) {}

  private spawn(): Worker {
    const w = new Worker(new URL("./lod-worker.ts", import.meta.url).href);
    w.onmessage = (e: MessageEvent<RegionJobResult>) => {
      const cb = this.pending.get(e.data.id);
      this.pending.delete(e.data.id);
      cb?.(e.data);
      this.release(w);
    };
    (w as unknown as { unref(): void }).unref();
    this.workers.push(w);
    return w;
  }

  private release(w: Worker): void {
    const next = this.queue.shift();
    if (next) this.dispatch(w, next.job, next.resolve);
    else this.idle.push(w);
  }

  private dispatch(w: Worker, job: Omit<RegionJob, "id">, resolve: (r: RegionJobResult) => void): void {
    const id = this.nextId++;
    this.pending.set(id, resolve);
    w.postMessage({ ...job, id } satisfies RegionJob);
  }

  run(job: Omit<RegionJob, "id">): Promise<RegionJobResult> {
    return new Promise((resolve) => {
      const w = this.idle.pop() ?? (this.workers.length < this.size ? this.spawn() : null);
      if (w) this.dispatch(w, job, resolve);
      else this.queue.push({ job, resolve });
    });
  }

  terminate(): void {
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
    this.idle.length = 0;
  }
}

// Kept on globalThis so `bun --hot` reloads replace the old workers instead of leaking them.
const g = globalThis as { __mcrLodPool?: RegionPool };
g.__mcrLodPool?.terminate();
g.__mcrLodPool = undefined;

export function regionPool(): RegionPool {
  const n = Number(process.env.LOD_WORKERS) || Math.max(1, navigator.hardwareConcurrency - 2);
  g.__mcrLodPool ??= new RegionPool(n);
  return g.__mcrLodPool;
}

// ---------------------------------------------------------------------------------------------
// Service

function gridFromBlob(gz: Uint8Array<ArrayBuffer>): Grid {
  const raw = Bun.gunzipSync(gz);
  const d = decodeLod(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer);
  return { size: LOD_CELLS, heights: d.heights, colors: new Uint32Array(d.colors.buffer, d.colors.byteOffset, LOD_CELLS * LOD_CELLS) };
}

export class LodService {
  readonly root: string;
  private readonly regions: { rx: number; rz: number }[];
  private readonly regionSet: Set<string>;
  private readonly inflight = new Map<string, Promise<Uint8Array<ArrayBuffer> | null>>();

  constructor(readonly world: ServerWorld) {
    this.root = lodCacheRoot(world.info.id);
    this.regions = world.store.regions();
    this.regionSet = new Set(this.regions.map((r) => `${r.rx},${r.rz}`));
    this.checkStamp();
  }

  /** Wipe the cache when the colour table or LOD algorithm changed since it was built. */
  private checkStamp(): void {
    const stamp = `v${LOD_VERSION};${loadColours().fingerprint}`;
    const f = join(this.root, "stamp.txt");
    const old = existsSync(f) ? readFileSync(f, "utf8") : null;
    if (old === stamp) return;
    if (old !== null) console.log(`[lod] ${this.world.info.id}: cache stamp changed (${old} -> ${stamp}), clearing`);
    rmSync(this.root, { recursive: true, force: true });
    mkdirSync(this.root, { recursive: true });
    writeFileSync(f, stamp);
  }

  /** Region range [r0, r1] covered by tile index t at level L, on one axis. */
  private static regionSpan(L: number, t: number): [number, number] {
    if (L < 2) {
      const r = t >> (2 - L);
      return [r, r];
    }
    const k = 1 << (L - 2);
    return [t * k, t * k + k - 1];
  }

  hasData(L: number, tx: number, tz: number): boolean {
    const [x0, x1] = LodService.regionSpan(L, tx);
    const [z0, z1] = LodService.regionSpan(L, tz);
    if (x0 === x1 && z0 === z1) return this.regionSet.has(`${x0},${z0}`);
    for (const r of this.regions) if (r.rx >= x0 && r.rx <= x1 && r.rz >= z0 && r.rz <= z1) return true;
    return false;
  }

  private readCache(L: number, tx: number, tz: number): Uint8Array<ArrayBuffer> | null | undefined {
    const p = lodPath(this.root, L, tx, tz);
    if (!existsSync(p)) return undefined;
    if (statSync(p).size === 0) return null;
    return new Uint8Array(readFileSync(p));
  }

  /** Build levels 0..2 of one region in a worker (results land in the cache). */
  async buildRegion(rx: number, rz: number): Promise<RegionJobResult> {
    const key = `R${rx},${rz}`;
    const existing = this.inflight.get(key);
    if (existing) {
      await existing;
      return { id: 0 };
    }
    let result: RegionJobResult = { id: 0 };
    const p = regionPool()
      .run({ regionDir: this.world.regionDir, root: this.root, rx, rz })
      .then((r) => {
        result = r;
        if (r.error) throw new Error(`region ${rx},${rz}: ${r.error}`);
        return null;
      });
    this.inflight.set(key, p);
    try {
      await p;
    } finally {
      this.inflight.delete(key);
    }
    return result;
  }

  /** Gzipped MCL1 bytes, or null when the tile has no data. */
  get(L: number, tx: number, tz: number): Promise<Uint8Array<ArrayBuffer> | null> {
    if (L < 0 || L > this.world.info.maxLod || !this.hasData(L, tx, tz)) return Promise.resolve(null);
    const cached = this.readCache(L, tx, tz);
    if (cached !== undefined) return Promise.resolve(cached);
    const key = `${L}/${tx}/${tz}`;
    let p = this.inflight.get(key);
    if (!p) {
      p = this.build(L, tx, tz).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private async build(L: number, tx: number, tz: number): Promise<Uint8Array<ArrayBuffer> | null> {
    if (L < REGION_LEVELS) {
      const per = 4 >> L; // tiles per region side
      await this.buildRegion(Math.floor(tx / per), Math.floor(tz / per));
      return this.readCache(L, tx, tz) ?? null;
    }
    const kids = await Promise.all([0, 1, 2, 3].map((k) => this.get(L - 1, 2 * tx + (k & 1), 2 * tz + (k >> 1))));
    const out = newGrid(LOD_CELLS);
    const half = LOD_CELLS >> 1;
    kids.forEach((blob, k) => {
      if (blob) downInto(gridFromBlob(blob), out, (k & 1) * half, (k >> 1) * half);
    });
    const blob = lodBlob(L, tx, tz, out);
    writeLod(this.root, L, tx, tz, blob);
    return blob;
  }

  /** Tiles at level L overlapping a block-coordinate box (inclusive). */
  tilesInBox(L: number, b: { minX: number; maxX: number; minZ: number; maxZ: number }): [number, number][] {
    const size = LOD_CELLS << L;
    const out: [number, number][] = [];
    for (let tz = Math.floor(b.minZ / size); tz <= Math.floor(b.maxZ / size); tz++)
      for (let tx = Math.floor(b.minX / size); tx <= Math.floor(b.maxX / size); tx++)
        if (this.hasData(L, tx, tz)) out.push([tx, tz]);
    return out;
  }

  /** Build levels 0..2 for the given regions (default: all) in parallel, skipping cached ones. */
  async prebuildRegions(opts: { force?: boolean; regions?: { rx: number; rz: number }[]; log?: boolean } = {}): Promise<void> {
    const todo = (opts.regions ?? this.regions).filter(
      (r) => opts.force || !existsSync(lodPath(this.root, REGION_LEVELS - 1, r.rx, r.rz)),
    );
    const t0 = performance.now();
    let done = 0;
    let chunks = 0;
    let lastLog = 0;
    await Promise.all(
      todo.map(async (r) => {
        const res = await this.buildRegion(r.rx, r.rz);
        done++;
        chunks += res.chunks ?? 0;
        const now = performance.now();
        if (opts.log && (now - lastLog > 2000 || done === todo.length)) {
          lastLog = now;
          const s = (now - t0) / 1000;
          const eta = (s / done) * (todo.length - done);
          console.log(`[lod] ${this.world.info.id}: ${done}/${todo.length} regions, ${chunks} chunks, ${s.toFixed(1)} s, eta ${eta.toFixed(0)} s`);
        }
      }),
    );
  }

  /** Build every level for the whole world (or a block box), bottom-up. */
  async prebuildAll(opts: { force?: boolean; log?: boolean; box?: { minX: number; maxX: number; minZ: number; maxZ: number }; maxLevel?: number } = {}) {
    const box = opts.box ?? this.world.info.bounds;
    const regions = this.tilesInBox(REGION_LEVELS - 1, box).map(([rx, rz]) => ({ rx, rz }));
    await this.prebuildRegions({ force: opts.force, regions, log: opts.log });
    const top = Math.min(opts.maxLevel ?? this.world.info.maxLod, this.world.info.maxLod);
    for (let L = REGION_LEVELS; L <= top; L++) {
      const t = performance.now();
      const tiles = this.tilesInBox(L, box);
      await Promise.all(tiles.map(([tx, tz]) => this.get(L, tx, tz)));
      if (opts.log) console.log(`[lod] ${this.world.info.id}: level ${L}: ${tiles.length} tiles in ${(performance.now() - t).toFixed(0)} ms`);
    }
  }
}

const services = new Map<string, LodService>();
export function lodService(world: ServerWorld): LodService {
  let s = services.get(world.info.id);
  if (!s) {
    s = new LodService(world);
    services.set(world.info.id, s);
  }
  return s;
}

// ---------------------------------------------------------------------------------------------
// CLI

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(`--${name}`);
  const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (!flag("prebuild")) {
    console.log("usage: bun run src/server/lod.ts --prebuild [--world <id>] [--force] [--max-level N]");
    process.exit(1);
  }
  const worlds = getWorlds();
  const ids = opt("world") ? [opt("world")!] : [...worlds.keys()];
  for (const id of ids) {
    const w = worlds.get(id);
    if (!w) {
      console.error(`unknown world ${id}`);
      process.exit(1);
    }
    const t = performance.now();
    const ml = opt("max-level");
    await lodService(w).prebuildAll({ force: flag("force"), log: true, maxLevel: ml !== undefined ? Number(ml) : undefined });
    console.log(`[lod] ${id}: prebuild done in ${((performance.now() - t) / 1000).toFixed(1)} s`);
  }
  regionPool().terminate();
}
