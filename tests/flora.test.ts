/**
 * Species and plant geometry tests.
 *
 * The thing being guarded is variety. Scattered vegetation gives itself away
 * not because the meshes repeat — at a distance they always will — but because
 * they repeat *identically*, and the eye finds that instantly. So most of what
 * is checked here is that two individuals of one species actually differ, in
 * several independent ways, and that a place grows a mix rather than one
 * winner.
 */
import { describe, expect, it } from 'vitest';
import {
  SPECIES,
  pickSpecies,
  sample,
  speciesById,
  suitability,
} from '../src/vegetation/species.js';
import type { Species } from '../src/vegetation/species.js';
import {
  buildPlant,
  drawTraits,
  hslToLinearRgb,
} from '../src/vegetation/plantGeometry.js';
import type { PlantTraits } from '../src/vegetation/plantGeometry.js';
import { hashUnit } from '../src/vegetation/scatter.js';

/** Traits for one individual, as the renderer draws them. */
function traitsFor(species: Species, salt: number): PlantTraits {
  const rolls: number[] = [];
  for (let i = 0; i < 9; i++) rolls.push(hashUnit(salt, i, 101));
  return drawTraits(species, rolls);
}

describe('the species catalogue', () => {
  it('offers several distinct forms', () => {
    // One form repeated is one silhouette repeated.
    const forms = new Set(SPECIES.map((species) => species.form));
    expect(forms.size).toBeGreaterThanOrEqual(4);
    expect(SPECIES.length).toBeGreaterThanOrEqual(6);
  });

  it('gives every species a real range to vary within', () => {
    for (const species of SPECIES) {
      expect(species.height.max, species.id).toBeGreaterThan(species.height.min);
      expect(species.spread.max, species.id).toBeGreaterThan(species.spread.min);
      expect(species.hue.max, species.id).toBeGreaterThan(species.hue.min);
    }
  });

  it('spans a useful spread of sizes', () => {
    // Ground cover through to canopy trees, or the world has one storey.
    const shortest = Math.min(...SPECIES.map((s) => s.height.min));
    const tallest = Math.max(...SPECIES.map((s) => s.height.max));

    expect(shortest).toBeLessThan(0.5);
    expect(tallest).toBeGreaterThan(10);
  });

  it('looks species up by id', () => {
    expect(speciesById('conifer').form).toBe('conifer');
    expect(() => speciesById('nonesuch' as never)).toThrow();
  });
});

describe('where species grow', () => {
  it('refuses ground outside its range', () => {
    const conifer = speciesById('conifer');

    expect(suitability(conifer, 0, 0, 0.3)).toBe(0);
    expect(suitability(conifer, 9_000, 0, 0.3)).toBe(0);
    expect(suitability(conifer, 800, 2, 0.3)).toBe(0);
  });

  it('fades at its limits rather than cutting', () => {
    // A hard edge draws a contour line across the hillside.
    const conifer = speciesById('conifer');
    const values = [1_800, 2_100, 2_300, 2_400].map((elevation) =>
      suitability(conifer, elevation, 0, 0.3),
    );

    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeLessThanOrEqual(values[i - 1]!);
    }
    expect(values[0]!).toBeGreaterThan(0);
    expect(values[values.length - 1]!).toBeCloseTo(0, 2);
  });

  it('separates cold and warm species', () => {
    const conifer = speciesById('conifer');
    const palm = speciesById('palm');

    expect(suitability(conifer, 600, 0.1, 0.2)).toBeGreaterThan(
      suitability(palm, 600, 0.1, 0.2),
    );
    expect(suitability(palm, 120, 0.1, 0.85)).toBeGreaterThan(
      suitability(conifer, 120, 0.1, 0.85),
    );
  });

  it('grows a mix in one place rather than a monoculture', () => {
    // Weighted selection, so a hillside is not a thousand copies of whichever
    // species happened to score highest.
    const chosen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const species = pickSpecies(i / 200, 500, 0.15, 0.55);
      if (species) chosen.add(species.id);
    }

    expect(chosen.size).toBeGreaterThanOrEqual(4);
  });

  it('shifts the mix as conditions change', () => {
    // Compared as distributions, not as single picks. Grass grows nearly
    // everywhere and is the most abundant species, so one roll lands on it in
    // both places — which says nothing about whether the mix differs.
    const mixAt = (elevation: number, warmth: number): Set<string> => {
      const found = new Set<string>();
      for (let i = 0; i < 200; i++) {
        const species = pickSpecies(i / 200, elevation, 0.1, warmth);
        if (species) found.add(species.id);
      }
      return found;
    };

    const coast = mixAt(60, 0.85);
    const alpine = mixAt(2_200, 0.2);

    // Palms on a warm coast, never at altitude in the cold.
    expect(coast.has('palm')).toBe(true);
    expect(alpine.has('palm')).toBe(false);

    // And the two communities are not the same set.
    const shared = [...coast].filter((id) => alpine.has(id)).length;
    expect(shared).toBeLessThan(coast.size);
  });

  it('grows nothing where nothing can', () => {
    expect(pickSpecies(0.5, -100, 0, 0.5)).toBeNull();
  });
});

