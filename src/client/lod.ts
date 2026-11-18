// LOD heightfield quadtree for one world. Tiles at level L cover 128*2^L blocks; the level is
// chosen so one cell projects to roughly `pixelsPerCell` pixels. A node is replaced by its
// children only once all of them are loaded, so the coarse level stays up while finer tiles
// stream in and there are no holes.
import * as THREE from "three";
import { LOD_CELLS, LOD_NO_DATA, type WorldInfo } from "../shared/api.ts";
import { decodeLod } from "../shared/tile-format.ts";
import { dataUrl } from "./config.ts";
import { rectDistance } from "./coords.ts";
import { buildLodMesh, validHeights } from "./lod-mesh.ts";
import type { LodMaterials } from "./materials.ts";

type NodeState = "new" | "loading" | "decoded" | "ready" | "empty" | "error";

interface LodNode {
  L: number;
  tx: number;
  tz: number;
  key: string;
  x0: number;
  z0: number;
  size: number;
  state: NodeState;
  mesh: THREE.Mesh | null;
  heights: Int16Array | null;
  pending: ReturnType<typeof decodeLod> | null;
  lastUsed: number;
  retryAt: number;
  triangles: number;
}

export interface LodView {
  /** camera in the world's own coords */
  cam: THREE.Vector3;
  /** camera height above ground */
  hag: number;
  /** pixels per block at distance 1 */
  projFactor: number;
  pixelsPerCell: number;
  /** nodes beyond this (own-coords) distance are not drawn */
  viewDist: number;
  /** full-detail coverage circle (own coords) — nodes entirely inside it are hidden */
  coverCenter: THREE.Vector2;
  coverRadius: number;
}

export interface LodStats {
  shown: number;
  loaded: number;
  loading: number;
  building: number;
  triangles: number;
}

const settled = (n: LodNode) => n.state === "ready" || n.state === "empty" || n.state === "error";

export class LodManager {
  private readonly nodes = new Map<string, LodNode>();
  private shown = new Set<LodNode>();
  private readonly buildQueue: LodNode[] = [];
  private loading = 0;
  private readonly roots: LodNode[] = [];
  private readonly maxLod: number;

  constructor(
    private readonly world: WorldInfo,
    private readonly materials: LodMaterials,
    private readonly parent: THREE.Object3D,
    private readonly opts: { maxFetches: number; cacheTiles: number },
  ) {
    this.maxLod = Math.max(0, world.maxLod | 0);
    const S = LOD_CELLS * 2 ** this.maxLod;
    const b = world.bounds;
    for (let tz = Math.floor(b.minZ / S); tz <= Math.floor(b.maxZ / S); tz++)
      for (let tx = Math.floor(b.minX / S); tx <= Math.floor(b.maxX / S); tx++) this.roots.push(this.node(this.maxLod, tx, tz));
  }

  private node(L: number, tx: number, tz: number): LodNode {
    const key = `${L}/${tx}/${tz}`;
    let n = this.nodes.get(key);
    if (!n) {
      const size = LOD_CELLS * 2 ** L;
      n = {
        L, tx, tz, key, x0: tx * size, z0: tz * size, size,
        state: "new", mesh: null, heights: null, pending: null, lastUsed: 0, retryAt: 0, triangles: 0,
      };
      this.nodes.set(key, n);
    }
    return n;
  }

  private inBounds(L: number, tx: number, tz: number): boolean {
    const size = LOD_CELLS * 2 ** L;
    const b = this.world.bounds;
    return tx * size <= b.maxX && (tx + 1) * size > b.minX && tz * size <= b.maxZ && (tz + 1) * size > b.minZ;
  }

  update(v: LodView, now: number): void {
    const want: { n: LodNode; d: number }[] = [];
    const next = new Set<LodNode>();
    const dv = Math.max(0, v.hag);
    const splitK = v.projFactor / v.pixelsPerCell;

    const request = (n: LodNode, d: number) => {
      if (n.state === "new" || (n.state === "error" && now >= n.retryAt)) want.push({ n, d });
    };
    const dist = (n: LodNode) => {
      const dh = rectDistance(v.cam.x, v.cam.z, n.x0, n.z0, n.x0 + n.size, n.z0 + n.size);
      return Math.sqrt(dh * dh + dv * dv);
    };
    const visit = (n: LodNode, d: number) => {
      n.lastUsed = now;
      if (n.state === "empty") return;
      if (n.L > 0 && 2 ** n.L * splitK > d) {
        const kids: { k: LodNode; dk: number }[] = [];
        let all = true;
        for (let j = 0; j < 2; j++)
          for (let i = 0; i < 2; i++) {
            const tx = n.tx * 2 + i, tz = n.tz * 2 + j;
            if (!this.inBounds(n.L - 1, tx, tz)) continue;
            const k = this.node(n.L - 1, tx, tz);
            const dk = dist(k);
            if (dk > v.viewDist) continue;
            k.lastUsed = now;
            kids.push({ k, dk });
            if (!settled(k)) {
              all = false;
              request(k, dk);
            }
          }
        if (all) {
          for (const { k, dk } of kids) visit(k, dk);
          return;
        }
      }
      request(n, d);
      if (n.state === "ready" && n.mesh) next.add(n);
    };
    for (const r of this.roots) {
      const d = dist(r);
      if (d <= v.viewDist) visit(r, d);
    }

    // Visibility: selected, and not entirely inside the loaded full-detail circle.
    for (const n of this.shown) if (!next.has(n)) n.mesh!.visible = false;
    for (const n of next) {
      const fx = Math.max(Math.abs(n.x0 - v.coverCenter.x), Math.abs(n.x0 + n.size - v.coverCenter.x));
      const fz = Math.max(Math.abs(n.z0 - v.coverCenter.y), Math.abs(n.z0 + n.size - v.coverCenter.y));
      n.mesh!.visible = Math.sqrt(fx * fx + fz * fz) > v.coverRadius;
    }
    this.shown = next;

    // Fetch: coarse levels first, then nearest.
    want.sort((a, b) => b.n.L - a.n.L || a.d - b.d);
    for (const { n } of want) {
      if (this.loading >= this.opts.maxFetches) break;
      this.fetch(n);
    }

    this.evict(now);
  }

