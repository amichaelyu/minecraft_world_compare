// bun run build-assets [--version 26.2] [--jar path]
//
// Reads the Minecraft client jar and writes cache/assets/{atlas.png,assets.json,mesher-worker.js}.
// The jar comes from --jar, env MINECRAFT_JAR, or the standard launcher directory for this OS.
// Jar contents are only ever written to cache/ (gitignored).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { parseArgs } from "node:util";
import { decode as decodePng, encode as encodePng, convertIndexedToRgb, type DecodedPng } from "fast-png";
import type { AssetBundle, ModelElement, ModelFace, ResolvedModel } from "../src/shared/mesh-types.ts";
import {
  approximate,
  defaultUv,
  INVISIBLE,
  LAVA_TEXTURE,
  UNTINTED,
  MISSING_TEXTURE,
  tintColor,
  tintKindFor,
  WATER,
  WATER_TEXTURE,
  type FaceName,
  type Rgb,
  type TintKind,
} from "../src/client/mesher/blocks.ts";
import { buildMesherWorker } from "../src/client/mesher/build-worker.ts";

const t0 = performance.now();
const REPO = resolve(import.meta.dir, "..");
const OUT_DIR = join(REPO, "cache", "assets");

const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: { version: { type: "string", default: "26.2" }, jar: { type: "string" } },
});
const VERSION = args.version!;

function defaultJar(version: string): string {
  const home = homedir();
  const p = platform();
  const root =
    p === "darwin"
      ? join(home, "Library", "Application Support", "minecraft")
      : p === "win32"
        ? join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), ".minecraft")
        : join(home, ".minecraft");
  return join(root, "versions", version, `${version}.jar`);
}

