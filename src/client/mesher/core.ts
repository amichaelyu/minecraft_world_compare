// Mesher core: DecodedTile + AssetBundle -> TileMesh. No DOM / worker APIs, so it runs in a web
// worker (worker.ts), on the main thread, or under bun for testing.

import type { AssetBundle, MeshBuffers, ModelElement, ResolvedModel, TileMesh } from "../../shared/mesh-types.ts";
import { parseState, type DecodedTile } from "../../shared/tile-format.ts";
import { resolveBlockstate, type Alternative, type PartRef } from "./blockstate.ts";
import {
  ALIASES,
  ALWAYS_WATER,
  approximate,
  INVISIBLE,
  LAVA_TEXTURE,
  MISSING_TEXTURE,
  missingCube,
  tintColor,
  WATER,
  WATER_TEXTURE,
  type FaceName,
} from "./blocks.ts";

// Directions: 0 down, 1 up, 2 north (-z), 3 south (+z), 4 west (-x), 5 east (+x)
const DIR_NAMES: FaceName[] = ["down", "up", "north", "south", "west", "east"];
const DIR_INDEX: Record<string, number> = { down: 0, up: 1, north: 2, south: 3, west: 4, east: 5 };
const OPP = [1, 0, 3, 2, 5, 4];
const DIR_VEC: [number, number, number][] = [
  [0, -1, 0],
  [0, 1, 0],
  [0, 0, -1],
  [0, 0, 1],
  [-1, 0, 0],
  [1, 0, 0],
];

// Padded tile volume: x/z in -1..64, y in -1..H. index = ((y+1)*SZ + (z+1))*SX + (x+1)
const SX = 66;
const SY = SX * SX;
const STRIDE = [1, SY, SX]; // per axis x, y, z
const DIR_OFF = DIR_VEC.map(([x, y, z]) => x + y * SY + z * SX);

const AO_CURVE = [1.0, 0.8, 0.65, 0.5];
const FLUID_HEIGHT = 14 / 16;
const EPS = 1e-4;

const enum Bucket {
  Opaque = 0,
  Cutout = 1,
  Translucent = 2,
}

const enum Fluid {
  None = 0,
  Water = 1,
  Lava = 2,
}

interface Quad {
  pos: Float32Array; // 4 x xyz, block-local 0..1
  uv: Float32Array; // 4 x uv, atlas 0..1
  nx: number; // int8-scaled normal
  ny: number;
  nz: number;
  cull: number; // direction index or -1
  r: number; // base colour 0..255 (tint * directional shade)
  g: number;
  b: number;
  bucket: Bucket;
  /** AO sampling: [front, then per vertex side1, side2, corner] volume offsets; null = no AO */
  ao: Int32Array | null;
  /** bit (v*3 + k) set when that AO sample applies */
  aoMask: number;
}

interface BlockInfo {
  /** alternatives (weighted random variants); usually one */
  alts: Quad[][];
  weights: number[] | null;
  totalWeight: number;
  /** bit d: face in direction d is fully covered by opaque geometry (culls the neighbour) */
  occlude: number;
  /** glass-like blocks and panes/bars: cull faces against a neighbour of the same block id */
  selfCull: boolean;
  /** block id, for same-block culling */
  id: string;
  fluid: Fluid;
  fluidHeight: number;
  empty: boolean;
}

const EMPTY_INFO: BlockInfo = { alts: [[]], weights: null, totalWeight: 1, occlude: 0, selfCull: false, id: "", fluid: Fluid.None, fluidHeight: 0, empty: true };
const OPAQUE_INFO: BlockInfo = { ...EMPTY_INFO, occlude: 63 };
const WATER_INFO: BlockInfo = { ...EMPTY_INFO, fluid: Fluid.Water, fluidHeight: 1 };
const LAVA_INFO: BlockInfo = { ...EMPTY_INFO, fluid: Fluid.Lava, fluidHeight: 1 };

// ---------------------------------------------------------------------------------------------
// Geometry helpers (model space 0..16)

/** Face corners in vanilla order; uv corner i = [(u0,v0),(u0,v1),(u1,v1),(u1,v0)][i]. CCW from outside. */
function faceCorners(dir: number, f: ArrayLike<number>, t: ArrayLike<number>): number[] {
  const [x0, y0, z0] = [f[0]!, f[1]!, f[2]!];
  const [x1, y1, z1] = [t[0]!, t[1]!, t[2]!];
  switch (dir) {
    case 0:
      return [x0, y0, z1, x0, y0, z0, x1, y0, z0, x1, y0, z1];
    case 1:
      return [x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0];
    case 2:
      return [x1, y1, z0, x1, y0, z0, x0, y0, z0, x0, y1, z0];
    case 3:
      return [x0, y1, z1, x0, y0, z1, x1, y0, z1, x1, y1, z1];
    case 4:
      return [x0, y1, z0, x0, y0, z0, x0, y0, z1, x0, y1, z1];
    default:
      return [x1, y1, z1, x1, y0, z1, x1, y0, z0, x1, y1, z0];
  }
}

