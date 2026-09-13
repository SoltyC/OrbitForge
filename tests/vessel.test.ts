/**
 * Vessel mass properties, staging, and the rocket equation.
 */
import { describe, expect, it } from 'vitest';
import { createPathfinder } from '../src/parts/testVehicle.js';
import { G0 } from '../src/parts/types.js';
import {
  activeEngine,
  consumePropellant,
  hasPropellant,
  jettisonStage,
  stageDeltaV,
  thrustToWeight,
  totalDeltaV,
  vesselMass,
} from '../src/sim/vessel.js';

describe('Pathfinder I mass properties', () => {
  const vessel = createPathfinder();

  it('has the expected liftoff mass', () => {
    // 11 550 kg booster + 2 700 kg upper + 800 kg pod.
    expect(vesselMass(vessel)).toBe(15_050);
  });

  it('starts with a launch TWR above 1', () => {
    const twr = thrustToWeight(vessel, 9.81, 1);
    expect(twr).toBeGreaterThan(1.5);
    expect(twr).toBeLessThan(2.0);
  });

  it('carries enough delta-v to reach orbit with margin', () => {
    // Orbiting Terrin costs roughly 3.4 km/s including losses.
    expect(totalDeltaV(vessel)).toBeGreaterThan(4_500);
  });

  it('exposes the booster engine as active', () => {
    expect(activeEngine(vessel)?.thrustSeaLevel).toBe(240_000);
  });
});

describe('stageDeltaV', () => {
  it('matches the Tsiolkovsky rocket equation by hand', () => {
    const vessel = createPathfinder();

    // Upper stage: 2 700 kg wet + 800 kg pod above it, 2 000 kg of propellant.
    const wet = 2_700 + 800;
    const dry = wet - 2_000;
    const expected = 345 * G0 * Math.log(wet / dry);

    expect(stageDeltaV(vessel, 1)).toBeCloseTo(expected, 6);
  });

  it('is zero for a stage with no propellant', () => {
    const vessel = createPathfinder();
    // Index 2 is the pod: no engine, no propellant.
    expect(stageDeltaV(vessel, 2)).toBe(0);
  });

  it('is zero for an out-of-range stage index', () => {
    expect(stageDeltaV(createPathfinder(), 99)).toBe(0);
  });
});

describe('consumePropellant', () => {
  it('does not mutate the original vessel', () => {
    const vessel = createPathfinder();
    const before = vessel.stages[0]!.propellant;

    consumePropellant(vessel, 500);

    expect(vessel.stages[0]!.propellant).toBe(before);
  });

  it('draws from the active stage', () => {
    const vessel = createPathfinder();
    const result = consumePropellant(vessel, 500);

    expect(result.consumed).toBe(500);
    expect(result.vessel.stages[0]!.propellant).toBe(9_000 - 500);
  });

  it('clamps to what is actually left in the tank', () => {
    const vessel = createPathfinder();
    const result = consumePropellant(vessel, 99_999);

    expect(result.consumed).toBe(9_000);
    expect(result.vessel.stages[0]!.propellant).toBe(0);
    expect(hasPropellant(result.vessel)).toBe(false);
  });
});

describe('jettisonStage', () => {
  it('drops the lowest stage and its mass', () => {
    const vessel = createPathfinder();
    const staged = jettisonStage(vessel);

    expect(staged.stages.length).toBe(2);
    expect(vesselMass(staged)).toBe(3_500);
    expect(activeEngine(staged)?.thrustVacuum).toBe(60_000);
  });

  it('never drops the final stage', () => {
    let vessel = createPathfinder();
    for (let i = 0; i < 10; i++) vessel = jettisonStage(vessel);

    expect(vessel.stages.length).toBe(1);
  });

  it('does not mutate the original vessel', () => {
    const vessel = createPathfinder();
    jettisonStage(vessel);
    expect(vessel.stages.length).toBe(3);
  });
});
