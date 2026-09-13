/**
 * Orbital mechanics unit tests.
 *
 * These cover the round-trip identities and conservation laws that the whole
 * simulation rests on. If these break, nothing above them can be trusted.
 */
import { describe, expect, it } from 'vitest';
import { TERRIN } from '../src/bodies/system.js';
import {
  eccentricFromTrue,
  elementsFromState,
  normalizeAngle,
  propagate,
  solveKepler,
  stateFromElements,
  timeToApoapsis,
  trueFromEccentric,
} from '../src/sim/orbit.js';
import { Vec3 } from '../src/sim/vec3.js';

const MU = TERRIN.mu;

describe('solveKepler', () => {
  it('satisfies Kepler’s equation across the eccentricity range', () => {
    const eccentricities = [0, 0.1, 0.5, 0.8, 0.95, 0.99];
    const meanAnomalies = [0, 0.5, 1.5, Math.PI, 4.2, 6.0];

    for (const e of eccentricities) {
      for (const m of meanAnomalies) {
        const eccentric = solveKepler(m, e);
        const recovered = eccentric - e * Math.sin(eccentric);
        expect(normalizeAngle(recovered)).toBeCloseTo(normalizeAngle(m), 9);
      }
    }
  });

  it('returns zero for a zero mean anomaly', () => {
    expect(solveKepler(0, 0.3)).toBeCloseTo(0, 12);
  });
});

describe('anomaly conversions', () => {
  it('round-trips true -> eccentric -> true', () => {
    for (const e of [0, 0.2, 0.7, 0.9]) {
      for (const nu of [0.1, 1.0, 2.5, 4.0, 5.9]) {
        const eccentric = eccentricFromTrue(nu, e);
        expect(normalizeAngle(trueFromEccentric(eccentric, e))).toBeCloseTo(nu, 9);
      }
    }
  });
});

describe('elementsFromState / stateFromElements', () => {
  it('round-trips a circular equatorial orbit', () => {
    const radius = TERRIN.radius + 100_000;
    const speed = Math.sqrt(MU / radius);
    const position = new Vec3(radius, 0, 0);
    const velocity = new Vec3(0, speed, 0);

    const elements = elementsFromState(position, velocity, MU);

    expect(elements.eccentricity).toBeCloseTo(0, 9);
    expect(elements.semiMajorAxis).toBeCloseTo(radius, 3);
    expect(elements.apoapsis).toBeCloseTo(radius, 3);
    expect(elements.periapsis).toBeCloseTo(radius, 3);
    expect(elements.inclination).toBeCloseTo(0, 9);
    expect(elements.isClosed).toBe(true);
  });

  it('round-trips an inclined elliptical orbit', () => {
    const position = new Vec3(700_000, 120_000, 260_000);
    const velocity = new Vec3(-400, 1_900, 350);

    const elements = elementsFromState(position, velocity, MU);
    const rebuilt = stateFromElements(elements, MU);

    expect(rebuilt.position.x).toBeCloseTo(position.x, 3);
    expect(rebuilt.position.y).toBeCloseTo(position.y, 3);
    expect(rebuilt.position.z).toBeCloseTo(position.z, 3);
    expect(rebuilt.velocity.x).toBeCloseTo(velocity.x, 6);
    expect(rebuilt.velocity.y).toBeCloseTo(velocity.y, 6);
    expect(rebuilt.velocity.z).toBeCloseTo(velocity.z, 6);
  });

  it('identifies a hyperbolic trajectory as not closed', () => {
    const radius = TERRIN.radius + 100_000;
    const escapeSpeed = Math.sqrt((2 * MU) / radius);
    const elements = elementsFromState(
      new Vec3(radius, 0, 0),
      new Vec3(0, escapeSpeed * 1.2, 0),
      MU,
    );

    expect(elements.eccentricity).toBeGreaterThan(1);
    expect(elements.isClosed).toBe(false);
    expect(elements.apoapsis).toBe(Infinity);
    expect(elements.period).toBe(Infinity);
  });

  it('computes apoapsis and periapsis of a known ellipse', () => {
    // Periapsis at 700 km radius, apoapsis at 900 km radius.
    const periapsis = 700_000;
    const apoapsis = 900_000;
    const a = (periapsis + apoapsis) / 2;
    // Vis-viva at periapsis.
    const speed = Math.sqrt(MU * (2 / periapsis - 1 / a));

    const elements = elementsFromState(
      new Vec3(periapsis, 0, 0),
      new Vec3(0, speed, 0),
      MU,
    );

    expect(elements.periapsis).toBeCloseTo(periapsis, 3);
    expect(elements.apoapsis).toBeCloseTo(apoapsis, 3);
  });
});

describe('propagate', () => {
  it('returns to the same state after exactly one period', () => {
    const position = new Vec3(750_000, 0, 0);
    const velocity = new Vec3(0, 2_000, 300);
    const elements = elementsFromState(position, velocity, MU);

    const advanced = propagate(elements, MU, elements.period);

    expect(normalizeAngle(advanced.trueAnomaly)).toBeCloseTo(
      normalizeAngle(elements.trueAnomaly),
      6,
    );
  });

  it('reaches apoapsis after half a period from periapsis', () => {
    const periapsis = 700_000;
    const a = 800_000;
    const speed = Math.sqrt(MU * (2 / periapsis - 1 / a));
    const elements = elementsFromState(
      new Vec3(periapsis, 0, 0),
      new Vec3(0, speed, 0),
      MU,
    );

    const advanced = propagate(elements, MU, elements.period / 2);

    expect(normalizeAngle(advanced.trueAnomaly)).toBeCloseTo(Math.PI, 6);
  });

  it('conserves orbit shape while propagating', () => {
    const elements = elementsFromState(
      new Vec3(800_000, 100_000, 0),
      new Vec3(-200, 2_100, 0),
      MU,
    );

    const advanced = propagate(elements, MU, 1_234);

    expect(advanced.semiMajorAxis).toBeCloseTo(elements.semiMajorAxis, 6);
    expect(advanced.eccentricity).toBeCloseTo(elements.eccentricity, 12);
    expect(advanced.inclination).toBeCloseTo(elements.inclination, 12);
  });

  it('rejects propagation of an unbound trajectory', () => {
    const radius = TERRIN.radius + 100_000;
    const escapeSpeed = Math.sqrt((2 * MU) / radius);
    const elements = elementsFromState(
      new Vec3(radius, 0, 0),
      new Vec3(0, escapeSpeed * 1.2, 0),
      MU,
    );

    expect(() => propagate(elements, MU, 10)).toThrow(/closed orbits only/);
  });
});

describe('timeToApoapsis', () => {
  it('is half a period when starting at periapsis', () => {
    const periapsis = 700_000;
    const a = 800_000;
    const speed = Math.sqrt(MU * (2 / periapsis - 1 / a));
    const elements = elementsFromState(
      new Vec3(periapsis, 0, 0),
      new Vec3(0, speed, 0),
      MU,
    );

    expect(timeToApoapsis(elements, MU)).toBeCloseTo(elements.period / 2, 3);
  });

  it('is infinite for an unbound trajectory', () => {
    const radius = TERRIN.radius + 100_000;
    const escapeSpeed = Math.sqrt((2 * MU) / radius);
    const elements = elementsFromState(
      new Vec3(radius, 0, 0),
      new Vec3(0, escapeSpeed * 1.5, 0),
      MU,
    );

    expect(timeToApoapsis(elements, MU)).toBe(Infinity);
  });
});