function defaultUv(dir: number, f: ArrayLike<number>, t: ArrayLike<number>): [number, number, number, number] {
  switch (dir) {
    case 0:
      return [f[0]!, 16 - t[2]!, t[0]!, 16 - f[2]!];
    case 1:
      return [f[0]!, f[2]!, t[0]!, t[2]!];
    case 2:
      return [16 - t[0]!, 16 - t[1]!, 16 - f[0]!, 16 - f[1]!];
    case 3:
      return [f[0]!, 16 - t[1]!, t[0]!, 16 - f[1]!];
    case 4:
      return [f[2]!, 16 - t[1]!, t[2]!, 16 - f[1]!];
    default:
      return [16 - t[2]!, 16 - t[1]!, 16 - f[2]!, 16 - f[1]!];
  }
}

/** uv (0..16) for each of the 4 corners, with face texture rotation applied. */
function cornerUvs(uv: ArrayLike<number>, rotation: number): number[] {
  const c = [uv[0]!, uv[1]!, uv[0]!, uv[3]!, uv[2]!, uv[3]!, uv[2]!, uv[1]!];
  const shift = ((rotation / 90) | 0) & 3;
  const out = new Array<number>(8);
  for (let i = 0; i < 4; i++) {
    const j = (i + shift) & 3;
    out[i * 2] = c[j * 2]!;
    out[i * 2 + 1] = c[j * 2 + 1]!;
  }
  return out;
}

/** Rotate points (flat xyz, 0..16) by an element rotation in place. */
function applyElementRotation(p: number[], n: number[], rot: NonNullable<ModelElement["rotation"]>): void {
  const a = (rot.angle * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const [ox, oy, oz] = rot.origin;
  const k = rot.rescale ? 1 / Math.max(Math.abs(Math.cos(a)), 1e-3) : 1;
  const rotate = (x: number, y: number, z: number): [number, number, number] => {
    switch (rot.axis) {
      case "x":
        return [x, y * c - z * s, y * s + z * c];
      case "y":
        return [x * c + z * s, y, -x * s + z * c];
      default:
        return [x * c - y * s, x * s + y * c, z];
    }
  };
  for (let i = 0; i < p.length; i += 3) {
    let [x, y, z] = rotate(p[i]! - ox, p[i + 1]! - oy, p[i + 2]! - oz);
    if (k !== 1) {
      if (rot.axis !== "x") x *= k;
      if (rot.axis !== "y") y *= k;
      if (rot.axis !== "z") z *= k;
    }
    p[i] = x + ox;
    p[i + 1] = y + oy;
    p[i + 2] = z + oz;
  }
  const [nx, ny, nz] = rotate(n[0]!, n[1]!, n[2]!);
  n[0] = nx;
  n[1] = ny;
  n[2] = nz;
}

/** Blockstate rotation: x first then y, 90° steps, about the block centre (vanilla convention). */
function rotX(x: number, y: number, z: number, steps: number, centre: number): [number, number, number] {
  for (let i = 0; i < steps; i++) [y, z] = [z, 2 * centre - y];
  return [x, y, z];
}
function rotY(x: number, y: number, z: number, steps: number, centre: number): [number, number, number] {
  for (let i = 0; i < steps; i++) [x, z] = [2 * centre - z, x];
  return [x, y, z];
}
function rotateDir(dir: number, xs: number, ys: number): number {
  let [x, y, z] = DIR_VEC[dir]!;
  [x, y, z] = rotX(x, y, z, xs, 0);
  [x, y, z] = rotY(x, y, z, ys, 0);
  return dirFromVec(x, y, z);
}
function dirFromVec(x: number, y: number, z: number): number {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  if (ay >= ax && ay >= az) return y < 0 ? 0 : 1;
  if (az >= ax) return z < 0 ? 2 : 3;
  return x < 0 ? 4 : 5;
}
function axisAligned(x: number, y: number, z: number): boolean {
  const l = Math.hypot(x, y, z);
  return Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) / l > 1 - EPS;
}

function steps(deg: number): number {
  return ((Math.round(deg / 90) % 4) + 4) % 4;
}

