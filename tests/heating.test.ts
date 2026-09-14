/**
 * Aerodynamic heating tests.
 *
 * The question that matters is not whether the arithmetic is right but whether
 * a reentry behaves: survivable behind a shield, fatal without one, and
 * harmless at ascent speeds. So most of this flies actual descents through the
 * real atmosphere model rather than checking formulas in isolation.
 */
import { describe, expect, it } from 'vitest';
import { TERRIN } from '../src/bodies/system.js';
import { densityAt } from '../src/sim/atmosphere.js';
import {
  AMBIENT_THERMAL,
  STRUCTURAL_LIMIT,
  equilibriumTemperature,
  glowColour,
  glowIntensity,
  hasBurnedUp,
  heatingConditions,
  stagnationFlux,
  stepHeating,
} from '../src/sim/heating.js';
import type { ThermalState } from '../src/sim/heating.js';
import { Vec3 } from '../src/sim/vec3.js';
import { createPathfinder } from '../src/parts/testVehicle.js';
import { createPrelaunchState } from '../src/sim/flightState.js';
import { PHYSICS_TIMESTEP, step } from '../src/sim/simulation.js';

/** A blunt capsule, and a slender booster for comparison. */
const CAPSULE_NOSE = 1.2;
const SLENDER_NOSE = 0.15;

/**
 * Fly a descent and report the worst it got.
 *
 * Straight down at a fixed speed is not a real trajectory, but it is a far
 * harsher one than any real entry — a real vehicle decelerates high up where
 * the air is thin, which is the whole point of the profile.
 */
function descend(options: {
  readonly speed: number;
  readonly noseRadius: number;
  readonly shield: number;
  readonly fromAltitude?: number;
}): { peakFlux: number; peakTemperature: number; thermal: ThermalState } {
  let thermal: ThermalState = { ...AMBIENT_THERMAL, shield: options.shield };
  let peakFlux = 0;
  let peakTemperature = 0;

  const from = options.fromAltitude ?? 70_000;
  const dt = 0.1;

  for (let altitude = from; altitude > 0; altitude -= options.speed * dt) {
    const density = densityAt(TERRIN, altitude);
    const flux = stagnationFlux(density, options.speed, options.noseRadius);

    const step = stepHeating(thermal, flux, dt);
    thermal = step.thermal;

    peakFlux = Math.max(peakFlux, flux);
    peakTemperature = Math.max(peakTemperature, thermal.temperature);
  }

  return { peakFlux, peakTemperature, thermal };
}

describe('stagnation heating', () => {
  it('is zero in vacuum and at rest', () => {
    expect(stagnationFlux(0, 7_000, CAPSULE_NOSE)).toBe(0);
    expect(stagnationFlux(1.2, 0, CAPSULE_NOSE)).toBe(0);
  });

  it('grows as the cube of speed', () => {
    // Which is why the first kilometre per second of a descent matters more
    // than all the rest of it.
    const slow = stagnationFlux(0.01, 1_000, CAPSULE_NOSE);
    const fast = stagnationFlux(0.01, 2_000, CAPSULE_NOSE);

    expect(fast / slow).toBeCloseTo(8, 6);
  });

  it('grows as the square root of density', () => {
    const thin = stagnationFlux(0.001, 5_000, CAPSULE_NOSE);
    const thick = stagnationFlux(0.004, 5_000, CAPSULE_NOSE);

    expect(thick / thin).toBeCloseTo(2, 6);
  });

  it('punishes a sharp nose', () => {
    // Blunt bodies survive reentry and sharp ones do not, and this is why:
    // heating goes as the inverse square root of the radius of curvature.
    const blunt = stagnationFlux(0.02, 6_000, CAPSULE_NOSE);
    const sharp = stagnationFlux(0.02, 6_000, SLENDER_NOSE);

    expect(sharp).toBeGreaterThan(blunt * 2.5);
  });

  it('reads conditions from a real flight state', () => {
    const position = new Vec3(TERRIN.radius + 40_000, 0, 0);
    const velocity = new Vec3(-2_000, 1_000, 0);

    const conditions = heatingConditions(TERRIN, position, velocity, CAPSULE_NOSE);

    expect(conditions.density).toBeGreaterThan(0);
    expect(conditions.airspeed).toBeGreaterThan(1_000);
    expect(conditions.flux).toBeGreaterThan(0);
  });

  it('reports nothing in vacuum above the atmosphere', () => {
    const conditions = heatingConditions(
      TERRIN,
      new Vec3(TERRIN.radius + 120_000, 0, 0),
      new Vec3(0, 3_000, 0),
      CAPSULE_NOSE,
    );

    expect(conditions.density).toBe(0);
    expect(conditions.flux).toBe(0);
  });
});

