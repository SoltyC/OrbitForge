/**
 * Plant species, and the traits that make individuals of one differ.
 *
 * The thing that makes scattered vegetation read as tiling is not that the
 * meshes repeat — at a distance they always will — but that they repeat
 * *identically*. Two pines of the same height, the same green, the same
 * silhouette, twenty metres apart, and the eye finds the pattern immediately.
 *
 * So every species describes a range rather than a shape, and each individual
 * draws its own values from the hash of the ground it stands on: how tall, how
 * broad, how many branches, what shade of green, how far it leans. Nothing is
 * shared between two plants except the rules they were grown by.
 */
import { clamp01 } from '../clouds/noise.js';

export type SpeciesId =
  | 'conifer'
  | 'broadleaf'
  | 'palm'
  | 'shrub'
  | 'fern'
  | 'flowering'
  | 'grass'
  | 'boulder';

/** Which broad form a species is built from. */
export type PlantForm = 'conifer' | 'canopy' | 'frond' | 'tuft' | 'rock';

export interface Range {
  readonly min: number;
  readonly max: number;
}

export interface Species {
  readonly id: SpeciesId;
  readonly form: PlantForm;

  /** Overall height (m). */
  readonly height: Range;
  /** Crown or clump width, as a fraction of height. */
  readonly spread: Range;
  /** Branch or frond count, where the form has them. */
  readonly limbs: Range;

  /** Foliage colour, as HSL. Hue and lightness vary per individual. */
  readonly hue: Range;
  readonly saturation: Range;
  readonly lightness: Range;

  /** Bark or stem colour, as a packed hex. */
  readonly woodColour: number;

  /** Where this species will grow. */
  readonly minElevation: number;
  readonly maxElevation: number;
  /** Steepest ground it tolerates, as rise over run. */
  readonly maxSlope: number;
  /** Warmth preference in [0, 1], against the biome's own warmth. */
  readonly warmth: Range;

  /**
   * How much of the local plant population this species takes when conditions
   * suit it. Relative, not absolute — these are normalised at selection.
   */
  readonly abundance: number;

  /**
   * Metres between individuals of this species.
   *
   * The single most important number here. Ground cover can sit a metre apart;
   * a mature tree cannot, and placing one in every cell put ninety thousand
   * plants and sixteen million triangles around the launchpad — a wall of
   * canopy with no ground visible between it, which is both unaffordable and
   * wrong. Each species is placed on its own coarser grid, so a forest has
   * trees with space between them and grass filling the gaps.
   */
  readonly spacing: number;
}

/**
 * The catalogue.
 *
 * Eight species covering the range a temperate world needs: two canopy trees
 * with different silhouettes, a coastal palm, understorey shrubs and ferns,
 * flowering ground cover, grass, and boulders for the ground too poor for any
 * of it.
 */
