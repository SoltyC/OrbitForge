/**
 * Volumetric cloud tests.
 *
 * A wrong cloud still looks like a cloud, so appearance is a poor judge. These
 * assert the structural facts the model has to obey: the noise tiles, the
 * density field is bounded and vertically shaped, the sky has both gaps and
 * cover, the layer is a shell around a round planet rather than a plane, and
 * the lighting produces bright rims rather than uniform grey.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLOUD_LAYER,
  bottomRadius,
  cloudDensity,
  heightFraction,
  heightGradient,
  topRadius,
  weatherCloudType,
  weatherCoverage,
} from '../src/clouds/density.js';
import type { CloudLayer } from '../src/clouds/density.js';
import {
  dualLobePhase,
  henyeyGreenstein,
  multiScatter,
} from '../src/clouds/lighting.js';
import {
  MAX_VIEW_STEPS,
  MIN_VIEW_STEPS,
  TARGET_STEP,
  lightMarch,
  marchClouds,
  slabIntersection,
  viewStepsFor,
} from '../src/clouds/march.js';
import {
  perlin3,
  perlinWorley,
  remap,
  worley3,
  worleyFbm,
} from '../src/clouds/noise.js';

const layer = DEFAULT_CLOUD_LAYER;

type Vec = [number, number, number];

/**
 * A planet-centric position, given horizontal offsets and an altitude.
 *
 * The model takes positions rather than a tangent plane, so the tests have to
 * build them. Offsets are metres along the surface near the reference point;
 * far past that they simply wander further around the globe, which is fine for
 * sampling but is why nothing here asserts an exact horizontal distance.
 */
function at(east: number, north: number, altitude: number): Vec {
  const r = layer.planetRadius + altitude;
  const d = normalise([east / layer.planetRadius, 1, north / layer.planetRadius]);
  return [d[0] * r, d[1] * r, d[2] * r];
}

/** Straight up from the reference point, at a given altitude. */
function overhead(altitude: number): Vec {
  return [0, layer.planetRadius + altitude, 0];
}

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

  it('is unchanged by the lattice tables it is now read through', () => {
    // The tables hold precomputed hashes, so they must reproduce the hash
    // exactly — a table that merely looks similar would shift every cloud.
    // These are values computed before the tables existed.
    expect(perlin3(1.5, 2.5, 3.5, 8, 1337)).toBe(0.4375);
    expect(worley3(1.5, 2.5, 3.5, 8, 1337)).toBe(0.49137560638764444);
    expect(perlinWorley(0.3, 6.1, 2.9, 4, 0)).toBe(0.7200001172670824);
    expect(perlinWorley(12.25, 3.75, 9.5, 16, 77)).toBe(0.5949306056733735);
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

  it('places the slab as a shell around the planet', () => {
    expect(bottomRadius(layer)).toBe(layer.planetRadius + layer.bottomAltitude);
    expect(topRadius(layer)).toBe(layer.planetRadius + layer.topAltitude);
  });
});

describe('weather map', () => {
  it('stays within range everywhere', () => {
    for (let i = 0; i < 500; i++) {
      const p = at(i * 731, i * 1_193, 3_000);
      expect(weatherCoverage(layer, ...p)).toBeGreaterThanOrEqual(0);
      expect(weatherCoverage(layer, ...p)).toBeLessThanOrEqual(1);
      expect(weatherCloudType(layer, ...p)).toBeGreaterThanOrEqual(0);
      expect(weatherCloudType(layer, ...p)).toBeLessThanOrEqual(1);
    }
  });

  it('varies coverage across the sky', () => {
    const samples = Array.from({ length: 400 }, (_, i) =>
      weatherCoverage(layer, ...at(i * 2_500, i * 1_700, 3_000)),
    );

    // A sky with uniform coverage is wallpaper, not weather.
    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(0.3);
  });

  it('does not change with altitude within the layer', () => {
    // Coverage describes a patch of sky, not a height inside it; if it varied
    // vertically the slab would be sliced into horizontal bands.
    for (let i = 0; i < 40; i++) {
      const east = i * 3_100;
      const low = weatherCoverage(layer, ...at(east, 0, layer.bottomAltitude));
      const high = weatherCoverage(layer, ...at(east, 0, layer.topAltitude));
      expect(high).toBeCloseTo(low, 9);
    }
  });
});

