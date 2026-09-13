/**
 * Exponential (isothermal) atmosphere model.
 *
 * Density falls as rho = rho0 * exp(-h / H). This is the standard barometric
 * approximation and is accurate enough for ascent and reentry drag. It is
 * replaced by a tabulated curve only if a body needs a non-isothermal profile.
 */
import type { Body } from '../bodies/types.js';

/** Air density at altitude `altitude` (m above sea level), in kg/m^3. */
export function densityAt(body: Body, altitude: number): number {
  const atmo = body.atmosphere;
  if (!atmo) return 0;
  if (altitude >= atmo.height || altitude < -atmo.scaleHeight) return 0;
  return atmo.seaLevelDensity * Math.exp(-altitude / atmo.scaleHeight);
}

/** Ambient pressure at altitude (Pa). Drives engine Isp interpolation. */
export function pressureAt(body: Body, altitude: number): number {
  const atmo = body.atmosphere;
  if (!atmo) return 0;
  if (altitude >= atmo.height || altitude < -atmo.scaleHeight) return 0;
  return atmo.seaLevelPressure * Math.exp(-altitude / atmo.scaleHeight);
}

/**
 * Ambient pressure as a fraction of sea level, clamped to [0, 1].
 * Engines interpolate between their sea-level and vacuum ratings by this.
 */
export function pressureRatio(body: Body, altitude: number): number {
  const atmo = body.atmosphere;
  if (!atmo) return 0;
  const ratio = pressureAt(body, altitude) / atmo.seaLevelPressure;
  return Math.min(1, Math.max(0, ratio));
}

/** Dynamic pressure Q = 0.5 * rho * v^2 (Pa). Structural/heating limiter. */
export function dynamicPressure(density: number, speed: number): number {
  return 0.5 * density * speed * speed;
}

/** True if the altitude is inside the body's sensible atmosphere. */
export function isInAtmosphere(body: Body, altitude: number): boolean {
  return body.atmosphere !== null && altitude < body.atmosphere.height;
}
