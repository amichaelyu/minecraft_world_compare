// Full-detail tile streaming for one world: fetch MCT1 blobs near the camera, mesh them in the
// worker pool, and keep the resulting meshes in the world's group.
import * as THREE from "three";
import { TILE_BLOCKS, type WorldInfo } from "../shared/api.ts";
import type { MeshBuffers, MesherPool, TileMesh } from "../shared/mesh-types.ts";
import { dataUrl } from "./config.ts";
import { rectDistance } from "./coords.ts";
import type { BlockMaterials } from "./materials.ts";

type TileState = "fetching" | "fetched" | "meshing" | "ready" | "empty" | "error";

interface TileEntry {
  tx: number;
  tz: number;
  state: TileState;
  abort: AbortController | null;
  blob: ArrayBuffer | null;
  obj: THREE.Group | null;
  lastWanted: number;
  retryAt: number;
  triangles: number;
}

interface Wanted {
  tx: number;
  tz: number;
  d: number;
}

export interface StreamStats {
  ready: number;
  empty: number;
  fetching: number;
  meshing: number;
  queued: number;
  wanted: number;
  triangles: number;
}

const key = (tx: number, tz: number) => (tx + 0x8000) * 0x10000 + (tz + 0x8000);

/** Camera height above ground that doesn't count against the radius (street level, roofs). */
const FREE_HEIGHT = 32;

export class StreamManager {
  private readonly tiles = new Map<number, TileEntry>();
  private wanted: Wanted[] = [];
  private fetching = 0;
  private meshing = 0;
  private readonly t0: number;
  private readonly t1: number;
  private readonly u0: number;
  private readonly u1: number;
  /**
   * Horizontal radius (own coords) around `coverageCenter` inside which every tile is loaded.
   * The LOD shader discards fragments inside it.
   */
  coverage = 0;
  readonly coverageCenter = new THREE.Vector2();

  constructor(
    private readonly world: WorldInfo,
    private readonly mesher: MesherPool,
    private readonly materials: BlockMaterials,
    private readonly parent: THREE.Object3D,
    private readonly opts: { maxFetches: number; maxMeshing: number; unloadFactor: number },
  ) {
    const b = world.bounds;
    this.t0 = Math.floor(b.minX / TILE_BLOCKS);
    this.t1 = Math.floor(b.maxX / TILE_BLOCKS);
    this.u0 = Math.floor(b.minZ / TILE_BLOCKS);
    this.u1 = Math.floor(b.maxZ / TILE_BLOCKS);
  }

  /** cx/cz: camera in the world's own coords; hag: camera height above ground; radius in own blocks. */
  update(cx: number, cz: number, hag: number, radius: number, now: number): void {
    const dv = Math.max(0, hag - FREE_HEIGHT);
    const rh = dv < radius ? Math.sqrt(radius * radius - dv * dv) : 0;

    // 1. Tiles wanted, nearest first.
    const wanted: Wanted[] = [];
    if (rh > 0) {
      const ta = Math.max(this.t0, Math.floor((cx - rh) / TILE_BLOCKS));
      const tb = Math.min(this.t1, Math.floor((cx + rh) / TILE_BLOCKS));
      const ua = Math.max(this.u0, Math.floor((cz - rh) / TILE_BLOCKS));
      const ub = Math.min(this.u1, Math.floor((cz + rh) / TILE_BLOCKS));
      for (let tz = ua; tz <= ub; tz++) {
        for (let tx = ta; tx <= tb; tx++) {
          const x0 = tx * TILE_BLOCKS;
          const z0 = tz * TILE_BLOCKS;
          const d = rectDistance(cx, cz, x0, z0, x0 + TILE_BLOCKS, z0 + TILE_BLOCKS);
          if (d < rh) wanted.push({ tx, tz, d });
        }
      }
      wanted.sort((a, b) => a.d - b.d);
    }
    this.wanted = wanted;

    // 2. Coverage ring: everything nearer than the first tile that isn't settled is loaded.
    let coverage = rh;
    for (const w of wanted) {
      const e = this.tiles.get(key(w.tx, w.tz));
      e && (e.lastWanted = now);
      if (coverage === rh && !(e && (e.state === "ready" || e.state === "empty"))) coverage = w.d;
    }
    this.coverage = coverage;
    this.coverageCenter.set(cx, cz);

    // 3. Drop stale work and far-away tiles.
    const unload = radius * this.opts.unloadFactor;
    for (const [k, e] of this.tiles) {
      if (e.state === "fetching" || e.state === "fetched") {
        if (e.lastWanted < now - 300) {
          e.abort?.abort();
          this.drop(k, e);
        }
        continue;
      }
      if (e.state === "meshing") continue; // can't cancel; handled on completion
      const x0 = e.tx * TILE_BLOCKS;
      const z0 = e.tz * TILE_BLOCKS;
      const d = rectDistance(cx, cz, x0, z0, x0 + TILE_BLOCKS, z0 + TILE_BLOCKS);
      const dist = Math.sqrt(d * d + dv * dv);
      if (dist > unload || (e.state === "error" && e.lastWanted < now)) this.drop(k, e);
    }

    // 4. Start fetches and mesher jobs, nearest first.
    for (const w of wanted) {
      if (this.fetching >= this.opts.maxFetches && this.meshing >= this.opts.maxMeshing) break;
      const k = key(w.tx, w.tz);
      let e = this.tiles.get(k);
      if (e?.state === "error" && now >= e.retryAt) {
        this.tiles.delete(k);
        e = undefined;
      }
      if (!e) {
        if (this.fetching < this.opts.maxFetches) this.startFetch(k, w.tx, w.tz, now);
      } else if (e.state === "fetched" && this.meshing < this.opts.maxMeshing) {
        this.startMesh(k, e);
      }
    }
  }

