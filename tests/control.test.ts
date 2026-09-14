/**
 * Player control and manoeuvre planning.
 *
 * The question worth answering is whether someone can actually fly the thing:
 * point it where they want, burn when they choose, stage on their own command,
 * and plan a burn that does what the map said it would. So the important tests
 * here fly whole ascents and transfers on nothing but simulated input.
 */
import { describe, expect, it } from 'vitest';
import { LUNARA, TERRIN } from '../src/bodies/system.js';
import { createPathfinder } from '../src/parts/testVehicle.js';
import {
  NEUTRAL_CONTROL,
  canHold,
  holdDirection,
  holdLabel,
  referenceFrame,
  steer,
} from '../src/sim/control.js';
import type { ControlInput, HoldMode } from '../src/sim/control.js';
import { createPrelaunchState } from '../src/sim/flightState.js';
import type { FlightState } from '../src/sim/flightState.js';
import {
  adjustNode,
  burnDuration,
  circulariseAtApoapsis,
  emptyNode,
  evaluateNode,
  isEmpty,
  isExpired,
  nodeDeltaV,
  shiftNode,
  timeToBurn,
} from '../src/sim/maneuver.js';
import { elementsFromState } from '../src/sim/orbit.js';
import { PHYSICS_TIMESTEP, step } from '../src/sim/simulation.js';
import type { SimulationOptions } from '../src/sim/simulation.js';
import { Vec3 } from '../src/sim/vec3.js';

const TARGET = { orbitRadius: TERRIN.radius + 80_000 };

/** Options for a flight under player control. */
function manual(control: Partial<ControlInput>): SimulationOptions {
  return {
    target: TARGET,
    autopilotEnabled: false,
    control: { ...NEUTRAL_CONTROL, ...control },
  };
}

/** A vessel coasting in a circular orbit, for planning against. */
function inOrbit(radius = TERRIN.radius + 100_000): FlightState {
  const base = createPrelaunchState(TERRIN, createPathfinder());
  return {
    ...base,
    position: new Vec3(radius, 0, 0),
    velocity: new Vec3(0, Math.sqrt(TERRIN.mu / radius), 0),
    regime: 'coasting',
    rails: null,
  };
}

describe('the orbital reference frame', () => {
  it('points prograde along the velocity', () => {
    const frame = referenceFrame(new Vec3(1_000, 0, 0), new Vec3(0, 500, 0));
    expect(frame.prograde.distanceTo(new Vec3(0, 1, 0))).toBeLessThan(1e-9);
  });

  it('opposes prograde and retrograde exactly', () => {
    const frame = referenceFrame(new Vec3(700, 300, 100), new Vec3(-20, 400, 60));
    expect(frame.prograde.dot(frame.retrograde)).toBeCloseTo(-1, 9);
  });

  it('puts normal perpendicular to the orbital plane', () => {
    const frame = referenceFrame(new Vec3(1_000, 0, 0), new Vec3(0, 500, 0));

    expect(Math.abs(frame.normal.dot(frame.prograde))).toBeLessThan(1e-9);
    expect(Math.abs(frame.normal.dot(frame.radialOut))).toBeLessThan(1e-9);
  });

  it('points radial straight up from the body', () => {
    const frame = referenceFrame(new Vec3(0, 1_000, 0), new Vec3(300, 0, 0));
    expect(frame.radialOut.distanceTo(new Vec3(0, 1, 0))).toBeLessThan(1e-9);
  });
});