function hashPos(x: number, y: number, z: number): number {
  let h = Math.imul(x, 3129871) ^ Math.imul(z, 116129781) ^ y;
  h = Math.imul(h, Math.imul(h, 42317861)) + Math.imul(h, 11);
  return (h >>> 16) & 0xffff;
}

// ---------------------------------------------------------------------------------------------
// Output buffers

function grow<T extends Float32Array | Int8Array | Uint8Array | Uint32Array>(a: T, need: number, C: new (n: number) => T): T {
  const b = new C(Math.max(need, a.length * 2));
  b.set(a as any);
  return b;
}

class BucketBuilder {
  // capacities sized in vertices (V) and indices; every array is checked on its own in ensure()
  pos = new Float32Array(16384 * 3);
  nrm = new Int8Array(16384 * 3);
  uv = new Float32Array(16384 * 2);
  col = new Uint8Array(16384 * 3);
  idx = new Uint32Array(16384 * 6 / 4);
  v = 0; // vertex count
  i = 0; // index count

  reset(): void {
    this.v = 0;
    this.i = 0;
  }

  ensure(quads: number): void {
    const verts = this.v + quads * 4;
    if (verts * 3 > this.pos.length) this.pos = grow(this.pos, verts * 3, Float32Array);
    if (verts * 3 > this.nrm.length) this.nrm = grow(this.nrm, verts * 3, Int8Array);
    if (verts * 2 > this.uv.length) this.uv = grow(this.uv, verts * 2, Float32Array);
    if (verts * 3 > this.col.length) this.col = grow(this.col, verts * 3, Uint8Array);
    const needI = this.i + quads * 6;
    if (needI > this.idx.length) this.idx = grow(this.idx, needI, Uint32Array);
  }

  finish(): MeshBuffers | null {
    if (this.v === 0) return null;
    return {
      positions: this.pos.slice(0, this.v * 3),
      normals: this.nrm.slice(0, this.v * 3),
      uvs: this.uv.slice(0, this.v * 2),
      colors: this.col.slice(0, this.v * 3),
      indices: this.idx.slice(0, this.i),
    };
  }
}

// ---------------------------------------------------------------------------------------------

export interface MeshStats {
  quads: [number, number, number];
  ms: number;
}

export class MesherCore {
  private readonly assets: AssetBundle;
  private readonly infoCache = new Map<string, BlockInfo>();
  private readonly buckets = [new BucketBuilder(), new BucketBuilder(), new BucketBuilder()];
  private vol = new Uint16Array(0);
  private readonly aw: number;
  private readonly ah: number;
  lastStats: MeshStats = { quads: [0, 0, 0], ms: 0 };

  constructor(assets: AssetBundle) {
    this.assets = assets;
    this.aw = assets.atlas.width;
    this.ah = assets.atlas.height;
  }

  // ---- block baking ------------------------------------------------------------------------

  /** Baked block info for a canonical state string (cached across tiles). */
  info(state: string): BlockInfo {
    let info = this.infoCache.get(state);
    if (!info) {
      info = this.bake(state);
      this.infoCache.set(state, info);
    }
    return info;
  }

  private bake(state: string): BlockInfo {
    const parsed = parseState(state);
    const props = parsed.props;
    const id = ALIASES[parsed.name] ?? parsed.name;
    if (INVISIBLE.has(id)) return EMPTY_INFO;
    let fluid = Fluid.None;
    let fluidHeight = FLUID_HEIGHT;
    if (id === "minecraft:lava") fluid = Fluid.Lava;
    else if (ALWAYS_WATER.has(id) || props.waterlogged === "true") fluid = Fluid.Water;
    if ((id === "minecraft:water" || id === "minecraft:lava") && props.level !== undefined) {
      const level = Number(props.level);
      if (level > 0 && level < 8) fluidHeight = Math.max(2 / 16, ((8 - level) / 8) * FLUID_HEIGHT);
    }
    const isFluidBlock = id === "minecraft:water" || id === "minecraft:lava" || id === "minecraft:bubble_column";

    const bs = this.assets.blockstates[id];
    let alts: Alternative[] | null = bs ? resolveBlockstate(bs, props) : null;
    let approxModel: ResolvedModel | null = null;
    const altQuads: Quad[][] = [];
    if (alts) for (const a of alts) altQuads.push(a.parts.flatMap((p) => this.bakePart(id, props, p, null)));
    if (!isFluidBlock && (altQuads.length === 0 || altQuads.every((q) => q.length === 0))) {
      // block-entity rendered (chests, banners, ...) or unknown: approximate or draw "missing"
      const approx = bs ? approximate(id, props) : null;
      approxModel = { elements: approx ? approx.elements : missingCube() };
      const part: PartRef = { model: "", x: 0, y: approx?.y ?? 0, uvlock: false };
      alts = [{ parts: [part], weight: 1 }];
      altQuads.length = 0;
      altQuads.push(this.bakePart(id, props, part, approxModel));
    }
    const quads0 = altQuads[0] ?? [];

    // face coverage
    let occlude = 0;
    let covered = 0;
    for (const q of quads0) {
      if (q.cull < 0 || !this.coversFace(q, q.cull)) continue;
      covered |= 1 << q.cull;
      if (q.bucket === Bucket.Opaque) occlude |= 1 << q.cull;
    }
    const isLeaves = id.endsWith("_leaves");
    // vanilla HalfTransparentBlock (glass, ice, slime...) and IronBarsBlock (panes, bars)
    const isPaneLike = /(_pane|_bars)$/.test(id);
    const weights = alts && alts.length > 1 ? alts.map((a) => a.weight) : null;
    return {
      alts: altQuads.length ? altQuads : [[]],
      weights,
      totalWeight: weights ? weights.reduce((s, w) => s + w, 0) : 1,
      occlude,
      selfCull: isPaneLike || (covered === 63 && occlude !== 63 && !isLeaves),
      id,
      fluid,
      fluidHeight,
      empty: quads0.length === 0 && fluid === Fluid.None,
    };
  }

