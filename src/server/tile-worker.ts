// Worker used by scripts/bake.ts: builds a batch of MCT1 tiles and writes them under outDir.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RegionStore } from "./region.ts";
import { buildTile } from "./tiles.ts";

declare const self: Worker;

export interface TileBatchJob {
  id: number;
  regionDir: string;
  /** directory that receives {tx}/{tz}.bin */
  outDir: string;
  tiles: [number, number][];
}

export interface TileBatchResult {
  id: number;
  written: [number, number][];
  bytes: number;
  error?: string;
}

const stores = new Map<string, RegionStore>();

self.onmessage = (e: MessageEvent<TileBatchJob>) => {
  const { id, regionDir, outDir, tiles } = e.data;
  const written: [number, number][] = [];
  let bytes = 0;
  try {
    let store = stores.get(regionDir);
    if (!store) {
      store = new RegionStore(regionDir, 4);
      stores.set(regionDir, store);
    }
    for (const [tx, tz] of tiles) {
      const blob = buildTile(store, tx, tz, 9);
      if (!blob) continue;
      const dir = join(outDir, String(tx));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${tz}.bin`), blob);
      written.push([tx, tz]);
      bytes += blob.length;
    }
    self.postMessage({ id, written, bytes } satisfies TileBatchResult);
  } catch (err) {
    self.postMessage({ id, written, bytes, error: (err as Error).stack ?? String(err) } satisfies TileBatchResult);
  }
};
