/**
 * Ascent autopilot: launch, gravity turn, coast, circularise.
 *
 * The gravity turn follows a scripted pitch program rather than true prograde
 * following. A scripted profile is deterministic and therefore testable, which
 * matters more at this stage than optimality.
 */
import { pressureRatio } from './atmosphere.js';
import { altitudeOf, surfaceRelativeVelocity, verticalSpeed } from './forces.js';
import type { FlightState } from './flightState.js';
import { directionFromPitch, horizontalPrograde } from './flightState.js';
import { elementsFromState } from './orbit.js';
import { planTransfer } from './transfer.js';
import type { Body } from '../bodies/types.js';
import { hasPropellant, thrustToWeight } from './vessel.js';
import type { Vec3 } from './vec3.js';

/** Altitude at which the vehicle begins pitching over (m). */
const TURN_START_ALTITUDE = 1_500;
/**
 * Altitude by which the initial pitch kick is complete (m). After this the
 * vehicle simply follows its own velocity vector.
 */
const KICK_END_ALTITUDE = 9_000;
/** How far off vertical the initial kick aims (rad). */
const KICK_ANGLE = 0.28; // ~16 degrees
/**
 * Thrust-to-weight ceiling held during ascent. Real launchers throttle down to
 * limit dynamic pressure and g-loading, and doing the same here is what makes
 * the autopilot work for craft the player designed rather than only for one
 * reference vehicle: a high-thrust build is simply throttled back.
 */
const MAX_ASCENT_TWR = 2.0;
/** Never throttle below this, or a heavy craft would never leave the pad. */
const MIN_ASCENT_THROTTLE = 0.35;
/** Orbit is declared reached once periapsis is this close to the target. */
const PERIAPSIS_TOLERANCE = 0.995;
/** Gain converting an altitude shortfall into a target climb rate (1/s). */
const CLIMB_RATE_GAIN = 0.08;
/** Bounds on the commanded climb rate during the orbit-insertion burn (m/s). */
const MAX_CLIMB_RATE = 140;
const MIN_CLIMB_RATE = -25;
/** Gain converting a climb-rate error into a pitch correction (rad per m/s). */
const PITCH_GAIN = 0.03;
/** Pitch authority during insertion (rad): may aim down as well as up. */
const MAX_INSERTION_PITCH = 0.7;
const MIN_INSERTION_PITCH = -0.35;

export type AscentPhase =
  | 'prelaunch'
  | 'liftoff'
  | 'gravityTurn'
  | 'insertion'
  | 'complete'
  | 'transferWait'
  | 'transferBurn'
  | 'cruise'
  | 'arrived'
  | 'descent'
  | 'touchdown'
  | 'manual';

export interface GuidanceCommand {
  readonly phase: AscentPhase;
  readonly targetDirection: Vec3;
  readonly throttle: number;
  /** True when the active stage is spent and should be jettisoned. */
  readonly shouldStage: boolean;
  /**
   * Upper bound on the next timestep (s), when the autopilot is waiting for a
   * moment it must not overshoot. Without this a high warp factor would sail
   * straight past a transfer window between one frame and the next.
   */
  readonly maxTimestep?: number;
}

export interface AscentTarget {
  /** Desired final orbital radius from the body centre (m). */
  readonly orbitRadius: number;
}

/** Burn when the phase error is within this of the ideal window (rad). */
const TRANSFER_WINDOW_TOLERANCE = 0.004;
/**
 * Apoapsis-to-periapsis ratio above which a departure burn is judged to be
 * already under way. A parking orbit sits near 1.01; anything meaningfully
 * above that has been stretched by a burn in progress.
 */
const BURN_UNDERWAY_RATIO = 1.1;
/**
 * Descent profile: how fast to fall per metre of altitude (1/s). Falling
 * proportionally to height is a simple, always-stable approach — the closer
 * the ground, the slower the vehicle is asked to be.
 */
const DESCENT_RATE_PER_METRE = 0.08;
/** Bounds on the commanded descent speed (m/s). */
const MAX_DESCENT_SPEED = 350;
const TOUCHDOWN_SPEED = 3;
/** Throttle gain on the speed error (per m/s). */
const DESCENT_THROTTLE_GAIN = 0.12;
/** Altitude below which the vehicle is considered to have landed (m). */
const TOUCHDOWN_ALTITUDE = 20;
/** Stop the departure burn once apoapsis reaches this fraction of the target. */
const TRANSFER_APOAPSIS_TOLERANCE = 0.998;
/** Leave this much of the approach unwarped so the window is not skipped. */
const WINDOW_APPROACH_FRACTION = 0.5;

