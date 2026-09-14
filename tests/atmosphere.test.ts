/**
 * Atmospheric scattering tests.
 *
 * These matter more than usual because the payoff is visual and I cannot see
 * it: the GPU shader is a transcription of this same maths, so proving the
 * model here is what gives confidence the sky is right rather than merely
 * plausible. Each test states a physical fact the sky must obey.
 */
import { describe, expect, it } from 'vitest';
import { TERRIN } from '../src/bodies/system.js';
import { starVisibility } from '../src/render/starfield.js';
import {
  distanceToGround,
  distanceToTop,
  hitsGround,
  muAt,
  radiusAt,
} from '../src/atmosphere/geometry.js';
import {
  createAtmosphereModel,
  extinctionAt,
  mieDensity,
  ozoneDensity,
  rayleighDensity,
} from '../src/atmosphere/model.js';
import type { AtmosphereModel } from '../src/atmosphere/model.js';
import {
  integrateScattering,
  miePhase,
  rayleighPhase,
  viewSunCosine,
} from '../src/atmosphere/scattering.js';
import {
  buildTransmittanceLut,
  opticalDepthToTop,
  sampleTransmittance,
  transmittanceRMuToUv,
  transmittanceToSun,
  transmittanceToTop,
  transmittanceUvToRMu,
} from '../src/atmosphere/transmittance.js';

const model = createAtmosphereModel(TERRIN)!;
const lut = buildTransmittanceLut(model);

const GROUND = model.bottomRadius;
const TOP = model.topRadius;

/** Channel indices, for readability. */
const RED = 0;
const BLUE = 2;

describe('atmosphere model', () => {
  it('exists for Terrin and not for airless Lunara', () => {
    expect(model).not.toBeNull();
    expect(createAtmosphereModel({ ...TERRIN, atmosphere: null })).toBeNull();
  });

  it('spans exactly the body’s atmosphere height', () => {
    expect(GROUND).toBe(TERRIN.radius);
    expect(TOP - GROUND).toBe(TERRIN.atmosphere!.height);
  });

  it('scatters blue far more strongly than red', () => {
    const ratio = model.rayleighScattering[BLUE] / model.rayleighScattering[RED];
    // The 1/lambda^4 dependence: this is why the sky is blue.
    expect(ratio).toBeGreaterThan(5);
    expect(ratio).toBeLessThan(6.5);
  });

  it('falls off exponentially with altitude', () => {
    expect(rayleighDensity(model, 0)).toBeCloseTo(1, 12);
    expect(rayleighDensity(model, model.rayleighScaleHeight)).toBeCloseTo(
      Math.exp(-1),
      12,
    );
    // Aerosols hug the ground far more closely than air does.
    expect(mieDensity(model, 5_000)).toBeLessThan(rayleighDensity(model, 5_000));
  });

  it('puts ozone in a band well above the ground', () => {
    expect(ozoneDensity(model, 0)).toBeLessThan(0.5);
    expect(ozoneDensity(model, model.ozoneCentre)).toBeCloseTo(1, 12);
    expect(ozoneDensity(model, model.ozoneCentre + model.ozoneWidth)).toBeCloseTo(0, 12);
    expect(ozoneDensity(model, TOP)).toBe(0);
  });

  it('has monotonically decreasing extinction with altitude', () => {
    let previous = Infinity;
    for (const altitude of [0, 10_000, 30_000, 50_000, 69_000]) {
      const total = extinctionAt(model, altitude).reduce((a, b) => a + b, 0);
      expect(total).toBeLessThan(previous);
      previous = total;
    }
  });
});

describe('ray geometry', () => {
  it('reaches the top of the atmosphere straight up', () => {
    expect(distanceToTop(GROUND, 1, TOP)).toBeCloseTo(TOP - GROUND, 6);
  });

  it('travels further to the top near the horizon', () => {
    const zenith = distanceToTop(GROUND, 1, TOP);
    const grazing = distanceToTop(GROUND, 0.01, TOP);
    // Terrin's atmosphere is 70 km on a 600 km body, so the grazing path is
    // ~4x the vertical one rather than Earth's ~10x.
    expect(grazing).toBeGreaterThan(zenith * 4);
  });

  it('detects a downward ray hitting the ground', () => {
    expect(hitsGround(GROUND + 10_000, -1, GROUND)).toBe(true);
    expect(distanceToGround(GROUND + 10_000, -1, GROUND)).toBeCloseTo(10_000, 6);
  });

  it('does not treat a grazing downward ray as hitting the ground', () => {
    // From high up, looking slightly down still clears the limb.
    expect(hitsGround(TOP, -0.01, GROUND)).toBe(false);
    expect(distanceToGround(TOP, -0.01, GROUND)).toBe(-1);
  });

  it('tracks radius and zenith cosine along a ray', () => {
    const r = GROUND + 1_000;
    expect(radiusAt(r, 1, 5_000)).toBeCloseTo(r + 5_000, 6);
    expect(muAt(r, 1, 5_000)).toBeCloseTo(1, 9);

    // Travelling horizontally, the ray climbs away from the surface.
    expect(radiusAt(r, 0, 50_000)).toBeGreaterThan(r);
    expect(muAt(r, 0, 50_000)).toBeGreaterThan(0);
  });
});

