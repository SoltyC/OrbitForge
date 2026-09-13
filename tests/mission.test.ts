/**
 * Milestone 4 acceptance: a full multi-body mission.
 *
 * Launch, reach orbit, wait for a transfer window, burn, cruise, cross into
 * Lunara's sphere of influence, and land. Every one of those steps is a
 * different part of the simulation, and this is the only test that exercises
 * them in sequence against each other.
 */
import { describe, expect, it } from 'vitest';
import { chainToRoot } from '../src/bodies/ephemeris.js';
import { LUNARA, TERRIN } from '../src/bodies/system.js';
import { craftToVessel } from '../src/parts/assembly.js';
import { attachPart, createCraft } from '../src/parts/craft.js';
import { createPathfinder } from '../src/parts/testVehicle.js';
import { createPrelaunchState } from '../src/sim/flightState.js';
import type { FlightState } from '../src/sim/flightState.js';
import type { AscentPhase } from '../src/sim/guidance.js';
import { PHYSICS_TIMESTEP, step } from '../src/sim/simulation.js';
import type { SimulationOptions } from '../src/sim/simulation.js';
import {
  angularRate,
  departureDeltaV,
  phaseAngle,
  planTransfer,
  signedAngleDifference,
} from '../src/sim/transfer.js';
import { Vec3 } from '../src/sim/vec3.js';
import { totalDeltaV, vesselMass } from '../src/sim/vessel.js';
import type { Vessel } from '../src/sim/vessel.js';

const MISSION: SimulationOptions = {
  target: { orbitRadius: TERRIN.radius + 80_000 },
  autopilotEnabled: true,
  transferTo: LUNARA,
};

/**
 * A three-stage launcher with a booster cluster, built through editor
 * operations — this is the sort of craft a player has to design to reach the
 * moon, and the reference Pathfinder is deliberately not big enough.
 */
function buildMoonRocket(): Vessel {
  let craft = createCraft('Wayfarer', 'mk1-pod');

  const stack = [
    'decoupler-stack', 'tank-small', 'engine-vacuum',   // lander
    'decoupler-stack', 'tank-large', 'engine-booster',  // transfer
    'decoupler-stack', 'tank-large', 'engine-booster',  // launch
  ];

  let parentId = 'root';
  let lastTankId = 'root';
  for (const partId of stack) {
    const before = craft.parts.length;
    craft = attachPart(craft, { parentId, parentNodeId: 'bottom', partId });
    parentId = craft.parts[before]!.id;
    if (partId === 'tank-large') lastTankId = parentId;
  }

  // Radial boosters so the launch stage clears TWR 1.
  craft = attachPart(craft, {
    parentId: lastTankId,
    parentNodeId: 'radial',
    partId: 'engine-booster',
    symmetry: 2,
  });

  return craftToVessel(craft);
}

interface MissionLog {
  readonly finalState: FlightState;
  readonly phases: readonly AscentPhase[];
  readonly transitionBefore: FlightState | null;
  readonly transitionAfter: FlightState | null;
}

/** Fly a mission, warping on rails, recording phases and the SOI crossing. */
function flyMission(vessel: Vessel, maxSteps = 4_000_000): MissionLog {
  let state = createPrelaunchState(TERRIN, vessel);
  const phases: AscentPhase[] = [];

  let transitionBefore: FlightState | null = null;
  let transitionAfter: FlightState | null = null;

  for (let i = 0; i < maxSteps; i++) {
    const previous = state;
    const dt = state.regime === 'onRails' ? 600 : PHYSICS_TIMESTEP;
    const result = step(state, MISSION, dt);
    state = result.state;

    if (phases[phases.length - 1] !== result.command.phase) {
      phases.push(result.command.phase);
    }

    if (previous.body.id !== state.body.id && !transitionAfter) {
      transitionBefore = previous;
      transitionAfter = state;
    }

    if (result.command.phase === 'touchdown') break;
  }

  return { finalState: state, phases, transitionBefore, transitionAfter };
}

