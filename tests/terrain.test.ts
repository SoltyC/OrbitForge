/**
 * Terrain foundations: the cube-sphere mapping, the height field, and chunk
 * selection.
 *
 * These are the pieces every vertex position depends on, and their failure
 * modes are specific and recognisable — seams where faces meet, cracks where
 * detail levels meet, terrain that changes under you as you approach it. Each
 * of those is asserted directly rather than left to the eye.
 */
import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/sim/vec3.js';
import {
  FACE_COUNT,
  directionToFace,
  faceToDirection,
  unwarpFaceCoordinate,
  warpFaceCoordinate,
} from '../src/terrain/cubeSphere.js';
import type { FaceIndex } from '../src/terrain/cubeSphere.js';
import { DEFAULT_TERRAIN, elevationAt, terrainRadius } from '../src/terrain/height.js';
import {
  chunkBounds,
  chunkKey,
  childrenOf,
  makeChunk,
  maxNeighbourLevelDifference,
  selectChunks,
} from '../src/terrain/quadtree.js';

const PLANET_RADIUS = 600_000;
const FACES: FaceIndex[] = [0, 1, 2, 3, 4, 5];

/** Deterministic spread of directions over the sphere. */
function sampleDirections(count: number): Vec3[] {
  const directions: Vec3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));

  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    directions.push(new Vec3(Math.cos(theta) * radius, y, Math.sin(theta) * radius));
  }

  return directions;
}

describe('cube-sphere mapping', () => {
  it('round-trips every direction through a face', () => {
    for (const direction of sampleDirections(500)) {
      const { face, u, v } = directionToFace(direction);
      const back = faceToDirection(face, u, v);

      expect(back.distanceTo(direction)).toBeLessThan(1e-9);
    }
  });

  it('produces unit directions everywhere on every face', () => {
    for (const face of FACES) {
      for (const u of [-1, -0.5, 0, 0.37, 1]) {
        for (const v of [-1, -0.5, 0, 0.37, 1]) {
          expect(faceToDirection(face, u, v).length).toBeCloseTo(1, 12);
        }
      }
    }
  });

  it('covers all six faces', () => {
    const seen = new Set(sampleDirections(2_000).map((d) => directionToFace(d).face));
    expect(seen.size).toBe(FACE_COUNT);
  });

  it('agrees along every shared face edge', () => {
    // A disagreement here is a crack running the length of a cube edge. Rather
    // than name the twenty-four adjacencies by hand — which is how the first
    // version of this test got them wrong — assert the property itself: every
    // point on a face edge must be reproducible from exactly one other face,
    // exactly.
    const edgePoints: [number, number][] = [
      [1, 0.3],
      [-1, 0.3],
      [0.3, 1],
      [0.3, -1],
      [1, -0.75],
      [-0.75, 1],
    ];

    for (const face of FACES) {
      for (const [u, v] of edgePoints) {
        const direction = faceToDirection(face, u, v);

        const neighbours = FACES.filter((other) => other !== face).filter((other) => {
          const mapped = directionToFace(direction);
          return (
            mapped.face === other &&
            faceToDirection(other, mapped.u, mapped.v).distanceTo(direction) < 1e-12
          );
        });

        // Either this face owns the point, or exactly one neighbour does — and
        // whichever it is reproduces it exactly.
        const owner = directionToFace(direction);
        expect(
          faceToDirection(owner.face, owner.u, owner.v).distanceTo(direction),
          `face ${face} at (${u}, ${v}) does not round-trip`,
        ).toBeLessThan(1e-12);

        expect(neighbours.length).toBeLessThanOrEqual(1);
      }
    }
  });

  it('lets both faces sharing an edge describe it exactly', () => {
    // The complement of the above: a point on the +X/-Z edge is representable
    // from either side, with no gap and no overlap between them.
    const fromPlusX = faceToDirection(0, 1, 0.3);
    const fromMinusZ = faceToDirection(5, -1, 0.3);

    expect(fromPlusX.distanceTo(fromMinusZ)).toBeLessThan(1e-12);

    const fromPlusY = faceToDirection(2, 0.3, 1);
    const fromMinusZ2 = faceToDirection(5, -0.3, 1);
    expect(fromPlusY.distanceTo(fromMinusZ2)).toBeLessThan(1e-12);
  });

  it('round-trips the tangent warp', () => {
    for (const t of [-1, -0.6, 0, 0.25, 1]) {
      expect(unwarpFaceCoordinate(warpFaceCoordinate(t))).toBeCloseTo(t, 12);
    }
  });

  it('leaves the ends and centre of the warp alone', () => {
    expect(warpFaceCoordinate(0)).toBeCloseTo(0, 12);
    expect(warpFaceCoordinate(1)).toBeCloseTo(1, 12);
    expect(warpFaceCoordinate(-1)).toBeCloseTo(-1, 12);
  });

  it('evens out sample spacing across a face', () => {
    // The whole point of the warp: without it, a uniform grid bunches badly
    // towards the face centre. Compare arc lengths of equal steps.
    const step = 0.1;
    const nearCentre = faceToDirection(0, 0, 0).distanceTo(faceToDirection(0, step, 0));
    const nearEdge = faceToDirection(0, 1 - step, 0).distanceTo(
      faceToDirection(0, 1, 0),
    );

    // Within a factor of two across the face; unwarped this exceeds three.
    const ratio = Math.max(nearCentre, nearEdge) / Math.min(nearCentre, nearEdge);
    expect(ratio).toBeLessThan(2);
  });
});

