// Web worker entry. Bundled separately (see build-worker.ts) and served at MESHER_WORKER_URL.
//
// Protocol (main -> worker):
//   { type: "init", assets: string }               AssetBundle as JSON text (cheap to clone)
//   { type: "mesh", id: number, blob: ArrayBuffer } uncompressed MCT1 blob (transferred)
// worker -> main:
//   { id, mesh: TileMesh, ms: number }  buffers transferred
//   { id, error: string }

import type { AssetBundle } from "../../shared/mesh-types.ts";
import { decodeTile } from "../../shared/tile-format.ts";
import { MesherCore, meshTransferables } from "./core.ts";

declare const self: DedicatedWorkerGlobalScope;

let core: MesherCore | null = null;

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === "init") {
    core = new MesherCore(JSON.parse(msg.assets) as AssetBundle);
    return;
  }
  if (msg.type === "mesh") {
    try {
      if (!core) throw new Error("mesher worker not initialised");
      const t0 = performance.now();
      const mesh = core.meshTile(decodeTile(msg.blob));
      self.postMessage({ id: msg.id, mesh, ms: performance.now() - t0 }, meshTransferables(mesh));
    } catch (err) {
      self.postMessage({ id: msg.id, error: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err) });
    }
  }
};