/**
 * Decide what the autopilot wants this tick. Pure: depends only on the
 * current state, so the same state always yields the same command.
 */
export function computeGuidance(
  state: FlightState,
  target: AscentTarget,
  autopilotEnabled: boolean,
  transferTo: Body | null = null,
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
    if (transferTo) return transferCommand(state, transferTo, shouldStage);

    return {
      phase: 'complete',
      targetDirection: horizontalPrograde(state.position, state.velocity),
      throttle: 0,
      shouldStage: false,
    };
  }

  // Already under way to the target: nothing more to steer until arrival.
  if (transferTo && isOnTransfer(state, transferTo, elements)) {
    return transferCommand(state, transferTo, shouldStage);
  }

  // Climb until apoapsis reaches the target altitude.
  if (elements.apoapsis < target.orbitRadius) {
    return ascentCommand(state, altitude, shouldStage);
  }

  // Apoapsis is high enough: now build orbital velocity.
  return insertionCommand(state, altitude, target, shouldStage);
}

/**
 * True once the vessel is either inside the target's SOI or on an orbit that
 * already reaches it — in both cases the ascent controller must keep its hands
 * off, or it would try to "fix" the transfer ellipse back into a parking orbit.
 */
function isOnTransfer(
  state: FlightState,
  target: Body,
  elements: ReturnType<typeof elementsFromState>,
): boolean {
  if (state.body.id === target.id) return true;
  if (!target.orbit) return false;

  return elements.apoapsis >= target.orbit.semiMajorAxis * TRANSFER_APOAPSIS_TOLERANCE;
}

/**
 * Transfer to a moon: wait for the window, burn prograde to raise apoapsis to
 * the moon's orbit, then coast until its gravity takes over.
 */
function transferCommand(
  state: FlightState,
  target: Body,
  shouldStage: boolean,
): GuidanceCommand {
  const prograde = horizontalPrograde(state.position, state.velocity);

  // Arrived: the moon owns the vessel now, so fly it down.
  if (state.body.id === target.id) {
    return descentCommand(state, shouldStage);
  }

  const elements = elementsFromState(state.position, state.velocity, state.body.mu);
  const plan = planTransfer(state.position, target, state.body.mu, state.time);

  // Apoapsis already reaches the moon's orbit — stop burning and coast out.
  if (elements.apoapsis >= plan.arrivalRadius * TRANSFER_APOAPSIS_TOLERANCE) {
    return { phase: 'cruise', targetDirection: prograde, throttle: 0, shouldStage };
  }

  // Once committed, keep burning to completion.
  //
  // Guidance is stateless — it re-derives everything each tick — so without
  // this the vessel would leave the window a moment after entering it, stop
  // mid-burn, and wait a whole orbit for the next one. That actually happened:
  // the transfer completed in a dozen ragged bursts over six days instead of
  // one burn, wasting most of the propellant. The stretch of the orbit itself
  // is the evidence that a burn is in progress.
  const isBurnUnderway = elements.apoapsis > elements.periapsis * BURN_UNDERWAY_RATIO;

  if (isBurnUnderway || Math.abs(plan.phaseError) <= TRANSFER_WINDOW_TOLERANCE) {
    return {
      phase: 'transferBurn',
      targetDirection: prograde,
      throttle: 1,
      shouldStage,
    };
  }

  // Hold, and stop time-warp from leaping over the window.
  return {
    phase: 'transferWait',
    targetDirection: prograde,
    throttle: 0,
    shouldStage,
    maxTimestep: Math.max(
      PHYSICS_STEP_FLOOR,
      plan.timeToWindow * WINDOW_APPROACH_FRACTION,
    ),
  };
}

/** Smallest cap the guidance will ever ask for (s). */
const PHYSICS_STEP_FLOOR = 0.02;

/**
 * Powered descent onto an airless body.
 *
 * With no atmosphere there is nothing to slow the vehicle but its own engine,
 * so the controller points retrograde to the *surface* velocity — which bleeds
 * off horizontal and vertical speed together — and throttles to track a target
 * speed that tapers with altitude.
 */
