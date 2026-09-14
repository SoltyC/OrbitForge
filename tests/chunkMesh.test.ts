/**
 * Chunk geometry tests.
 *
 * The failure modes here are quiet ones. A mesh with the wrong winding renders
 * inside-out only from certain angles; one with float-quantised positions looks
 * fine from orbit and shakes underfoot; a missing skirt is a hairline of sky
 * that only appears where two detail levels happen to meet. None of them
 * announce themselves, so each is asserted directly.
 */
import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/sim/vec3.js';
import {
  CHUNK_RESOLUTION,
  buildChunkGeometry,
  buildChunkIndices,
  chunkVertexCount,
  surfaceColour,
} from '../src/terrain/chunkMesh.js';
import { DEFAULT_TERRAIN, elevationAt } from '../src/terrain/height.js';
import { makeChunk } from '../src/terrain/quadtree.js';
import type { FaceIndex } from '../src/terrain/cubeSphere.js';

const PLANET_RADIUS = 600_000;

function chunkAt(depth: number, face: FaceIndex = 0, x = 0, y = 0) {
  return makeChunk({ face, depth, x, y }, PLANET_RADIUS);
}

describe('index buffer', () => {
  const indices = buildChunkIndices();

  it('references only existing vertices', () => {
    const limit = chunkVertexCount();
    for (const index of indices) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(limit);
    }
  });

  it('is a whole number of triangles', () => {
    expect(indices.length % 3).toBe(0);
  });

  it('covers the interior grid and four skirts', () => {
    const quads = (CHUNK_RESOLUTION - 1) ** 2;
    const skirtQuads = (CHUNK_RESOLUTION - 1) * 4;

    expect(indices.length / 3).toBe((quads + skirtQuads) * 2);
  });

  it('uses every grid vertex', () => {
    const used = new Set(indices);
    for (let i = 0; i < CHUNK_RESOLUTION ** 2; i++) {
      expect(used.has(i), `grid vertex ${i} is orphaned`).toBe(true);
    }
  });
});

describe('chunk geometry', () => {
  const chunk = chunkAt(6);
  const geometry = buildChunkGeometry(chunk, PLANET_RADIUS);

  it('produces one position, normal and colour per vertex', () => {
    const count = chunkVertexCount();
    expect(geometry.positions.length).toBe(count * 3);
    expect(geometry.normals.length).toBe(count * 3);
    expect(geometry.colors.length).toBe(count * 3);
  });

  it('is entirely finite', () => {
    for (const array of [geometry.positions, geometry.normals, geometry.colors]) {
      expect(array.every((value) => Number.isFinite(value))).toBe(true);
    }
  });

  it('keeps positions small enough for 32-bit float', () => {
    // This is the whole reason positions are stored relative to the chunk
    // centre. At planet scale a float32 grid is about six centimetres coarse,
    // which is the scale the finest chunks are trying to resolve.
    let furthest = 0;
    for (let i = 0; i < geometry.positions.length; i += 3) {
      furthest = Math.max(
        furthest,
        Math.hypot(geometry.positions[i]!, geometry.positions[i + 1]!, geometry.positions[i + 2]!),
      );
    }

    // No vertex should be much further from the centre than the chunk is wide.
    expect(furthest).toBeLessThan(chunk.size * 1.5);
  });

  it('puts the chunk centre on the terrain surface', () => {
    const direction = geometry.centre.normalized();
    const expected = PLANET_RADIUS + Math.max(0, elevationAt(direction));

    expect(geometry.centre.length).toBeCloseTo(expected, 3);
  });

  it('normalises every normal', () => {
    for (let i = 0; i < geometry.normals.length; i += 3) {
      const length = Math.hypot(
        geometry.normals[i]!,
        geometry.normals[i + 1]!,
        geometry.normals[i + 2]!,
      );
      expect(length).toBeCloseTo(1, 5);
    }
  });

  it('points every normal outward', () => {
    // An inward normal is a patch of terrain lit from underneath.
    for (let i = 0; i < CHUNK_RESOLUTION ** 2; i++) {
      const position = new Vec3(
        geometry.positions[i * 3]!,
        geometry.positions[i * 3 + 1]!,
        geometry.positions[i * 3 + 2]!,
      ).add(geometry.centre);

      const normal = new Vec3(
        geometry.normals[i * 3]!,
        geometry.normals[i * 3 + 1]!,
        geometry.normals[i * 3 + 2]!,
      );

      expect(normal.dot(position.normalized())).toBeGreaterThan(0);
    }
  });

  it('never places terrain below sea level', () => {
    for (let i = 0; i < CHUNK_RESOLUTION ** 2; i++) {
      const radius = new Vec3(
        geometry.positions[i * 3]!,
        geometry.positions[i * 3 + 1]!,
        geometry.positions[i * 3 + 2]!,
      )
        .add(geometry.centre)
        .length;

      expect(radius).toBeGreaterThanOrEqual(PLANET_RADIUS - 1e-3);
    }
  });

  it('hangs the skirt below the rim', () => {
    // Only below: a skirt that rises above its rim pokes through the ground.
    const gridCount = CHUNK_RESOLUTION ** 2;

    for (let i = gridCount; i < chunkVertexCount(); i++) {
      const radius = new Vec3(
        geometry.positions[i * 3]!,
        geometry.positions[i * 3 + 1]!,
        geometry.positions[i * 3 + 2]!,
      )
        .add(geometry.centre)
        .length;

      expect(radius).toBeLessThan(PLANET_RADIUS + DEFAULT_TERRAIN.mountainAmplitude);
    }
  });

  it('drops the skirt deeper than a neighbouring level could mismatch', () => {
    // The skirt has to be deeper than the worst height difference across a
    // one-level boundary, or the crack shows through anyway.
    const gridCount = CHUNK_RESOLUTION ** 2;

    const rimRadius = new Vec3(
      geometry.positions[0]!,
      geometry.positions[1]!,
      geometry.positions[2]!,
    ).add(geometry.centre).length;

    const skirtRadius = new Vec3(
      geometry.positions[gridCount * 3]!,
      geometry.positions[gridCount * 3 + 1]!,
      geometry.positions[gridCount * 3 + 2]!,
    ).add(geometry.centre).length;

    expect(rimRadius - skirtRadius).toBeGreaterThan(0);
    expect(rimRadius - skirtRadius).toBeCloseTo(chunk.size * 0.06, 3);
  });
});