describe('individual variation', () => {
  it('gives no two plants the same traits', () => {
    const conifer = speciesById('conifer');
    const seen = new Set<string>();

    for (let i = 0; i < 200; i++) {
      const traits = traitsFor(conifer, i);
      seen.add(`${traits.height.toFixed(3)}/${traits.spread.toFixed(3)}/${traits.limbs}`);
    }

    // Identical clones are what makes a forest read as wallpaper.
    expect(seen.size).toBeGreaterThan(150);
  });

  it('varies traits independently of one another', () => {
    // A tall plant must not always be a broad one, or every individual is the
    // same plant at a different scale.
    const conifer = speciesById('conifer');

    const samples = Array.from({ length: 300 }, (_, i) => traitsFor(conifer, i));
    const correlation = pearson(
      samples.map((t) => t.height),
      samples.map((t) => t.spread),
    );

    expect(Math.abs(correlation)).toBeLessThan(0.3);
  });

  it('varies foliage colour between individuals', () => {
    const broadleaf = speciesById('broadleaf');
    const greens = new Set<string>();

    for (let i = 0; i < 150; i++) {
      greens.add(traitsFor(broadleaf, i).foliage.map((c) => c.toFixed(3)).join(','));
    }

    expect(greens.size).toBeGreaterThan(100);
  });

  it('keeps every trait inside its species range', () => {
    for (const species of SPECIES) {
      for (let i = 0; i < 60; i++) {
        const traits = traitsFor(species, i * 7);

        expect(traits.height, species.id).toBeGreaterThanOrEqual(species.height.min - 1e-9);
        expect(traits.height, species.id).toBeLessThanOrEqual(species.height.max + 1e-9);
        expect(traits.limbs, species.id).toBeGreaterThanOrEqual(
          Math.round(species.limbs.min),
        );
      }
    }
  });

  it('is stable for the same ground', () => {
    const shrub = speciesById('shrub');
    expect(traitsFor(shrub, 42)).toEqual(traitsFor(shrub, 42));
  });

  it('samples a range across its whole span', () => {
    expect(sample({ min: 2, max: 6 }, 0)).toBe(2);
    expect(sample({ min: 2, max: 6 }, 1)).toBe(6);
    expect(sample({ min: 2, max: 6 }, 0.5)).toBe(4);
  });
});

