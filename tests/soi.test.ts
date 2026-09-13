/**
 * Sphere-of-influence and ephemeris tests.
 *
 * The load-bearing property is continuity: re-parenting a vessel between
 * frames describes the same physical trajectory from a different origin, so it
 * must not change the vessel's actual motion. An error here is a free velocity
 * change at every boundary crossing.
 */
import { describe, expect, it } from 'vitest';
import {
  bodyStateAt,
  chainToRoot,
  orbitalPeriod,
  relativePosition,
  transformFrame,
} from '../src/bodies/ephemeris.js';
import { LUNARA, TERRIN, childrenOf, parentOf, rootBody } from '../src/bodies/system.js';
import { sphereOfInfluence } from '../src/bodies/types.js';
import {
  distanceToNearestBoundary,
  dominantBody,
  reframe,
  resolveSoi,
} from '../src/sim/soi.js';
import { Vec3 } from '../src/sim/vec3.js';

describe('system structure', () => {
  it('makes Terrin the root and Lunara its child', () => {
    expect(rootBody().id).toBe('terrin');
    expect(parentOf(LUNARA)?.id).toBe('terrin');
    expect(parentOf(TERRIN)).toBeNull();
    expect(childrenOf('terrin').map((b) => b.id)).toEqual(['lunara']);
  });

  it('gives the root an unbounded sphere of influence', () => {
    expect(TERRIN.soiRadius).toBe(Infinity);
  });

  it('computes Lunara’s SOI from the mass ratio', () => {
    const expected = sphereOfInfluence(12_000_000, LUNARA.mu, TERRIN.mu);
    expect(LUNARA.soiRadius).toBeCloseTo(expected, 6);
    // Sanity: comfortably larger than the moon, far smaller than its orbit.
    expect(LUNARA.soiRadius).toBeGreaterThan(LUNARA.radius * 5);
    expect(LUNARA.soiRadius).toBeLessThan(12_000_000 / 3);
  });

  it('matches the reference SOI radius to within a kilometre', () => {
    expect(Math.abs(LUNARA.soiRadius - 2_429_559)).toBeLessThan(5_000);
  });
});

describe('ephemeris', () => {
  it('keeps Lunara on a circular orbit', () => {
    const period = orbitalPeriod(LUNARA);

    for (const fraction of [0, 0.17, 0.4, 0.63, 0.95]) {
      const state = bodyStateAt(LUNARA, period * fraction);
      expect(state.position.length).toBeCloseTo(12_000_000, 3);
    }
  });

  it('returns Lunara to its starting point after one period', () => {
    const period = orbitalPeriod(LUNARA);
    const start = bodyStateAt(LUNARA, 0);
    const later = bodyStateAt(LUNARA, period);

    expect(later.position.distanceTo(start.position)).toBeLessThan(1);
  });

  it('gives Lunara the correct circular orbital speed', () => {
    const expected = Math.sqrt(TERRIN.mu / 12_000_000);
    expect(bodyStateAt(LUNARA, 0).velocity.length).toBeCloseTo(expected, 6);
  });

  it('leaves the root body at rest at the origin', () => {
    const state = bodyStateAt(TERRIN, 12_345);
    expect(state.position.length).toBe(0);
    expect(state.velocity.length).toBe(0);
    expect(chainToRoot(TERRIN, 12_345).position.length).toBe(0);
  });

  it('reports Lunara’s position relative to Terrin', () => {
    const offset = relativePosition(TERRIN, LUNARA, 5_000);
    expect(offset.length).toBeCloseTo(12_000_000, 3);
  });
});

describe('frame transforms', () => {
  it('round-trips a state through both frames unchanged', () => {
    const time = 4_321;
    const position = new Vec3(900_000, 120_000, 0);
    const velocity = new Vec3(-150, 2_100, 30);

    const toMoon = transformFrame(position, velocity, TERRIN, LUNARA, time);
    const back = transformFrame(toMoon.position, toMoon.velocity, LUNARA, TERRIN, time);

    expect(back.position.distanceTo(position)).toBeLessThan(1e-6);
    expect(back.velocity.distanceTo(velocity)).toBeLessThan(1e-9);
  });

  it('is a no-op between identical frames', () => {
    const position = new Vec3(1, 2, 3);
    const velocity = new Vec3(4, 5, 6);
    const same = transformFrame(position, velocity, TERRIN, TERRIN, 99);

    expect(same.position).toBe(position);
    expect(same.velocity).toBe(velocity);
  });

  it('offsets a state by exactly the relative body state', () => {
    const time = 777;
    const moon = bodyStateAt(LUNARA, time);

    // A vessel sitting exactly at Lunara's centre in Terrin's frame should be
    // at the origin once expressed in Lunara's frame.
    const reframed = transformFrame(moon.position, moon.velocity, TERRIN, LUNARA, time);

    expect(reframed.position.length).toBeLessThan(1e-6);
    expect(reframed.velocity.length).toBeLessThan(1e-9);
  });
});

