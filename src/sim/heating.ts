/**
 * Aerodynamic heating.
 *
 * A vessel returning from orbit arrives with the kinetic energy of its whole
 * ascent and has to be rid of it. Almost all of that goes into the air rather
 * than the vehicle — the bow shock does the work, which is why blunt bodies
 * survive reentry and sharp ones do not — but what reaches the skin is still
 * enough to melt most of it.
 *
 * Two things balance. Heat arrives by convection from the shock layer, roughly
 * as the cube of speed, so the last few hundred metres per second of a descent
 * matter far less than the first few thousand. Heat leaves by radiation, as the
 * fourth power of temperature, which is what gives a vehicle an equilibrium it
 * can sit at rather than simply accumulating until it fails.
 *
 * Pure functions over plain numbers, no renderer and no global state, so the
 * whole thing can be flown in a test.
 */
import type { Body } from '../bodies/types.js';
import { densityAt } from './atmosphere.js';
import type { Vec3 } from './vec3.js';
import { surfaceRelativeVelocity } from './forces.js';

/**
 * Sutton-Graves constant for air (kg^0.5 / m).
 *
 * The standard engineering correlation for stagnation-point convective
 * heating: q = k * sqrt(rho / Rn) * v^3.
 */
const SUTTON_GRAVES = 1.7415e-4;

/** Stefan-Boltzmann constant (W / m^2 / K^4). */
const STEFAN_BOLTZMANN = 5.670374e-8;

/** Emissivity of a hot ceramic surface. */
const EMISSIVITY = 0.85;

/** Ambient temperature the skin relaxes towards (K). */
const AMBIENT_TEMPERATURE = 250;

/**
 * Heat capacity of the skin, per square metre (J / m^2 / K).
 *
 * Thermal mass, not the whole vehicle's: only the outer layer heats and cools
 * on the timescale of a reentry. A small value makes the skin track the flux
 * almost instantly; a large one lags behind it.
 *
 * Calibrated against how fast a descent actually is. At 32,000 the skin gained
 * three kelvin a step and a thirty-second entry ended at 600 K while the air
 * around it sat at an equilibrium of 1,700 — the vehicle was never in the
 * atmosphere long enough to feel it. Real thermal protection responds in
 * seconds, which is what makes a steep entry more dangerous than a shallow one
 * rather than less.
 */
const SKIN_HEAT_CAPACITY = 7_000;

export interface ThermalState {
  /** Skin temperature at the stagnation point (K). */
  readonly temperature: number;
  /** Fraction of the heat shield remaining, in [0, 1]. */
  readonly shield: number;
}

export const AMBIENT_THERMAL: ThermalState = {
  temperature: AMBIENT_TEMPERATURE,
  shield: 1,
};

export interface HeatingConditions {
  /** Convective heat flux at the stagnation point (W / m^2). */
  readonly flux: number;
  /** Speed relative to the air (m/s). */
  readonly airspeed: number;
  readonly density: number;
}

/**
 * Convective heating at the stagnation point.
 *
 * @param noseRadius Radius of curvature of the leading surface (m). Blunter is
 *   cooler — heating goes as its inverse square root, which is the whole
 *   reason capsules are shaped the way they are.
 */
export function stagnationFlux(
  density: number,
  airspeed: number,
  noseRadius: number,
): number {
  if (density <= 0 || airspeed <= 0 || noseRadius <= 0) return 0;
  return SUTTON_GRAVES * Math.sqrt(density / noseRadius) * airspeed ** 3;
}

/** Heating conditions for a vessel at a point in its flight. */
export function heatingConditions(
  body: Body,
  position: Vec3,
  velocity: Vec3,
  noseRadius: number,
): HeatingConditions {
  const altitude = position.length - body.radius;
  const density = densityAt(body, altitude);
  const airspeed = surfaceRelativeVelocity(body, position, velocity).length;

  return {
    flux: stagnationFlux(density, airspeed, noseRadius),
    airspeed,
    density,
  };
}

/**
 * Temperature at which incoming convection and outgoing radiation balance (K).
 *
 * The number that actually decides whether a vehicle survives: a reentry that
 * holds below its materials' limit is survivable however long it lasts, and one
 * above them fails however briefly.
 */
