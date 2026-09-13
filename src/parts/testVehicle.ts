/**
 * "Pathfinder I" — the hardcoded two-stage test vehicle for milestone 1.
 *
 * Liftoff mass 15.0 t, launch TWR ~1.63, roughly 5.4 km/s of ideal delta-v
 * against the ~3.4 km/s needed to orbit Terrin. The margin is deliberate: the
 * point of milestone 1 is to validate the physics, not to fly a tight budget.
 *
 * Replaced by player-built craft when the VAB lands in milestone 3.
 */
import type { Vessel } from '../sim/vessel.js';
import {
  DECOUPLER,
  ENGINE_BOOSTER,
  ENGINE_VACUUM,
  MK1_POD,
  TANK_LARGE,
  TANK_SMALL,
} from './catalogue.js';

export function createPathfinder(): Vessel {
  return {
    name: 'Pathfinder I',
    stages: [
      {
        parts: [ENGINE_BOOSTER, TANK_LARGE, DECOUPLER],
        propellant: TANK_LARGE.tank!.propellantCapacity,
      },
      {
        parts: [ENGINE_VACUUM, TANK_SMALL],
        propellant: TANK_SMALL.tank!.propellantCapacity,
      },
      {
        parts: [MK1_POD],
        propellant: 0,
      },
    ],
  };
}
