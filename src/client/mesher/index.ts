// Mesher pool: web workers turning MCT1 tile blobs into TileMesh geometry.
//
// The worker script is NOT bundled by Bun's HTML import (Bun leaves
// `new Worker(new URL("./worker.ts", import.meta.url))` untouched), so it is built separately and
// loaded from MESHER_WORKER_URL ("/assets/mesher-worker.js", written by `bun run build-assets`;
// a dev server may serve a fresh build from build-worker.ts's mesherWorkerResponse()).

import type { AssetBundle, MesherPool, TileMesh } from "../../shared/mesh-types.ts";
import { MESHER_WORKER_URL } from "./worker-url.ts";

export { MESHER_WORKER_URL } from "./worker-url.ts";

export interface MesherPoolOptions {
  /** URL of the bundled worker script (default MESHER_WORKER_URL) */
  workerUrl?: string | URL;
  /** jobs sent to one worker before it answers (default 2) */
  inFlightPerWorker?: number;
}

interface Job {
  id: number;
  blob: ArrayBuffer;
  resolve: (m: TileMesh) => void;
  reject: (e: Error) => void;
}

interface Slot {
  worker: Worker;
  inFlight: Map<number, Job>;
}

/**
 * Start `workers` mesher workers. `mesh(blob)` takes an uncompressed MCT1 blob and TRANSFERS it
 * to the worker (the caller's ArrayBuffer is detached afterwards). Jobs run in FIFO order.
 */
export function createMesherPool(assets: AssetBundle, workers: number, opts: MesherPoolOptions = {}): MesherPool {
  const url = opts.workerUrl ?? MESHER_WORKER_URL;
  const perWorker = Math.max(1, opts.inFlightPerWorker ?? 2);
  const assetsJson = JSON.stringify(assets);
  const queue: Job[] = [];
  const slots: Slot[] = [];
  let nextId = 1;
  let disposed = false;

  const fail = (slot: Slot, err: Error) => {
    for (const job of slot.inFlight.values()) job.reject(err);
    slot.inFlight.clear();
  };

  for (let i = 0; i < Math.max(1, workers); i++) {
    const worker = new Worker(url, { type: "module", name: `mesher-${i}` });
    const slot: Slot = { worker, inFlight: new Map() };
    worker.onmessage = (e: MessageEvent) => {
      const { id, mesh, error } = e.data as { id: number; mesh?: TileMesh; error?: string };
      const job = slot.inFlight.get(id);
      if (!job) return;
      slot.inFlight.delete(id);
      if (error !== undefined || !mesh) job.reject(new Error(`mesher: ${error ?? "no mesh"}`));
      else job.resolve(mesh);
      pump();
    };
    worker.onerror = (e: ErrorEvent) => {
      e.preventDefault();
      fail(slot, new Error(`mesher worker error: ${e.message} (is ${String(url)} served? run \`bun run build-assets\`)`));
      pump();
    };
    worker.postMessage({ type: "init", assets: assetsJson });
    slots.push(slot);
  }

  function pump(): void {
    while (queue.length) {
      let best: Slot | null = null;
      for (const s of slots) if (s.inFlight.size < perWorker && (!best || s.inFlight.size < best.inFlight.size)) best = s;
      if (!best) return;
      const job = queue.shift()!;
      best.inFlight.set(job.id, job);
      best.worker.postMessage({ type: "mesh", id: job.id, blob: job.blob }, [job.blob]);
    }
  }

  return {
    mesh(blob: ArrayBuffer): Promise<TileMesh> {
      if (disposed) return Promise.reject(new Error("mesher pool disposed"));
      return new Promise<TileMesh>((resolve, reject) => {
        queue.push({ id: nextId++, blob, resolve, reject });
        pump();
      });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const err = new Error("mesher pool disposed");
      for (const s of slots) {
        s.worker.terminate();
        fail(s, err);
      }
      for (const j of queue.splice(0)) j.reject(err);
    },
  };
}
