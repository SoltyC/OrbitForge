/**
 * Renders the atmosphere model to a PNG using the CPU reference
 * implementation, as ground truth for what the GPU shader should produce.
 *
 * The shader is a transcription of `atmosphere/scattering.ts`, so this image is
 * what the real sky is supposed to look like. If the game disagrees with it,
 * the shader is wrong rather than the physics.
 *
 *   npx vite-node tools/renderSkyReference.ts
 */
import { writeFileSync } from 'node:fs';
import { createAtmosphereModel } from '../src/atmosphere/model.js';
import type { AtmosphereModel } from '../src/atmosphere/model.js';
import { integrateScattering } from '../src/atmosphere/scattering.js';
import { buildTransmittanceLut } from '../src/atmosphere/transmittance.js';
import type { TransmittanceLut } from '../src/atmosphere/transmittance.js';
import { TERRIN } from '../src/bodies/system.js';
import { encodePng } from './png.js';

const PANEL_WIDTH = 340;
const PANEL_HEIGHT = 260;
const GAP = 8;

/** Matches DEFAULT_SUN_INTENSITY in the sky material. */
const SUN_INTENSITY = 22;

interface Panel {
  readonly label: string;
  /** Altitude of the viewpoint above sea level (m). */
  readonly altitude: number;
  /** Sun elevation above the horizon (degrees). */
  readonly sunElevation: number;
  /** Pitch of the camera relative to the horizon (degrees). */
  readonly cameraPitch: number;
  /** Horizontal field of view (degrees). */
  readonly fov: number;
}

const PANELS: readonly Panel[] = [
  { label: 'noon from the ground', altitude: 2, sunElevation: 60, cameraPitch: 20, fov: 100 },
  { label: 'sunset from the ground', altitude: 2, sunElevation: 1.5, cameraPitch: 8, fov: 100 },
  { label: 'limb from 400 km', altitude: 400_000, sunElevation: 25, cameraPitch: -50, fov: 55 },
];

function main(): void {
  const model = createAtmosphereModel(TERRIN);
  if (!model) throw new Error('Terrin has no atmosphere');

  const lut = buildTransmittanceLut(model);

  const width = PANEL_WIDTH * PANELS.length + GAP * (PANELS.length - 1);
  const height = PANEL_HEIGHT;
  const pixels = new Uint8Array(width * height * 3);

  PANELS.forEach((panel, index) => {
    const originX = index * (PANEL_WIDTH + GAP);
    renderPanel(model, lut, panel, pixels, width, originX);
    reportPanel(model, lut, panel);
  });

  writeFileSync('docs/sky-reference.png', encodePng(width, height, pixels));
  console.log(`\nwrote docs/sky-reference.png (${width}x${height})`);
}

function renderPanel(
  model: AtmosphereModel,
  lut: TransmittanceLut,
  panel: Panel,
  pixels: Uint8Array,
  imageWidth: number,
  originX: number,
): void {
  const r = model.bottomRadius + panel.altitude;

  // Camera basis: zenith is +Z, the view looks along +X tilted by the pitch.
  const pitch = (panel.cameraPitch * Math.PI) / 180;
  const forward = normalize([Math.cos(pitch), 0, Math.sin(pitch)]);
  const right: Vec = [0, -1, 0];
  const upAxis = normalize(cross(right, forward));

  const sunElevation = (panel.sunElevation * Math.PI) / 180;
  const sun: Vec = [Math.cos(sunElevation), 0, Math.sin(sunElevation)];

  const tanH = Math.tan(((panel.fov * Math.PI) / 180) / 2);
  const tanV = (tanH * PANEL_HEIGHT) / PANEL_WIDTH;

  for (let y = 0; y < PANEL_HEIGHT; y++) {
    const ndcY = 1 - (2 * (y + 0.5)) / PANEL_HEIGHT;

    for (let x = 0; x < PANEL_WIDTH; x++) {
      const ndcX = (2 * (x + 0.5)) / PANEL_WIDTH - 1;

      const direction = normalize(
        add(
          add(forward, scaleVec(right, ndcX * tanH)),
          scaleVec(upAxis, ndcY * tanV),
        ),
      );

      // Viewpoint sits on the zenith axis, so "up" is simply +Z.
      const mu = direction[2];
      const muSun = sun[2];
      const nu = dot(direction, sun);

      const sky = integrateScattering(model, lut, { r, mu, muSun, nu });

      const colour = tonemap([
        sky.radiance[0] * SUN_INTENSITY,
        sky.radiance[1] * SUN_INTENSITY,
        sky.radiance[2] * SUN_INTENSITY,
      ]);

      // The ground itself is not modelled here; shade it so the horizon reads.
      const isGround = sky.hitGround;
      const final: Vec = isGround
        ? [colour[0] * 0.5 + 0.06, colour[1] * 0.5 + 0.07, colour[2] * 0.5 + 0.05]
        : colour;

      const offset = ((y * imageWidth) + originX + x) * 3;
      pixels[offset] = toByte(final[0]);
      pixels[offset + 1] = toByte(final[1]);
      pixels[offset + 2] = toByte(final[2]);
    }
  }
}

/** Print the numbers behind each panel, so the image can be sanity-checked. */
function reportPanel(
  model: AtmosphereModel,
  lut: TransmittanceLut,
  panel: Panel,
): void {
  const r = model.bottomRadius + panel.altitude;
  const sunElevation = (panel.sunElevation * Math.PI) / 180;
  const muSun = Math.sin(sunElevation);
  const sun: Vec = [Math.cos(sunElevation), 0, muSun];

  // Sample along the panel's own centre ray; from orbit a straight-up ray
  // misses the atmosphere entirely and would report a meaningless zero.
  const pitch = (panel.cameraPitch * Math.PI) / 180;
  const centre = normalize([Math.cos(pitch), 0, Math.sin(pitch)]);

  const format = (c: readonly number[]): string =>
    c.map((v) => (v * SUN_INTENSITY).toFixed(3)).join(', ');

  const sample = (direction: Vec): string => {
    const result = integrateScattering(model, lut, {
      r,
      mu: direction[2],
      muSun,
      nu: dot(direction, sun),
    });
    return format(result.radiance);
  };

  // A little above and below the centre ray, to show the gradient.
  const upper = normalize(add(centre, [0, 0, 0.25]));
  const lower = normalize(add(centre, [0, 0, -0.25]));

  console.log(`${panel.label}:`);
  console.log(`  upper  rgb ${sample(upper)}`);
  console.log(`  centre rgb ${sample(centre)}`);
  console.log(`  lower  rgb ${sample(lower)}`);
}

type Vec = readonly [number, number, number];

/** Filmic-ish curve; the model outputs physical radiance, not display values. */
function tonemap(colour: Vec): Vec {
  return [reinhard(colour[0]), reinhard(colour[1]), reinhard(colour[2])];
}

function reinhard(value: number): number {
  const exposed = Math.max(0, value);
  // Tone-map, then encode to sRGB so gradients are not crushed.
  return Math.pow(exposed / (1 + exposed), 1 / 2.2);
}

function toByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value * 255)));
}

function normalize(v: Vec): Vec {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function add(a: Vec, b: Vec): Vec {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scaleVec(v: Vec, s: number): Vec {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function dot(a: Vec, b: Vec): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec, b: Vec): Vec {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

main();
