// Camera pose in the URL hash: #x,y,z,yaw,pitch (reference frame, Minecraft yaw/pitch).
export interface Pose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

export function readHash(): Pose | null {
  const parts = location.hash.replace(/^#/, "").split(",").map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
  const [x, y, z, yaw = 0, pitch = 0] = parts as [number, number, number, number?, number?];
  return { x, y, z, yaw: Number.isFinite(yaw) ? yaw : 0, pitch: Number.isFinite(pitch) ? pitch : 0 };
}

let last = "";
export function poseHash(p: Pose): string {
  const r = (n: number) => String(Math.round(n * 10) / 10);
  return `#${r(p.x)},${r(p.y)},${r(p.z)},${r(p.yaw)},${r(p.pitch)}`;
}

export function writeHash(p: Pose): void {
  const h = poseHash(p);
  if (h === last) return;
  last = h;
  history.replaceState(null, "", h);
}

/** True when the hash differs from what we last wrote (i.e. the user edited or pasted it). */
export function hashIsForeign(): boolean {
  return location.hash !== last;
}
