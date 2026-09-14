/**
 * Baking the cloud noise into textures.
 *
 * The reference model evaluates its noise analytically: a four-octave Perlin
 * remapped by a three-octave Worley, plus a two-octave Worley for erosion.
 * That is around three hundred hash-and-interpolate operations for a single
 * density sample, and the raymarch wants tens of thousands of samples per
 * pixel. Analytically, on a GPU, that is not a shader — it is a screensaver.
 *
 * So the noise is evaluated once into small tiling 3D textures and read back
 * with trilinear interpolation from then on. The fields are periodic by
 * construction, so a texture spanning exactly one period tiles seamlessly.
 *
 * Everything here is plain arithmetic over typed arrays — no Three.js — so the
 * baked field can be sampled and compared against the analytic one in tests.
 * That comparison is the point: it is what says the texture the GPU reads is
 * the field the tests verified.
 */
import { perlinWorley, worley3, worleyFbm } from './noise.js';

/**
 * Resolution and period of the base shape texture.
 *
 * Period is in noise units, and one noise unit is `shapeScale` metres — so at
 * the default 7 km scale this texture spans 28 km and repeats beyond that.
 * A shorter repeat than one might expect, and deliberately so: the texel count
 * goes as the cube, and the weather map (which repeats at 152 km) is what
 * breaks up the tiling. Hiding repetition is the weather map's job; resolving
 * cloud shape is this one's.
 *
 * 64 texels over 28 km is 437 m each, against a finest Perlin octave of about
 * 875 m — two texels per feature, which is the least that reconstructs it.
 */
export const SHAPE_RESOLUTION = 64;
export const SHAPE_PERIOD = 4;

/** Erosion detail: finer features, so a much smaller texture covers them. */
export const DETAIL_RESOLUTION = 32;
export const DETAIL_PERIOD = 4;

/** Coverage and cloud type. Low frequency by nature, so 32 is ample. */
export const WEATHER_RESOLUTION = 32;
export const WEATHER_PERIOD = 4;

/** Octave counts, matching the analytic calls in `density.ts`. */
const DETAIL_OCTAVES = 2;
const WEATHER_OCTAVES = 2;

/**
 * Seed offsets, which must match the analytic path in `density.ts` exactly.
 * They live here so the two cannot drift apart silently.
 */
export const DETAIL_SEED_OFFSET = 977;
export const WEATHER_TYPE_SEED_OFFSET = 53;

/**
 * The baked fields.
 *
 * Single-byte channels throughout. Every field is a [0, 1] quantity that is
 * then remapped hard by coverage and erosion, which does amplify quantisation
 * — the tests measure how much, and it lands well under a texel of spatial
 * error, so it is not the limiting approximation here.
 */
export interface CloudTextures {
  /** Perlin-Worley base shape. One channel, `SHAPE_RESOLUTION` cubed. */
  readonly shape: Uint8Array;
  /** Worley erosion detail. One channel, `DETAIL_RESOLUTION` cubed. */
  readonly detail: Uint8Array;
  /** Coverage in R, cloud type in G. `WEATHER_RESOLUTION` cubed. */
  readonly weather: Uint8Array;
}

/** Total texels to bake, for reporting progress before the work starts. */
export const TOTAL_BAKE_TEXELS =
  SHAPE_RESOLUTION ** 3 + DETAIL_RESOLUTION ** 3 + WEATHER_RESOLUTION ** 3;

/**
 * Bake every field, yielding after each z-slice.
 *
 * A generator rather than a plain function because the shape texture alone is
 * a quarter of a million four-octave noise evaluations — several seconds of
 * JavaScript. Run to completion on the main thread that is a frozen tab, so
 * the renderer drains it against a frame budget instead and shows no clouds
 * until it is done. (A compute-shader bake would retire this entirely, and is
 * the obvious upgrade once there is a compute pass to hang it on.)
 *
 * Yields the number of texels completed so far.
 */
export function* bakeCloudTextures(seed: number): Generator<number, CloudTextures> {
  const shape = new Uint8Array(SHAPE_RESOLUTION ** 3);
  const detail = new Uint8Array(DETAIL_RESOLUTION ** 3);
  const weather = new Uint8Array(WEATHER_RESOLUTION ** 3 * 2);

  let done = 0;

  for (let z = 0; z < SHAPE_RESOLUTION; z++) {
    for (let y = 0; y < SHAPE_RESOLUTION; y++) {
      for (let x = 0; x < SHAPE_RESOLUTION; x++) {
        const value = perlinWorley(
          texelCentre(x, SHAPE_RESOLUTION, SHAPE_PERIOD),
          texelCentre(y, SHAPE_RESOLUTION, SHAPE_PERIOD),
          texelCentre(z, SHAPE_RESOLUTION, SHAPE_PERIOD),
          SHAPE_PERIOD,
          seed,
        );
        shape[(z * SHAPE_RESOLUTION + y) * SHAPE_RESOLUTION + x] = toByte(value);
      }
    }
    done += SHAPE_RESOLUTION ** 2;
    yield done;
  }

  for (let z = 0; z < DETAIL_RESOLUTION; z++) {
    for (let y = 0; y < DETAIL_RESOLUTION; y++) {
      for (let x = 0; x < DETAIL_RESOLUTION; x++) {
        const value = worleyFbm(
          texelCentre(x, DETAIL_RESOLUTION, DETAIL_PERIOD),
          texelCentre(y, DETAIL_RESOLUTION, DETAIL_PERIOD),
          texelCentre(z, DETAIL_RESOLUTION, DETAIL_PERIOD),
          DETAIL_PERIOD,
          DETAIL_OCTAVES,
          seed + DETAIL_SEED_OFFSET,
        );
        detail[(z * DETAIL_RESOLUTION + y) * DETAIL_RESOLUTION + x] = toByte(value);
      }
    }
    done += DETAIL_RESOLUTION ** 2;
    yield done;
  }

  for (let z = 0; z < WEATHER_RESOLUTION; z++) {
    for (let y = 0; y < WEATHER_RESOLUTION; y++) {
      for (let x = 0; x < WEATHER_RESOLUTION; x++) {
        const u = texelCentre(x, WEATHER_RESOLUTION, WEATHER_PERIOD);
        const v = texelCentre(y, WEATHER_RESOLUTION, WEATHER_PERIOD);
        const w = texelCentre(z, WEATHER_RESOLUTION, WEATHER_PERIOD);

        const index = ((z * WEATHER_RESOLUTION + y) * WEATHER_RESOLUTION + x) * 2;
        weather[index] = toByte(
          worleyFbm(u, v, w, WEATHER_PERIOD, WEATHER_OCTAVES, seed),
        );
        weather[index + 1] = toByte(
          worley3(u, v, w, WEATHER_PERIOD, seed + WEATHER_TYPE_SEED_OFFSET),
        );
      }
    }
    done += WEATHER_RESOLUTION ** 2;
    yield done;
  }

  return { shape, detail, weather };
}

