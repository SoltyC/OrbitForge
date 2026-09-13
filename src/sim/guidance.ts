/**
 * Ascent autopilot: launch, gravity turn, coast, circularise.
 *
 * The gravity turn follows a scripted pitch program rather than true prograde
 * following. A scripted profile is deterministic and therefore testable, which
 * matters more at this stage than optimality.
 */
import { altitudeOf, verticalSpeed } from './forces.js';
import type { FlightState } from './flightState.js';
import { directionFromPitch, horizontalPrograde } from './flightState.js';
import { elementsFromState, timeToApoapsis } from './orbit.js';
import { thrustAt } from '../parts/types.js';
import { activeEngine, hasPropellant, vesselMass } from './vessel.js';
import type { Vec3 } from './vec3.js';

/** Altitude at which the vehicle begins pitching over (m). */
const TURN_START_ALTITUDE = 1_500;
/** Altitude by which the pitch program reaches the horizon (m). */
const TURN_END_ALTITUDE = 60_000;
/**
 * Shapes the pitch curve. Higher keeps the vehicle steeper for longer; too low
 * and it goes horizontal deep in the atmosphere, trading the whole ascent for
 * drag losses and arriving at apoapsis with no time to circularise.
 */
const TURN_EXPONENT = 0.8;
/** Stop circularising once periapsis is this close to the target radius. */
const PERIAPSIS_TOLERANCE = 0.995;
/**
 * While falling short of orbit, how much upward pitch to mix into the burn per
 * m/s of descent rate. Arrests the fall without wasting the burn on altitude.
 */
const DESCENT_RECOVERY_GAIN = 0.004;
/** Cap on that recovery pitch (rad) so the burn stays mostly horizontal. */
const MAX_RECOVERY_PITCH = 0.6;

export type AscentPhase =
  | 'prelaunch'
  | 'liftoff'
  | 'gravityTurn'
  | 'coastToApoapsis'
  | 'circularise'
  | 'complete';

export interface GuidanceCommand {
  readonly phase: AscentPhase;
  readonly targetDirection: Vec3;
  readonly throttle: number;
  /** True when the active stage is spent and should be jettisoned. */
  readonly shouldStage: boolean;
}

export interface AscentTarget {
  /** Desired final orbital radius from the body centre (m). */
  readonly orbitRadius: number;
}

/**
 * Decide what the autopilot wants this tick. Pure: depends only on the
 * current state, so the same state always yields the same command.
 */
export function computeGuidance(
  state: FlightState,
  target: AscentTarget,
  autopilotEnabled: boolean,
): GuidanceCommand {
  const altitude = altitudeOf(state.body, state.position);
  const elements = elementsFromState(state.position, state.velocity, state.body.mu);
  const shouldStage = !hasPropellant(state.vessel) && state.vessel.stages.length > 1;

  if (!autopilotEnabled) {
    return {
      phase: 'complete',
      targetDirection: horizontalPrograde(state.position, state.velocity),
      throttle: state.throttle,
      shouldStage,
    };
  }

  // Orbit achieved: periapsis is clear of the atmosphere and near target.
  const periapsisTarget = target.orbitRadius * PERIAPSIS_TOLERANCE;
  if (elements.isClosed && elements.periapsis >= periapsisTarget) {
    return {
      phase: 'complete',
      targetDirection: horizontalPrograde(state.position, state.velocity),
      throttle: 0,
      shouldStage: false,
    };
  }

  // Climb until apoapsis reaches the target altitude.
  if (elements.apoapsis < target.orbitRadius) {
    return ascentCommand(state, altitude, shouldStage);
  }

  // Apoapsis is high enough — coast up, then burn at the top to raise periapsis.
  return circulariseCommand(state, elements, target, shouldStage);
}

function ascentCommand(
  state: FlightState,
  altitude: number,
  shouldStage: boolean,
): GuidanceCommand {
  const pitch = pitchProgram(altitude);
  const phase: AscentPhase = altitude < TURN_START_ALTITUDE ? 'liftoff' : 'gravityTurn';

  return {
    phase,
    targetDirection: directionFromPitch(state.position, pitch),
    throttle: 1,
    shouldStage,
  };
}

function circulariseCommand(
  state: FlightState,
  elements: ReturnType<typeof elementsFromState>,
  target: AscentTarget,
  shouldStage: boolean,
): GuidanceCommand {
  const prograde = horizontalPrograde(state.position, state.velocity);
  const secondsToApoapsis = timeToApoapsis(elements, state.body.mu);
  const burnDuration = estimateCirculariseBurn(state, elements, target);
  const climbRate = verticalSpeed(state.position, state.velocity);

  // Start the burn half its duration before apoapsis so it straddles the apex
  // — that is what keeps the resulting orbit close to circular.
  const isNearApoapsis = secondsToApoapsis <= burnDuration / 2;

  // If we are already falling with periapsis still below the target, apoapsis
  // is behind us and waiting for the next one means reentry. Burn now.
  const isFallingShort = climbRate < 0;

  if (!isNearApoapsis && !isFallingShort) {
    return {
      phase: 'coastToApoapsis',
      targetDirection: prograde,
      throttle: 0,
      shouldStage,
    };
  }

  return {
    phase: 'circularise',
    targetDirection: recoveryDirection(state.position, prograde, climbRate),
    throttle: 1,
    shouldStage,
  };
}

/**
 * Horizontal prograde, with a little upward pitch mixed in when descending so
 * the burn arrests the fall as well as building orbital velocity.
 */
function recoveryDirection(position: Vec3, prograde: Vec3, climbRate: number): Vec3 {
  if (climbRate >= 0) return prograde;

  const pitch = Math.min(MAX_RECOVERY_PITCH, -climbRate * DESCENT_RECOVERY_GAIN);
  const up = position.normalized();
  return prograde.scale(Math.cos(pitch)).add(up.scale(Math.sin(pitch))).normalized();
}

/**
 * Scripted pitch profile, in radians above the horizon. Vertical below the
 * turn start, then easing to horizontal by the turn end altitude.
 */
export function pitchProgram(altitude: number): number {
  if (altitude <= TURN_START_ALTITUDE) return Math.PI / 2;
  if (altitude >= TURN_END_ALTITUDE) return 0;

  const span = TURN_END_ALTITUDE - TURN_START_ALTITUDE;
  const progress = (altitude - TURN_START_ALTITUDE) / span;
  return (Math.PI / 2) * (1 - Math.pow(progress, TURN_EXPONENT));
}

/**
 * Rough burn time to circularise: the delta-v needed at apoapsis divided by
 * current thrust acceleration. Only needs to be good enough to time ignition.
 */
function estimateCirculariseBurn(
  state: FlightState,
  elements: ReturnType<typeof elementsFromState>,
  target: AscentTarget,
): number {
  const engine = activeEngine(state.vessel);
  if (!engine || !elements.isClosed) return 0;

  const mu = state.body.mu;
  const rApo = Math.min(elements.apoapsis, target.orbitRadius);

  // Vis-viva: speed on the current ellipse at apoapsis vs. circular speed there.
  const speedAtApoapsis = Math.sqrt(mu * (2 / rApo - 1 / elements.semiMajorAxis));
  const circularSpeed = Math.sqrt(mu / rApo);
  const deltaV = Math.max(0, circularSpeed - speedAtApoapsis);

  const acceleration = thrustAt(engine, 0) / vesselMass(state.vessel);
  return acceleration > 0 ? deltaV / acceleration : 0;
}
