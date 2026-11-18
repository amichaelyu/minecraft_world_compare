// Runtime configuration for the viewer. Everything here can be overridden from the query string.

const params = new URLSearchParams(location.search);

/**
 * Base URL that `/data/*` and `/assets/*` hang off. Empty string = same origin (local dev server
 * and the hosted build, which serves the baked files at the same URL layout). Override with
 * `?data=https://host/prefix` to point a page at another copy of the data.
 */
export const DEFAULT_DATA_BASE = "";

function cleanBase(s: string): string {
  return s.replace(/\/+$/, "");
}

export const DATA_BASE = cleanBase(params.get("data") ?? DEFAULT_DATA_BASE);

export const dataUrl = (path: string) => `${DATA_BASE}/data/${path}`;
export const assetUrl = (path: string) => `${DATA_BASE}/assets/${path}`;

function num(name: string, def: number): number {
  const v = params.get(name);
  if (v === null || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export const config = {
  /** world ids for the left (A) and right (B) panes; null = first two worlds */
  worldA: params.get("a"),
  worldB: params.get("b"),
  /** full-detail radius in reference-frame blocks */
  radius: num("r", 384),
  radiusMin: 128,
  radiusMax: 1024,
  /** dispose full tiles beyond radius * this */
  unloadFactor: 1.3,
  maxTileFetches: num("fetches", 8),
  maxLodFetches: num("lodfetches", 3),
  mesherWorkers: num("workers", Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 2))),
  /** target on-screen size of one LOD cell, in pixels (bigger = coarser, faster) */
  lodPixelsPerCell: num("lodpx", 5),
  /** LOD tiles kept in memory beyond the ones in use */
  lodCacheTiles: 256,
  /** ms of LOD mesh building allowed per frame */
  lodBuildBudgetMs: 4,
  pixelRatio: num("dpr", Math.min(window.devicePixelRatio || 1, 2)),
  logDepth: params.get("logdepth") !== "0",
  fov: num("fov", 70),
  far: 60000,
  skyColor: 0x9fc6f5,
};