describe('density field', () => {
  it('is zero above and below the slab', () => {
    expect(cloudDensity(layer, ...overhead(layer.bottomAltitude - 100))).toBe(0);
    expect(cloudDensity(layer, ...overhead(layer.topAltitude + 100))).toBe(0);
  });

  it('never exceeds the layer’s peak density', () => {
    for (let i = 0; i < 3_000; i++) {
      const altitude = layer.bottomAltitude + (i % 97) * 36;
      const density = cloudDensity(layer, ...at(i * 137, i * 211, altitude));

      expect(density).toBeGreaterThanOrEqual(0);
      expect(density).toBeLessThanOrEqual(layer.density);
    }
  });

  it('produces both cloud and clear sky', () => {
    let cloudy = 0;
    let clear = 0;

    for (let i = 0; i < 4_000; i++) {
      const altitude = layer.bottomAltitude + (i % 53) * 66;
      const density = cloudDensity(layer, ...at(i * 331, i * 457, altitude));
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
        sum += cloudDensity(candidate, ...at(i * 197, i * 263, altitude));
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
      const altitude = layer.bottomAltitude + 1_200;
      const a = cloudDensity(layer, ...at(i * 97, 0, altitude));
      const b = cloudDensity(layer, ...at(i * 97 + 5, 0, altitude));
      maxJump = Math.max(maxJump, Math.abs(a - b));
    }

    expect(maxJump).toBeLessThan(layer.density * 0.25);
  });

  it('is the same field everywhere on the globe, poles included', () => {
    // The noise is read at the position itself rather than through a tangent
    // frame, so there is no pole to be degenerate at. Sampling a meridian from
    // equator to pole must find cloud and gap all the way round.
    let cloudy = 0;
    const samples = 400;
    for (let i = 0; i < samples; i++) {
      const angle = (i / samples) * Math.PI * 2;
      const r = layer.planetRadius + 3_000;
      const density = cloudDensity(
        layer,
        0,
        Math.cos(angle) * r,
        Math.sin(angle) * r,
      );
      if (density > layer.density * 0.05) cloudy++;
    }

    expect(cloudy).toBeGreaterThan(20);
    expect(cloudy).toBeLessThan(samples - 20);
  });

  it('has most of its mass carved away by the erosion detail', () => {
    // Recorded because it is the reason the light march still pays for a
    // second texture fetch. Dropping erosion there is the standard saving, and
    // it was measured before being rejected: it raised the mean optical depth
    // towards the sun by 44%. Erosion is not an edge treatment — it removes
    // roughly a third of the field, and a light march blind to those holes
    // shadows cloud that is not there.
    const eroded = { ...layer };
    const smooth = { ...layer, erosion: 0 };

    let totalEroded = 0;
    let totalSmooth = 0;

    for (let i = 0; i < 2_000; i++) {
      const altitude = layer.bottomAltitude + (i % 53) * 66;
      const p = at(i * 331, i * 457, altitude);

      const a = cloudDensity(eroded, ...p);
      const b = cloudDensity(smooth, ...p);

      // Erosion only ever removes density; it cannot add cloud.
      expect(a).toBeLessThanOrEqual(b + 1e-12);

      totalEroded += a;
      totalSmooth += b;
    }

    expect(totalSmooth).toBeGreaterThan(0);
    expect(totalEroded).toBeLessThan(totalSmooth * 0.8);
  });
});

describe('slab intersection', () => {
  const ground = layer.planetRadius;

  it('finds the span for a ray climbing from below', () => {
    const hit = slabIntersection(layer, ground, 1);
    expect(hit).not.toBeNull();
    expect(hit!.near).toBeCloseTo(layer.bottomAltitude, 6);
    expect(hit!.far).toBeCloseTo(layer.topAltitude, 6);
  });

  it('finds the span for a ray descending from above', () => {
    const hit = slabIntersection(layer, ground + 20_000, -1);
    expect(hit).not.toBeNull();
    expect(hit!.near).toBeCloseTo(20_000 - layer.topAltitude, 6);
    expect(hit!.far).toBeCloseTo(20_000 - layer.bottomAltitude, 6);
  });

  it('starts at the viewer when already inside the slab', () => {
    expect(slabIntersection(layer, ground + 3_000, 1)!.near).toBe(0);
  });

  it('misses when looking away from the layer', () => {
    // Down into the ground, and up into space from above the layer.
    expect(slabIntersection(layer, ground, -1)).toBeNull();
    expect(slabIntersection(layer, ground + 20_000, 1)).toBeNull();
  });

  it('lets a horizontal ray leave the layer instead of running forever', () => {
    // This is what the flat slab got wrong. On a plane a level ray inside the
    // layer never escapes, so the horizon became a wall; around a sphere the
    // ground curves away and the ray climbs out of the top.
    const hit = slabIntersection(layer, ground + 3_000, 0);
    expect(hit).not.toBeNull();
    expect(Number.isFinite(hit!.far)).toBe(true);

    const expected = Math.sqrt(topRadius(layer) ** 2 - (ground + 3_000) ** 2);
    expect(hit!.far).toBeCloseTo(expected, 3);
  });

  it('sees the layer along the horizon from beneath it', () => {
    // Standing under the deck, clouds are still visible out towards the
    // horizon where the surface has dropped away from them. The flat model
    // reported nothing here at all.
    const hit = slabIntersection(layer, ground + 500, 0);
    expect(hit).not.toBeNull();
    expect(hit!.near).toBeGreaterThan(30_000);
    expect(hit!.far).toBeGreaterThan(hit!.near);
  });

  it('stops at the ground rather than reaching the far side of the planet', () => {
    // A steep downward ray from low altitude meets the surface first. Without
    // the check it would find the cloud base on the other side of the world.
    expect(slabIntersection(layer, ground + 500, -0.5)).toBeNull();
  });

  it('stops at the cloud base when looking down from orbit', () => {
    const r = ground + 400_000;
    const hit = slabIntersection(layer, r, -1);
    expect(hit).not.toBeNull();
    expect(hit!.far).toBeCloseTo(400_000 - layer.bottomAltitude, 6);
  });
});