describe('hold modes', () => {
  const state = inOrbit();

  it('holds each named direction', () => {
    const modes: HoldMode[] = [
      'prograde',
      'retrograde',
      'radialOut',
      'radialIn',
      'normal',
      'antiNormal',
    ];

    const frame = referenceFrame(state.position, state.velocity);
    const expected: Record<string, Vec3> = {
      prograde: frame.prograde,
      retrograde: frame.retrograde,
      radialOut: frame.radialOut,
      radialIn: frame.radialIn,
      normal: frame.normal,
      antiNormal: frame.antiNormal,
    };

    for (const mode of modes) {
      const held = holdDirection(state, mode, null);
      expect(held, mode).not.toBeNull();
      expect(held!.distanceTo(expected[mode]!), mode).toBeLessThan(1e-9);
    }
  });

  it('leaves free flight to the player', () => {
    expect(holdDirection(state, 'free', null)).toBeNull();
  });

  it('points up on the pad rather than along the ground', () => {
    // Orbital prograde before there is an orbit points along the planet's
    // rotation, which would lay a waiting rocket on its side.
    const onPad = createPrelaunchState(TERRIN, createPathfinder());
    const held = holdDirection(onPad, 'prograde', null);

    expect(held!.dot(onPad.position.normalized())).toBeGreaterThan(0.99);
  });

  it('follows a planned burn in manoeuvre mode', () => {
    const burn = new Vec3(0, 0, 1);
    expect(holdDirection(state, 'maneuver', burn)!.distanceTo(burn)).toBeLessThan(1e-9);
  });

  it('falls back to free when there is no burn to follow', () => {
    expect(holdDirection(state, 'maneuver', null)).toBeNull();
  });

  it('knows what it can hold', () => {
    expect(canHold(state, 'prograde')).toBe(true);
    expect(canHold(state, 'free')).toBe(true);
  });

  it('names every mode for the HUD', () => {
    const modes: HoldMode[] = [
      'free', 'prograde', 'retrograde', 'radialOut',
      'radialIn', 'normal', 'antiNormal', 'maneuver',
    ];
    for (const mode of modes) expect(holdLabel(mode).length).toBeGreaterThan(2);
  });
});

describe('steering by hand', () => {
  const up = new Vec3(0, 1, 0);
  const forward = new Vec3(1, 0, 0);

  it('leaves the nose alone with no input', () => {
    const steered = steer(forward, up, NEUTRAL_CONTROL, 0.1);
    expect(steered.distanceTo(forward)).toBe(0);
  });

  it('swings the nose in the direction asked', () => {
    const pitched = steer(forward, up, { ...NEUTRAL_CONTROL, pitch: 1 }, 0.5);

    // Pitched up: still mostly forward, now with a component along up.
    expect(pitched.dot(up)).toBeGreaterThan(0);
    expect(pitched.dot(forward)).toBeGreaterThan(0.5);
  });

  it('pitches opposite ways for opposite input', () => {
    const upward = steer(forward, up, { ...NEUTRAL_CONTROL, pitch: 1 }, 0.5);
    const downward = steer(forward, up, { ...NEUTRAL_CONTROL, pitch: -1 }, 0.5);

    expect(Math.sign(upward.dot(up))).toBe(-Math.sign(downward.dot(up)));
  });

  it('keeps the command a unit vector', () => {
    let direction = forward;
    for (let i = 0; i < 200; i++) {
      direction = steer(direction, up, { ...NEUTRAL_CONTROL, pitch: 0.7, yaw: -0.3 }, 0.1);
      expect(direction.length).toBeCloseTo(1, 9);
    }
  });

  it('survives pointing straight along the up axis', () => {
    // The steering frame is degenerate there, and a naive cross product gives
    // a zero vector and then NaN.
    const steered = steer(up, up, { ...NEUTRAL_CONTROL, pitch: 1, yaw: 1 }, 0.1);

    expect(steered.isFinite).toBe(true);
    expect(steered.length).toBeCloseTo(1, 9);
  });
});

