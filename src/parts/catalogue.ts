/**
 * Milestone 1 part catalogue. Deliberately small: just enough to fly the
 * hardcoded two-stage test vehicle. The VAB editor (milestone 3) expands this.
 */
import type { Part } from './types.js';

export const MK1_POD: Part = {
  id: 'mk1-pod',
  name: 'Mk1 Command Pod',
  category: 'command',
  dryMass: 800,
  length: 1.6,
  diameter: 1.25,
  command: { torque: 12_000 },
};

export const TANK_LARGE: Part = {
  id: 'tank-large',
  name: 'FL-T800 Tank',
  category: 'tank',
  dryMass: 1_000,
  length: 7.5,
  diameter: 1.25,
  tank: { propellantCapacity: 9_000 },
};

export const TANK_SMALL: Part = {
  id: 'tank-small',
  name: 'FL-T200 Tank',
  category: 'tank',
  dryMass: 250,
  length: 2.0,
  diameter: 1.25,
  tank: { propellantCapacity: 2_000 },
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
};

export const DECOUPLER: Part = {
  id: 'decoupler-stack',
  name: 'TD-12 Stack Decoupler',
  category: 'decoupler',
  dryMass: 50,
  length: 0.3,
  diameter: 1.25,
};

export const CATALOGUE: readonly Part[] = [
  MK1_POD,
  TANK_LARGE,
  TANK_SMALL,
  ENGINE_BOOSTER,
  ENGINE_VACUUM,
  DECOUPLER,
];
