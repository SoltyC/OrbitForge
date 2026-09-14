/**
 * Vegetation scatter tests.
 *
 * The property that matters most is stability. A plant is placed by hashing
 * the ground it stands on, so the same patch answers the same way forever —
 * and it has to, because terrain chunks are rebuilt constantly as detail
 * changes. Anything that generates placement from a random source instead puts
 * every blade somewhere new each rebuild, and the whole field crawls underfoot.
 *
 * After that: nothing grows in the sea, on cliffs, or above the tree line, and
 * every limit fades rather than drawing a contour line across the hillside.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VEGETATION,
  growthDensity,
  hashUnit,
  plantInCell,
  windSway,
} from '../src/vegetation/scatter.js';
import type { PlantKind } from '../src/vegetation/scatter.js';

const profile = DEFAULT_VEGETATION;

/** Plants over a patch of ground, as the renderer would gather them. */
function patch(
  cells: number,
  density: number,
): { plants: number; kinds: Record<PlantKind, number> } {
  const kinds: Record<PlantKind, number> = { grass: 0, shrub: 0, rock: 0 };
  let plants = 0;

  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const plant = plantInCell(x, y, density);
      if (!plant) continue;
      plants++;
      kinds[plant.kind]++;
    }
  }

  return { plants, kinds };
}

describe('placement stability', () => {
  it('answers identically for the same cell every time', () => {
    // Terrain chunks are rebuilt whenever detail changes. If placement is not
    // a pure function of the ground, the field crawls with every rebuild.
    for (const [x, y] of [
      [0, 0],
      [17, -4],
      [-1_203, 8_814],
    ]) {
      const first = plantInCell(x!, y!, 0.8);
      const second = plantInCell(x!, y!, 0.8);

      expect(second).toEqual(first);
    }
  });

  it('does not depend on the order cells are visited', () => {
    const forwards: (string | null)[] = [];
    for (let i = 0; i < 200; i++) forwards.push(describePlant(i, 3));

    const backwards: (string | null)[] = [];
    for (let i = 199; i >= 0; i--) backwards.unshift(describePlant(i, 3));

    expect(backwards).toEqual(forwards);
  });

  it('gives neighbouring cells unrelated contents', () => {
    // A hash that correlates between adjacent cells lays the scatter out in
    // visible rows.
    const offsets: number[] = [];
    for (let i = 0; i < 400; i++) {
      const a = plantInCell(i, 0, 1);
      const b = plantInCell(i + 1, 0, 1);
      if (a && b) offsets.push(Math.abs(a.offsetU - b.offsetU));
    }

    const mean = offsets.reduce((t, v) => t + v, 0) / offsets.length;
    // Independent uniforms average a third of the range apart.
    expect(mean).toBeGreaterThan(profile.cellSize * 0.25);
  });

  it('spreads the hash evenly over the unit range', () => {
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 10_000; i++) {
      buckets[Math.floor(hashUnit(i % 100, Math.floor(i / 100), 1) * 10)]++;
    }

    for (const count of buckets) {
      expect(count).toBeGreaterThan(700);
      expect(count).toBeLessThan(1_300);
    }
  });
});

