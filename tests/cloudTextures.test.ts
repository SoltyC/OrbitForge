/**
 * Baked cloud noise tests.
 *
 * The shader cannot evaluate the noise; it can only read the baked textures.
 * So everything the cloud tests establish about the field is established about
 * a function the GPU never calls — unless the bake is shown to reproduce it.
 * That is what these are for.
 *
 * Two things have to hold. The bake has to land the analytic values at the
 * texel centres exactly, and the trilinear reconstruction between those texels
 * has to stay close to the analytic field in between. The second is an
 * approximation with a real error, and the size of that error is measured here
 * rather than assumed.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLOUD_LAYER,
  analyticNoise,
  bakedNoise,
  cloudDensity,
} from '../src/clouds/density.js';
import { marchClouds } from '../src/clouds/march.js';
import {
  DETAIL_PERIOD,
  DETAIL_RESOLUTION,
  SHAPE_PERIOD,
  SHAPE_RESOLUTION,
  TOTAL_BAKE_TEXELS,
  WEATHER_PERIOD,
  WEATHER_RESOLUTION,
  bakeCloudTextures,
  bakeCloudTexturesSync,
  sampleDetail,
  sampleShape,
  sampleWeatherCoverage,
  sampleWeatherType,
} from '../src/clouds/textures.js';

const layer = DEFAULT_CLOUD_LAYER;

/**
 * One bake, shared by every test here.
 *
 * A quarter of a million four-octave noise evaluations is several seconds of
 * JavaScript, which is worth paying once and not once per assertion.
 */
const textures = bakeCloudTexturesSync(layer.seed);
const analytic = analyticNoise(layer.seed);
const baked = bakedNoise(textures);

/** The noise coordinate a texel stores, matching the bake's own convention. */
function texelCentre(index: number, resolution: number, period: number): number {
  return ((index + 0.5) / resolution) * period;
}

describe('baking', () => {
  it('fills every texel of every field', () => {
    expect(textures.shape).toHaveLength(SHAPE_RESOLUTION ** 3);
    expect(textures.detail).toHaveLength(DETAIL_RESOLUTION ** 3);
    expect(textures.weather).toHaveLength(WEATHER_RESOLUTION ** 3 * 2);

    // A field left at zero would render as a permanently clear sky, which is
    // an easy thing not to notice.
    for (const [name, data] of [
      ['shape', textures.shape],
      ['detail', textures.detail],
      ['weather', textures.weather],
    ] as const) {
      const nonZero = data.reduce((count, v) => count + (v > 0 ? 1 : 0), 0);
      expect(nonZero, name).toBeGreaterThan(data.length * 0.5);
    }
  });

  it('reports progress that reaches the announced total', () => {
    const baker = bakeCloudTextures(layer.seed);
    let last = 0;
    let steps = 0;

    for (;;) {
      const next = baker.next();
      if (next.done) break;
      // Progress only ever moves forwards, or a progress bar goes backwards.
      expect(next.value).toBeGreaterThan(last);
      last = next.value;
      steps++;
    }

    expect(last).toBe(TOTAL_BAKE_TEXELS);
    // Yields often enough to be split across frames rather than freezing one.
    expect(steps).toBeGreaterThan(100);
  });

  it('produces the same bytes whether drained in steps or in one go', () => {
    const incremental = bakeCloudTextures(layer.seed);
    let next = incremental.next();
    while (!next.done) next = incremental.next();

    expect(next.value.shape).toEqual(textures.shape);
    expect(next.value.detail).toEqual(textures.detail);
    expect(next.value.weather).toEqual(textures.weather);
  });

  it('depends on the seed', () => {
    const other = bakeCloudTexturesSync(layer.seed + 1);
    expect(other.weather).not.toEqual(textures.weather);
  });
});