export function equilibriumTemperature(flux: number): number {
  if (flux <= 0) return AMBIENT_TEMPERATURE;
  return Math.max(
    AMBIENT_TEMPERATURE,
    (flux / (EMISSIVITY * STEFAN_BOLTZMANN)) ** 0.25,
  );
}

/**
 * Heat of ablation (J / kg).
 *
 * An ablative shield works by being destroyed: the material carries heat away
 * as it chars and boils off, which is why it protects so much better per
 * kilogram than anything that merely insulates.
 */
const ABLATION_HEAT = 1.2e7;

/** Shield mass per square metre of exposed area (kg / m^2). */
const SHIELD_AREAL_MASS = 45;

/** Flux above which the shield begins to ablate (W / m^2). */
const ABLATION_THRESHOLD = 1.4e5;

export interface HeatingStep {
  readonly thermal: ThermalState;
  /** Fraction of the incoming heat the shield absorbed, in [0, 1]. */
  readonly shielded: number;
}

/**
 * Advance the thermal state by one timestep.
 *
 * While shield remains, most of the heat above the ablation threshold goes
 * into destroying it rather than into the skin. Once it is gone the skin takes
 * the full flux and climbs towards equilibrium, which for an orbital entry is
 * well past what any structure survives.
 */
export function stepHeating(
  thermal: ThermalState,
  flux: number,
  dt: number,
): HeatingStep {
  if (dt <= 0) return { thermal, shielded: 0 };

  // Ablation consumes shield proportionally to the heat it absorbs.
  const ablating = thermal.shield > 0 && flux > ABLATION_THRESHOLD;
  const absorbed = ablating ? flux - ABLATION_THRESHOLD : 0;

  const consumed = absorbed > 0
    ? Math.min(thermal.shield, (absorbed * dt) / (ABLATION_HEAT * SHIELD_AREAL_MASS))
    : 0;

  const shield = Math.max(0, thermal.shield - consumed);
  const shielded = flux > 0 ? Math.min(1, absorbed / flux) : 0;

  // What the skin actually feels.
  const reaching = flux - absorbed * (consumed > 0 ? 1 : 0);

  // Radiated away, as the fourth power of temperature.
  const radiated =
    EMISSIVITY * STEFAN_BOLTZMANN * (thermal.temperature ** 4 - AMBIENT_TEMPERATURE ** 4);

  const rate = (reaching - radiated) / SKIN_HEAT_CAPACITY;

  // Clamped so a long step cannot overshoot equilibrium and oscillate.
  const target = equilibriumTemperature(reaching);
  const next = thermal.temperature + rate * dt;

  const temperature =
    rate > 0
      ? Math.min(next, Math.max(thermal.temperature, target))
      : Math.max(next, Math.min(thermal.temperature, target));

  return {
    thermal: { temperature: Math.max(AMBIENT_TEMPERATURE, temperature), shield },
    shielded,
  };
}

/** Temperature above which unprotected structure fails (K). */
export const STRUCTURAL_LIMIT = 1_600;

/** Whether the vessel has been destroyed by heating. */
export function hasBurnedUp(thermal: ThermalState): boolean {
  return thermal.temperature >= STRUCTURAL_LIMIT;
}

/**
 * How brightly the vehicle glows, in [0, 1].
 *
 * Radiated power goes as the fourth power of temperature, but the eye responds
 * roughly logarithmically, so this is deliberately neither — it is a visual
 * curve that reaches zero where a surface stops being visibly hot.
 */
export function glowIntensity(temperature: number): number {
  const onset = 900;
  if (temperature <= onset) return 0;
  return Math.min(1, (temperature - onset) / (STRUCTURAL_LIMIT * 1.4 - onset));
}

/**
 * Colour of a glowing surface at a temperature, as linear RGB.
 *
 * Follows the black-body sequence the eye knows — dull red, orange, yellow,
 * white — rather than a true Planck curve, which at these temperatures would
 * be almost entirely infrared and look far duller than a reentry does.
 */
export function glowColour(temperature: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, (temperature - 900) / 1_300));

  return [
    Math.min(1, 0.35 + 0.65 * t * 2.2),
    Math.min(1, 0.02 + 1.25 * Math.max(0, t - 0.14) ** 1.15),
    Math.min(1, 0.01 + 1.6 * Math.max(0, t - 0.4) ** 1.35),
  ];
}
