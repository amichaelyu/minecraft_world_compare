// Blockstate resolution: canonical state string -> list of model parts (variants or multipart).

export interface PartRef {
  model: string;
  x: number;
  y: number;
  uvlock: boolean;
}

/** One way to draw the block: all parts together. Weighted random variants give several. */
export interface Alternative {
  parts: PartRef[];
  weight: number;
}

function toPart(v: any): PartRef | null {
  if (!v || typeof v.model !== "string") return null;
  const model = v.model.includes(":") ? v.model : `minecraft:${v.model}`;
  return { model, x: Number(v.x ?? 0), y: Number(v.y ?? 0), uvlock: v.uvlock === true };
}

/**
 * Default values assumed for properties missing from a state string. Some world generators
 * (arnis) write partial states such as "minecraft:oak_log" or "oak_stairs[facing=east]";
 * vanilla would fill in the block's default state.
 */
const DEFAULTS: Record<string, string[]> = {
  axis: ["y"],
  facing: ["north"],
  half: ["bottom", "lower"],
  type: ["bottom"],
  shape: ["straight", "north_south"],
  hinge: ["left"],
  face: ["wall"],
  attachment: ["floor"],
  part: ["foot"],
  up: ["true"], // walls: post shown by default
  orientation: ["north_up"],
  mode: ["save", "compare"],
  sculk_sensor_phase: ["inactive"],
  thickness: ["tip"],
  vertical_direction: ["up"],
  tilt: ["none"],
  leaves: ["none"],
};

function isDefault(key: string, value: string): boolean {
  const d = DEFAULTS[key];
  if (d) return d.includes(value);
  return value === "false" || value === "0" || value === "none";
}

/** mode 0: exact; 1: missing properties take default values; 2: missing properties ignored */
function variantMatches(key: string, props: Record<string, string>, mode: number): boolean {
  if (key === "") return true;
  for (const kv of key.split(",")) {
    const e = kv.indexOf("=");
    if (e < 0) continue;
    const k = kv.slice(0, e);
    const v = props[k];
    if (v === undefined) {
      if (mode === 0 || (mode === 1 && !isDefault(k, kv.slice(e + 1)))) return false;
    } else if (v !== kv.slice(e + 1)) return false;
  }
  return true;
}

function conditionMatches(when: any, props: Record<string, string>): boolean {
  if (!when) return true;
  if (Array.isArray(when.OR)) return when.OR.some((c: any) => conditionMatches(c, props));
  if (Array.isArray(when.AND)) return when.AND.every((c: any) => conditionMatches(c, props));
  for (const [k, raw] of Object.entries(when)) {
    const v = props[k];
    let s = String(raw);
    let negate = false;
    if (s.startsWith("!")) {
      negate = true;
      s = s.slice(1);
    }
    const values = s.split("|");
    const hit = v !== undefined ? values.includes(v) : values.some((x) => isDefault(k, x));
    if (hit === negate) return false;
  }
  return true;
}

/** Resolve a blockstate definition for the given properties. Null when nothing matches. */
export function resolveBlockstate(bs: any, props: Record<string, string>): Alternative[] | null {
  if (!bs) return null;
  if (bs.variants) {
    const keys = Object.keys(bs.variants);
    const key = keys.find((k) => variantMatches(k, props, 0)) ?? keys.find((k) => variantMatches(k, props, 1)) ?? keys.find((k) => variantMatches(k, props, 2));
    if (key !== undefined) {
      const v = bs.variants[key];
      if (Array.isArray(v)) {
        const alts: Alternative[] = [];
        for (const item of v) {
          const p = toPart(item);
          if (p) alts.push({ parts: [p], weight: Math.max(1, Number(item.weight ?? 1)) });
        }
        return alts.length ? alts : null;
      }
      const p = toPart(v);
      return p ? [{ parts: [p], weight: 1 }] : null;
    }
    return null;
  }
  if (Array.isArray(bs.multipart)) {
    const parts: PartRef[] = [];
    for (const part of bs.multipart) {
      if (!conditionMatches(part.when, props)) continue;
      const p = toPart(Array.isArray(part.apply) ? part.apply[0] : part.apply);
      if (p) parts.push(p);
    }
    return [{ parts, weight: 1 }];
  }
  return null;
}