describe('flying by hand', () => {
  it('does nothing at all without input', () => {
    // The vessel must sit on the pad until told otherwise, not fly itself.
    let state = createPrelaunchState(TERRIN, createPathfinder());
    const startRadius = state.position.length;

    for (let i = 0; i < 400; i++) state = step(state, manual({}), PHYSICS_TIMESTEP).state;

    expect(state.throttle).toBe(0);
    expect(Math.abs(state.position.length - startRadius)).toBeLessThan(1);
    expect(state.vessel.stages.length).toBe(3);
  });

  it('lifts off when the player opens the throttle', () => {
    let state = createPrelaunchState(TERRIN, createPathfinder());
    const startRadius = state.position.length;

    const input = manual({ throttle: 1, hold: 'prograde' });
    for (let i = 0; i < 600; i++) state = step(state, input, PHYSICS_TIMESTEP).state;

    expect(state.position.length).toBeGreaterThan(startRadius + 100);
    expect(state.throttle).toBe(1);
  });

  it('stages only when asked', () => {
    let state = createPrelaunchState(TERRIN, createPathfinder());

    // Burn for a while without asking: still three stages, however empty.
    const burning = manual({ throttle: 1, hold: 'prograde' });
    for (let i = 0; i < 400; i++) state = step(state, burning, PHYSICS_TIMESTEP).state;
    expect(state.vessel.stages.length).toBe(3);

    // Now ask, once.
    state = step(state, manual({ throttle: 1, stageRequested: true }), PHYSICS_TIMESTEP).state;
    expect(state.vessel.stages.length).toBe(2);
  });

  it('reaches orbit under hand flying', () => {
    // A scripted pilot flying the same way a person does: straight up, tip the
    // nose over by hand, then let prograde carry the turn round, staging when
    // a tank runs dry and finishing the job near apoapsis. If this cannot make
    // orbit then neither can a player, whatever the autopilot manages.
    let state = createPrelaunchState(TERRIN, createPathfinder());
    let commanded: Vec3 | null = null;

    for (let i = 0; i < 200_000; i++) {
      const altitude = state.position.length - TERRIN.radius;
      const orbit = elementsFromState(state.position, state.velocity, TERRIN.mu);
      const dry = state.vessel.stages[0]!.propellant <= 0;
      const stageRequested = dry && state.vessel.stages.length > 1;

      let control: Partial<ControlInput>;

      if (altitude < 1_200) {
        // Straight up, hands off.
        control = { throttle: 1, hold: 'free', stageRequested };
      } else if (altitude < 9_000) {
        // Tip it east. Holding prograde from vertical never starts a turn,
        // which is exactly the mistake a new player makes.
        control = { throttle: 1, hold: 'free', pitch: -0.55, stageRequested };
      } else if (orbit.apoapsis < TARGET.orbitRadius) {
        control = { throttle: 1, hold: 'prograde', stageRequested };
      } else {
        // Apoapsis is high enough, so stop pushing it higher and coast up to
        // it. Burning prograde on the way up raises the far side further, not
        // the near one — the first version of this script did exactly that and
        // left on an escape trajectory at an eccentricity of 1.02, which still
        // passed a naive "periapsis above the atmosphere" check.
        //
        // The near side only rises from a burn at the far side, so wait until
        // the climb has flattened out and then push until periapsis is clear.
        const climbRate = state.velocity.dot(state.position.normalized());
        const atApoapsis = climbRate < 30;
        const done = orbit.periapsis > TERRIN.radius + TERRIN.atmosphere!.height + 4_000;

        control = {
          throttle: atApoapsis && !done ? 1 : 0,
          hold: 'prograde',
          stageRequested,
        };
      }

      const result = step(
        state,
        { ...manual(control), commandedDirection: commanded },
        PHYSICS_TIMESTEP,
      );

      state = result.state;
      commanded = result.command.targetDirection;

      // Closed, and clear of the air. Either alone is not an orbit: a
      // hyperbolic escape also has a periapsis above the atmosphere.
      if (
        orbit.isClosed &&
        orbit.periapsis > TERRIN.radius + TERRIN.atmosphere!.height
      ) {
        break;
      }
    }

    const orbit = elementsFromState(state.position, state.velocity, TERRIN.mu);
    expect(orbit.isClosed, 'closed orbit').toBe(true);
    expect(orbit.periapsis - TERRIN.radius, 'periapsis above the atmosphere')
      .toBeGreaterThan(TERRIN.atmosphere!.height);
  });
});

