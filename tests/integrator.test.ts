/**
 * Integrator accuracy and energy-conservation tests.
 *
 * The headline check is that RK4 holds a circular orbit over many revolutions:
 * this is exactly what naive explicit Euler fails at, and why it is banned.
 */
import { describe, expect, it } from 'vitest';
import { TERRIN } from '../src/bodies/system.js';
import { integrateRK4, integrateSymplecticEuler } from '../src/sim/integrator.js';
import type { AccelerationFn, TranslationalState } from '../src/sim/integrator.js';
import { elementsFromState } from '../src/sim/orbit.js';
import { Vec3 } from '../src/sim/vec3.js';

const MU = TERRIN.mu;

/** Pure two-body gravity, no drag or thrust. */
const gravityOnly: AccelerationFn = (state) => {
  const rSq = state.position.lengthSq;
  return state.position.normalized().scale(-MU / rSq);
};

function circularState(radius: number): TranslationalState {
  return {
    position: new Vec3(radius, 0, 0),
    velocity: new Vec3(0, Math.sqrt(MU / radius), 0),
  };
}

/** Specific orbital energy: v^2/2 - mu/r. Conserved under pure gravity. */
function specificEnergy(state: TranslationalState): number {
  return state.velocity.lengthSq / 2 - MU / state.position.length;
}

describe('integrateRK4', () => {
  it('holds a circular orbit over ten revolutions', () => {
    const radius = TERRIN.radius + 100_000;
    let state = circularState(radius);
    const initial = elementsFromState(state.position, state.velocity, MU);

    const dt = 1 / 50;
    const steps = Math.floor((initial.period * 10) / dt);
    for (let i = 0; i < steps; i++) {
      state = integrateRK4(state, gravityOnly, dt);
    }

    const final = elementsFromState(state.position, state.velocity, MU);

    // Radius must not drift measurably, and the orbit must stay circular.
    expect(final.semiMajorAxis / initial.semiMajorAxis).toBeCloseTo(1, 8);
    expect(final.eccentricity).toBeLessThan(1e-6);
  });

  it('conserves specific orbital energy', () => {
    let state = circularState(TERRIN.radius + 200_000);
    const initialEnergy = specificEnergy(state);

    for (let i = 0; i < 50_000; i++) {
      state = integrateRK4(state, gravityOnly, 1 / 50);
    }

    const drift = Math.abs(specificEnergy(state) - initialEnergy) / Math.abs(initialEnergy);
    expect(drift).toBeLessThan(1e-9);
  });

  it('matches the analytic solution for constant acceleration', () => {
    // Under constant acceleration RK4 is exact: x = x0 + v0*t + 0.5*a*t^2.
    const acceleration = new Vec3(0, -9.81, 0);
    const constant: AccelerationFn = () => acceleration;

    let state: TranslationalState = {
      position: Vec3.ZERO,
      velocity: new Vec3(100, 50, 0),
    };

    const dt = 0.01;
    const steps = 1_000;
    for (let i = 0; i < steps; i++) {
      state = integrateRK4(state, constant, dt);
    }

    const t = dt * steps;
    expect(state.position.x).toBeCloseTo(100 * t, 6);
    expect(state.position.y).toBeCloseTo(50 * t - 0.5 * 9.81 * t * t, 6);
    expect(state.velocity.y).toBeCloseTo(50 - 9.81 * t, 9);
  });
});

describe('integrateSymplecticEuler', () => {
  it('keeps orbital energy bounded over many revolutions', () => {
    let state = circularState(TERRIN.radius + 100_000);
    const initialEnergy = specificEnergy(state);

    for (let i = 0; i < 100_000; i++) {
      state = integrateSymplecticEuler(state, gravityOnly, 1 / 50);
    }

    // Symplectic integrators oscillate around the true energy rather than
    // drifting away from it — the property that makes them useful here.
    const drift = Math.abs(specificEnergy(state) - initialEnergy) / Math.abs(initialEnergy);
    expect(drift).toBeLessThan(1e-3);
  });
});
