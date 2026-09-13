/**
 * Chase camera.
 *
 * The vessel always renders at the scene origin (see FloatingOrigin), so the
 * camera orbits the origin. Its "up" is the vessel's local vertical, which
 * keeps the horizon level during ascent instead of rolling with the world.
 */
import type { PerspectiveCamera } from 'three/webgpu';
import { Vector3 } from 'three/webgpu';
import type { Vec3 } from '../sim/vec3.js';

const MIN_DISTANCE = 15;
const MAX_DISTANCE = 4_000;
const ZOOM_SENSITIVITY = 0.0015;
const ORBIT_SENSITIVITY = 0.005;
/** Clamp pitch just short of the poles to avoid gimbal flip. */
const MAX_PITCH = Math.PI / 2 - 0.05;

export class ChaseCamera {
  private distance = 60;
  private yaw = 0;
  private pitch = 0.25;
  private isDragging = false;

  constructor(private readonly camera: PerspectiveCamera) {}

  /** Wire up mouse orbit and wheel zoom on the canvas. */
  attach(element: HTMLElement): () => void {
    const onPointerDown = (): void => {
      this.isDragging = true;
    };
    const onPointerUp = (): void => {
      this.isDragging = false;
    };
    const onPointerMove = (event: PointerEvent): void => {
      if (!this.isDragging) return;
      this.yaw -= event.movementX * ORBIT_SENSITIVITY;
      this.pitch = clamp(
        this.pitch + event.movementY * ORBIT_SENSITIVITY,
        -MAX_PITCH,
        MAX_PITCH,
      );
    };
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const factor = Math.exp(event.deltaY * ZOOM_SENSITIVITY);
      this.distance = clamp(this.distance * factor, MIN_DISTANCE, MAX_DISTANCE);
    };

    element.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointermove', onPointerMove);
    element.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      element.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('wheel', onWheel);
    };
  }

  /**
   * Place the camera for this frame.
   *
   * @param localUp The vessel's radial "up" direction in simulation space.
   */
  update(localUp: Vec3): void {
    const up = new Vector3(localUp.x, localUp.y, localUp.z).normalize();

    // Build a stable basis around the local vertical.
    const reference =
      Math.abs(up.x) > 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
    const east = new Vector3().crossVectors(up, reference).normalize();
    const north = new Vector3().crossVectors(east, up).normalize();

    const horizontal = Math.cos(this.pitch);
    const offset = new Vector3()
      .addScaledVector(east, Math.cos(this.yaw) * horizontal)
      .addScaledVector(north, Math.sin(this.yaw) * horizontal)
      .addScaledVector(up, Math.sin(this.pitch))
      .multiplyScalar(this.distance);

    this.camera.position.copy(offset);
    this.camera.up.copy(up);
    this.camera.lookAt(0, 0, 0);
  }

  /** Widen the view as the vessel climbs so the planet stays framed. */
  setDistance(distance: number): void {
    this.distance = clamp(distance, MIN_DISTANCE, MAX_DISTANCE);
  }

  getDistance(): number {
    return this.distance;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