describe('manoeuvre nodes', () => {
  const state = inOrbit();

  it('starts empty', () => {
    const node = emptyNode(100);
    expect(isEmpty(node)).toBe(true);
    expect(nodeDeltaV(node)).toBe(0);
  });

  it('measures its own delta-v', () => {
    const node = { time: 0, prograde: 3, normal: 4, radial: 0 };
    expect(nodeDeltaV(node)).toBeCloseTo(5, 9);
  });

  it('adjusts one axis at a time', () => {
    const node = adjustNode(emptyNode(0), 'prograde', 120);
    expect(node.prograde).toBe(120);
    expect(node.normal).toBe(0);
  });

  it('shifts in time but never into the past', () => {
    expect(shiftNode({ time: 500, prograde: 0, normal: 0, radial: 0 }, 100, 0).time).toBe(600);
    expect(shiftNode({ time: 500, prograde: 0, normal: 0, radial: 0 }, -900, 100).time).toBe(100);
  });

  it('raises the opposite side of the orbit when burning prograde', () => {
    // The single most important fact about orbital mechanics, and the one a
    // planning tool has to get right or it teaches the wrong thing.
    const before = elementsFromState(state.position, state.velocity, TERRIN.mu);
    const node = { time: state.time, prograde: 200, normal: 0, radial: 0 };

    const evaluated = evaluateNode(node, state.position, state.velocity, TERRIN.mu, state.time);

    expect(evaluated).not.toBeNull();
    expect(evaluated!.resulting.apoapsis).toBeGreaterThan(before.apoapsis + 1_000);
    // And leaves the near side about where it was.
    expect(Math.abs(evaluated!.resulting.periapsis - before.periapsis)).toBeLessThan(1_000);
  });

  it('lowers the orbit when burning retrograde', () => {
    const before = elementsFromState(state.position, state.velocity, TERRIN.mu);
    const node = { time: state.time, prograde: -150, normal: 0, radial: 0 };

    const evaluated = evaluateNode(node, state.position, state.velocity, TERRIN.mu, state.time);
    expect(evaluated!.resulting.apoapsis).toBeLessThan(before.apoapsis);
  });

  it('tilts the plane when burning normal', () => {
    const before = elementsFromState(state.position, state.velocity, TERRIN.mu);
    const node = { time: state.time, prograde: 0, normal: 400, radial: 0 };

    const evaluated = evaluateNode(node, state.position, state.velocity, TERRIN.mu, state.time);
    expect(evaluated!.resulting.inclination).toBeGreaterThan(before.inclination + 0.05);
  });

  it('points the burn where the axes say', () => {
    const node = { time: state.time, prograde: 100, normal: 0, radial: 0 };
    const evaluated = evaluateNode(node, state.position, state.velocity, TERRIN.mu, state.time)!;

    const frame = referenceFrame(state.position, state.velocity);
    expect(evaluated.burn.normalized().distanceTo(frame.prograde)).toBeLessThan(1e-9);
  });

  it('evaluates a node in the future, not just now', () => {
    const later = { time: state.time + 600, prograde: 100, normal: 0, radial: 0 };
    const evaluated = evaluateNode(later, state.position, state.velocity, TERRIN.mu, state.time)!;

    // The vessel has moved round its orbit by then.
    expect(evaluated.position.distanceTo(state.position)).toBeGreaterThan(1_000);
  });

  it('declines to plan on an escape trajectory', () => {
    const radius = TERRIN.radius + 100_000;
    const escaping = new Vec3(0, Math.sqrt((2 * TERRIN.mu) / radius) * 1.2, 0);

    expect(
      evaluateNode(emptyNode(0), new Vec3(radius, 0, 0), escaping, TERRIN.mu, 0),
    ).toBeNull();
  });
});

describe('planning a circularisation', () => {
  it('produces a node that actually circularises', () => {
    // An eccentric orbit, and the node that should round it off.
    const periapsis = TERRIN.radius + 90_000;
    const apoapsis = TERRIN.radius + 400_000;
    const a = (periapsis + apoapsis) / 2;

    const position = new Vec3(periapsis, 0, 0);
    const velocity = new Vec3(0, Math.sqrt(TERRIN.mu * (2 / periapsis - 1 / a)), 0);

    const node = circulariseAtApoapsis(position, velocity, TERRIN.mu, 0);
    expect(node).not.toBeNull();
    expect(node!.prograde).toBeGreaterThan(0);

    const evaluated = evaluateNode(node!, position, velocity, TERRIN.mu, 0)!;
    expect(evaluated.resulting.eccentricity).toBeLessThan(0.01);
  });

  it('times the node for apoapsis', () => {
    const periapsis = TERRIN.radius + 90_000;
    const a = TERRIN.radius + 245_000;

    const position = new Vec3(periapsis, 0, 0);
    const velocity = new Vec3(0, Math.sqrt(TERRIN.mu * (2 / periapsis - 1 / a)), 0);

    const orbit = elementsFromState(position, velocity, TERRIN.mu);
    const node = circulariseAtApoapsis(position, velocity, TERRIN.mu, 0)!;

    // Starting at periapsis, apoapsis is half a period away.
    expect(node.time).toBeCloseTo(orbit.period / 2, -1);
  });
});

