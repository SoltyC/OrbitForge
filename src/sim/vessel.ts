/**
 * Vessel composition and mass properties.
 *
 * A vessel is an ordered list of stages, lowest first: `stages[0]` is the one
 * currently burning and the next to be jettisoned. The topmost stage is the
 * payload (no engine, no propellant), which keeps staging uniform.
 *
 * All operations are pure — staging and propellant consumption return a new
 * vessel rather than mutating the existing one.
 */
import type { EngineSpec, Part } from '../parts/types.js';
import { G0, ispAt, massFlowRate, thrustAt } from '../parts/types.js';

export interface Stage {
  readonly parts: readonly Part[];
  /** Remaining usable propellant in this stage (kg). */
  readonly propellant: number;
}

export interface Vessel {
  readonly name: string;
  readonly stages: readonly Stage[];
}

/** Total propellant capacity of a stage (kg). */
export function stageCapacity(stage: Stage): number {
  return stage.parts.reduce((sum, part) => sum + (part.tank?.propellantCapacity ?? 0), 0);
}

/** Dry mass of a stage, excluding propellant (kg). */
export function stageDryMass(stage: Stage): number {
  return stage.parts.reduce((sum, part) => sum + part.dryMass, 0);
}

/** Current total mass of a stage including propellant (kg). */
export function stageMass(stage: Stage): number {
  return stageDryMass(stage) + stage.propellant;
}

/** Current total mass of the whole vessel (kg). */
export function vesselMass(vessel: Vessel): number {
  return vessel.stages.reduce((sum, stage) => sum + stageMass(stage), 0);
}

/** The engine of the active (lowest) stage, or null if it has none. */
export function activeEngine(vessel: Vessel): EngineSpec | null {
  const stage = vessel.stages[0];
  if (!stage) return null;
  const enginePart = stage.parts.find((part) => part.engine);
  return enginePart?.engine ?? null;
}

/** Reaction-wheel torque authority summed across all remaining parts (N*m). */
export function torqueAuthority(vessel: Vessel): number {
  return vessel.stages.reduce(
    (sum, stage) =>
      sum + stage.parts.reduce((s, part) => s + (part.command?.torque ?? 0), 0),
    0,
  );
}

/** True if the active stage has propellant left to burn. */
export function hasPropellant(vessel: Vessel): boolean {
  const stage = vessel.stages[0];
  return stage !== undefined && stage.propellant > 0;
}

/** Overall vessel length along the stack axis (m). */
export function vesselLength(vessel: Vessel): number {
  return vessel.stages.reduce(
    (sum, stage) => sum + stage.parts.reduce((s, part) => s + part.length, 0),
    0,
  );
}

/** Reference area for drag, taken from the widest part (m^2). */
export function dragArea(vessel: Vessel): number {
  const maxDiameter = vessel.stages.reduce(
    (max, stage) =>
      Math.max(max, ...stage.parts.map((part) => part.diameter)),
    0,
  );
  const radius = maxDiameter / 2;
  return Math.PI * radius * radius;
}

/**
 * Longitudinal moment of inertia, approximating the stack as a uniform rod
 * about its centre: I = m*L^2 / 12. Good enough for attitude control response;
 * a per-part parallel-axis sum replaces it when the editor lands.
 */
export function momentOfInertia(vessel: Vessel): number {
  const length = vesselLength(vessel);
  return (vesselMass(vessel) * length * length) / 12;
}

/**
 * Burn propellant from the active stage, returning the new vessel and the
 * mass actually consumed (which is less than requested if the tank runs dry).
 */
export function consumePropellant(
  vessel: Vessel,
  requestedMass: number,
): { vessel: Vessel; consumed: number } {
  const stage = vessel.stages[0];
  if (!stage || requestedMass <= 0) return { vessel, consumed: 0 };

  const consumed = Math.min(stage.propellant, requestedMass);
  const updatedStage: Stage = { ...stage, propellant: stage.propellant - consumed };

  return {
    vessel: { ...vessel, stages: [updatedStage, ...vessel.stages.slice(1)] },
    consumed,
  };
}

/**
 * Jettison the active stage. Refuses to drop the payload stage, so a vessel
 * always retains at least one stage.
 */
export function jettisonStage(vessel: Vessel): Vessel {
  if (vessel.stages.length <= 1) return vessel;
  return { ...vessel, stages: vessel.stages.slice(1) };
}

/**
 * Ideal delta-v of a single stage via the Tsiolkovsky rocket equation:
 * dv = Isp * g0 * ln(m_wet / m_dry), where the masses include everything
 * the stage has to push (itself plus all stages above it).
 */
export function stageDeltaV(
  vessel: Vessel,
  stageIndex: number,
  pressureRatio = 0,
): number {
  const stage = vessel.stages[stageIndex];
  if (!stage) return 0;

  const enginePart = stage.parts.find((part) => part.engine);
  if (!enginePart?.engine || stage.propellant <= 0) return 0;

  const massAbove = vessel.stages
    .slice(stageIndex + 1)
    .reduce((sum, s) => sum + stageMass(s), 0);

  const wetMass = massAbove + stageMass(stage);
  const dryMass = wetMass - stage.propellant;
  if (dryMass <= 0) return 0;

  return ispAt(enginePart.engine, pressureRatio) * G0 * Math.log(wetMass / dryMass);
}

/** Total remaining ideal delta-v across all stages (m/s). */
export function totalDeltaV(vessel: Vessel, pressureRatio = 0): number {
  return vessel.stages.reduce(
    (sum, _stage, index) => sum + stageDeltaV(vessel, index, pressureRatio),
    0,
  );
}

/** Thrust-to-weight ratio against a given local gravity (dimensionless). */
export function thrustToWeight(
  vessel: Vessel,
  localGravity: number,
  pressureRatio: number,
  throttle = 1,
): number {
  const engine = activeEngine(vessel);
  if (!engine || localGravity <= 0) return 0;
  return (thrustAt(engine, pressureRatio) * throttle) / (vesselMass(vessel) * localGravity);
}

/** Propellant mass flow of the active engine at a throttle setting (kg/s). */
export function currentMassFlow(
  vessel: Vessel,
  pressureRatio: number,
  throttle: number,
): number {
  const engine = activeEngine(vessel);
  if (!engine) return 0;
  return massFlowRate(engine, pressureRatio) * throttle;
}
