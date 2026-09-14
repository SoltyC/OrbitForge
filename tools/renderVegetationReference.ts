/**
 * Renders the vegetation scatter, as ground truth for the instanced version.
 *
 * Three views, because the scatter has three ways of going wrong and each
 * shows up at a different scale. Close up, a bad hash lays plants out in
 * visible rows. Across a landscape, the growth rules either follow the terrain
 * or draw contour lines across it. And from ground level, the field either
 * reads as a field or as a texture with things standing on it.
 *
 *   npx vite-node tools/renderVegetationReference.ts
 */
import { writeFileSync } from 'node:fs';
import { TERRIN } from '../src/bodies/system.js';
import { Vec3 } from '../src/sim/vec3.js';
import { DEFAULT_TERRAIN, elevationAt } from '../src/terrain/height.js';
import {
  DEFAULT_VEGETATION,
  growthDensity,
  plantInCell,
} from '../src/vegetation/scatter.js';
import type { Plant } from '../src/vegetation/scatter.js';
import { encodePng } from './png.js';

const PANEL = 320;
const GAP = 8;

const profile = DEFAULT_VEGETATION;

/** Ground-plane basis at the launch site, in metres. */
const ORIGIN = TERRIN.launchSite.normalized();
const NORTH = new Vec3(0, 0, 1).cross(ORIGIN).normalized();
const EAST = ORIGIN.cross(NORTH).normalized();

/** Elevation and slope at a point on the local ground plane. */
function ground(u: number, v: number): { elevation: number; slope: number } {
  const direction = ORIGIN.add(EAST.scale(u / TERRIN.radius))
    .add(NORTH.scale(v / TERRIN.radius))
    .normalized();

  const elevation = elevationAt(direction, DEFAULT_TERRAIN);

  // Slope from a short central difference, in rise over run.
  const step = 12;
  const at = (du: number, dv: number): number =>
    elevationAt(
      ORIGIN.add(EAST.scale((u + du) / TERRIN.radius))
        .add(NORTH.scale((v + dv) / TERRIN.radius))
        .normalized(),
      DEFAULT_TERRAIN,
    );

  const slope =
    Math.hypot(at(step, 0) - at(-step, 0), at(0, step) - at(0, -step)) / (2 * step);

  return { elevation, slope };
}

type Colour = readonly [number, number, number];

const PLANT_COLOURS: Record<Plant['kind'], Colour> = {
  grass: [0.32, 0.55, 0.22],
  shrub: [0.18, 0.36, 0.15],
  rock: [0.46, 0.43, 0.40],
};

function main(): void {
  const width = PANEL * 3 + GAP * 2;
  const pixels = new Uint8Array(width * PANEL * 3);

  scatterMap(pixels, width, 0, 40, 'close (40 m)');
  scatterMap(pixels, width, PANEL + GAP, 60_000, 'landscape (60 km)');
  obliqueView(pixels, width, (PANEL + GAP) * 2);

  reportRules();

  writeFileSync('docs/vegetation-reference.png', encodePng(width, PANEL, pixels));
  console.log(`\nwrote docs/vegetation-reference.png (${width}x${PANEL})`);
}

/** Top-down: every plant as a dot, over shaded ground. */
function scatterMap(
  pixels: Uint8Array,
  imageWidth: number,
  originX: number,
  extent: number,
  label: string,
): void {
  const metresPerPixel = extent / PANEL;

  let plants = 0;
  let vegetated = 0;

  for (let y = 0; y < PANEL; y++) {
    for (let x = 0; x < PANEL; x++) {
      const u = (x - PANEL / 2) * metresPerPixel;
      const v = (y - PANEL / 2) * metresPerPixel;

      const { elevation, slope } = ground(u, v);
      const density = growthDensity(elevation, slope, profile, DEFAULT_TERRAIN);
      if (density > 0.05) vegetated++;

      // Ground tone: sea, bare earth, or soil shaded by how much grows on it.
      let colour: Colour =
        elevation <= 0
          ? [0.06, 0.16, 0.30]
          : mix([0.42, 0.38, 0.30], [0.20, 0.30, 0.14], density);

      // Then the plant standing in this pixel's cell, if any.
      const cellX = Math.floor(u / profile.cellSize);
      const cellY = Math.floor(v / profile.cellSize);
      const plant = plantInCell(cellX, cellY, density, profile);

      if (plant && metresPerPixel < profile.cellSize * 0.6) {
        // Close enough to resolve individuals: draw where it actually stands.
        const px = cellX * profile.cellSize + plant.offsetU;
        const py = cellY * profile.cellSize + plant.offsetV;

        if (Math.abs(px - u) < metresPerPixel && Math.abs(py - v) < metresPerPixel) {
          colour = PLANT_COLOURS[plant.kind];
          plants++;
        }
      }

      write(pixels, imageWidth, originX + x, y, colour);
    }
  }

  console.log(
    `${label}: ${((100 * vegetated) / (PANEL * PANEL)).toFixed(1)}% of ground supports growth` +
      (plants > 0 ? `, ${plants} plants drawn` : ''),
  );
}

/**
 * How the growth rules behave across the whole planet, not just near the pad.
 *
 * The launch site is a flat coastal plain, so everything grows there and the
 * map panels alone cannot tell whether the rules do anything at all.
 */
