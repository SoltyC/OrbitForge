/**
 * End-to-end ascent test: the vehicle must actually reach a stable orbit.
 *
 * This is the milestone 1 acceptance criterion. If this passes, the force
 * model, integrator, staging and guidance all agree with each other.
 */
import { describe, expect, it } from 'vitest';
import { TERRIN } from '../src/bodies/system.js';
import { createPathfinder } from '../src/parts/testVehicle.js';
import { altitudeOf } from '../src/sim/forces.js';
import { elementsFromState } from '../src/sim/orbit.js';
import { PHYSICS_TIMESTEP, step } from '../src/sim/simulation.js';
import type { SimulationOptions } from '../src/sim/simulation.js';
import { runAscent } from './helpers/runAscent.js';

const TARGET_RADIUS = TERRIN.radius + 80_000;

const OPTIONS: SimulationOptions = {
  target: { orbitRadius: TARGET_RADIUS },
  autopilotEnabled: true,
};

describe('Pathfinder I ascent to orbit', () => {
  const result = runAscent(TERRIN, createPathfinder(), OPTIONS, 1200);

  it('reaches a closed orbit', () => {
    expect(result.elements.isClosed).toBe(true);
  });

  it('raises periapsis clear of the atmosphere', () => {
    const periapsisAltitude = result.elements.periapsis - TERRIN.radius;
    expect(periapsisAltitude).toBeGreaterThan(TERRIN.atmosphere!.height);
  });

  it('achieves a near-circular orbit', () => {
    expect(result.elements.eccentricity).toBeLessThan(0.05);
  });

  it('reaches roughly the target altitude', () => {
    const apoapsisAltitude = result.elements.apoapsis - TERRIN.radius;
    expect(apoapsisAltitude).toBeGreaterThan(70_000);
    expect(apoapsisAltitude).toBeLessThan(120_000);
  });

  it('completes the ascent with propellant to spare', () => {
    expect(result.finalState.vessel.stages.length).toBeGreaterThanOrEqual(1);
    expect(result.phase).toBe('complete');
  });

  it('keeps the state numerically finite throughout', () => {
    expect(result.finalState.position.isFinite).toBe(true);
    expect(result.finalState.velocity.isFinite).toBe(true);
  });
});

describe('orbit stability after insertion', () => {
  it('holds its orbit when coasting with the autopilot off', () => {
    const ascent = runAscent(TERRIN, createPathfinder(), OPTIONS, 1200);

    const coastOptions: SimulationOptions = {
      target: { orbitRadius: TARGET_RADIUS },
      autopilotEnabled: false,
    };

    let state = { ...ascent.finalState, throttle: 0 };
    const before = elementsFromState(state.position, state.velocity, TERRIN.mu);

    // Coast for roughly one orbital period.
    const steps = Math.floor(before.period / PHYSICS_TIMESTEP);
    for (let i = 0; i < steps; i++) {
      state = step(state, coastOptions).state;
    }

    const after = elementsFromState(state.position, state.velocity, TERRIN.mu);

    // Semi-major axis should be conserved to well under a tenth of a percent.
    const drift = Math.abs(after.semiMajorAxis - before.semiMajorAxis) / before.semiMajorAxis;
    expect(drift).toBeLessThan(1e-3);
    expect(altitudeOf(TERRIN, state.position)).toBeGreaterThan(0);
  });
});
