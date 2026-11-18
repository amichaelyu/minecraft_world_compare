// Shared API types.

/** Maps a world's own block coords to the reference frame (world A). */
export interface WorldTransform {
  s: number; // uniform XZ scale
  thetaDeg: number; // XZ rotation, degrees, [x',z'] = s*R*[x,z] + t
  tx: number;
  tz: number;
  ty: number; // y' = y + ty
}

export interface WorldInfo {
  id: string; // url-safe, e.g. "sf", "arnis"
  name: string;
  /** inclusive block bounds in the world's OWN coords, from the region files present */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number; minY: number; maxY: number };
  spawn: { x: number; y: number; z: number };
  transform: WorldTransform;
  /** highest LOD level available (tile covers 128*2^L blocks) */
  maxLod: number;
}

export const TILE_CHUNKS = 4; // tile = 4x4 chunks
export const TILE_BLOCKS = 64;
export const LOD_CELLS = 128; // LOD tile = 128x128 cells
export const LOD_NO_DATA = -32768;
