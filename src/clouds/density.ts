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
 *
 * Positions are **planet-centric metres** — the vector from the body's centre
 * to the sample. Not a local tangent plane, which is what this used to take.
 * A flat slab is a fine model of a cloud deck a few kilometres across and a
 * hopeless one past that: at Terrin's 600 km radius a horizontal ray has
 * dropped a kilometre below its starting altitude after 35 km, and more than
 * the whole thickness of the layer after 65. Since the layer stays visible for
 * about 80 km from the ground and for hundreds of kilometres from altitude,
 * flat would have put a solid wall across the horizon in every shot the
 * milestone is actually about. So the slab is two concentric shells, and
 * altitude is the distance from the centre.
 *
 * The noise is then read at the planet-centric position directly, with no
 * tangent frame at all. A frame built from the camera would make the clouds
 * swim as it moved, and a frame built from the planet's axes is degenerate at
 * the poles; three-dimensional noise read at a three-dimensional position is
 * neither, and is the same arithmetic everywhere on the globe.
 */
import { clamp01, perlinWorley, remap, worley3, worleyFbm } from './noise.js';
import {
  DETAIL_SEED_OFFSET,
  WEATHER_TYPE_SEED_OFFSET,
  sampleDetail,
  sampleShape,
  sampleWeatherCoverage,
  sampleWeatherType,
} from './textures.js';
import type { CloudTextures } from './textures.js';

