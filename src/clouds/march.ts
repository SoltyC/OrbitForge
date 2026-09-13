/**
 * The cloud raymarch — reference implementation.
 *
 * Same discipline as the atmosphere: this is plain TypeScript that can be
 * probed and tested, and the GPU shader is a transcription of it. A wrong
 * cloud still looks like a cloud, so the eye is a poor judge; the tests are
 * what say it is right.
 *
 * Two nested marches. The view ray steps through the slab accumulating
 * scattered light and transmittance; at each step a much shorter march towards
 * the sun estimates how much light got there. The inner march is why clouds
 * are expensive, and why its step count is kept low.
 */
import type { CloudLayer } from './density.js';
import { cloudDensity } from './density.js';
import { multiScatter } from './lighting.js';
import type { ScatterOctaves } from './lighting.js';
import { DEFAULT_OCTAVES } from './lighting.js';

/** Steps along the view ray through the cloud slab. */
export const VIEW_STEPS = 48;
/** Steps from a sample towards the sun. */
export const LIGHT_STEPS = 6;
/** Stop marching once this little light survives; the rest is invisible. */
const TRANSMITTANCE_CUTOFF = 0.01;

export interface CloudMarchParams {
  /** Ray origin, as (x, altitude, z) in metres. */
  readonly origin: readonly [number, number, number];
  /** Unit view direction, same axes. */
  readonly direction: readonly [number, number, number];
  /** Unit direction towards the sun. */
  readonly sunDirection: readonly [number, number, number];
  /** Furthest distance to consider (m). */
  readonly maxDistance?: number;
  readonly octaves?: ScatterOctaves;
  /** Per-pixel offset in [0, 1) to break up banding. */
  readonly jitter?: number;
}

export interface CloudSample {
  /** Scattered light reaching the eye, relative to sunlight. */
  readonly luminance: number;
  /** Fraction of background light that survives the clouds. */
  readonly transmittance: number;
  /** True if the ray passed through the slab at all. */
  readonly hitLayer: boolean;
}

const MISS: CloudSample = { luminance: 0, transmittance: 1, hitLayer: false };

/**
 * Where a ray enters and leaves the cloud slab.
 *
 * The slab is treated as flat rather than as two concentric shells. Over the
 * few tens of kilometres a cloud layer is visible across, the curvature error
 * is far smaller than the clouds themselves; the atmosphere, which is seen
 * from orbit, does not get that luxury.
 */
export function slabIntersection(
  layer: CloudLayer,
  originAltitude: number,
  directionY: number,
): { near: number; far: number } | null {
  const bottom = layer.bottomAltitude;
  const top = layer.topAltitude;

  if (Math.abs(directionY) < 1e-9) {
    // Travelling horizontally: either inside the slab forever, or never.
    const inside = originAltitude > bottom && originAltitude < top;
    return inside ? { near: 0, far: Infinity } : null;
  }

  const t1 = (bottom - originAltitude) / directionY;
  const t2 = (top - originAltitude) / directionY;

  const near = Math.max(0, Math.min(t1, t2));
  const far = Math.max(t1, t2);

  return far > near ? { near, far } : null;
}

/**
 * Optical depth from a point towards the sun.
 *
 * Marches a short, fixed distance rather than the whole slab. Only nearby
 * cloud meaningfully shadows a point — and marching further would drive the
 * optical depth into the range where the scattering approximation collapses to
 * black. Steps grow with distance so the near shadowing, which carries the
 * shape, is sampled most finely.
 */
export function lightMarch(
  layer: CloudLayer,
  x: number,
  altitude: number,
  z: number,
  sun: readonly [number, number, number],
): number {
  const slab = slabIntersection(layer, altitude, sun[1]);
  if (!slab) return 0;

  const distance = Math.min(slab.far, layer.lightMarchDistance);
  if (distance <= 0) return 0;

  let opticalDepth = 0;

  for (let i = 0; i < LIGHT_STEPS; i++) {
    const t0 = (i / LIGHT_STEPS) ** 2;
    const t1 = ((i + 1) / LIGHT_STEPS) ** 2;

    const step = distance * (t1 - t0);
    const d = distance * ((t0 + t1) / 2);

    opticalDepth +=
      cloudDensity(layer, x + sun[0] * d, z + sun[2] * d, altitude + sun[1] * d) * step;
  }

  return opticalDepth;
}

/** March a view ray through the cloud layer. */
export function marchClouds(
  layer: CloudLayer,
  params: CloudMarchParams,
): CloudSample {
  const { origin, direction, sunDirection } = params;

  const slab = slabIntersection(layer, origin[1], direction[1]);
  if (!slab) return MISS;

  const far = Math.min(
    slab.far,
    params.maxDistance ?? Infinity,
    // Beyond this the layer is edge-on and contributes nothing but cost.
    slab.near + MAX_MARCH_LENGTH,
  );

  const span = far - slab.near;
  if (span <= 0) return MISS;

  const step = span / VIEW_STEPS;
  const cosTheta =
    direction[0] * sunDirection[0] +
    direction[1] * sunDirection[1] +
    direction[2] * sunDirection[2];

  const octaves = params.octaves ?? DEFAULT_OCTAVES;
  const jitter = params.jitter ?? 0.5;

  let transmittance = 1;
  let luminance = 0;

  for (let i = 0; i < VIEW_STEPS; i++) {
    const d = slab.near + step * (i + jitter);

    const x = origin[0] + direction[0] * d;
    const altitude = origin[1] + direction[1] * d;
    const z = origin[2] + direction[2] * d;

    const density = cloudDensity(layer, x, z, altitude);
    if (density <= 0) continue;

    const sunOpticalDepth = lightMarch(layer, x, altitude, z, sunDirection);
    const inScatter = multiScatter(sunOpticalDepth, cosTheta, octaves);

    const extinction = density * step;
    const stepTransmittance = Math.exp(-extinction);

    // Integrate the segment in closed form, as the atmosphere does: light
    // scattered at the start of a step is attenuated across the rest of it.
    luminance += transmittance * inScatter * (1 - stepTransmittance);
    transmittance *= stepTransmittance;

    if (transmittance < TRANSMITTANCE_CUTOFF) break;
  }

  return { luminance, transmittance, hitLayer: true };
}

/**
 * Cap on how far to march. A ray skimming just under the cloud base can stay
 * inside the slab for hundreds of kilometres; past this point the clouds are
 * below the horizon anyway.
 */
const MAX_MARCH_LENGTH = 120_000;