  private drop(k: number, e: TileEntry): void {
    if (e.state === "fetching") this.fetching--;
    if (e.obj) {
      this.parent.remove(e.obj);
      for (const c of e.obj.children) (c as THREE.Mesh).geometry.dispose();
      e.obj = null;
    }
    e.blob = null;
    this.tiles.delete(k);
  }

  private startFetch(k: number, tx: number, tz: number, now: number): void {
    const e: TileEntry = {
      tx,
      tz,
      state: "fetching",
      abort: new AbortController(),
      blob: null,
      obj: null,
      lastWanted: now,
      retryAt: 0,
      triangles: 0,
    };
    this.tiles.set(k, e);
    this.fetching++;
    const url = dataUrl(`${this.world.id}/tile/${tx}/${tz}.bin`);
    fetch(url, { signal: e.abort!.signal })
      .then(async (res) => {
        if (res.status === 204 || res.status === 404) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        return buf.byteLength ? buf : null;
      })
      .then(
        (buf) => {
          if (this.tiles.get(k) !== e) return; // dropped meanwhile
          this.fetching--;
          e.abort = null;
          if (buf) {
            e.state = "fetched";
            e.blob = buf;
          } else e.state = "empty";
        },
        (err: unknown) => {
          if (this.tiles.get(k) !== e) return;
          this.fetching--;
          e.abort = null;
          e.state = "error";
          e.retryAt = performance.now() + 5000;
          console.warn(`tile ${this.world.id} ${tx},${tz}:`, err);
        },
      );
  }

  private startMesh(k: number, e: TileEntry): void {
    const blob = e.blob!;
    e.blob = null;
    e.state = "meshing";
    this.meshing++;
    this.mesher.mesh(blob).then(
      (tm) => {
        this.meshing--;
        if (this.tiles.get(k) !== e) return;
        const obj = this.build(tm, e.tx, e.tz);
        if (obj) {
          e.obj = obj;
          e.triangles = countTriangles(tm);
          this.parent.add(obj);
          e.state = "ready";
        } else e.state = "empty";
      },
      (err: unknown) => {
        this.meshing--;
        if (this.tiles.get(k) !== e) return;
        e.state = "error";
        e.retryAt = performance.now() + 60000;
        console.warn(`mesher ${this.world.id} ${e.tx},${e.tz}:`, err);
      },
    );
  }

  private build(tm: TileMesh, tx: number, tz: number): THREE.Group | null {
    const g = new THREE.Group();
    g.name = `tile ${tx},${tz}`;
    g.position.set(tx * TILE_BLOCKS, 0, tz * TILE_BLOCKS);
    g.matrixAutoUpdate = false;
    g.updateMatrix();
    const add = (b: MeshBuffers | null, mat: THREE.Material, order: number) => {
      if (!b || b.indices.length === 0) return;
      const m = new THREE.Mesh(toGeometry(b), mat);
      m.matrixAutoUpdate = false;
      m.renderOrder = order;
      g.add(m);
    };
    add(tm.opaque, this.materials.opaque, 0);
    add(tm.cutout, this.materials.cutout, 1);
    add(tm.translucent, this.materials.translucent, 2);
    if (g.children.length === 0) return null;
    g.updateMatrixWorld(true);
    return g;
  }

  /** Release every tile (used when the radius changes drastically or on teardown). */
  clear(): void {
    for (const [k, e] of this.tiles) {
      e.abort?.abort();
      this.drop(k, e);
    }
    this.fetching = 0;
  }

  stats(): StreamStats {
    let ready = 0,
      empty = 0,
      queued = 0,
      triangles = 0;
    for (const e of this.tiles.values()) {
      if (e.state === "ready") {
        ready++;
        triangles += e.triangles;
      } else if (e.state === "empty") empty++;
      else if (e.state === "fetched") queued++;
    }
    return { ready, empty, fetching: this.fetching, meshing: this.meshing, queued, wanted: this.wanted.length, triangles };
  }
}

/** Pad a short attribute array (defensive: a short buffer makes WebGL drop the whole draw). */
function fit<T extends Float32Array | Int8Array | Uint8Array>(a: T, len: number, fill: number): T {
  if (a.length >= len) return a;
  const b = new (a.constructor as new (n: number) => T)(len);
  b.set(a);
  b.fill(fill, a.length);
  if (!warnedShort) {
    warnedShort = true;
    console.warn(`mesher returned a short attribute array (${a.length} < ${len}); padded`);
  }
  return b;
}
let warnedShort = false;

function toGeometry(b: MeshBuffers): THREE.BufferGeometry {
  const nv = b.positions.length / 3;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(b.positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(fit(b.normals, nv * 3, 0), 3, true));
  geo.setAttribute("uv", new THREE.BufferAttribute(fit(b.uvs, nv * 2, 0), 2));
  geo.setAttribute("color", new THREE.BufferAttribute(fit(b.colors, nv * 3, 255), 3, true));
  geo.setIndex(new THREE.BufferAttribute(b.indices, 1));
  geo.computeBoundingSphere();
  return geo;
}

function countTriangles(tm: TileMesh): number {
  return ((tm.opaque?.indices.length ?? 0) + (tm.cutout?.indices.length ?? 0) + (tm.translucent?.indices.length ?? 0)) / 3;
}
