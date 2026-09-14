/**
 * Which plant stands on which patch of ground.
 *
 * Cells are addressed in cube-sphere face coordinates, the same parameterisation
 * the terrain is built from. That matters more than it looks: a grid built from
 * the camera's own frame drifts as the camera moves, so every plant rehashes
 * into a different cell and the whole field swims underfoot. Face coordinates
 * belong to the planet, so a patch of ground is the same cell from any
 * distance, at any time, forever.
 *
 * No renderer here either. This answers "what grows at this cell, and where
 * exactly does it stand", and the renderer turns that into instances.
 */
import { Vec3 } from '../sim/vec3.js';
import { faceToDirection } from '../terrain/cubeSphere.js';
import type { FaceIndex } from '../terrain/cubeSphere.js';
import type { TerrainProfile } from '../terrain/height.js';
import { DEFAULT_TERRAIN, elevationAt } from '../terrain/height.js';
import { drawTraits } from './plantGeometry.js';
import type { PlantTraits } from './plantGeometry.js';
import { hashUnit } from './scatter.js';
import type { VegetationProfile } from './scatter.js';
import { DEFAULT_VEGETATION, growthDensity } from './scatter.js';
import { pickSpecies } from './species.js';
import type { Species } from './species.js';

export interface PlacedPlant {
  readonly species: Species;
  readonly traits: PlantTraits;
  /** Planet-centric position of the plant's base (m). */
  readonly position: Vec3;
  /** Outward surface normal where it stands. */
  readonly up: Vec3;
}

/** How many cells span one cube face, for a given spacing on the ground. */
export function cellsPerFace(planetRadius: number, cellSize: number): number {
  // A face spans a quarter turn of the planet.
  return Math.max(1, Math.round(((Math.PI / 2) * planetRadius) / cellSize));
}

/** Face coordinate at the centre of a cell. */
export function cellCoordinate(index: number, perFace: number): number {
  return ((index + 0.5) / perFace) * 2 - 1;
}

/** Cell index containing a face coordinate. */
export function cellIndex(coordinate: number, perFace: number): number {
  return Math.floor(((coordinate + 1) / 2) * perFace);
}

/**
 * Local warmth in [0, 1], which decides what kind of plant grows.
 *
 * Latitude sets the trend and a large-scale wobble breaks it up, so the biome
 * bands are not perfect rings around the planet. Altitude cools it, which is
 * why the tree line is a consequence rather than another hard rule.
 */
export function warmthAt(direction: Vec3, elevation: number): number {
  // Bodies spin about +Z, so that axis is latitude.
  const latitude = Math.abs(direction.z);
  const base = 1 - latitude * 1.15;

  const wobble =
    0.18 * Math.sin(direction.x * 4.1 + direction.y * 3.3) +
    0.1 * Math.sin(direction.y * 7.7 - direction.x * 5.2);

  const lapse = elevation / 4_000;

  return Math.min(1, Math.max(0, base + wobble - lapse));
}

/**
 * Every plant in a square block of cells.
 *
 * Placing cells one at a time costs six height-field evaluations each — one for
 * the cell, four for the slope, one for the offset position — and each of those
 * is eleven octaves of noise. Walking a block shares them: a 24-cell patch with
 * a one-cell border needs 676 samples rather than 3,456, because every interior
 * cell's slope is a difference of samples its neighbours already took.
 *
 * This is the difference between a field that appears in under two seconds and
 * one that takes twenty.
 */
export function plantsInBlock(
  face: FaceIndex,
  originX: number,
  originY: number,
  size: number,
  perFace: number,
  planetRadius: number,
  terrain: TerrainProfile = DEFAULT_TERRAIN,
  vegetation: VegetationProfile = DEFAULT_VEGETATION,
): PlacedPlant[] {
  const stride = size + 2;
  const elevations = new Float64Array(stride * stride);
  const directions: Vec3[] = new Array(stride * stride);

  // One bordered grid of samples, shared by every cell in the block.
  for (let y = 0; y < stride; y++) {
    for (let x = 0; x < stride; x++) {
      const direction = faceToDirection(
        face,
        cellCoordinate(originX + x - 1, perFace),
        cellCoordinate(originY + y - 1, perFace),
      );

      directions[y * stride + x] = direction;
      elevations[y * stride + x] = elevationAt(direction, terrain);
    }
  }

  const run = (2 * ((Math.PI / 2) * planetRadius)) / perFace;
  const salt = face * 7_919;
  const plants: PlacedPlant[] = [];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cellX = originX + x;
      const cellY = originY + y;
      if (cellX < 0 || cellY < 0 || cellX >= perFace || cellY >= perFace) continue;

      // Unoccupied cells cost nothing beyond the roll.
      const occupancy = hashUnit(cellX + salt, cellY, vegetation.seed);
      if (occupancy > vegetation.density) continue;

      const centre = (y + 1) * stride + (x + 1);
      const elevation = elevations[centre]!;
      if (elevation <= 0 || elevation > vegetation.treeLine) continue;

      const slope =
        Math.hypot(
          elevations[centre + 1]! - elevations[centre - 1]!,
          elevations[centre + stride]! - elevations[centre - stride]!,
        ) / run;

      const density = growthDensity(elevation, slope, vegetation, terrain);
      if (density <= 0 || occupancy > density * vegetation.density) continue;

      const direction = directions[centre]!;
      const species = pickSpecies(
        hashUnit(cellX + salt, cellY, vegetation.seed + 17),
        elevation,
        slope,
        warmthAt(direction, elevation),
      );
      if (!species) continue;

      const rolls: number[] = [];
      for (let i = 0; i < 9; i++) {
        rolls.push(hashUnit(cellX + salt, cellY, vegetation.seed + 101 + i * 13));
      }
      const traits = drawTraits(species, rolls);

      // Offset within the cell, so plants are not on a visible lattice. Over a
      // metre the ground does not move enough to be worth resampling, so the
      // cell's own elevation stands.
      const stand = faceToDirection(
        face,
        cellCoordinate(cellX, perFace) + ((rolls[6]! - 0.5) * 2) / perFace,
        cellCoordinate(cellY, perFace) + ((rolls[8]! - 0.5) * 2) / perFace,
      );

      plants.push({
        species,
        traits,
        position: stand.scale(planetRadius + elevation),
        up: stand,
      });
    }
  }

  return plants;
}

/** Local slope, as rise over run, from a central difference across cells. */
export function slopeAt(
  face: FaceIndex,
  cellX: number,
  cellY: number,
  perFace: number,
  planetRadius: number,
  terrain: TerrainProfile = DEFAULT_TERRAIN,
): number {
  const at = (dx: number, dy: number): number =>
    elevationAt(
      faceToDirection(
        face,
        cellCoordinate(cellX + dx, perFace),
        cellCoordinate(cellY + dy, perFace),
      ),
      terrain,
    );

  // Two cells apart on the ground, in metres.
  const run = (2 * ((Math.PI / 2) * planetRadius)) / perFace;

  return Math.hypot(at(1, 0) - at(-1, 0), at(0, 1) - at(0, -1)) / run;
}
