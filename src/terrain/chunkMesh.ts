/**
 * Turning a quadtree chunk into geometry.
 *
 * Two things here are less obvious than they look.
 *
 * Positions are stored relative to the chunk's own centre, not to the planet's.
 * A vertex 600 km from the origin in 32-bit float lands on a grid about six
 * centimetres coarse, which is the scale the finest chunks are trying to
 * resolve — the mesh would quantise into visible steps and jitter as the
 * camera moved. Relative to a chunk a few metres across, the same float has
 * micrometres to spare. The chunk's own centre carries the large magnitude, in
 * double precision, right up until it is handed to the renderer.
 *
 * Normals come from the height field directly rather than from the triangles.
 * Face normals stop at a chunk's edge, so two chunks meeting at different
 * detail levels would shade differently along the join and draw a bright seam
 * across the terrain. Sampling the field is continuous across every boundary
 * and does not care what level the neighbour is.
 */
import { Vec3 } from '../sim/vec3.js';
import type { Chunk } from './quadtree.js';
import { faceToDirection } from './cubeSphere.js';
import type { TerrainProfile } from './height.js';
import { DEFAULT_TERRAIN, elevationAt } from './height.js';

/**
 * Vertices along one edge of a chunk. Every chunk has the same topology, so
 * the index buffer is built once and shared.
 *
 * Measured rather than picked. At 17 the ground was 1.3 km per vertex from
 * orbit, which smooths mountain ranges into swells and quantises every
 * coastline into a staircase of grid cells. Doubling it, together with a wider
 * split ratio, brings that to 325 m — and 20 m at five kilometres up, where
 * most of a launch is actually spent looking down.
 */
export const CHUNK_RESOLUTION = 33;

/**
 * How far the skirt hangs below the chunk's rim, as a fraction of its size.
 *
 * Where two detail levels meet, the finer chunk has vertices the coarser one
 * does not, and they sit off its straight edge — a row of gaps showing the sky
 * through the planet. A skirt is a wall dropped from the rim that fills them
 * from behind. It only has to be deeper than the worst mismatch, which the
 * one-level neighbour constraint bounds.
 */
const SKIRT_DEPTH = 0.06;

export interface ChunkGeometryData {
  /** Positions relative to `centre`, in metres. */
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly colors: Float32Array;
  readonly indices: Uint32Array;
  /** Planet-centric position of the chunk's centre (m), in double precision. */
  readonly centre: Vec3;
  /** Highest elevation in the chunk (m), for bounding and culling. */
  readonly maxElevation: number;
}

/**
 * Shared index buffer.
 *
 * The interior grid, plus four skirt strips hanging from the rim.
 */
export function buildChunkIndices(resolution = CHUNK_RESOLUTION): Uint32Array {
  const indices: number[] = [];
  const at = (x: number, y: number): number => y * resolution + x;

  // Counter-clockwise seen from outside the planet, which is what the renderer
  // treats as front-facing. Wound the other way the whole surface is culled and
  // the view passes straight through the ground — with the vertex normals still
  // perfectly correct, so nothing looks wrong except that there is no terrain.
  for (let y = 0; y < resolution - 1; y++) {
    for (let x = 0; x < resolution - 1; x++) {
      indices.push(at(x, y), at(x + 1, y), at(x, y + 1));
      indices.push(at(x + 1, y), at(x + 1, y + 1), at(x, y + 1));
    }
  }

  // Skirt vertices follow the grid, one per rim vertex, in the order the rim
  // is walked below.
  const skirtBase = resolution * resolution;
  let skirt = skirtBase;

  const addSkirt = (rim: (i: number) => number, flip: boolean): void => {
    for (let i = 0; i < resolution - 1; i++) {
      const a = rim(i);
      const b = rim(i + 1);
      const c = skirt + i;
      const d = skirt + i + 1;

      if (flip) {
        indices.push(a, c, b, b, c, d);
      } else {
        indices.push(a, b, c, b, d, c);
      }
    }
    skirt += resolution;
  };

  addSkirt((i) => at(i, 0), false);
  addSkirt((i) => at(i, resolution - 1), true);
  addSkirt((i) => at(0, i), true);
  addSkirt((i) => at(resolution - 1, i), false);

  return new Uint32Array(indices);
}