describe('chunk seams', () => {
  it('gives adjacent chunks identical vertices along their shared edge', () => {
    // Two chunks at the same level sharing an edge must agree exactly, or
    // there is a crack between them regardless of skirts.
    const left = buildChunkGeometry(chunkAt(4, 0, 3, 5), PLANET_RADIUS);
    const right = buildChunkGeometry(chunkAt(4, 0, 4, 5), PLANET_RADIUS);

    for (let y = 0; y < CHUNK_RESOLUTION; y++) {
      const leftIndex = y * CHUNK_RESOLUTION + (CHUNK_RESOLUTION - 1);
      const rightIndex = y * CHUNK_RESOLUTION;

      const a = new Vec3(
        left.positions[leftIndex * 3]!,
        left.positions[leftIndex * 3 + 1]!,
        left.positions[leftIndex * 3 + 2]!,
      ).add(left.centre);

      const b = new Vec3(
        right.positions[rightIndex * 3]!,
        right.positions[rightIndex * 3 + 1]!,
        right.positions[rightIndex * 3 + 2]!,
      ).add(right.centre);

      // Float32 storage at chunk scale, so a millimetre is generous.
      expect(a.distanceTo(b)).toBeLessThan(0.01);
    }
  });

  it('shades a shared edge identically from both sides', () => {
    // Normals from the height field rather than from triangles, so the two
    // chunks agree and no bright seam runs along the join.
    const left = buildChunkGeometry(chunkAt(4, 0, 3, 5), PLANET_RADIUS);
    const right = buildChunkGeometry(chunkAt(4, 0, 4, 5), PLANET_RADIUS);

    for (let y = 0; y < CHUNK_RESOLUTION; y++) {
      const leftIndex = y * CHUNK_RESOLUTION + (CHUNK_RESOLUTION - 1);
      const rightIndex = y * CHUNK_RESOLUTION;

      for (let c = 0; c < 3; c++) {
        expect(left.normals[leftIndex * 3 + c]!).toBeCloseTo(
          right.normals[rightIndex * 3 + c]!,
          4,
        );
      }
    }
  });

  it('agrees with its parent where a finer chunk shares its corner', () => {
    const parent = buildChunkGeometry(chunkAt(3, 0, 1, 1), PLANET_RADIUS);
    const child = buildChunkGeometry(chunkAt(4, 0, 2, 2), PLANET_RADIUS);

    const parentCorner = new Vec3(
      parent.positions[0]!,
      parent.positions[1]!,
      parent.positions[2]!,
    ).add(parent.centre);

    const childCorner = new Vec3(
      child.positions[0]!,
      child.positions[1]!,
      child.positions[2]!,
    ).add(child.centre);

    expect(parentCorner.distanceTo(childCorner)).toBeLessThan(0.01);
  });
});

