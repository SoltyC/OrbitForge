/**
 * The Helion system — a fictional star system tuned for playability rather
 * than fidelity (see docs/PLAN.md §9). Constants are Kerbin-scaled: small
 * enough that orbits are reachable in minutes, large enough that real orbital
 * mechanics still govern everything.
 */
import { Vec3 } from '../sim/vec3.js';
import { DEFAULT_TERRAIN } from '../terrain/height.js';
import type { Body } from './types.js';
import { sphereOfInfluence } from './types.js';

/** Lunara's orbital radius around Terrin (m). */
const LUNARA_ORBIT_RADIUS = 12_000_000;

const TERRIN_MU = 3.5316e12;
const LUNARA_MU = 6.5138398e10;

/**
 * Terrin — the homeworld. 600 km radius, 9.81 m/s^2 at sea level, 70 km of
 * atmosphere. Circular orbit just above the atmosphere needs ~2296 m/s.
 *
 * It is the root of the system, so its sphere of influence is unbounded: there
 * is nothing further out to hand a vessel off to.
 */
export const TERRIN: Body = {
  id: 'terrin',
  name: 'Terrin',
  mu: TERRIN_MU,
  radius: 600_000,
  rotationPeriod: 21_600,
  soiRadius: Infinity,
  parentId: null,
  orbit: null,
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
  terrain: DEFAULT_TERRAIN,
  launchSite: new Vec3(-0.995045, -0.099424, 0),
};

/**
 * Lunara — Terrin's airless moon, on a circular equatorial orbit. Landing here
 * is the milestone 4 objective: no atmosphere means no drag and no parachutes,
 * so the descent has to be flown on the engine alone.
 */
export const LUNARA: Body = {
  id: 'lunara',
  name: 'Lunara',
  mu: LUNARA_MU,
  radius: 200_000,
  rotationPeriod: 138_984,
  soiRadius: sphereOfInfluence(LUNARA_ORBIT_RADIUS, LUNARA_MU, TERRIN_MU),
  parentId: 'terrin',
  orbit: {
    semiMajorAxis: LUNARA_ORBIT_RADIUS,
    eccentricity: 0,
    inclination: 0,
    longitudeOfAscendingNode: 0,
    argumentOfPeriapsis: 0,
    trueAnomaly: 0,
  },
  atmosphere: null,
  surface: {
    seed: 77010203,
    color: 0x8a8578,
  },
  // Lunara keeps the placeholder sphere for now; a cratered profile is its own
  // height field rather than a reuse of Terrin's.
  terrain: null,
  launchSite: new Vec3(1, 0, 0),
};

export const BODIES: readonly Body[] = [TERRIN, LUNARA];

export function findBody(id: string): Body {
  const body = BODIES.find((b) => b.id === id);
  if (!body) throw new Error(`Unknown celestial body: ${id}`);
  return body;
}

/** The body at the root of the system — everything else orbits it. */
export function rootBody(): Body {
  const root = BODIES.find((b) => b.parentId === null);
  if (!root) throw new Error('System has no root body');
  return root;
}

/** Bodies directly orbiting the given one. */
export function childrenOf(bodyId: string): readonly Body[] {
  return BODIES.filter((b) => b.parentId === bodyId);
}

export function parentOf(body: Body): Body | null {
  return body.parentId ? findBody(body.parentId) : null;
}
