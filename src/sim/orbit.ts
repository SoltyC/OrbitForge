/**
 * Two-body (Keplerian) orbital mechanics.
 *
 * Converts between Cartesian state vectors and orbital elements, and
 * propagates an orbit analytically by solving Kepler's equation. Analytic
 * propagation is what makes arbitrary time-warp possible: we never integrate
 * millions of steps to fast-forward an orbit.
 */
import { Vec3 } from './vec3.js';

/** Tolerance and iteration cap for the Newton solve on Kepler's equation. */
const KEPLER_TOLERANCE = 1e-12;
const KEPLER_MAX_ITERATIONS = 64;

/** Below this eccentricity an orbit is treated as circular (argument of
 *  periapsis and true anomaly are otherwise undefined). */
const CIRCULAR_EPSILON = 1e-9;

/** Below this inclination an orbit is treated as equatorial. */
const EQUATORIAL_EPSILON = 1e-9;

export interface OrbitalElements {
  /** Semi-major axis (m). Negative for hyperbolic orbits. */
  readonly semiMajorAxis: number;
  readonly eccentricity: number;
  /** Inclination (rad). */
  readonly inclination: number;
  /** Longitude of the ascending node (rad). */
  readonly longitudeOfAscendingNode: number;
  /** Argument of periapsis (rad). */
  readonly argumentOfPeriapsis: number;
  /** True anomaly at epoch (rad). */
  readonly trueAnomaly: number;
}

export interface OrbitSummary extends OrbitalElements {
  /** Distance from body centre at apoapsis (m). Infinity if not closed. */
  readonly apoapsis: number;
  /** Distance from body centre at periapsis (m). */
  readonly periapsis: number;
  /** Orbital period (s). Infinity if not closed. */
  readonly period: number;
  readonly isClosed: boolean;
}

/**
 * Derive orbital elements from a Cartesian state vector.
 *
 * @param position Position relative to the body centre (m).
 * @param velocity Velocity in the body-centred inertial frame (m/s).
 * @param mu Standard gravitational parameter of the body (m^3/s^2).
 */
export function elementsFromState(
  position: Vec3,
  velocity: Vec3,
  mu: number,
): OrbitSummary {
  const r = position.length;
  const v = velocity.length;

  // Specific angular momentum.
  const h = position.cross(velocity);

  // Eccentricity vector: points at periapsis, magnitude is eccentricity.
  const eVec = velocity
    .cross(h)
    .scale(1 / mu)
    .sub(position.normalized());
  const eccentricity = eVec.length;

  // Vis-viva gives the semi-major axis from specific orbital energy.
  const specificEnergy = (v * v) / 2 - mu / r;
  const semiMajorAxis = -mu / (2 * specificEnergy);

  const inclination = h.length > 0 ? Math.acos(clamp(h.z / h.length, -1, 1)) : 0;

  // Node vector points at the ascending node (zero for equatorial orbits).
  const nodeVec = new Vec3(0, 0, 1).cross(h);
  const isEquatorial = nodeVec.length < EQUATORIAL_EPSILON;
  const isCircular = eccentricity < CIRCULAR_EPSILON;

  const longitudeOfAscendingNode = isEquatorial
    ? 0
    : normalizeAngle(Math.atan2(nodeVec.y, nodeVec.x));

  const argumentOfPeriapsis = resolveArgumentOfPeriapsis(
    nodeVec,
    eVec,
    isEquatorial,
    isCircular,
  );

  const trueAnomaly = resolveTrueAnomaly(
    position,
    velocity,
    eVec,
    nodeVec,
    isEquatorial,
    isCircular,
  );

  const isClosed = eccentricity < 1 && semiMajorAxis > 0;
  const periapsis = semiMajorAxis * (1 - eccentricity);
  const apoapsis = isClosed ? semiMajorAxis * (1 + eccentricity) : Infinity;
  const period = isClosed
    ? 2 * Math.PI * Math.sqrt((semiMajorAxis * semiMajorAxis * semiMajorAxis) / mu)
    : Infinity;

  return {
    semiMajorAxis,
    eccentricity,
    inclination,
    longitudeOfAscendingNode,
    argumentOfPeriapsis,
    trueAnomaly,
    apoapsis,
    periapsis,
    period,
    isClosed,
  };
}

/** Rebuild a Cartesian state vector from orbital elements. */
export function stateFromElements(
  elements: OrbitalElements,
  mu: number,
): { position: Vec3; velocity: Vec3 } {
  const { semiMajorAxis: a, eccentricity: e, trueAnomaly: nu } = elements;

  // Semi-latus rectum, then the orbit equation for radius at this anomaly.
  const p = a * (1 - e * e);
  const r = p / (1 + e * Math.cos(nu));

  // State in the perifocal frame (x towards periapsis, z along angular momentum).
  const perifocalPos = new Vec3(r * Math.cos(nu), r * Math.sin(nu), 0);
  const vScale = Math.sqrt(mu / p);
  const perifocalVel = new Vec3(-vScale * Math.sin(nu), vScale * (e + Math.cos(nu)), 0);

  return {
    position: perifocalToInertial(perifocalPos, elements),
    velocity: perifocalToInertial(perifocalVel, elements),
  };
}

/**
 * Propagate an orbit forward by `dt` seconds analytically.
 *
 * Only the true anomaly changes; the orbit's shape and orientation are
 * constant in a two-body problem. This is the core of time-warp.
 */
