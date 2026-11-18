// Worker: builds LOD levels 0..2 for one region and writes them to the LOD cache.

import { buildRegionLods, loadColours } from "./lod-core.ts";
import { RegionStore } from "./region.ts";

declare const self: Worker;

export interface RegionJob {
  id: number;
  regionDir: string;
  root: string;
  rx: number;
  rz: number;
}

export interface RegionJobResult {
  id: number;
  chunks?: number;
  ms?: number;
  error?: string;
}

const stores = new Map<string, RegionStore>();

self.onmessage = (e: MessageEvent<RegionJob>) => {
  const { id, regionDir, root, rx, rz } = e.data;
  const t = performance.now();
  try {
    let store = stores.get(regionDir);
    if (!store) {
      store = new RegionStore(regionDir, 4);
      stores.set(regionDir, store);
    }
    const { chunks } = buildRegionLods(store, root, rx, rz, loadColours());
    self.postMessage({ id, chunks, ms: performance.now() - t } satisfies RegionJobResult);
  } catch (err) {
    self.postMessage({ id, error: (err as Error).stack ?? String(err) } satisfies RegionJobResult);
  }
};
