// Bake every /data URL (and /assets) to dist/ for static file serving.
//
//   bun run bake [--world <id>] [--bbox minTx,minTz,maxTx,maxTz] [--max-lod N] [--no-lod] [--no-tiles]
//                [--out <dir>] [--workers N]
//
// --bbox is in MCT1 tile coords (64 blocks) of the world's own frame. Only tiles that contain chunks
// are written. .bin files are stored gzipped as served (set Content-Encoding: gzip on upload).
// Missing tiles are simply absent (404 from a static file server, where the local server says 204); the per-world
// tiles.json lists the baked tiles.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TILE_CHUNKS } from "../src/shared/api.ts";
import { lodPath } from "../src/server/lod-core.ts";
import { lodService, regionPool } from "../src/server/lod.ts";
import { RegionFile, listRegions } from "../src/server/region.ts";
import type { TileBatchJob, TileBatchResult } from "../src/server/tile-worker.ts";
import { CACHE_DIR, REPO_ROOT, getWorlds, type ServerWorld } from "../src/server/worlds.ts";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const OUT = resolve(REPO_ROOT, opt("out") ?? "dist");
const WORKERS = Number(opt("workers")) || Math.max(1, navigator.hardwareConcurrency - 2);
const bboxArg = opt("bbox")?.split(",").map(Number);
if (bboxArg && (bboxArg.length !== 4 || bboxArg.some((v) => !Number.isFinite(v)))) {
  console.error("--bbox wants minTx,minTz,maxTx,maxTz");
  process.exit(1);
}
const bbox = bboxArg ? { minTx: bboxArg[0]!, minTz: bboxArg[1]!, maxTx: bboxArg[2]!, maxTz: bboxArg[3]! } : null;
const maxLodArg = opt("max-lod");

/** All tiles with at least one chunk, optionally clipped to the bbox. */
function listTiles(w: ServerWorld): [number, number][] {
  const out: [number, number][] = [];
  const per = 32 / TILE_CHUNKS;
  for (const r of listRegions(w.regionDir)) {
    if (bbox) {
      const tx0 = r.rx * per, tz0 = r.rz * per;
      if (tx0 + per - 1 < bbox.minTx || tx0 > bbox.maxTx || tz0 + per - 1 < bbox.minTz || tz0 > bbox.maxTz) continue;
    }
    const rf = new RegionFile(r.file, r.rx, r.rz);
    for (let gz = 0; gz < per; gz++) {
      for (let gx = 0; gx < per; gx++) {
        const tx = r.rx * per + gx, tz = r.rz * per + gz;
        if (bbox && (tx < bbox.minTx || tx > bbox.maxTx || tz < bbox.minTz || tz > bbox.maxTz)) continue;
        let any = false;
        for (let i = 0; i < TILE_CHUNKS * TILE_CHUNKS && !any; i++)
          any = rf.has(gx * TILE_CHUNKS + (i % TILE_CHUNKS), gz * TILE_CHUNKS + Math.floor(i / TILE_CHUNKS));
        if (any) out.push([tx, tz]);
      }
    }
    rf.close();
  }
  return out;
}

