// One world in one pane: its scene, root group (world -> reference transform), full-detail
// streaming and LOD quadtree.
import * as THREE from "three";
import type { WorldInfo } from "../shared/api.ts";
import type { MesherPool } from "../shared/mesh-types.ts";
import { config } from "./config.ts";
import { transformMatrix } from "./coords.ts";
import { LodManager } from "./lod.ts";
import { type BlockMaterials, createLights, LodMaterials } from "./materials.ts";
import { StreamManager } from "./tile-stream.ts";

export interface FrameParams {
  /** fallback height above ground (from the reference world) */
  hag: number;
  /** full-detail radius, reference-frame blocks */
  radius: number;
  projFactor: number;
  /** draw distance, reference-frame blocks */
  viewDist: number;
}

const UPDATE_MS = 100;

export class WorldView {
  readonly scene = new THREE.Scene();
  readonly root = new THREE.Group();
  readonly toRef: THREE.Matrix4;
  readonly toOwn: THREE.Matrix4;
  readonly scale: number;
  /** camera position in this world's own coords (updated every frame) */
  readonly camOwn = new THREE.Vector3();
  readonly stream: StreamManager;
  readonly lod: LodManager;
  private readonly lodMats = new LodMaterials();
  private nextUpdate = 0;
  private readonly _v = new THREE.Vector3();

  constructor(
    readonly info: WorldInfo,
    mesher: MesherPool,
    blockMats: BlockMaterials,
  ) {
    this.toRef = transformMatrix(info.transform);
    this.toOwn = this.toRef.clone().invert();
    this.scale = info.transform.s || 1;

    this.scene.background = new THREE.Color(config.skyColor);
    this.scene.fog = new THREE.Fog(config.skyColor, 1000, 4000);
    this.scene.add(createLights());
    this.root.name = `world ${info.id}`;
    this.root.matrixAutoUpdate = false;
    this.root.matrix.copy(this.toRef);
    this.scene.add(this.root);

    const tiles = new THREE.Group();
    tiles.name = "tiles";
    const lods = new THREE.Group();
    lods.name = "lod";
    this.root.add(tiles, lods);

    this.stream = new StreamManager(info, mesher, blockMats, tiles, {
      maxFetches: config.maxTileFetches,
      maxMeshing: Math.max(2, config.mesherWorkers),
      unloadFactor: config.unloadFactor,
    });
    this.lod = new LodManager(info, this.lodMats, lods, {
      maxFetches: config.maxLodFetches,
      cacheTiles: config.lodCacheTiles,
    });
  }

  toOwnPoint(ref: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(ref).applyMatrix4(this.toOwn);
  }

  toRefPoint(own: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(own).applyMatrix4(this.toRef);
  }

  /** Ground height (reference-frame y of the block top) under reference point (x, z), if loaded. */
  groundRef(x: number, z: number): number | null {
    const p = this.toOwnPoint(this._v.set(x, 0, z), this._v);
    const h = this.lod.heightAt(p.x, p.z);
    return h === null ? null : h + 1 + this.info.transform.ty;
  }

  /** Height of the camera above this world's ground, if known. */
  hagOwn(): number | null {
    const h = this.lod.heightAt(this.camOwn.x, this.camOwn.z);
    return h === null ? null : this.camOwn.y - (h + 1);
  }

  update(camera: THREE.Camera, f: FrameParams, now: number): void {
    this.toOwnPoint(camera.position, this.camOwn);
    const fog = this.scene.fog as THREE.Fog;
    fog.far = f.viewDist;
    fog.near = f.viewDist * 0.35;

    if (now >= this.nextUpdate) {
      this.nextUpdate = now + UPDATE_MS;
      const hag = this.hagOwn() ?? f.hag;
      const s = this.scale;
      this.stream.update(this.camOwn.x, this.camOwn.z, hag, f.radius / s, now);
      this.lod.update(
        {
          cam: this.camOwn,
          hag,
          projFactor: f.projFactor,
          pixelsPerCell: config.lodPixelsPerCell,
          viewDist: f.viewDist / s,
          coverCenter: this.stream.coverageCenter,
          coverRadius: this.stream.coverage,
        },
        now,
      );
      // LOD discard ring in the reference frame (where the shader compares positions)
      const c = this.stream.coverageCenter;
      const ref = this.toRefPoint(this._v.set(c.x, 0, c.y), this._v);
      this.lodMats.center.value.set(ref.x, ref.z);
      this.lodMats.radius.value = this.stream.coverage * s;
    }
    this.lod.build(config.lodBuildBudgetMs / 2);
  }
}
