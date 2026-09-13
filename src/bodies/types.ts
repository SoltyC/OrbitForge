/**
 * Celestial body definitions. All values SI: metres, kilograms, seconds.
 */

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
  readonly atmosphere: AtmosphereDef | null;
  readonly surface: SurfaceDef;
}

/** Surface gravity magnitude at sea level (m/s^2). */
export function surfaceGravity(body: Body): number {
  return body.mu / (body.radius * body.radius);
}

/** Speed of a circular orbit at radius `r` from the body centre (m/s). */
export function circularOrbitSpeed(body: Body, r: number): number {
  return Math.sqrt(body.mu / r);
}
