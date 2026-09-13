/**
 * Body ephemeris: where a celestial body is, and how fast it is moving.
 *
 * Bodies are on rails permanently — they never feel the vessel, and their
 * orbits never change — so their positions are always an analytic Kepler solve
 * from the epoch elements. No integration, no drift, and the same answer for a
 * given time no matter how the simulation got there.
 */
import { propagate, stateFromElements } from '../sim/orbit.js';
import { Vec3 } from '../sim/vec3.js';
import { findBody, parentOf } from './system.js';
import type { Body } from './types.js';

export interface BodyState {
  /** Position relative to the parent body (m). */
  readonly position: Vec3;
  /** Velocity relative to the parent body (m/s). */
  readonly velocity: Vec3;
}

const AT_REST: BodyState = { position: Vec3.ZERO, velocity: Vec3.ZERO };

/** State of a body relative to its parent at mission time `time`. */
export function bodyStateAt(body: Body, time: number): BodyState {
  const parent = parentOf(body);
  if (!parent || !body.orbit) return AT_REST;

  const elements = propagate(body.orbit, parent.mu, time);
  return stateFromElements(elements, parent.mu);
}

/**
 * Convert a position expressed in `from`'s frame into `to`'s frame.
 *
 * Both frames must belong to the same system. This walks each frame up to the
 * shared root and differences the two chains, so it works between any pair of
 * bodies regardless of how deeply nested they are.
 */
export function transformFrame(
  position: Vec3,
  velocity: Vec3,
  from: Body,
  to: Body,
  time: number,
): BodyState {
  if (from.id === to.id) return { position, velocity };

  const fromRoot = chainToRoot(from, time);
  const toRoot = chainToRoot(to, time);

  return {
    position: position.add(fromRoot.position).sub(toRoot.position),
    velocity: velocity.add(fromRoot.velocity).sub(toRoot.velocity),
  };
}

/** Absolute state of a body in the root frame at `time`. */
export function chainToRoot(body: Body, time: number): BodyState {
  let position = Vec3.ZERO;
  let velocity = Vec3.ZERO;

  let current: Body | null = body;
  while (current && current.parentId) {
    const state = bodyStateAt(current, time);
    position = position.add(state.position);
    velocity = velocity.add(state.velocity);
    current = findBody(current.parentId);
  }

  return { position, velocity };
}

/**
 * Position of `target` as seen from `observer`'s frame at `time`.
 * Used to test whether a vessel has fallen inside a moon's sphere of influence.
 */
export function relativePosition(observer: Body, target: Body, time: number): Vec3 {
  const observerState = chainToRoot(observer, time);
  const targetState = chainToRoot(target, time);
  return targetState.position.sub(observerState.position);
}

/** Orbital period of a body around its parent (s), or Infinity for the root. */
export function orbitalPeriod(body: Body): number {
  const parent = parentOf(body);
  if (!parent || !body.orbit) return Infinity;

  const a = body.orbit.semiMajorAxis;
  return 2 * Math.PI * Math.sqrt((a * a * a) / parent.mu);
}
