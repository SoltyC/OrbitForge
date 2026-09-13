/**
 * Part definitions. Parts are plain data, never subclasses, so the catalogue
 * can move to JSON and become moddable without touching simulation code.
 */

export type PartCategory = 'command' | 'engine' | 'tank' | 'decoupler';

export interface EngineSpec {
  /** Thrust in vacuum (N). */
  readonly thrustVacuum: number;
  /** Thrust at sea level (N). */
  readonly thrustSeaLevel: number;
  /** Specific impulse in vacuum (s). */
  readonly ispVacuum: number;
  /** Specific impulse at sea level (s). */
  readonly ispSeaLevel: number;
  /** Maximum thrust-vector gimbal deflection (rad). */
  readonly gimbalRange: number;
}

export interface TankSpec {
  /** Usable propellant mass (kg). */
  readonly propellantCapacity: number;
}

export interface CommandSpec {
  /** Reaction-wheel torque authority (N*m). */
  readonly torque: number;
}

export interface Part {
  readonly id: string;
  readonly name: string;
  readonly category: PartCategory;
  /** Mass excluding propellant (kg). */
  readonly dryMass: number;
  /** Length along the stack axis (m), used for geometry and CoM. */
  readonly length: number;
  /** Outer diameter (m), used for geometry and drag area. */
  readonly diameter: number;
  readonly engine?: EngineSpec;
  readonly tank?: TankSpec;
  readonly command?: CommandSpec;
}

/** Standard gravity used in the rocket equation and Isp conversions (m/s^2). */
export const G0 = 9.80665;

/**
 * Propellant mass flow rate for an engine at a given ambient pressure ratio.
 * Isp and thrust both vary with pressure; flow is their ratio.
 */
export function massFlowRate(engine: EngineSpec, pressureRatio: number): number {
  return thrustAt(engine, pressureRatio) / (ispAt(engine, pressureRatio) * G0);
}

/** Thrust at a given ambient pressure ratio (0 = vacuum, 1 = sea level). */
export function thrustAt(engine: EngineSpec, pressureRatio: number): number {
  return lerp(engine.thrustVacuum, engine.thrustSeaLevel, pressureRatio);
}

/** Specific impulse at a given ambient pressure ratio (s). */
export function ispAt(engine: EngineSpec, pressureRatio: number): number {
  return lerp(engine.ispVacuum, engine.ispSeaLevel, pressureRatio);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
