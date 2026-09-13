/**
 * Volumetric cloud tests.
 *
 * A wrong cloud still looks like a cloud, so appearance is a poor judge. These
 * assert the structural facts the model has to obey: the noise tiles, the
 * density field is bounded and vertically shaped, the sky has both gaps and
 * cover, and the lighting produces bright rims rather than uniform grey.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLOUD_LAYER,
  cloudDensity,
  heightFraction,
  heightGradient,
  sampleWeather,
} from '../src/clouds/density.js';
import type { CloudLayer } from '../src/clouds/density.js';
import {
  dualLobePhase,
  henyeyGreenstein,
  multiScatter,
} from '../src/clouds/lighting.js';
import { lightMarch, marchClouds, slabIntersection } from '../src/clouds/march.js';
import {
  perlin3,
  perlinWorley,
  remap,
  worley3,
  worleyFbm,
} from '../src/clouds/noise.js';

const layer = DEFAULT_CLOUD_LAYER;

describe('noise primitives', () => {
  it('keeps Perlin inside [0, 1]', () => {
    for (let i = 0; i < 2_000; i++) {
      const value = perlin3(i * 0.37, i * 0.71, i * 1.13, 8);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('keeps Worley inside [0, 1]', () => {
    for (let i = 0; i < 2_000; i++) {
      const value = worley3(i * 0.29, i * 0.53, i * 0.97, 8);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('tiles Perlin seamlessly over its period', () => {
    const period = 8;
    for (const [x, y, z] of [
      [0.3, 1.7, 2.2],
      [5.5, 0.1, 7.9],
      [3.25, 6.5, 1.0],
    ]) {
      const inside = perlin3(x!, y!, z!, period);
      // The same point one period away must be identical, or a seam shows.
      expect(perlin3(x! + period, y!, z!, period)).toBeCloseTo(inside, 12);
      expect(perlin3(x!, y! + period, z!, period)).toBeCloseTo(inside, 12);
      expect(perlin3(x!, y!, z! + period, period)).toBeCloseTo(inside, 12);
    }
  });

  it('tiles Worley seamlessly over its period', () => {
    const period = 8;
    for (const [x, y, z] of [
      [0.3, 1.7, 2.2],
      [4.4, 5.2, 6.1],
    ]) {
      const inside = worley3(x!, y!, z!, period);
      expect(worley3(x! + period, y!, z!, period)).toBeCloseTo(inside, 12);
      expect(worley3(x!, y! + period, z!, period)).toBeCloseTo(inside, 12);
      expect(worley3(x!, y!, z! + period, period)).toBeCloseTo(inside, 12);
    }
  });

  it('is deterministic for a given seed and varies between seeds', () => {
    expect(perlin3(1.5, 2.5, 3.5, 8, 1)).toBe(perlin3(1.5, 2.5, 3.5, 8, 1));
    expect(perlin3(1.5, 2.5, 3.5, 8, 1)).not.toBe(perlin3(1.5, 2.5, 3.5, 8, 2));
  });

  it('varies across space rather than returning a constant', () => {
    const samples = Array.from({ length: 400 }, (_, i) =>
      perlin3(i * 0.13, 0.5, i * 0.29, 16),
    );
    const min = Math.min(...samples);
    const max = Math.max(...samples);

    expect(max - min).toBeGreaterThan(0.4);
  });

  it('keeps Perlin-Worley bounded and non-degenerate', () => {
    const samples = Array.from({ length: 300 }, (_, i) =>
      perlinWorley(i * 0.11, 0.4, i * 0.17, 8),
    );

    for (const value of samples) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(0.25);
  });

  it('remaps between ranges and clamps outside them', () => {
    expect(remap(0.5, 0, 1, 0, 10)).toBeCloseTo(5, 12);
    expect(remap(-1, 0, 1, 0, 10)).toBe(0);
    expect(remap(2, 0, 1, 0, 10)).toBe(10);
    // A degenerate input range must not divide by zero.
    expect(remap(0.5, 1, 1, 3, 9)).toBe(3);
  });

  it('averages Worley octaves without leaving the unit range', () => {
    for (let i = 0; i < 500; i++) {
      const value = worleyFbm(i * 0.21, i * 0.13, i * 0.07, 8, 3);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe('height gradient', () => {
  it('is zero outside the slab', () => {
    expect(heightGradient(-0.1, 0.5)).toBe(0);
    expect(heightGradient(1.1, 0.5)).toBe(0);
  });

  it('vanishes at the very bottom and top', () => {
    expect(heightGradient(0, 0.5)).toBeCloseTo(0, 9);
    expect(heightGradient(1, 0.5)).toBeCloseTo(0, 9);
  });

  it('keeps stratus low and flat', () => {
    // A stratus sheet lives in the lower third and is gone above it.
    expect(heightGradient(0.25, 0)).toBeGreaterThan(0.4);
    expect(heightGradient(0.6, 0)).toBeCloseTo(0, 6);
  });

  it('lets cumulus tower', () => {
    // Cumulus still has substance high in the slab, where stratus has none.
    expect(heightGradient(0.6, 1)).toBeGreaterThan(0.5);
    expect(heightGradient(0.6, 1)).toBeGreaterThan(heightGradient(0.6, 0));
  });

  it('never leaves [0, 1]', () => {
    for (let h = 0; h <= 1; h += 0.01) {
      for (const type of [0, 0.25, 0.5, 0.75, 1]) {
        const value = heightGradient(h, type);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('maps altitude to slab fraction', () => {
    expect(heightFraction(layer, layer.bottomAltitude)).toBeCloseTo(0, 12);
    expect(heightFraction(layer, layer.topAltitude)).toBeCloseTo(1, 12);
    const middle = (layer.bottomAltitude + layer.topAltitude) / 2;
    expect(heightFraction(layer, middle)).toBeCloseTo(0.5, 12);
  });
});

describe('weather map', () => {
  it('stays within range everywhere', () => {
    for (let i = 0; i < 500; i++) {
      const weather = sampleWeather(layer, i * 731, i * 1_193);
      expect(weather.coverage).toBeGreaterThanOrEqual(0);
      expect(weather.coverage).toBeLessThanOrEqual(1);
      expect(weather.cloudType).toBeGreaterThanOrEqual(0);
      expect(weather.cloudType).toBeLessThanOrEqual(1);
    }
  });

  it('varies coverage across the sky', () => {
    const samples = Array.from({ length: 400 }, (_, i) =>
      sampleWeather(layer, i * 2_500, i * 1_700).coverage,
    );

    // A sky with uniform coverage is wallpaper, not weather.
    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(0.3);
  });
});

describe('density field', () => {
  it('is zero above and below the slab', () => {
    expect(cloudDensity(layer, 0, 0, layer.bottomAltitude - 100)).toBe(0);
    expect(cloudDensity(layer, 0, 0, layer.topAltitude + 100)).toBe(0);
  });

  it('never exceeds the layer’s peak density', () => {
    for (let i = 0; i < 3_000; i++) {
      const altitude = layer.bottomAltitude + (i % 97) * 36;
      const density = cloudDensity(layer, i * 137, i * 211, altitude);

      expect(density).toBeGreaterThanOrEqual(0);
      expect(density).toBeLessThanOrEqual(layer.density);
    }
  });

  it('produces both cloud and clear sky', () => {
    let cloudy = 0;
    let clear = 0;

    for (let i = 0; i < 4_000; i++) {
      const altitude = layer.bottomAltitude + (i % 53) * 66;
      const density = cloudDensity(layer, i * 331, i * 457, altitude);
      if (density > layer.density * 0.05) cloudy++;
      else clear++;
    }

    // Neither an empty sky nor a solid ceiling.
    expect(cloudy).toBeGreaterThan(200);
    expect(clear).toBeGreaterThan(200);
  });

  it('thins out as coverage falls', () => {
    const total = (candidate: CloudLayer): number => {
      let sum = 0;
      for (let i = 0; i < 1_500; i++) {
        const altitude = candidate.bottomAltitude + (i % 41) * 85;
        sum += cloudDensity(candidate, i * 197, i * 263, altitude);
      }
      return sum;
    };

    expect(total({ ...layer, coverage: 0.75 })).toBeGreaterThan(
      total({ ...layer, coverage: 0.25 }),
    );
  });

  it('is continuous — no sudden jumps between nearby points', () => {
    // A discontinuity in the field shows as a hard edge in the sky.
    let maxJump = 0;
    for (let i = 0; i < 600; i++) {
      const x = i * 97;
      const altitude = layer.bottomAltitude + 1_200;
      const a = cloudDensity(layer, x, 0, altitude);
      const b = cloudDensity(layer, x + 5, 0, altitude);
      maxJump = Math.max(maxJump, Math.abs(a - b));
    }

    expect(maxJump).toBeLessThan(layer.density * 0.25);
  });
});

describe('slab intersection', () => {
  it('finds the span for a ray climbing from below', () => {
    const hit = slabIntersection(layer, 0, 1);
    expect(hit).not.toBeNull();
    expect(hit!.near).toBeCloseTo(layer.bottomAltitude, 6);
    expect(hit!.far).toBeCloseTo(layer.topAltitude, 6);
  });

  it('finds the span for a ray descending from above', () => {
    const hit = slabIntersection(layer, 20_000, -1);
    expect(hit).not.toBeNull();
    expect(hit!.near).toBeCloseTo(20_000 - layer.topAltitude, 6);
    expect(hit!.far).toBeCloseTo(20_000 - layer.bottomAltitude, 6);
  });

  it('starts at the viewer when already inside the slab', () => {
    const hit = slabIntersection(layer, 3_000, 1);
    expect(hit!.near).toBe(0);
  });

  it('misses when looking away from the layer', () => {
    expect(slabIntersection(layer, 0, -1)).toBeNull();
    expect(slabIntersection(layer, 20_000, 1)).toBeNull();
  });

  it('handles a horizontal ray inside and outside the slab', () => {
    expect(slabIntersection(layer, 3_000, 0)).not.toBeNull();
    expect(slabIntersection(layer, 500, 0)).toBeNull();
  });
});

describe('lighting', () => {
  it('normalises Henyey-Greenstein over the sphere', () => {
    let total = 0;
    const steps = 2_000;
    for (let i = 0; i < steps; i++) {
      const theta = (Math.PI * (i + 0.5)) / steps;
      total += henyeyGreenstein(Math.cos(theta), 0.8) * Math.sin(theta) * (Math.PI / steps);
    }
    expect(total * 2 * Math.PI).toBeCloseTo(1, 2);
  });

  it('scatters forward far more than backward', () => {
    expect(henyeyGreenstein(1, 0.8)).toBeGreaterThan(henyeyGreenstein(-1, 0.8) * 100);
  });

  it('keeps a backward lobe so the anti-solar sky is not dead', () => {
    const single = henyeyGreenstein(-1, 0.8);
    const dual = dualLobePhase(-1, 0.8, 0.3, 0.15);

    expect(dual).toBeGreaterThan(single * 2);
  });

  it('still peaks forward with both lobes', () => {
    expect(dualLobePhase(1, 0.8, 0.3, 0.15)).toBeGreaterThan(
      dualLobePhase(0, 0.8, 0.3, 0.15),
    );
  });

  it('attenuates with optical depth', () => {
    let previous = Infinity;
    for (const depth of [0.1, 0.5, 1, 2, 5]) {
      const value = multiScatter(depth, 0);
      expect(value).toBeLessThan(previous);
      previous = value;
    }
  });

  it('lifts cloud cores above pure Beer extinction', () => {
    // Multiple scattering is the difference between a cloud and a silhouette.
    const deep = 6;
    expect(multiScatter(deep, 0)).toBeGreaterThan(Math.exp(-deep));
  });

  it('brightens towards the sun', () => {
    expect(multiScatter(1, 1)).toBeGreaterThan(multiScatter(1, -1));
  });

  it('never returns negative light', () => {
    for (const depth of [0, 0.5, 3, 20]) {
      for (const cos of [-1, -0.3, 0.3, 1]) {
        expect(multiScatter(depth, cos)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('raymarch', () => {
  const sun: readonly [number, number, number] = [0.6, 0.8, 0];

  it('reports a miss when the ray never meets the layer', () => {
    const result = marchClouds(layer, {
      origin: [0, 0, 0],
      direction: [0, -1, 0],
      sunDirection: sun,
    });

    expect(result.hitLayer).toBe(false);
    expect(result.transmittance).toBe(1);
    expect(result.luminance).toBe(0);
  });

  it('attenuates light when looking up through cloud', () => {
    let anyAttenuation = false;

    for (let i = 0; i < 60; i++) {
      const result = marchClouds(layer, {
        origin: [i * 3_000, 0, i * 1_700],
        direction: [0, 1, 0],
        sunDirection: sun,
      });
      if (result.transmittance < 0.9) anyAttenuation = true;
    }

    expect(anyAttenuation).toBe(true);
  });

  it('keeps transmittance and luminance physical', () => {
    for (let i = 0; i < 200; i++) {
      const result = marchClouds(layer, {
        origin: [i * 911, 200, i * 673],
        direction: normalise([0.5, 0.6, 0.3]),
        sunDirection: sun,
      });

      expect(result.transmittance).toBeGreaterThanOrEqual(0);
      expect(result.transmittance).toBeLessThanOrEqual(1);
      expect(result.luminance).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(result.luminance)).toBe(true);
    }
  });

  it('leaves clear sky fully transmitting', () => {
    // Above the layer looking up: nothing in the way at all.
    const result = marchClouds(layer, {
      origin: [0, layer.topAltitude + 1_000, 0],
      direction: [0, 1, 0],
      sunDirection: sun,
    });

    expect(result.transmittance).toBe(1);
    expect(result.hitLayer).toBe(false);
  });

  it('darkens more through a denser layer', () => {
    const meanTransmittance = (density: number): number => {
      let sum = 0;
      const samples = 40;
      for (let i = 0; i < samples; i++) {
        sum += marchClouds(
          { ...layer, density },
          {
            origin: [i * 2_300, 0, i * 1_900],
            direction: [0, 1, 0],
            sunDirection: sun,
          },
        ).transmittance;
      }
      return sum / samples;
    };

    expect(meanTransmittance(0.2)).toBeLessThan(meanTransmittance(0.02));
  });

  it('accumulates optical depth towards the sun inside cloud', () => {
    let sawDepth = false;
    for (let i = 0; i < 80; i++) {
      const depth = lightMarch(layer, i * 1_700, 3_000, i * 2_300, sun);
      expect(depth).toBeGreaterThanOrEqual(0);
      if (depth > 0) sawDepth = true;
    }
    expect(sawDepth).toBe(true);
  });
});

function normalise(v: readonly [number, number, number]): [number, number, number] {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}
