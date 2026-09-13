/**
 * The cloud density field.
 *
 * Density comes from four things multiplied together:
 *
 *   1. A base shape from Perlin-Worley noise — the overall billowy form.
 *   2. A height gradient — where in the slab this cloud type lives, and what
 *      profile it has. Stratus are flat and low; cumulus are tall with narrow
 *      bases and wide anvil tops.
 *   3. A weather map — coverage and cloud type varying across the sky, so the
 *      sky is not uniformly overcast everywhere.
 *   4. Detail erosion — high-frequency Worley subtracted from the edges, which
 *      turns smooth blobs into wispy, cauliflower silhouettes.
 *
 * Keeping this separate from the raymarch means the field itself can be probed
 * and tested directly, which is the only way to know a cloud is shaped right
 * rather than merely present.
 */
import { clamp01, perlinWorley, remap, worley3, worleyFbm } from './noise.js';

export interface CloudLayer {
  /** Altitude of the cloud slab's base (m). */
  readonly bottomAltitude: number;
  /** Altitude of its top (m). */
  readonly topAltitude: number;
  /**
   * Horizontal size of one repeat of the base shape (m).
   *
   * This is roughly how big an individual cloud is, and it has to be sized
   * against how far away the clouds are seen from. Standing under a deck a
   * kilometre or two up, a feature scale of tens of kilometres subtends more
   * than the whole field of view — the viewer ends up inside a single blob and
   * the sky reads as flat overcast, however good the noise underneath is. Real
   * cumulus run a few kilometres across.
   */
  readonly shapeScale: number;
  /** Horizontal size of one repeat of the erosion detail (m). */
  readonly detailScale: number;
  /** Size of one repeat of the weather map (m). */
  readonly weatherScale: number;
  /** Global coverage bias in [0, 1]; higher is cloudier. */
  readonly coverage: number;
  /** How strongly detail noise erodes the edges, in [0, 1]. */
  readonly erosion: number;
  /**
   * Peak extinction of the medium (m^-1).
   *
   * Deliberately far below a real cloud's. Actual cumulus runs around
   * 0.05 m^-1, which over a 3.5 km slab is an optical depth near 200 — and
   * real clouds look white at that depth only because water droplets scatter
   * almost without absorbing, so photons bounce dozens of times and most still
   * escape. A three-octave approximation cannot represent that: fed a depth of
   * 200 it returns exp(-200), and every cloud renders as a black ceiling.
   *
   * Lowering the density until optical depths land in the range the scattering
   * model actually handles is the usual, well-understood trade. It is a cheat,
   * but it is the cheat that makes clouds look like clouds.
   */
  readonly density: number;
  /**
   * How far to march towards the sun when estimating self-shadowing (m).
   * Short on purpose, for the same reason the density is low.
   */
  readonly lightMarchDistance: number;
  readonly seed: number;
}

/** A temperate day: broken cumulus with clear gaps. */
export const DEFAULT_CLOUD_LAYER: CloudLayer = {
  bottomAltitude: 1_500,
  topAltitude: 5_000,
  shapeScale: 7_000,
  detailScale: 1_100,
  weatherScale: 38_000,
  coverage: 0.46,
  erosion: 0.35,
  density: 0.0035,
  lightMarchDistance: 700,
  seed: 1337,
};

export interface WeatherSample {
  /** Local cloud coverage in [0, 1]. */
  readonly coverage: number;
  /** 0 is flat stratus, 1 is towering cumulus. */
  readonly cloudType: number;
}

/**
 * Sample the weather map at a horizontal position.
 *
 * Two noise fields at different scales: one drives coverage, the other decides
 * what kind of cloud grows where. Without this the whole sky is one texture
 * repeated, which reads as wallpaper rather than weather.
 */
export function sampleWeather(
  layer: CloudLayer,
  x: number,
  z: number,
): WeatherSample {
  const u = x / layer.weatherScale;
  const v = z / layer.weatherScale;

  // A large period keeps the weather from visibly repeating overhead.
  const coverageNoise = worleyFbm(u, 0.5, v, 4, 2, layer.seed);
  const typeNoise = worley3(u * 0.6 + 11, 0.5, v * 0.6 + 7, 4, layer.seed + 53);

  return {
    coverage: clamp01(remap(coverageNoise, 0.25, 0.85, 0, 1) * layer.coverage * 2),
    cloudType: clamp01(typeNoise),
  };
}

/**
 * Vertical density profile through the slab, for a given cloud type.
 *
 * `heightFraction` is 0 at the slab's base and 1 at its top. Real clouds are
 * not uniform slabs: they taper at the bottom where air is still rising and
 * spread at the top where it stops, and that shape is most of what makes a
 * cloud read as a cloud.
 */
export function heightGradient(heightFraction: number, cloudType: number): number {
  if (heightFraction < 0 || heightFraction > 1) return 0;

  // Stratus: a flat sheet in the lower third.
  const stratus = remap(heightFraction, 0, 0.1, 0, 1) * remap(heightFraction, 0.2, 0.35, 1, 0);

  // Cumulus: narrow base, broad body, soft top.
  const cumulus = remap(heightFraction, 0, 0.2, 0, 1) * remap(heightFraction, 0.7, 1, 1, 0);

  // Blend between them, with a stratocumulus middle.
  const stratocumulus =
    remap(heightFraction, 0, 0.15, 0, 1) * remap(heightFraction, 0.4, 0.7, 1, 0);

  if (cloudType < 0.5) {
    return lerp(stratus, stratocumulus, cloudType * 2);
  }
  return lerp(stratocumulus, cumulus, (cloudType - 0.5) * 2);
}

/** Where a point sits in the slab: 0 at the base, 1 at the top. */
export function heightFraction(layer: CloudLayer, altitude: number): number {
  const span = layer.topAltitude - layer.bottomAltitude;
  if (span <= 0) return 0;
  return (altitude - layer.bottomAltitude) / span;
}

/**
 * Cloud density at a point, in m^-1.
 *
 * @param x,z Horizontal position (m), in the planet's tangent plane.
 * @param altitude Height above sea level (m).
 */
export function cloudDensity(
  layer: CloudLayer,
  x: number,
  z: number,
  altitude: number,
): number {
  const h = heightFraction(layer, altitude);
  if (h <= 0 || h >= 1) return 0;

  const weather = sampleWeather(layer, x, z);
  const gradient = heightGradient(h, weather.cloudType);
  if (gradient <= 0) return 0;

  // Base shape, carved down by how much coverage this patch of sky has.
  const shape = perlinWorley(
    x / layer.shapeScale,
    altitude / layer.shapeScale,
    z / layer.shapeScale,
    8,
    layer.seed,
  );

  const base = remap(shape * gradient, 1 - weather.coverage, 1, 0, 1);
  if (base <= 0) return 0;

  // Detail erosion. Eroding more at the base than the top gives the wispy
  // underside and firm cauliflower crown that real convective clouds have.
  const detail = worleyFbm(
    x / layer.detailScale,
    altitude / layer.detailScale,
    z / layer.detailScale,
    8,
    2,
    layer.seed + 977,
  );

  const erosionStrength = layer.erosion * (1 - h) ** 0.5;
  const eroded = remap(base, detail * erosionStrength, 1, 0, 1);

  return clamp01(eroded) * layer.density;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}
