/**
 * On-rails propagation tests.
 *
 * The headline test is cross-validation: analytic Kepler propagation and RK4
 * integration must describe the same trajectory. They are completely
 * independent code paths, so agreement between them is strong evidence both
 * are right — and any future regression in either will break it.
 */
import { describe, expect, it } from 'vitest';
import { TERRIN } from '../src/bodies/system.js';
import { createPathfinder } from '../src/parts/testVehicle.js';
import { createPrelaunchState } from '../src/sim/flightState.js';
import type { FlightState } from '../src/sim/flightState.js';
import { integrateRK4 } from '../src/sim/integrator.js';
import type { AccelerationFn, TranslationalState } from '../src/sim/integrator.js';
import { elementsFromState } from '../src/sim/orbit.js';
import {
  advanceRails,
  canGoOnRails,
  enterRails,
  maxSafeRailsTimestep,
  railsToCartesian,
} from '../src/sim/rails.js';
import { PHYSICS_TIMESTEP, step } from '../src/sim/simulation.js';
import type { SimulationOptions } from '../src/sim/simulation.js';
import { Quat } from '../src/sim/quat.js';
import { Vec3 } from '../src/sim/vec3.js';

const MU = TERRIN.mu;

const COAST_OPTIONS: SimulationOptions = {
  target: { orbitRadius: TERRIN.radius + 80_000 },
  autopilotEnabled: false,
};

/** A coasting vessel in a stable orbit, well clear of the atmosphere. */
function orbitingState(radius = TERRIN.radius + 120_000): FlightState {
  const base = createPrelaunchState(TERRIN, createPathfinder());
  const speed = Math.sqrt(MU / radius);

  return {
    ...base,
    position: new Vec3(radius, 0, 0),
    velocity: new Vec3(0, speed, 0),
    orientation: Quat.IDENTITY,
    throttle: 0,
    regime: 'coasting',
    rails: null,
  };
}

const gravityOnly: AccelerationFn = (s) =>
  s.position.normalized().scale(-MU / s.position.lengthSq);

describe('rails eligibility', () => {
  it('accepts a coasting vessel in a stable orbit', () => {
    expect(canGoOnRails(orbitingState())).toBe(true);
  });

  it('rejects a vessel on the launchpad', () => {
    expect(canGoOnRails(createPrelaunchState(TERRIN, createPathfinder()))).toBe(false);
  });

  it('rejects a vessel inside the atmosphere', () => {
    const inAtmosphere = {
      ...orbitingState(),
      position: new Vec3(TERRIN.radius + 30_000, 0, 0),
    };
    expect(canGoOnRails(inAtmosphere)).toBe(false);
  });

  it('rejects a vessel under thrust', () => {
    expect(canGoOnRails({ ...orbitingState(), throttle: 1 })).toBe(false);
  });

  it('rejects a vessel on an escape trajectory', () => {
    const radius = TERRIN.radius + 120_000;
    const escaping = {
      ...orbitingState(),
      velocity: new Vec3(0, Math.sqrt((2 * MU) / radius) * 1.1, 0),
    };
    expect(canGoOnRails(escaping)).toBe(false);
  });
});

describe('rails vs RK4 cross-validation', () => {
  it('agrees with RK4 over a full orbit', () => {
    const state = orbitingState();
    const elements = elementsFromState(state.position, state.velocity, MU);
    const duration = elements.period;

    // Path A: one analytic solve.
    const rails = advanceRails(enterRails(state), MU, duration);
    const analytic = railsToCartesian(rails, MU);

    // Path B: integrate the same span with RK4.
    let integrated: TranslationalState = {
      position: state.position,
      velocity: state.velocity,
    };
    const steps = Math.round(duration / PHYSICS_TIMESTEP);
    const dt = duration / steps;
    for (let i = 0; i < steps; i++) {
      integrated = integrateRK4(integrated, gravityOnly, dt);
    }

    // Agreement to within a metre over a ~700 km orbit.
    expect(analytic.position.distanceTo(integrated.position)).toBeLessThan(1);
    expect(analytic.velocity.distanceTo(integrated.velocity)).toBeLessThan(0.01);
  });

  it('agrees with RK4 on an eccentric orbit', () => {
    const periapsis = TERRIN.radius + 100_000;
    const a = TERRIN.radius + 400_000;
    const speed = Math.sqrt(MU * (2 / periapsis - 1 / a));

    const state: FlightState = {
      ...orbitingState(),
      position: new Vec3(periapsis, 0, 0),
      velocity: new Vec3(0, speed, 0),
    };

    const elements = elementsFromState(state.position, state.velocity, MU);
    const duration = elements.period / 2;

    const analytic = railsToCartesian(advanceRails(enterRails(state), MU, duration), MU);

    let integrated: TranslationalState = {
      position: state.position,
      velocity: state.velocity,
    };
    const steps = Math.round(duration / PHYSICS_TIMESTEP);
    const dt = duration / steps;
    for (let i = 0; i < steps; i++) {
      integrated = integrateRK4(integrated, gravityOnly, dt);
    }

    expect(analytic.position.distanceTo(integrated.position)).toBeLessThan(5);
  });
});

