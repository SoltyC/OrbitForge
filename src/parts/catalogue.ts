/**
 * Part catalogue.
 *
 * Every part is plain data with a list of attachment nodes. Nothing here knows
 * about rendering or simulation — the editor reads these to build a craft, and
 * the assembler compiles that craft into something the physics can fly.
 */
import type { Part } from './types.js';
import { bottomNode, radialNode, topNode } from './types.js';

export const MK1_POD: Part = {
  id: 'mk1-pod',
  name: 'Mk1 Command Pod',
  category: 'command',
  dryMass: 800,
  length: 1.6,
  diameter: 1.25,
  command: { torque: 12_000 },
  // A pod is the top of the stack: things attach below it only.
  attachNodes: [bottomNode()],
};

export const TANK_LARGE: Part = {
  id: 'tank-large',
  name: 'FL-T800 Tank',
  category: 'tank',
  dryMass: 1_000,
  length: 7.5,
  diameter: 1.25,
  tank: { propellantCapacity: 9_000 },
  attachNodes: [bottomNode(), topNode(7.5), radialNode(1.25, 7.5)],
};

export const TANK_SMALL: Part = {
  id: 'tank-small',
  name: 'FL-T200 Tank',
  category: 'tank',
  dryMass: 250,
  length: 2.0,
  diameter: 1.25,
  tank: { propellantCapacity: 2_000 },
  attachNodes: [bottomNode(), topNode(2.0), radialNode(1.25, 2.0)],
};

export const ENGINE_BOOSTER: Part = {
  id: 'engine-booster',
  name: 'RT-1 "Anvil" Booster',
  category: 'engine',
  dryMass: 1_500,
  length: 2.2,
  diameter: 1.25,
  engine: {
    thrustVacuum: 265_000,
    thrustSeaLevel: 240_000,
    ispVacuum: 300,
    ispSeaLevel: 265,
    gimbalRange: 0.0524, // 3 degrees
  },
  // The bottom node is what a stack decoupler mounts to when this engine is
  // the base of an upper stage.
  attachNodes: [bottomNode(), topNode(2.2)],
};

export const ENGINE_VACUUM: Part = {
  id: 'engine-vacuum',
  name: 'LV-9 "Spark" Vacuum Engine',
  category: 'engine',
  dryMass: 400,
  length: 1.4,
  diameter: 1.25,
  engine: {
    thrustVacuum: 60_000,
    thrustSeaLevel: 42_000,
    ispVacuum: 345,
    ispSeaLevel: 240,
    gimbalRange: 0.0698, // 4 degrees
  },
  attachNodes: [bottomNode(), topNode(1.4)],
};

export const DECOUPLER: Part = {
  id: 'decoupler-stack',
  name: 'TD-12 Stack Decoupler',
  category: 'decoupler',
  dryMass: 50,
  length: 0.3,
  diameter: 1.25,
  attachNodes: [bottomNode(), topNode(0.3)],
};

export const CATALOGUE: readonly Part[] = [
  MK1_POD,
  TANK_LARGE,
  TANK_SMALL,
  ENGINE_BOOSTER,
  ENGINE_VACUUM,
  DECOUPLER,
];

export function findPart(partId: string): Part {
  const part = CATALOGUE.find((candidate) => candidate.id === partId);
  if (!part) throw new Error(`Unknown part: ${partId}`);
  return part;
}
