// World registry: worlds.json (committed) + worlds.local.json (gitignored) + WORLD_<ID>_PATH env
// overrides. Paths in the JSON files are resolved against the repo root.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import type { WorldInfo, WorldTransform } from "../shared/api.ts";
import { LOD_CELLS } from "../shared/api.ts";
import { parseNbt } from "./nbt.ts";
import { RegionFile, RegionStore, findRegionDir, listRegions } from "./region.ts";

export const REPO_ROOT = resolve(import.meta.dir, "..", "..");
export const CACHE_DIR = process.env.MCR_CACHE_DIR ? resolve(REPO_ROOT, process.env.MCR_CACHE_DIR) : join(REPO_ROOT, "cache");

export interface WorldConfig {
  id: string;
  name: string;
  path: string | null; // absolute, after overrides
  transform: WorldTransform;
}

export interface ServerWorld {
  info: WorldInfo;
  path: string;
  regionDir: string;
  store: RegionStore;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function envKey(id: string): string {
  return `WORLD_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PATH`;
}

/** Cheap: config only, no disk scanning beyond the two JSON files. */
export function loadWorldConfigs(): WorldConfig[] {
  const base = readJson(join(REPO_ROOT, "worlds.json")) as {
    id: string;
    name: string;
    path: string | null;
    transform?: WorldTransform;
  }[];
  const localFile = join(REPO_ROOT, "worlds.local.json");
  const local = (existsSync(localFile) ? readJson(localFile) : {}) as Record<string, { path?: string | null }>;
  return base.map((w) => {
    let p: string | null = w.path;
    if (local[w.id]?.path) p = local[w.id]!.path!;
    const env = process.env[envKey(w.id)];
    if (env) p = env;
    return {
      id: w.id,
      name: w.name,
      path: p ? (isAbsolute(p) ? p : resolve(REPO_ROOT, p)) : null,
      transform: w.transform ?? { s: 1, thetaDeg: 0, tx: 0, tz: 0, ty: 0 },
    };
  });
}

/** Overworld vertical range: from a datapack dimension_type override, else from a sample chunk. */
function dimensionRange(worldPath: string): { minY: number; height: number } | null {
  const dp = join(worldPath, "datapacks");
  if (!existsSync(dp)) return null;
  for (const pack of readdirSync(dp)) {
    const roots = [join(dp, pack)];
    try {
      for (const sub of readdirSync(join(dp, pack))) if (sub.startsWith("overlay")) roots.push(join(dp, pack, sub));
    } catch {
      continue; // zipped pack
    }
    for (const r of roots) {
      const f = join(r, "data", "minecraft", "dimension_type", "overworld.json");
      if (!existsSync(f)) continue;
      try {
        const j = readJson(f) as { min_y?: number; height?: number };
        if (typeof j.min_y === "number" && typeof j.height === "number") return { minY: j.min_y, height: j.height };
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function readSpawn(worldPath: string): { x: number; y: number; z: number } | null {
  const f = join(worldPath, "level.dat");
  if (!existsSync(f)) return null;
  try {
    const root = parseNbt(new Uint8Array(gunzipSync(readFileSync(f))));
    const d = root.Data as Record<string, unknown> | undefined;
    if (!d) return null;
    const spawn = d.spawn as { pos?: Int32Array } | undefined;
    if (spawn?.pos && spawn.pos.length >= 3) return { x: spawn.pos[0]!, y: spawn.pos[1]!, z: spawn.pos[2]! };
    if (typeof d.SpawnX === "number" && typeof d.SpawnY === "number" && typeof d.SpawnZ === "number")
      return { x: d.SpawnX, y: d.SpawnY, z: d.SpawnZ };
  } catch {
    /* ignore */
  }
  return null;
}

/** Smallest level whose tiles cover the world in <= 4 tiles per axis. */
export function pickMaxLod(b: { minX: number; maxX: number; minZ: number; maxZ: number }): number {
  for (let L = 0; L < 20; L++) {
    const size = LOD_CELLS * 2 ** L;
    const nx = Math.floor(b.maxX / size) - Math.floor(b.minX / size) + 1;
    const nz = Math.floor(b.maxZ / size) - Math.floor(b.minZ / size) + 1;
    if (nx <= 4 && nz <= 4) return L;
  }
  return 20;
}

/** Full scan: region headers for exact chunk bounds, level.dat spawn, dimension range. */
export function openWorld(cfg: WorldConfig): ServerWorld | null {
  if (!cfg.path || !existsSync(cfg.path)) {
    console.warn(`[worlds] ${cfg.id}: no world at ${cfg.path ?? "(unset)"}; set worlds.local.json or ${envKey(cfg.id)}`);
    return null;
  }
  const regionDir = findRegionDir(cfg.path);
  if (!regionDir) {
    console.warn(`[worlds] ${cfg.id}: no region dir under ${cfg.path}`);
    return null;
  }
  let minCx = Infinity, maxCx = -Infinity, minCz = Infinity, maxCz = -Infinity;
  let sample = null as { rf: RegionFile; lx: number; lz: number } | null;
  for (const r of listRegions(regionDir)) {
    const rf = new RegionFile(r.file, r.rx, r.rz);
    let any = false;
    for (let i = 0; i < 1024; i++) {
      if (rf.locations[i] === 0) continue;
      any = true;
      const cx = r.rx * 32 + (i & 31);
      const cz = r.rz * 32 + (i >> 5);
      if (cx < minCx) minCx = cx;
      if (cx > maxCx) maxCx = cx;
      if (cz < minCz) minCz = cz;
      if (cz > maxCz) maxCz = cz;
      if (!sample) sample = { rf, lx: i & 31, lz: i >> 5 };
    }
    if (sample?.rf !== rf || !any) rf.close();
  }
  if (!Number.isFinite(minCx)) {
    console.warn(`[worlds] ${cfg.id}: no chunks in ${regionDir}`);
    return null;
  }
  let range = dimensionRange(cfg.path);
  if (!range && sample) {
    // fall back to a chunk's yPos and highest section
    const nbt = sample.rf.readChunk(sample.lx, sample.lz);
    if (nbt) {
      const root = parseNbt(nbt) as { yPos?: number; sections?: { Y: number }[] };
      const ys = (root.sections ?? []).map((s) => s.Y);
      const lo = root.yPos ?? Math.min(...ys);
      range = { minY: lo * 16, height: (Math.max(...ys) - lo + 1) * 16 };
    }
  }
  sample?.rf.close();
  range ??= { minY: -64, height: 384 };
  const bounds = {
    minX: minCx * 16,
    maxX: maxCx * 16 + 15,
    minZ: minCz * 16,
    maxZ: maxCz * 16 + 15,
    minY: range.minY,
    maxY: range.minY + range.height - 1,
  };
  const spawn = readSpawn(cfg.path) ?? {
    x: Math.round((bounds.minX + bounds.maxX) / 2),
    y: 64,
    z: Math.round((bounds.minZ + bounds.maxZ) / 2),
  };
  return {
    info: { id: cfg.id, name: cfg.name, bounds, spawn, transform: cfg.transform, maxLod: pickMaxLod(bounds) },
    path: cfg.path,
    regionDir,
    store: new RegionStore(regionDir, 32),
  };
}

let cached: Map<string, ServerWorld> | null = null;

/** All worlds that exist on this machine, scanned once per process. */
export function getWorlds(): Map<string, ServerWorld> {
  if (cached) return cached;
  const m = new Map<string, ServerWorld>();
  for (const cfg of loadWorldConfigs()) {
    const t = performance.now();
    const w = openWorld(cfg);
    if (w) {
      m.set(cfg.id, w);
      console.log(`[worlds] ${cfg.id}: ${w.regionDir} bounds ${JSON.stringify(w.info.bounds)} maxLod ${w.info.maxLod} (${(performance.now() - t).toFixed(0)} ms)`);
    }
  }
  cached = m;
  return m;
}

export function worldInfos(): WorldInfo[] {
  return [...getWorlds().values()].map((w) => w.info);
}
