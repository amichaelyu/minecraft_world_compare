// Block tables shared by the mesher and scripts/build-assets.ts: invisible blocks, tint colours,
// and box approximations for blocks that vanilla draws with a block-entity renderer (their block
// models have no elements). Pure data + functions, no DOM / Node imports.

import type { ModelElement, ModelFace } from "../../shared/mesh-types.ts";

export type Rgb = [number, number, number];
export type FaceName = "down" | "up" | "north" | "south" | "west" | "east";
export type TintKind = "grass" | "foliage" | "water" | "redstone" | "fixed";

/** Blocks that never produce geometry. */
export const INVISIBLE = new Set([
  "minecraft:air",
  "minecraft:cave_air",
  "minecraft:void_air",
  "minecraft:light",
  "minecraft:barrier",
  "minecraft:structure_void",
  "minecraft:moving_piston",
]);

/** Old block ids still written by some generators -> current 26.x ids. */
export const ALIASES: Record<string, string> = {
  "minecraft:chain": "minecraft:iron_chain",
  "minecraft:grass": "minecraft:short_grass",
  "minecraft:grass_path": "minecraft:dirt_path",
};

/** Blocks that are always filled with water (no waterlogged property). */
export const ALWAYS_WATER = new Set([
  "minecraft:water",
  "minecraft:bubble_column",
  "minecraft:seagrass",
  "minecraft:tall_seagrass",
  "minecraft:kelp",
  "minecraft:kelp_plant",
]);

export const MISSING_TEXTURE = "minecraft:missing";
export const WATER_TEXTURE = "minecraft:block/water_still";
export const LAVA_TEXTURE = "minecraft:block/lava_still";

export const GRASS: Rgb = [0x79, 0xc0, 0x5a];
export const FOLIAGE: Rgb = [0x59, 0xae, 0x30];
export const WATER: Rgb = [0x3f, 0x76, 0xe4];
const BIRCH: Rgb = [0x80, 0xa7, 0x55];
const SPRUCE: Rgb = [0x61, 0x99, 0x61];
const LILY_PAD: Rgb = [0x20, 0x80, 0x30];
const DRY_FOLIAGE: Rgb = [0xa0, 0x7a, 0x48];
const WHITE: Rgb = [255, 255, 255];

const GRASS_TINTED = new Set(
  ["grass_block", "short_grass", "tall_grass", "grass", "fern", "large_fern", "potted_fern", "sugar_cane", "bush", "pink_petals", "wildflowers"].map((s) => `minecraft:${s}`),
);
const FOLIAGE_TINTED = new Set(
  ["oak_leaves", "jungle_leaves", "acacia_leaves", "dark_oak_leaves", "mangrove_leaves", "vine"].map((s) => `minecraft:${s}`),
);
const WATER_TINTED = new Set(["minecraft:water", "minecraft:bubble_column", "minecraft:water_cauldron"]);
const FIXED_TINTED = new Set(
  ["birch_leaves", "spruce_leaves", "lily_pad", "melon_stem", "pumpkin_stem", "attached_melon_stem", "attached_pumpkin_stem", "leaf_litter"].map(
    (s) => `minecraft:${s}`,
  ),
);

/** Blocks whose models carry tintindex but that vanilla draws untinted (no colour provider). */
export const UNTINTED = new Set(
  ["bamboo", "bamboo_sapling", "cherry_leaves", "pale_oak_leaves", "azalea_leaves", "flowering_azalea_leaves", "lava_cauldron", "powder_snow_cauldron", "cauldron", "stonecutter"].map(
    (s) => `minecraft:${s}`,
  ),
);

/** Tint kind for a block whose model has tintindex faces; undefined when vanilla doesn't tint it. */
export function tintKindFor(id: string): TintKind | undefined {
  if (GRASS_TINTED.has(id)) return "grass";
  if (FOLIAGE_TINTED.has(id)) return "foliage";
  if (WATER_TINTED.has(id)) return "water";
  if (id === "minecraft:redstone_wire") return "redstone";
  if (FIXED_TINTED.has(id)) return "fixed";
  return undefined;
}

