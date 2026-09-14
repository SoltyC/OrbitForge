/**
 * Player control.
 *
 * The autopilot flies the vehicle perfectly and gives the player nothing to
 * do, so it becomes one option among several rather than the only one. A
 * control mode decides where the vessel points and how hard it burns; the
 * simulation does not care which produced the answer.
 *
 * Attitude is commanded as a direction rather than as torques. A player
 * holding a key wants the nose to go somewhere, and the vehicle's actual
 * ability to get there — its reaction wheels, its gimbal, its moment of
 * inertia — is already modelled by the attitude controller. Commanding torque
 * directly would double-count that.
 */
import type { FlightState } from './flightState.js';
import { eastDirection, thrustAxis } from './flightState.js';
import { surfaceRelativeVelocity } from './forces.js';
import { Vec3 } from './vec3.js';

/**
 * What the vessel is holding its nose against.
 *
 * The named modes are the ones that matter for flying an orbit: burning along
 * the velocity vector raises or lowers the opposite side of it, and burning
 * across it changes the plane.
 */
export type HoldMode =
  | 'free'
  | 'prograde'
  | 'retrograde'
  | 'radialOut'
  | 'radialIn'
  | 'normal'
  | 'antiNormal'
  | 'maneuver';

export interface ControlInput {
  /** Commanded throttle in [0, 1]. */
  readonly throttle: number;
  /** Pitch, yaw and roll demand, each in [-1, 1]. */
  readonly pitch: number;
  readonly yaw: number;
  readonly roll: number;
  readonly hold: HoldMode;
  /** Set for one step when the player asks to stage. */
  readonly stageRequested: boolean;
}

export const NEUTRAL_CONTROL: ControlInput = {
  throttle: 0,
  pitch: 0,
  yaw: 0,
  roll: 0,
  hold: 'free',
  stageRequested: false,
};

/** How fast free-flight input swings the commanded direction (rad/s). */
const MANUAL_RATE = 1.1;

/**
 * The six orbital reference directions at a point in a flight.
 *
 * Prograde is along the orbital velocity, normal is perpendicular to the
 * orbital plane, and radial completes the set. These are the axes every
 * manoeuvre is expressed in.
 */
export interface ReferenceFrame {
  readonly prograde: Vec3;
  readonly retrograde: Vec3;
  readonly normal: Vec3;
  readonly antiNormal: Vec3;
  readonly radialOut: Vec3;
  readonly radialIn: Vec3;
}

export function referenceFrame(position: Vec3, velocity: Vec3): ReferenceFrame {
  const prograde = velocity.lengthSq > 0 ? velocity.normalized() : eastDirection(position);
  const radialOut = position.normalized();

  // Normal is the orbit's own axis: position cross velocity.
  const angularMomentum = position.cross(velocity);
  const normal =
    angularMomentum.lengthSq > 0
      ? angularMomentum.normalized()
      : radialOut.cross(prograde).normalized();

  return {
    prograde,
    retrograde: prograde.negate(),
    normal,
    antiNormal: normal.negate(),
    radialOut,
    radialIn: radialOut.negate(),
  };
}

/**
 * Where the nose should point, given a hold mode and the current state.
 *
 * Returns null for free flight, where the direction comes from the player's
 * own input instead.
 */
export function holdDirection(
  state: FlightState,
  hold: HoldMode,
  maneuverBurn: Vec3 | null,
): Vec3 | null {
  if (hold === 'free') return null;

  if (hold === 'maneuver') {
    return maneuverBurn && maneuverBurn.lengthSq > 0 ? maneuverBurn.normalized() : null;
  }

  // Which velocity "prograde" means depends on where the vessel is.
  //
  // Orbital prograde on the launchpad points along the planet's rotation —
  // 174 m/s due east at Terrin's equator — so a rocket told to hold it lies
  // straight over and flies into the ground. Down here the velocity that
  // matters is the one relative to the air, which is what a pilot means by
  // prograde and what every flight instrument reads. High up, where the
  // rotation is a rounding error against orbital speed, the orbital frame is
  // the useful one. The changeover is smooth because by then the two have
  // converged anyway.
  const airVelocity = surfaceRelativeVelocity(state.body, state.position, state.velocity);
  const altitude = state.position.length - state.body.radius;
  const inAtmosphere = state.body.atmosphere !== null && altitude < state.body.atmosphere.height;

  const velocity = inAtmosphere ? airVelocity : state.velocity;

  // Below flying speed there is no meaningful direction of travel at all, so
  // hold the vehicle upright rather than chasing noise.
  if (velocity.length < 20) return state.position.normalized();

  const frame = referenceFrame(state.position, velocity);

  switch (hold) {
    case 'prograde':
      return frame.prograde;
    case 'retrograde':
      return frame.retrograde;
    case 'radialOut':
      return frame.radialOut;
    case 'radialIn':
      return frame.radialIn;
    case 'normal':
      return frame.normal;
    case 'antiNormal':
      return frame.antiNormal;
    default:
      return null;
  }
}

/**
 * Swing a commanded direction by the player's pitch and yaw demand.
 *
 * Rotating the existing command rather than deriving a new one from scratch is
 * what makes the controls feel continuous: letting go leaves the nose where it
 * was pointed rather than snapping it back to some reference.
 */
export function steer(
  current: Vec3,
  up: Vec3,
  input: ControlInput,
  dt: number,
): Vec3 {
  if (input.pitch === 0 && input.yaw === 0) return current;

  const forward = current.normalized();

  // A body-relative frame to pitch and yaw within.
  let right = forward.cross(up);
  if (right.lengthSq < 1e-12) {
    // Pointing straight up or down: any perpendicular will do.
    right = forward.cross(new Vec3(1, 0, 0));
    if (right.lengthSq < 1e-12) right = forward.cross(new Vec3(0, 1, 0));
  }
  right = right.normalized();

  const above = right.cross(forward).normalized();

  const swung = forward
    .add(above.scale(input.pitch * MANUAL_RATE * dt))
    .add(right.scale(input.yaw * MANUAL_RATE * dt));

  return swung.lengthSq > 0 ? swung.normalized() : forward;
}

/**
 * Whether a hold mode can be engaged at all.
 *
 * Holding prograde before there is a velocity worth speaking of would point
 * the vehicle along the ground.
 */
export function canHold(state: FlightState, hold: HoldMode): boolean {
  if (hold === 'free') return true;
  if (hold === 'maneuver') return true;
  return state.velocity.lengthSq > 0;
}

/** A short label for the HUD. */
export function holdLabel(hold: HoldMode): string {
  const names: Record<HoldMode, string> = {
    free: 'Free',
    prograde: 'Prograde',
    retrograde: 'Retrograde',
    radialOut: 'Radial out',
    radialIn: 'Radial in',
    normal: 'Normal',
    antiNormal: 'Anti-normal',
    maneuver: 'Manoeuvre',
  };
  return names[hold];
}

/** The commanded direction a manual control step produces. */
export function manualDirection(
  state: FlightState,
  input: ControlInput,
  commanded: Vec3,
  maneuverBurn: Vec3 | null,
  dt: number,
): Vec3 {
  const held = holdDirection(state, input.hold, maneuverBurn);
  if (held) return held;

  // Free flight: swing whatever was last commanded, starting from where the
  // vehicle is actually pointing so engaging free mode does not jump it.
  const base = commanded.lengthSq > 0 ? commanded : thrustAxis(state);
  return steer(base, state.position.normalized(), input, dt);
}
