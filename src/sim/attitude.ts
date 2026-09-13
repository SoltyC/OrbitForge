/**
 * Attitude control: a PD controller that steers the vessel's nose onto a
 * commanded direction using reaction-wheel and engine-gimbal torque.
 *
 * Control authority is deliberately finite — the vessel cannot snap instantly
 * to a new heading, so a badly shaped ascent profile actually costs you.
 */
import { Quat } from './quat.js';
import { Vec3 } from './vec3.js';
import {
  maxGimbalRange,
  momentOfInertia,
  torqueAuthority,
  totalThrust,
} from './vessel.js';
import type { Vessel } from './vessel.js';

/** Proportional gain on pointing error (1/s^2). */
const GAIN_PROPORTIONAL = 0.9;
/** Derivative gain on angular rate (1/s). Tuned for near-critical damping. */
const GAIN_DERIVATIVE = 2.2;
/** Aerodynamic rotational damping coefficient (per unit dynamic pressure). */
const AERO_DAMPING = 4e-4;

export interface AttitudeState {
  readonly orientation: Quat;
  readonly angularVelocity: Vec3;
}

/**
 * Advance attitude one step toward `targetDirection`.
 *
 * @param currentAxis Unit vector the nose currently points along.
 * @param dynamicPressure Ambient Q (Pa), used for aerodynamic damping.
 */
export function stepAttitude(
  state: AttitudeState,
  currentAxis: Vec3,
  targetDirection: Vec3,
  vessel: Vessel,
  throttle: number,
  pressureRatio: number,
  dynamicPressure: number,
  dt: number,
): AttitudeState {
  const inertia = momentOfInertia(vessel);
  if (inertia <= 0 || dt <= 0) return state;

  const errorVector = pointingError(currentAxis, targetDirection);

  // PD law expressed as a desired angular acceleration.
  const desiredAcceleration = errorVector
    .scale(GAIN_PROPORTIONAL)
    .sub(state.angularVelocity.scale(GAIN_DERIVATIVE));

  const maxTorque = availableTorque(vessel, throttle, pressureRatio);
  const commandedTorque = clampMagnitude(desiredAcceleration.scale(inertia), maxTorque);

  // Passive aerodynamic damping always opposes rotation.
  const dampingTorque = state.angularVelocity.scale(-AERO_DAMPING * dynamicPressure * inertia);

  const angularAcceleration = commandedTorque.add(dampingTorque).scale(1 / inertia);
  const angularVelocity = state.angularVelocity.add(angularAcceleration.scale(dt));

  return {
    orientation: state.orientation.integrate(angularVelocity, dt),
    angularVelocity,
  };
}

/**
 * Pointing error as a rotation vector: direction is the rotation axis,
 * magnitude is the angle in radians.
 */
export function pointingError(currentAxis: Vec3, targetDirection: Vec3): Vec3 {
  const current = currentAxis.normalized();
  const target = targetDirection.normalized();

  const axis = current.cross(target);
  const cos = Math.min(1, Math.max(-1, current.dot(target)));
  const angle = Math.acos(cos);

  // Exactly antiparallel: any perpendicular axis is a valid way round.
  if (axis.lengthSq < 1e-18) {
    if (angle < 1e-9) return Vec3.ZERO;
    const fallback = Math.abs(current.x) > 0.9 ? new Vec3(0, 1, 0) : new Vec3(1, 0, 0);
    return current.cross(fallback).normalized().scale(angle);
  }

  return axis.normalized().scale(angle);
}

/**
 * Total torque the vessel can command: reaction wheels always, plus engine
 * gimbal while thrusting (gimbal authority scales with thrust and lever arm).
 */
export function availableTorque(
  vessel: Vessel,
  throttle: number,
  pressureRatio: number,
): number {
  const wheelTorque = torqueAuthority(vessel);
  if (throttle <= 0) return wheelTorque;

  const thrust = totalThrust(vessel, pressureRatio, throttle);
  if (thrust <= 0) return wheelTorque;

  // Lever arm from the engines to the centre of mass, approximated as a
  // quarter of the stack length.
  const leverArm = Math.max(1, vesselLengthApprox(vessel) / 4);
  const gimbalTorque = thrust * Math.sin(maxGimbalRange(vessel)) * leverArm;

  return wheelTorque + gimbalTorque;
}

function vesselLengthApprox(vessel: Vessel): number {
  return vessel.stages.reduce(
    (sum, stage) => sum + stage.parts.reduce((s, part) => s + part.length, 0),
    0,
  );
}

function clampMagnitude(vector: Vec3, maxMagnitude: number): Vec3 {
  const magnitude = vector.length;
  if (magnitude <= maxMagnitude || magnitude === 0) return vector;
  return vector.scale(maxMagnitude / magnitude);
}
