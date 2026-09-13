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
import type { Body } from '../bodies/types.js';
import type { FlightState } from './flightState.js';
import {
  elementsFromState,
  propagate,
  stateFromElements,
  timeToPeriapsis,
} from './orbit.js';
import type { OrbitalElements } from './orbit.js';
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
 * atmospheric entry.
 *
 * Without this, a high warp factor would tunnel a vessel straight through the
 * atmosphere — it would be above it before the step and below it after, and
 * the reentry would simply never be simulated.
 */
export function maxSafeRailsTimestep(
  rails: RailsState,
  body: Body,
  requestedDt: number,
): number {
  const atmosphere = body.atmosphere;
  if (!atmosphere) return requestedDt;

  const summary = elementsFromState(
    ...toStatePair(rails, body.mu),
    body.mu,
  );

  // An orbit that never dips into the atmosphere can warp freely.
  const entryRadius = body.radius + atmosphere.height;
  if (summary.periapsis > entryRadius) return requestedDt;

  // Otherwise never warp past the next periapsis pass.
  const secondsToPeriapsis = timeToPeriapsis(summary, body.mu);
  return Math.min(requestedDt, Math.max(0, secondsToPeriapsis));
}

function toStatePair(rails: RailsState, mu: number): [Vec3, Vec3] {
  const state = railsToCartesian(rails, mu);
  return [state.position, state.velocity];
}
