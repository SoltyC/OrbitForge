/**
 * Numerical integrators for translational state.
 *
 * RK4 is the default for powered and atmospheric flight: fourth-order accuracy
 * keeps ascent trajectories faithful under rapidly changing thrust and drag.
 * Semi-implicit (symplectic) Euler is kept alongside it because it conserves
 * orbital energy over long spans, which makes it a useful reference when
 * validating that RK4 is not silently draining or pumping energy.
 *
 * Plain explicit Euler is deliberately absent — it drifts orbits into garbage.
 */
import { Vec3 } from './vec3.js';

export interface TranslationalState {
  readonly position: Vec3;
  readonly velocity: Vec3;
}

/**
 * Acceleration as a function of state and time offset within the step.
 * The time offset lets force models vary over the step (e.g. drag changing
 * with altitude); mass changes are handled outside the integrator.
 */
export type AccelerationFn = (state: TranslationalState, timeOffset: number) => Vec3;

/** Classic fourth-order Runge-Kutta step. */
export function integrateRK4(
  state: TranslationalState,
  accelerationOf: AccelerationFn,
  dt: number,
): TranslationalState {
  const k1v = accelerationOf(state, 0);
  const k1x = state.velocity;

  const s2 = offsetState(state, k1x, k1v, dt / 2);
  const k2v = accelerationOf(s2, dt / 2);
  const k2x = s2.velocity;

  const s3 = offsetState(state, k2x, k2v, dt / 2);
  const k3v = accelerationOf(s3, dt / 2);
  const k3x = s3.velocity;

  const s4 = offsetState(state, k3x, k3v, dt);
  const k4v = accelerationOf(s4, dt);
  const k4x = s4.velocity;

  const dx = weightedSum(k1x, k2x, k3x, k4x).scale(dt / 6);
  const dv = weightedSum(k1v, k2v, k3v, k4v).scale(dt / 6);

  return {
    position: state.position.add(dx),
    velocity: state.velocity.add(dv),
  };
}

/**
 * Semi-implicit (symplectic) Euler: velocity updates first, then position uses
 * the new velocity. Energy-stable over long integrations.
 */
export function integrateSymplecticEuler(
  state: TranslationalState,
  accelerationOf: AccelerationFn,
  dt: number,
): TranslationalState {
  const acceleration = accelerationOf(state, 0);
  const velocity = state.velocity.add(acceleration.scale(dt));
  return {
    position: state.position.add(velocity.scale(dt)),
    velocity,
  };
}

function offsetState(
  base: TranslationalState,
  dxdt: Vec3,
  dvdt: Vec3,
  dt: number,
): TranslationalState {
  return {
    position: base.position.add(dxdt.scale(dt)),
    velocity: base.velocity.add(dvdt.scale(dt)),
  };
}

/** Simpson-style RK4 weighting: k1 + 2*k2 + 2*k3 + k4. */
function weightedSum(k1: Vec3, k2: Vec3, k3: Vec3, k4: Vec3): Vec3 {
  return k1.add(k2.scale(2)).add(k3.scale(2)).add(k4);
}
