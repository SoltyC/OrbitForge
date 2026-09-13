/**
 * "Pathfinder I" — the default craft loaded in the editor and flown by tests.
 *
 * Built as an attachment tree rather than a hand-written stage list, so it goes
 * through exactly the same assembly path as anything a player builds. That
 * keeps one source of truth: if the assembler is wrong, the reference vehicle
 * stops flying and the tests say so.
 *
 * Liftoff mass 15.05 t, launch TWR ~1.63, roughly 5.5 km/s of ideal delta-v
 * against the ~3.4 km/s needed to orbit Terrin.
 */
import { craftToVessel } from './assembly.js';
import { attachPart, createCraft } from './craft.js';
import type { Craft } from './craft.js';
import type { Vessel } from '../sim/vessel.js';

/**
 * Stack from the top down: pod, decoupler, upper stage, decoupler, booster.
 * Each decoupler is a stage boundary, so this compiles to three stages.
 */
export function createPathfinderCraft(): Craft {
  let craft = createCraft('Pathfinder I', 'mk1-pod');

  const stack: readonly { partId: string; parentNodeId: string }[] = [
    { partId: 'decoupler-stack', parentNodeId: 'bottom' },
    { partId: 'tank-small', parentNodeId: 'bottom' },
    { partId: 'engine-vacuum', parentNodeId: 'bottom' },
    { partId: 'decoupler-stack', parentNodeId: 'bottom' },
    { partId: 'tank-large', parentNodeId: 'bottom' },
    { partId: 'engine-booster', parentNodeId: 'bottom' },
  ];

  // Each part hangs from the bottom node of the one placed before it.
  let parentId = 'root';
  for (const entry of stack) {
    const before = craft.parts.length;
    craft = attachPart(craft, {
      parentId,
      parentNodeId: entry.parentNodeId,
      partId: entry.partId,
    });
    parentId = craft.parts[before]!.id;
  }

  return craft;
}

export function createPathfinder(): Vessel {
  return craftToVessel(createPathfinderCraft());
}
