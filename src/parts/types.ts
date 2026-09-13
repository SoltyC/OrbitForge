/**
 * Part definitions. Parts are plain data, never subclasses, so the catalogue
 * can move to JSON and become moddable without touching simulation code.
 */

export type PartCategory = 'command' | 'engine' | 'tank' | 'decoupler';

/**
 * Where another part can be attached.
 *
 * `stack` nodes join end-to-end along the vehicle's long axis; `radial` nodes
 * hang parts off the side, which is what symmetry groups are built from.
 *
 * Positions are relative to the part's own origin, which sits at the centre of
 * its base — so a part occupies y in [0, length].
 */
export type AttachNodeKind = 'stack' | 'radial';

export interface AttachNode {
  readonly id: string;
  readonly kind: AttachNodeKind;
  /** Offset from the part's origin (m). */
  readonly offset: readonly [number, number, number];
}

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
  /** Attachment points this part offers to others. */
  readonly attachNodes: readonly AttachNode[];
}

/** Standard stack node at the base of a part. */
export function bottomNode(): AttachNode {
  return { id: 'bottom', kind: 'stack', offset: [0, 0, 0] };
}

/** Standard stack node at the top of a part. */
export function topNode(length: number): AttachNode {
  return { id: 'top', kind: 'stack', offset: [0, length, 0] };
}

/** Side-mount node at the midpoint of a part's flank. */
export function radialNode(diameter: number, length: number): AttachNode {
  return { id: 'radial', kind: 'radial', offset: [diameter / 2, length / 2, 0] };
}

export function findAttachNode(part: Part, nodeId: string): AttachNode | undefined {
  return part.attachNodes.find((node) => node.id === nodeId);
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
