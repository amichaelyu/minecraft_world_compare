// Viewer entry point: two worlds, one camera, split screen.
import * as THREE from "three";
import type { WorldInfo } from "../shared/api.ts";
import type { AssetBundle } from "../shared/mesh-types.ts";
import { config } from "./config.ts";
import { CameraController, ControlMode } from "./controls.ts";
import { type Landmark, SF_SPAWN } from "./landmarks.ts";
import { loadAssets, loadAtlas, loadWorlds } from "./loaders.ts";
import { createBlockMaterials } from "./materials.ts";
import { makeMesherPool } from "./mesher-source.ts";
import { UI, ViewMode } from "./ui.ts";
import { hashIsForeign, readHash, writeHash } from "./url-state.ts";
import { WorldView } from "./world-view.ts";

const EMPTY_ASSETS: AssetBundle = {
  version: "",
  atlas: { width: 1, height: 1, file: "atlas.png" },
  textures: {},
  textureAlpha: {},
  models: {},
  blockstates: {},
  tints: {},
  colors: {},
};

const isIdentity = (w: WorldInfo) => {
  const t = w.transform;
  return t.s === 1 && t.thetaDeg === 0 && t.tx === 0 && t.tz === 0 && t.ty === 0;
};

async function main(): Promise<void> {
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  const overlay = document.getElementById("overlay")!;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    logarithmicDepthBuffer: config.logDepth,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(config.pixelRatio);
  renderer.setScissorTest(true);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const [worlds, assets] = await Promise.all([loadWorlds(), loadAssets()]);
  if (worlds.length === 0) throw new Error("worlds.json lists no worlds");
  const pick = (id: string | null, fallback: WorldInfo) => {
    if (!id) return fallback;
    const w = worlds.find((w) => w.id === id);
    if (!w) throw new Error(`unknown world "${id}" (have: ${worlds.map((w) => w.id).join(", ")})`);
    return w;
  };
  const infoA = pick(config.worldA, worlds[0]!);
  const infoB = pick(config.worldB, worlds.find((w) => w !== infoA) ?? infoA);

  const atlas = await loadAtlas(assets, renderer.capabilities.getMaxAnisotropy());
  const blockMats = createBlockMaterials(atlas);
  const mesher = await makeMesherPool(assets, config.mesherWorkers, EMPTY_ASSETS);
  const views = [new WorldView(infoA, mesher, blockMats), new WorldView(infoB, mesher, blockMats)] as const;
  const [A, B] = views;

  const camera = new THREE.PerspectiveCamera(config.fov, 1, 0.1, config.far);
  const controls = new CameraController(camera, canvas);
  // debugging handle for the devtools console
  (window as unknown as { mcr: unknown }).mcr = { THREE, renderer, camera, controls, views };

  let radius = THREE.MathUtils.clamp(config.radius, config.radiusMin, config.radiusMax);
  let viewMode = ViewMode.SideBySide;
  let splitFrac = 0.5;

  /** Ground under a reference point: reference world first, then the other one. */
  let lastGround = SF_SPAWN.y;
  const groundAt = (x: number, z: number) => A.groundRef(x, z) ?? B.groundRef(x, z);
  controls.groundAt = groundAt;

  // Start pose: hash, else the reference world's spawn (the reference = identity transform).
  const refInfo = [infoA, infoB].find(isIdentity) ?? infoA;
  const refView = views.find((v) => v.info === refInfo)!;
  const spawn = refView.toRefPoint(new THREE.Vector3(refInfo.spawn.x, refInfo.spawn.y, refInfo.spawn.z));
  const spawnYaw = refInfo.id === "sf" ? SF_SPAWN.yaw : 0;
  const goHash = () => {
    const p = readHash();
    if (p) controls.setPose(p.x, p.y, p.z, p.yaw, p.pitch);
    return !!p;
  };
  if (!goHash()) controls.setPose(spawn.x, spawn.y + 1.62, spawn.z, spawnYaw, 0);
  window.addEventListener("hashchange", () => hashIsForeign() && goHash());

  const jumpTo = (x: number, z: number, y: number | null, yaw = controls.yaw, pitch = controls.pitch) => {
    const g = groundAt(x, z);
    controls.setPose(x, y ?? (g !== null ? g + 40 : camera.position.y), z, yaw, pitch);
  };

  // Landmarks derived from the data: world centres (in the reference frame) and a city overview.
  const centre = (v: WorldView): Landmark => {
    const b = v.info.bounds;
    const p = v.toRefPoint(new THREE.Vector3((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2));
    const extent = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * v.scale;
    return { name: `${v.info.id} centre, overview`, x: Math.round(p.x), z: Math.round(p.z), y: Math.round(extent * 0.55), yaw: 0, pitch: 70 };
  };

  const ui = new UI(overlay, {
    onRadius: (r) => (radius = r),
    onJump: (x, z, y) => jumpTo(x, z, y),
    onLandmark: (l) => l.x !== null && l.z !== null && jumpTo(l.x, l.z, l.y ?? null, l.yaw ?? controls.yaw, l.pitch ?? controls.pitch),
    onViewMode: (m) => (viewMode = m),
    onSplit: (x) => (splitFrac = THREE.MathUtils.clamp(x / window.innerWidth, 0.02, 0.98)),
    onToggleControls: () => controls.toggleMode(),
    extraLandmarks: [centre(A), ...(B !== A ? [centre(B)] : [])],
  });
  ui.setLabels(`A: ${infoA.name}`, `B: ${infoB.name}`);
  controls.onModeChange = (m) => ui.setControlMode(m);
  if (!assets) ui.setStatus("assets.json not found: run `bun run build-assets`.\nShowing untextured blocks.");
  if (!assets) setTimeout(() => ui.setStatus(null), 5000);

  // --- frame loop -------------------------------------------------------------------------
  const timer = new THREE.Timer();
  let fpsFrames = 0;
  let fpsT = performance.now();
  let fps = 0;
  let nextHud = 0;
  let nextHash = 0;
  let lastAspect = 0;
  let hag = 0;

  const setAspect = (a: number) => {
    if (Math.abs(a - lastAspect) < 1e-6) return;
    lastAspect = a;
    camera.aspect = a;
    camera.updateProjectionMatrix();
  };

  let w = 0;
  let h = 0;
  const resize = () => {
    w = window.innerWidth;
    h = window.innerHeight;
    renderer.setSize(w, h, false);
  };
  window.addEventListener("resize", resize);
  resize();

  const fmt = (v: THREE.Vector3) => `${v.x.toFixed(1).padStart(8)} ${v.y.toFixed(1).padStart(6)} ${v.z.toFixed(1).padStart(8)}`;

  renderer.setAnimationLoop(() => {
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.1);
    const now = performance.now();

    // height above ground drives fly speed, draw distance and streaming
    const p = camera.position;
    const g = groundAt(p.x, p.z);
    if (g !== null) lastGround = g;
    hag = Math.max(0, p.y - lastGround);
    controls.hag = hag;
    controls.update(dt);
    camera.updateMatrixWorld();

    const viewDist = THREE.MathUtils.clamp(4000 + hag * 12, 4000, config.far * 0.8);
    if (Math.abs(camera.far - viewDist * 1.05) > 1) {
      camera.far = viewDist * 1.05;
      lastAspect = 0; // force projection update
    }
    const projFactor = h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    for (const v of views) v.update(camera, { hag, radius, projFactor, viewDist }, now);

    // render the two panes
    const split = viewMode === ViewMode.SideBySide ? Math.floor(w / 2) : Math.round(w * splitFrac);
    if (viewMode === ViewMode.SideBySide) {
      setAspect(split / h);
      renderer.setViewport(0, 0, split, h);
      renderer.setScissor(0, 0, split, h);
      renderer.render(A.scene, camera);
      renderer.setViewport(split, 0, w - split, h);
      renderer.setScissor(split, 0, w - split, h);
      renderer.render(B.scene, camera);
    } else {
      setAspect(w / h);
      renderer.setViewport(0, 0, w, h);
      renderer.setScissor(0, 0, split, h);
      renderer.render(A.scene, camera);
      renderer.setScissor(split, 0, w - split, h);
      renderer.render(B.scene, camera);
    }
    ui.layout(split, w);

    fpsFrames++;
    if (now - fpsT >= 500) {
      fps = (fpsFrames * 1000) / (now - fpsT);
      fpsFrames = 0;
      fpsT = now;
    }
    if (now >= nextHud && ui.debugVisible) {
      nextHud = now + 250;
      const lines = [
        `ref   ${fmt(p)}   yaw ${controls.yaw.toFixed(1)} pitch ${controls.pitch.toFixed(1)}`,
      ];
      for (const [tag, v] of [["A", A], ["B", B]] as const) {
        const s = v.stream.stats();
        const l = v.lod.stats();
        lines.push(
          `${tag} ${v.info.id.padEnd(6)}${fmt(v.camOwn)}`,
          `   tiles ${s.ready} loaded, ${s.wanted} wanted, ${s.empty} empty  fetch ${s.fetching} mesh ${s.meshing} q ${s.queued}  ${(s.triangles / 1e6).toFixed(2)}M tri`,
          `   lod ${l.shown} shown ${l.loaded} loaded  fetch ${l.loading} build ${l.building}  ${(l.triangles / 1e6).toFixed(2)}M tri  ring ${(v.stream.coverage * v.scale).toFixed(0)}`,
        );
      }
      const info = renderer.info.render;
      lines.push(
        `${fps.toFixed(0).padStart(3)} fps  ${controls.mode}  ${viewMode}  R ${radius}  speed ${controls.speed.toFixed(0)} b/s  above ground ${hag.toFixed(0)}`,
        `draw calls ${info.calls} (last pane)  view ${viewDist.toFixed(0)}`,
        `H help  Tab ${controls.mode === ControlMode.Fly ? "map" : "fly"}  V view  F3 hide`,
      );
      ui.hud.textContent = lines.join("\n");
    }
    if (now >= nextHash) {
      nextHash = now + 500;
      writeHash({ x: p.x, y: p.y, z: p.z, yaw: controls.yaw, pitch: controls.pitch });
    }
  });
}

main().catch((e: unknown) => {
  console.error(e);
  const s = document.getElementById("overlay");
  if (s) {
    const d = document.createElement("div");
    d.id = "status";
    d.textContent = `Viewer failed to start:\n${e instanceof Error ? e.message : String(e)}`;
    s.append(d);
  }
});