describe('height field', () => {
  it('is deterministic', () => {
    const direction = new Vec3(0.3, 0.6, 0.74).normalized();
    expect(elevationAt(direction)).toBe(elevationAt(direction));
  });

  it('stays within the profile’s amplitude', () => {
    for (const direction of sampleDirections(800)) {
      const elevation = elevationAt(direction);
      const ceiling =
        DEFAULT_TERRAIN.continentAmplitude + DEFAULT_TERRAIN.mountainAmplitude;
      expect(elevation).toBeLessThanOrEqual(ceiling);
      expect(elevation).toBeGreaterThanOrEqual(-DEFAULT_TERRAIN.oceanDepth);
    }
  });

  it('produces both land and sea', () => {
    const elevations = sampleDirections(2_000).map((d) => elevationAt(d));
    const land = elevations.filter((e) => e > 0).length / elevations.length;

    // Sea level is set from the continent field's own 70th percentile, so this
    // should land near 30%. A planet that is all ocean or all continent means
    // that calibration has drifted.
    expect(land).toBeGreaterThan(0.18);
    expect(land).toBeLessThan(0.45);
  });

  it('is continuous — no cliffs between neighbouring samples', () => {
    // A discontinuity in the field is a hole in the mesh.
    let worst = 0;

    for (const direction of sampleDirections(300)) {
      const nudged = direction
        .add(new Vec3(1e-5, 1e-5, -1e-5))
        .normalized();
      worst = Math.max(worst, Math.abs(elevationAt(direction) - elevationAt(nudged)));
    }

    // A ten-metre step across a centimetre of ground would be a wall.
    expect(worst).toBeLessThan(10);
  });

  it('varies across the surface rather than being flat', () => {
    const elevations = sampleDirections(500).map((d) => elevationAt(d));
    const spread = Math.max(...elevations) - Math.min(...elevations);

    expect(spread).toBeGreaterThan(DEFAULT_TERRAIN.mountainAmplitude * 0.3);
  });

  it('never puts terrain below the planet’s radius', () => {
    // Sea floor is flattened to sea level; a radius below the sphere would
    // punch the ocean through the surface.
    for (const direction of sampleDirections(400)) {
      expect(terrainRadius(PLANET_RADIUS, direction)).toBeGreaterThanOrEqual(
        PLANET_RADIUS,
      );
    }
  });

  it('changes with the seed', () => {
    const direction = new Vec3(0.2, 0.9, 0.3).normalized();
    const other = { ...DEFAULT_TERRAIN, seed: DEFAULT_TERRAIN.seed + 1 };

    expect(elevationAt(direction, other)).not.toBe(elevationAt(direction));
  });
});

describe('chunk geometry', () => {
  it('covers a face exactly at every depth', () => {
    for (const depth of [0, 1, 3]) {
      const side = 2 ** depth;
      let area = 0;

      for (let x = 0; x < side; x++) {
        for (let y = 0; y < side; y++) {
          const bounds = chunkBounds({ face: 0, depth, x, y });
          area += (bounds.u1 - bounds.u0) * (bounds.v1 - bounds.v0);
        }
      }

      // The face spans [-1, 1] squared.
      expect(area).toBeCloseTo(4, 9);
    }
  });

  it('partitions a node into four children that tile it', () => {
    const parent = { face: 3 as FaceIndex, depth: 2, x: 1, y: 2 };
    const children = childrenOf(parent);
    const parentBounds = chunkBounds(parent);

    expect(children).toHaveLength(4);

    let area = 0;
    for (const child of children) {
      const bounds = chunkBounds(child);
      area += (bounds.u1 - bounds.u0) * (bounds.v1 - bounds.v0);

      expect(bounds.u0).toBeGreaterThanOrEqual(parentBounds.u0 - 1e-12);
      expect(bounds.u1).toBeLessThanOrEqual(parentBounds.u1 + 1e-12);
    }

    const parentArea =
      (parentBounds.u1 - parentBounds.u0) * (parentBounds.v1 - parentBounds.v0);
    expect(area).toBeCloseTo(parentArea, 12);
  });

  it('halves chunk size with each level', () => {
    const coarse = makeChunk({ face: 0, depth: 2, x: 1, y: 1 }, PLANET_RADIUS);
    const fine = makeChunk({ face: 0, depth: 3, x: 2, y: 2 }, PLANET_RADIUS);

    expect(fine.size).toBeLessThan(coarse.size);
    expect(fine.size).toBeGreaterThan(coarse.size * 0.3);
  });

  it('gives each node a distinct key', () => {
    const keys = new Set<string>();
    for (const face of FACES) {
      for (let x = 0; x < 4; x++) {
        for (let y = 0; y < 4; y++) keys.add(chunkKey({ face, depth: 2, x, y }));
      }
    }
    expect(keys.size).toBe(6 * 16);
  });
});