  private fetch(n: LodNode): void {
    n.state = "loading";
    this.loading++;
    fetch(dataUrl(`${this.world.id}/lod/${n.L}/${n.tx}/${n.tz}.bin`))
      .then(async (res) => {
        if (res.status === 204 || res.status === 404) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        return buf.byteLength ? decodeLod(buf) : null;
      })
      .then(
        (lod) => {
          this.loading--;
          if (this.nodes.get(n.key) !== n) return;
          if (!lod) n.state = "empty";
          else {
            n.state = "decoded";
            n.pending = lod;
            this.buildQueue.push(n);
          }
        },
        (err: unknown) => {
          this.loading--;
          if (this.nodes.get(n.key) !== n) return;
          n.state = "error";
          n.retryAt = performance.now() + 10000;
          console.warn(`lod ${this.world.id} ${n.key}:`, err);
        },
      );
  }

  /** Build queued meshes within a time budget (call once per frame). */
  build(budgetMs: number): void {
    const t0 = performance.now();
    while (this.buildQueue.length && performance.now() - t0 < budgetMs) {
      const n = this.buildQueue.shift()!;
      const lod = n.pending;
      n.pending = null;
      if (this.nodes.get(n.key) !== n || !lod) continue;
      const H = validHeights(lod);
      const m = buildLodMesh(lod, H);
      n.heights = H;
      if (!m) {
        n.state = "empty";
        continue;
      }
      const mesh = new THREE.Mesh(m.geometry, this.materials.create(m.texture));
      mesh.name = `lod ${n.key}`;
      mesh.position.set(n.x0, 0, n.z0);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.visible = false;
      this.parent.add(mesh);
      mesh.updateMatrixWorld();
      n.mesh = mesh;
      n.triangles = m.geometry.index!.count / 3;
      n.state = "ready";
    }
  }

  private evict(now: number): void {
    const excess = this.nodes.size - this.shown.size - this.opts.cacheTiles;
    if (excess <= 0) return;
    const old = [...this.nodes.values()]
      .filter((n) => n.lastUsed < now && (settled(n) || n.state === "new"))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (let i = 0; i < Math.min(excess, old.length); i++) this.dispose(old[i]!);
  }

  private dispose(n: LodNode): void {
    if (n.mesh) {
      this.parent.remove(n.mesh);
      n.mesh.geometry.dispose();
      const mat = n.mesh.material as THREE.MeshLambertMaterial;
      mat.map?.dispose();
      mat.dispose();
      n.mesh = null;
    }
    this.shown.delete(n);
    this.nodes.delete(n.key);
  }

  /** Ground height (top block y) at own-coords (x, z) from the finest loaded level, or null. */
  heightAt(x: number, z: number): number | null {
    for (let L = 0; L <= this.maxLod; L++) {
      const c = 2 ** L;
      const size = LOD_CELLS * c;
      const tx = Math.floor(x / size), tz = Math.floor(z / size);
      const n = this.nodes.get(`${L}/${tx}/${tz}`);
      if (!n?.heights) continue;
      const cx = Math.floor((x - tx * size) / c), cz = Math.floor((z - tz * size) / c);
      const h = n.heights[cz * LOD_CELLS + cx]!;
      if (h !== LOD_NO_DATA) return h;
    }
    return null;
  }

  stats(): LodStats {
    let loaded = 0, triangles = 0, shown = 0;
    for (const n of this.nodes.values()) if (n.state === "ready") loaded++;
    for (const n of this.shown) {
      if (n.mesh?.visible) {
        shown++;
        triangles += n.triangles;
      }
    }
    return { shown, loaded, loading: this.loading, building: this.buildQueue.length, triangles };
  }

  clear(): void {
    for (const n of [...this.nodes.values()]) this.dispose(n);
  }
}
