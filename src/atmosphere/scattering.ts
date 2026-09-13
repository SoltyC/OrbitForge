/**
 * Single-scattering integration and phase functions.
 *
 * This is the reference implementation of the sky: given a view ray and a sun
 * direction, it returns the radiance arriving at the eye. The GPU shader is a
 * transcription of this same maths, which is deliberate — it means the model
 * can be unit-tested on the CPU where its behaviour is inspectable, and the
 * shader is then a port of something already known to be right rather than a
 * black box that either looks plausible or does not.
 */
import {
  distanceToGround,
  distanceToSphereEntry,
  distanceToTop,
  hitsGround,
  muAt,
  muSunAt,
  radiusAt,
} from './geometry.js';
import type { AtmosphereModel, Spectrum } from './model.js';
import { mieScatteringAt, rayleighScatteringAt } from './model.js';
import type { TransmittanceLut } from './transmittance.js';
import { transmittanceOverSegment, transmittanceToSun } from './transmittance.js';

/** Raymarch steps through the atmosphere for a sky sample. */
export const SCATTERING_SAMPLES = 32;

/**
 * Rayleigh phase function.
 *
 * Nearly isotropic — slightly stronger forward and backward — which is why the
 * blue of the sky is spread across the whole dome rather than clustered near
 * the sun.
 */
export function rayleighPhase(cosTheta: number): number {
  return (3 / (16 * Math.PI)) * (1 + cosTheta * cosTheta);
}

/**
 * Henyey-Greenstein phase function for Mie scattering.
 *
 * Strongly forward-biased for the usual g of 0.8, which produces the bright
 * white glare around the sun and the silver lining on clouds.
 */
export function miePhase(cosTheta: number, g: number): number {
  const gg = g * g;
  const denominator = 1 + gg - 2 * g * cosTheta;
  return ((1 - gg) / (4 * Math.PI)) * Math.pow(Math.max(1e-6, denominator), -1.5);
}

export interface SkySample {
  /** Radiance reaching the eye from the atmosphere itself. */
  readonly radiance: Spectrum;
  /** Fraction of background light that survives the path. */
  readonly transmittance: Spectrum;
  /** True when the ray terminates on the ground rather than in space. */
  readonly hitGround: boolean;
}

export interface ScatteringParams {
  /** Radius of the viewpoint (m). */
  readonly r: number;
  /** Cosine between up at the viewpoint and the view direction. */
  readonly mu: number;
  /** Cosine between up at the viewpoint and the sun direction. */
  readonly muSun: number;
  /** Cosine between the view direction and the sun direction. */
  readonly nu: number;
  /** Multiple-scattering contribution, if available. */
  readonly multipleScattering?: (r: number, muSun: number) => Spectrum;
  /** Distance to an opaque surface along the ray, if nearer than the sky. */
  readonly maxDistance?: number;
}

/**
 * Integrate single scattering along a view ray.
 *
 * At each step, sunlight that survives the trip down to the sample point is
 * scattered towards the eye, attenuated again on the way out. Summing that
 * over the ray is the whole of the sky's colour.
 */
export function integrateScattering(
  model: AtmosphereModel,
  lut: TransmittanceLut,
  params: ScatteringParams,
): SkySample {
  const { r, mu, muSun, nu } = params;

  const rayHitsGround = hitsGround(r, mu, model.bottomRadius);

  // From outside the atmosphere, skip forward to where the ray actually
  // enters it so every sample lands in air rather than vacuum.
  let start = 0;
  if (r > model.topRadius) {
    const entry = distanceToSphereEntry(r, mu, model.topRadius);
    if (entry < 0) {
      return { radiance: [0, 0, 0], transmittance: [1, 1, 1], hitGround: false };
    }
    start = entry;
  }

  let end = rayHitsGround
    ? distanceToGround(r, mu, model.bottomRadius)
    : distanceToTop(r, mu, model.topRadius);

  if (params.maxDistance !== undefined) {
    end = Math.min(end, params.maxDistance);
  }

  const span = end - start;
  if (span <= 0) {
    return { radiance: [0, 0, 0], transmittance: [1, 1, 1], hitGround: rayHitsGround };
  }

  const step = span / SCATTERING_SAMPLES;
  const rayleighPhaseValue = rayleighPhase(nu);
  const miePhaseValue = miePhase(nu, model.miePhaseG);

  const radiance: [number, number, number] = [0, 0, 0];

  for (let i = 0; i < SCATTERING_SAMPLES; i++) {
    // Sample at segment midpoints: a midpoint rule converges much faster here
    // than sampling at the near edge, which systematically over-weights the
    // dense air close to the viewer.
    const d = start + step * (i + 0.5);

    const sampleRadius = radiusAt(r, mu, d);
    const altitude = sampleRadius - model.bottomRadius;
    const sampleMuSun = muSunAt(r, muSun, nu, d);

    const sunTransmittance = transmittanceToSun(lut, sampleRadius, sampleMuSun);
    const viewTransmittance = transmittanceOverSegment(lut, r, mu, d);

    const rayleigh = rayleighScatteringAt(model, altitude);
    const mie = mieScatteringAt(model, altitude);

    const multiple = params.multipleScattering?.(sampleRadius, sampleMuSun) ?? [0, 0, 0];

    for (let c = 0; c < 3; c++) {
      const rayleighTerm = rayleigh[c]! * rayleighPhaseValue;
      const mieTerm = mie * miePhaseValue;

      // Direct sunlight scattered once into the eye...
      const single = (rayleighTerm + mieTerm) * sunTransmittance[c]!;
      // ...plus ambient light that has already bounced around the sky.
      const multi = (rayleigh[c]! + mie) * multiple[c]!;

      radiance[c]! += (single + multi) * viewTransmittance[c]! * step;
    }
  }

  const scale = model.solarIrradiance;
  return {
    radiance: [radiance[0] * scale[0], radiance[1] * scale[1], radiance[2] * scale[2]],
    transmittance: transmittanceOverSegment(lut, r, mu, end),
    hitGround: rayHitsGround,
  };
}

/** Cosine between the view direction and the sun, from the two zenith cosines. */
export function viewSunCosine(mu: number, muSun: number, azimuth: number): number {
  const sinView = Math.sqrt(Math.max(0, 1 - mu * mu));
  const sinSun = Math.sqrt(Math.max(0, 1 - muSun * muSun));
  return mu * muSun + sinView * sinSun * Math.cos(azimuth);
}

/** Zenith cosine after travelling `d`, exposed for the multi-scattering pass. */
export { muAt };