export function propagate(
  elements: OrbitalElements,
  mu: number,
  dt: number,
): OrbitalElements {
  const { semiMajorAxis: a, eccentricity: e } = elements;
  if (e >= 1 || a <= 0) {
    throw new Error('Analytic propagation supports closed orbits only');
  }

  const meanMotion = Math.sqrt(mu / (a * a * a));
  const eccentricAnomaly0 = eccentricFromTrue(elements.trueAnomaly, e);
  const meanAnomaly0 = eccentricAnomaly0 - e * Math.sin(eccentricAnomaly0);

  const meanAnomaly = normalizeAngle(meanAnomaly0 + meanMotion * dt);
  const eccentricAnomaly = solveKepler(meanAnomaly, e);

  return { ...elements, trueAnomaly: trueFromEccentric(eccentricAnomaly, e) };
}

/**
 * Solve Kepler's equation M = E - e*sin(E) for the eccentric anomaly E via
 * Newton-Raphson. Converges for all elliptical eccentricities; the initial
 * guess is shifted for high-e orbits where plain M is a poor starting point.
 */
export function solveKepler(meanAnomaly: number, eccentricity: number): number {
  const m = normalizeAngle(meanAnomaly);
  let e = eccentricity > 0.8 ? Math.PI : m;

  for (let i = 0; i < KEPLER_MAX_ITERATIONS; i++) {
    const f = e - eccentricity * Math.sin(e) - m;
    const fPrime = 1 - eccentricity * Math.cos(e);
    const delta = f / fPrime;
    e -= delta;
    if (Math.abs(delta) < KEPLER_TOLERANCE) break;
  }

  return e;
}

/**
 * Seconds until the vessel next reaches apoapsis. Returns Infinity for orbits
 * that never come back around. Used to time the circularisation burn.
 */
export function timeToApoapsis(elements: OrbitSummary, mu: number): number {
  if (!elements.isClosed) return Infinity;

  const { semiMajorAxis: a, eccentricity: e } = elements;
  const meanMotion = Math.sqrt(mu / (a * a * a));

  const meanNow = meanAnomalyOf(elements.trueAnomaly, e);
  // Apoapsis is true anomaly PI, where mean anomaly is also PI.
  const delta = normalizeAngle(Math.PI - meanNow);

  return delta / meanMotion;
}

/** Mean anomaly corresponding to a true anomaly on an elliptical orbit. */
export function meanAnomalyOf(trueAnomaly: number, eccentricity: number): number {
  const eccentricAnomaly = eccentricFromTrue(trueAnomaly, eccentricity);
  return normalizeAngle(eccentricAnomaly - eccentricity * Math.sin(eccentricAnomaly));
}

/** Eccentric anomaly from true anomaly. */
export function eccentricFromTrue(trueAnomaly: number, e: number): number {
  return Math.atan2(
    Math.sqrt(1 - e * e) * Math.sin(trueAnomaly),
    e + Math.cos(trueAnomaly),
  );
}

/** True anomaly from eccentric anomaly. */
export function trueFromEccentric(eccentricAnomaly: number, e: number): number {
  return Math.atan2(
    Math.sqrt(1 - e * e) * Math.sin(eccentricAnomaly),
    Math.cos(eccentricAnomaly) - e,
  );
}

/** Rotate a perifocal-frame vector into the body-centred inertial frame. */
function perifocalToInertial(v: Vec3, elements: OrbitalElements): Vec3 {
  const { inclination: i, longitudeOfAscendingNode: raan } = elements;
  const argP = elements.argumentOfPeriapsis;

  const cosR = Math.cos(raan);
  const sinR = Math.sin(raan);
  const cosI = Math.cos(i);
  const sinI = Math.sin(i);
  const cosW = Math.cos(argP);
  const sinW = Math.sin(argP);

  // Standard 3-1-3 Euler rotation (RAAN, inclination, argument of periapsis).
  return new Vec3(
    v.x * (cosR * cosW - sinR * sinW * cosI) -
      v.y * (cosR * sinW + sinR * cosW * cosI),
    v.x * (sinR * cosW + cosR * sinW * cosI) -
      v.y * (sinR * sinW - cosR * cosW * cosI),
    v.x * (sinW * sinI) + v.y * (cosW * sinI),
  );
}

function resolveArgumentOfPeriapsis(
  nodeVec: Vec3,
  eVec: Vec3,
  isEquatorial: boolean,
  isCircular: boolean,
): number {
  if (isCircular) return 0;
  if (isEquatorial) return normalizeAngle(Math.atan2(eVec.y, eVec.x));

  const angle = Math.acos(
    clamp(nodeVec.dot(eVec) / (nodeVec.length * eVec.length), -1, 1),
  );
  return normalizeAngle(eVec.z < 0 ? 2 * Math.PI - angle : angle);
}

function resolveTrueAnomaly(
  position: Vec3,
  velocity: Vec3,
  eVec: Vec3,
  nodeVec: Vec3,
  isEquatorial: boolean,
  isCircular: boolean,
): number {
  // For circular orbits periapsis is undefined, so measure from the ascending
  // node (or from +x for a circular equatorial orbit) instead.
  if (isCircular) {
    const reference = isEquatorial ? new Vec3(1, 0, 0) : nodeVec;
    const angle = Math.acos(
      clamp(reference.dot(position) / (reference.length * position.length), -1, 1),
    );
    const isDescending = isEquatorial ? position.y < 0 : position.z < 0;
    return normalizeAngle(isDescending ? 2 * Math.PI - angle : angle);
  }

  const angle = Math.acos(
    clamp(eVec.dot(position) / (eVec.length * position.length), -1, 1),
  );
  // Moving away from periapsis means true anomaly is in the first half-turn.
  return normalizeAngle(position.dot(velocity) < 0 ? 2 * Math.PI - angle : angle);
}

/** Wrap an angle into [0, 2*PI). */
export function normalizeAngle(radians: number): number {
  const wrapped = radians % (2 * Math.PI);
  return wrapped < 0 ? wrapped + 2 * Math.PI : wrapped;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