async function bakeTiles(w: ServerWorld): Promise<{ tiles: [number, number][]; bytes: number }> {
  const tiles = listTiles(w);
  const outDir = join(OUT, "data", w.info.id, "tile");
  // batches of tiles from the same region keep each worker's region reads local
  const batches: [number, number][][] = [];
  for (let i = 0; i < tiles.length; i += 64) batches.push(tiles.slice(i, i + 64));
  const workers = Array.from({ length: Math.min(WORKERS, batches.length) }, () => {
    const wk = new Worker(new URL("../src/server/tile-worker.ts", import.meta.url).href);
    return wk;
  });
  const written: [number, number][] = [];
  let bytes = 0;
  let next = 0;
  let done = 0;
  const t0 = performance.now();
  let lastLog = 0;
  await Promise.all(
    workers.map(
      (wk) =>
        new Promise<void>((resolveAll, reject) => {
          const send = () => {
            if (next >= batches.length) return resolveAll();
            const id = next++;
            wk.postMessage({ id, regionDir: w.regionDir, outDir, tiles: batches[id]! } satisfies TileBatchJob);
          };
          wk.onmessage = (e: MessageEvent<TileBatchResult>) => {
            if (e.data.error) return reject(new Error(e.data.error));
            written.push(...e.data.written);
            bytes += e.data.bytes;
            done += batches[e.data.id]!.length;
            const now = performance.now();
            if (now - lastLog > 3000) {
              lastLog = now;
              const s = (now - t0) / 1000;
              console.log(`[bake] ${w.info.id}: tiles ${done}/${tiles.length}, ${(bytes / 1e6).toFixed(0)} MB, ${s.toFixed(0)} s, eta ${((s / done) * (tiles.length - done)).toFixed(0)} s`);
            }
            send();
          };
          send();
        }),
    ),
  );
  for (const wk of workers) wk.terminate();
  console.log(`[bake] ${w.info.id}: ${written.length} tiles, ${(bytes / 1e6).toFixed(1)} MB in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  written.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  return { tiles: written, bytes };
}

async function bakeLod(w: ServerWorld): Promise<Record<number, number>> {
  const svc = lodService(w);
  const maxLevel = Math.min(maxLodArg !== undefined ? Number(maxLodArg) : w.info.maxLod, w.info.maxLod);
  const box = bbox
    ? { minX: bbox.minTx * 64, maxX: (bbox.maxTx + 1) * 64 - 1, minZ: bbox.minTz * 64, maxZ: (bbox.maxTz + 1) * 64 - 1 }
    : w.info.bounds;
  const t0 = performance.now();
  await svc.prebuildAll({ box, maxLevel, log: !bbox });
  const counts: Record<number, number> = {};
  for (let L = 0; L <= maxLevel; L++) {
    let n = 0;
    for (const [tx, tz] of svc.tilesInBox(L, box)) {
      const src = lodPath(svc.root, L, tx, tz);
      if (!existsSync(src) || statSync(src).size === 0) continue;
      const dst = join(OUT, "data", w.info.id, "lod", String(L), String(tx), `${tz}.bin`);
      mkdirSync(join(dst, ".."), { recursive: true });
      cpSync(src, dst);
      n++;
    }
    counts[L] = n;
  }
  console.log(`[bake] ${w.info.id}: lod ${JSON.stringify(counts)} in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  return counts;
}

const worlds = getWorlds();
const ids = opt("world") ? [opt("world")!] : [...worlds.keys()];
mkdirSync(join(OUT, "data"), { recursive: true });

const manifest: {
  generatedAt: string;
  bbox: typeof bbox;
  worlds: Record<string, { tiles: number; tileBytes: number; lod: Record<number, number> }>;
} = { generatedAt: new Date().toISOString(), bbox, worlds: {} };
// merge with an earlier bake into the same dir (e.g. one world at a time)
const manifestFile = join(OUT, "data", "manifest.json");
if (existsSync(manifestFile)) {
  try {
    Object.assign(manifest.worlds, JSON.parse(readFileSync(manifestFile, "utf8")).worlds ?? {});
  } catch {
    /* ignore */
  }
}

for (const id of ids) {
  const w = worlds.get(id);
  if (!w) {
    console.error(`[bake] unknown or missing world ${id}`);
    process.exit(1);
  }
  const t = flag("no-tiles") ? { tiles: [], bytes: 0 } : await bakeTiles(w);
  if (!flag("no-tiles")) writeFileSync(join(OUT, "data", id, "tiles.json"), JSON.stringify(t.tiles));
  const lod = flag("no-lod") ? {} : await bakeLod(w);
  manifest.worlds[id] = { tiles: t.tiles.length, tileBytes: t.bytes, lod };
}
regionPool().terminate();

writeFileSync(join(OUT, "data", "worlds.json"), JSON.stringify([...worlds.values()].map((w) => w.info)));
writeFileSync(manifestFile, JSON.stringify(manifest, null, 1));

const assets = join(CACHE_DIR, "assets");
if (existsSync(assets) && readdirSync(assets).length > 0) {
  cpSync(assets, join(OUT, "assets"), { recursive: true });
  console.log(`[bake] copied ${assets} -> ${join(OUT, "assets")}`);
} else console.warn(`[bake] no ${assets}; run \`bun run build-assets\` first`);

console.log(`[bake] wrote ${OUT}`);
