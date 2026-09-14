/**
 * Renders the plant species as ground truth for the instanced version.
 *
 * A small software rasteriser, because the question — does this look like a
 * tree — cannot be answered from vertex counts. Two panels: a row of
 * individuals from each species, so the silhouettes can be judged; and a stand
 * of many, to see whether a field of them reads as varied or as one mesh
 * repeated.
 *
 *   npx vite-node tools/renderFloraReference.ts
 */
import { writeFileSync } from 'node:fs';
import { SPECIES, pickSpecies } from '../src/vegetation/species.js';
import type { Species } from '../src/vegetation/species.js';
import { buildPlant, drawTraits } from '../src/vegetation/plantGeometry.js';
import type { PlantMesh, PlantTraits } from '../src/vegetation/plantGeometry.js';
import { hashUnit } from '../src/vegetation/scatter.js';
import { encodePng } from './png.js';

const WIDTH = 1_180;
const HEIGHT = 620;

/** Sun direction, for a simple Lambert term. */
const SUN = normalise([0.5, 0.75, 0.42]);

function main(): void {
  const pixels = new Float32Array(WIDTH * HEIGHT * 3);
  const depth = new Float32Array(WIDTH * HEIGHT).fill(Infinity);

  skyAndGround(pixels);

  // Top row: one of each species, to judge the silhouettes.
  gallery(pixels, depth);

  // Bottom: a stand of mixed flora, to judge the variety.
  stand(pixels, depth);

  writeFileSync('docs/flora-reference.png', encodePng(WIDTH, HEIGHT, encode(pixels)));
  console.log(`wrote docs/flora-reference.png (${WIDTH}x${HEIGHT})`);
}

/** One individual of each species, evenly spaced. */
function gallery(pixels: Float32Array, depth: Float32Array): void {
  const camera = { x: 0, y: 7, z: -46, pitch: -0.06, scale: 430 };

  SPECIES.forEach((species, index) => {
    const spacing = 9.5;
    const x = (index - (SPECIES.length - 1) / 2) * spacing;

    const traits = traitsFor(species, index * 37 + 11);
    const mesh = buildPlant(species, traits);

    draw(pixels, depth, mesh, x, 0, 0, traits, camera, -HEIGHT * 0.22);
  });

  console.log(`gallery: ${SPECIES.length} species`);
}

/** A stand of plants chosen the way the scatter would choose them. */
function stand(pixels: Float32Array, depth: Float32Array): void {
  const camera = { x: 0, y: 3.2, z: -26, pitch: -0.04, scale: 470 };

  interface Placed {
    readonly mesh: PlantMesh;
    readonly traits: PlantTraits;
    readonly x: number;
    readonly z: number;
  }

  const placed: Placed[] = [];
  const counts = new Map<string, number>();

  for (let i = 0; i < 260; i++) {
    // Scattered across a patch of ground in front of the camera.
    const x = (hashUnit(i, 3, 7) - 0.5) * 46;
    const z = hashUnit(i, 5, 11) * 34;

    // Conditions vary across the patch, so the mix varies with it.
    const elevation = 180 + x * 4 + z * 2;
    const slope = 0.05 + Math.abs(x) * 0.004;
    const warmth = 0.62 - z * 0.004;

    const species = pickSpecies(hashUnit(i, 7, 13), elevation, slope, warmth);
    if (!species) continue;

    const traits = traitsFor(species, i * 13 + 5);
    placed.push({ mesh: buildPlant(species, traits), traits, x, z });
    counts.set(species.id, (counts.get(species.id) ?? 0) + 1);
  }

  // Painter's order: furthest first.
  placed.sort((a, b) => b.z - a.z);

  for (const item of placed) {
    draw(pixels, depth, item.mesh, item.x, 0, item.z, item.traits, camera, HEIGHT * 0.14);
  }

  const mix = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => `${id} ${n}`)
    .join(', ');
  console.log(`stand: ${placed.length} plants — ${mix}`);
}

function traitsFor(species: Species, salt: number): PlantTraits {
  const rolls: number[] = [];
  for (let i = 0; i < 9; i++) rolls.push(hashUnit(salt, i, 101));
  return drawTraits(species, rolls);
}

interface Camera {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly pitch: number;
  readonly scale: number;
}