  /** True when the quad lies on the block boundary in direction d and covers the whole face. */
  private coversFace(q: Quad, d: number): boolean {
    const vec = DIR_VEC[d]!;
    const axis = vec[0] ? 0 : vec[1] ? 1 : 2;
    const plane = vec[axis]! > 0 ? 1 : 0;
    const t1 = axis === 0 ? 1 : 0;
    const t2 = axis === 2 ? 1 : 2;
    let min1 = 1, max1 = 0, min2 = 1, max2 = 0;
    for (let v = 0; v < 4; v++) {
      if (Math.abs(q.pos[v * 3 + axis]! - plane) > EPS) return false;
      const a = q.pos[v * 3 + t1]!;
      const b = q.pos[v * 3 + t2]!;
      min1 = Math.min(min1, a);
      max1 = Math.max(max1, a);
      min2 = Math.min(min2, b);
      max2 = Math.max(max2, b);
    }
    return min1 < EPS && max1 > 1 - EPS && min2 < EPS && max2 > 1 - EPS;
  }

  private texRect(tex: string): [number, number, number, number] {
    return this.assets.textures[tex] ?? this.assets.textures[MISSING_TEXTURE] ?? [0, 0, 1, 1];
  }

  private bucketFor(tex: string): Bucket {
    const a = this.assets.textureAlpha[tex];
    return a === "translucent" ? Bucket.Translucent : a === "cutout" ? Bucket.Cutout : Bucket.Opaque;
  }

