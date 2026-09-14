/**
 * Renders the terrain height field as shaded relief, to see whether it is
 * actually shaped like a planet.
 *
 * Relief rather than a perspective view on purpose. Raymarching the field from
 * a camera would cost a few hundred height samples per pixel, and each sample
 * is eleven noise evaluations — minutes per image. Sampling elevation once per
 * pixel and shading by the slope costs one, and shows the things worth
 * judging: where the continents are, whether mountains form ranges or scatter,
 * and whether the ridgelines look eroded or grid-aligned.
 *
 *   npx vite-node tools/renderTerrainReference.ts
 */
import { writeFileSync } from 'node:fs';
import { TERRIN } from '../src/bodies/system.js';
import { Vec3 } from '../src/sim/vec3.js';
import { DEFAULT_TERRAIN, elevationAt } from '../src/terrain/height.js';
import type { TerrainProfile } from '../src/terrain/height.js';
import { encodePng } from './png.js';

const PANEL = 300;
const GAP = 8;

interface View {
  readonly label: string;
  /** Half-angle of the patch shown, in radians. The globe is PI/2. */
  readonly extent: number;
  /** Centre of the view, as a direction from the planet's centre. */
  readonly centre: Vec3;
}

const VIEWS: readonly View[] = [
  { label: 'hemisphere', extent: Math.PI / 2, centre: new Vec3(1, 0.35, 0.2) },
  { label: 'continent (~900 km)', extent: 0.75, centre: new Vec3(1, 0.35, 0.2) },
  // Centred inland rather than on the same point as the wider views, which
  // happened to sit over water.
  { label: 'range (~150 km)', extent: 0.125, centre: new Vec3(0.86, 0.45, -0.25) },
];

function main(): void {
  const profile = DEFAULT_TERRAIN;
  const width = PANEL * VIEWS.length + GAP * (VIEWS.length - 1);
  const pixels = new Uint8Array(width * PANEL * 3);

  VIEWS.forEach((view, index) => {
    renderView(view, profile, pixels, width, index * (PANEL + GAP));
  });

  writeFileSync('docs/terrain-reference.png', encodePng(width, PANEL, pixels));
  console.log(`\nwrote docs/terrain-reference.png (${width}x${PANEL})`);
}

function renderView(
  view: View,
  profile: TerrainProfile,
  pixels: Uint8Array,
  imageWidth: number,
  originX: number,
): void {
  const forward = view.centre.normalized();
  const right = new Vec3(0, 1, 0).cross(forward).normalized();
  const up = forward.cross(right).normalized();

  // Light from the upper left, the convention that makes relief read as raised
  // rather than sunken.
  const sun = forward
    .scale(0.45)
    .add(right.scale(-0.6))
    .add(up.scale(0.66))
    .normalized();

  let land = 0;
  let highest = -Infinity;

  for (let y = 0; y < PANEL; y++) {
    const ndcY = 1 - (2 * (y + 0.5)) / PANEL;

    for (let x = 0; x < PANEL; x++) {
      const ndcX = (2 * (x + 0.5)) / PANEL - 1;

      const offset = (y * imageWidth + originX + x) * 3;

      // Mask the corners to a disc on wide views, where they would otherwise
      // wrap around the far side of the planet.
      const radial = Math.hypot(ndcX, ndcY);
      if (view.extent > 0.5 && radial > 1) {
        pixels[offset] = 4;
        pixels[offset + 1] = 6;
        pixels[offset + 2] = 10;
        continue;
      }

      // Azimuthal equidistant: rotate away from the centre by an angle
      // proportional to screen distance. A tangent-plane projection cannot
      // show a hemisphere at all — tan(pi/2) diverges, and the first version
      // of this renderer turned the globe into a sunburst.
      const angle = radial * view.extent;
      const tangent =
        radial > 1e-9
          ? right.scale(ndcX / radial).add(up.scale(ndcY / radial))
          : right;

      const direction = forward
        .scale(Math.cos(angle))
        .add(tangent.normalized().scale(Math.sin(angle)))
        .normalized();

      const elevation = elevationAt(direction, profile);
      if (elevation > 0) land++;
      highest = Math.max(highest, elevation);

      const colour = shade(direction, elevation, sun, profile, view.extent);

      pixels[offset] = toByte(colour[0]);
      pixels[offset + 1] = toByte(colour[1]);
      pixels[offset + 2] = toByte(colour[2]);
    }
  }

  const area = PANEL * PANEL;
  console.log(
    `${view.label}: ${((100 * land) / area).toFixed(1)}% land, ` +
      `highest ${(highest / 1000).toFixed(2)} km`,
  );
}