const JAR = args.jar ?? process.env.MINECRAFT_JAR ?? defaultJar(VERSION);
if (!existsSync(JAR)) {
  console.error(`client jar not found: ${JAR}\nset MINECRAFT_JAR or pass --jar`);
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------
// Zip reading (central directory + inflateRaw)

interface ZipEntry {
  method: number;
  csize: number;
  offset: number; // local header offset
}

function readZipDirectory(buf: Uint8Array): Map<string, ZipEntry> {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file (no end of central directory)");
  const count = v.getUint16(eocd + 10, true);
  let o = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const entries = new Map<string, ZipEntry>();
  for (let i = 0; i < count; i++) {
    if (v.getUint32(o, true) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = v.getUint16(o + 10, true);
    const csize = v.getUint32(o + 20, true);
    const nameLen = v.getUint16(o + 28, true);
    const extraLen = v.getUint16(o + 30, true);
    const commentLen = v.getUint16(o + 32, true);
    const offset = v.getUint32(o + 42, true);
    entries.set(dec.decode(buf.subarray(o + 46, o + 46 + nameLen)), { method, csize, offset });
    o += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const jarBuf = new Uint8Array(readFileSync(JAR));
const zip = readZipDirectory(jarBuf);

function readEntry(name: string): Uint8Array | null {
  const e = zip.get(name);
  if (!e) return null;
  const v = new DataView(jarBuf.buffer, jarBuf.byteOffset);
  const start = e.offset + 30 + v.getUint16(e.offset + 26, true) + v.getUint16(e.offset + 28, true);
  const raw = jarBuf.subarray(start, start + e.csize);
  if (e.method === 0) return raw;
  if (e.method === 8) return new Uint8Array(inflateRawSync(raw));
  throw new Error(`unsupported zip method ${e.method} for ${name}`);
}

const textDec = new TextDecoder();
function readJson(name: string): any {
  const b = readEntry(name);
  return b ? JSON.parse(textDec.decode(b)) : null;
}

// ---------------------------------------------------------------------------------------------
// Ids

/** "block/stone" | "minecraft:block/stone" -> "minecraft:block/stone" */
function nsId(id: string): string {
  return id.includes(":") ? id : `minecraft:${id}`;
}
function assetPath(id: string, kind: "models" | "textures" | "blockstates", ext: string): string {
  const [ns, path] = nsId(id).split(":") as [string, string];
  return `assets/${ns}/${kind}/${path}${ext}`;
}

// ---------------------------------------------------------------------------------------------
// Blockstates

const BS_PREFIX = "assets/minecraft/blockstates/";
const blockstates: Record<string, unknown> = {};
for (const name of zip.keys()) {
  if (name.startsWith(BS_PREFIX) && name.endsWith(".json")) {
    blockstates[`minecraft:${name.slice(BS_PREFIX.length, -5)}`] = readJson(name);
  }
}

interface VariantRef {
  model: string;
  x?: number;
  y?: number;
  uvlock?: boolean;
  weight?: number;
}

/** All model refs used by a blockstate (every variant / multipart apply, including random lists). */
function blockstateRefs(bs: any): VariantRef[] {
  const out: VariantRef[] = [];
  const add = (v: any) => {
    if (Array.isArray(v)) v.forEach(add);
    else if (v && typeof v.model === "string") out.push(v);
  };
  if (bs?.variants) for (const k of Object.keys(bs.variants)) add(bs.variants[k]);
  if (Array.isArray(bs?.multipart)) for (const p of bs.multipart) add(p.apply);
  return out;
}

/** Representative model ref for the block colour: first variant, or first unconditional part. */
function representativeRefs(bs: any): VariantRef[] {
  const first = (v: any): VariantRef | null => (Array.isArray(v) ? (v[0] ?? null) : v?.model ? v : null);
  if (bs?.variants) {
    const keys = Object.keys(bs.variants);
    const r = keys.length ? first(bs.variants[keys[0]!]) : null;
    return r ? [r] : [];
  }
  if (Array.isArray(bs?.multipart)) {
    const parts = bs.multipart.filter((p: any) => !p.when).map((p: any) => first(p.apply));
    const r = parts.length ? parts : [first(bs.multipart[0]?.apply)];
    return r.filter((x: VariantRef | null): x is VariantRef => !!x);
  }
  return [];
}

// ---------------------------------------------------------------------------------------------
// Models

interface RawModel {
  parent?: string;
  textures?: Record<string, string | { sprite: string; force_translucent?: boolean }>;
  elements?: any[];
  ambientocclusion?: boolean;
}

const rawModelCache = new Map<string, RawModel | null>();
function rawModel(id: string): RawModel | null {
  id = nsId(id);
  if (!rawModelCache.has(id)) rawModelCache.set(id, readJson(assetPath(id, "models", ".json")));
  return rawModelCache.get(id)!;
}

const forceTranslucent = new Set<string>();
const referencedTextures = new Set<string>();
const DIRS: FaceName[] = ["down", "up", "north", "south", "west", "east"];
const warnings: string[] = [];

/** Convert a vanilla element rotation (single axis, or the newer {x,y,z} euler form) to axis+angle. */
function normalizeRotation(r: any): ModelElement["rotation"] | undefined {
  if (!r) return undefined;
  const origin = (r.origin ?? [8, 8, 8]) as [number, number, number];
  if (typeof r.axis === "string") {
    if (!r.angle) return undefined;
    return { origin, axis: r.axis, angle: r.angle, ...(r.rescale ? { rescale: true } : {}) };
  }
  // Euler form: R = Rz * Ry * Rx. Find the equivalent single-axis rotation if there is one.
  const rad = Math.PI / 180;
  const [ax, ay, az] = [(r.x ?? 0) * rad, (r.y ?? 0) * rad, (r.z ?? 0) * rad];
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(ax), Math.sin(ax), Math.cos(ay), Math.sin(ay), Math.cos(az), Math.sin(az)];
  const m = [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx],
  ] as const;
  const eps = 1e-4;
  let rot: ModelElement["rotation"];
  if (Math.abs(m[1][1] - 1) < eps) rot = { origin, axis: "y", angle: Math.atan2(m[0][2], m[0][0]) / rad };
  else if (Math.abs(m[0][0] - 1) < eps) rot = { origin, axis: "x", angle: Math.atan2(m[2][1], m[1][1]) / rad };
  else if (Math.abs(m[2][2] - 1) < eps) rot = { origin, axis: "z", angle: Math.atan2(m[1][0], m[0][0]) / rad };
  else {
    const axes = (["x", "y", "z"] as const).map((a) => [a, Math.abs(r[a] ?? 0)] as const).sort((p, q) => q[1] - p[1]);
    const a = axes[0]![0];
    rot = { origin, axis: a, angle: r[a] };
    warnings.push(`multi-axis element rotation ${JSON.stringify(r)} approximated as ${a}`);
  }
  if (Math.abs(rot.angle) < 1e-3) return undefined;
  if (r.rescale) rot.rescale = true;
  return rot;
}

function resolveModel(id: string): ResolvedModel {
  const chain: RawModel[] = [];
  let cur: string | undefined = nsId(id);
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const m = rawModel(cur);
    if (!m) {
      warnings.push(`missing model ${cur} (in chain of ${id})`);
      break;
    }
    chain.push(m);
    cur = m.parent ? nsId(m.parent) : undefined;
  }
  // textures: root first, child overrides
  const tex: Record<string, string> = {};
  for (let i = chain.length - 1; i >= 0; i--) {
    for (const [k, v] of Object.entries(chain[i]!.textures ?? {})) {
      if (typeof v === "string") tex[k] = v;
      else if (v && typeof v.sprite === "string") {
        tex[k] = v.sprite;
        if (v.force_translucent) forceTranslucent.add(nsId(v.sprite));
      }
    }
  }
  const resolveTex = (ref: string): string => {
    let r = ref;
    for (let d = 0; d < 16 && r.startsWith("#"); d++) {
      const next = tex[r.slice(1)];
      if (next === undefined) return MISSING_TEXTURE;
      r = next;
    }
    if (r.startsWith("#")) return MISSING_TEXTURE;
    const t = nsId(r);
    referencedTextures.add(t);
    return t;
  };
  const elementsRaw = chain.find((m) => Array.isArray(m.elements))?.elements ?? [];
  const aoModel = chain.find((m) => typeof m.ambientocclusion === "boolean");
  const elements: ModelElement[] = [];
  for (const e of elementsRaw) {
    const el: ModelElement = { from: e.from, to: e.to, faces: {} };
    const rot = normalizeRotation(e.rotation);
    if (rot) el.rotation = rot;
    if (e.shade === false) el.shade = false;
    for (const [dirRaw, f] of Object.entries<any>(e.faces ?? {})) {
      const dir = (dirRaw === "bottom" ? "down" : dirRaw) as FaceName;
      if (!DIRS.includes(dir)) continue;
      const face: ModelFace = {
        uv: Array.isArray(f.uv) && f.uv.length === 4 ? f.uv : defaultUv(dir, e.from, e.to),
        // face textures are always variable references; vanilla accepts them with or without '#'
        texture: resolveTex(typeof f.texture === "string" ? (f.texture.startsWith("#") ? f.texture : `#${f.texture}`) : "#missing"),
      };
      if (f.cullface) face.cullface = (f.cullface === "bottom" ? "down" : f.cullface) as FaceName;
      const r = (((f.rotation ?? 0) % 360) + 360) % 360;
      if (r) face.rotation = r as 90 | 180 | 270;
      if (typeof f.tintindex === "number" && f.tintindex >= 0) face.tintindex = f.tintindex;
      el.faces[dir] = face;
    }
    elements.push(el);
  }
  const out: ResolvedModel = { elements };
  if (aoModel && aoModel.ambientocclusion === false) out.ambientocclusion = false;
  return out;
}

const models: Record<string, ResolvedModel> = {};
const tints: Record<string, TintKind> = {};
const noElementBlocks: string[] = [];
for (const [blockId, bs] of Object.entries(blockstates)) {
  let tinted = false;
  let anyElements = false;
  for (const ref of blockstateRefs(bs)) {
    const mid = nsId(ref.model);
    if (!models[mid]) models[mid] = resolveModel(mid);
    const m = models[mid]!;
    if (m.elements.length) anyElements = true;
    for (const e of m.elements) for (const f of Object.values(e.faces)) if (f && f.tintindex !== undefined) tinted = true;
  }
  if (tinted) {
    const k = tintKindFor(blockId);
    if (k) tints[blockId] = k;
    else if (!UNTINTED.has(blockId)) warnings.push(`tinted block without tint rule: ${blockId}`);
  }
  if (!anyElements && !INVISIBLE.has(blockId) && blockId !== "minecraft:water" && blockId !== "minecraft:lava" && blockId !== "minecraft:bubble_column") {
    noElementBlocks.push(blockId);
  }
}
// tint kinds for fluids even though their models have no elements
tints["minecraft:water"] = "water";
tints["minecraft:bubble_column"] = "water";

const approxTextures = new Set<string>([WATER_TEXTURE, LAVA_TEXTURE]);
const unapproximated: string[] = [];
for (const id of noElementBlocks) {
  const a = approximate(id, {});
  if (!a) unapproximated.push(id);
  else for (const e of a.elements) for (const f of Object.values(e.faces)) if (f) approxTextures.add(f.texture);
}

// ---------------------------------------------------------------------------------------------
// Textures

interface Tex {
  id: string;
  w: number;
  h: number;
  rgba: Uint8Array; // first frame, w*h*4
}

function toRgba(png: DecodedPng): Uint8Array {
  const n = png.width * png.height;
  let src: ArrayLike<number> = png.data;
  let channels = png.channels;
  let depth: number = png.depth;
  if (png.palette) {
    src = convertIndexedToRgb(png);
    channels = src.length / n;
    depth = 8;
  }
  const out = new Uint8Array(n * 4);
  const shift = depth === 16 ? 8 : 0;
  // tRNS for grayscale / truecolour images: one colour key that is fully transparent
  const key = !png.palette && png.transparency && (channels === 1 || channels === 3) ? png.transparency : null;
  for (let i = 0; i < n; i++) {
    const s = i * channels;
    let r: number, g: number, b: number, a: number;
    if (channels >= 3) {
      r = src[s]! >> shift;
      g = src[s + 1]! >> shift;
      b = src[s + 2]! >> shift;
      a = channels === 4 ? src[s + 3]! >> shift : 255;
    } else {
      r = g = b = src[s]! >> shift;
      a = channels === 2 ? src[s + 1]! >> shift : 255;
    }
    if (key && (channels === 1 ? src[s] === key[0] : src[s] === key[0] && src[s + 1] === key[1] && src[s + 2] === key[2])) a = 0;
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = a;
  }
  return out;
}

function loadTexture(id: string): Tex | null {
  const path = assetPath(id, "textures", ".png");
  const bytes = readEntry(path);
  if (!bytes) return null;
  const png = decodePng(bytes);
  const rgba = toRgba(png);
  const meta = readJson(`${path}.mcmeta`);
  const anim = meta?.animation;
  let fw = png.width;
  let fh = png.height;
  let frame = 0;
  if (anim) {
    fw = anim.width ?? Math.min(png.width, png.height);
    fh = anim.height ?? fw;
    const f0 = Array.isArray(anim.frames) ? anim.frames[0] : 0;
    frame = typeof f0 === "number" ? f0 : (f0?.index ?? 0);
  } else if (png.height > png.width && png.height % png.width === 0) {
    fh = png.width;
  }
  const perRow = Math.max(1, Math.floor(png.width / fw));
  const fx = (frame % perRow) * fw;
  const fy = Math.floor(frame / perRow) * fh;
  if (fy + fh > png.height) return { id, w: fw, h: fh, rgba: crop(rgba, png.width, 0, 0, fw, fh) };
  return { id, w: fw, h: fh, rgba: crop(rgba, png.width, fx, fy, fw, fh) };
}

function crop(rgba: Uint8Array, stride: number, x: number, y: number, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let r = 0; r < h; r++) out.set(rgba.subarray(((y + r) * stride + x) * 4, ((y + r) * stride + x + w) * 4), r * w * 4);
  return out;
}

