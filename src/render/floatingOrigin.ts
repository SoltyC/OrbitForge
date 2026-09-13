/**
 * Floating origin.
 *
 * Simulation positions are f64 metres from the body centre and reach into the
 * hundreds of millions. Feeding those straight to the GPU as f32 produces
 * visible jitter, so every frame we recentre the rendered world on the active
 * vessel: the vessel sits at the scene origin and everything else is placed
 * relative to it. Rendered coordinates then stay small and precise.
 */
import { Vector3 } from 'three/webgpu';
import type { Vec3 } from '../sim/vec3.js';

export class FloatingOrigin {
  private origin: Vec3;

  constructor(origin: Vec3) {
    this.origin = origin;
  }

  /** Move the render origin to a new simulation position. */
  setOrigin(origin: Vec3): void {
    this.origin = origin;
  }

  getOrigin(): Vec3 {
    return this.origin;
  }

  /** Convert a simulation position into render space. */
  toRender(simulationPosition: Vec3): Vector3 {
    const relative = simulationPosition.sub(this.origin);
    return new Vector3(relative.x, relative.y, relative.z);
  }

  /** Write a simulation position into an existing Three.js vector. */
  writeTo(simulationPosition: Vec3, target: Vector3): Vector3 {
    const relative = simulationPosition.sub(this.origin);
    return target.set(relative.x, relative.y, relative.z);
  }
}