describe('where things grow', () => {
  it('puts nothing in the sea', () => {
    expect(growthDensity(0, 0)).toBe(0);
    expect(growthDensity(-200, 0)).toBe(0);
  });

  it('puts nothing above the tree line', () => {
    expect(growthDensity(profile.treeLine + 100, 0)).toBe(0);
  });

  it('puts nothing on a cliff', () => {
    expect(growthDensity(500, profile.maxSlope + 0.1)).toBe(0);
  });

  it('grows densely on flat lowland', () => {
    expect(growthDensity(400, 0.05)).toBeGreaterThan(0.9);
  });

  it('fades in off the beach rather than starting at a line', () => {
    // A hard edge at the shoreline is the giveaway that the rule is a rule.
    const beach = growthDensity(2, 0);
    const inland = growthDensity(60, 0);

    expect(beach).toBeLessThan(inland);
    expect(beach).toBeGreaterThanOrEqual(0);
    expect(inland).toBeGreaterThan(0.9);
  });

  it('fades out approaching the tree line', () => {
    let previous = Infinity;
    for (const elevation of [1_600, 2_000, 2_300, 2_500, 2_600]) {
      const density = growthDensity(elevation, 0);
      expect(density).toBeLessThanOrEqual(previous);
      previous = density;
    }
    expect(previous).toBe(0);
  });

  it('fades out as the ground steepens', () => {
    let previous = Infinity;
    for (const slope of [0, 0.2, 0.35, 0.45, 0.55]) {
      const density = growthDensity(600, slope);
      expect(density).toBeLessThanOrEqual(previous);
      previous = density;
    }
  });

  it('never leaves the unit range', () => {
    for (const elevation of [-500, 0, 100, 1_000, 5_000]) {
      for (const slope of [0, 0.3, 1, 2]) {
        const density = growthDensity(elevation, slope);
        expect(density).toBeGreaterThanOrEqual(0);
        expect(density).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('what stands in a cell', () => {
  it('leaves barren ground empty', () => {
    for (let i = 0; i < 100; i++) expect(plantInCell(i, 0, 0)).toBeNull();
  });

  it('fills roughly the profile’s share of good ground', () => {
    const { plants } = patch(60, 1);
    const occupancy = plants / (60 * 60);

    expect(occupancy).toBeGreaterThan(profile.density * 0.8);
    expect(occupancy).toBeLessThan(profile.density * 1.2);
  });

  it('thins out as the ground worsens', () => {
    expect(patch(60, 0.3).plants).toBeLessThan(patch(60, 0.9).plants);
  });

  it('turns from meadow to scree through the mix, not at a line', () => {
    // Poor ground carries proportionally more rock and less grass, so the
    // transition happens through what grows rather than where it stops.
    const rich = patch(60, 0.95).kinds;
    const poor = patch(60, 0.35).kinds;

    expect(rich.grass / Math.max(1, rich.rock)).toBeGreaterThan(
      poor.grass / Math.max(1, poor.rock),
    );
    expect(poor.rock).toBeGreaterThan(0);
  });

  it('keeps every plant inside its own cell', () => {
    // A plant that strays outside its cell is one a neighbouring chunk will
    // not know to draw, and it vanishes at the seam.
    for (let i = 0; i < 500; i++) {
      const plant = plantInCell(i, i * 3, 1);
      if (!plant) continue;

      expect(plant.offsetU).toBeGreaterThanOrEqual(0);
      expect(plant.offsetU).toBeLessThan(profile.cellSize);
      expect(plant.offsetV).toBeGreaterThanOrEqual(0);
      expect(plant.offsetV).toBeLessThan(profile.cellSize);
    }
  });

  it('varies size, facing and lean between individuals', () => {
    const heights = new Set<number>();
    const rotations = new Set<number>();

    for (let i = 0; i < 200; i++) {
      const plant = plantInCell(i, 7, 1);
      if (!plant) continue;
      heights.add(plant.height);
      rotations.add(plant.rotation);
    }

    // Identical clones on a grid read as a texture, not as a field.
    expect(heights.size).toBeGreaterThan(50);
    expect(rotations.size).toBeGreaterThan(50);
  });

  it('keeps heights positive and plausible', () => {
    for (let i = 0; i < 400; i++) {
      const plant = plantInCell(i, -i, 1);
      if (!plant) continue;

      expect(plant.height).toBeGreaterThan(0);
      expect(plant.height).toBeLessThan(profile.shrubHeight * 2);
      expect(plant.rotation).toBeGreaterThanOrEqual(0);
      expect(plant.rotation).toBeLessThan(Math.PI * 2 + 1e-9);
    }
  });
});

describe('wind', () => {
  it('moves plants together rather than independently', () => {
    // Neighbours must lean alike, or the field shimmers instead of swaying.
    const here = windSway(100, 100, 3);
    const next = windSway(100.5, 100, 3);

    expect(Math.abs(next - here)).toBeLessThan(0.05);
  });

  it('travels across the ground over time', () => {
    const samples = [0, 0.5, 1, 1.5, 2].map((t) => windSway(40, 40, t));
    expect(new Set(samples).size).toBe(samples.length);
  });

  it('differs from one side of a field to the other', () => {
    // A single global value is a field that pulses rather than one a gust
    // crosses.
    const values = [0, 30, 60, 90, 120].map((x) => windSway(x, 0, 2));
    const spread = Math.max(...values) - Math.min(...values);

    expect(spread).toBeGreaterThan(0.05);
  });

  it('stays bounded', () => {
    for (let i = 0; i < 500; i++) {
      const sway = windSway(i * 7, i * 3, i * 0.1);
      expect(Math.abs(sway)).toBeLessThan(0.4);
    }
  });
});

function describePlant(x: number, y: number): string | null {
  const plant = plantInCell(x, y, 0.7);
  return plant ? `${plant.kind}:${plant.height.toFixed(4)}:${plant.rotation.toFixed(4)}` : null;
}