describe('rails orbit conservation', () => {
  it('carries orbit shape forward exactly over a thousand orbits', () => {
    const state = orbitingState();
    const initial = enterRails(state);
    const elements = elementsFromState(state.position, state.velocity, MU);

    let rails = initial;
    for (let i = 0; i < 1_000; i++) {
      rails = advanceRails(rails, MU, elements.period);
    }

    // Shape is copied, never re-derived, so it cannot drift at all.
    expect(rails.elements.semiMajorAxis).toBe(initial.elements.semiMajorAxis);
    expect(rails.elements.eccentricity).toBe(initial.elements.eccentricity);
    expect(rails.elements.inclination).toBe(initial.elements.inclination);
  });

  it('gives the same result whether advanced in one step or many', () => {
    const state = orbitingState();
    const rails = enterRails(state);
    const total = 3_600;

    const oneStep = railsToCartesian(advanceRails(rails, MU, total), MU);

    let chunked = rails;
    for (let i = 0; i < 360; i++) {
      chunked = advanceRails(chunked, MU, total / 360);
    }
    const manySteps = railsToCartesian(chunked, MU);

    expect(oneStep.position.distanceTo(manySteps.position)).toBeLessThan(1e-3);
  });
});

describe('maxSafeRailsTimestep', () => {
  it('allows unrestricted warp for an orbit clear of the atmosphere', () => {
    const rails = enterRails(orbitingState());
    expect(maxSafeRailsTimestep(rails, TERRIN, 100_000)).toBe(100_000);
  });

  it('clamps warp to the next periapsis when the orbit dips into atmosphere', () => {
    // Apoapsis high, periapsis inside the atmosphere: a reentry trajectory.
    const apoapsis = TERRIN.radius + 200_000;
    const periapsis = TERRIN.radius + 20_000;
    const a = (apoapsis + periapsis) / 2;
    const speedAtApoapsis = Math.sqrt(MU * (2 / apoapsis - 1 / a));

    const state: FlightState = {
      ...orbitingState(),
      position: new Vec3(apoapsis, 0, 0),
      velocity: new Vec3(0, speedAtApoapsis, 0),
    };

    const rails = enterRails(state);
    const clamped = maxSafeRailsTimestep(rails, TERRIN, 1e9);

    expect(clamped).toBeLessThan(1e9);
    expect(clamped).toBeGreaterThan(0);

    // Having warped that far, the vessel must not already be underground.
    const arrived = railsToCartesian(advanceRails(rails, MU, clamped), MU);
    expect(arrived.position.length).toBeGreaterThan(TERRIN.radius);
  });
});

describe('regime switching through step()', () => {
  it('puts a coasting orbital vessel on rails', () => {
    const result = step(orbitingState(), COAST_OPTIONS, 60);

    expect(result.state.regime).toBe('onRails');
    expect(result.state.rails).not.toBeNull();
    expect(result.advanced).toBe(60);
  });

  it('accepts a huge timestep on rails without substepping', () => {
    const result = step(orbitingState(), COAST_OPTIONS, 10_000);

    expect(result.state.regime).toBe('onRails');
    expect(result.advanced).toBe(10_000);
    expect(result.state.position.isFinite).toBe(true);
  });

  it('clamps an integrated step to the fixed physics timestep', () => {
    const onPad = createPrelaunchState(TERRIN, createPathfinder());
    const result = step(onPad, COAST_OPTIONS, 10_000);

    expect(result.state.regime).not.toBe('onRails');
    expect(result.advanced).toBe(PHYSICS_TIMESTEP);
  });

  it('preserves the trajectory across a rails round trip', () => {
    const state = orbitingState();
    const before = elementsFromState(state.position, state.velocity, MU);

    // Go on rails, warp, then force back to integration.
    const warped = step(state, COAST_OPTIONS, 5_000).state;
    const resumed = step({ ...warped, rails: null, throttle: 0 }, COAST_OPTIONS, 5_000);
    const after = elementsFromState(
      resumed.state.position,
      resumed.state.velocity,
      MU,
    );

    // No energy discontinuity from entering or leaving rails.
    expect(after.semiMajorAxis).toBeCloseTo(before.semiMajorAxis, 3);
    expect(after.eccentricity).toBeCloseTo(before.eccentricity, 9);
  });
});
