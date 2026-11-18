// Coordinate helpers: world transforms and Minecraft-style yaw/pitch <-> three.js camera.
import * as THREE from "three";
import type { WorldTransform } from "../shared/api.ts";

/**
 * Matrix mapping a world's own block coords to the reference frame:
 *   [x', z'] = s * R(theta) * [x, z] + [tx, tz],  y' = y + ty
 */
export function transformMatrix(t: WorldTransform): THREE.Matrix4 {
  const th = (t.thetaDeg * Math.PI) / 180;
  const c = Math.cos(th) * t.s;
  const s = Math.sin(th) * t.s;
  // prettier-ignore
  return new THREE.Matrix4().set(
    c, 0, -s, t.tx,
    0, 1,  0, t.ty,
    s, 0,  c, t.tz,
    0, 0,  0, 1,
  );
}

/** Minecraft yaw/pitch (degrees; yaw 0 = +Z/south, 90 = -X/west; pitch + = down) -> Euler. */
export function applyYawPitch(camera: THREE.Camera, yawDeg: number, pitchDeg: number): void {
  camera.rotation.order = "YXZ";
  camera.rotation.set((-pitchDeg * Math.PI) / 180, Math.PI - (yawDeg * Math.PI) / 180, 0);
}

const _dir = new THREE.Vector3();
/** Inverse of applyYawPitch, from the camera's current orientation. */
export function yawPitchOf(camera: THREE.Camera): { yaw: number; pitch: number } {
  camera.getWorldDirection(_dir);
  const yaw = (Math.atan2(-_dir.x, _dir.z) * 180) / Math.PI;
  const pitch = (-Math.asin(THREE.MathUtils.clamp(_dir.y, -1, 1)) * 180) / Math.PI;
  return { yaw, pitch };
}

export function wrapYaw(y: number): number {
  return ((((y + 180) % 360) + 360) % 360) - 180;
}

/** Distance from point (px, pz) to the axis-aligned rect [x0,x1] x [z0,z1]. */
export function rectDistance(px: number, pz: number, x0: number, z0: number, x1: number, z1: number): number {
  const dx = Math.max(x0 - px, 0, px - x1);
  const dz = Math.max(z0 - pz, 0, pz - z1);
  return Math.sqrt(dx * dx + dz * dz);
}
