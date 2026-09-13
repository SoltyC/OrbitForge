/**
 * Time-warp policy.
 *
 * Two tiers, because the two physics regimes have very different limits:
 *
 * - **Physics warp** (<= 10x) runs the RK4 integrator faster by taking more
 *   fixed steps per frame. It works anywhere, including under thrust and in
 *   atmosphere, but costs CPU linearly and so cannot go far.
 * - **Rails warp** (50x and up) advances the orbit analytically in a single
 *   solve, so 100,000x costs exactly as much as 1x. It is only available to a
 *   vessel coasting in vacuum, which is precisely when rails are valid.
 *
 * Requesting a rails-only warp while not on rails clamps to the physics tier
 * rather than failing, so the control is always safe to hold down.
 */
import type { FlightState } from './flightState.js';

export const WARP_LEVELS = [1, 2, 5, 10, 50, 100, 1_000, 10_000, 100_000] as const;

/** Index of the first level that requires being on rails. */
const FIRST_RAILS_LEVEL = 4;

/** Highest multiplier the integrator is allowed to attempt. */
export const MAX_PHYSICS_WARP_INDEX = FIRST_RAILS_LEVEL - 1;

export function warpFactorAt(index: number): number {
  return WARP_LEVELS[clampIndex(index)] ?? 1;
}

export function requiresRails(index: number): boolean {
  return clampIndex(index) >= FIRST_RAILS_LEVEL;
}

/**
 * The warp index actually permitted for this state. Clamps rails-tier requests
 * down to the physics tier whenever the vessel is not coasting on rails.
 */
export function permittedWarpIndex(state: FlightState, requestedIndex: number): number {
  const requested = clampIndex(requestedIndex);
  if (!requiresRails(requested)) return requested;
  return state.regime === 'onRails' ? requested : MAX_PHYSICS_WARP_INDEX;
}

export function clampIndex(index: number): number {
  return Math.min(WARP_LEVELS.length - 1, Math.max(0, Math.round(index)));
}

/** Human-readable label, e.g. "1x" or "10,000x". */
export function formatWarp(index: number): string {
  return `${warpFactorAt(index).toLocaleString('en-US')}x`;
}