function missingTexture(): Tex {
  const rgba = new Uint8Array(16 * 16 * 4);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const i = (y * 16 + x) * 4;
      const on = (x < 8) !== (y < 8);
      rgba[i] = on ? 248 : 0;
      rgba[i + 1] = 0;
      rgba[i + 2] = on ? 248 : 0;
      rgba[i + 3] = 255;
    }
  return { id: MISSING_TEXTURE, w: 16, h: 16, rgba };
}

const texIds = new Set<string>();
for (const name of zip.keys()) {
  const m = /^assets\/minecraft\/textures\/(block\/.+)\.png$/.exec(name);
  if (m) texIds.add(`minecraft:${m[1]}`);
}
for (const t of referencedTextures) texIds.add(t);
for (const t of approxTextures) texIds.add(t);
texIds.delete(MISSING_TEXTURE);

const texList: Tex[] = [missingTexture()];
for (const id of [...texIds].sort()) {
  const t = loadTexture(id);
  if (t) texList.push(t);
  else if (referencedTextures.has(id) || approxTextures.has(id)) warnings.push(`missing texture ${id}`);
}
const texById = new Map(texList.map((t) => [t.id, t]));

// Fully transparent pixels: give them the texture's mean opaque colour so filtering/mipmaps
// don't pull black fringes into cutout edges.
for (const t of texList) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < t.rgba.length; i += 4)
    if (t.rgba[i + 3]! > 0) {
      r += t.rgba[i]!;
      g += t.rgba[i + 1]!;
      b += t.rgba[i + 2]!;
      n++;
    }
  if (!n || n * 4 === t.rgba.length) continue;
  for (let i = 0; i < t.rgba.length; i += 4)
    if (t.rgba[i + 3] === 0) {
      t.rgba[i] = r / n;
      t.rgba[i + 1] = g / n;
      t.rgba[i + 2] = b / n;
    }
}

