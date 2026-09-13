/**
 * Tiling 3D noise for cloud shapes.
 *
 * Clouds are built from two kinds of noise doing different jobs. Perlin gives
 * smooth, billowy variation; Worley (cellular) gives the rounded, clumped
 * look of convection. Combined — Perlin remapped by inverted Worley — they
 * produce the puffy cumulus shape that neither gives alone.
 *
 * Everything here tiles over a period, because the result is baked into a 3D
 * texture that repeats across the sky. A seam in the noise is a seam you can
 * see from orbit.
 */

/**
 * Integer hash. Deterministic, well-mixed, and cheap enough to call per
 * lattice corner. The constants are from the usual xorshift-multiply family.
 */
function hash(x: number, y: number, z: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 1274126177 + seed * 144665) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Wrap a lattice coordinate into [0, period). */
function wrap(value: number, period: number): number {
  const m = value % period;
  return m < 0 ? m + period : m;
}

/**
 * Lattice caches.
 *
 * Both noises hash the same lattice points over and over: eight corners per
 * Perlin sample, twenty-seven cells per Worley sample, and again for every
 * octave. Because the noise tiles, there are only `period^3` distinct lattice
 * points however far the sampling ranges — so the hashes are worth computing
 * once and reading back.
 *
 * This matters because baking the shape texture evaluates a four-octave Perlin
 * and a three-octave Worley at each of 128^3 texels. Hashing it all afresh
 * takes the better part of a minute; from a table it is a few seconds.
 *
 * The tables hold exactly what the hashes produced, so the noise is unchanged
 * — that is asserted directly in the tests, against values computed the long
 * way round.
 */
const MAX_CACHED_LATTICES = 32;

interface Lattice<T> {
  period: number;
  seed: number;
  table: T;
}

/**
 * Caches are scanned linearly rather than keyed through a Map.
 *
 * That looks like a step backwards and is not: a Map needs a key, and building
 * one — `${period}:${seed}` — allocates a string on every sample. At a few
 * hundred million samples per bake that allocation cost more than all the
 * hashing it was introduced to avoid, and measurably so. A handful of
 * (period, seed) pairs are ever live, so comparing two numbers against a short
 * array is both faster and simpler.
 */
const worleyLattices: Lattice<Float64Array>[] = [];
const perlinLattices: Lattice<Uint8Array>[] = [];

function findLattice<T>(
  cache: Lattice<T>[],
  period: number,
  seed: number,
): T | null {
  for (let i = 0; i < cache.length; i++) {
    const entry = cache[i]!;
    if (entry.period === period && entry.seed === seed) return entry.table;
  }
  return null;
}

function worleyLattice(period: number, seed: number): Float64Array {
  const cached = findLattice(worleyLattices, period, seed);
  if (cached) return cached;

  const table = new Float64Array(period * period * period * 3);
  let i = 0;
  for (let z = 0; z < period; z++) {
    for (let y = 0; y < period; y++) {
      for (let x = 0; x < period; x++) {
        table[i++] = hash(x, y, z, seed) / 4294967296;
        table[i++] = hash(x, y, z, seed + 1) / 4294967296;
        table[i++] = hash(x, y, z, seed + 2) / 4294967296;
      }
    }
  }

  if (worleyLattices.length >= MAX_CACHED_LATTICES) worleyLattices.length = 0;
  worleyLattices.push({ period, seed, table });
  return table;
}

function perlinLattice(period: number, seed: number): Uint8Array {
  const cached = findLattice(perlinLattices, period, seed);
  if (cached) return cached;

  const table = new Uint8Array(period * period * period);
  let i = 0;
  for (let z = 0; z < period; z++) {
    for (let y = 0; y < period; y++) {
      for (let x = 0; x < period; x++) {
        table[i++] = hash(x, y, z, seed) % 12;
      }
    }
  }

  if (perlinLattices.length >= MAX_CACHED_LATTICES) perlinLattices.length = 0;
  perlinLattices.push({ period, seed, table });
  return table;
}