  private bakePart(id: string, props: Record<string, string>, part: PartRef, override: ResolvedModel | null): Quad[] {
    const model = override ?? this.assets.models[part.model];
    if (!model) return override ? [] : this.bakePart(id, props, part, { elements: missingCube() });
    const xs = steps(part.x);
    const ys = steps(part.y);
    const useAo = model.ambientocclusion !== false;
    const tintKind = this.assets.tints[id];
    let tint: [number, number, number] | null = null;
    const quads: Quad[] = [];
    for (const el of model.elements) {
      for (const dirName of DIR_NAMES) {
        const face = el.faces[dirName];
        if (!face) continue;
        const dir = DIR_INDEX[dirName]!;
        let p = faceCorners(dir, el.from, el.to);
        let uv = cornerUvs(face.uv, face.rotation ?? 0);
        const n = [...DIR_VEC[dir]!] as number[];
        if (el.rotation) applyElementRotation(p, n, el.rotation);
        if (xs || ys) {
          for (let i = 0; i < 12; i += 3) {
            let v = rotX(p[i]!, p[i + 1]!, p[i + 2]!, xs, 8);
            v = rotY(v[0], v[1], v[2], ys, 8);
            p[i] = v[0];
            p[i + 1] = v[1];
            p[i + 2] = v[2];
          }
          let nv = rotX(n[0]!, n[1]!, n[2]!, xs, 0);
          nv = rotY(nv[0], nv[1], nv[2], ys, 0);
          n[0] = nv[0];
          n[1] = nv[1];
          n[2] = nv[2];
          if (part.uvlock && !el.rotation) {
            // rebuild the face in its new direction with world-aligned default uvs
            const nd = rotateDir(dir, xs, ys);
            const f = [Math.min(p[0]!, p[3]!, p[6]!, p[9]!), Math.min(p[1]!, p[4]!, p[7]!, p[10]!), Math.min(p[2]!, p[5]!, p[8]!, p[11]!)];
            const t = [Math.max(p[0]!, p[3]!, p[6]!, p[9]!), Math.max(p[1]!, p[4]!, p[7]!, p[10]!), Math.max(p[2]!, p[5]!, p[8]!, p[11]!)];
            p = faceCorners(nd, f, t);
            uv = cornerUvs(defaultUv(nd, f, t), face.rotation ?? 0);
          }
        }
        // drop degenerate faces
        const ex = [p[3]! - p[0]!, p[4]! - p[1]!, p[5]! - p[2]!];
        const ey = [p[9]! - p[0]!, p[10]! - p[1]!, p[11]! - p[2]!];
        const cross = Math.hypot(ex[1]! * ey[2]! - ex[2]! * ey[1]!, ex[2]! * ey[0]! - ex[0]! * ey[2]!, ex[0]! * ey[1]! - ex[1]! * ey[0]!);
        if (cross < 1e-6) continue;

        const nl = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
        const nx = n[0]! / nl;
        const ny = n[1]! / nl;
        const nz = n[2]! / nl;
        const shade = el.shade === false ? 1 : nx * nx * 0.6 + nz * nz * 0.8 + ny * ny * (ny > 0 ? 1 : 0.5);
        let r = 255 * shade;
        let g = 255 * shade;
        let b = 255 * shade;
        if (face.tintindex !== undefined && face.tintindex >= 0 && tintKind) {
          tint ??= tintColor(tintKind, id, props);
          r = (r * tint[0]) / 255;
          g = (g * tint[1]) / 255;
          b = (b * tint[2]) / 255;
        }
        const [rx, ry, rw, rh] = this.texRect(face.texture);
        const pos = new Float32Array(12);
        for (let i = 0; i < 12; i++) pos[i] = p[i]! / 16;
        const auv = new Float32Array(8);
        for (let i = 0; i < 4; i++) {
          auv[i * 2] = (rx + (uv[i * 2]! / 16) * rw) / this.aw;
          auv[i * 2 + 1] = (ry + (uv[i * 2 + 1]! / 16) * rh) / this.ah;
        }
        let cull = face.cullface ? rotateDir(DIR_INDEX[face.cullface]!, xs, ys) : -1;
        // A face lying on the block boundary and facing out is hidden whenever the neighbour
        // occludes it, even if the model gave it no cullface (pane tops, post ends, ...).
        if (cull < 0 && axisAligned(nx, ny, nz)) {
          const d = dirFromVec(nx, ny, nz);
          const vec = DIR_VEC[d]!;
          const axis = vec[0] ? 0 : vec[1] ? 1 : 2;
          const plane = vec[axis]! > 0 ? 16 : 0;
          if (Math.abs(p[axis]! - plane) < EPS && Math.abs(p[axis + 3]! - plane) < EPS && Math.abs(p[axis + 6]! - plane) < EPS && Math.abs(p[axis + 9]! - plane) < EPS) cull = d;
        }
        const q: Quad = {
          pos,
          uv: auv,
          nx: Math.round(nx * 127),
          ny: Math.round(ny * 127),
          nz: Math.round(nz * 127),
          cull,
          r,
          g,
          b,
          bucket: this.bucketFor(face.texture),
          ao: null,
          aoMask: 0,
        };
        if (useAo && axisAligned(nx, ny, nz)) this.setupAo(q, dirFromVec(nx, ny, nz));
        quads.push(q);
      }
    }
    return quads;
  }

  /** Vanilla-style 3-sample AO: front cell + side/side/corner per vertex, for vertices on block edges. */
  private setupAo(q: Quad, d: number): void {
    const vec = DIR_VEC[d]!;
    const axis = vec[0] ? 0 : vec[1] ? 1 : 2;
    const planeVal = q.pos[axis]!;
    const boundary = vec[axis]! > 0 ? planeVal > 1 - EPS : planeVal < EPS;
    const front = boundary ? DIR_OFF[d]! : 0;
    const t1 = axis === 0 ? 1 : 0;
    const t2 = axis === 2 ? 1 : 2;
    const ao = new Int32Array(13);
    ao[0] = front;
    let mask = 0;
    for (let v = 0; v < 4; v++) {
      const a = q.pos[v * 3 + t1]!;
      const b = q.pos[v * 3 + t2]!;
      const s1 = a < EPS ? -1 : a > 1 - EPS ? 1 : 0;
      const s2 = b < EPS ? -1 : b > 1 - EPS ? 1 : 0;
      const o1 = s1 * STRIDE[t1]!;
      const o2 = s2 * STRIDE[t2]!;
      ao[1 + v * 3] = front + o1;
      ao[2 + v * 3] = front + o2;
      ao[3 + v * 3] = front + o1 + o2;
      if (s1) mask |= 1 << (v * 3);
      if (s2) mask |= 1 << (v * 3 + 1);
      if (s1 && s2) mask |= 1 << (v * 3 + 2);
    }
    if (mask) {
      q.ao = ao;
      q.aoMask = mask;
    }
  }

