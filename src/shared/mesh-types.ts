// Contract between the asset pipeline, the mesher workers and the viewer.

/** One geometry bucket. Positions are tile-local on x/z (0..64) and absolute block y. */
export interface MeshBuffers {
  positions: Float32Array; // xyz
  normals: Int8Array; // xyz, unit axis-aligned (or rotated element normals, scaled to 127)
  uvs: Float32Array; // atlas uv, 0..1, v down (flipY=false on the texture)
  colors: Uint8Array; // rgb: tint * AO/shade, 255 = unmodified
  indices: Uint32Array;
}

export interface TileMesh {
  tx: number;
  tz: number;
  opaque: MeshBuffers | null;
  cutout: MeshBuffers | null; // alphaTest 0.5, double-sided where the model needs it
  translucent: MeshBuffers | null; // water, stained glass, ice: blended, depthWrite off
}

export interface ModelFace {
  uv: [number, number, number, number]; // in 0..16 model space (already defaulted from element bounds)
  texture: string; // resolved texture id, key into AssetBundle.textures
  cullface?: "down" | "up" | "north" | "south" | "west" | "east";
  rotation?: 0 | 90 | 180 | 270;
  tintindex?: number;
}

export interface ModelElement {
  from: [number, number, number];
  to: [number, number, number];
  rotation?: { origin: [number, number, number]; axis: "x" | "y" | "z"; angle: number; rescale?: boolean };
  shade?: boolean;
  faces: Partial<Record<"down" | "up" | "north" | "south" | "west" | "east", ModelFace>>;
}

export interface ResolvedModel {
  ambientocclusion?: boolean;
  elements: ModelElement[];
}

export interface AssetBundle {
  version: string; // e.g. "26.2"
  atlas: { width: number; height: number; file: string }; // file relative to /assets/
  /** texture id ("minecraft:block/stone") -> atlas rect in pixels [x, y, w, h]; first animation frame only */
  textures: Record<string, [number, number, number, number]>;
  /** texture ids whose pixels include alpha < 255 (cutout) or partial alpha (translucent) */
  textureAlpha: Record<string, "cutout" | "translucent">;
  /** model id ("minecraft:block/oak_stairs") -> parent chain + texture variables resolved */
  models: Record<string, ResolvedModel>;
  /** block id ("minecraft:oak_stairs") -> raw blockstate JSON from the jar (variants | multipart) */
  blockstates: Record<string, unknown>;
  /** block id -> tint kind for tintindex >= 0 */
  tints: Record<string, "grass" | "foliage" | "water" | "redstone" | "fixed">;
  /** block id -> average top-face colour [r,g,b] 0..255, tint applied (used by LOD tiles) */
  colors: Record<string, [number, number, number]>;
}

export interface MesherPool {
  mesh(blob: ArrayBuffer): Promise<TileMesh>; // blob = uncompressed MCT1
  dispose(): void;
}

export declare function createMesherPool(assets: AssetBundle, workers: number): MesherPool;