// alpha classification
const textureAlpha: Record<string, "cutout" | "translucent"> = {};
for (const t of texList) {
  let partial = 0;
  let clear = 0;
  for (let i = 3; i < t.rgba.length; i += 4) {
    const a = t.rgba[i]!;
    if (a === 0) clear++;
    else if (a < 255) partial++;
  }
  if (forceTranslucent.has(t.id) || partial > 0) textureAlpha[t.id] = "translucent";
  else if (clear > 0) textureAlpha[t.id] = "cutout";
}

// ---------------------------------------------------------------------------------------------
// Atlas packing: each texture of size S sits in a 2S cell with S/2 px of edge extrusion on every
// side, so mip levels up to log2(S) stay inside the texture's own cell.

const PAD_RATIO = 0.25; // pad = cell * 0.25 = S/2
const cells = texList.map((t) => ({ t, cell: nextPow2(Math.max(t.w, t.h)) * 2 })).sort((a, b) => b.cell - a.cell || (a.t.id < b.t.id ? -1 : 1));
function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}
const totalArea = cells.reduce((s, c) => s + c.cell * c.cell, 0);
let atlasW = 256;
while (atlasW * atlasW < totalArea) atlasW *= 2;
// Cells are powers of two sorted largest first: fill rows of equal-size cells, starting a new row
// whenever the size changes (at most one partly empty row per size).
function pack(W: number): { places: Map<Tex, [number, number]>; height: number } {
  const places = new Map<Tex, [number, number]>();
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const { t, cell } of cells) {
    if (rowH && (x + cell > W || cell !== rowH)) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    if (rowH === 0) rowH = cell;
    places.set(t, [x, y]);
    x += cell;
  }
  return { places, height: y + rowH };
}
let packed = pack(atlasW);
let atlasH = nextPow2(packed.height);
if (atlasH > atlasW * 2) {
  atlasW *= 2;
  packed = pack(atlasW);
  atlasH = nextPow2(packed.height);
}