function reportRules(): void {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const buckets = { bare: 0, sparse: 0, lush: 0 };

  for (let i = 0; i < 3_000; i++) {
    const y = 1 - (2 * (i + 0.5)) / 3_000;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const direction = new Vec3(
      Math.cos(golden * i) * radius,
      y,
      Math.sin(golden * i) * radius,
    );

    const elevation = elevationAt(direction, DEFAULT_TERRAIN);

    // Slope from a short difference along an arbitrary tangent.
    const tangent =
      Math.abs(direction.y) > 0.9 ? new Vec3(1, 0, 0) : new Vec3(0, 1, 0);
    const across = tangent.cross(direction).normalized().scale(12 / TERRIN.radius);
    const slope =
      Math.abs(elevationAt(direction.add(across).normalized(), DEFAULT_TERRAIN) - elevation) / 12;

    const density = growthDensity(elevation, slope, profile, DEFAULT_TERRAIN);
    if (density < 0.05) buckets.bare++;
    else if (density < 0.6) buckets.sparse++;
    else buckets.lush++;
  }

  const total = buckets.bare + buckets.sparse + buckets.lush;
  console.log(
    `\nacross the planet: ${((100 * buckets.bare) / total).toFixed(0)}% bare, ` +
      `${((100 * buckets.sparse) / total).toFixed(0)}% sparse, ` +
      `${((100 * buckets.lush) / total).toFixed(0)}% lush`,
  );
}

/**
 * Ground level, looking across the field.
 *
 * Painter's algorithm — collect what is in view, sort back to front, draw each
 * as an upright quad. Crude, but it answers the question the top-down views
 * cannot: whether this reads as a field someone is standing in.
 */
function obliqueView(pixels: Uint8Array, imageWidth: number, originX: number): void {
  const eyeHeight = 1.7;
  const range = 60;
  const fov = 1.2;

  // Sky and distant ground first.
  for (let y = 0; y < PANEL; y++) {
    for (let x = 0; x < PANEL; x++) {
      const horizon = PANEL * 0.42;
      const colour: Colour =
        y < horizon
          ? mix([0.55, 0.68, 0.85], [0.78, 0.85, 0.93], y / horizon)
          : mix([0.24, 0.32, 0.17], [0.30, 0.36, 0.22], (y - horizon) / PANEL);
      write(pixels, imageWidth, originX + x, y, colour);
    }
  }

  interface Billboard {
    readonly distance: number;
    readonly screenX: number;
    readonly baseY: number;
    readonly height: number;
    readonly width: number;
    readonly colour: Colour;
  }

  const billboards: Billboard[] = [];
  const cells = Math.ceil(range / profile.cellSize);

  for (let cy = -cells; cy <= cells; cy++) {
    for (let cx = -cells; cx <= cells; cx++) {
      const u = cx * profile.cellSize;
      const v = cy * profile.cellSize;

      const { elevation, slope } = ground(u, v);
      const density = growthDensity(elevation, slope, profile, DEFAULT_TERRAIN);

      const plant = plantInCell(cx, cy, density, profile);
      if (!plant) continue;

      const px = u + plant.offsetU;
      const pv = v + plant.offsetV;

      // Camera looks along +v; anything behind it is skipped.
      const forward = pv;
      if (forward < 1 || forward > range) continue;

      const lateral = px;
      const angle = Math.atan2(lateral, forward);
      if (Math.abs(angle) > fov / 2) continue;

      const scale = PANEL / (2 * Math.tan(fov / 2));
      const screenX = PANEL / 2 + (lateral / forward) * scale;

      const relief = ground(px, pv).elevation - ground(0, 0).elevation;
      const baseY = PANEL / 2 + ((eyeHeight - relief) / forward) * scale;

      billboards.push({
        distance: forward,
        screenX,
        baseY,
        height: (plant.height / forward) * scale,
        width: Math.max(1, ((plant.kind === 'grass' ? 0.18 : 0.5) / forward) * scale),
        colour: PLANT_COLOURS[plant.kind],
      });
    }
  }

  billboards.sort((a, b) => b.distance - a.distance);

  for (const board of billboards) {
    const shade = 0.55 + 0.45 * Math.exp(-board.distance / 60);
    const colour: Colour = [
      board.colour[0] * shade,
      board.colour[1] * shade,
      board.colour[2] * shade,
    ];

    for (let dx = -board.width / 2; dx <= board.width / 2; dx++) {
      for (let dy = 0; dy <= board.height; dy++) {
        const x = Math.round(board.screenX + dx);
        const y = Math.round(board.baseY - dy);
        if (x < 0 || x >= PANEL || y < 0 || y >= PANEL) continue;
        write(pixels, imageWidth, originX + x, y, colour);
      }
    }
  }

  console.log(`ground level: ${billboards.length} plants in view`);
}

function write(
  pixels: Uint8Array,
  imageWidth: number,
  x: number,
  y: number,
  colour: Colour,
): void {
  const offset = (y * imageWidth + x) * 3;
  pixels[offset] = toByte(colour[0]);
  pixels[offset + 1] = toByte(colour[1]);
  pixels[offset + 2] = toByte(colour[2]);
}

function mix(a: Colour, b: Colour, t: number): Colour {
  const k = Math.min(1, Math.max(0, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

function toByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(Math.pow(Math.max(0, value), 1 / 2.2) * 255)));
}

main();
