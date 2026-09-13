/**
 * Map-view camera.
 *
 * Where the chase camera orbits the vessel, the map camera orbits the *body*
 * and frames the whole trajectory — the view you plan manoeuvres in. It shares
 * the scene and the floating origin with flight view, so switching between
 * them is just a change of camera placement.
 */
import type { PerspectiveCamera, Vector3 } from 'three/webgpu';
import { Vector3 as Vec3Three } from 'three/webgpu';

/** Zoom bounds as a multiple of the framed orbit radius. */
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 12;
const ZOOM_SENSITIVITY = 0.0015;
const ORBIT_SENSITIVITY = 0.005;
const MAX_PITCH = Math.PI / 2 - 0.05;

/** Bodies spin about +Z, so that is "up" in map view. */
const MAP_UP = new Vec3Three(0, 0, 1);

export class MapCamera {
  private zoom = 2.6;
  private yaw = 0.6;
  private pitch = 0.6;
  private isDragging = false;
  private lastDistance = 1;

  constructor(private readonly camera: PerspectiveCamera) {}

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
      this.zoom = clamp(
        this.zoom * Math.exp(event.deltaY * ZOOM_SENSITIVITY),
        MIN_ZOOM,
        MAX_ZOOM,
      );
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
   * @param bodyCentre The body's position in render space.
   * @param frameRadius Orbit radius to frame, in metres.
   */
  update(bodyCentre: Vector3, frameRadius: number): void {
    const distance = frameRadius * this.zoom;
    this.lastDistance = distance;

    const horizontal = Math.cos(this.pitch);
    const offset = new Vec3Three(
      Math.cos(this.yaw) * horizontal,
      Math.sin(this.yaw) * horizontal,
      Math.sin(this.pitch),
    ).multiplyScalar(distance);

    this.camera.position.copy(bodyCentre).add(offset);
    this.camera.up.copy(MAP_UP);
    this.camera.lookAt(bodyCentre);
  }

  getDistance(): number {
    return this.lastDistance;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