/**
 * Reused scratch for the wrapped lattice coordinates of a Worley
 * neighbourhood. Allocating three arrays per sample would show up in the bake;
 * the noise stays pure regardless, since the contents never outlive a call.
 */
const WRAP_SCRATCH_X = new Int32Array(3);
const WRAP_SCRATCH_Y = new Int32Array(3);
const WRAP_SCRATCH_Z = new Int32Array(3);

/** Quintic smoothstep: zero first and second derivatives at the ends. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** One of twelve edge gradients, chosen by hash. */
function gradientDot(
  hashValue: number,
  x: number,
  y: number,
  z: number,
): number {
  switch (hashValue % 12) {
    case 0: return x + y;
    case 1: return -x + y;
    case 2: return x - y;
    case 3: return -x - y;
    case 4: return x + z;
    case 5: return -x + z;
    case 6: return x - z;
    case 7: return -x - z;
    case 8: return y + z;
    case 9: return -y + z;
    case 10: return y - z;
    default: return -y - z;
  }
}

/**
 * Tiling Perlin gradient noise, returned in [0, 1].
 *
 * @param period Lattice period; coordinates repeat every `period` units.
 */
export function perlin3(
  x: number,
  y: number,
  z: number,
  period: number,
  seed = 0,
): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);

  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;

  const u = fade(xf);
  const v = fade(yf);
  const w = fade(zf);

  // The eight corners share six wrapped lattice coordinates between them, and
  // their gradients come from the table rather than from a fresh hash.
  const table = perlinLattice(period, seed);
  const p2 = period * period;

  const wx0 = wrap(xi, period);
  const wy0 = wrap(yi, period);
  const wz0 = wrap(zi, period);
  const wx1 = wx0 + 1 === period ? 0 : wx0 + 1;
  const wy1 = wy0 + 1 === period ? 0 : wy0 + 1;
  const wz1 = wz0 + 1 === period ? 0 : wz0 + 1;

  const ry0 = wy0 * period;
  const ry1 = wy1 * period;
  const rz0 = wz0 * p2;
  const rz1 = wz1 * p2;

  const g000 = gradientDot(table[rz0 + ry0 + wx0]!, xf, yf, zf);
  const g100 = gradientDot(table[rz0 + ry0 + wx1]!, xf - 1, yf, zf);
  const g010 = gradientDot(table[rz0 + ry1 + wx0]!, xf, yf - 1, zf);
  const g110 = gradientDot(table[rz0 + ry1 + wx1]!, xf - 1, yf - 1, zf);
  const g001 = gradientDot(table[rz1 + ry0 + wx0]!, xf, yf, zf - 1);
  const g101 = gradientDot(table[rz1 + ry0 + wx1]!, xf - 1, yf, zf - 1);
  const g011 = gradientDot(table[rz1 + ry1 + wx0]!, xf, yf - 1, zf - 1);
  const g111 = gradientDot(table[rz1 + ry1 + wx1]!, xf - 1, yf - 1, zf - 1);

  const x00 = lerp(g000, g100, u);
  const x10 = lerp(g010, g110, u);
  const x01 = lerp(g001, g101, u);
  const x11 = lerp(g011, g111, u);

  const y0 = lerp(x00, x10, v);
  const y1 = lerp(x01, x11, v);

  // Gradient noise spans roughly [-1, 1]; remap to [0, 1].
  return clamp01((lerp(y0, y1, w) + 1) * 0.5);
}

/**
 * Tiling Worley (cellular) noise, returned in [0, 1] and *inverted* so that 1
 * is the centre of a cell and 0 is the boundary.
 *
 * Inverted is the useful orientation for clouds: it gives rounded blobs rather
 * than the cracked-mud look of raw distance-to-feature.
 */
