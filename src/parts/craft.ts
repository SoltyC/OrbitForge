/**
 * The craft: an attachment tree of part instances.
 *
 * This is what the editor manipulates. It is a tree, not a list — each part
 * records which node of which parent it hangs from — and it is compiled into
 * the flat staged Vessel the physics understands by parts/assembly.ts.
 *
 * All operations are pure: attaching or detaching returns a new Craft.
 */
import { findPart } from './catalogue.js';
import type { Part } from './types.js';

export interface PartInstance {
  /** Unique within a craft. */
  readonly id: string;
  /** Catalogue part this instance is of. */
  readonly partId: string;
  /** Null only for the root part. */
  readonly parentId: string | null;
  /** Which of the parent's attach nodes this hangs from. */
  readonly parentNodeId: string | null;
  /**
   * Rotation about the stack axis for radially mounted parts (rad). Ignored
   * for stack attachment.
   */
  readonly radialAngle: number;
  /**
   * Parts placed together by a symmetry operation share a group id, so
   * removing one removes all of them.
   */
  readonly symmetryGroup: string | null;
}

export interface Craft {
  readonly name: string;
  readonly parts: readonly PartInstance[];
}

export class CraftError extends Error {}

/** Start a new craft from a single root part (normally a command pod). */
export function createCraft(name: string, rootPartId: string): Craft {
  return {
    name,
    parts: [
      {
        id: 'root',
        partId: rootPartId,
        parentId: null,
        parentNodeId: null,
        radialAngle: 0,
        symmetryGroup: null,
      },
    ],
  };
}

export function findInstance(craft: Craft, instanceId: string): PartInstance {
  const instance = craft.parts.find((candidate) => candidate.id === instanceId);
  if (!instance) throw new CraftError(`No such part instance: ${instanceId}`);
  return instance;
}

export function partOf(instance: PartInstance): Part {
  return findPart(instance.partId);
}

export function rootInstance(craft: Craft): PartInstance {
  const root = craft.parts.find((candidate) => candidate.parentId === null);
  if (!root) throw new CraftError('Craft has no root part');
  return root;
}

export function childrenOf(craft: Craft, instanceId: string): readonly PartInstance[] {
  return craft.parts.filter((candidate) => candidate.parentId === instanceId);
}

/**
 * True when the given node of the given instance is unavailable — either a
 * child is already mounted on it, or it is the node facing this part's own
 * parent. Without the second case an engine's top node would look free and
 * parts could be stacked straight into the tank above it.
 */
export function isNodeOccupied(
  craft: Craft,
  instanceId: string,
  nodeId: string,
): boolean {
  const hasChild = craft.parts.some(
    (candidate) =>
      candidate.parentId === instanceId && candidate.parentNodeId === nodeId,
  );
  if (hasChild) return true;

  const instance = craft.parts.find((candidate) => candidate.id === instanceId);
  return instance ? facingNodeId(instance) === nodeId : false;
}

/**
 * Which of a part's own nodes is consumed by its attachment to its parent.
 * Hanging below a parent uses the child's top; sitting on top uses its bottom.
 */
function facingNodeId(instance: PartInstance): string | null {
  if (instance.parentNodeId === 'bottom') return 'top';
  if (instance.parentNodeId === 'top') return 'bottom';
  return null;
}

/** Every attach node in the craft that is currently free. */
export function freeNodes(
  craft: Craft,
): readonly { instanceId: string; nodeId: string }[] {
  return craft.parts.flatMap((instance) =>
    partOf(instance)
      .attachNodes.filter((node) => !isNodeOccupied(craft, instance.id, node.id))
      .map((node) => ({ instanceId: instance.id, nodeId: node.id })),
  );
}

export interface AttachOptions {
  readonly parentId: string;
  readonly parentNodeId: string;
  readonly partId: string;
  /** Radial symmetry count. 1 places a single part; 2+ mirrors it around. */
  readonly symmetry?: number;
}

/**
 * Attach a part (or a symmetric ring of them) to a free node.
 *
 * Throws rather than silently no-oping: a failed attach is an editor bug or a
 * bad user action, and both are worth surfacing.
 */
export function attachPart(craft: Craft, options: AttachOptions): Craft {
  const parent = findInstance(craft, options.parentId);
  const parentPart = partOf(parent);

  const node = parentPart.attachNodes.find((n) => n.id === options.parentNodeId);
  if (!node) {
    throw new CraftError(
      `Part ${parentPart.id} has no attach node "${options.parentNodeId}"`,
    );
  }

  if (isNodeOccupied(craft, options.parentId, options.parentNodeId)) {
    throw new CraftError(
      `Node "${options.parentNodeId}" on ${options.parentId} is already occupied`,
    );
  }

  const child = findPart(options.partId);
  assertCompatible(node.kind, child);

  const count = node.kind === 'radial' ? Math.max(1, Math.round(options.symmetry ?? 1)) : 1;
  const symmetryGroup = count > 1 ? `sym-${nextId(craft)}` : null;

  const added: PartInstance[] = [];
  for (let i = 0; i < count; i++) {
    added.push({
      id: `p${nextId(craft) + i}`,
      partId: options.partId,
      parentId: options.parentId,
      // Only the first of a symmetric set claims the node; the rest are
      // rotated copies sharing it.
      parentNodeId: i === 0 ? options.parentNodeId : null,
      radialAngle: count > 1 ? (i / count) * Math.PI * 2 : 0,
      symmetryGroup,
    });
  }

  return { ...craft, parts: [...craft.parts, ...added] };
}

/**
 * Remove a part, everything attached below it, and any symmetric counterparts.
 * Removing the root is refused — a craft always needs one.
 */
export function detachPart(craft: Craft, instanceId: string): Craft {
  const target = findInstance(craft, instanceId);
  if (target.parentId === null) {
    throw new CraftError('Cannot remove the root part');
  }

  const doomed = new Set<string>();

  const peers = target.symmetryGroup
    ? craft.parts.filter((p) => p.symmetryGroup === target.symmetryGroup)
    : [target];

  for (const peer of peers) collectSubtree(craft, peer.id, doomed);

  return { ...craft, parts: craft.parts.filter((part) => !doomed.has(part.id)) };
}

function collectSubtree(craft: Craft, instanceId: string, into: Set<string>): void {
  if (into.has(instanceId)) return;
  into.add(instanceId);
  for (const child of childrenOf(craft, instanceId)) {
    collectSubtree(craft, child.id, into);
  }
}

/**
 * Radial nodes take anything; stack nodes refuse radial-only parts. Engines are
 * allowed anywhere so boosters can be side-mounted.
 */
function assertCompatible(kind: 'stack' | 'radial', child: Part): void {
  if (kind === 'stack' && child.attachNodes.length === 0) {
    throw new CraftError(`${child.name} cannot be stack-mounted`);
  }
}

/** Monotonic id source, derived from the craft so it stays deterministic. */
function nextId(craft: Craft): number {
  return craft.parts.length + 1;
}

/** Total part count including symmetric copies. */
export function partCount(craft: Craft): number {
  return craft.parts.length;
}
