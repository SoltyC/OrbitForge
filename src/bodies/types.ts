/**
 * Celestial body definitions. All values SI: metres, kilograms, seconds.
 */
import type { OrbitalElements } from '../sim/orbit.js';
import type { TerrainProfile } from '../terrain/height.js';
import type { Vec3 } from '../sim/vec3.js';

export interface AtmosphereDef {
  /** Altitude above sea level where the atmosphere ends (m). */
  readonly height: number;
  /** Exponential scale height (m): density falls by 1/e over this distance. */
  readonly scaleHeight: number;
  /** Sea-level pressure (Pa). */
  readonly seaLevelPressure: number;
  /** Sea-level density (kg/m^3). */
  readonly seaLevelDensity: number;
}

export interface SurfaceDef {
  /** Deterministic seed for procedural terrain (used from milestone 7). */
  readonly seed: number;
  /** Base surface colour, used by the placeholder sphere renderer. */
  readonly color: number;
}

export interface Body {
  readonly id: string;
  readonly name: string;
  /** Standard gravitational parameter mu = G*M (m^3/s^2). */
  readonly mu: number;
  /** Mean equatorial radius, i.e. "sea level" (m). */
  readonly radius: number;
  /** Sidereal rotation period (s). */
  readonly rotationPeriod: number;
  /** Sphere-of-influence radius (m). Infinite for the root body. */
  readonly soiRadius: number;
  /** Body this one orbits, or null for the root of the system. */
  readonly parentId: string | null;
  /** Orbit around the parent at epoch (t = 0). Null for the root body. */
  readonly orbit: OrbitalElements | null;
  readonly atmosphere: AtmosphereDef | null;
  readonly surface: SurfaceDef;
  /**
   * Height field for real terrain. Bodies without one keep the placeholder
   * sphere, which is all an airless moon seen from orbit has needed so far.
   */
  readonly terrain: TerrainProfile | null;
  /**
   * Unit direction from the centre to the launch site.
   *
   * Chosen rather than assumed. With real terrain the old default of the +X
   * axis put the pad 489 m under water.
   *
   * On the equator, and not merely near it. Launching nine degrees off put the
   * vessel into an inclined orbit, and the transfer planner works in one plane
   * — the moon simply stopped being reachable, and a mission that had taken
   * nine hours ran for three thousand.
   *
   * And on the daylight side. The flattest equatorial land happened to sit at
   * a sun angle of -0.955, so the game opened at midnight: ground, sky and sea
   * all correctly black, which reads exactly like a renderer that has failed.
   * This is a little rougher and lit.
   */
  readonly launchSite: Vec3;
}

/**
 * Radius of a body's sphere of influence (m).
 *
 * r = a * (m_body / m_parent)^(2/5). Inside it, the patched-conic model treats
 * this body as the only source of gravity; outside, the parent takes over.
 */
export function sphereOfInfluence(
  semiMajorAxis: number,
  mu: number,
  parentMu: number,
): number {
  return semiMajorAxis * Math.pow(mu / parentMu, 2 / 5);
}

/** Surface gravity magnitude at sea level (m/s^2). */
export function surfaceGravity(body: Body): number {
  return body.mu / (body.radius * body.radius);
}

/** Speed of a circular orbit at radius `r` from the body centre (m/s). */
export function circularOrbitSpeed(body: Body, r: number): number {
  return Math.sqrt(body.mu / r);
}