export const SPECIES: readonly Species[] = [
  {
    id: 'conifer',
    form: 'conifer',
    height: { min: 7, max: 19 },
    spread: { min: 0.22, max: 0.38 },
    limbs: { min: 7, max: 12 },
    hue: { min: 0.29, max: 0.38 },
    saturation: { min: 0.32, max: 0.55 },
    lightness: { min: 0.13, max: 0.28 },
    woodColour: 0x4a3728,
    minElevation: 120,
    maxElevation: 2_400,
    maxSlope: 0.6,
    warmth: { min: 0, max: 0.55 },
    abundance: 1,
    spacing: 11,
  },
  {
    id: 'broadleaf',
    form: 'canopy',
    height: { min: 5, max: 14 },
    spread: { min: 0.5, max: 0.85 },
    limbs: { min: 4, max: 7 },
    hue: { min: 0.2, max: 0.31 },
    saturation: { min: 0.35, max: 0.62 },
    lightness: { min: 0.22, max: 0.4 },
    woodColour: 0x5b4636,
    minElevation: 40,
    maxElevation: 1_400,
    maxSlope: 0.45,
    warmth: { min: 0.3, max: 0.9 },
    abundance: 1.1,
    spacing: 13,
  },
  {
    id: 'palm',
    form: 'frond',
    height: { min: 4, max: 9 },
    spread: { min: 0.55, max: 0.9 },
    limbs: { min: 6, max: 11 },
    hue: { min: 0.22, max: 0.29 },
    saturation: { min: 0.45, max: 0.7 },
    lightness: { min: 0.3, max: 0.45 },
    woodColour: 0x6b5a42,
    minElevation: 5,
    maxElevation: 260,
    maxSlope: 0.3,
    warmth: { min: 0.62, max: 1 },
    abundance: 0.7,
    spacing: 10,
  },
  {
    id: 'shrub',
    form: 'canopy',
    height: { min: 0.8, max: 2.4 },
    spread: { min: 0.7, max: 1.2 },
    limbs: { min: 3, max: 6 },
    hue: { min: 0.18, max: 0.32 },
    saturation: { min: 0.3, max: 0.6 },
    lightness: { min: 0.18, max: 0.34 },
    woodColour: 0x4f4030,
    minElevation: 15,
    maxElevation: 2_600,
    maxSlope: 0.7,
    warmth: { min: 0, max: 1 },
    abundance: 1.8,
    spacing: 4,
  },
  {
    id: 'fern',
    form: 'frond',
    height: { min: 0.5, max: 1.3 },
    spread: { min: 0.9, max: 1.5 },
    limbs: { min: 5, max: 9 },
    hue: { min: 0.24, max: 0.34 },
    saturation: { min: 0.4, max: 0.65 },
    lightness: { min: 0.2, max: 0.36 },
    woodColour: 0x3f5230,
    minElevation: 20,
    maxElevation: 1_100,
    maxSlope: 0.55,
    warmth: { min: 0.35, max: 1 },
    abundance: 1.4,
    spacing: 3,
  },
  {
    id: 'flowering',
    form: 'tuft',
    height: { min: 0.25, max: 0.6 },
    spread: { min: 0.8, max: 1.4 },
    limbs: { min: 4, max: 8 },
    // Flowers break the green: the hue range crosses into yellows and violets.
    hue: { min: 0.06, max: 0.78 },
    saturation: { min: 0.45, max: 0.85 },
    lightness: { min: 0.45, max: 0.72 },
    woodColour: 0x53673a,
    minElevation: 25,
    maxElevation: 2_100,
    maxSlope: 0.5,
    warmth: { min: 0.25, max: 0.95 },
    abundance: 0.9,
    spacing: 2,
  },
  {
    id: 'grass',
    form: 'tuft',
    height: { min: 0.2, max: 0.7 },
    spread: { min: 0.5, max: 1 },
    limbs: { min: 5, max: 11 },
    hue: { min: 0.17, max: 0.29 },
    saturation: { min: 0.3, max: 0.62 },
    lightness: { min: 0.25, max: 0.48 },
    woodColour: 0x5d6b38,
    minElevation: 2,
    maxElevation: 2_600,
    maxSlope: 0.65,
    warmth: { min: 0, max: 1 },
    abundance: 4,
    spacing: 1,
  },
  {
    id: 'boulder',
    form: 'rock',
    height: { min: 0.4, max: 2.2 },
    spread: { min: 0.9, max: 1.6 },
    limbs: { min: 1, max: 1 },
    hue: { min: 0.05, max: 0.12 },
    saturation: { min: 0.02, max: 0.12 },
    lightness: { min: 0.3, max: 0.55 },
    woodColour: 0x6e6963,
    minElevation: 0,
    maxElevation: 9_000,
    maxSlope: 2,
    warmth: { min: 0, max: 1 },
    abundance: 0.8,
    spacing: 7,
  },
];

export function speciesById(id: SpeciesId): Species {
  const species = SPECIES.find((candidate) => candidate.id === id);
  if (!species) throw new Error(`No such species: ${id}`);
  return species;
}

/**
 * How well a species suits a place, in [0, 1].
 *
 * Zero outside its range. The edges fade rather than cut, so a forest thins
 * into scrub as it climbs instead of stopping along a contour.
 */
