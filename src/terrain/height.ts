/**
 * The terrain height field.
 *
 * Sampled in three dimensions at a point's direction from the planet's centre,
 * not in two on a projected grid. Three-dimensional noise read at a
 * three-dimensional position is the same arithmetic everywhere on the globe —
 * no seams between cube faces, no distortion at the poles, and nothing special
 * to do where faces meet. The same reasoning the cloud layer arrived at.
 *
 * Two ingredients do most of the work:
 *
 *   - *Ridged* noise, which folds each octave about its midpoint so the peaks
 *     come to creases instead of rounded humps. Plain fractal noise makes
 *     rolling dunes; mountains have ridgelines, and this is where they come
 *     from.
 *   - *Domain warping*, which offsets the lookup by another noise field. That
 *     bends what would otherwise be visibly grid-aligned ridges into the
 *     meandering shapes erosion actually leaves.
 */
import { perlin3 } from '../clouds/noise.js';

/**
 * Lattice period for the underlying noise.
 *
 * The noise tiles, but terrain is sampled on a sphere of unit directions
 * scaled by frequency — so a period this large never repeats within a planet.
 */
const NOISE_PERIOD = 256;

export interface TerrainProfile {
  /** Vertical scale of the continental rise, sea level to plateau (m). */
  readonly continentAmplitude: number;
  /** Extra relief that mountain ranges add on top of that (m). */
  readonly mountainAmplitude: number;
  /** How deep the ocean basins go (m). */
  readonly oceanDepth: number;

  /** Features per unit sphere for the continent field; lower is bigger. */
  readonly continentFrequency: number;
  /** Features per unit sphere for the mountain field. */
  readonly mountainFrequency: number;

  readonly continentOctaves: number;
  readonly mountainOctaves: number;
  readonly lacunarity: number;
  readonly gain: number;

  /** How far the domain warp displaces the lookup, in noise units. */
  readonly warpStrength: number;
  /**
   * Height on the continent field, in [0, 1], that counts as the shoreline.
   * Raising it floods the planet.
   */
  readonly seaLevel: number;
  readonly seed: number;
}

/** Terrin: scattered continents with mountain ranges inland. */
export const DEFAULT_TERRAIN: TerrainProfile = {
  continentAmplitude: 2_200,
  mountainAmplitude: 5_400,
  oceanDepth: 3_000,

  continentFrequency: 1.35,
  mountainFrequency: 5.5,

  continentOctaves: 5,
  mountainOctaves: 7,
  lacunarity: 2.03,
  gain: 0.5,

  warpStrength: 0.35,
  // Set from the continent field's own distribution rather than guessed: this
  // is its 70th percentile, which leaves about 30% of the surface above water.
  seaLevel: 0.547,
  seed: 20260913,
};

/**
 * Fold a [0, 1] noise sample about its midpoint and square it.
 *
 * The fold is what creates the crease — the derivative flips sign at the
 * midpoint rather than turning over smoothly — and squaring sharpens the peaks
 * while flattening the valleys, which is the asymmetry real relief has.
 */
function ridge(value: number): number {
  const folded = 1 - Math.abs(value * 2 - 1);
  return folded * folded;
}

/**
 * Plain fractal noise in [0, 1], for the continental shape.
 *
 * Kept to few octaves deliberately. Summing many of them drives the result
 * towards its mean — the central limit theorem applies to noise octaves like
 * anything else — and the first version of this field used eight, which left
 * the whole planet inside a band of 0.22 to 0.79 and using barely a quarter of
 * its vertical range.
 */
export function continentField(
  x: number,
  y: number,
  z: number,
  frequency: number,
  octaves: number,
  profile: TerrainProfile,
  seed: number,
): number {
  let total = 0;
  let normalisation = 0;
  let amplitude = 1;
  let f = frequency;

  for (let i = 0; i < octaves; i++) {
    total += perlin3(x * f, y * f, z * f, NOISE_PERIOD, seed + i * 31) * amplitude;
    normalisation += amplitude;

    amplitude *= profile.gain;
    f *= profile.lacunarity;
  }

  return normalisation > 0 ? total / normalisation : 0;
}

