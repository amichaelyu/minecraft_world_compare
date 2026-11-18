// URL at which the bundled mesher worker script is served (same in local and hosted mode).
// scripts/build-assets.ts writes cache/assets/mesher-worker.js, which the server's /assets/*
// route serves; see build-worker.ts for why Bun can't bundle the worker from the HTML import.
export const MESHER_WORKER_URL = "/assets/mesher-worker.js";