describe('burn timing', () => {
  it('takes longer for more delta-v', () => {
    const small = burnDuration(50, 60_000, 3_000, 3_400);
    const large = burnDuration(200, 60_000, 3_000, 3_400);

    expect(large).toBeGreaterThan(small);
  });

  it('takes no time for no burn', () => {
    expect(burnDuration(0, 60_000, 3_000, 3_400)).toBe(0);
  });

  it('starts the burn early so it straddles the node', () => {
    // A burn applied entirely after its planned moment lands the vessel
    // somewhere other than the map promised.
    const node = { time: 1_000, prograde: 100, normal: 0, radial: 0 };
    expect(timeToBurn(node, 0, 60)).toBe(970);
  });

  it('knows when a node has been flown past', () => {
    const node = { time: 100, prograde: 50, normal: 0, radial: 0 };

    expect(isExpired(node, 50, 20)).toBe(false);
    expect(isExpired(node, 200, 20)).toBe(true);
  });
});

describe('planning a transfer to the moon', () => {
  it('raises apoapsis to Lunara from a parking orbit', () => {
    // What the player is actually trying to do: a node that puts the far side
    // of the orbit out at the moon's distance.
    const state = inOrbit(TERRIN.radius + 80_000);

    const moonRadius = LUNARA.orbit!.semiMajorAxis;
    const r = state.position.length;
    const transferAxis = (r + moonRadius) / 2;

    const needed =
      Math.sqrt(TERRIN.mu * (2 / r - 1 / transferAxis)) - Math.sqrt(TERRIN.mu / r);

    const node = { time: state.time, prograde: needed, normal: 0, radial: 0 };
    const evaluated = evaluateNode(node, state.position, state.velocity, TERRIN.mu, state.time)!;

    // Within a percent of the moon's orbit, which is close enough for the
    // moon's own gravity to do the rest.
    expect(Math.abs(evaluated.resulting.apoapsis - moonRadius) / moonRadius).toBeLessThan(0.01);
  });
});

describe('planning and flying a burn', () => {
  it('reaches the orbit the node predicted', () => {
    // The whole promise of a planning tool: what the map showed is what the
    // vessel gets. Flown for real rather than evaluated, so the finite burn
    // time is in the answer.
    let state = inOrbit(TERRIN.radius + 90_000);

    const radius = state.position.length;
    const moonRadius = LUNARA.orbit!.semiMajorAxis;
    const transferAxis = (radius + moonRadius) / 2;

    // Against the actual speed, not an assumed circular one.
    const needed =
      Math.sqrt(TERRIN.mu * (2 / radius - 1 / transferAxis)) - state.velocity.length;

    const node = { time: state.time + 5, prograde: needed, normal: 0, radial: 0 };
    const predicted = evaluateNode(
      node,
      state.position,
      state.velocity,
      TERRIN.mu,
      state.time,
    )!;

    // The plan should put the far side of the orbit at the moon.
    expect(Math.abs(predicted.resulting.apoapsis - moonRadius) / moonRadius)
      .toBeLessThan(0.02);

    // Now fly it, holding the node and cutting off when the delta-v is spent.
    const startSpeed = state.velocity.length;
    let commanded: Vec3 | null = null;

    for (let i = 0; i < 200_000; i++) {
      const spent = Math.abs(state.velocity.length - startSpeed);
      const burning = spent < nodeDeltaV(node) && state.time >= node.time - 1;

      const result = step(
        state,
        {
          target: TARGET,
          autopilotEnabled: false,
          control: { ...NEUTRAL_CONTROL, throttle: burning ? 1 : 0, hold: 'maneuver' },
          maneuver: node,
          commandedDirection: commanded,
        },
        PHYSICS_TIMESTEP,
      );

      state = result.state;
      commanded = result.command.targetDirection;

      if (!burning && state.time > node.time + 2) break;
    }

    const achieved = elementsFromState(state.position, state.velocity, TERRIN.mu);

    // Within a few percent of the plan. The shortfall is the burn taking time
    // rather than happening at an instant, which is real and is why a pilot
    // starts a burn before the node rather than at it.
    const error =
      Math.abs(achieved.apoapsis - predicted.resulting.apoapsis) /
      predicted.resulting.apoapsis;

    expect(error, 'achieved versus planned apoapsis').toBeLessThan(0.06);
    expect(achieved.apoapsis).toBeGreaterThan(radius * 10);
  });
});