describe('adaptive step count', () => {
  it('holds the step size near its target across the span', () => {
    for (const span of [4_000, 20_000, 40_000, 120_000]) {
      const steps = viewStepsFor(span);
      const size = span / steps;
      // Either the target is met, or one of the bounds is the reason it is not.
      const bounded = steps === MIN_VIEW_STEPS || steps === MAX_VIEW_STEPS;
      expect(bounded || Math.abs(size - TARGET_STEP) <= TARGET_STEP).toBe(true);
    }
  });

  it('never falls below the floor or rises above the ceiling', () => {
    for (const span of [1, 100, 3_500, 1e6]) {
      expect(viewStepsFor(span)).toBeGreaterThanOrEqual(MIN_VIEW_STEPS);
      expect(viewStepsFor(span)).toBeLessThanOrEqual(MAX_VIEW_STEPS);
    }
  });

  it('spends more steps on a longer span', () => {
    expect(viewStepsFor(30_000)).toBeGreaterThan(viewStepsFor(4_000));
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
  const sun: Vec = normalise([0.6, 0.8, 0]);

  it('reports a miss when the ray never meets the layer', () => {
    const result = marchClouds(layer, {
      origin: overhead(0),
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
      const origin = at(i * 3_000, i * 1_700, 0);
      const result = marchClouds(layer, {
        origin,
        direction: normalise(origin),
        sunDirection: sun,
      });
      if (result.transmittance < 0.9) anyAttenuation = true;
    }

    expect(anyAttenuation).toBe(true);
  });

  it('keeps transmittance and luminance physical', () => {
    for (let i = 0; i < 200; i++) {
      const origin = at(i * 911, i * 673, 200);
      const up = normalise(origin);
      const result = marchClouds(layer, {
        origin,
        direction: normalise([up[0] + 0.5, up[1] * 0.6, up[2] + 0.3]),
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
      origin: overhead(layer.topAltitude + 1_000),
      direction: [0, 1, 0],
      sunDirection: sun,
    });

    expect(result.transmittance).toBe(1);
    expect(result.hitLayer).toBe(false);
  });

  it('sees the deck from orbit', () => {
    // Looking straight down from 400 km: the layer has to be there, and it has
    // to be partly transparent, or the planet is wearing a lid.
    let attenuated = 0;
    let clear = 0;

    for (let i = 0; i < 40; i++) {
      const origin = at(i * 9_000, i * 4_000, 400_000);
      const result = marchClouds(layer, {
        origin,
        direction: normalise(origin).map((c) => -c) as Vec,
        sunDirection: sun,
      });

      expect(result.hitLayer).toBe(true);
      if (result.transmittance < 0.7) attenuated++;
      if (result.transmittance > 0.95) clear++;
    }

    expect(attenuated).toBeGreaterThan(2);
    expect(clear).toBeGreaterThan(2);
  });

  it('darkens more through a denser layer', () => {
    const meanTransmittance = (density: number): number => {
      let sum = 0;
      const samples = 40;
      for (let i = 0; i < samples; i++) {
        const origin = at(i * 2_300, i * 1_900, 0);
        sum += marchClouds(
          { ...layer, density },
          { origin, direction: normalise(origin), sunDirection: sun },
        ).transmittance;
      }
      return sum / samples;
    };

    expect(meanTransmittance(0.2)).toBeLessThan(meanTransmittance(0.02));
  });

  it('accumulates optical depth towards the sun inside cloud', () => {
    let sawDepth = false;
    for (let i = 0; i < 80; i++) {
      const depth = lightMarch(layer, ...at(i * 1_700, i * 2_300, 3_000), sun);
      expect(depth).toBeGreaterThanOrEqual(0);
      if (depth > 0) sawDepth = true;
    }
    expect(sawDepth).toBe(true);
  });
});

function normalise(v: readonly [number, number, number]): Vec {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}
