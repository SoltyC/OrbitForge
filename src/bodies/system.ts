/**
 * The Helion system — a fictional star system tuned for playability rather
 * than fidelity (see docs/PLAN.md §9). Constants are Kerbin-scaled: small
 * enough that orbits are reachable in minutes, large enough that real orbital
 * mechanics still govern everything.
 *
 * Milestone 1 ships only the homeworld. Moons and outer planets arrive with
 * the SOI work in milestone 4.
 */
import type { Body } from './types.js';

/**
 * Terrin — the homeworld. 600 km radius, 9.81 m/s^2 at sea level, 70 km of
 * atmosphere. Circular orbit just above the atmosphere needs ~2296 m/s.
 */
export const TERRIN: Body = {
  id: 'terrin',
  name: 'Terrin',
  mu: 3.5316e12,
  radius: 600_000,
  rotationPeriod: 21_600,
  soiRadius: 84_159_286,
  atmosphere: {
    height: 70_000,
    scaleHeight: 5_600,
    seaLevelPressure: 101_325,
    seaLevelDensity: 1.225,
  },
  surface: {
    seed: 20260913,
    color: 0x3a6b4f,
  },
};

export const BODIES: readonly Body[] = [TERRIN];

export function findBody(id: string): Body {
  const body = BODIES.find((b) => b.id === id);
  if (!body) throw new Error(`Unknown celestial body: ${id}`);
  return body;
}