export function worley3(
  x: number,
  y: number,
  z: number,
  period: number,
  seed = 0,
): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);

  let nearest = Infinity;

  const table = worleyLattice(period, seed);
  const p2 = period * period;

  // The 27 cells only ever use three wrapped coordinates per axis, so they are
  // wrapped once per axis rather than once per cell.
  const wxs = WRAP_SCRATCH_X;
  const wys = WRAP_SCRATCH_Y;
  const wzs = WRAP_SCRATCH_Z;
  for (let d = 0; d < 3; d++) {
    wxs[d] = wrap(xi + d - 1, period);
    wys[d] = wrap(yi + d - 1, period);
    wzs[d] = wrap(zi + d - 1, period);
  }

  // One feature point per cell; the 27-cell neighbourhood is enough to find
  // the nearest, since a point cannot be closer than its own cell's diagonal.
  for (let dz = -1; dz <= 1; dz++) {
    const cz = zi + dz;
    const rz = wzs[dz + 1]! * p2;

    for (let dy = -1; dy <= 1; dy++) {
      const cy = yi + dy;
      const ry = wys[dy + 1]! * period;

      for (let dx = -1; dx <= 1; dx++) {
        const cx = xi + dx;
        const base = (rz + ry + wxs[dx + 1]!) * 3;

        const ex = cx + table[base]! - x;
        const ey = cy + table[base + 1]! - y;
        const ez = cz + table[base + 2]! - z;

        const distanceSq = ex * ex + ey * ey + ez * ez;
        if (distanceSq < nearest) nearest = distanceSq;
      }
    }
  }

  return clamp01(1 - Math.sqrt(nearest));
}

/** Sum several octaves of Worley at doubling frequency. */
export function worleyFbm(
  x: number,
  y: number,
  z: number,
  period: number,
  octaves = 3,
  seed = 0,
): number {
  let total = 0;
  let amplitude = 0.625;
  let normalisation = 0;
  let frequency = 1;

  for (let i = 0; i < octaves; i++) {
    total +=
      worley3(x * frequency, y * frequency, z * frequency, period * frequency, seed + i * 7) *
      amplitude;
    normalisation += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }

  return normalisation > 0 ? total / normalisation : 0;
}

/** Sum several octaves of Perlin at doubling frequency. */
export function perlinFbm(
  x: number,
  y: number,
  z: number,
  period: number,
  octaves = 4,
  seed = 0,
): number {
  let total = 0;
  let amplitude = 0.5;
  let normalisation = 0;
  let frequency = 1;

  for (let i = 0; i < octaves; i++) {
    total +=
      perlin3(x * frequency, y * frequency, z * frequency, period * frequency, seed + i * 13) *
      amplitude;
    normalisation += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }

  return normalisation > 0 ? total / normalisation : 0;
}

/**
 * Perlin-Worley: Perlin noise remapped so its low end is carved away by
 * inverted Worley.
 *
 * This is the standard cloud base shape. Perlin alone looks like fog; Worley
 * alone looks like bubbles. Remapping one by the other keeps Perlin's soft
 * internal variation while giving the silhouette Worley's rounded clumping.
 */
export function perlinWorley(
  x: number,
  y: number,
  z: number,
  period: number,
  seed = 0,
): number {
  const perlin = perlinFbm(x, y, z, period, 4, seed);
  const worley = worleyFbm(x, y, z, period, 3, seed + 101);

  return remap(perlin, worley - 1, 1, 0, 1);
}

/**
 * Rescale `value` from one range to another, clamped.
 * Used constantly in cloud modelling to carve one field out of another.
 */
export function remap(
  value: number,
  fromMin: number,
  fromMax: number,
  toMin: number,
  toMax: number,
): number {
  if (fromMax === fromMin) return toMin;
  const t = (value - fromMin) / (fromMax - fromMin);
  return clamp(toMin + t * (toMax - toMin), Math.min(toMin, toMax), Math.max(toMin, toMax));
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