describe('thermal equilibrium', () => {
  it('sits at ambient with no heating', () => {
    expect(equilibriumTemperature(0)).toBe(AMBIENT_THERMAL.temperature);
  });

  it('rises as the fourth root of flux', () => {
    // Sixteen times the heat for twice the temperature, which is what gives a
    // vehicle an equilibrium rather than an accumulation.
    const low = equilibriumTemperature(1e5);
    const high = equilibriumTemperature(16e5);

    expect(high / low).toBeCloseTo(2, 2);
  });

  it('cools towards ambient once the heating stops', () => {
    let thermal: ThermalState = { temperature: 1_400, shield: 1 };

    for (let i = 0; i < 2_000; i++) thermal = stepHeating(thermal, 0, 1).thermal;

    expect(thermal.temperature).toBeLessThan(350);
    expect(thermal.temperature).toBeGreaterThanOrEqual(AMBIENT_THERMAL.temperature);
  });

  it('never falls below ambient', () => {
    let thermal: ThermalState = AMBIENT_THERMAL;
    for (let i = 0; i < 500; i++) thermal = stepHeating(thermal, 0, 5).thermal;

    expect(thermal.temperature).toBe(AMBIENT_THERMAL.temperature);
  });

  it('does not overshoot equilibrium on a long step', () => {
    // A step long enough to jump past the balance point must settle at it
    // rather than oscillate, or time warp makes vehicles explode.
    //
    // Flown without a shield, because a shield absorbs most of the flux and
    // the skin then settles at the equilibrium of what got through it — which
    // is correct behaviour and a different thing from the one being tested.
    const flux = 5e5;
    const target = equilibriumTemperature(flux);

    let thermal: ThermalState = { temperature: AMBIENT_THERMAL.temperature, shield: 0 };
    for (let i = 0; i < 40; i++) thermal = stepHeating(thermal, flux, 30).thermal;

    expect(thermal.temperature).toBeLessThanOrEqual(target * 1.01);
    expect(thermal.temperature).toBeGreaterThan(target * 0.9);
  });
});

describe('the heat shield', () => {
  it('is untouched by gentle heating', () => {
    const { thermal } = descend({ speed: 400, noseRadius: CAPSULE_NOSE, shield: 1 });
    expect(thermal.shield).toBe(1);
  });

  it('ablates under a real entry', () => {
    const { thermal } = descend({ speed: 2_400, noseRadius: CAPSULE_NOSE, shield: 1 });

    expect(thermal.shield).toBeLessThan(1);
    expect(thermal.shield).toBeGreaterThan(0);
  });

  it('keeps the skin below structural limits while it lasts', () => {
    // The whole point: an orbital entry behind a shield is survivable.
    const { peakTemperature, thermal } = descend({
      speed: 2_400,
      noseRadius: CAPSULE_NOSE,
      shield: 1,
    });

    expect(thermal.shield).toBeGreaterThan(0);
    expect(peakTemperature).toBeLessThan(STRUCTURAL_LIMIT);
  });

  it('leaves the vehicle to burn without one', () => {
    // And the complement, or the shield is decoration.
    const { peakTemperature } = descend({
      speed: 2_400,
      noseRadius: CAPSULE_NOSE,
      shield: 0,
    });

    expect(peakTemperature).toBeGreaterThan(STRUCTURAL_LIMIT);
    expect(hasBurnedUp({ temperature: peakTemperature, shield: 0 })).toBe(true);
  });

  it('cannot ablate below nothing', () => {
    let thermal: ThermalState = { temperature: 300, shield: 0.01 };
    for (let i = 0; i < 400; i++) thermal = stepHeating(thermal, 4e6, 1).thermal;

    expect(thermal.shield).toBe(0);
  });

  it('spends more shield on a faster entry', () => {
    const slower = descend({ speed: 1_800, noseRadius: CAPSULE_NOSE, shield: 1 });
    const faster = descend({ speed: 2_600, noseRadius: CAPSULE_NOSE, shield: 1 });

    expect(faster.thermal.shield).toBeLessThan(slower.thermal.shield);
  });
});

