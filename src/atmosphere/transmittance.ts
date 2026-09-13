/**
 * Transmittance: the fraction of light surviving a path through the
 * atmosphere, per colour channel.
 *
 * This is the single most reused quantity in the model — every scattering
 * calculation needs to know how much sunlight reached a point and how much of
 * what scattered there reaches the eye. It depends only on (radius, zenith
 * cosine), so it precomputes into a small 2D table once per body and is
 * sampled from then on.
 *
 * It is also where sunsets come from: near the horizon the path through the
 * air is so long that blue is almost entirely extinguished while red survives.
 */
import {
  atmosphereThicknessParameter,
  clampCosine,
  clampRadius,
  distanceToTop,
  hitsGround,
  muAt,
  radiusAt,
} from './geometry.js';
import type { AtmosphereModel, Spectrum } from './model.js';
import { extinctionAt } from './model.js';

/** Samples along each transmittance integration. */
const OPTICAL_DEPTH_SAMPLES = 64;

export const TRANSMITTANCE_WIDTH = 256;
export const TRANSMITTANCE_HEIGHT = 64;

/**
 * Optical depth from (r, mu) to the top of the atmosphere, per channel.
 * Integrated with the trapezoidal rule along the ray.
 */
export function opticalDepthToTop(
  model: AtmosphereModel,
  r: number,
  mu: number,
): Spectrum {
  const distance = distanceToTop(r, mu, model.topRadius);
  if (distance <= 0) return [0, 0, 0];

  const step = distance / OPTICAL_DEPTH_SAMPLES;
  let total: [number, number, number] = [0, 0, 0];

  for (let i = 0; i <= OPTICAL_DEPTH_SAMPLES; i++) {
    const d = step * i;
    const altitude = radiusAt(r, mu, d) - model.bottomRadius;
    const extinction = extinctionAt(model, altitude);

    // Trapezoidal weights: half at the ends, full in between.
    const weight = i === 0 || i === OPTICAL_DEPTH_SAMPLES ? 0.5 : 1;
    total = [
      total[0] + extinction[0] * weight,
      total[1] + extinction[1] * weight,
      total[2] + extinction[2] * weight,
    ];
  }

  return [total[0] * step, total[1] * step, total[2] * step];
}

/** Transmittance from (r, mu) to the top of the atmosphere. */
export function transmittanceToTop(
  model: AtmosphereModel,
  r: number,
  mu: number,
): Spectrum {
  const depth = opticalDepthToTop(model, r, mu);
  return [Math.exp(-depth[0]), Math.exp(-depth[1]), Math.exp(-depth[2])];
}

/**
 * Transmittance between two points on the same ray, separated by `distance`.
 *
 * Computed as the ratio of the two to-top transmittances, which is exact and
 * far cheaper than integrating the segment: the shared outer part of the path
 * cancels.
 */
export function transmittanceOverSegment(
  lut: TransmittanceLut,
  r: number,
  mu: number,
  distance: number,
): Spectrum {
  const model = lut.model;
  const endRadius = clampRadius(
    radiusAt(r, mu, distance),
    model.bottomRadius,
    model.topRadius,
  );
  const endMu = muAt(r, mu, distance);

  // T(a -> top) = T(a -> b) * T(b -> top), so the segment is the ratio of the
  // two to-top transmittances. The shared outer path cancels exactly.
  //
  // The order matters: numerator is always the point further from the top
  // along the ray. Getting this backwards yields ratios above 1 that clamp to
  // 1, which silently removes all attenuation and leaves the sky unshaded.
  const [numerator, denominator] = hitsGround(r, mu, model.bottomRadius)
    ? [
        sampleTransmittance(lut, endRadius, -endMu),
        sampleTransmittance(lut, r, -mu),
      ]
    : [sampleTransmittance(lut, r, mu), sampleTransmittance(lut, endRadius, endMu)];

  return [
    ratio(numerator[0], denominator[0]),
    ratio(numerator[1], denominator[1]),
    ratio(numerator[2], denominator[2]),
  ];
}

/** Transmittance is a fraction, so the ratio can never exceed 1. */
function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? clamp01(numerator / denominator) : 0;
}

/**
 * Transmittance from a point to the sun, or zero when the ground is in the
 * way — which is what puts things in shadow at night.
 */
