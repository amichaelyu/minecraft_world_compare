// Server/build-side helper: bundles the mesher web worker with Bun.build.
//
// Bun's HTML-import bundler (dev and production) does NOT follow
// `new Worker(new URL("./worker.ts", import.meta.url))`, so the worker is built separately and
// served as a plain script at MESHER_WORKER_URL (see ./worker-url.ts). scripts/build-assets.ts
// writes it to cache/assets/mesher-worker.js; a dev server can call buildMesherWorker() per
// request instead so edits to the mesher show up without re-running build-assets.
//
// Do not import this file from client code (it uses Bun APIs).

const WORKER_ENTRY = new URL("./worker.ts", import.meta.url).pathname;

/** Bundle src/client/mesher/worker.ts into a single ES module script for the browser. */
export async function buildMesherWorker(opts: { minify?: boolean; sourcemap?: boolean } = {}): Promise<string> {
  const result = await Bun.build({
    entrypoints: [decodeURIComponent(WORKER_ENTRY)],
    target: "browser",
    format: "esm",
    minify: opts.minify ?? true,
    sourcemap: opts.sourcemap ? "inline" : "none",
  });
  if (!result.success) throw new AggregateError(result.logs, "mesher worker build failed");
  const out = result.outputs[0];
  if (!out) throw new Error("mesher worker build produced no output");
  return out.text();
}

/** Ready-made Bun.serve route handler: rebuilds the worker on every request (dev). */
export async function mesherWorkerResponse(): Promise<Response> {
  const js = await buildMesherWorker({ minify: false, sourcemap: true });
  return new Response(js, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
}
