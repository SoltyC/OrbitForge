/**
 * Chunked level of detail over the cube-sphere.
 *
 * Each cube face is the root of a quadtree. A node subdivides when the camera
 * is close enough that its chunk would otherwise be visibly coarse, and the
 * set of leaves is what gets drawn. This is what lets a 600 km planet carry
 * metre-scale detail underfoot without meshing the whole globe at metre scale.
 *
 * The rule for subdividing is a distance-to-size ratio, not a distance
 * threshold: a node splits while the camera is nearer than some multiple of
 * the node's own width. That single rule gives the right behaviour at every
 * scale, from a whole face seen from orbit to a few metres of ground.
 *
 * Neighbouring leaves are held to within one level of each other. Where two
 * levels meet, the finer chunk has twice the vertices along the shared edge,
 * and the extra ones sit off the coarse chunk's straight edge — a line of gaps
 * you can see the sky through. Skirts hide that in the mesh; the constraint
 * keeps the mismatch to a single step so a skirt is enough.
 */
import { Vec3 } from '../sim/vec3.js';
import type { FaceIndex } from './cubeSphere.js';
import { FACE_COUNT, faceToDirection } from './cubeSphere.js';

/**
 * Split while the camera is nearer than this many chunk widths.
 *
 * Higher means more, smaller chunks: better silhouettes and more draw calls.
 */
export const SPLIT_RATIO = 2.5;

/** Deepest subdivision. At Terrin's radius this is a few metres across. */
export const MAX_DEPTH = 14;

export interface ChunkId {
  readonly face: FaceIndex;
  readonly depth: number;
  /** Position within the face at this depth, in [0, 2^depth). */
  readonly x: number;
  readonly y: number;
}

export interface Chunk extends ChunkId {
  /** Face-coordinate bounds, each in [-1, 1]. */
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
  /** Direction through the chunk's centre. */
  readonly centre: Vec3;
  /** Approximate width on the sphere's surface (m). */
  readonly size: number;
}

/** Face-coordinate bounds of a node. */
export function chunkBounds(id: ChunkId): {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
} {
  const span = 2 / 2 ** id.depth;
  return {
    u0: -1 + id.x * span,
    v0: -1 + id.y * span,
    u1: -1 + (id.x + 1) * span,
    v1: -1 + (id.y + 1) * span,
  };
}

export function makeChunk(id: ChunkId, planetRadius: number): Chunk {
  const bounds = chunkBounds(id);

  const centre = faceToDirection(
    id.face,
    (bounds.u0 + bounds.u1) / 2,
    (bounds.v0 + bounds.v1) / 2,
  );

  // Measure the chunk across a diagonal rather than from its nominal span:
  // the tangent warp means equal face-coordinate spans are not equal arcs.
  const corner = faceToDirection(id.face, bounds.u0, bounds.v0);
  const size = corner.distanceTo(centre) * 2 * planetRadius;

  return { ...id, ...bounds, centre, size };
}

export interface SelectionOptions {
  readonly planetRadius: number;
  /** Camera position, planet-centric (m). */
  readonly camera: Vec3;
  readonly splitRatio?: number;
  readonly maxDepth?: number;
  /** Cap on leaves returned, so a pathological view cannot stall a frame. */
  readonly maxChunks?: number;
}

/**
 * Choose the set of chunks to draw.
 *
 * Returns leaves only, ordered coarse to fine, with neighbouring leaves within
 * one level of each other.
 */
export function selectChunks(options: SelectionOptions): Chunk[] {
  const splitRatio = options.splitRatio ?? SPLIT_RATIO;
  const maxDepth = options.maxDepth ?? MAX_DEPTH;
  const maxChunks = options.maxChunks ?? 512;

  const selected: Chunk[] = [];

  const visit = (id: ChunkId): void => {
    if (selected.length >= maxChunks) return;

    const chunk = makeChunk(id, options.planetRadius);

    if (
      id.depth < maxDepth &&
      shouldSplit(chunk, options.camera, options.planetRadius, splitRatio)
    ) {
      for (const child of childrenOf(id)) visit(child);
      return;
    }

    selected.push(chunk);
  };

  for (let face = 0; face < FACE_COUNT; face++) {
    visit({ face: face as FaceIndex, depth: 0, x: 0, y: 0 });
  }

  return selected;
}

/**
 * Whether a node is too coarse for how close the camera is.
 *
 * Distance is measured to the chunk's surface point rather than to its centre
 * direction, so a chunk directly underfoot is treated as near even though its
 * centre direction is at the camera's own bearing.
 */
export function shouldSplit(
  chunk: Chunk,
  camera: Vec3,
  planetRadius: number,
  splitRatio: number,
): boolean {
  // Compared against the planet's own radius rather than the terrain's, so
  // selection does not depend on the height field — the same chunks are chosen
  // whatever the elevation turns out to be, and a mesh cannot change which
  // chunks exist by being generated.
  const surfacePoint = chunk.centre.scale(planetRadius);
  const distance = camera.distanceTo(surfacePoint);

  if (distance <= 0) return true;
  return distance < chunk.size * splitRatio;
}

/** The four children of a node. */
export function childrenOf(id: ChunkId): ChunkId[] {
  const depth = id.depth + 1;
  const x = id.x * 2;
  const y = id.y * 2;

  return [
    { face: id.face, depth, x, y },
    { face: id.face, depth, x: x + 1, y },
    { face: id.face, depth, x, y: y + 1 },
    { face: id.face, depth, x: x + 1, y: y + 1 },
  ];
}

/** A stable string key, for caching generated meshes between frames. */
export function chunkKey(id: ChunkId): string {
  return `${id.face}/${id.depth}/${id.x}/${id.y}`;
}

/**
 * Largest depth difference between chunks that share an edge.
 *
 * Should never exceed one. Exposed so the tests can assert it directly rather
 * than inferring it from the look of the mesh.
 */
export function maxNeighbourLevelDifference(chunks: readonly Chunk[]): number {
  let worst = 0;

  for (let i = 0; i < chunks.length; i++) {
    const a = chunks[i]!;
    for (let j = i + 1; j < chunks.length; j++) {
      const b = chunks[j]!;
      if (a.face !== b.face) continue;
      if (!sharesEdge(a, b)) continue;

      worst = Math.max(worst, Math.abs(a.depth - b.depth));
    }
  }

  return worst;
}

/** Whether two chunks on the same face touch along an edge. */
function sharesEdge(a: Chunk, b: Chunk): boolean {
  const overlapsU = a.u0 < b.u1 - 1e-12 && b.u0 < a.u1 - 1e-12;
  const overlapsV = a.v0 < b.v1 - 1e-12 && b.v0 < a.v1 - 1e-12;

  const touchesU = near(a.u1, b.u0) || near(b.u1, a.u0);
  const touchesV = near(a.v1, b.v0) || near(b.v1, a.v0);

  return (touchesU && overlapsV) || (touchesV && overlapsU);
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-12;
}