export function transmittanceToSun(
  lut: TransmittanceLut,
  r: number,
  muSun: number,
): Spectrum {
  if (hitsGround(r, muSun, lut.model.bottomRadius)) return [0, 0, 0];
  return sampleTransmittance(lut, r, muSun);
}

export interface TransmittanceLut {
  readonly model: AtmosphereModel;
  readonly width: number;
  readonly height: number;
  /** RGBA float data, row-major, ready to upload as a texture. */
  readonly data: Float32Array;
}

/**
 * Precompute the transmittance table.
 *
 * The (r, mu) axes use Bruneton's mapping, which concentrates resolution near
 * the horizon where transmittance changes fastest. A naive linear mapping
 * produces visible banding exactly where the interesting colours are.
 */
export function buildTransmittanceLut(model: AtmosphereModel): TransmittanceLut {
  const width = TRANSMITTANCE_WIDTH;
  const height = TRANSMITTANCE_HEIGHT;
  const data = new Float32Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const { r, mu } = transmittanceUvToRMu(
        model,
        (x + 0.5) / width,
        (y + 0.5) / height,
      );

      const transmittance = transmittanceToTop(model, r, mu);
      const offset = (y * width + x) * 4;
      data[offset] = transmittance[0];
      data[offset + 1] = transmittance[1];
      data[offset + 2] = transmittance[2];
      data[offset + 3] = 1;
    }
  }

  return { model, width, height, data };
}

/** Map a LUT texture coordinate back to (radius, zenith cosine). */
export function transmittanceUvToRMu(
  model: AtmosphereModel,
  u: number,
  v: number,
): { r: number; mu: number } {
  const H = atmosphereThicknessParameter(model.bottomRadius, model.topRadius);

  // rho is the distance to the horizon from this radius.
  const rho = H * v;
  const r = Math.sqrt(rho * rho + model.bottomRadius * model.bottomRadius);

  // Map u through the distance to the top boundary rather than through mu
  // directly, which is what keeps horizon detail.
  const dMin = model.topRadius - r;
  const dMax = rho + H;
  const d = dMin + u * (dMax - dMin);

  const mu = d === 0 ? 1 : clampCosine((H * H - rho * rho - d * d) / (2 * r * d));
  return { r, mu };
}

/** Map (radius, zenith cosine) to a LUT texture coordinate. */
export function transmittanceRMuToUv(
  model: AtmosphereModel,
  r: number,
  mu: number,
): { u: number; v: number } {
  const H = atmosphereThicknessParameter(model.bottomRadius, model.topRadius);
  const rho = Math.sqrt(
    Math.max(0, r * r - model.bottomRadius * model.bottomRadius),
  );

  const d = distanceToTop(r, mu, model.topRadius);
  const dMin = model.topRadius - r;
  const dMax = rho + H;

  return {
    u: dMax === dMin ? 0 : clamp01((d - dMin) / (dMax - dMin)),
    v: H === 0 ? 0 : clamp01(rho / H),
  };
}

/** Bilinearly sample the precomputed table. */
export function sampleTransmittance(
  lut: TransmittanceLut,
  r: number,
  mu: number,
): Spectrum {
  const { u, v } = transmittanceRMuToUv(lut.model, r, mu);
  return bilinear(lut, u, v);
}

function bilinear(lut: TransmittanceLut, u: number, v: number): Spectrum {
  const x = clamp01(u) * lut.width - 0.5;
  const y = clamp01(v) * lut.height - 0.5;

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;

  const c00 = texel(lut, x0, y0);
  const c10 = texel(lut, x0 + 1, y0);
  const c01 = texel(lut, x0, y0 + 1);
  const c11 = texel(lut, x0 + 1, y0 + 1);

  const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

  return [
    mix(mix(c00[0], c10[0], fx), mix(c01[0], c11[0], fx), fy),
    mix(mix(c00[1], c10[1], fx), mix(c01[1], c11[1], fx), fy),
    mix(mix(c00[2], c10[2], fx), mix(c01[2], c11[2], fx), fy),
  ];
}

function texel(lut: TransmittanceLut, x: number, y: number): Spectrum {
  const cx = Math.min(lut.width - 1, Math.max(0, x));
  const cy = Math.min(lut.height - 1, Math.max(0, y));
  const offset = (cy * lut.width + cx) * 4;
  return [lut.data[offset]!, lut.data[offset + 1]!, lut.data[offset + 2]!];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
