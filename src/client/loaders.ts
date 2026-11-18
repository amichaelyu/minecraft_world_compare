// Fetches the world list, the asset bundle and the block atlas.
import * as THREE from "three";
import type { WorldInfo } from "../shared/api.ts";
import type { AssetBundle } from "../shared/mesh-types.ts";
import { assetUrl, dataUrl } from "./config.ts";

export async function loadWorlds(): Promise<WorldInfo[]> {
  const res = await fetch(dataUrl("worlds.json"));
  if (!res.ok) throw new Error(`worlds.json: HTTP ${res.status}`);
  return (await res.json()) as WorldInfo[];
}

/** Returns null (and logs) when the bundle isn't built yet, so the viewer still starts. */
export async function loadAssets(): Promise<AssetBundle | null> {
  try {
    const res = await fetch(assetUrl("assets.json"));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as AssetBundle;
  } catch (e) {
    console.warn("assets.json unavailable; run `bun run build-assets`", e);
    return null;
  }
}

function whiteTexture(): THREE.Texture {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

export async function loadAtlas(assets: AssetBundle | null, maxAnisotropy: number): Promise<THREE.Texture> {
  if (!assets) return whiteTexture();
  try {
    const tex = await new THREE.TextureLoader().loadAsync(assetUrl(assets.atlas.file || "atlas.png"));
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = Math.min(8, maxAnisotropy);
    tex.needsUpdate = true;
    return tex;
  } catch (e) {
    console.warn("atlas.png unavailable", e);
    return whiteTexture();
  }
}
