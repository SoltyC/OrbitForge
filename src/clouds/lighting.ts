/**
 * Cloud lighting.
 *
 * Clouds are not lit like surfaces. Light entering a cloud scatters many times
 * before leaving, and it is that multiple scattering that produces the two
 * things the eye recognises instantly: bright rims where the sun is behind a
 * cloud, and the fact that a thick cloud's core is grey rather than black.
 *
 * Beer's law alone gives neither. It makes dense clouds uniformly dark, which
 * reads as smoke. The multi-scatter octaves below are the correction, and they
 * are what make this look like a cloud.
 *
 * There is a second well-known correction — the "powder" term, which darkens
 * thin cloud edges to give a crumbly, sugary look. It is deliberately not here.
 * It models the same phenomenon as the octaves below (light that has scattered
 * in but not yet out) by a different and less principled route, so applying
 * both double-counts it. The octaves are energy-conserving; powder is a curve
 * fitted to look right. If the edges ever need to be crumblier, that is the
 * knob to reach for, and it should replace an octave rather than stack on top.
 */

/**
 * Henyey-Greenstein phase function — the same one the atmosphere uses, but
 * clouds need two lobes rather than one.
 */
export function henyeyGreenstein(cosTheta: number, g: number): number {
  const gg = g * g;
  const denominator = Math.max(1e-6, 1 + gg - 2 * g * cosTheta);
  return ((1 - gg) / (4 * Math.PI)) * Math.pow(denominator, -1.5);
}

/**
 * Two-lobe phase: a strong forward lobe for the silver lining, plus a weak
 * backward lobe so clouds do not go flat when the sun is behind the viewer.
 *
 * A single forward lobe leaves the anti-solar sky looking dead; real water
 * droplets scatter backwards enough to matter.
 */
export function dualLobePhase(
  cosTheta: number,
  forwardG: number,
  backwardG: number,
  blend: number,
): number {
  return (
    (1 - blend) * henyeyGreenstein(cosTheta, forwardG) +
    blend * henyeyGreenstein(cosTheta, -backwardG)
  );
}

/**
 * Energy-conserving multiple scattering, approximated as a few octaves of
 * progressively wider, dimmer, less extincting scattering.
 *
 * Each octave stands in for light that has bounced one more time: it is
 * attenuated less (it has spread out) and scatters more isotropically. Three
 * octaves is enough to lift cloud cores out of black.
 */
export interface ScatterOctaves {
  readonly count: number;
  /** How fast each octave's contribution falls off. */
  readonly attenuation: number;
  /** How fast each octave's extinction falls off. */
  readonly contribution: number;
  /** How fast each octave's phase flattens towards isotropic. */
  readonly phaseAttenuation: number;
}

export const DEFAULT_OCTAVES: ScatterOctaves = {
  count: 3,
  attenuation: 0.5,
  contribution: 0.5,
  phaseAttenuation: 0.5,
};

/**
 * Light reaching a point inside the cloud, summed over scattering octaves.
 *
 * @param sunOpticalDepth Optical depth between the sample and the sun.
 * @param cosTheta Cosine between the view and sun directions.
 */
export function multiScatter(
  sunOpticalDepth: number,
  cosTheta: number,
  octaves: ScatterOctaves = DEFAULT_OCTAVES,
): number {
  let luminance = 0;
  let attenuation = 1;
  let contribution = 1;
  let phaseAttenuation = 1;

  for (let i = 0; i < octaves.count; i++) {
    // Later octaves scatter more isotropically: lerp g towards zero.
    const phase = dualLobePhase(cosTheta, 0.8 * phaseAttenuation, 0.3 * phaseAttenuation, 0.15);

    luminance += contribution * phase * Math.exp(-sunOpticalDepth * attenuation);

    attenuation *= octaves.attenuation;
    contribution *= octaves.contribution;
    phaseAttenuation *= octaves.phaseAttenuation;
  }

  return luminance;
}