export function suitability(
  species: Species,
  elevation: number,
  slope: number,
  warmth: number,
): number {
  const low = fade(elevation, species.minElevation, species.minElevation + 60);
  const high = 1 - fade(elevation, species.maxElevation - 300, species.maxElevation);
  const footing = 1 - fade(slope, species.maxSlope * 0.7, species.maxSlope);

  const warm =
    fade(warmth, species.warmth.min - 0.12, species.warmth.min + 0.05) *
    (1 - fade(warmth, species.warmth.max - 0.05, species.warmth.max + 0.12));

  return clamp01(low * high * footing * warm);
}

/**
 * Whether a cell is on a given species' own placement grid.
 *
 * Each species is offset by its own hash, so they do not all land on the same
 * cells — otherwise every tree would have a bush growing out of it and most of
 * the ground would be bare.
 */
export function onSpeciesGrid(
  species: Species,
  cellX: number,
  cellY: number,
  cellSize: number,
): boolean {
  const stride = speciesStride(species, cellSize);
  if (stride === 1) return true;

  const [offsetX, offsetY] = speciesGridOffset(species, stride);

  return (
    (((cellX - offsetX) % stride) + stride) % stride === 0 &&
    (((cellY - offsetY) % stride) + stride) % stride === 0
  );
}

/** Cells between individuals of a species, given the placement grid's spacing. */
export function speciesStride(species: Species, cellSize: number): number {
  return Math.max(1, Math.round(species.spacing / cellSize));
}

/**
 * A species' fixed offset on its own grid, so they do not all land on the same
 * cells.
 *
 * Exported because the placement walk enumerates these grids directly rather
 * than testing every cell against them, and the two have to agree exactly. A
 * walk offset by even one cell from the test finds nothing at all.
 */
export function speciesGridOffset(species: Species, stride: number): [number, number] {
  let hash = 0;
  for (let i = 0; i < species.id.length; i++) {
    hash = (hash * 31 + species.id.charCodeAt(i)) | 0;
  }

  return [
    ((hash % stride) + stride) % stride,
    (((hash >> 8) % stride) + stride) % stride,
  ];
}

/**
 * Pick a species for one cell, given a roll in [0, 1].
 *
 * Only species whose own placement grid includes this cell are candidates, and
 * among those the choice is weighted by suitability times abundance — so a
 * place grows the mix that suits it rather than one winner, and each kind sits
 * at its own natural spacing.
 */
export function pickSpecies(
  roll: number,
  elevation: number,
  slope: number,
  warmth: number,
  cellX = 0,
  cellY = 0,
  cellSize = 1,
): Species | null {
  const weights = SPECIES.map((species) => {
    if (!onSpeciesGrid(species, cellX, cellY, cellSize)) return 0;

    // Scale by how rarely this species is even offered a cell.
    //
    // A tree on an eleven-metre grid is a candidate in one cell in a hundred,
    // and in that cell it still has to out-roll grass — which is a candidate
    // everywhere and four times as abundant. Without this correction the
    // common species win the rare species' own cells too, and a forest comes
    // out as a lawn: measured at zero trees anywhere near the launch site.
    const stride = Math.max(1, Math.round(species.spacing / cellSize));
    const rarity = stride * stride;

    return suitability(species, elevation, slope, warmth) * species.abundance * rarity;
  });

  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return null;

  let cursor = clamp01(roll) * total;
  for (let i = 0; i < SPECIES.length; i++) {
    cursor -= weights[i]!;
    if (cursor <= 0) return SPECIES[i]!;
  }

  return SPECIES[SPECIES.length - 1]!;
}

/** Draw a value from a range using a roll in [0, 1]. */
export function sample(range: Range, roll: number): number {
  return range.min + (range.max - range.min) * clamp01(roll);
}

/** Smooth 0-to-1 ramp, for fading a limit instead of cutting at it. */
function fade(value: number, edge0: number, edge1: number): number {
  if (edge1 <= edge0) return value >= edge1 ? 1 : 0;
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
