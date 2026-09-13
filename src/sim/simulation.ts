/**
 * The simulation step. Ties together guidance, attitude, forces and the
 * integrator, and produces a new immutable FlightState.
 *
 * Two regimes, chosen per step: RK4 integration whenever thrust or atmosphere
 * is in play, and analytic Kepler propagation while coasting in vacuum. Only
 * the latter can swallow an arbitrarily large timestep, which is what makes
 * meaningful time-warp possible.
 */
import { densityAt, dynamicPressure, pressureRatio } from './atmosphere.js';
import { stepAttitude } from './attitude.js';
import type { FlightState } from './flightState.js';
import { orientationPointing, thrustAxis } from './flightState.js';
import {
  altitudeOf,
  dragForce,
  gravityForce,
  surfaceRelativeVelocity,
  thrustForce,
} from './forces.js';
import type { AscentTarget, GuidanceCommand } from './guidance.js';
import { computeGuidance } from './guidance.js';
import { integrateRK4 } from './integrator.js';
import {
  advanceRails,
  canGoOnRails,
  enterRails,
  maxSafeRailsTimestep,
  railsToCartesian,
} from './rails.js';
import type { TranslationalState } from './integrator.js';
import { thrustAt } from '../parts/types.js';
import { Vec3 } from './vec3.js';
import {
  activeEngine,
  consumePropellant,
  currentMassFlow,
  dragArea,
  jettisonStage,
  vesselMass,
} from './vessel.js';

/** Fixed physics timestep (s). Render framerate is decoupled from this. */
export const PHYSICS_TIMESTEP = 1 / 50;

export interface SimulationOptions {
  readonly target: AscentTarget;
  readonly autopilotEnabled: boolean;
}

export interface StepResult {
  readonly state: FlightState;
  readonly command: GuidanceCommand;
  /** Seconds actually advanced. Less than requested when rails were clamped. */
  readonly advanced: number;
}

/**
 * Advance the simulation.
 *
 * Picks between the two regimes automatically: analytic Kepler propagation
 * while coasting in vacuum (which accepts an arbitrarily large `dt`), and RK4
 * integration whenever thrust or atmosphere is involved (which does not).
 */
export function step(
  state: FlightState,
  options: SimulationOptions,
  dt: number = PHYSICS_TIMESTEP,
): StepResult {
  const command = computeGuidance(state, options.target, options.autopilotEnabled);

  // Drop a spent stage before computing this step's forces.
  const staged = command.shouldStage
    ? { ...state, vessel: jettisonStage(state.vessel) }
    : state;

  const wantsThrust = resolveThrottle(staged, command.throttle) > 0;
  if (!wantsThrust && canGoOnRails(staged)) {
    const railed = stepOnRails(staged, command, dt);
    if (railed) return railed;
  }

  return stepIntegrated(staged, command, Math.min(dt, PHYSICS_TIMESTEP));
}

/**
 * Advance analytically along a frozen orbit. Returns null when the step cannot
 * safely be taken on rails (atmospheric entry is imminent), so the caller can
 * fall back to integration.
 */
function stepOnRails(
  state: FlightState,
  command: GuidanceCommand,
  dt: number,
): StepResult | null {
  const mu = state.body.mu;
  const rails = state.rails ?? enterRails(state);
  const safeDt = maxSafeRailsTimestep(rails, state.body, dt);

  // Too close to the atmosphere to warp across — hand back to the integrator.
  if (safeDt < PHYSICS_TIMESTEP) return null;

  const advanced = advanceRails(rails, mu, safeDt);
  const { position, velocity } = railsToCartesian(advanced, mu);

  return {
    state: {
      ...state,
      position,
      velocity,
      // The timestep here can be hours; integrating a PD controller across it
      // would be meaningless, so point the vessel directly at its target.
      orientation: orientationPointing(command.targetDirection),
      angularVelocity: Vec3.ZERO,
      throttle: 0,
      rails: advanced,
      regime: 'onRails',
      time: state.time + safeDt,
    },
    command,
    advanced: safeDt,
  };
}

