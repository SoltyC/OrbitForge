/**
 * Craft assembly: compiling an editor attachment tree into the flat, staged
 * Vessel the physics simulation flies, plus the geometry the renderer draws.
 *
 * Staging is derived from the tree rather than set by hand. A decoupler is a
 * stage boundary: everything below it drops together when it fires, and the
 * decoupler goes with the part being jettisoned. Counting decouplers along the
 * path from the root gives each part its stage automatically.
 */
import type { Craft, PartInstance } from './craft.js';
import { childrenOf, partOf, rootInstance } from './craft.js';
import type { Part } from './types.js';
import { findAttachNode } from './types.js';
import type { Stage, Vessel } from '../sim/vessel.js';

export interface PartPlacement {
  readonly instance: PartInstance;
  readonly part: Part;
  /** Position of the part's base, in craft-local metres (y is the stack axis). */
  readonly position: readonly [number, number, number];
  /** Stage this part belongs to; 0 fires first. */
  readonly stageIndex: number;
}

export interface Assembly {
  readonly vessel: Vessel;
  readonly placements: readonly PartPlacement[];
  /** Overall height of the stack (m). */
  readonly height: number;
}

/** Compile a craft into a flyable vessel and its geometry. */
export function assemble(craft: Craft): Assembly {
  const depths = computeDecouplerDepths(craft);
  const maxDepth = Math.max(...depths.values());

  const layout = computeLayout(craft);
  const lowest = Math.min(...[...layout.values()].map((p) => p[1]));

  const placements: PartPlacement[] = craft.parts.map((instance) => {
    const raw = layout.get(instance.id) ?? [0, 0, 0];
    return {
      instance,
      part: partOf(instance),
      // Normalise so the bottom of the stack sits at y = 0.
      position: [raw[0], raw[1] - lowest, raw[2]],
      // Deepest parts are furthest down the stack, so they fire first.
      stageIndex: maxDepth - (depths.get(instance.id) ?? 0),
    };
  });

  const height = Math.max(
    ...placements.map((placement) => placement.position[1] + placement.part.length),
  );

  return { vessel: buildVessel(craft.name, placements, maxDepth), placements, height };
}

/** Convenience wrapper when only the flyable vessel is needed. */
export function craftToVessel(craft: Craft): Vessel {
  return assemble(craft).vessel;
}

function buildVessel(
  name: string,
  placements: readonly PartPlacement[],
  maxDepth: number,
): Vessel {
  const stages: Stage[] = [];

  for (let index = 0; index <= maxDepth; index++) {
    const parts = placements
      .filter((placement) => placement.stageIndex === index)
      .map((placement) => placement.part);

    stages.push({
      parts,
      propellant: parts.reduce(
        (sum, part) => sum + (part.tank?.propellantCapacity ?? 0),
        0,
      ),
    });
  }

  return { name, stages };
}

/**
 * Number of decouplers on the path from the root to each part, counting the
 * part itself when it is a decoupler.
 */
function computeDecouplerDepths(craft: Craft): Map<string, number> {
  const depths = new Map<string, number>();

  const walk = (instance: PartInstance, parentDepth: number): void => {
    const isDecoupler = partOf(instance).category === 'decoupler';
    const depth = parentDepth + (isDecoupler ? 1 : 0);
    depths.set(instance.id, depth);

    for (const child of childrenOf(craft, instance.id)) walk(child, depth);
  };

  walk(rootInstance(craft), 0);
  return depths;
}

/**
 * Position every part relative to the root.
 *
 * Parts occupy y in [0, length] from their own origin, so stack attachment is
 * just arithmetic on that: a part hung below its parent sits one of its own
 * lengths further down.
 */
function computeLayout(craft: Craft): Map<string, [number, number, number]> {
  const layout = new Map<string, [number, number, number]>();
  const root = rootInstance(craft);
  layout.set(root.id, [0, 0, 0]);

  const walk = (instance: PartInstance): void => {
    const base = layout.get(instance.id)!;

    for (const child of childrenOf(craft, instance.id)) {
      layout.set(child.id, placeChild(instance, base, child));
      walk(child);
    }
  };

  walk(root);
  return layout;
}

function placeChild(
  parent: PartInstance,
  parentBase: readonly [number, number, number],
  child: PartInstance,
): [number, number, number] {
  const parentPart = partOf(parent);
  const childPart = partOf(child);

  // Symmetric copies carry no node of their own — they share the radial node
  // claimed by the primary of their group.
  const node = child.parentNodeId
    ? findAttachNode(parentPart, child.parentNodeId)
    : parentPart.attachNodes.find((candidate) => candidate.kind === 'radial');

  if (!node) return [parentBase[0], parentBase[1], parentBase[2]];

  if (node.kind === 'radial') {
    return radialPlacement(parentBase, node.offset, childPart, child.radialAngle);
  }

  // Hanging below the parent: the child's top meets the parent's base.
  if (node.id === 'bottom') {
    return [parentBase[0], parentBase[1] - childPart.length, parentBase[2]];
  }

  // Sitting on top of the parent.
  return [parentBase[0], parentBase[1] + parentPart.length, parentBase[2]];
}

function radialPlacement(
  parentBase: readonly [number, number, number],
  nodeOffset: readonly [number, number, number],
  childPart: Part,
  angle: number,
): [number, number, number] {
  const radius = nodeOffset[0] + childPart.diameter / 2;
  return [
    parentBase[0] + Math.cos(angle) * radius,
    // Radial parts are centred on the node rather than hung from it.
    parentBase[1] + nodeOffset[1] - childPart.length / 2,
    parentBase[2] + Math.sin(angle) * radius,
  ];
}