function descentCommand(state: FlightState, shouldStage: boolean): GuidanceCommand {
  const altitude = altitudeOf(state.body, state.position);
  const surfaceVelocity = surfaceRelativeVelocity(
    state.body,
    state.position,
    state.velocity,
  );
  const speed = surfaceVelocity.length;
  const up = state.position.normalized();

  if (altitude <= TOUCHDOWN_ALTITUDE && speed <= TOUCHDOWN_SPEED) {
    return { phase: 'touchdown', targetDirection: up, throttle: 0, shouldStage: false };
  }

  const targetSpeed = Math.min(
    MAX_DESCENT_SPEED,
    Math.max(TOUCHDOWN_SPEED, altitude * DESCENT_RATE_PER_METRE),
  );

  const throttle = clamp((speed - targetSpeed) * DESCENT_THROTTLE_GAIN, 0, 1);

  // Retrograde until nearly stopped, then hold upright for touchdown.
  const direction = speed > TOUCHDOWN_SPEED ? surfaceVelocity.normalized().negate() : up;

  return { phase: 'descent', targetDirection: direction, throttle, shouldStage };
}

function ascentCommand(
  state: FlightState,
  altitude: number,
  shouldStage: boolean,
): GuidanceCommand {
  const phase: AscentPhase = altitude < TURN_START_ALTITUDE ? 'liftoff' : 'gravityTurn';

  return {
    phase,
    targetDirection: ascentDirection(state, altitude),
    throttle: ascentThrottle(state, altitude),
    shouldStage,
  };
}

/**
 * A true gravity turn: hold vertical, kick a few degrees downrange, then let
 * the vehicle follow its own velocity vector while gravity bends the
 * trajectory over.
 *
 * Following prograde rather than a scripted altitude-to-pitch table is what
 * makes this work for arbitrary craft — the velocity vector already encodes
 * the vehicle's actual acceleration history.
 */
function ascentDirection(state: FlightState, altitude: number): Vec3 {
  if (altitude <= TURN_START_ALTITUDE) {
    return directionFromPitch(state.position, Math.PI / 2);
  }

  if (altitude < KICK_END_ALTITUDE) {
    return directionFromPitch(state.position, Math.PI / 2 - KICK_ANGLE);
  }

  const airVelocity = surfaceRelativeVelocity(
    state.body,
    state.position,
    state.velocity,
  );

  // Before the vehicle is really moving, prograde is meaningless.
  if (airVelocity.length < 1) {
    return directionFromPitch(state.position, Math.PI / 2 - KICK_ANGLE);
  }

  return airVelocity.normalized();
}

/**
 * Throttle back to hold the thrust-to-weight ceiling. Without this, a craft
 * with a lot of thrust climbs so fast that gravity never gets the chance to
 * turn it, and it arrives at a wildly overshot apoapsis going straight up.
 */
function ascentThrottle(state: FlightState, altitude: number): number {
  const radius = state.position.length;
  const gravity = state.body.mu / (radius * radius);
  const ambient = pressureRatio(state.body, altitude);

  const fullThrottleTwr = thrustToWeight(state.vessel, gravity, ambient, 1);
  if (fullThrottleTwr <= MAX_ASCENT_TWR) return 1;

  return Math.max(MIN_ASCENT_THROTTLE, MAX_ASCENT_TWR / fullThrottleTwr);
}

/**
 * Orbit insertion: keep burning, steering to hold altitude while converting
 * thrust into horizontal speed, until periapsis reaches the target.
 *
 * This replaces the older coast-to-apoapsis-then-circularise profile. Coasting
 * is only cheap once the vehicle already carries most of its orbital velocity;
 * a steep ascent arrives at apoapsis slow, having paid the whole climb back to
 * gravity. Burning continuously is slightly less efficient in the best case and
 * far more robust across the range of craft a player can actually build.
 */
function insertionCommand(
  state: FlightState,
  altitude: number,
  target: AscentTarget,
  shouldStage: boolean,
): GuidanceCommand {
  const targetAltitude = target.orbitRadius - state.body.radius;

  // Climb toward the target altitude, easing to level flight on arrival.
  const desiredClimbRate = clamp(
    (targetAltitude - altitude) * CLIMB_RATE_GAIN,
    MIN_CLIMB_RATE,
    MAX_CLIMB_RATE,
  );

  const climbRate = verticalSpeed(state.position, state.velocity);
  const pitch = clamp(
    (desiredClimbRate - climbRate) * PITCH_GAIN,
    MIN_INSERTION_PITCH,
    MAX_INSERTION_PITCH,
  );

  const prograde = horizontalPrograde(state.position, state.velocity);
  const up = state.position.normalized();
  const direction = prograde
    .scale(Math.cos(pitch))
    .add(up.scale(Math.sin(pitch)))
    .normalized();

  return {
    phase: 'insertion',
    targetDirection: direction,
    throttle: ascentThrottle(state, altitude),
    shouldStage,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