describe('sampling the baked fields', () => {
  it('returns the baked value exactly at a texel centre', () => {
    // If the half-texel offset were wrong, everything would still look like
    // cloud — shifted by half a texel, and differently on CPU and GPU.
    for (let i = 0; i < 200; i++) {
      const x = (i * 7) % SHAPE_RESOLUTION;
      const y = (i * 13) % SHAPE_RESOLUTION;
      const z = (i * 29) % SHAPE_RESOLUTION;

      const stored =
        textures.shape[(z * SHAPE_RESOLUTION + y) * SHAPE_RESOLUTION + x]! / 255;

      const read = sampleShape(
        textures,
        texelCentre(x, SHAPE_RESOLUTION, SHAPE_PERIOD),
        texelCentre(y, SHAPE_RESOLUTION, SHAPE_PERIOD),
        texelCentre(z, SHAPE_RESOLUTION, SHAPE_PERIOD),
      );

      expect(read).toBeCloseTo(stored, 12);
    }
  });

  it('keeps the two weather channels apart', () => {
    // Coverage and cloud type share a texel. Swapping the channels would give
    // a sky that is cloudy in the right places and the wrong kind everywhere.
    let differences = 0;
    for (let i = 0; i < 200; i++) {
      const c = texelCentre(i % WEATHER_RESOLUTION, WEATHER_RESOLUTION, WEATHER_PERIOD);
      const coverage = sampleWeatherCoverage(textures, c, c * 0.5, c * 1.5);
      const type = sampleWeatherType(textures, c, c * 0.5, c * 1.5);
      if (Math.abs(coverage - type) > 1e-6) differences++;
    }
    expect(differences).toBeGreaterThan(150);
  });

  it('wraps seamlessly at the tile boundary', () => {
    // A texture that does not wrap leaves a visible seam every 28 km.
    for (let i = 0; i < 100; i++) {
      const x = (i * 0.037) % SHAPE_PERIOD;
      const y = (i * 0.071) % SHAPE_PERIOD;
      const z = (i * 0.113) % SHAPE_PERIOD;

      const inside = sampleShape(textures, x, y, z);
      expect(sampleShape(textures, x + SHAPE_PERIOD, y, z)).toBeCloseTo(inside, 12);
      expect(sampleShape(textures, x, y - SHAPE_PERIOD, z)).toBeCloseTo(inside, 12);
      expect(sampleShape(textures, x, y, z + SHAPE_PERIOD * 3)).toBeCloseTo(inside, 12);
    }
  });

  it('has no seam in the field it reconstructs across the wrap', () => {
    // Wrapping the lookup is not enough: the values either side of the seam
    // have to agree too, which is why the noise is periodic in the first place.
    for (let i = 0; i < 60; i++) {
      const y = (i * 0.061) % SHAPE_PERIOD;
      const z = (i * 0.131) % SHAPE_PERIOD;
      const before = sampleShape(textures, SHAPE_PERIOD - 1e-4, y, z);
      const after = sampleShape(textures, 1e-4, y, z);
      expect(Math.abs(after - before)).toBeLessThan(0.02);
    }
  });

  it('reconstructs the detail field at its own texel centres', () => {
    for (let i = 0; i < 100; i++) {
      const x = (i * 5) % DETAIL_RESOLUTION;
      const y = (i * 11) % DETAIL_RESOLUTION;
      const z = (i * 17) % DETAIL_RESOLUTION;

      const stored =
        textures.detail[(z * DETAIL_RESOLUTION + y) * DETAIL_RESOLUTION + x]! / 255;

      expect(
        sampleDetail(
          textures,
          texelCentre(x, DETAIL_RESOLUTION, DETAIL_PERIOD),
          texelCentre(y, DETAIL_RESOLUTION, DETAIL_PERIOD),
          texelCentre(z, DETAIL_RESOLUTION, DETAIL_PERIOD),
        ),
      ).toBeCloseTo(stored, 12);
    }
  });
});

