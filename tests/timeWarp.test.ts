/**
 * Time-warp policy and its interaction with the physics regimes.
 *
 * The property that matters: warping must not change the orbit. A vessel that
 * warps a day forward should be on exactly the trajectory it would have
 * reached by coasting there in real time.
 */
import { describe, expect, it } from 'vitest';
import { TERRIN } from '../src/bodies/system.js';
import { createPathfinder } from '../src/parts/testVehicle.js';
import { createPrelaunchState } from '../src/sim/flightState.js';
import type { FlightState } from '../src/sim/flightState.js';
import { elementsFromState } from '../src/sim/orbit.js';
import { Quat } from '../src/sim/quat.js';
import { step } from '../src/sim/simulation.js';
import type { SimulationOptions } from '../src/sim/simulation.js';
import {
  MAX_PHYSICS_WARP_INDEX,
  WARP_LEVELS,
  clampIndex,
  formatWarp,
  permittedWarpIndex,
  requiresRails,
  warpFactorAt,
} from '../src/sim/timeWarp.js';
import { Vec3 } from '../src/sim/vec3.js';

const MU = TERRIN.mu;

const OPTIONS: SimulationOptions = {
  target: { orbitRadius: TERRIN.radius + 80_000 },
  autopilotEnabled: false,
};

function orbitingState(radius = TERRIN.radius + 120_000): FlightState {
  const base = createPrelaunchState(TERRIN, createPathfinder());
  return {
    ...base,
    position: new Vec3(radius, 0, 0),
    velocity: new Vec3(0, Math.sqrt(MU / radius), 0),
    orientation: Quat.IDENTITY,
    throttle: 0,
    regime: 'coasting',
    rails: null,
  };
}

describe('warp levels', () => {
  it('starts at 1x and rises monotonically', () => {
    expect(WARP_LEVELS[0]).toBe(1);
    for (let i = 1; i < WARP_LEVELS.length; i++) {
      expect(WARP_LEVELS[i]!).toBeGreaterThan(WARP_LEVELS[i - 1]!);
    }
  });

  it('clamps indices to the available range', () => {
    expect(clampIndex(-5)).toBe(0);
    expect(clampIndex(999)).toBe(WARP_LEVELS.length - 1);
  });

  it('marks only the high tiers as requiring rails', () => {
    expect(requiresRails(MAX_PHYSICS_WARP_INDEX)).toBe(false);
    expect(requiresRails(MAX_PHYSICS_WARP_INDEX + 1)).toBe(true);
  });

  it('formats multipliers readably', () => {
    expect(formatWarp(0)).toBe('1x');
    expect(formatWarp(WARP_LEVELS.length - 1)).toBe('100,000x');
  });
});

describe('permittedWarpIndex', () => {
  it('allows high warp for a vessel on rails', () => {
    const onRails = step(orbitingState(), OPTIONS, 60).state;
    expect(onRails.regime).toBe('onRails');

    const highest = WARP_LEVELS.length - 1;
    expect(permittedWarpIndex(onRails, highest)).toBe(highest);
    expect(warpFactorAt(permittedWarpIndex(onRails, highest))).toBe(100_000);
  });

  it('clamps high warp down to the physics tier on the launchpad', () => {
    const onPad = createPrelaunchState(TERRIN, createPathfinder());
    expect(permittedWarpIndex(onPad, WARP_LEVELS.length - 1)).toBe(
      MAX_PHYSICS_WARP_INDEX,
    );
  });

  it('leaves low warp untouched regardless of regime', () => {
    const onPad = createPrelaunchState(TERRIN, createPathfinder());
    expect(permittedWarpIndex(onPad, 2)).toBe(2);
  });
});

describe('warping preserves the orbit', () => {
  it('reaches the same orbit warped as coasted', () => {
    const start = step(orbitingState(), OPTIONS, 60).state;
    const before = elementsFromState(start.position, start.velocity, MU);

    // One big warped jump...
    const warped = step(start, OPTIONS, 86_400).state;

    // ...versus the same span in a thousand smaller ones.
    let coasted = start;
    for (let i = 0; i < 1_000; i++) {
      coasted = step(coasted, OPTIONS, 86.4).state;
    }

    const warpedElements = elementsFromState(warped.position, warped.velocity, MU);
    const coastedElements = elementsFromState(coasted.position, coasted.velocity, MU);

    expect(warpedElements.semiMajorAxis).toBeCloseTo(before.semiMajorAxis, 6);
    expect(warpedElements.semiMajorAxis).toBeCloseTo(coastedElements.semiMajorAxis, 6);
    expect(warped.position.distanceTo(coasted.position)).toBeLessThan(1);
  });

  it('advances mission time by exactly the warped amount', () => {
    const start = step(orbitingState(), OPTIONS, 60).state;
    const result = step(start, OPTIONS, 3_600);

    expect(result.advanced).toBe(3_600);
    expect(result.state.time - start.time).toBe(3_600);
  });

  it('does not let a decaying orbit warp through the atmosphere', () => {
    // Periapsis inside the atmosphere: warping must stop at entry.
    const apoapsis = TERRIN.radius + 300_000;
    const periapsis = TERRIN.radius + 10_000;
    const a = (apoapsis + periapsis) / 2;

    let state: FlightState = {
      ...orbitingState(),
      position: new Vec3(apoapsis, 0, 0),
      velocity: new Vec3(0, Math.sqrt(MU * (2 / apoapsis - 1 / a)), 0),
    };

    // Hammer it with maximum warp repeatedly.
    for (let i = 0; i < 200; i++) {
      state = step(state, OPTIONS, 100_000).state;
      expect(state.position.length).toBeGreaterThan(TERRIN.radius);
    }
  });
});