describe('transmittance', () => {
  it('matches the analytic optical depth for a vertical Rayleigh path', () => {
    // Straight up through an exponential atmosphere the integral is
    // beta * H * (1 - exp(-height/H)); ozone and Mie add a little on top.
    const H = model.rayleighScaleHeight;
    const height = TOP - GROUND;
    const analytic = model.rayleighScattering[BLUE] * H * (1 - Math.exp(-height / H));

    const depth = opticalDepthToTop(model, GROUND, 1)[BLUE];

    expect(depth).toBeGreaterThan(analytic);
    expect(depth).toBeLessThan(analytic * 1.35);
  });

  it('is total above the atmosphere', () => {
    const above = transmittanceToTop(model, TOP, 1);
    expect(above[RED]).toBeCloseTo(1, 6);
    expect(above[BLUE]).toBeCloseTo(1, 6);
  });

  it('lets more red than blue through at the ground', () => {
    const vertical = transmittanceToTop(model, GROUND, 1);
    expect(vertical[RED]).toBeGreaterThan(vertical[BLUE]);
  });

  it('reddens dramatically towards the horizon', () => {
    const zenith = transmittanceToTop(model, GROUND, 1);
    const horizon = transmittanceToTop(model, GROUND, 0.0);

    // The long grazing path extinguishes blue far more than red — this is
    // exactly why sunsets are red.
    const zenithRatio = zenith[RED] / zenith[BLUE];
    const horizonRatio = horizon[RED] / horizon[BLUE];

    expect(horizonRatio).toBeGreaterThan(zenithRatio * 3);
    expect(horizon[BLUE]).toBeLessThan(0.1);
  });

  it('decreases monotonically as the view tilts towards the horizon', () => {
    let previous = 1;
    for (const mu of [1, 0.8, 0.5, 0.2, 0.05]) {
      const value = transmittanceToTop(model, GROUND, mu)[BLUE];
      expect(value).toBeLessThan(previous);
      previous = value;
    }
  });

  it('blocks sunlight when the ground is in the way', () => {
    const belowHorizon = transmittanceToSun(lut, GROUND + 1_000, -0.5);
    expect(belowHorizon).toEqual([0, 0, 0]);
  });
});

