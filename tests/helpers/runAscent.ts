/**
 * Headless ascent driver shared by tests and the tuning script.
 */
import type { Body } from '../../src/bodies/types.js';
import { createPrelaunchState } from '../../src/sim/flightState.js';
import type { FlightState } from '../../src/sim/flightState.js';
import type { AscentPhase } from '../../src/sim/guidance.js';
import { elementsFromState } from '../../src/sim/orbit.js';
import type { OrbitSummary } from '../../src/sim/orbit.js';
import { PHYSICS_TIMESTEP, step } from '../../src/sim/simulation.js';
import type { SimulationOptions } from '../../src/sim/simulation.js';
import type { Vessel } from '../../src/sim/vessel.js';

export interface AscentResult {
  readonly finalState: FlightState;
  readonly elements: OrbitSummary;
  readonly phase: AscentPhase;
  readonly maxDynamicPressure: number;
  readonly elapsed: number;
}

/** Fly the autopilot until it reports `complete` or the time limit expires. */
export function runAscent(
  body: Body,
  vessel: Vessel,
  options: SimulationOptions,
  maxSeconds: number,
  onSample?: (state: FlightState, phase: AscentPhase) => void,
): AscentResult {
  let state = createPrelaunchState(body, vessel);
  let phase: AscentPhase = 'prelaunch';
  let maxDynamicPressure = 0;

  const maxSteps = Math.floor(maxSeconds / PHYSICS_TIMESTEP);

  for (let i = 0; i < maxSteps; i++) {
    const result = step(state, options);
    state = result.state;
    phase = result.command.phase;

    const q = sampleDynamicPressure(state);
    if (q > maxDynamicPressure) maxDynamicPressure = q;

    onSample?.(state, phase);

    if (phase === 'complete') break;
    if (!state.position.isFinite || !state.velocity.isFinite) break;
  }

  return {
    finalState: state,
    elements: elementsFromState(state.position, state.velocity, body.mu),
    phase,
    maxDynamicPressure,
    elapsed: state.time,
  };
}

function sampleDynamicPressure(state: FlightState): number {
  const atmo = state.body.atmosphere;
  if (!atmo) return 0;
  const altitude = state.position.length - state.body.radius;
  if (altitude >= atmo.height) return 0;
  const density = atmo.seaLevelDensity * Math.exp(-altitude / atmo.scaleHeight);
  const speed = state.velocity.length;
  return 0.5 * density * speed * speed;
}