export interface CloudLayer {
  /** Radius of the body the layer sits above (m). */
  readonly planetRadius: number;
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

/** A temperate day over Terrin: broken cumulus with clear gaps. */
export const DEFAULT_CLOUD_LAYER: CloudLayer = {
  planetRadius: 600_000,
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

/**
 * Where the density field reads its noise from.
 *
 * Two implementations: the analytic one, which evaluates the noise functions
 * directly, and the baked one, which reads the 3D textures the GPU reads. They
 * are behind an interface so the reference renderer and the tests can run
 * either, and so the difference between them can be *measured* rather than
 * assumed — which matters, because the shader can only use the baked path, and
 * it is the analytic path that the physical reasoning is written against.
 *
 * Coordinates are in each field's own noise units: position divided by
 * `shapeScale`, `detailScale` or `weatherScale`.
 */
export interface CloudNoiseSource {
  shape(x: number, y: number, z: number): number;
  detail(x: number, y: number, z: number): number;
  weatherCoverage(x: number, y: number, z: number): number;
  weatherType(x: number, y: number, z: number): number;
}

/** Periods used by the analytic path; the textures span exactly one of each. */
const SHAPE_PERIOD = 4;
const DETAIL_PERIOD = 4;
const WEATHER_PERIOD = 4;
const DETAIL_OCTAVES = 2;
const WEATHER_OCTAVES = 2;

/** Evaluate the noise functions directly. The ground truth; far too slow for a GPU. */
export function analyticNoise(seed: number): CloudNoiseSource {
  return {
    shape: (x, y, z) => perlinWorley(x, y, z, SHAPE_PERIOD, seed),
    detail: (x, y, z) =>
      worleyFbm(x, y, z, DETAIL_PERIOD, DETAIL_OCTAVES, seed + DETAIL_SEED_OFFSET),
    weatherCoverage: (x, y, z) =>
      worleyFbm(x, y, z, WEATHER_PERIOD, WEATHER_OCTAVES, seed),
    weatherType: (x, y, z) =>
      worley3(x, y, z, WEATHER_PERIOD, seed + WEATHER_TYPE_SEED_OFFSET),
  };
}

/** Read the baked textures, exactly as the shader does. */
export function bakedNoise(textures: CloudTextures): CloudNoiseSource {
  return {
    shape: (x, y, z) => sampleShape(textures, x, y, z),
    detail: (x, y, z) => sampleDetail(textures, x, y, z),
    weatherCoverage: (x, y, z) => sampleWeatherCoverage(textures, x, y, z),
    weatherType: (x, y, z) => sampleWeatherType(textures, x, y, z),
  };
}

/**
 * The analytic source for a seed, remembered between calls.
 *
 * `cloudDensity` is called tens of millions of times by the reference
 * renderer, and building a fresh object of four closures each time is the kind
 * of cost that does not look like a cost.
 */
let cachedAnalyticSeed = Number.NaN;
let cachedAnalytic: CloudNoiseSource | null = null;

function defaultNoise(seed: number): CloudNoiseSource {
  if (cachedAnalytic === null || cachedAnalyticSeed !== seed) {
    cachedAnalytic = analyticNoise(seed);
    cachedAnalyticSeed = seed;
  }
  return cachedAnalytic;
}

/**
 * Local cloud coverage in [0, 1], from the weather map.
 *
 * Sampled on a reference sphere at the planet's radius rather than at the
 * sample's own altitude, so a column of air has one coverage from base to top
 * — coverage is a property of a patch of sky, not of a height within it.
 */
export function weatherCoverage(
  layer: CloudLayer,
  x: number,
  y: number,
  z: number,
  noise: CloudNoiseSource = defaultNoise(layer.seed),
): number {
  return coverageAt(layer, x, y, z, projection(layer, x, y, z), noise);
}

/**
 * What kind of cloud grows here: 0 is flat stratus, 1 is towering cumulus.
 *
 * Read at the same point as the coverage, and separated from it by seed rather
 * than by scale. Two lookups at different scales would mean two texture
 * fetches where one does, and the weather map is fetched at every step of
 * every ray.
 */
export function weatherCloudType(
  layer: CloudLayer,
  x: number,
  y: number,
  z: number,
  noise: CloudNoiseSource = defaultNoise(layer.seed),
): number {
  return cloudTypeAt(layer, x, y, z, projection(layer, x, y, z), noise);
}

/**
 * The two weather lookups, given a projection factor the caller already has.
 *
 * `cloudDensity` needs the sample's radius anyway, so letting it pass the
 * factor down saves recomputing the same square root three times per sample.
 */
function coverageAt(
  layer: CloudLayer,
  x: number,
  y: number,
  z: number,
  s: number,
  noise: CloudNoiseSource,
): number {
  const raw = noise.weatherCoverage(
    (x * s) / layer.weatherScale,
    (y * s) / layer.weatherScale,
    (z * s) / layer.weatherScale,
  );
  return clamp01(remap(raw, 0.25, 0.85, 0, 1) * layer.coverage * 2);
}

function cloudTypeAt(
  layer: CloudLayer,
  x: number,
  y: number,
  z: number,
  s: number,
  noise: CloudNoiseSource,
): number {
  return clamp01(
    noise.weatherType(
      (x * s) / layer.weatherScale,
      (y * s) / layer.weatherScale,
      (z * s) / layer.weatherScale,
    ),
  );
}

/** Scale factor that projects a point onto the sphere of the planet's radius. */
function projection(layer: CloudLayer, x: number, y: number, z: number): number {
  const radius = Math.hypot(x, y, z);
  return radius > 0 ? layer.planetRadius / radius : 0;
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

/** Radius of the slab's base and top, measured from the planet's centre. */
export function bottomRadius(layer: CloudLayer): number {
  return layer.planetRadius + layer.bottomAltitude;
}

export function topRadius(layer: CloudLayer): number {
  return layer.planetRadius + layer.topAltitude;
}

/**
 * Cloud density at a point, in m^-1.
 *
 * @param x,y,z Planet-centric position (m).
 * @param noise Where to read the noise from; analytic unless told otherwise.
 *
 * The erosion detail is applied on every call, including from the light march
 * — which is the innermost loop of the whole renderer, and where a common
 * optimisation is to leave it out and read one texture instead of two. That
 * was tried and measured: across points actually inside cloud it raised the
 * mean optical depth towards the sun by 44%, and individual points by up to
 * two orders of magnitude. Erosion does not just trim silhouettes, it removes
 * about a third of the field's mass, and a light march that cannot see the
 * holes shadows a cloud that is not there. The fetch stays.
 */
export function cloudDensity(
  layer: CloudLayer,
  x: number,
  y: number,
  z: number,
  noise: CloudNoiseSource = defaultNoise(layer.seed),
): number {
  const radius = Math.hypot(x, y, z);
  const h = heightFraction(layer, radius - layer.planetRadius);
  if (h <= 0 || h >= 1) return 0;

  const s = radius > 0 ? layer.planetRadius / radius : 0;

  const gradient = heightGradient(h, cloudTypeAt(layer, x, y, z, s, noise));
  if (gradient <= 0) return 0;

  // Base shape, carved down by how much coverage this patch of sky has.
  const shape = noise.shape(
    x / layer.shapeScale,
    y / layer.shapeScale,
    z / layer.shapeScale,
  );

  const coverage = coverageAt(layer, x, y, z, s, noise);
  const base = remap(shape * gradient, 1 - coverage, 1, 0, 1);
  if (base <= 0) return 0;

  // Detail erosion. Eroding more at the base than the top gives the wispy
  // underside and firm cauliflower crown that real convective clouds have.
  const detail = noise.detail(
    x / layer.detailScale,
    y / layer.detailScale,
    z / layer.detailScale,
  );

  const erosionStrength = layer.erosion * (1 - h) ** 0.5;
  const eroded = remap(base, detail * erosionStrength, 1, 0, 1);

  return clamp01(eroded) * layer.density;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}