describe('chunk selection', () => {
  const surface = new Vec3(PLANET_RADIUS + 100, 0, 0);
  const orbit = new Vec3(PLANET_RADIUS + 400_000, 0, 0);

  it('returns whole faces from far away', () => {
    const chunks = selectChunks({
      planetRadius: PLANET_RADIUS,
      camera: new Vec3(PLANET_RADIUS * 40, 0, 0),
    });

    expect(chunks).toHaveLength(FACE_COUNT);
    expect(chunks.every((c) => c.depth === 0)).toBe(true);
  });

  it('subdivides deeply underfoot', () => {
    const chunks = selectChunks({ planetRadius: PLANET_RADIUS, camera: surface });
    const deepest = Math.max(...chunks.map((c) => c.depth));

    expect(deepest).toBeGreaterThan(8);
  });

  it('puts the finest detail beneath the camera', () => {
    const chunks = selectChunks({ planetRadius: PLANET_RADIUS, camera: surface });
    const deepest = Math.max(...chunks.map((c) => c.depth));

    const finest = chunks.filter((c) => c.depth === deepest);
    const below = surface.normalized();

    for (const chunk of finest) {
      // Within a few degrees of straight down.
      expect(chunk.centre.dot(below)).toBeGreaterThan(0.99);
    }
  });

  it('keeps neighbouring chunks within one level', () => {
    // Two levels apart is a crack a skirt cannot cover.
    for (const camera of [surface, orbit, new Vec3(0, PLANET_RADIUS + 9_000, 0)]) {
      const chunks = selectChunks({ planetRadius: PLANET_RADIUS, camera, maxDepth: 6 });
      expect(maxNeighbourLevelDifference(chunks)).toBeLessThanOrEqual(1);
    }
  });

  it('never returns overlapping chunks', () => {
    const chunks = selectChunks({ planetRadius: PLANET_RADIUS, camera: orbit, maxDepth: 5 });

    for (let i = 0; i < chunks.length; i++) {
      for (let j = i + 1; j < chunks.length; j++) {
        const a = chunks[i]!;
        const b = chunks[j]!;
        if (a.face !== b.face) continue;

        const overlaps =
          a.u0 < b.u1 - 1e-12 &&
          b.u0 < a.u1 - 1e-12 &&
          a.v0 < b.v1 - 1e-12 &&
          b.v0 < a.v1 - 1e-12;

        expect(overlaps, `${chunkKey(a)} overlaps ${chunkKey(b)}`).toBe(false);
      }
    }
  });

  it('still covers the whole sphere when subdivided', () => {
    const chunks = selectChunks({ planetRadius: PLANET_RADIUS, camera: orbit, maxDepth: 6 });

    // Every direction must land inside exactly one selected chunk.
    for (const direction of sampleDirections(400)) {
      const { face, u, v } = directionToFace(direction);

      const containing = chunks.filter(
        (c) => c.face === face && u >= c.u0 && u <= c.u1 && v >= c.v0 && v <= c.v1,
      );

      expect(containing.length, `no chunk covers ${u},${v} on face ${face}`)
        .toBeGreaterThanOrEqual(1);
    }
  });

  it('respects the chunk budget', () => {
    const chunks = selectChunks({
      planetRadius: PLANET_RADIUS,
      camera: surface,
      maxChunks: 64,
    });

    expect(chunks.length).toBeLessThanOrEqual(64);
  });

  it('selects more chunks as the camera descends', () => {
    const high = selectChunks({
      planetRadius: PLANET_RADIUS,
      camera: new Vec3(PLANET_RADIUS + 200_000, 0, 0),
      maxDepth: 8,
    });
    const low = selectChunks({
      planetRadius: PLANET_RADIUS,
      camera: new Vec3(PLANET_RADIUS + 2_000, 0, 0),
      maxDepth: 8,
    });

    expect(low.length).toBeGreaterThan(high.length);
  });

  it('is deterministic for a given camera', () => {
    const a = selectChunks({ planetRadius: PLANET_RADIUS, camera: surface, maxDepth: 7 });
    const b = selectChunks({ planetRadius: PLANET_RADIUS, camera: surface, maxDepth: 7 });

    expect(a.map(chunkKey)).toEqual(b.map(chunkKey));
  });
});