describe('ascent is not a reentry', () => {
  it('leaves a climbing rocket cool', () => {
    // A launch passes through the same air at similar speeds, but high up
    // where it is thin — heating must not make ascent unflyable.
    let thermal: ThermalState = AMBIENT_THERMAL;
    let peak = 0;

    // Roughly the Pathfinder ascent: speed rising as altitude does.
    for (let altitude = 0; altitude < 70_000; altitude += 100) {
      const speed = 100 + (altitude / 70_000) * 2_200;
      const flux = stagnationFlux(densityAt(TERRIN, altitude), speed, 0.6);

      thermal = stepHeating(thermal, flux, 100 / Math.max(1, speed)).thermal;
      peak = Math.max(peak, thermal.temperature);
    }

    expect(peak).toBeLessThan(STRUCTURAL_LIMIT);
  });
});

describe('how it looks', () => {
  it('does not glow when cool', () => {
    expect(glowIntensity(300)).toBe(0);
    expect(glowIntensity(800)).toBe(0);
  });

  it('brightens with temperature', () => {
    let previous = -1;
    for (const temperature of [1_000, 1_200, 1_500, 2_000, 2_600]) {
      const glow = glowIntensity(temperature);
      expect(glow).toBeGreaterThan(previous);
      previous = glow;
    }
    expect(previous).toBeLessThanOrEqual(1);
  });

  it('runs red through orange to white', () => {
    const dull = glowColour(1_000);
    const hot = glowColour(2_300);

    // Dull red: red dominant, little else.
    expect(dull[0]).toBeGreaterThan(dull[1] * 3);

    // White-hot: all three channels high and close together.
    expect(Math.min(...hot)).toBeGreaterThan(0.5);
    expect(Math.max(...hot) - Math.min(...hot)).toBeLessThan(0.45);
  });

  it('keeps colour in range at any temperature', () => {
    for (const temperature of [0, 500, 1_500, 3_000, 10_000]) {
      for (const channel of glowColour(temperature)) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('heating through a whole flight', () => {
  const OPTIONS = {
    target: { orbitRadius: TERRIN.radius + 80_000 },
    autopilotEnabled: true,
  };

  it('leaves an ascent cold and its shield intact', () => {
    // A launch crosses the same air a reentry does, at comparable speeds. If
    // heating made ascent dangerous the game would be unplayable, and the
    // reason it does not is that a rocket is slow while the air is thick.
    let state = createPrelaunchState(TERRIN, createPathfinder());
    let peak = 0;

    for (let i = 0; i < 40_000; i++) {
      const result = step(state, OPTIONS, PHYSICS_TIMESTEP);
      state = result.state;
      peak = Math.max(peak, state.thermal.temperature);
      if (result.command.phase === 'complete') break;
    }

    expect(peak).toBeLessThan(600);
    expect(state.thermal.shield).toBe(1);
  });

  it('heats a descent enough to glow, and survives it', () => {
    // Dropped out of orbit at well below circular speed: a steep entry, which
    // is harsher than any a player would fly deliberately.
    let state = createPrelaunchState(TERRIN, createPathfinder());
    for (let i = 0; i < 40_000; i++) {
      const result = step(state, OPTIONS, PHYSICS_TIMESTEP);
      state = result.state;
      if (result.command.phase === 'complete') break;
    }

    const speed = Math.sqrt(TERRIN.mu / state.position.length) * 0.72;
    state = {
      ...state,
      velocity: state.position
        .normalized()
        .cross(new Vec3(0, 0, 1))
        .normalized()
        .scale(speed),
      thermal: AMBIENT_THERMAL,
      throttle: 0,
      rails: null,
      regime: 'coasting',
    };

    const coasting = { ...OPTIONS, autopilotEnabled: false };
    let peak = 0;
    let glowed = false;

    for (let i = 0; i < 400_000; i++) {
      state = step(state, coasting, PHYSICS_TIMESTEP).state;
      peak = Math.max(peak, state.thermal.temperature);
      if (glowIntensity(state.thermal.temperature) > 0) glowed = true;
      if (state.position.length - TERRIN.radius < 500) break;
    }

    // Visibly hot, and still in one piece behind its shield.
    expect(glowed).toBe(true);
    expect(peak).toBeGreaterThan(1_000);
    expect(peak).toBeLessThan(STRUCTURAL_LIMIT);
    expect(state.thermal.shield).toBeGreaterThan(0);
  });
});
