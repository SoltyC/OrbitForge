/**
 * Ray/sphere geometry for atmospheric integration.
 *
 * Everything in the scattering model is parameterised by two numbers: the
 * radius `r` of a point, and the cosine `mu` of the angle between "up" at that
 * point and the direction of travel. Two numbers describe any ray through a
 * spherically symmetric atmosphere, which is exactly why the lookup tables can
 * be so small.
 */

/**
 * Distance along a ray from radius `r` with zenith cosine `mu` to where it
 * meets a sphere of radius `sphereRadius`, or -1 if it never does.
 */
export function distanceToSphere(r: number, mu: number, sphereRadius: number): number {
  const discriminant = r * r * (mu * mu - 1) + sphereRadius * sphereRadius;
  if (discriminant < 0) return -1;
  return Math.max(0, -r * mu + Math.sqrt(discriminant));
}

/** Distance to the top of the atmosphere. Always exists for a ray inside it. */
export function distanceToTop(
  r: number,
  mu: number,
  topRadius: number,
): number {
  return distanceToSphere(r, mu, topRadius);
}

/**
 * Distance to where a ray first enters a sphere from outside it, or -1 if it
 * misses. This is the near intersection, where `distanceToSphere` gives the far
 * one.
 *
 * Needed when viewing a planet from space: without it the raymarch starts at
 * the camera and spends most of its samples in vacuum before reaching any air,
 * which leaves the limb noisy and under-lit.
 */
export function distanceToSphereEntry(
  r: number,
  mu: number,
  sphereRadius: number,
): number {
  const discriminant = r * r * (mu * mu - 1) + sphereRadius * sphereRadius;
  if (discriminant < 0) return -1;

  const near = -r * mu - Math.sqrt(discriminant);
  return near >= 0 ? near : -1;
}

/**
 * Distance to the ground, or -1 when the ray misses it.
 *
 * A downward ray that passes above the surface must not be treated as hitting
 * it, or the sky would be black wherever the view grazes the horizon.
 */
export function distanceToGround(
  r: number,
  mu: number,
  bottomRadius: number,
): number {
  const discriminant = r * r * (mu * mu - 1) + bottomRadius * bottomRadius;
  if (discriminant < 0 || mu > 0) return -1;
  return Math.max(0, -r * mu - Math.sqrt(discriminant));
}

/** True when a ray from (r, mu) intersects the ground. */
export function hitsGround(r: number, mu: number, bottomRadius: number): boolean {
  return mu < 0 && r * r * (mu * mu - 1) + bottomRadius * bottomRadius >= 0;
}

/**
 * Radius reached after travelling `d` along a ray from (r, mu).
 * Straight-line travel in a spherical shell, by the cosine rule.
 */
export function radiusAt(r: number, mu: number, d: number): number {
  return Math.sqrt(Math.max(0, d * d + 2 * r * mu * d + r * r));
}

/** Zenith cosine after travelling `d` along a ray from (r, mu). */
export function muAt(r: number, mu: number, d: number): number {
  const newRadius = radiusAt(r, mu, d);
  if (newRadius <= 0) return mu;
  return clampCosine((r * mu + d) / newRadius);
}

/**
 * Cosine of the angle between the sun and "up" after travelling `d`.
 * `muSun` is that cosine at the start, and `nu` the cosine between the view
 * direction and the sun.
 */
export function muSunAt(
  r: number,
  muSun: number,
  nu: number,
  d: number,
): number {
  const newRadius = radiusAt(r, muSun, d);
  if (newRadius <= 0) return muSun;
  return clampCosine((r * muSun + d * nu) / newRadius);
}

export function clampCosine(value: number): number {
  return Math.min(1, Math.max(-1, value));
}

export function clampRadius(
  r: number,
  bottomRadius: number,
  topRadius: number,
): number {
  return Math.min(topRadius, Math.max(bottomRadius, r));
}

/** Distance from the ground sphere to the top, used to normalise LUT axes. */
export function atmosphereThicknessParameter(
  bottomRadius: number,
  topRadius: number,
): number {
  return Math.sqrt(topRadius * topRadius - bottomRadius * bottomRadius);
}