export function redstoneColor(power: number): Rgb {
  const f = power / 15;
  const r = f * 0.6 + (f > 0 ? 0.4 : 0.3);
  const g = Math.max(0, Math.min(1, f * f * 0.7 - 0.5));
  const b = Math.max(0, Math.min(1, f * f * 0.6 - 0.7));
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function fixedColor(id: string, props: Record<string, string>): Rgb {
  switch (id) {
    case "minecraft:birch_leaves":
      return BIRCH;
    case "minecraft:spruce_leaves":
      return SPRUCE;
    case "minecraft:lily_pad":
      return LILY_PAD;
    case "minecraft:leaf_litter":
      return DRY_FOLIAGE;
    case "minecraft:attached_melon_stem":
    case "minecraft:attached_pumpkin_stem":
      return [224, 199, 28];
    case "minecraft:melon_stem":
    case "minecraft:pumpkin_stem": {
      const age = Number(props.age ?? 7);
      return [age * 32, 255 - age * 8, age * 4];
    }
  }
  return WHITE;
}

/** Tint colour for tintindex >= 0 faces of a block (biome-independent defaults). */
export function tintColor(kind: TintKind | undefined, id: string, props: Record<string, string>): Rgb {
  switch (kind) {
    case "grass":
      return GRASS;
    case "foliage":
      return FOLIAGE;
    case "water":
      return WATER;
    case "redstone":
      return redstoneColor(Number(props.power ?? 0));
    case "fixed":
      return fixedColor(id, props);
  }
  return WHITE;
}

// ---------------------------------------------------------------------------------------------
// Approximations for block-entity-rendered blocks

const FACES: FaceName[] = ["down", "up", "north", "south", "west", "east"];

/** Default face uv from element bounds (vanilla rules), 0..16 model space. */
export function defaultUv(face: FaceName, from: number[], to: number[]): [number, number, number, number] {
  const [x0, y0, z0] = from as [number, number, number];
  const [x1, y1, z1] = to as [number, number, number];
  switch (face) {
    case "down":
      return [x0, 16 - z1, x1, 16 - z0];
    case "up":
      return [x0, z0, x1, z1];
    case "north":
      return [16 - x1, 16 - y1, 16 - x0, 16 - y0];
    case "south":
      return [x0, 16 - y1, x1, 16 - y0];
    case "west":
      return [z0, 16 - y1, z1, 16 - y0];
    case "east":
      return [16 - z1, 16 - y1, 16 - z0, 16 - y0];
  }
}

function box(from: [number, number, number], to: [number, number, number], texture: string): ModelElement {
  const faces: ModelElement["faces"] = {};
  for (const f of FACES) {
    const face: ModelFace = { uv: defaultUv(f, from, to), texture };
    const onEdge =
      (f === "down" && from[1] === 0) ||
      (f === "up" && to[1] === 16) ||
      (f === "north" && from[2] === 0) ||
      (f === "south" && to[2] === 16) ||
      (f === "west" && from[0] === 0) ||
      (f === "east" && to[0] === 16);
    if (onEdge) face.cullface = f;
    faces[f] = face;
  }
  return { from, to, faces };
}

export interface Approximation {
  elements: ModelElement[];
  /** blockstate-style y rotation (0/90/180/270) */
  y: number;
}

const FACING_Y: Record<string, number> = { north: 0, east: 90, south: 180, west: 270 };

const SKULL_TEXTURE: Record<string, string> = {
  skeleton: "bone_block_side",
  wither_skeleton: "coal_block",
  zombie: "green_terracotta",
  creeper: "lime_terracotta",
  player: "brown_terracotta",
  dragon: "black_concrete",
  piglin: "pink_terracotta",
};

function copperStage(id: string): string {
  const m = /(exposed|weathered|oxidized)_/.exec(id);
  return m ? `minecraft:block/${m[1]}_copper` : "minecraft:block/copper_block";
}

/**
 * Box approximation for a block drawn by a block-entity renderer (no model elements), so
 * buildings don't get holes. Returns null when the block has no rule (caller falls back to the
 * "missing" cube).
 */
export function approximate(id: string, props: Record<string, string>): Approximation | null {
  const name = id.startsWith("minecraft:") ? id.slice(10) : id;
  const facingY = FACING_Y[props.facing ?? "north"] ?? 0;
  let m: RegExpExecArray | null;
  if (name === "chest" || name === "trapped_chest") return { elements: [box([1, 0, 1], [15, 14, 15], "minecraft:block/oak_planks")], y: 0 };
  if (name === "ender_chest") return { elements: [box([1, 0, 1], [15, 14, 15], "minecraft:block/obsidian")], y: 0 };
  if (name.endsWith("copper_chest")) return { elements: [box([1, 0, 1], [15, 14, 15], copperStage(name))], y: 0 };
  if (name.endsWith("copper_golem_statue")) return { elements: [box([3, 0, 3], [13, 14, 13], copperStage(name))], y: 0 };
  if ((m = /^(\w+)_wall_banner$/.exec(name)))
    return { elements: [box([1, -16, 14], [15, 12, 15.5], `minecraft:block/${m[1]}_wool`)], y: facingY };
  if ((m = /^(\w+)_banner$/.exec(name))) {
    const rot = Number(props.rotation ?? 0);
    return {
      elements: [box([7, 0, 7], [9, 16, 9], "minecraft:block/oak_planks"), box([1, -2, 9], [15, 26, 10], `minecraft:block/${m[1]}_wool`)],
      y: (Math.round(rot / 4) % 4) * 90,
    };
  }
  if ((m = /^(\w+?)_wall_(skull|head)$/.exec(name)))
    return { elements: [box([4, 4, 8], [12, 12, 16], `minecraft:block/${SKULL_TEXTURE[m[1]!] ?? "brown_terracotta"}`)], y: facingY };
  if ((m = /^(\w+?)_(skull|head)$/.exec(name)))
    return { elements: [box([4, 0, 4], [12, 8, 12], `minecraft:block/${SKULL_TEXTURE[m[1]!] ?? "brown_terracotta"}`)], y: 0 };
  if ((m = /^(?:(\w+)_)?shulker_box$/.exec(name)))
    return { elements: [box([0, 0, 0], [16, 16, 16], `minecraft:block/${m[1] ? `${m[1]}_` : ""}shulker_box`)], y: 0 };
  if (name === "decorated_pot") return { elements: [box([1, 0, 1], [15, 16, 15], "minecraft:block/terracotta")], y: 0 };
  if (name === "conduit") return { elements: [box([5, 5, 5], [11, 11, 11], "minecraft:block/conduit")], y: 0 };
  if (name === "end_portal") return { elements: [box([0, 0, 0], [16, 12, 16], "minecraft:block/black_concrete")], y: 0 };
  if (name === "end_gateway") return { elements: [box([0, 0, 0], [16, 16, 16], "minecraft:block/black_concrete")], y: 0 };
  return null;
}

/** Full cube with the "missing" texture, for blocks with no blockstate / no geometry rule. */
export function missingCube(): ModelElement[] {
  return [box([0, 0, 0], [16, 16, 16], MISSING_TEXTURE)];
}
