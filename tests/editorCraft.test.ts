/**
 * Milestone 3 acceptance: a craft built purely through editor operations must
 * be flyable, and engine clusters must actually produce cluster thrust.
 *
 * This is the test that would have caught the single-engine bug — before it,
 * radial boosters added mass and no thrust, so a cluster flew *worse* than the
 * rocket without it.
 */
import { describe, expect, it } from 'vitest';
import { TERRIN } from '../src/bodies/system.js';
import { craftToVessel } from '../src/parts/assembly.js';
import { attachPart, childrenOf, createCraft } from '../src/parts/craft.js';
import type { Craft } from '../src/parts/craft.js';
import { createPathfinderCraft } from '../src/parts/testVehicle.js';
import { G0 } from '../src/parts/types.js';
import { createPrelaunchState } from '../src/sim/flightState.js';
import { elementsFromState } from '../src/sim/orbit.js';
import { PHYSICS_TIMESTEP, step } from '../src/sim/simulation.js';
import type { SimulationOptions } from '../src/sim/simulation.js';
import {
  activeEngines,
  currentMassFlow,
  effectiveIsp,
  stageDeltaV,
  thrustToWeight,
  totalThrust,
  vesselMass,
} from '../src/sim/vessel.js';
import { runAscent } from './helpers/runAscent.js';

const OPTIONS: SimulationOptions = {
  target: { orbitRadius: TERRIN.radius + 80_000 },
  autopilotEnabled: true,
};

/** Pathfinder with a ring of radial boosters on the first-stage tank. */
function withBoosters(count: number): Craft {
  const craft = createPathfinderCraft();
  const bigTank = craft.parts.find((p) => p.partId === 'tank-large')!;

  return attachPart(craft, {
    parentId: bigTank.id,
    parentNodeId: 'radial',
    partId: 'engine-booster',
    symmetry: count,
  });
}

describe('engine clusters', () => {
  it('counts every engine in the active stage', () => {
    expect(activeEngines(craftToVessel(createPathfinderCraft()))).toHaveLength(1);
    expect(activeEngines(craftToVessel(withBoosters(3)))).toHaveLength(4);
  });

  it('sums thrust across the cluster', () => {
    const single = totalThrust(craftToVessel(createPathfinderCraft()), 1);
    const clustered = totalThrust(craftToVessel(withBoosters(3)), 1);

    expect(single).toBe(240_000);
    expect(clustered).toBe(240_000 * 4);
  });

  it('raises launch TWR despite the added mass', () => {
    const plain = craftToVessel(createPathfinderCraft());
    const clustered = craftToVessel(withBoosters(3));

    const plainTwr = thrustToWeight(plain, 9.81, 1);
    const clusteredTwr = thrustToWeight(clustered, 9.81, 1);

    expect(vesselMass(clustered)).toBeGreaterThan(vesselMass(plain));
    expect(clusteredTwr).toBeGreaterThan(plainTwr);
  });

  it('returns the shared Isp for identical engines', () => {
    const engines = activeEngines(craftToVessel(withBoosters(3)));
    expect(effectiveIsp(engines, 0)).toBeCloseTo(300, 9);
  });

  it('weights Isp by thrust for a mixed cluster', () => {
    const mixed = [
      { thrustVacuum: 100_000, thrustSeaLevel: 100_000, ispVacuum: 300, ispSeaLevel: 300, gimbalRange: 0 },
      { thrustVacuum: 100_000, thrustSeaLevel: 100_000, ispVacuum: 400, ispSeaLevel: 400, gimbalRange: 0 },
    ];

    // Equal thrust, so flow is 1/300 + 1/400 per unit: the harmonic mean.
    const expected = 200_000 / (100_000 / 300 + 100_000 / 400);
    expect(effectiveIsp(mixed, 0)).toBeCloseTo(expected, 6);
    expect(effectiveIsp(mixed, 0)).toBeLessThan(350);
  });

  it('draws propellant for every engine in the cluster', () => {
    // Compared at equal throttle: the autopilot throttles a high-thrust craft
    // back, so flown side by side these would not burn at a 4:1 ratio.
    const plain = currentMassFlow(craftToVessel(createPathfinderCraft()), 1, 1);
    const clustered = currentMassFlow(craftToVessel(withBoosters(3)), 1, 1);

    expect(clustered).toBeCloseTo(plain * 4, 6);
  });

  it('throttles a high-thrust craft back on the pad', () => {
    const clustered = createPrelaunchState(TERRIN, craftToVessel(withBoosters(3)));
    const after = step(clustered, OPTIONS, PHYSICS_TIMESTEP).state;

    // Full throttle here would be TWR ~7; the autopilot holds it near 2.
    expect(after.throttle).toBeGreaterThan(0);
    expect(after.throttle).toBeLessThan(0.5);
  });

  it('uses cluster Isp in the rocket equation', () => {
    const vessel = craftToVessel(withBoosters(2));
    const wet = vesselMass(vessel);
    const dry = wet - vessel.stages[0]!.propellant;

    // All boosters share one Isp, so the cluster behaves as a single engine.
    expect(stageDeltaV(vessel, 0)).toBeCloseTo(300 * G0 * Math.log(wet / dry), 6);
  });
});

describe('flying an editor-built craft', () => {
  it('reaches orbit with a booster cluster attached', () => {
    const result = runAscent(TERRIN, craftToVessel(withBoosters(2)), OPTIONS, 1_500);

    expect(result.elements.isClosed).toBe(true);
    expect(result.elements.periapsis - TERRIN.radius).toBeGreaterThan(
      TERRIN.atmosphere!.height,
    );
    expect(result.phase).toBe('complete');
  });

  it('reaches orbit faster with boosters than without', () => {
    const plain = runAscent(TERRIN, craftToVessel(createPathfinderCraft()), OPTIONS, 1_500);
    const boosted = runAscent(TERRIN, craftToVessel(withBoosters(2)), OPTIONS, 1_500);

    expect(boosted.phase).toBe('complete');
    expect(boosted.elapsed).toBeLessThan(plain.elapsed);
  });

  it('refuses to fly a craft with no engine', () => {
    const craft = attachPart(createCraft('Dud', 'mk1-pod'), {
      parentId: 'root',
      parentNodeId: 'bottom',
      partId: 'tank-large',
    });

    const state = createPrelaunchState(TERRIN, craftToVessel(craft));
    const after = step(state, OPTIONS, PHYSICS_TIMESTEP).state;

    // No engine means no throttle and no movement off the pad.
    expect(after.throttle).toBe(0);
    expect(after.regime).toBe('landed');
  });

  it('flies a minimal single-stage craft built from scratch', () => {
    let craft = createCraft('Minimal', 'mk1-pod');
    craft = attachPart(craft, {
      parentId: 'root',
      parentNodeId: 'bottom',
      partId: 'tank-large',
    });
    const tank = childrenOf(craft, 'root')[0]!;
    craft = attachPart(craft, {
      parentId: tank.id,
      parentNodeId: 'bottom',
      partId: 'engine-booster',
    });

    const vessel = craftToVessel(craft);
    expect(vessel.stages).toHaveLength(1);
    expect(thrustToWeight(vessel, 9.81, 1)).toBeGreaterThan(1);

    // A single stage with this much delta-v should still make orbit.
    const result = runAscent(TERRIN, vessel, OPTIONS, 1_500);
    const elements = elementsFromState(
      result.finalState.position,
      result.finalState.velocity,
      TERRIN.mu,
    );
    expect(elements.apoapsis - TERRIN.radius).toBeGreaterThan(70_000);
  });
});
