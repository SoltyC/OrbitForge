/**
 * Force model for powered atmospheric flight.
 *
 * Every force here is expressed in the body-centred inertial frame and
 * returned in newtons. Gravity is single-body (patched conics): a vessel only
 * ever feels the gravity of its current sphere-of-influence owner.
 */
import type { Body } from '../bodies/types.js';
import { densityAt } from './atmosphere.js';
import { Vec3 } from './vec3.js';

/** Drag coefficient of the stack, nose-on. */
export const DRAG_COEFFICIENT = 0.25;

/**
 * Newtonian gravity toward the body centre.
 * a = -mu / r^2, directed along -r_hat; returned as a force via F = m*a.
 */
export function gravityForce(body: Body, position: Vec3, mass: number): Vec3 {
  const rSq = position.lengthSq;
  if (rSq === 0) return Vec3.ZERO;
  const magnitude = (body.mu * mass) / rSq;
  return position.normalized().scale(-magnitude);
}

/** Gravitational acceleration magnitude at a position (m/s^2). */
export function gravityMagnitude(body: Body, radius: number): number {
  if (radius <= 0) return 0;
  return body.mu / (radius * radius);
}

/**
 * Aerodynamic drag: F = -0.5 * rho * v^2 * Cd * A, opposing the velocity
 * relative to the rotating atmosphere.
 */
export function dragForce(
  body: Body,
  position: Vec3,
  velocity: Vec3,
  area: number,
): Vec3 {
  const altitude = position.length - body.radius;
  const density = densityAt(body, altitude);
  if (density <= 0) return Vec3.ZERO;

  const airVelocity = velocity.sub(atmosphericVelocity(body, position));
  const speed = airVelocity.length;
  if (speed <= 0) return Vec3.ZERO;

  const magnitude = 0.5 * density * speed * speed * DRAG_COEFFICIENT * area;
  return airVelocity.normalized().scale(-magnitude);
}

/**
 * Velocity of the atmosphere at a position, from the body's rotation.
 * The atmosphere is assumed to co-rotate rigidly with the surface.
 */
export function atmosphericVelocity(body: Body, position: Vec3): Vec3 {
  if (body.rotationPeriod === 0) return Vec3.ZERO;
  const angularVelocity = new Vec3(0, 0, (2 * Math.PI) / body.rotationPeriod);
  return angularVelocity.cross(position);
}

/** Thrust along the vessel's pointing direction (N). */
export function thrustForce(direction: Vec3, magnitude: number): Vec3 {
  return direction.normalized().scale(magnitude);
}

/** Altitude above sea level (m). */
export function altitudeOf(body: Body, position: Vec3): number {
  return position.length - body.radius;
}

/** Speed relative to the rotating surface — what a pitot tube would read. */
export function surfaceRelativeVelocity(
  body: Body,
  position: Vec3,
  velocity: Vec3,
): Vec3 {
  return velocity.sub(atmosphericVelocity(body, position));
}

/** Vertical (radially outward) component of velocity (m/s). */
export function verticalSpeed(position: Vec3, velocity: Vec3): number {
  return velocity.dot(position.normalized());
}

/** Horizontal (tangential) speed (m/s). */
export function horizontalSpeed(position: Vec3, velocity: Vec3): number {
  return velocity.rejectFrom(position).length;
}