  // ---- tile meshing --------------------------------------------------------------------------

  meshTile(tile: DecodedTile): TileMesh {
    const t0 = performance.now();
    const H = tile.numSections * 16;
    const P = tile.palette.length;
    const IDX_OPAQUE = P;
    const IDX_WATER = P + 1;
    const IDX_LAVA = P + 2;
    const infos: BlockInfo[] = new Array(P + 3);
    for (let i = 0; i < P; i++) infos[i] = this.info(tile.palette[i]!);
    infos[IDX_OPAQUE] = OPAQUE_INFO;
    infos[IDX_WATER] = WATER_INFO;
    infos[IDX_LAVA] = LAVA_INFO;
    const n = P + 3;
    const occ = new Uint8Array(n);
    const aoOcc = new Uint8Array(n);
    const fluidOf = new Uint8Array(n);
    const empty = new Uint8Array(n);
    const sameBlock = new Int32Array(n);
    const blockKeys = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const inf = infos[i]!;
      occ[i] = inf.occlude;
      aoOcc[i] = inf.occlude === 63 ? 1 : 0;
      fluidOf[i] = inf.fluid;
      empty[i] = inf.empty ? 1 : 0;
      let key = blockKeys.get(inf.id);
      if (key === undefined) blockKeys.set(inf.id, (key = blockKeys.size + 1));
      sameBlock[i] = inf.id ? key : -1 - i;
    }

    // fill padded volume
    const volSize = SY * (H + 2);
    if (this.vol.length !== volSize) this.vol = new Uint16Array(volSize);
    const vol = this.vol;
    vol.fill(0);
    for (let c = 0; c < 16; c++) {
      const secs = tile.chunks[c];
      if (!secs) continue;
      const lx = (c & 3) * 16;
      const lz = (c >> 2) * 16;
      for (let s = 0; s < secs.length; s++) {
        const sec = secs[s]!;
        if (sec.kind === 0) continue;
        for (let y = 0; y < 16; y++) {
          const yb = (s * 16 + y + 1) * SY;
          for (let z = 0; z < 16; z++) {
            const base = yb + (lz + z + 1) * SX + lx + 1;
            if (sec.kind === 1) vol.fill(sec.index, base, base + 16);
            else vol.set(sec.data.subarray(y * 256 + z * 16, y * 256 + z * 16 + 16), base);
          }
        }
      }
    }
    // bottom of the world: treat as solid
    vol.fill(IDX_OPAQUE, 0, SY);
    this.fillEdges(vol, H, aoOcc, fluidOf, IDX_OPAQUE, IDX_WATER, IDX_LAVA);

    for (const b of this.buckets) b.reset();
    const quadCount: [number, number, number] = [0, 0, 0];
    const baseX = tile.tx * 64;
    const baseZ = tile.tz * 64;
    const minY = tile.minSectionY * 16;
    const aoVals = [1, 1, 1, 1];