/** Total vertices per chunk: the grid plus four skirt strips. */
export function chunkVertexCount(resolution = CHUNK_RESOLUTION): number {
  return resolution * resolution + resolution * 4;
}

/**
 * Generate a chunk's geometry.
 *
 * @param planetRadius Sea-level radius (m).
 */
export function buildChunkGeometry(
  chunk: Chunk,
  planetRadius: number,
  profile: TerrainProfile = DEFAULT_TERRAIN,
  resolution = CHUNK_RESOLUTION,
): ChunkGeometryData {
  const vertexCount = chunkVertexCount(resolution);

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);

  // Sample the grid with a one-vertex border on every side.
  //
  // The border is what makes normals affordable. Differencing a vertex against
  // its neighbours needs samples beyond the rim, and taking them per vertex
  // costs four extra field evaluations each — over fourteen hundred for a
  // chunk. Extending the grid by one instead gives every normal the same
  // central difference for three hundred and sixty-one.
  const stride = resolution + 2;
  const du = (chunk.u1 - chunk.u0) / (resolution - 1);
  const dv = (chunk.v1 - chunk.v0) / (resolution - 1);

  const borderDirections: Vec3[] = new Array(stride * stride);
  const borderRadii = new Float64Array(stride * stride);
  const borderElevations = new Float64Array(stride * stride);

  let maxElevation = -Infinity;

  for (let y = 0; y < stride; y++) {
    const v = chunk.v0 + dv * (y - 1);

    for (let x = 0; x < stride; x++) {
      const u = chunk.u0 + du * (x - 1);

      const direction = faceToDirection(chunk.face, u, v);
      const elevation = elevationAt(direction, profile);

      const index = y * stride + x;
      borderDirections[index] = direction;
      borderElevations[index] = elevation;
      // Below sea level is flattened to it: the ocean is a surface, not a bed.
      borderRadii[index] = planetRadius + Math.max(0, elevation);

      const inside = x > 0 && y > 0 && x <= resolution && y <= resolution;
      if (inside) maxElevation = Math.max(maxElevation, elevation);
    }
  }

  // The interior of that grid is the chunk proper.
  const directions: Vec3[] = new Array(resolution * resolution);
  const radii = new Float64Array(resolution * resolution);

  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const source = (y + 1) * stride + (x + 1);
      directions[y * resolution + x] = borderDirections[source]!;
      radii[y * resolution + x] = borderRadii[source]!;
    }
  }

  const centreIndex =
    Math.floor(resolution / 2) * resolution + Math.floor(resolution / 2);
  const centre = directions[centreIndex]!.scale(radii[centreIndex]!);

  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const index = y * resolution + x;
      const direction = directions[index]!;
      const position = direction.scale(radii[index]!).sub(centre);

      positions[index * 3] = position.x;
      positions[index * 3 + 1] = position.y;
      positions[index * 3 + 2] = position.z;

      const normal = gridNormal(borderDirections, borderRadii, stride, x, y);
      normals[index * 3] = normal.x;
      normals[index * 3 + 1] = normal.y;
      normals[index * 3 + 2] = normal.z;

      // The true elevation, not the clamped radius. Every ocean vertex sits at
      // exactly sea level once flattened, so colouring from the radius makes
      // the whole sea one flat tone and the shoreline a hard step.
      const colour = surfaceColour(
        borderElevations[(y + 1) * stride + (x + 1)]!,
        1 - normal.dot(direction),
        profile,
      );
      colors[index * 3] = colour[0];
      colors[index * 3 + 1] = colour[1];
      colors[index * 3 + 2] = colour[2];
    }
  }

  writeSkirt(chunk, positions, normals, colors, directions, radii, centre, resolution);

  return {
    positions,
    normals,
    colors,
    indices: buildChunkIndices(resolution),
    centre,
    maxElevation,
  };
}

