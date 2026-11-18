// Picks the mesher pool. Set USE_STUB = true to fall back to the main-thread dev stub.
import type { AssetBundle, MesherPool } from "../shared/mesh-types.ts";
import { assetUrl } from "./config.ts";
import { createMesherPool as createStubPool } from "./dev-stub-mesher.ts";
import { createMesherPool as createWorkerPool } from "./mesher/index.ts";

const USE_STUB = false;

/**
 * Worker scripts must be same-origin. When `?data=` points at another origin, fetch the bundled
 * worker and run it from a blob: URL instead.
 */
async function workerUrl(): Promise<string> {
  const url = new URL(assetUrl("mesher-worker.js"), location.href);
  if (url.origin === location.origin) return url.href;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`mesher-worker.js: HTTP ${res.status}`);
  return URL.createObjectURL(new Blob([await res.text()], { type: "text/javascript" }));
}

/** assets === null (bundle not built) also falls back to the stub. */
export async function makeMesherPool(assets: AssetBundle | null, workers: number, empty: AssetBundle): Promise<MesherPool> {
  if (USE_STUB || !assets) return createStubPool(assets ?? empty, workers);
  return createWorkerPool(assets, workers, { workerUrl: await workerUrl() });
}
