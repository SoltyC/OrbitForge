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
 *
 * Everything is in planet-centric metres, and the slab is two concentric
 * shells rather than two parallel planes — see the note in `density.ts` for
 * why the flat version could not survive contact with a horizon.
 */
import type { CloudLayer, CloudNoiseSource } from './density.js';
import { bottomRadius, cloudDensity, topRadius } from './density.js';
import { multiScatter } from './lighting.js';
import type { ScatterOctaves } from './lighting.js';
import { DEFAULT_OCTAVES } from './lighting.js';

/**
 * Step count along the view ray.
 *
 * Adaptive, because the distance a ray spends inside the slab varies by two
 * orders of magnitude with where it is pointed. Straight up from the ground it
 * is 3.5 km; along the horizon it is 35 km; grazing the inside of the layer it
 * approaches 150. A fixed count either wastes samples on the short rays or
 * steps a kilometre at a time through the long ones, and a kilometre is larger
 * than the clouds.
 *
 * So the step *size* is what is held roughly constant, and the count follows —
 * bounded at both ends so neither the cost nor the aliasing can run away.
 */
export const TARGET_STEP = 250;
export const MIN_VIEW_STEPS = 32;
export const MAX_VIEW_STEPS = 96;

/** Steps from a sample towards the sun. */
export const LIGHT_STEPS = 6;

/** Stop marching once this little light survives; the rest is invisible. */
const TRANSMITTANCE_CUTOFF = 0.01;

export interface CloudMarchParams {
  /** Ray origin: planet-centric position in metres. */
  readonly origin: readonly [number, number, number];
  /** Unit view direction, same frame. */
  readonly direction: readonly [number, number, number];
  /** Unit direction towards the sun, same frame. */
  readonly sunDirection: readonly [number, number, number];
  /** Furthest distance to consider (m). */
  readonly maxDistance?: number;
  readonly octaves?: ScatterOctaves;
  /** Where to read noise from; analytic unless told otherwise. */
  readonly noise?: CloudNoiseSource;
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
 * The positive root of a ray's intersection with a sphere centred on the
 * origin, or -1 if it misses. Returns the *near* root when `near` is true.
 *
 * The same `r`, `mu` parameterisation the sky shader uses: `r` is the distance
 * from the centre and `mu` the cosine between the outward radial and the ray.
 */
function sphereHit(r: number, mu: number, radius: number, near: boolean): number {
  const discriminant = r * r * (mu * mu - 1) + radius * radius;
  if (discriminant < 0) return -1;

  const root = Math.sqrt(discriminant);
  return near ? -r * mu - root : -r * mu + root;
}

/**
 * Where a ray enters and leaves the cloud slab.
 *
 * One interval, not two. A ray can in principle cross the layer, pass beneath
 * it, and rise through it again on the far side of the planet — but everything
 * past the first descent below the cloud base is either inside the planet or
 * hidden behind its limb, so the march stops there and the far deck is never
 * reached. That is a simplification the geometry makes for us rather than one
 * imposed on it.
 *
 * @param r Distance from the planet's centre to the ray origin (m).
 * @param mu Cosine between the outward radial at the origin and the ray.
 */
export function slabIntersection(
  layer: CloudLayer,
  r: number,
  mu: number,
): { near: number; far: number } | null {
  const inner = bottomRadius(layer);
  const outer = topRadius(layer);

  // Where the ray would cross the base of the layer, coming down.
  const innerNear = sphereHit(r, mu, inner, true);

  let near: number;
  let far: number;

  if (r > outer) {
    // Above the layer: come in through the top.
    near = sphereHit(r, mu, outer, true);
    if (near < 0) return null;
    far = innerNear > 0 ? innerNear : sphereHit(r, mu, outer, false);
  } else if (r < inner) {
    // Below the layer: the base is the entry. Every ray reaches it eventually,
    // including ones pointed at the ground — which is why the planet has to be
    // tested for here and nowhere else. In every other case the march already
    // stops at the cloud base, which is above the surface.
    if (mu < 0 && sphereHit(r, mu, layer.planetRadius, true) >= 0) return null;

    near = sphereHit(r, mu, inner, false);
    if (near < 0) return null;
    far = sphereHit(r, mu, outer, false);
  } else {
    // Inside the layer already: start at the viewer and leave through whichever
    // boundary comes first.
    near = 0;
    far = innerNear > 0 ? innerNear : sphereHit(r, mu, outer, false);
  }

  if (!(far > near) || far <= 0) return null;
  return { near: Math.max(0, near), far };
}

/** How many steps to take across a span, holding the step size near target. */
export function viewStepsFor(span: number): number {
  const wanted = Math.ceil(span / TARGET_STEP);
  return Math.min(MAX_VIEW_STEPS, Math.max(MIN_VIEW_STEPS, wanted));
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
  y: number,
  z: number,
  sun: readonly [number, number, number],
  noise?: CloudNoiseSource,
): number {
  const distance = layer.lightMarchDistance;
  if (distance <= 0) return 0;

  let opticalDepth = 0;

  for (let i = 0; i < LIGHT_STEPS; i++) {
    const t0 = (i / LIGHT_STEPS) ** 2;
    const t1 = ((i + 1) / LIGHT_STEPS) ** 2;

    const step = distance * (t1 - t0);
    const d = distance * ((t0 + t1) / 2);

    opticalDepth +=
      cloudDensity(layer, x + sun[0] * d, y + sun[1] * d, z + sun[2] * d, noise) *
      step;
  }

  return opticalDepth;
}

/** March a view ray through the cloud layer. */
export function marchClouds(
  layer: CloudLayer,
  params: CloudMarchParams,
): CloudSample {
  const { origin, direction, sunDirection, noise } = params;

  const r = Math.hypot(origin[0], origin[1], origin[2]);
  if (r <= 0) return MISS;

  const mu =
    (origin[0] * direction[0] + origin[1] * direction[1] + origin[2] * direction[2]) / r;

  const slab = slabIntersection(layer, r, mu);
  if (!slab) return MISS;

  const far = Math.min(slab.far, params.maxDistance ?? Infinity);
  const span = far - slab.near;
  if (span <= 0) return MISS;

  const steps = viewStepsFor(span);
  const step = span / steps;

  const cosTheta =
    direction[0] * sunDirection[0] +
    direction[1] * sunDirection[1] +
    direction[2] * sunDirection[2];

  const octaves = params.octaves ?? DEFAULT_OCTAVES;
  const jitter = params.jitter ?? 0.5;

  let transmittance = 1;
  let luminance = 0;

  for (let i = 0; i < steps; i++) {
    const d = slab.near + step * (i + jitter);

    const x = origin[0] + direction[0] * d;
    const y = origin[1] + direction[1] * d;
    const z = origin[2] + direction[2] * d;

    const density = cloudDensity(layer, x, y, z, noise);
    if (density <= 0) continue;

    const sunOpticalDepth = lightMarch(layer, x, y, z, sunDirection, noise);
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