describe('transmittance lookup table', () => {
  it('has the expected dimensions and finite contents', () => {
    expect(lut.data.length).toBe(lut.width * lut.height * 4);
    expect(lut.data.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('stays within physical bounds everywhere', () => {
    for (let i = 0; i < lut.data.length; i += 4) {
      expect(lut.data[i]!).toBeGreaterThanOrEqual(0);
      expect(lut.data[i]!).toBeLessThanOrEqual(1);
    }
  });

  it('round-trips the (r, mu) parameterisation', () => {
    for (const [u, v] of [
      [0.1, 0.2],
      [0.5, 0.5],
      [0.9, 0.8],
      [0.25, 0.95],
    ]) {
      const { r, mu } = transmittanceUvToRMu(model, u!, v!);
      const back = transmittanceRMuToUv(model, r, mu);

      expect(back.u).toBeCloseTo(u!, 4);
      expect(back.v).toBeCloseTo(v!, 4);
    }
  });

  it('agrees with direct integration to within a few percent', () => {
    for (const mu of [1, 0.6, 0.2, 0.02]) {
      const sampled = sampleTransmittance(lut, GROUND + 2_000, mu);
      const exact = transmittanceToTop(model, GROUND + 2_000, mu);

      for (const channel of [RED, BLUE]) {
        expect(Math.abs(sampled[channel]! - exact[channel]!)).toBeLessThan(0.04);
      }
    }
  });
});

describe('phase functions', () => {
  it('keeps Rayleigh scattering nearly isotropic', () => {
    const forward = rayleighPhase(1);
    const side = rayleighPhase(0);
    expect(forward / side).toBeCloseTo(2, 6);
  });

  it('normalises Rayleigh over the sphere', () => {
    expect(integratePhase((c) => rayleighPhase(c))).toBeCloseTo(1, 3);
  });

  it('biases Mie strongly forward', () => {
    const forward = miePhase(1, 0.8);
    const backward = miePhase(-1, 0.8);
    expect(forward).toBeGreaterThan(backward * 100);
  });

  it('normalises Mie over the sphere', () => {
    expect(integratePhase((c) => miePhase(c, 0.8))).toBeCloseTo(1, 2);
  });

  it('reduces to isotropic when Mie asymmetry is zero', () => {
    expect(miePhase(1, 0)).toBeCloseTo(1 / (4 * Math.PI), 9);
    expect(miePhase(-1, 0)).toBeCloseTo(1 / (4 * Math.PI), 9);
  });
});

describe('sky radiance', () => {
  /** Looking straight up from the ground with the sun overhead. */
  function zenithNoon(): ReturnType<typeof integrateScattering> {
    return integrateScattering(model, lut, { r: GROUND + 2, mu: 1, muSun: 1, nu: 1 });
  }

  it('is blue looking up on a clear day', () => {
    const sky = zenithNoon();

    // Converged single-scattering gives a blue/red ratio near 1.85. It is not
    // the full 5.7 of the scattering coefficients because the longer blue path
    // is also more strongly extinguished, and because multiple scattering —
    // which would push it higher — is not modelled yet.
    expect(sky.radiance[BLUE]).toBeGreaterThan(sky.radiance[RED] * 1.7);
    expect(sky.radiance[BLUE]).toBeGreaterThan(0);
  });

  it('has converged at the default sample count', () => {
    // Guards the step distribution. Uniform spacing put the zenith 47% below
    // truth even at twice the samples, because it barely sampled the dense air
    // near the ground; this fails loudly if that regresses.
    const coarse = zenithNoon();
    const fine = integrateScattering(model, lut, {
      r: GROUND + 2,
      mu: 1,
      muSun: 1,
      nu: 1,
      samples: 512,
    });

    for (const channel of [RED, BLUE]) {
      const error = Math.abs(coarse.radiance[channel]! - fine.radiance[channel]!);
      expect(error / fine.radiance[channel]!).toBeLessThan(0.15);
    }
  });

  it('converges from any viewpoint, not just straight up', () => {
    const views = [
      { r: GROUND + 2, mu: 0.707, muSun: 0.866 },
      { r: GROUND + 2, mu: 0.02, muSun: 0.866 },
      { r: GROUND + 20_000, mu: 0.5, muSun: 0.6 },
      { r: GROUND + 400_000, mu: -0.766, muSun: 0.42 },
    ];

    for (const view of views) {
      const params = { ...view, nu: view.mu * view.muSun };
      const coarse = integrateScattering(model, lut, params);
      const fine = integrateScattering(model, lut, { ...params, samples: 512 });

      const reference = Math.max(1e-9, fine.radiance[BLUE]!);
      const error = Math.abs(coarse.radiance[BLUE]! - reference) / reference;
      expect(error, `view mu=${view.mu} r=${view.r}`).toBeLessThan(0.1);
    }
  });

  it('is black above the atmosphere looking away from the planet', () => {
    const space = integrateScattering(model, lut, {
      r: TOP + 500_000,
      mu: 1,
      muSun: 1,
      nu: 1,
    });

    expect(space.radiance[BLUE]).toBeCloseTo(0, 9);
    expect(space.transmittance[BLUE]).toBeCloseTo(1, 6);
  });

  it('glows along the limb seen from orbit', () => {
    // Looking back down so the ray grazes the atmosphere: the blue rim.
    const rim = integrateScattering(model, lut, {
      r: GROUND + 300_000,
      mu: -0.88,
      muSun: 0.4,
      nu: 0.2,
    });

    expect(rim.radiance[BLUE]).toBeGreaterThan(0);
    expect(rim.radiance[BLUE]).toBeGreaterThan(rim.radiance[RED]);
  });

  it('goes dark when the sun is below the horizon', () => {
    const night = integrateScattering(model, lut, {
      r: GROUND + 2,
      mu: 1,
      muSun: -0.6,
      nu: -0.6,
    });
    const day = zenithNoon();

    expect(night.radiance[BLUE]).toBeLessThan(day.radiance[BLUE] * 0.01);
  });

  it('is brighter near the horizon than at the zenith', () => {
    const zenith = zenithNoon();
    const horizon = integrateScattering(model, lut, {
      r: GROUND + 2,
      mu: 0.03,
      muSun: 1,
      nu: 0.03,
    });

    // More air along the line of sight means more scattered light.
    const sum = (s: readonly number[]): number => s[0]! + s[1]! + s[2]!;
    expect(sum(horizon.radiance)).toBeGreaterThan(sum(zenith.radiance));
  });

  it('reddens the horizon at sunset relative to noon', () => {
    const sunset = integrateScattering(model, lut, {
      r: GROUND + 2,
      mu: 0.02,
      muSun: 0.02,
      nu: 1,
    });
    const noon = zenithNoon();

    const sunsetRedness = sunset.radiance[RED] / Math.max(1e-12, sunset.radiance[BLUE]);
    const noonRedness = noon.radiance[RED] / Math.max(1e-12, noon.radiance[BLUE]);

    expect(sunsetRedness).toBeGreaterThan(noonRedness * 2);
  });

  it('produces finite non-negative radiance over the whole sky', () => {
    for (const r of [GROUND + 1, GROUND + 20_000, TOP, TOP + 100_000]) {
      for (const mu of [1, 0.5, 0, -0.5, -1]) {
        for (const muSun of [1, 0.2, -0.4]) {
          const sky = integrateScattering(model, lut, { r, mu, muSun, nu: mu * muSun });

          for (const channel of sky.radiance) {
            expect(Number.isFinite(channel)).toBe(true);
            expect(channel).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
  });

  it('darkens the background through thicker air', () => {
    const thin = integrateScattering(model, lut, {
      r: GROUND + 60_000,
      mu: 1,
      muSun: 1,
      nu: 1,
    });
    const thick = integrateScattering(model, lut, {
      r: GROUND + 2,
      mu: 0.05,
      muSun: 1,
      nu: 0.05,
    });

    expect(thick.transmittance[BLUE]).toBeLessThan(thin.transmittance[BLUE]);
  });
});

describe('viewSunCosine', () => {
  it('is 1 when looking straight at an overhead sun', () => {
    expect(viewSunCosine(1, 1, 0)).toBeCloseTo(1, 9);
  });

  it('is -1 when looking directly away from it', () => {
    expect(viewSunCosine(-1, 1, 0)).toBeCloseTo(-1, 9);
  });

  it('falls to the horizon value at 90 degrees azimuth', () => {
    expect(viewSunCosine(0, 0, Math.PI / 2)).toBeCloseTo(0, 9);
  });
});

/** Integrate a phase function over the sphere; should come to 1. */
function integratePhase(phase: (cosTheta: number) => number): number {
  const steps = 4_000;
  let total = 0;

  for (let i = 0; i < steps; i++) {
    const theta = (Math.PI * (i + 0.5)) / steps;
    total += phase(Math.cos(theta)) * Math.sin(theta) * (Math.PI / steps);
  }

  return total * 2 * Math.PI;
}

/** Keep the model type referenced for readers of this file. */
export type { AtmosphereModel };

describe('star visibility', () => {
  /** Sky radiance overhead, the quantity the star fade is driven by. */
  function zenith(altitude: number, muSun: number): number {
    return integrateScattering(model, lut, {
      r: GROUND + altitude,
      mu: 1,
      muSun,
      nu: muSun,
    }).radiance[1]!;
  }

  it('drowns stars in a daytime sky', () => {
    // Daylight does not block starlight, it outshines it. Attenuation alone
    // left stars visible wherever the air happened to be thin.
    expect(starVisibility(zenith(0, 1))).toBeLessThan(0.05);
  });

  it('still hides them in the blue sky partway up', () => {
    expect(starVisibility(zenith(7_000, 1))).toBeLessThan(0.15);
  });

  it('brings them back above the atmosphere', () => {
    expect(starVisibility(zenith(40_000, 1))).toBeGreaterThan(0.9);
    expect(starVisibility(zenith(80_000, 1))).toBeGreaterThan(0.95);
  });

  it('shows them at night on the ground', () => {
    expect(starVisibility(zenith(0, -0.5))).toBeGreaterThan(0.95);
  });

  it('falls monotonically as the sky brightens', () => {
    let previous = Infinity;
    for (const brightness of [0, 1e-5, 1e-4, 1e-3, 1e-2, 1e-1]) {
      const value = starVisibility(brightness);
      expect(value).toBeLessThanOrEqual(previous);
      previous = value;
    }
  });

  it('stays within [0, 1]', () => {
    for (const brightness of [-1, 0, 0.5, 1e6]) {
      expect(starVisibility(brightness)).toBeGreaterThanOrEqual(0);
      expect(starVisibility(brightness)).toBeLessThanOrEqual(1);
    }
  });
});