type Colour = readonly [number, number, number];

/** Colour a point by its elevation and the slope of the ground there. */
function shade(
  direction: Vec3,
  elevation: number,
  sun: Vec3,
  profile: TerrainProfile,
  extent: number,
): Colour {
  if (elevation <= 0) {
    // Deeper water reads darker, which makes the coastlines legible.
    const depth = Math.min(1, -elevation / profile.oceanDepth);
    return [0.03 + 0.04 * (1 - depth), 0.09 + 0.12 * (1 - depth), 0.22 + 0.18 * (1 - depth)];
  }

  const normal = surfaceNormal(direction, profile, extent);
  const lambert = Math.max(0.08, normal.dot(sun));

  // Slope decides the material: flats are vegetated, steep faces are bare
  // rock, and the highest ground is snow regardless.
  const slope = 1 - normal.dot(direction);
  const height = elevation / (profile.continentAmplitude + profile.mountainAmplitude);

  const grass: Colour = [0.18, 0.34, 0.16];
  const rock: Colour = [0.34, 0.31, 0.28];
  const snow: Colour = [0.86, 0.88, 0.92];
  const sand: Colour = [0.62, 0.57, 0.38];

  let base = mix(sand, grass, clamp01(height * 14));
  base = mix(base, rock, clamp01((slope - 0.004) * 160));
  base = mix(base, snow, clamp01((height - 0.34) * 6));

  return [base[0] * lambert, base[1] * lambert, base[2] * lambert];
}

/**
 * Normal from finite differences of the height field.
 *
 * The offset scales with the view, so a zoomed-in panel measures the slope
 * over a correspondingly smaller patch of ground; a fixed offset would smooth
 * away exactly the detail a close view exists to show.
 */
function surfaceNormal(direction: Vec3, profile: TerrainProfile, extent: number): Vec3 {
  const step = Math.max(1e-6, extent * 0.002);

  const tangentA = pickTangent(direction);
  const tangentB = direction.cross(tangentA).normalized();

  const radius = TERRIN.radius;
  const centre = direction.scale(radius + elevationAt(direction, profile));

  const a = direction.add(tangentA.scale(step)).normalized();
  const b = direction.add(tangentB.scale(step)).normalized();

  const pointA = a.scale(radius + elevationAt(a, profile));
  const pointB = b.scale(radius + elevationAt(b, profile));

  const normal = pointA.sub(centre).cross(pointB.sub(centre)).normalized();

  // Keep it pointing outward; the cross product's sign depends on the tangents.
  return normal.dot(direction) < 0 ? normal.negate() : normal;
}

function pickTangent(direction: Vec3): Vec3 {
  const reference =
    Math.abs(direction.y) > 0.9 ? new Vec3(1, 0, 0) : new Vec3(0, 1, 0);
  return reference.cross(direction).normalized();
}

function mix(a: Colour, b: Colour, t: number): Colour {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function toByte(value: number): number {
  // sRGB-ish encode, so the midtones are not crushed.
  return Math.max(0, Math.min(255, Math.round(Math.pow(clamp01(value), 1 / 2.2) * 255)));
}

main();