const atlas = new Uint8Array(atlasW * atlasH * 4);
const textures: Record<string, [number, number, number, number]> = {};
for (const { t, cell } of cells) {
  const [cx, cy] = packed.places.get(t)!;
  const pad = Math.floor(cell * PAD_RATIO);
  const ox = cx + pad;
  const oy = cy + pad;
  // copy with clamp-to-edge extrusion over the full cell
  for (let y = 0; y < cell; y++) {
    const sy = Math.min(t.h - 1, Math.max(0, y - pad));
    for (let x = 0; x < cell; x++) {
      const sx = Math.min(t.w - 1, Math.max(0, x - pad));
      const si = (sy * t.w + sx) * 4;
      const di = ((cy + y) * atlasW + cx + x) * 4;
      atlas[di] = t.rgba[si]!;
      atlas[di + 1] = t.rgba[si + 1]!;
      atlas[di + 2] = t.rgba[si + 2]!;
      atlas[di + 3] = t.rgba[si + 3]!;
    }
  }
  textures[t.id] = [ox, oy, t.w, t.h];
}

// ---------------------------------------------------------------------------------------------
// Block colours (LOD)

function averageColor(texId: string, uv: [number, number, number, number]): [Rgb, number] | null {
  const t = texById.get(texId);
  if (!t) return null;
  const x0 = Math.floor((Math.min(uv[0], uv[2]) / 16) * t.w);
  const x1 = Math.max(x0 + 1, Math.ceil((Math.max(uv[0], uv[2]) / 16) * t.w));
  const y0 = Math.floor((Math.min(uv[1], uv[3]) / 16) * t.h);
  const y1 = Math.max(y0 + 1, Math.ceil((Math.max(uv[1], uv[3]) / 16) * t.h));
  let r = 0, g = 0, b = 0, wsum = 0;
  for (let y = Math.max(0, y0); y < Math.min(t.h, y1); y++)
    for (let x = Math.max(0, x0); x < Math.min(t.w, x1); x++) {
      const i = (y * t.w + x) * 4;
      const a = t.rgba[i + 3]! / 255;
      r += t.rgba[i]! * a;
      g += t.rgba[i + 1]! * a;
      b += t.rgba[i + 2]! * a;
      wsum += a;
    }
  if (wsum <= 0) return null;
  return [[r / wsum, g / wsum, b / wsum], wsum];
}

