/**
 * 3D view of a craft under construction.
 *
 * Rebuilt wholesale whenever the craft changes. That is wasteful in principle
 * but the part counts here are tiny and edits are user-paced, and it removes a
 * whole class of stale-mesh bugs that incremental updates invite.
 */
import {
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
} from 'three/webgpu';
import type { Assembly } from '../parts/assembly.js';
import type { Craft } from '../parts/craft.js';
import { freeNodes, partOf } from '../parts/craft.js';
import { findAttachNode } from '../parts/types.js';
import { PART_COLORS } from '../render/vesselView.js';

/** Radius of the clickable sphere marking a free attach node (m). */
const NODE_MARKER_RADIUS = 0.32;

const NODE_COLOR = 0x5ad1ff;
const NODE_HOVER_COLOR = 0xffffff;
const SELECTED_COLOR = 0xffc46b;

/** Data carried on a node marker so a raycast hit can be acted on. */
export interface NodeTarget {
  readonly instanceId: string;
  readonly nodeId: string;
}

export interface CraftView {
  readonly group: Group;
  /** Part meshes, keyed by the mesh's uuid for raycast lookup. */
  readonly partMeshes: Map<string, string>;
  /** Node markers, keyed by mesh uuid. */
  readonly nodeTargets: Map<string, NodeTarget>;
  readonly nodeMeshes: Mesh[];
}

export function buildCraftView(
  craft: Craft,
  assembly: Assembly,
  selectedInstanceId: string | null,
): CraftView {
  const group = new Group();
  group.name = 'craftView';

  const partMeshes = new Map<string, string>();
  const nodeTargets = new Map<string, NodeTarget>();
  const nodeMeshes: Mesh[] = [];

  for (const placement of assembly.placements) {
    const { part, position, instance } = placement;
    const isSelected = instance.id === selectedInstanceId;

    const mesh = new Mesh(
      new CylinderGeometry(part.diameter / 2, part.diameter / 2, part.length, 24),
      new MeshStandardMaterial({
        color: isSelected ? SELECTED_COLOR : (PART_COLORS[part.category] ?? 0x999999),
        roughness: 0.55,
        metalness: 0.35,
        emissive: isSelected ? SELECTED_COLOR : 0x000000,
        emissiveIntensity: isSelected ? 0.25 : 0,
      }),
    );

    // Cylinders are centred on their origin; parts are anchored at their base.
    mesh.position.set(position[0], position[1] + part.length / 2, position[2]);
    mesh.name = part.id;
    partMeshes.set(mesh.uuid, instance.id);
    group.add(mesh);
  }

  for (const target of freeNodes(craft)) {
    const marker = buildNodeMarker(craft, assembly, target);
    if (!marker) continue;
    nodeTargets.set(marker.uuid, target);
    nodeMeshes.push(marker);
    group.add(marker);
  }

  return { group, partMeshes, nodeTargets, nodeMeshes };
}

function buildNodeMarker(
  craft: Craft,
  assembly: Assembly,
  target: NodeTarget,
): Mesh | null {
  const placement = assembly.placements.find(
    (candidate) => candidate.instance.id === target.instanceId,
  );
  if (!placement) return null;

  const instance = craft.parts.find((candidate) => candidate.id === target.instanceId);
  if (!instance) return null;

  const node = findAttachNode(partOf(instance), target.nodeId);
  if (!node) return null;

  const marker = new Mesh(
    new SphereGeometry(NODE_MARKER_RADIUS, 14, 10),
    new MeshBasicMaterial({ color: NODE_COLOR, transparent: true, opacity: 0.85 }),
  );

  marker.position.set(
    placement.position[0] + node.offset[0],
    placement.position[1] + node.offset[1],
    placement.position[2] + node.offset[2],
  );
  marker.name = `node:${target.instanceId}:${target.nodeId}`;

  return marker;
}

/** Highlight the node currently under the cursor. */
export function setHoveredNode(view: CraftView, meshUuid: string | null): void {
  for (const mesh of view.nodeMeshes) {
    const material = mesh.material as MeshBasicMaterial;
    const isHovered = mesh.uuid === meshUuid;
    material.color.setHex(isHovered ? NODE_HOVER_COLOR : NODE_COLOR);
    mesh.scale.setScalar(isHovered ? 1.4 : 1);
  }
}

/** Release GPU resources for a view that is being replaced. */
export function disposeCraftView(view: CraftView): void {
  view.group.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.geometry.dispose();
    const material = object.material;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material.dispose();
  });
}
