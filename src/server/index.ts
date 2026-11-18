// Local dev server: the client (HTML import) plus /data/* (tiles and LOD built on demand from the
// region files) and /assets/* (from cache/assets). URLs match the baked static layout.

import { existsSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import index from "../client/index.html";
import { lodService } from "./lod.ts";
import { buildTile } from "./tiles.ts";
import { CACHE_DIR, getWorlds, worldInfos } from "./worlds.ts";

const PORT = Number(process.env.PORT) || 3000;
const ASSETS_DIR = join(CACHE_DIR, "assets");
const DATA_CACHE = "public, max-age=300";

const worlds = getWorlds();

function binary(body: Uint8Array<ArrayBuffer> | null): Response {
  if (!body) return new Response(null, { status: 204, headers: { "Cache-Control": DATA_CACHE } });
  return new Response(body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "gzip",
      "Cache-Control": DATA_CACHE,
    },
  });
}

const notFound = (msg = "not found") => new Response(msg, { status: 404 });

/** Parse "<int>" or "<int>.bin". */
function intParam(s: string, bin = false): number | null {
  const m = (bin ? /^(-?\d+)\.bin$/ : /^(-?\d+)$/).exec(s);
  return m ? Number(m[1]) : null;
}

function timed(label: string, t0: number, extra = ""): void {
  const ms = performance.now() - t0;
  if (ms > 50 || process.env.LOG_ALL) console.log(`${label} ${ms.toFixed(1)} ms${extra}`);
}

const server = Bun.serve({
  port: PORT,
  development: process.env.NODE_ENV !== "production",
  routes: {
    "/": index,

    "/data/worlds.json": () => Response.json(worldInfos(), { headers: { "Cache-Control": "no-cache" } }),

    "/data/:world/tile/:tx/:tz": (req) => {
      const t0 = performance.now();
      const w = worlds.get(req.params.world);
      const tx = intParam(req.params.tx);
      const tz = intParam(req.params.tz, true);
      if (!w || tx === null || tz === null) return notFound();
      const body = buildTile(w.store, tx, tz);
      timed(`tile ${w.info.id} ${tx},${tz}`, t0, body ? ` ${body.length} B` : " empty");
      return binary(body);
    },

    "/data/:world/lod/:L/:tx/:tz": async (req) => {
      const t0 = performance.now();
      const w = worlds.get(req.params.world);
      const L = intParam(req.params.L);
      const tx = intParam(req.params.tx);
      const tz = intParam(req.params.tz, true);
      if (!w || L === null || tx === null || tz === null) return notFound();
      const body = await lodService(w).get(L, tx, tz);
      timed(`lod ${w.info.id} L${L} ${tx},${tz}`, t0, body ? ` ${body.length} B` : " empty");
      return binary(body);
    },

    "/assets/*": (req) => {
      const rel = decodeURIComponent(new URL(req.url).pathname.slice("/assets/".length));
      const p = normalize(join(ASSETS_DIR, rel));
      if (!p.startsWith(ASSETS_DIR + sep) || !existsSync(p) || !statSync(p).isFile()) return notFound();
      return new Response(Bun.file(p), { headers: { "Cache-Control": "no-cache" } });
    },
  },
  fetch: () => notFound(),
});

console.log(`[server] http://localhost:${server.port}  worlds: ${[...worlds.keys()].join(", ") || "(none)"}`);