    for (let c = 0; c < 16; c++) {
      const secs = tile.chunks[c];
      if (!secs) continue;
      const lx = (c & 3) * 16;
      const lz = (c >> 2) * 16;
      for (let s = 0; s < secs.length; s++) {
        const sec = secs[s]!;
        if (sec.kind === 0 || (sec.kind === 1 && empty[sec.index])) continue;
        for (let y = 0; y < 16; y++) {
          const wy = s * 16 + y;
          for (let z = 0; z < 16; z++) {
            const rowBase = (wy + 1) * SY + (lz + z + 1) * SX + lx + 1;
            for (let x = 0; x < 16; x++) {
              const vi = rowBase + x;
              const pi = vol[vi]!;
              if (empty[pi]) continue;
              const o = occ[pi]!;
              if (
                o === 63 &&
                occ[vol[vi - SY]!]! & 2 &&
                occ[vol[vi + SY]!]! & 1 &&
                occ[vol[vi - SX]!]! & 8 &&
                occ[vol[vi + SX]!]! & 4 &&
                occ[vol[vi - 1]!]! & 32 &&
                occ[vol[vi + 1]!]! & 16
              )
                continue;
              const info = infos[pi]!;
              const bx = lx + x;
              const by = minY + wy;
              const bz = lz + z;
              let quads = info.alts[0]!;
              if (info.weights) {
                let h = hashPos(baseX + bx, by, baseZ + bz) % info.totalWeight;
                for (let k = 0; k < info.weights.length; k++) {
                  h -= info.weights[k]!;
                  if (h < 0) {
                    quads = info.alts[k]!;
                    break;
                  }
                }
              }
              for (let qi = 0; qi < quads.length; qi++) {
                const q = quads[qi]!;
                if (q.cull >= 0) {
                  const nb = vol[vi + DIR_OFF[q.cull]!]!;
                  if ((occ[nb]! >> OPP[q.cull]!) & 1) continue;
                  if (info.selfCull && (nb === pi || sameBlock[nb] === sameBlock[pi])) continue;
                }
                let flip = false;
                if (q.ao) {
                  const ao = q.ao;
                  const m = q.aoMask;
                  for (let v = 0; v < 4; v++) {
                    const s1 = m & (1 << (v * 3)) ? aoOcc[vol[vi + ao[1 + v * 3]!]!]! : 0;
                    const s2 = m & (1 << (v * 3 + 1)) ? aoOcc[vol[vi + ao[2 + v * 3]!]!]! : 0;
                    const cn = m & (1 << (v * 3 + 2)) ? aoOcc[vol[vi + ao[3 + v * 3]!]!]! : 0;
                    aoVals[v] = AO_CURVE[s1 && s2 ? 3 : s1 + s2 + cn]!;
                  }
                  flip = aoVals[0]! + aoVals[2]! < aoVals[1]! + aoVals[3]!;
                } else {
                  aoVals[0] = aoVals[1] = aoVals[2] = aoVals[3] = 1;
                }
                const bk = this.buckets[q.bucket]!;
                quadCount[q.bucket]++;
                bk.ensure(1);
                const v0 = bk.v;
                const p3 = v0 * 3;
                const p2 = v0 * 2;
                for (let v = 0; v < 4; v++) {
                  const k = p3 + v * 3;
                  bk.pos[k] = bx + q.pos[v * 3]!;
                  bk.pos[k + 1] = by + q.pos[v * 3 + 1]!;
                  bk.pos[k + 2] = bz + q.pos[v * 3 + 2]!;
                  bk.nrm[k] = q.nx;
                  bk.nrm[k + 1] = q.ny;
                  bk.nrm[k + 2] = q.nz;
                  const a = aoVals[v]!;
                  bk.col[k] = q.r * a;
                  bk.col[k + 1] = q.g * a;
                  bk.col[k + 2] = q.b * a;
                  bk.uv[p2 + v * 2] = q.uv[v * 2]!;
                  bk.uv[p2 + v * 2 + 1] = q.uv[v * 2 + 1]!;
                }
                pushIndices(bk, v0, flip);
                bk.v += 4;
              }
              if (info.fluid !== Fluid.None) this.emitFluid(vol, vi, info, fluidOf, occ, bx, by, bz, quadCount);
            }
          }
        }
      }
    }

