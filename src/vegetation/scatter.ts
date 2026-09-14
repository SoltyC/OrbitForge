/**
 * Where plants grow, and where each individual one stands.
 *
 * Placement is a pure function of position — hash a cell, get its contents —
 * rather than a list generated once and stored. Two reasons. A planet's worth
 * of grass does not fit in memory, and any scheme that generates it on the fly
 * from a random source puts every blade somewhere new each time a chunk is
 * rebuilt, so the ground crawls as the level of detail changes. Hashing the
 * cell means a given patch of ground answers the same way forever, whoever
 * asks and however often.
 *
 * Nothing here knows about meshes. It answers "what grows at this point", and
 * the renderer decides how to draw it.
 */
import { clamp01 } from '../clouds/noise.js';
import type { TerrainProfile } from '../terrain/height.js';
import { DEFAULT_TERRAIN } from '../terrain/height.js';

/** What kind of thing is standing at a point. */
export type PlantKind = 'grass' | 'shrub' | 'rock';

export interface VegetationProfile {
  /**
   * Spacing of the placement grid (m). One plant per cell at most.
   *
   * A metre apart, so a clump of grass sits roughly every square metre. At two
   * and a half the field read as scattered posts rather than ground cover —
   * the instance count is what buys the illusion, and it is cheap, since these
   * are drawn instanced.
   */
  readonly cellSize: number;
  /** Highest altitude anything grows at (m). */
  readonly treeLine: number;
  /** Ground steeper than this carries only rock (slope, 0 is flat). */
  readonly maxSlope: number;
  /** Fraction of cells that are occupied at best, in [0, 1]. */
  readonly density: number;
  /** Share of plants that are shrubs rather than grass, in [0, 1]. */
  readonly shrubShare: number;
  /** Height of a full-grown plant (m). */
  readonly grassHeight: number;
  readonly shrubHeight: number;
  readonly rockHeight: number;
  readonly seed: number;
}

export const DEFAULT_VEGETATION: VegetationProfile = {
  cellSize: 1,
  treeLine: 2_600,
  maxSlope: 0.55,
  density: 0.72,
  shrubShare: 0.12,
  grassHeight: 0.55,
  shrubHeight: 1.5,
  rockHeight: 0.7,
  seed: 4242,
};

export interface Plant {
  /** Offset from the cell's corner, in metres, on the ground plane. */
  readonly offsetU: number;
  readonly offsetV: number;
  readonly kind: PlantKind;
  /** Height in metres, already varied per instance. */
  readonly height: number;
  /** Rotation about the surface normal (rad). */
  readonly rotation: number;
  /** How much this one leans, for wind and for variety (rad). */
  readonly lean: number;
}

/**
 * Whether ground can support plants at all, and how densely.
 *
 * Returns 0 where nothing grows: under water, above the tree line, and on
 * anything too steep for soil to stay on. The fade at each limit matters more
 * than the limit itself — a hard cutoff draws a contour line across the
 * hillside, which is the giveaway that the rule is a rule rather than a place.
 */
export function growthDensity(
  elevation: number,
  slope: number,
  profile: VegetationProfile = DEFAULT_VEGETATION,
  terrain: TerrainProfile = DEFAULT_TERRAIN,
): number {
  if (elevation <= 0) return 0;

  // Fade in off the beach, and out approaching the tree line.
  const shore = smoothstep(0, 25, elevation);
  const alpine = 1 - smoothstep(profile.treeLine * 0.7, profile.treeLine, elevation);
  const footing = 1 - smoothstep(profile.maxSlope * 0.6, profile.maxSlope, slope);

  void terrain;
  return clamp01(shore * alpine * footing);
}

/**
 * What stands in a given cell of the placement grid, or null if it is empty.
 *
 * @param cellX,cellY Integer cell coordinates on the local ground plane.
 * @param density Growth density there, from `growthDensity`.
 */
export function plantInCell(
  cellX: number,
  cellY: number,
  density: number,
  profile: VegetationProfile = DEFAULT_VEGETATION,
): Plant | null {
  if (density <= 0) return null;

  const occupancy = hashUnit(cellX, cellY, profile.seed);
  if (occupancy > density * profile.density) return null;

  const kindRoll = hashUnit(cellX, cellY, profile.seed + 17);
  const kind = pickKind(kindRoll, density, profile);

  const baseHeight =
    kind === 'grass'
      ? profile.grassHeight
      : kind === 'shrub'
        ? profile.shrubHeight
        : profile.rockHeight;

  // Every plant differs in size, place within its cell, and facing. Without
  // that the scatter reads as a grid however well hidden the grid itself is.
  const sizeRoll = hashUnit(cellX, cellY, profile.seed + 31);

  return {
    offsetU: hashUnit(cellX, cellY, profile.seed + 53) * profile.cellSize,
    offsetV: hashUnit(cellX, cellY, profile.seed + 71) * profile.cellSize,
    kind,
    height: baseHeight * (0.6 + sizeRoll * 0.8),
    rotation: hashUnit(cellX, cellY, profile.seed + 97) * Math.PI * 2,
    lean: (hashUnit(cellX, cellY, profile.seed + 113) - 0.5) * 0.25,
  };
}

/**
 * Grass, shrub or rock.
 *
 * Rock takes over as the ground gets too poor for anything else, so the
 * transition from meadow to scree happens through the mix rather than at a
 * line drawn across it.
 */
function pickKind(
  roll: number,
  density: number,
  profile: VegetationProfile,
): PlantKind {
  const rockShare = 1 - density;
  if (roll < rockShare) return 'rock';
  if (roll < rockShare + profile.shrubShare) return 'shrub';
  return 'grass';
}

/**
 * Wind displacement at the top of a plant, as a fraction of its height.
 *
 * A travelling wave rather than a per-plant wobble: neighbouring plants lean
 * together and the gust visibly crosses the field, which is most of what makes
 * it look like wind rather than like jitter.
 */
export function windSway(
  x: number,
  z: number,
  time: number,
  strength = 0.18,
): number {
  const wave =
    Math.sin(x * 0.08 + time * 1.1) * 0.6 + Math.sin(z * 0.05 - time * 0.7) * 0.4;

  // Gusts: a slower envelope, so the field is not uniformly agitated.
  const gust = 0.7 + 0.3 * Math.sin(x * 0.01 + z * 0.013 + time * 0.23);

  return wave * gust * strength;
}

/** Deterministic hash of a cell to [0, 1). */
export function hashUnit(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 144665) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
