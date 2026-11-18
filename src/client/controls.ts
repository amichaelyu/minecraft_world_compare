// Camera controls: fly mode (pointer-lock mouse look + WASD) and map/orbit mode (MapControls).
// Speed scales with the camera's height above ground, so the same keys cross the city from the
// air and creep along a street.
import * as THREE from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";
import { applyYawPitch, wrapYaw, yawPitchOf } from "./coords.ts";

export enum ControlMode {
  Fly = "fly",
  Map = "map",
}

const MOUSE_SENS = 0.12; // degrees per pixel

function isTyping(e: Event): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA");
}

export class CameraController {
  mode = ControlMode.Fly;
  yaw = 0;
  pitch = 0;
  /** blocks per second at street level; scroll wheel scales it */
  baseSpeed = 10;
  /** height above ground, set by the frame loop each frame */
  hag = 0;
  /** ground height under a reference-frame point, if known */
  groundAt: (x: number, z: number) => number | null = () => null;
  onModeChange: (m: ControlMode) => void = () => {};

  private readonly keys = new Set<string>();
  private readonly vel = new THREE.Vector3();
  private readonly map: MapControls;
  private dragging = false;
  private readonly _move = new THREE.Vector3();
  private readonly _v = new THREE.Vector3();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly dom: HTMLElement,
  ) {
    this.map = new MapControls(camera, dom);
    this.map.enabled = false;
    this.map.screenSpacePanning = false;
    this.map.enableDamping = true;
    this.map.dampingFactor = 0.15;
    this.map.maxPolarAngle = THREE.MathUtils.degToRad(88);
    this.map.minDistance = 2;
    this.map.maxDistance = 40000;
    this.map.zoomSpeed = 1.5;

    window.addEventListener("keydown", (e) => {
      if (isTyping(e)) return;
      if (e.code === "Tab") {
        e.preventDefault();
        this.toggleMode();
        return;
      }
      this.keys.add(e.code);
      if (this.mode === ControlMode.Fly && (e.code === "Space" || e.ctrlKey)) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());

    dom.addEventListener("mousedown", (e) => {
      if (this.mode !== ControlMode.Fly || e.button !== 0) return;
      this.dragging = true;
      if (document.pointerLockElement !== dom) {
        try {
          const p = dom.requestPointerLock() as unknown as Promise<void> | undefined;
          p?.catch?.(() => {});
        } catch {
          /* pointer lock unavailable: drag-to-look still works */
        }
      }
    });
    window.addEventListener("mouseup", () => (this.dragging = false));
    window.addEventListener("mousemove", (e) => {
      if (this.mode !== ControlMode.Fly) return;
      if (document.pointerLockElement !== dom && !this.dragging) return;
      this.yaw = wrapYaw(this.yaw + e.movementX * MOUSE_SENS);
      this.pitch = THREE.MathUtils.clamp(this.pitch + e.movementY * MOUSE_SENS, -89.9, 89.9);
      applyYawPitch(this.camera, this.yaw, this.pitch);
    });
    dom.addEventListener(
      "wheel",
      (e) => {
        if (this.mode !== ControlMode.Fly) return;
        e.preventDefault();
        this.baseSpeed = THREE.MathUtils.clamp(this.baseSpeed * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 0.5, 2000);
      },
      { passive: false },
    );
  }

  setPose(x: number, y: number, z: number, yaw: number, pitch: number): void {
    this.camera.position.set(x, y, z);
    this.yaw = wrapYaw(yaw);
    this.pitch = THREE.MathUtils.clamp(pitch, -89.9, 89.9);
    this.vel.set(0, 0, 0);
    if (this.mode === ControlMode.Map) {
      this.mode = ControlMode.Fly;
      this.map.enabled = false;
      this.toggleMode(); // re-enter map mode around the new view
    } else applyYawPitch(this.camera, this.yaw, this.pitch);
  }

  toggleMode(): void {
    if (this.mode === ControlMode.Fly) {
      if (document.pointerLockElement) document.exitPointerLock();
      applyYawPitch(this.camera, this.yaw, this.pitch);
      const pos = this.camera.position;
      const dir = this.camera.getWorldDirection(this._v);
      const ground = this.groundAt(pos.x, pos.z) ?? pos.y - 30;
      const target = new THREE.Vector3();
      if (dir.y < -0.05) {
        const t = Math.min((pos.y - ground) / -dir.y, 5000);
        target.copy(pos).addScaledVector(dir, Math.max(t, 5));
      } else {
        dir.y = 0;
        dir.normalize();
        target.copy(pos).addScaledVector(dir, Math.max(50, pos.y - ground));
        target.y = this.groundAt(target.x, target.z) ?? ground;
      }
      this.map.target.copy(target);
      this.map.enabled = true;
      this.map.update();
      this.mode = ControlMode.Map;
    } else {
      this.map.enabled = false;
      const { yaw, pitch } = yawPitchOf(this.camera);
      this.yaw = yaw;
      this.pitch = pitch;
      applyYawPitch(this.camera, yaw, pitch);
      this.mode = ControlMode.Fly;
    }
    this.vel.set(0, 0, 0);
    this.onModeChange(this.mode);
  }

  /** Effective fly speed (blocks/s) without the shift boost. */
  get speed(): number {
    return this.baseSpeed * this.altitudeFactor;
  }

  get altitudeFactor(): number {
    return THREE.MathUtils.clamp(this.hag / 12, 1, 500);
  }

  update(dt: number): void {
    if (this.mode === ControlMode.Map) {
      this.map.update(dt);
      // keep yaw/pitch in sync for the HUD and the URL hash
      const yp = yawPitchOf(this.camera);
      this.yaw = yp.yaw;
      this.pitch = yp.pitch;
      return;
    }
    const k = this.keys;
    const fwd = (k.has("KeyW") ? 1 : 0) - (k.has("KeyS") ? 1 : 0);
    const strafe = (k.has("KeyD") ? 1 : 0) - (k.has("KeyA") ? 1 : 0);
    const up =
      (k.has("Space") || k.has("KeyE") ? 1 : 0) -
      (k.has("KeyQ") || k.has("ControlLeft") || k.has("ControlRight") ? 1 : 0);
    const y = THREE.MathUtils.degToRad(this.yaw);
    const p = THREE.MathUtils.degToRad(this.pitch);
    const m = this._move.set(0, 0, 0);
    // forward follows the look direction (pitch included), strafe stays horizontal
    m.x += fwd * -Math.sin(y) * Math.cos(p) + strafe * -Math.cos(y);
    m.y += fwd * -Math.sin(p) + up;
    m.z += fwd * Math.cos(y) * Math.cos(p) + strafe * -Math.sin(y);
    if (m.lengthSq() > 1) m.normalize();
    const fast = k.has("ShiftLeft") || k.has("ShiftRight") ? 6 : 1;
    m.multiplyScalar(this.speed * fast);
    this.vel.lerp(m, 1 - Math.exp(-dt * 10));
    this.camera.position.addScaledVector(this.vel, dt);
  }
}