describe('transfer planning', () => {
  it('computes the Hohmann flight time between the two orbits', () => {
    const position = new Vec3(TERRIN.radius + 80_000, 0, 0);
    const plan = planTransfer(position, LUNARA, TERRIN.mu, 0);

    const axis = (plan.departureRadius + plan.arrivalRadius) / 2;
    const expected = Math.PI * Math.sqrt((axis * axis * axis) / TERRIN.mu);

    expect(plan.flightTime).toBeCloseTo(expected, 6);
    // Roughly seven and a half hours for this pair of orbits.
    expect(plan.flightTime / 3600).toBeGreaterThan(6);
    expect(plan.flightTime / 3600).toBeLessThan(9);
  });

  it('requires the moon to lead by a little over 100 degrees', () => {
    const position = new Vec3(TERRIN.radius + 80_000, 0, 0);
    const plan = planTransfer(position, LUNARA, TERRIN.mu, 0);
    const degrees = (plan.requiredPhaseAngle * 180) / Math.PI;

    expect(degrees).toBeGreaterThan(100);
    expect(degrees).toBeLessThan(120);
  });

  it('prices the departure burn near 850 m/s', () => {
    const plan = planTransfer(new Vec3(TERRIN.radius + 80_000, 0, 0), LUNARA, TERRIN.mu, 0);
    expect(plan.deltaV).toBeGreaterThan(800);
    expect(plan.deltaV).toBeLessThan(900);
  });

  it('matches vis-viva for the departure burn', () => {
    const r1 = TERRIN.radius + 80_000;
    const axis = (r1 + 12_000_000) / 2;
    const expected =
      Math.sqrt(TERRIN.mu * (2 / r1 - 1 / axis)) - Math.sqrt(TERRIN.mu / r1);

    expect(departureDeltaV(r1, axis, TERRIN.mu)).toBeCloseTo(expected, 9);
  });

  it('measures phase angle in the direction of travel', () => {
    expect(phaseAngle(new Vec3(1, 0, 0), new Vec3(0, 1, 0))).toBeCloseTo(Math.PI / 2, 9);
    expect(phaseAngle(new Vec3(0, 1, 0), new Vec3(1, 0, 0))).toBeCloseTo(
      (3 * Math.PI) / 2,
      9,
    );
  });

  it('wraps angle differences to the short way round', () => {
    expect(signedAngleDifference(0.1, 6.2)).toBeCloseTo(0.1 + 2 * Math.PI - 6.2, 9);
    expect(signedAngleDifference(1, 2)).toBeCloseTo(-1, 9);
  });

  it('gives a lower orbit the faster angular rate', () => {
    expect(angularRate(TERRIN.radius + 80_000, TERRIN.mu)).toBeGreaterThan(
      angularRate(12_000_000, TERRIN.mu),
    );
  });
});

describe('Wayfarer lunar mission', () => {
  const log = flyMission(buildMoonRocket());

  it('carries more delta-v than the reference launcher', () => {
    expect(totalDeltaV(buildMoonRocket())).toBeGreaterThan(
      totalDeltaV(createPathfinder()),
    );
  });

  it('passes through every mission phase in order', () => {
    const ordered: AscentPhase[] = [
      'liftoff',
      'transferBurn',
      'cruise',
      'descent',
      'touchdown',
    ];

    let searchFrom = 0;
    for (const phase of ordered) {
      const index = log.phases.indexOf(phase, searchFrom);
      expect(index, `expected phase ${phase} after index ${searchFrom}`).toBeGreaterThan(-1);
      searchFrom = index;
    }
  });

  it('crosses into Lunara’s sphere of influence', () => {
    expect(log.transitionBefore?.body.id).toBe('terrin');
    expect(log.transitionAfter?.body.id).toBe('lunara');
  });

  it('crosses the boundary at the SOI radius', () => {
    expect(log.transitionAfter!.position.length).toBeCloseTo(LUNARA.soiRadius, -3);
  });

  it('does not gain or lose velocity crossing the boundary', () => {
    const before = log.transitionBefore!;
    const after = log.transitionAfter!;

    // Compare in the shared root frame: re-parenting changes the description
    // of the motion, never the motion itself.
    const beforeAbsolute = before.velocity.add(
      chainToRoot(before.body, before.time).velocity,
    );
    const afterAbsolute = after.velocity.add(
      chainToRoot(after.body, after.time).velocity,
    );

    expect(afterAbsolute.distanceTo(beforeAbsolute)).toBeLessThan(1);
  });

  it('lands on the surface at walking pace', () => {
    const state = log.finalState;
    expect(state.body.id).toBe('lunara');

    const altitude = state.position.length - LUNARA.radius;
    expect(altitude).toBeLessThan(25);
    expect(altitude).toBeGreaterThanOrEqual(0);

    // Inertial speed still carries the moon's rotation; relative to the
    // ground the vessel must be essentially stopped.
    const surfaceSpeed = 2 * Math.PI * LUNARA.radius / LUNARA.rotationPeriod;
    expect(Math.abs(state.velocity.length - surfaceSpeed)).toBeLessThan(3);
  });

  it('lands with propellant remaining', () => {
    expect(log.finalState.vessel.stages[0]!.propellant).toBeGreaterThan(0);
  });

  it('arrives within half a day', () => {
    expect(log.finalState.time / 3600).toBeLessThan(12);
  });
});

describe('Pathfinder I cannot reach the moon', () => {
  it('lacks the delta-v to land, and fails by crashing rather than hanging', () => {
    // Documents a real limitation: the reference launcher gets an encounter
    // but not a landing, which is why the mission needs a bigger craft.
    const vessel = createPathfinder();
    expect(vesselMass(vessel)).toBeLessThan(vesselMass(buildMoonRocket()));

    const log = flyMission(vessel, 2_000_000);
    expect(log.transitionAfter?.body.id).toBe('lunara');
    expect(log.finalState.position.length).toBeLessThanOrEqual(LUNARA.soiRadius);
  });
});