describe('dominantBody', () => {
  it('keeps a low-orbit vessel with Terrin', () => {
    const position = new Vec3(TERRIN.radius + 100_000, 0, 0);
    expect(dominantBody(TERRIN, position, 0).id).toBe('terrin');
  });

  it('hands a vessel near Lunara over to the moon', () => {
    const time = 0;
    const moon = relativePosition(TERRIN, LUNARA, time);
    // Half an SOI radius out from the moon's centre.
    const position = moon.add(new Vec3(LUNARA.soiRadius * 0.5, 0, 0));

    expect(dominantBody(TERRIN, position, time).id).toBe('lunara');
  });

  it('leaves a vessel just outside the moon’s SOI with Terrin', () => {
    const time = 0;
    const moon = relativePosition(TERRIN, LUNARA, time);
    const position = moon.add(new Vec3(LUNARA.soiRadius * 1.05, 0, 0));

    expect(dominantBody(TERRIN, position, time).id).toBe('terrin');
  });

  it('returns a vessel leaving Lunara’s SOI to Terrin', () => {
    const position = new Vec3(LUNARA.soiRadius * 1.2, 0, 0);
    expect(dominantBody(LUNARA, position, 0).id).toBe('terrin');
  });

  it('keeps a vessel just inside Lunara’s SOI with the moon', () => {
    const position = new Vec3(LUNARA.soiRadius * 0.99, 0, 0);
    expect(dominantBody(LUNARA, position, 0).id).toBe('lunara');
  });
});

describe('re-parenting continuity', () => {
  it('does not change the trajectory when entering Lunara’s SOI', () => {
    const time = 1_000;
    const moon = bodyStateAt(LUNARA, time);

    // A vessel on the SOI boundary, moving in Terrin's frame.
    const position = moon.position.add(new Vec3(LUNARA.soiRadius, 0, 0));
    const velocity = new Vec3(100, 900, 0);

    const reframed = reframe({ body: TERRIN, position, velocity }, LUNARA, time);

    // Its position relative to the moon must be exactly the SOI radius, and
    // its velocity relative to the moon the difference of the two.
    expect(reframed.position.length).toBeCloseTo(LUNARA.soiRadius, 6);
    expect(reframed.velocity.distanceTo(velocity.sub(moon.velocity))).toBeLessThan(1e-9);
  });

  it('conserves absolute position across a frame change', () => {
    const time = 2_500;
    const position = new Vec3(11_000_000, 1_500_000, 0);
    const velocity = new Vec3(-400, 800, 0);

    const inMoonFrame = reframe({ body: TERRIN, position, velocity }, LUNARA, time);
    const backToTerrin = reframe(inMoonFrame, TERRIN, time);

    expect(backToTerrin.position.distanceTo(position)).toBeLessThan(1e-6);
    expect(backToTerrin.velocity.distanceTo(velocity)).toBeLessThan(1e-9);
  });

  it('resolves straight to the innermost dominant body', () => {
    const time = 0;
    const moon = relativePosition(TERRIN, LUNARA, time);
    const position = moon.add(new Vec3(LUNARA.soiRadius * 0.3, 0, 0));

    const resolved = resolveSoi(
      { body: TERRIN, position, velocity: new Vec3(0, 900, 0) },
      time,
    );

    expect(resolved.body.id).toBe('lunara');
    expect(resolved.position.length).toBeCloseTo(LUNARA.soiRadius * 0.3, 3);
  });

  it('leaves a state alone when no boundary was crossed', () => {
    const state = {
      body: TERRIN,
      position: new Vec3(TERRIN.radius + 200_000, 0, 0),
      velocity: new Vec3(0, 2_200, 0),
    };

    expect(resolveSoi(state, 0)).toBe(state);
  });
});

describe('distanceToNearestBoundary', () => {
  it('is the gap to the moon’s SOI for a vessel in low orbit', () => {
    const time = 0;
    const position = new Vec3(TERRIN.radius + 100_000, 0, 0);
    const moon = relativePosition(TERRIN, LUNARA, time);

    const expected = Math.abs(position.sub(moon).length - LUNARA.soiRadius);
    expect(distanceToNearestBoundary({ body: TERRIN, position, velocity: Vec3.ZERO }, time))
      .toBeCloseTo(expected, 3);
  });

  it('is the gap to the SOI edge for a vessel inside Lunara', () => {
    const position = new Vec3(LUNARA.soiRadius * 0.25, 0, 0);
    const distance = distanceToNearestBoundary(
      { body: LUNARA, position, velocity: Vec3.ZERO },
      0,
    );

    expect(distance).toBeCloseTo(LUNARA.soiRadius * 0.75, 3);
  });
});