/** The milestone 1 path: full force model under RK4. */
function stepIntegrated(
  staged: FlightState,
  command: GuidanceCommand,
  dt: number,
): StepResult {
  const altitude = altitudeOf(staged.body, staged.position);
  const ambientRatio = pressureRatio(staged.body, altitude);
  const throttle = resolveThrottle(staged, command.throttle);

  const attitude = updateAttitude(staged, command, throttle, ambientRatio, dt);
  const axis = thrustAxis({ ...staged, ...attitude });

  const { vessel, consumed } = burnPropellant(staged, ambientRatio, throttle, dt);
  const thrustMagnitude = resolveThrust(staged, ambientRatio, throttle, consumed, dt);

  const translational = integrateTranslation(staged, axis, thrustMagnitude, dt);
  const grounded = resolveGroundContact(staged, translational, thrustMagnitude);

  return {
    state: {
      ...staged,
      ...attitude,
      ...grounded.state,
      vessel,
      throttle,
      time: staged.time + dt,
      regime: grounded.regime,
      // Any integrated step invalidates the frozen orbit.
      rails: null,
    },
    command,
    advanced: dt,
  };
}

/** Throttle is zero without a live engine or propellant, whatever was asked. */
function resolveThrottle(state: FlightState, requested: number): number {
  const engine = activeEngine(state.vessel);
  if (!engine) return 0;
  const stage = state.vessel.stages[0];
  if (!stage || stage.propellant <= 0) return 0;
  return Math.min(1, Math.max(0, requested));
}

function updateAttitude(
  state: FlightState,
  command: GuidanceCommand,
  throttle: number,
  ambientRatio: number,
  dt: number,
) {
  const altitude = altitudeOf(state.body, state.position);
  const density = densityAt(state.body, altitude);
  const airspeed = surfaceRelativeVelocity(state.body, state.position, state.velocity).length;
  const q = dynamicPressure(density, airspeed);

  return stepAttitude(
    { orientation: state.orientation, angularVelocity: state.angularVelocity },
    thrustAxis(state),
    command.targetDirection,
    state.vessel,
    throttle,
    ambientRatio,
    q,
    dt,
  );
}

function burnPropellant(
  state: FlightState,
  ambientRatio: number,
  throttle: number,
  dt: number,
) {
  const flow = currentMassFlow(state.vessel, ambientRatio, throttle);
  return consumePropellant(state.vessel, flow * dt);
}

/**
 * Actual thrust this step. If the tank ran dry partway through, thrust is
 * scaled by the fraction of the demanded propellant that was available.
 */
function resolveThrust(
  state: FlightState,
  ambientRatio: number,
  throttle: number,
  consumed: number,
  dt: number,
): number {
  const engine = activeEngine(state.vessel);
  if (!engine || throttle <= 0) return 0;

  const demanded = currentMassFlow(state.vessel, ambientRatio, throttle) * dt;
  if (demanded <= 0) return 0;

  const fraction = Math.min(1, consumed / demanded);
  return thrustAt(engine, ambientRatio) * throttle * fraction;
}

function integrateTranslation(
  state: FlightState,
  axis: Vec3,
  thrustMagnitude: number,
  dt: number,
): TranslationalState {
  const mass = vesselMass(state.vessel);
  const area = dragArea(state.vessel);
  const body = state.body;

  // Mass and thrust are held constant across the step; they change far more
  // slowly than position and velocity at a 20 ms timestep.
  const accelerationOf = (s: TranslationalState): Vec3 => {
    const gravity = gravityForce(body, s.position, mass);
    const drag = dragForce(body, s.position, s.velocity, area);
    const thrust = thrustForce(axis, thrustMagnitude);
    return gravity.add(drag).add(thrust).scale(1 / mass);
  };

  return integrateRK4(
    { position: state.position, velocity: state.velocity },
    accelerationOf,
    dt,
  );
}

/**
 * Keep the vessel from sinking through the surface. While it lacks the thrust
 * to lift off it stays clamped to the pad, co-rotating with the ground.
 */
function resolveGroundContact(
  state: FlightState,
  next: TranslationalState,
  thrustMagnitude: number,
): { state: TranslationalState; regime: FlightState['regime'] } {
  const body = state.body;
  const altitude = next.position.length - body.radius;

  if (altitude > 0) {
    return { state: next, regime: thrustMagnitude > 0 ? 'powered' : 'coasting' };
  }

  // Clamp to the surface and match the ground's rotation.
  const surfacePosition = next.position.normalized().scale(body.radius);
  const spinAxis = new Vec3(0, 0, (2 * Math.PI) / body.rotationPeriod);

  return {
    state: {
      position: surfacePosition,
      velocity: spinAxis.cross(surfacePosition),
    },
    regime: thrustMagnitude > 0 ? 'powered' : 'landed',
  };
}