/**
 * Normal from central differences across the bordered grid.
 *
 * Because the differences straddle the rim using real samples from beyond it,
 * two chunks meeting at an edge difference the same points and produce the
 * same normal. Normals taken from triangles instead stop at a chunk boundary,
 * and the mismatch draws a bright seam along every join.
 */
function gridNormal(
  directions: readonly Vec3[],
  radii: Float64Array,
  stride: number,
  x: number,
  y: number,
): Vec3 {
  // Grid coordinates are offset by one inside the bordered arrays.
  const bx = x + 1;
  const by = y + 1;

  const at = (ix: number, iy: number): Vec3 => {
    const index = iy * stride + ix;
    return directions[index]!.scale(radii[index]!);
  };

  const east = at(bx + 1, by).sub(at(bx - 1, by));
  const north = at(bx, by + 1).sub(at(bx, by - 1));

  const normal = east.cross(north).normalized();
  const outward = directions[by * stride + bx]!;

  return normal.dot(outward) < 0 ? normal.negate() : normal;
}

/** Drop a wall from each edge of the chunk to hide cracks at level changes. */
function writeSkirt(
  chunk: Chunk,
  positions: Float32Array,
  normals: Float32Array,
  colors: Float32Array,
  directions: readonly Vec3[],
  radii: Float64Array,
  centre: Vec3,
  resolution: number,
): void {
  const depth = chunk.size * SKIRT_DEPTH;
  let write = resolution * resolution;

  const rims: ((i: number) => number)[] = [
    (i) => i,
    (i) => (resolution - 1) * resolution + i,
    (i) => i * resolution,
    (i) => i * resolution + (resolution - 1),
  ];

  for (const rim of rims) {
    for (let i = 0; i < resolution; i++) {
      const source = rim(i);
      const direction = directions[source]!;
      const dropped = direction.scale(radii[source]! - depth).sub(centre);

      positions[write * 3] = dropped.x;
      positions[write * 3 + 1] = dropped.y;
      positions[write * 3 + 2] = dropped.z;

      // Copy the rim's shading, so a skirt that does peek through matches the
      // ground beside it rather than showing as a dark band.
      for (let c = 0; c < 3; c++) {
        normals[write * 3 + c] = normals[source * 3 + c]!;
        colors[write * 3 + c] = colors[source * 3 + c]!;
      }

      write++;
    }
  }
}

type Colour = readonly [number, number, number];

const SAND: Colour = [0.62, 0.57, 0.38];
const GRASS: Colour = [0.18, 0.34, 0.16];
const ROCK: Colour = [0.34, 0.31, 0.28];
const SNOW: Colour = [0.86, 0.88, 0.92];
const SHALLOWS: Colour = [0.10, 0.28, 0.42];
const DEEP_OCEAN: Colour = [0.02, 0.08, 0.20];

/**
 * Ground colour from elevation and slope.
 *
 * Baked per vertex rather than sampled from textures. Slope-and-altitude
 * blending is what actually reads as terrain at a distance; detail textures
 * matter close up, and can be layered on later without changing this.
 */
export function surfaceColour(
  elevation: number,
  slope: number,
  profile: TerrainProfile = DEFAULT_TERRAIN,
): Colour {
  if (elevation <= 0) {
    // Shading the sea by depth gives coastlines a shelf to fade across, in
    // place of the single flat tone that made every shore a hard edge.
    return mix(SHALLOWS, DEEP_OCEAN, clamp01(-elevation / (profile.oceanDepth * 0.5)));
  }

  const height = elevation / (profile.continentAmplitude + profile.mountainAmplitude);

  let colour = mix(SAND, GRASS, clamp01(elevation / 120));
  colour = mix(colour, ROCK, clamp01((slope - 0.004) * 160));
  colour = mix(colour, SNOW, clamp01((height - 0.34) * 6));

  return colour;
}

function mix(a: Colour, b: Colour, t: number): Colour {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
