/**
 * Complete dynamic state of a vessel in flight. Immutable: every simulation
 * step produces a new FlightState rather than mutating the previous one.
 */
import type { Body } from '../bodies/types.js';
import { Quat } from './quat.js';
import { Vec3 } from './vec3.js';
import type { Vessel } from './vessel.js';

/** Which physics regime the vessel is currently integrated under. */
export type FlightRegime = 'prelaunch' | 'powered' | 'coasting' | 'landed';

export interface FlightState {
  /** Mission elapsed time (s). */
  readonly time: number;
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly orientation: Quat;
  /** Angular velocity in the inertial frame (rad/s). */
  readonly angularVelocity: Vec3;
  readonly vessel: Vessel;
  /** Commanded throttle in [0, 1]. */
  readonly throttle: number;
  readonly regime: FlightRegime;
  readonly body: Body;
}

/** Local vessel axis that thrust acts along, before rotation. */
const LOCAL_THRUST_AXIS = new Vec3(0, 1, 0);

/** Unit vector the vessel's nose (and thrust) currently points along. */
export function thrustAxis(state: FlightState): Vec3 {
  return state.orientation.rotate(LOCAL_THRUST_AXIS);
}

/** Radially outward unit vector ("up") at the vessel's position. */
export function upDirection(state: FlightState): Vec3 {
  return state.position.normalized();
}

/**
 * Local east unit vector — the direction of the body's rotation. Launching
 * east banks the surface rotation as free orbital velocity.
 */
export function eastDirection(position: Vec3): Vec3 {
  const spinAxis = new Vec3(0, 0, 1);
  const east = spinAxis.cross(position);
  // Degenerate exactly at the poles; any horizontal direction will do there.
  return east.lengthSq > 0 ? east.normalized() : new Vec3(1, 0, 0);
}

/** Horizontal prograde direction: velocity with the radial component removed. */
export function horizontalPrograde(position: Vec3, velocity: Vec3): Vec3 {
  const horizontal = velocity.rejectFrom(position);
  return horizontal.lengthSq > 0 ? horizontal.normalized() : eastDirection(position);
}

/**
 * Build a pointing direction from a pitch angle above the local horizon,
 * heading east. 90 degrees is straight up, 0 is horizontal downrange.
 */
export function directionFromPitch(position: Vec3, pitchRadians: number): Vec3 {
  const up = position.normalized();
  const east = eastDirection(position);
  return up.scale(Math.sin(pitchRadians)).add(east.scale(Math.cos(pitchRadians))).normalized();
}

/** Create a vessel sitting on the launchpad at the equator, facing up. */
export function createPrelaunchState(
  body: Body,
  vessel: Vessel,
  padHeight = 0,
): FlightState {
  const position = new Vec3(body.radius + padHeight, 0, 0);
  // Sitting on the pad means co-rotating with the surface.
  const spinAxis = new Vec3(0, 0, (2 * Math.PI) / body.rotationPeriod);
  const velocity = spinAxis.cross(position);

  return {
    time: 0,
    position,
    velocity,
    orientation: Quat.fromUnitVectors(LOCAL_THRUST_AXIS, position.normalized()),
    angularVelocity: Vec3.ZERO,
    vessel,
    throttle: 0,
    regime: 'prelaunch',
    body,
  };
}
