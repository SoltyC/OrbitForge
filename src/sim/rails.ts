/**
 * On-rails propagation.
 *
 * A vessel that is coasting in vacuum on a closed orbit is put "on rails": its
 * trajectory is stored as Keplerian elements and advanced by solving Kepler's
 * equation rather than by integrating forces. This is what makes time-warp
 * possible — a single analytic solve can advance an hour as cheaply as a
 * millisecond, where RK4 would need 180,000 steps to do the same.
 *
 * It is also *more* accurate than integrating, not less: the orbit's shape is
 * carried forward exactly, so a/e/i cannot drift at all.
 */
import { densityAt } from './atmosphere.js';
import { childrenOf } from '../bodies/system.js';
import type { Body } from '../bodies/types.js';
import type { FlightState } from './flightState.js';
import {
  elementsFromState,
  propagate,
  stateFromElements,
  timeToPeriapsis,
} from './orbit.js';
import type { OrbitalElements } from './orbit.js';
import { distanceToNearestBoundary } from './soi.js';
import type { FrameState } from './soi.js';
import type { Vec3 } from './vec3.js';

export interface RailsState {
  /** The frozen orbit. Only the true anomaly advances. */
  readonly elements: OrbitalElements;
}

/**
 * Altitude margin above the atmosphere at which rails are dropped. Gives the
 * force model a little room before drag becomes relevant.
 */
const RAILS_ALTITUDE_MARGIN = 500;

/**
 * A vessel can go on rails only when nothing but gravity is acting on it: no
 * thrust, no meaningful atmosphere, and a closed orbit to propagate along.
 */
export function canGoOnRails(state: FlightState): boolean {
  if (state.throttle > 0) return false;
  if (state.regime === 'landed' || state.regime === 'prelaunch') return false;
  if (isInDrag(state.body, state.position)) return false;

  const elements = elementsFromState(state.position, state.velocity, state.body.mu);
  return elements.isClosed && elements.periapsis > 0;
}

/** Freeze the current Cartesian state into orbital elements. */
export function enterRails(state: FlightState): RailsState {
  return {
    elements: elementsFromState(state.position, state.velocity, state.body.mu),
  };
}

/** Advance a rails orbit analytically. `dt` may be arbitrarily large. */
export function advanceRails(rails: RailsState, mu: number, dt: number): RailsState {
  return { elements: propagate(rails.elements, mu, dt) };
}

/** Convert a rails orbit back into position and velocity. */
export function railsToCartesian(
  rails: RailsState,
  mu: number,
): { position: Vec3; velocity: Vec3 } {
  return stateFromElements(rails.elements, mu);
}

/** True where the atmosphere is dense enough that rails would be wrong. */
function isInDrag(body: Body, position: Vec3): boolean {
  const atmosphere = body.atmosphere;
  if (!atmosphere) return false;

  const altitude = position.length - body.radius;
  if (altitude > atmosphere.height + RAILS_ALTITUDE_MARGIN) return false;

  // Above the stated ceiling density is exactly zero, so only the margin band
  // and below counts as dragging.
  return densityAt(body, altitude) > 0 || altitude <= atmosphere.height;
}

/**
 * The largest timestep that can safely be taken on rails without skipping past
 * something that must be simulated: atmospheric entry, or a sphere-of-influence
 * boundary.
 *
 * Without this, a high warp factor would tunnel a vessel straight through — it
 * would be outside before the step and inside after, and the transition would
 * simply never happen.
 */
export function maxSafeRailsTimestep(
  rails: RailsState,
  body: Body,
  requestedDt: number,
  time = 0,
): number {
  const { position, velocity } = railsToCartesian(rails, body.mu);
  const summary = elementsFromState(position, velocity, body.mu);

  return Math.min(
    atmosphereLimit(summary, body, requestedDt),
    boundaryLimit({ body, position, velocity }, summary, time, requestedDt),
  );
}

function atmosphereLimit(
  summary: ReturnType<typeof elementsFromState>,
  body: Body,
  requestedDt: number,
): number {
  const atmosphere = body.atmosphere;
  if (!atmosphere) return requestedDt;

  // An orbit that never dips into the atmosphere can warp freely.
  const entryRadius = body.radius + atmosphere.height;
  if (summary.periapsis > entryRadius) return requestedDt;

  // Otherwise never warp past the next periapsis pass.
  return Math.min(requestedDt, Math.max(0, timeToPeriapsis(summary, body.mu)));
}

/**
 * Limit the step so the vessel cannot leap across an SOI boundary.
 *
 * Screened by geometry first: an orbit whose apoapsis falls short of every
 * boundary simply cannot reach one, so it warps at full speed. Only when a
 * crossing is actually reachable does this fall back to the conservative
 * clearance-over-speed bound, which assumes the worst case of heading straight
 * at the nearest boundary.
 */
function boundaryLimit(
  state: FrameState,
  summary: ReturnType<typeof elementsFromState>,
  time: number,
  requestedDt: number,
): number {
  if (!canReachBoundary(state.body, summary)) return requestedDt;

  const clearance = distanceToNearestBoundary(state, time);
  if (!Number.isFinite(clearance)) return requestedDt;

  const speed = state.velocity.length;
  if (speed <= 0) return requestedDt;

  // Half the clearance keeps the endpoint on this side of the boundary even
  // as the boundary itself moves with its body.
  return Math.min(requestedDt, Math.max(0, (clearance * 0.5) / speed));
}

/**
 * Could this orbit ever reach a sphere-of-influence boundary?
 *
 * Two ways: climb out past the current body's own SOI, or cross the orbital
 * band swept by one of its moons.
 */
function canReachBoundary(
  body: Body,
  summary: ReturnType<typeof elementsFromState>,
): boolean {
  // An unbound or SOI-exceeding orbit is on its way out.
  if (!summary.isClosed) return true;
  if (summary.apoapsis >= body.soiRadius) return true;

  for (const child of childrenOf(body.id)) {
    if (!child.orbit) continue;

    const inner = child.orbit.semiMajorAxis - child.soiRadius;
    const outer = child.orbit.semiMajorAxis + child.soiRadius;

    // Ranges overlap only if the vessel's radius band meets the moon's.
    if (summary.apoapsis >= inner && summary.periapsis <= outer) return true;
  }

  return false;
}