/** Pick the top-most "up" face (largest area at the highest y); else the largest face of any kind. */
function colorFromElements(blockId: string, elements: ModelElement[]): Rgb | null {
  let best: { face: ModelFace; score: number } | null = null;
  for (const e of elements) {
    const up = e.faces.up;
    if (up) {
      const area = Math.abs((e.to[0] - e.from[0]) * (e.to[2] - e.from[2]));
      const score = 1e6 + e.to[1] * 1000 + area;
      if (area > 0 && (!best || score > best.score)) best = { face: up, score };
    }
  }
  if (!best) {
    for (const e of elements)
      for (const [dir, f] of Object.entries(e.faces)) {
        if (!f) continue;
        const d = [e.to[0] - e.from[0], e.to[1] - e.from[1], e.to[2] - e.from[2]];
        const area = dir === "up" || dir === "down" ? d[0]! * d[2]! : dir === "north" || dir === "south" ? d[0]! * d[1]! : d[1]! * d[2]!;
        if (!best || Math.abs(area) > best.score) best = { face: f, score: Math.abs(area) };
      }
  }
  if (!best) return null;
  const avg = averageColor(best.face.texture, best.face.uv);
  if (!avg) return null;
  let c = avg[0];
  if (best.face.tintindex !== undefined) {
    const tint = tintColor(tints[blockId], blockId, {});
    c = [(c[0] * tint[0]) / 255, (c[1] * tint[1]) / 255, (c[2] * tint[2]) / 255];
  }
  return [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])];
}

const colors: Record<string, Rgb> = {};
for (const [blockId, bs] of Object.entries(blockstates)) {
  if (INVISIBLE.has(blockId)) continue;
  if (blockId === "minecraft:water" || blockId === "minecraft:bubble_column") {
    colors[blockId] = [...WATER];
    continue;
  }
  if (blockId === "minecraft:lava") {
    const a = averageColor(LAVA_TEXTURE, [0, 0, 16, 16]);
    if (a) colors[blockId] = a[0].map(Math.round) as Rgb;
    continue;
  }
  const els: ModelElement[] = [];
  for (const ref of representativeRefs(bs)) els.push(...(models[nsId(ref.model)]?.elements ?? []));
  const elements = els.length ? els : (approximate(blockId, {})?.elements ?? []);
  const c = colorFromElements(blockId, elements);
  if (c) colors[blockId] = c;
}

// ---------------------------------------------------------------------------------------------
// Write

mkdirSync(OUT_DIR, { recursive: true });
const bundle: AssetBundle = {
  version: VERSION,
  atlas: { width: atlasW, height: atlasH, file: "atlas.png" },
  textures,
  textureAlpha,
  models,
  blockstates,
  tints,
  colors,
};
const json = JSON.stringify(bundle);
writeFileSync(join(OUT_DIR, "assets.json"), json);
const png = encodePng({ width: atlasW, height: atlasH, data: atlas, depth: 8, channels: 4 });
writeFileSync(join(OUT_DIR, "atlas.png"), png);
const workerJs = await buildMesherWorker({ minify: true });
writeFileSync(join(OUT_DIR, "mesher-worker.js"), workerJs);

const ms = performance.now() - t0;
for (const w of [...new Set(warnings)].slice(0, 40)) console.warn(`warn: ${w}`);
if (unapproximated.length) console.warn(`warn: blocks with no geometry and no approximation (drawn as missing cubes): ${unapproximated.join(", ")}`);
console.log(
  [
    `jar        ${JAR}`,
    `blockstates ${Object.keys(blockstates).length}, models ${Object.keys(models).length}, textures ${texList.length} ` +
      `(${Object.keys(textureAlpha).filter((k) => textureAlpha[k] === "cutout").length} cutout, ` +
      `${Object.keys(textureAlpha).filter((k) => textureAlpha[k] === "translucent").length} translucent)`,
    `atlas      ${atlasW}x${atlasH} (${(png.length / 1024).toFixed(0)} KiB)`,
    `assets.json ${(json.length / 1024 / 1024).toFixed(2)} MiB, colors ${Object.keys(colors).length}, tints ${Object.keys(tints).length}`,
    `worker     mesher-worker.js ${(workerJs.length / 1024).toFixed(0)} KiB`,
    `done in ${(ms / 1000).toFixed(2)} s -> ${OUT_DIR}`,
  ].join("\n"),
);
