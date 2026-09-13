/**
 * Physical atmosphere model.
 *
 * Coefficients follow Bruneton's parameterisation: Rayleigh scattering from
 * air molecules, Mie scattering and absorption from aerosols, and a band of
 * ozone that absorbs without scattering. Together these are what make a sky
 * blue overhead, white near the horizon, orange at sunset and a thin blue rim
 * seen from orbit — all from one model rather than four special cases.
 *
 * Everything here is pure data and pure functions, so the whole model can be
 * evaluated and tested without a GPU.
 */
import type { Body } from '../bodies/types.js';

/** RGB triple in linear light. */
export type Spectrum = readonly [number, number, number];

export interface AtmosphereModel {
  /** Radius of the ground (m). */
  readonly bottomRadius: number;
  /** Radius of the top of the atmosphere (m). */
  readonly topRadius: number;

  /** Rayleigh scattering coefficient at sea level, per metre, per channel. */
  readonly rayleighScattering: Spectrum;
  /** Rayleigh density falls as exp(-h / scaleHeight). */
  readonly rayleighScaleHeight: number;

  /** Mie scattering coefficient at sea level (m^-1). */
  readonly mieScattering: number;
  /** Mie extinction = scattering + absorption (m^-1). */
  readonly mieExtinction: number;
  readonly mieScaleHeight: number;
  /** Henyey-Greenstein asymmetry: positive scatters forward. */
  readonly miePhaseG: number;

  /** Ozone absorbs but does not scatter (m^-1). */
  readonly ozoneAbsorption: Spectrum;
  /** Altitude of peak ozone density (m). */
  readonly ozoneCentre: number;
  /** Half-width of the ozone tent (m). */
  readonly ozoneWidth: number;

  /** Ground reflectance, used by the multiple-scattering pass. */
  readonly groundAlbedo: Spectrum;
  /** Solar irradiance at the top of the atmosphere, per channel. */
  readonly solarIrradiance: Spectrum;
}

/**
 * Earth's sea-level Rayleigh coefficients (m^-1).
 *
 * The blue-to-red ratio here is about 5.7, which is the 1/lambda^4 dependence
 * that makes the sky blue — it is not an artistic choice.
 */
const RAYLEIGH_SEA_LEVEL: Spectrum = [5.802e-6, 13.558e-6, 33.1e-6];

const MIE_SCATTERING = 3.996e-6;
const MIE_EXTINCTION = 4.44e-6;
const MIE_ASYMMETRY = 0.8;

const OZONE_ABSORPTION: Spectrum = [0.65e-6, 1.881e-6, 0.085e-6];

/**
 * Aerosol and ozone layers are described relative to the Rayleigh scale
 * height so the model transfers to any body rather than hardcoding Earth's
 * kilometres. These ratios reproduce Earth's profile at its own 8 km.
 */
const MIE_SCALE_HEIGHT_RATIO = 0.15;
const OZONE_CENTRE_RATIO = 3.125;
const OZONE_WIDTH_RATIO = 1.875;

/** Build a scattering model for a body that has an atmosphere. */
export function createAtmosphereModel(body: Body): AtmosphereModel | null {
  const atmosphere = body.atmosphere;
  if (!atmosphere) return null;

  const scaleHeight = atmosphere.scaleHeight;

  // Scattering scales with how much air there actually is at sea level.
  const densityRatio = atmosphere.seaLevelDensity / 1.225;

  return {
    bottomRadius: body.radius,
    topRadius: body.radius + atmosphere.height,

    rayleighScattering: scale(RAYLEIGH_SEA_LEVEL, densityRatio),
    rayleighScaleHeight: scaleHeight,

    mieScattering: MIE_SCATTERING * densityRatio,
    mieExtinction: MIE_EXTINCTION * densityRatio,
    mieScaleHeight: scaleHeight * MIE_SCALE_HEIGHT_RATIO,
    miePhaseG: MIE_ASYMMETRY,

    ozoneAbsorption: scale(OZONE_ABSORPTION, densityRatio),
    ozoneCentre: scaleHeight * OZONE_CENTRE_RATIO,
    ozoneWidth: scaleHeight * OZONE_WIDTH_RATIO,

    groundAlbedo: [0.1, 0.1, 0.1],
    solarIrradiance: [1, 1, 1],
  };
}

/** Rayleigh density at altitude, normalised to 1 at sea level. */
export function rayleighDensity(model: AtmosphereModel, altitude: number): number {
  return Math.exp(-Math.max(0, altitude) / model.rayleighScaleHeight);
}

/** Mie density at altitude, normalised to 1 at sea level. */
export function mieDensity(model: AtmosphereModel, altitude: number): number {
  return Math.exp(-Math.max(0, altitude) / model.mieScaleHeight);
}

/**
 * Ozone density at altitude: a linear tent peaking at `ozoneCentre`.
 * Unlike air, ozone is concentrated in a band well above the ground, which is
 * what tints the twilight sky rather than the daytime one.
 */
export function ozoneDensity(model: AtmosphereModel, altitude: number): number {
  const distance = Math.abs(altitude - model.ozoneCentre);
  return Math.max(0, 1 - distance / model.ozoneWidth);
}

/** Total extinction coefficient at an altitude, per channel (m^-1). */
export function extinctionAt(model: AtmosphereModel, altitude: number): Spectrum {
  const rayleigh = rayleighDensity(model, altitude);
  const mie = mieDensity(model, altitude);
  const ozone = ozoneDensity(model, altitude);

  return [
    model.rayleighScattering[0] * rayleigh +
      model.mieExtinction * mie +
      model.ozoneAbsorption[0] * ozone,
    model.rayleighScattering[1] * rayleigh +
      model.mieExtinction * mie +
      model.ozoneAbsorption[1] * ozone,
    model.rayleighScattering[2] * rayleigh +
      model.mieExtinction * mie +
      model.ozoneAbsorption[2] * ozone,
  ];
}

/** Rayleigh scattering coefficient at an altitude, per channel (m^-1). */
export function rayleighScatteringAt(
  model: AtmosphereModel,
  altitude: number,
): Spectrum {
  return scale(model.rayleighScattering, rayleighDensity(model, altitude));
}

/** Mie scattering coefficient at an altitude (m^-1). */
export function mieScatteringAt(model: AtmosphereModel, altitude: number): number {
  return model.mieScattering * mieDensity(model, altitude);
}

function scale(spectrum: Spectrum, factor: number): Spectrum {
  return [spectrum[0] * factor, spectrum[1] * factor, spectrum[2] * factor];
}
