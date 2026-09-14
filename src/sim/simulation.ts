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
  groundRadiusAt,
  gravityForce,
  surfaceRelativeVelocity,
  thrustForce,
  verticalSpeed,
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
import { heatingConditions, stepHeating } from './heating.js';
import { resolveSoi } from './soi.js';
import type { Body } from '../bodies/types.js';
import type { TranslationalState } from './integrator.js';
import { Vec3 } from './vec3.js';
import {
  activeEngines,
  consumePropellant,
  currentMassFlow,
  dragArea,
  jettisonStage,
  totalThrust,
  vesselMass,
} from './vessel.js';

/** How far above the ground a vessel can be and still count as resting on it (m). */
const CONTACT_TOLERANCE = 0.5;

/** Fixed physics timestep (s). Render framerate is decoupled from this. */
export const PHYSICS_TIMESTEP = 1 / 50;

export interface SimulationOptions {
  readonly target: AscentTarget;
  readonly autopilotEnabled: boolean;
  /** When set, the autopilot transfers to this body after reaching orbit. */
  readonly transferTo?: Body | null;
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
  const command = computeGuidance(
    state,
    options.target,
    options.autopilotEnabled,
    options.transferTo ?? null,
  );

  // Drop a spent stage before computing this step's forces.
  const staged = command.shouldStage
    ? { ...state, vessel: jettisonStage(state.vessel) }
    : state;

  // The autopilot may cap the step when it is waiting for a precise moment.
  const cappedDt = Math.min(dt, command.maxTimestep ?? Infinity);

  const wantsThrust = resolveThrottle(staged, command.throttle) > 0;
  if (!wantsThrust && canGoOnRails(staged)) {
    const railed = stepOnRails(staged, command, cappedDt);
    if (railed) return applySoi(railed);
  }

  return applySoi(stepIntegrated(staged, command, Math.min(cappedDt, PHYSICS_TIMESTEP)));
}

/**
 * Hand the vessel to whichever body now dominates it.
 *
 * Crossing a boundary rewrites position and velocity into the new frame and
 * invalidates any frozen orbit, because those elements described a conic about
 * the body just left.
 */
function applySoi(result: StepResult): StepResult {
  const state = result.state;
  const resolved = resolveSoi(
    { body: state.body, position: state.position, velocity: state.velocity },
    state.time,
  );

  if (resolved.body.id === state.body.id) return result;

  return {
    ...result,
    state: {
      ...state,
      body: resolved.body,
      position: resolved.position,
      velocity: resolved.velocity,
      rails: null,
      regime: state.throttle > 0 ? 'powered' : 'coasting',
    },
  };
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
  const safeDt = maxSafeRailsTimestep(rails, state.body, dt, state.time);

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
      // On rails the vessel is in vacuum by definition, so it only cools.
      thermal: stepHeating(state.thermal, 0, safeDt).thermal,
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

  // Heating is read after the step, from where the vessel ended up.
  const heating = heatingConditions(
    staged.body,
    grounded.state.position,
    grounded.state.velocity,
    noseRadiusOf(staged.vessel),
  );
  const thermal = stepHeating(staged.thermal, heating.flux, dt).thermal;

  return {
    state: {
      ...staged,
      ...attitude,
      ...grounded.state,
      vessel,
      throttle,
      time: staged.time + dt,
      regime: grounded.regime,
      thermal,
      // Any integrated step invalidates the frozen orbit.
      rails: null,
    },
    command,
    advanced: dt,
  };
}

/**
 * Radius of curvature of the leading surface (m).
 *
 * Taken from the widest part, because that is what the shock stands off from.
 * Heating goes as its inverse square root, so a broad craft is markedly cooler
 * than a narrow one at the same speed.
 */
function noseRadiusOf(vessel: FlightState['vessel']): number {
  let widest = 0;
  for (const stage of vessel.stages) {
    for (const part of stage.parts) widest = Math.max(widest, part.diameter);
  }
  return Math.max(0.1, widest / 2);
}

/** Throttle is zero without a live engine or propellant, whatever was asked. */
function resolveThrottle(state: FlightState, requested: number): number {
  if (activeEngines(state.vessel).length === 0) return 0;
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
  if (throttle <= 0) return 0;

  const demanded = currentMassFlow(state.vessel, ambientRatio, throttle) * dt;
  if (demanded <= 0) return 0;

  // A partially-fed cluster produces a proportional fraction of its thrust.
  const fraction = Math.min(1, consumed / demanded);
  return totalThrust(state.vessel, ambientRatio, throttle) * fraction;
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
  const ground = groundRadiusAt(body, next.position, state.time);

  // A little tolerance, because the ground is not a sphere any more. Travelling
  // along a slope changes the surface height under a vessel about as fast as
  // gravity pulls it down, so an exact test leaves a resting craft flickering
  // between landed and falling as the terrain drops away beneath it.
  //
  // Anything moving upward is released regardless of how close it is. Without
  // that the clamp is a trap: a lifting rocket is pinned and its velocity reset
  // every step, so it never gains the height to clear the tolerance and never
  // leaves the pad at all.
  const clearance = next.position.length - ground;
  const climbing = verticalSpeed(next.position, next.velocity) > 0;

  if (clearance > CONTACT_TOLERANCE || (clearance > 0 && climbing)) {
    return { state: next, regime: thrustMagnitude > 0 ? 'powered' : 'coasting' };
  }

  // Clamp to the surface and match the ground's rotation.
  const surfacePosition = next.position.normalized().scale(ground);
  const spinAxis = new Vec3(0, 0, (2 * Math.PI) / body.rotationPeriod);

  return {
    state: {
      position: surfacePosition,
      velocity: spinAxis.cross(surfacePosition),
    },
    regime: thrustMagnitude > 0 ? 'powered' : 'landed',
  };
}
