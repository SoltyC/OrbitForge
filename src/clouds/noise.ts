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

/** Hash to a float in [0, 1). */
function hashUnit(x: number, y: number, z: number, seed: number): number {
  return hash(x, y, z, seed) / 4294967296;
}

/** Wrap a lattice coordinate into [0, period). */
function wrap(value: number, period: number): number {
  const m = value % period;
  return m < 0 ? m + period : m;
}

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

  const corner = (dx: number, dy: number, dz: number): number => {
    const h = hash(
      wrap(xi + dx, period),
      wrap(yi + dy, period),
      wrap(zi + dz, period),
      seed,
    );
    return gradientDot(h, xf - dx, yf - dy, zf - dz);
  };

  const x00 = lerp(corner(0, 0, 0), corner(1, 0, 0), u);
  const x10 = lerp(corner(0, 1, 0), corner(1, 1, 0), u);
  const x01 = lerp(corner(0, 0, 1), corner(1, 0, 1), u);
  const x11 = lerp(corner(0, 1, 1), corner(1, 1, 1), u);

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

  // One feature point per cell; the 27-cell neighbourhood is enough to find
  // the nearest, since a point cannot be closer than its own cell's diagonal.
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = xi + dx;
        const cy = yi + dy;
        const cz = zi + dz;

        const wx = wrap(cx, period);
        const wy = wrap(cy, period);
        const wz = wrap(cz, period);

        const fx = cx + hashUnit(wx, wy, wz, seed);
        const fy = cy + hashUnit(wx, wy, wz, seed + 1);
        const fz = cz + hashUnit(wx, wy, wz, seed + 2);

        const distanceSq =
          (fx - x) * (fx - x) + (fy - y) * (fy - y) + (fz - z) * (fz - z);

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