describe('baked against analytic', () => {
  /** Error statistics between two functions over a sample of points. */
  function compare(
    samples: number,
    a: (x: number, y: number, z: number) => number,
    b: (x: number, y: number, z: number) => number,
    spread: number,
  ): { mean: number; max: number } {
    let total = 0;
    let max = 0;

    for (let i = 0; i < samples; i++) {
      // Irrational strides, so the points never land on the lattice.
      const x = i * 0.6180339887 * spread;
      const y = i * 0.4142135623 * spread;
      const z = i * 0.7320508075 * spread;

      const error = Math.abs(a(x, y, z) - b(x, y, z));
      total += error;
      max = Math.max(max, error);
    }

    return { mean: total / samples, max };
  }

  it('reconstructs the base shape to within a texel of interpolation error', () => {
    const { mean, max } = compare(4_000, analytic.shape, baked.shape, 1);

    // Trilinear interpolation of a 64^3 texture cannot follow the analytic
    // field exactly between texels — that is what the resolution buys. What
    // matters is that the error is interpolation-sized rather than structural:
    // a mis-scaled or mis-seeded bake lands nowhere near this.
    expect(mean).toBeLessThan(0.05);
    expect(max).toBeLessThan(0.25);
  });

  it('reconstructs the erosion detail', () => {
    const { mean, max } = compare(4_000, analytic.detail, baked.detail, 1);
    expect(mean).toBeLessThan(0.05);
    expect(max).toBeLessThan(0.25);
  });

  it('reconstructs the weather map most closely of all', () => {
    // The weather map is the lowest-frequency field, so its texels are the
    // furthest apart relative to its features and it should fare best.
    const coverage = compare(2_000, analytic.weatherCoverage, baked.weatherCoverage, 1);
    const type = compare(2_000, analytic.weatherType, baked.weatherType, 1);

    expect(coverage.mean).toBeLessThan(0.02);
    expect(type.mean).toBeLessThan(0.02);
    expect(coverage.max).toBeLessThan(0.15);
    expect(type.max).toBeLessThan(0.15);
  });

  it('is not merely correlated — a wrong seed misses by far more', () => {
    // Guards the thresholds above from being loose enough to pass anything.
    const wrong = bakedNoise(bakeCloudTexturesSync(layer.seed + 7));
    const right = compare(1_000, analytic.shape, baked.shape, 1);
    const decoy = compare(1_000, analytic.shape, wrong.shape, 1);

    expect(decoy.mean).toBeGreaterThan(right.mean * 3);
  });

  it('gives a density field of the same character', () => {
    // The field is what the renderer actually uses, and the remaps inside it
    // amplify the interpolation error above — so it is measured after them,
    // not before.
    let cloudy = 0;
    let totalAnalytic = 0;
    let totalBaked = 0;
    let maxError = 0;

    for (let i = 0; i < 3_000; i++) {
      const altitude = layer.bottomAltitude + (i % 53) * 66;
      const r = layer.planetRadius + altitude;
      const angle = i * 0.011;
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r * 0.7;
      const z = Math.sin(angle * 1.7) * r * 0.5;
      const scale = r / Math.hypot(x, y, z);

      const p: [number, number, number] = [x * scale, y * scale, z * scale];
      const da = cloudDensity(layer, ...p, analytic);
      const db = cloudDensity(layer, ...p, baked);

      if (da > 0 || db > 0) cloudy++;
      totalAnalytic += da;
      totalBaked += db;
      maxError = Math.max(maxError, Math.abs(da - db));
    }

    expect(cloudy).toBeGreaterThan(200);
    // Same amount of cloud in the sky, to within a tenth.
    expect(totalBaked).toBeGreaterThan(totalAnalytic * 0.9);
    expect(totalBaked).toBeLessThan(totalAnalytic * 1.1);
    // And no single point wildly off, which is what a bad wrap would produce.
    expect(maxError).toBeLessThan(layer.density * 0.6);
  });

  it('renders a ray to nearly the same transmittance', () => {
    // The end of the chain: what the pixel is, not what the field is.
    let worst = 0;
    let compared = 0;

    for (let i = 0; i < 60; i++) {
      const angle = i * 0.021;
      const r = layer.planetRadius + 200;
      const origin: [number, number, number] = [
        Math.cos(angle) * r,
        Math.sin(angle) * r * 0.6,
        Math.sin(angle * 2.3) * r * 0.4,
      ];
      const scale = r / Math.hypot(...origin);
      const o: [number, number, number] = [
        origin[0] * scale,
        origin[1] * scale,
        origin[2] * scale,
      ];
      const up: [number, number, number] = [o[0] / r, o[1] / r, o[2] / r];
      const sun: [number, number, number] = [0.6, 0.8, 0];

      const common = { origin: o, direction: up, sunDirection: sun, jitter: 0.5 };
      const a = marchClouds(layer, { ...common, noise: analytic });
      const b = marchClouds(layer, { ...common, noise: baked });

      worst = Math.max(worst, Math.abs(a.transmittance - b.transmittance));
      compared++;
    }

    expect(compared).toBe(60);
    expect(worst).toBeLessThan(0.15);
  });
});