/** Bake everything in one go. Convenient for tools and tests; blocks. */
export function bakeCloudTexturesSync(seed: number): CloudTextures {
  const baker = bakeCloudTextures(seed);
  let next = baker.next();
  while (!next.done) next = baker.next();
  return next.value;
}

/**
 * The noise coordinate a texel stores.
 *
 * Texel centres, not lower corners. The GPU samples at texel centres too, so
 * this is what makes `sampleShape` below return the baked value exactly at the
 * points it was baked at, with no half-texel shift between CPU and GPU.
 */
function texelCentre(index: number, resolution: number, period: number): number {
  return ((index + 0.5) / resolution) * period;
}

function toByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value * 255)));
}

/** Base shape at a point, in shape-noise units. Trilinear, wrapping. */
export function sampleShape(
  textures: CloudTextures,
  x: number,
  y: number,
  z: number,
): number {
  return trilinear(
    textures.shape,
    SHAPE_RESOLUTION,
    1,
    0,
    x / SHAPE_PERIOD,
    y / SHAPE_PERIOD,
    z / SHAPE_PERIOD,
  );
}

/** Erosion detail at a point, in detail-noise units. */
export function sampleDetail(
  textures: CloudTextures,
  x: number,
  y: number,
  z: number,
): number {
  return trilinear(
    textures.detail,
    DETAIL_RESOLUTION,
    1,
    0,
    x / DETAIL_PERIOD,
    y / DETAIL_PERIOD,
    z / DETAIL_PERIOD,
  );
}

/** Raw coverage noise at a point, in weather-noise units. */
export function sampleWeatherCoverage(
  textures: CloudTextures,
  x: number,
  y: number,
  z: number,
): number {
  return trilinear(
    textures.weather,
    WEATHER_RESOLUTION,
    2,
    0,
    x / WEATHER_PERIOD,
    y / WEATHER_PERIOD,
    z / WEATHER_PERIOD,
  );
}

/** Raw cloud-type noise at a point, in weather-noise units. */
export function sampleWeatherType(
  textures: CloudTextures,
  x: number,
  y: number,
  z: number,
): number {
  return trilinear(
    textures.weather,
    WEATHER_RESOLUTION,
    2,
    1,
    x / WEATHER_PERIOD,
    y / WEATHER_PERIOD,
    z / WEATHER_PERIOD,
  );
}

/**
 * Trilinear fetch with repeat addressing, in normalised texture coordinates.
 *
 * Written out rather than left to a sampler for the same reason the sky's
 * lookup table is: it is the arithmetic the GPU performs, so doing it by hand
 * here means the CPU reference and the shader agree by construction rather
 * than by hope. The shader's version is the transcription of this.
 */
function trilinear(
  data: Uint8Array,
  resolution: number,
  channels: number,
  channel: number,
  u: number,
  v: number,
  w: number,
): number {
  const cu = u * resolution - 0.5;
  const cv = v * resolution - 0.5;
  const cw = w * resolution - 0.5;

  const bu = Math.floor(cu);
  const bv = Math.floor(cv);
  const bw = Math.floor(cw);

  const fu = cu - bu;
  const fv = cv - bv;
  const fw = cw - bw;

  const x0 = wrapIndex(bu, resolution);
  const y0 = wrapIndex(bv, resolution);
  const z0 = wrapIndex(bw, resolution);
  const x1 = wrapIndex(bu + 1, resolution);
  const y1 = wrapIndex(bv + 1, resolution);
  const z1 = wrapIndex(bw + 1, resolution);

  const at = (x: number, y: number, z: number): number =>
    data[((z * resolution + y) * resolution + x) * channels + channel]! / 255;

  const c00 = at(x0, y0, z0) + (at(x1, y0, z0) - at(x0, y0, z0)) * fu;
  const c10 = at(x0, y1, z0) + (at(x1, y1, z0) - at(x0, y1, z0)) * fu;
  const c01 = at(x0, y0, z1) + (at(x1, y0, z1) - at(x0, y0, z1)) * fu;
  const c11 = at(x0, y1, z1) + (at(x1, y1, z1) - at(x0, y1, z1)) * fu;

  const c0 = c00 + (c10 - c00) * fv;
  const c1 = c01 + (c11 - c01) * fv;

  return c0 + (c1 - c0) * fw;
}

/** Repeat addressing: a coordinate outside the texture wraps back into it. */
function wrapIndex(index: number, resolution: number): number {
  const m = index % resolution;
  return m < 0 ? m + resolution : m;
}