    const mesh: TileMesh = {
      tx: tile.tx,
      tz: tile.tz,
      opaque: this.buckets[0]!.finish(),
      cutout: this.buckets[1]!.finish(),
      translucent: this.buckets[2]!.finish(),
    };
    this.lastStats = { quads: quadCount, ms: performance.now() - t0 };
    return mesh;
  }

  /**
   * Tile-edge padding. Out-of-tile neighbours are unknown; treat them as solid well below the
   * local surface (so underground faces along tile borders are culled), as the same fluid where
   * the edge cell is a fluid (no water walls at tile borders), and as air otherwise.
   */
  private fillEdges(vol: Uint16Array, H: number, aoOcc: Uint8Array, fluidOf: Uint8Array, IDX_OPAQUE: number, IDX_WATER: number, IDX_LAVA: number): void {
    const top = new Int32Array(64);
    const surf = new Int32Array(64);
    // side: 0 west (x=-1), 1 east (x=64), 2 north (z=-1), 3 south (z=64)
    for (let side = 0; side < 4; side++) {
      const edgeCell = (i: number, y: number): number => {
        const x = side === 0 ? 0 : side === 1 ? 63 : i;
        const z = side === 2 ? 0 : side === 3 ? 63 : i;
        return (y + 1) * SY + (z + 1) * SX + x + 1;
      };
      const padCell = (i: number, y: number): number => {
        const x = side === 0 ? -1 : side === 1 ? 64 : i;
        const z = side === 2 ? -1 : side === 3 ? 64 : i;
        return (y + 1) * SY + (z + 1) * SX + x + 1;
      };
      for (let i = 0; i < 64; i++) {
        let y = H - 1;
        while (y >= 0 && !aoOcc[vol[edgeCell(i, y)]!]) y--;
        top[i] = y;
      }
      for (let i = 0; i < 64; i++) {
        let m = Infinity;
        for (let j = Math.max(0, i - 4); j <= Math.min(63, i + 4); j++) m = Math.min(m, top[j]!);
        surf[i] = m - 4;
      }
      for (let i = 0; i < 64; i++) {
        const s = surf[i]!;
        for (let y = 0; y < H; y++) {
          if (y < s) vol[padCell(i, y)] = IDX_OPAQUE;
          else {
            const f = fluidOf[vol[edgeCell(i, y)]!]!;
            if (f === Fluid.Water) vol[padCell(i, y)] = IDX_WATER;
            else if (f === Fluid.Lava) vol[padCell(i, y)] = IDX_LAVA;
          }
        }
      }
    }
  }

  private emitFluid(
    vol: Uint16Array,
    vi: number,
    info: BlockInfo,
    fluidOf: Uint8Array,
    occ: Uint8Array,
    bx: number,
    by: number,
    bz: number,
    quadCount: [number, number, number],
  ): void {
    const fluid = info.fluid;
    const h = fluidOf[vol[vi + SY]!] === fluid ? 1 : info.fluidHeight;
    const water = fluid === Fluid.Water;
    const bucket = water ? Bucket.Translucent : Bucket.Opaque;
    const bk = this.buckets[bucket]!;
    const [rx, ry, rw, rh] = this.texRect(water ? WATER_TEXTURE : LAVA_TEXTURE);
    const from = [0, 0, 0];
    const to = [16, h * 16, 16];
    for (let d = 0; d < 6; d++) {
      const nb = vol[vi + DIR_OFF[d]!]!;
      if (fluidOf[nb] === fluid) continue;
      if ((occ[nb]! >> OPP[d]!) & 1) continue;
      const p = faceCorners(d, from, to);
      const uv = cornerUvs(defaultUv(d, from, to), 0);
      const [nx, ny, nz] = DIR_VEC[d]!;
      const shade = water ? [0.5, 1, 0.8, 0.8, 0.6, 0.6][d]! : 1;
      const r = water ? WATER[0] * shade : 255;
      const g = water ? WATER[1] * shade : 255;
      const b = water ? WATER[2] * shade : 255;
      bk.ensure(1);
      const v0 = bk.v;
      for (let v = 0; v < 4; v++) {
        const k = (v0 + v) * 3;
        bk.pos[k] = bx + p[v * 3]! / 16;
        bk.pos[k + 1] = by + p[v * 3 + 1]! / 16;
        bk.pos[k + 2] = bz + p[v * 3 + 2]! / 16;
        bk.nrm[k] = nx * 127;
        bk.nrm[k + 1] = ny * 127;
        bk.nrm[k + 2] = nz * 127;
        bk.col[k] = r;
        bk.col[k + 1] = g;
        bk.col[k + 2] = b;
        const k2 = (v0 + v) * 2;
        bk.uv[k2] = (rx + (uv[v * 2]! / 16) * rw) / this.aw;
        bk.uv[k2 + 1] = (ry + (uv[v * 2 + 1]! / 16) * rh) / this.ah;
      }
      pushIndices(bk, v0, false);
      bk.v += 4;
      quadCount[bucket]++;
    }
  }
}

function pushIndices(bk: BucketBuilder, v0: number, flip: boolean): void {
  const ix = bk.idx;
  const i = bk.i;
  if (flip) {
    ix[i] = v0 + 1;
    ix[i + 1] = v0 + 2;
    ix[i + 2] = v0 + 3;
    ix[i + 3] = v0 + 1;
    ix[i + 4] = v0 + 3;
    ix[i + 5] = v0;
  } else {
    ix[i] = v0;
    ix[i + 1] = v0 + 1;
    ix[i + 2] = v0 + 2;
    ix[i + 3] = v0;
    ix[i + 4] = v0 + 2;
    ix[i + 5] = v0 + 3;
  }
  bk.i = i + 6;
}

/** Transferable buffers of a TileMesh (for postMessage). */
export function meshTransferables(mesh: TileMesh): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const b of [mesh.opaque, mesh.cutout, mesh.translucent]) {
    if (!b) continue;
    out.push(b.positions.buffer as ArrayBuffer, b.normals.buffer as ArrayBuffer, b.uvs.buffer as ArrayBuffer, b.colors.buffer as ArrayBuffer, b.indices.buffer as ArrayBuffer);
  }
  return out;
}