describe('plant geometry', () => {
  it('grows a mesh for every species', () => {
    for (const species of SPECIES) {
      const mesh = buildPlant(species, traitsFor(species, 3));

      expect(mesh.positions.length, species.id).toBeGreaterThan(0);
      expect(mesh.indices.length, species.id).toBeGreaterThan(0);
      expect(mesh.indices.length % 3, species.id).toBe(0);
    }
  });

  it('keeps every buffer the same length', () => {
    for (const species of SPECIES) {
      const mesh = buildPlant(species, traitsFor(species, 11));
      const vertices = mesh.positions.length / 3;

      expect(mesh.normals.length, species.id).toBe(vertices * 3);
      expect(mesh.colors.length, species.id).toBe(vertices * 3);
      expect(mesh.sway.length, species.id).toBe(vertices);
    }
  });

  it('references only vertices it has', () => {
    for (const species of SPECIES) {
      const mesh = buildPlant(species, traitsFor(species, 5));
      const vertices = mesh.positions.length / 3;

      for (const index of mesh.indices) {
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(vertices);
      }
    }
  });

  it('is entirely finite', () => {
    for (const species of SPECIES) {
      const mesh = buildPlant(species, traitsFor(species, 9));

      for (const value of [...mesh.positions, ...mesh.normals, ...mesh.colors]) {
        expect(Number.isFinite(value), species.id).toBe(true);
      }
    }
  });

  it('stands every plant on the ground', () => {
    // A plant whose base is above zero floats; one below is buried.
    for (const species of SPECIES) {
      const mesh = buildPlant(species, traitsFor(species, 13));

      let lowest = Infinity;
      for (let i = 1; i < mesh.positions.length; i += 3) {
        lowest = Math.min(lowest, mesh.positions[i]!);
      }

      expect(lowest, species.id).toBeGreaterThan(-0.6);
      expect(lowest, species.id).toBeLessThan(0.3);
    }
  });

  it('keeps a plant within its own height and spread', () => {
    for (const species of SPECIES) {
      const traits = traitsFor(species, 17);
      const mesh = buildPlant(species, traits);

      let tallest = 0;
      let widest = 0;
      for (let i = 0; i < mesh.positions.length; i += 3) {
        tallest = Math.max(tallest, mesh.positions[i + 1]!);
        widest = Math.max(widest, Math.hypot(mesh.positions[i]!, mesh.positions[i + 2]!));
      }

      expect(tallest, species.id).toBeLessThan(traits.height * 1.4);
      expect(widest, species.id).toBeLessThan(traits.height * 2.2);
    }
  });

  it('anchors sway at the roots and frees it at the tips', () => {
    // A trunk that sways as freely as its leaves is a plant made of rubber.
    const conifer = speciesById('conifer');
    const mesh = buildPlant(conifer, traitsFor(conifer, 21));

    for (const sway of mesh.sway) {
      expect(sway).toBeGreaterThanOrEqual(0);
      expect(sway).toBeLessThanOrEqual(1);
    }

    expect(Math.min(...mesh.sway)).toBeLessThan(0.25);
    expect(Math.max(...mesh.sway)).toBeGreaterThan(0.7);
  });

  it('changes silhouette with traits, not just scale', () => {
    // Two individuals must differ in shape, or they are one plant resized.
    const conifer = speciesById('conifer');

    const sparse = buildPlant(conifer, { ...traitsFor(conifer, 1), limbs: 7 });
    const dense = buildPlant(conifer, { ...traitsFor(conifer, 1), limbs: 12 });

    expect(dense.positions.length).toBeGreaterThan(sparse.positions.length);
  });

  it('normalises every normal', () => {
    const mesh = buildPlant(speciesById('broadleaf'), traitsFor(speciesById('broadleaf'), 2));

    for (let i = 0; i < mesh.normals.length; i += 3) {
      const length = Math.hypot(mesh.normals[i]!, mesh.normals[i + 1]!, mesh.normals[i + 2]!);
      expect(length).toBeCloseTo(1, 5);
    }
  });
});

describe('colour conversion', () => {
  it('converts HSL to linear RGB', () => {
    const [r, g, b] = hslToLinearRgb(0.33, 0.5, 0.4);

    // A mid green: more green than either neighbour, and all in range.
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
    for (const channel of [r, g, b]) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(1);
    }
  });

  it('darkens as lightness falls', () => {
    const bright = hslToLinearRgb(0.3, 0.5, 0.7);
    const dark = hslToLinearRgb(0.3, 0.5, 0.2);

    expect(sum(dark)).toBeLessThan(sum(bright));
  });

  it('wraps hue rather than clamping it', () => {
    const a = hslToLinearRgb(0.1, 0.6, 0.5);
    const b = hslToLinearRgb(1.1, 0.6, 0.5);

    expect(b[0]).toBeCloseTo(a[0], 6);
    expect(b[1]).toBeCloseTo(a[1], 6);
  });
});

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Pearson correlation, for checking two traits vary independently. */
function pearson(a: readonly number[], b: readonly number[]): number {
  const n = a.length;
  const meanA = a.reduce((t, v) => t + v, 0) / n;
  const meanB = b.reduce((t, v) => t + v, 0) / n;

  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;

  for (let i = 0; i < n; i++) {
    const da = a[i]! - meanA;
    const db = b[i]! - meanB;
    covariance += da * db;
    varianceA += da * da;
    varianceB += db * db;
  }

  const denominator = Math.sqrt(varianceA * varianceB);
  return denominator > 0 ? covariance / denominator : 0;
}