/** Rasterise one plant, with a depth test and flat per-triangle lighting. */
function draw(
  pixels: Float32Array,
  depth: Float32Array,
  mesh: PlantMesh,
  atX: number,
  atY: number,
  atZ: number,
  traits: PlantTraits,
  camera: Camera,
  yOffset: number,
): void {
  const cos = Math.cos(traits.rotation);
  const sin = Math.sin(traits.rotation);

  const project = (i: number): { x: number; y: number; z: number } => {
    // Plant-local, spun about its own axis.
    const lx = mesh.positions[i * 3]!;
    const ly = mesh.positions[i * 3 + 1]!;
    const lz = mesh.positions[i * 3 + 2]!;

    const rx = lx * cos - lz * sin;
    const rz = lx * sin + lz * cos;

    // World, then camera.
    const wx = atX + rx - camera.x;
    const wy = atY + ly - camera.y;
    const wz = atZ + rz - camera.z;

    const cy = wy * Math.cos(camera.pitch) - wz * Math.sin(camera.pitch);
    const cz = wy * Math.sin(camera.pitch) + wz * Math.cos(camera.pitch);
    if (cz <= 0.2) return { x: -1e9, y: -1e9, z: cz };

    return {
      x: WIDTH / 2 + (wx / cz) * camera.scale,
      y: HEIGHT * 0.5 + yOffset - (cy / cz) * camera.scale,
      z: cz,
    };
  };

  for (let t = 0; t < mesh.indices.length; t += 3) {
    const ia = mesh.indices[t]!;
    const ib = mesh.indices[t + 1]!;
    const ic = mesh.indices[t + 2]!;

    const a = project(ia);
    const b = project(ib);
    const c = project(ic);
    if (a.z <= 0.2 || b.z <= 0.2 || c.z <= 0.2) continue;

    // Lambert from the averaged vertex normal.
    const nx = (mesh.normals[ia * 3]! + mesh.normals[ib * 3]! + mesh.normals[ic * 3]!) / 3;
    const ny =
      (mesh.normals[ia * 3 + 1]! + mesh.normals[ib * 3 + 1]! + mesh.normals[ic * 3 + 1]!) / 3;
    const nz =
      (mesh.normals[ia * 3 + 2]! + mesh.normals[ib * 3 + 2]! + mesh.normals[ic * 3 + 2]!) / 3;

    const lambert = Math.max(0.22, nx * SUN[0] + ny * SUN[1] + nz * SUN[2]);

    const colour: [number, number, number] = [
      mesh.colors[ia * 3]! * lambert,
      mesh.colors[ia * 3 + 1]! * lambert,
      mesh.colors[ia * 3 + 2]! * lambert,
    ];

    fillTriangle(pixels, depth, a, b, c, colour);
  }
}

function fillTriangle(
  pixels: Float32Array,
  depth: Float32Array,
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  c: { x: number; y: number; z: number },
  colour: readonly [number, number, number],
): void {
  const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
  const maxX = Math.min(WIDTH - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
  const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
  const maxY = Math.min(HEIGHT - 1, Math.ceil(Math.max(a.y, b.y, c.y)));

  const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
  if (Math.abs(area) < 1e-9) return;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;

      const w0 = ((b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y)) / area;
      const w1 = ((px - a.x) * (c.y - a.y) - (c.x - a.x) * (py - a.y)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;

      const z = a.z * w2 + b.z * w1 + c.z * w0;
      const index = y * WIDTH + x;
      if (z >= depth[index]!) continue;

      depth[index] = z;
      pixels[index * 3] = colour[0];
      pixels[index * 3 + 1] = colour[1];
      pixels[index * 3 + 2] = colour[2];
    }
  }
}

function skyAndGround(pixels: Float32Array): void {
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      // One sky and one ground plane across the whole image; the two rows of
      // plants share it, the gallery standing further back than the stand.
      const t = y / HEIGHT;
      const horizon = 0.52;

      const colour: [number, number, number] =
        t < horizon
          ? [0.30 + t * 0.22, 0.46 + t * 0.24, 0.68 + t * 0.16]
          : [0.16 + (t - horizon) * 0.28, 0.22 + (t - horizon) * 0.24, 0.10 + (t - horizon) * 0.1];

      const index = (y * WIDTH + x) * 3;
      pixels[index] = colour[0];
      pixels[index + 1] = colour[1];
      pixels[index + 2] = colour[2];
    }
  }
}

/** Linear to sRGB bytes. */
function encode(pixels: Float32Array): Uint8Array {
  const out = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) {
    const c = Math.min(1, Math.max(0, pixels[i]!));
    const srgb = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    out[i] = Math.round(srgb * 255);
  }
  return out;
}

function normalise(v: readonly [number, number, number]): [number, number, number] {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

main();