function sum(colour: readonly number[]): number {
  return colour[0]! + colour[1]! + colour[2]!;
}

describe('surface colour', () => {
  it('paints everything below sea level as water', () => {
    for (const depth of [0, -50, -500, -3_000]) {
      const colour = surfaceColour(depth, 0);
      // Blue: more blue than red, and never bright.
      expect(colour[2]).toBeGreaterThan(colour[0]);
      expect(colour[2]).toBeLessThan(0.6);
    }
  });

  it('darkens the sea with depth', () => {
    // One flat tone for the whole ocean leaves every coastline a hard step,
    // because the flattening puts every underwater vertex at exactly zero.
    const shallow = surfaceColour(-20, 0);
    const deep = surfaceColour(-2_500, 0);

    expect(sum(deep)).toBeLessThan(sum(shallow));
  });

  it('greens the lowlands and whitens the peaks', () => {
    const lowland = surfaceColour(400, 0);
    const peak = surfaceColour(6_500, 0);

    // Green means more green than red; snow means all channels high.
    expect(lowland[1]).toBeGreaterThan(lowland[0]);
    expect(Math.min(...peak)).toBeGreaterThan(0.6);
  });

  it('turns steep ground to rock whatever its height', () => {
    const flat = surfaceColour(600, 0);
    const steep = surfaceColour(600, 0.5);

    expect(steep[0]).toBeGreaterThan(flat[0]);
  });

  it('stays inside the unit range', () => {
    for (const elevation of [-1_000, 0, 500, 3_000, 9_000]) {
      for (const slope of [0, 0.2, 1]) {
        for (const channel of surfaceColour(elevation, slope)) {
          expect(channel).toBeGreaterThanOrEqual(0);
          expect(channel).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('triangle winding', () => {
  it('winds every surface triangle to face outward', () => {
    // Wound the other way the entire surface is back-face culled: the view
    // passes straight through the ground to whatever is behind it, while the
    // vertex normals stay perfectly correct so nothing else looks wrong.
    const chunk = chunkAt(3, 0, 4, 4);
    const geometry = buildChunkGeometry(chunk, PLANET_RADIUS);

    const vertex = (i: number): Vec3 =>
      new Vec3(
        geometry.positions[i * 3]!,
        geometry.positions[i * 3 + 1]!,
        geometry.positions[i * 3 + 2]!,
      ).add(geometry.centre);

    const gridTriangles = (CHUNK_RESOLUTION - 1) ** 2 * 2;

    for (let t = 0; t < gridTriangles; t++) {
      const a = vertex(geometry.indices[t * 3]!);
      const b = vertex(geometry.indices[t * 3 + 1]!);
      const c = vertex(geometry.indices[t * 3 + 2]!);

      const faceNormal = b.sub(a).cross(c.sub(a)).normalized();

      expect(
        faceNormal.dot(a.normalized()),
        `triangle ${t} faces inward`,
      ).toBeGreaterThan(0);
    }
  });

  it('agrees with the vertex normals it ships', () => {
    // Geometric and shading normals pointing opposite ways is the same bug
    // seen from the other side.
    const geometry = buildChunkGeometry(chunkAt(4, 2, 6, 6), PLANET_RADIUS);

    for (let i = 0; i < CHUNK_RESOLUTION ** 2; i += 37) {
      const position = new Vec3(
        geometry.positions[i * 3]!,
        geometry.positions[i * 3 + 1]!,
        geometry.positions[i * 3 + 2]!,
      ).add(geometry.centre);

      const normal = new Vec3(
        geometry.normals[i * 3]!,
        geometry.normals[i * 3 + 1]!,
        geometry.normals[i * 3 + 2]!,
      );

      expect(normal.dot(position.normalized())).toBeGreaterThan(0.5);
    }
  });
});
