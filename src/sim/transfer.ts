/**
 * Hohmann transfer planning: getting from a parking orbit to a moon.
 *
 * A transfer is a burn plus a wait. The burn itself is easy — raise apoapsis
 * to the moon's orbital radius — but it only produces an encounter if it
 * happens at the right moment, when the moon is far enough ahead that it
 * arrives at the meeting point exactly as the vessel does. That lead angle is
 * the whole problem, and it is what this module computes.
 */
import { bodyStateAt, orbitalPeriod } from '../bodies/ephemeris.js';
import type { Body } from '../bodies/types.js';
import { normalizeAngle } from './orbit.js';
import type { Vec3 } from './vec3.js';

export interface TransferPlan {
  /** Radius of the vessel's current orbit (m). */
  readonly departureRadius: number;
  /** Radius of the target's orbit (m). */
  readonly arrivalRadius: number;
  /** Time spent on the transfer ellipse (s). */
  readonly flightTime: number;
  /** How far ahead the target must be at ignition (rad). */
  readonly requiredPhaseAngle: number;
  /** How far ahead the target actually is right now (rad). */
  readonly currentPhaseAngle: number;
  /** Signed error between the two (rad); zero means burn now. */
  readonly phaseError: number;
  /** Seconds until the window opens. */
  readonly timeToWindow: number;
  /** Delta-v the departure burn needs (m/s). */
  readonly deltaV: number;
}

/**
 * Plan a transfer from the vessel's current orbit to `target`.
 *
 * Depends only on where the vessel is, not how fast it is going: a Hohmann
 * window is a geometric relationship between the two orbits.
 *
 * @param parentMu Gravitational parameter of the body both are orbiting.
 */
export function planTransfer(
  position: Vec3,
  target: Body,
  parentMu: number,
  time: number,
): TransferPlan {
  const targetState = bodyStateAt(target, time);

  const departureRadius = position.length;
  const arrivalRadius = targetState.position.length;

  // The transfer ellipse touches both orbits, so its semi-major axis is the
  // mean of the two radii and the trip is exactly half its period.
  const transferAxis = (departureRadius + arrivalRadius) / 2;
  const flightTime =
    Math.PI * Math.sqrt((transferAxis * transferAxis * transferAxis) / parentMu);

  // In that time the target sweeps through this much of its own orbit, so it
  // must start that much short of the far side.
  const targetAngularRate = (2 * Math.PI) / orbitalPeriod(target);
  const requiredPhaseAngle = normalizeAngle(Math.PI - targetAngularRate * flightTime);

  const currentPhaseAngle = phaseAngle(position, targetState.position);
  const phaseError = signedAngleDifference(currentPhaseAngle, requiredPhaseAngle);

  return {
    departureRadius,
    arrivalRadius,
    flightTime,
    requiredPhaseAngle,
    currentPhaseAngle,
    phaseError,
    timeToWindow: timeUntilWindow(
      phaseError,
      angularRate(departureRadius, parentMu),
      targetAngularRate,
    ),
    deltaV: departureDeltaV(departureRadius, transferAxis, parentMu),
  };
}

/**
 * Angle from the vessel to the target, measured about the orbital axis in the
 * direction of travel. Both orbits are treated as coplanar, which holds for
 * the equatorial system the game ships with.
 */
export function phaseAngle(vessel: Vec3, target: Vec3): number {
  const vesselAngle = Math.atan2(vessel.y, vessel.x);
  const targetAngle = Math.atan2(target.y, target.x);
  return normalizeAngle(targetAngle - vesselAngle);
}

/** Mean angular rate of a circular orbit at `radius` (rad/s). */
export function angularRate(radius: number, mu: number): number {
  return Math.sqrt(mu / (radius * radius * radius));
}

/**
 * Delta-v to leave a circular orbit onto the transfer ellipse (m/s), from
 * vis-viva at the departure radius.
 */
export function departureDeltaV(
  departureRadius: number,
  transferAxis: number,
  mu: number,
): number {
  const circular = Math.sqrt(mu / departureRadius);
  const transfer = Math.sqrt(mu * (2 / departureRadius - 1 / transferAxis));
  return transfer - circular;
}

/**
 * Seconds until the phase error closes to zero.
 *
 * The vessel in the lower orbit laps the target, so the phase angle shrinks at
 * the difference of their angular rates.
 */
function timeUntilWindow(
  phaseError: number,
  vesselRate: number,
  targetRate: number,
): number {
  const closingRate = vesselRate - targetRate;
  if (closingRate <= 0) return Infinity;

  // Phase decreases as the vessel catches up, so a positive error is the
  // amount still to close before the window comes round.
  return normalizeAngle(phaseError) / closingRate;
}

/** Difference between two angles, wrapped to (-PI, PI]. */
export function signedAngleDifference(from: number, to: number): number {
  const difference = normalizeAngle(from - to);
  return difference > Math.PI ? difference - 2 * Math.PI : difference;
}