/**
 * Ridged fractal noise in [0, 1], for mountain ranges.
 *
 * Each octave is weighted by the one before it, so detail piles up along high
 * ground and leaves the flats smooth. Without that the same roughness is
 * scattered evenly and the result reads as noise rather than as landscape.
 */
export function ridgedNoise(
  x: number,
  y: number,
  z: number,
  profile: TerrainProfile,
  seed: number,
): number {
  let total = 0;
  let normalisation = 0;
  let amplitude = 1;
  let frequency = profile.mountainFrequency;
  let weight = 1;

  for (let i = 0; i < profile.mountainOctaves; i++) {
    const shaped = ridge(
      perlin3(x * frequency, y * frequency, z * frequency, NOISE_PERIOD, seed + i * 37),
    );

    total += shaped * amplitude * weight;
    normalisation += amplitude;

    weight = clamp01(shaped * 1.6);

    amplitude *= profile.gain;
    frequency *= profile.lacunarity;
  }

  return normalisation > 0 ? clamp01(total / normalisation) : 0;
}

/** Smooth 0-to-1 ramp between two thresholds. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Surface elevation above sea level at a direction from the planet's centre.
 *
 * Built from two fields rather than one. A single fractal has to decide the
 * coastlines and the mountains at once, and tuning either moves the other —
 * raising the relief floods or drains the planet. Separating them means sea
 * level sets how much land there is and the mountain field sets how dramatic
 * it is, independently.
 *
 * Negative below sea level. The caller decides what to do with that; the
 * renderer flattens it to an ocean surface rather than drawing a sea bed.
 */
export function elevationAt(
  direction: { x: number; y: number; z: number },
  profile: TerrainProfile = DEFAULT_TERRAIN,
): number {
  // Domain warp: offset the lookup by a second, coarser noise field, which
  // bends grid-aligned ridges into meandering ones.
  const warp = profile.warpStrength;
  const x = direction.x + warp * signedNoise(direction, profile.seed + 701);
  const y = direction.y + warp * signedNoise(direction, profile.seed + 809);
  const z = direction.z + warp * signedNoise(direction, profile.seed + 911);

  const continent = continentField(
    x,
    y,
    z,
    profile.continentFrequency,
    profile.continentOctaves,
    profile,
    profile.seed,
  );

  // How far above the shoreline this point sits, normalised to [0, 1] inland.
  const land = (continent - profile.seaLevel) / Math.max(1e-6, 1 - profile.seaLevel);

  if (land <= 0) {
    // Below the shoreline: basins deepen away from the coast.
    return land * profile.oceanDepth;
  }

  const mountains = ridgedNoise(x, y, z, profile, profile.seed + 1301);

  // Ranges rise inland rather than straight out of the sea.
  const inland = smoothstep(0, 0.3, land);

  return (
    land * profile.continentAmplitude +
    mountains * profile.mountainAmplitude * inland
  );
}

/** Terrain radius at a direction: the planet's radius plus its elevation. */
export function terrainRadius(
  planetRadius: number,
  direction: { x: number; y: number; z: number },
  profile: TerrainProfile = DEFAULT_TERRAIN,
): number {
  return planetRadius + Math.max(0, elevationAt(direction, profile));
}

/** Noise in [-1, 1], for offsetting a lookup in either direction. */
function signedNoise(
  direction: { x: number; y: number; z: number },
  seed: number,
): number {
  const frequency = 0.9;
  return (
    perlin3(
      direction.x * frequency,
      direction.y * frequency,
      direction.z * frequency,
      NOISE_PERIOD,
      seed,
    ) *
      2 -
    1
  );
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
