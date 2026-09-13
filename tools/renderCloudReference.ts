/**
 * Renders the cloud model with the CPU reference implementation, as ground
 * truth for the GPU shader.
 *
 * Composites clouds over the atmosphere so the result is judged the way it
 * will actually be seen: cloud luminance is sunlight scattered towards the
 * eye, and cloud transmittance is what the sky behind them keeps.
 *
 *   npx vite-node tools/renderCloudReference.ts
 */
import { writeFileSync } from 'node:fs';
import { createAtmosphereModel } from '../src/atmosphere/model.js';
import type { AtmosphereModel } from '../src/atmosphere/model.js';
import { integrateScattering } from '../src/atmosphere/scattering.js';
import { buildTransmittanceLut } from '../src/atmosphere/transmittance.js';
import type { TransmittanceLut } from '../src/atmosphere/transmittance.js';
import { TERRIN } from '../src/bodies/system.js';
import { DEFAULT_CLOUD_LAYER } from '../src/clouds/density.js';
import type { CloudLayer } from '../src/clouds/density.js';
import { marchClouds } from '../src/clouds/march.js';
import { encodePng } from './png.js';

const PANEL_WIDTH = 340;
const PANEL_HEIGHT = 260;
const GAP = 8;

/** Matches DEFAULT_SUN_INTENSITY in the sky material. */
const SUN_INTENSITY = 22;
/** Scales cloud luminance into the same units as the sky. */
const CLOUD_BRIGHTNESS = 9;

interface Panel {
  readonly label: string;
  readonly altitude: number;
  readonly sunElevation: number;
  readonly cameraPitch: number;
  readonly fov: number;
  readonly layer?: Partial<CloudLayer>;
}

const PANELS: readonly Panel[] = [
  { label: 'from below, noon', altitude: 300, sunElevation: 55, cameraPitch: 22, fov: 95 },
  { label: 'from below, low sun', altitude: 300, sunElevation: 8, cameraPitch: 12, fov: 95 },
  { label: 'from 9 km, looking down', altitude: 9_000, sunElevation: 35, cameraPitch: -14, fov: 80 },
];

function main(): void {
  const atmosphere = createAtmosphereModel(TERRIN);
  if (!atmosphere) throw new Error('Terrin has no atmosphere');

  const lut = buildTransmittanceLut(atmosphere);

  const width = PANEL_WIDTH * PANELS.length + GAP * (PANELS.length - 1);
  const pixels = new Uint8Array(width * PANEL_HEIGHT * 3);

  PANELS.forEach((panel, index) => {
    renderPanel(atmosphere, lut, panel, pixels, width, index * (PANEL_WIDTH + GAP));
  });

  writeFileSync('docs/cloud-reference.png', encodePng(width, PANEL_HEIGHT, pixels));
  console.log(`wrote docs/cloud-reference.png (${width}x${PANEL_HEIGHT})`);
}

function renderPanel(
  atmosphere: AtmosphereModel,
  lut: TransmittanceLut,
  panel: Panel,
  pixels: Uint8Array,
  imageWidth: number,
  originX: number,
): void {
  const layer: CloudLayer = { ...DEFAULT_CLOUD_LAYER, ...panel.layer };
  const r = atmosphere.bottomRadius + panel.altitude;

  // Zenith is +Y here, to match the cloud model's (x, altitude, z) axes.
  const pitch = (panel.cameraPitch * Math.PI) / 180;
  const forward = normalise([Math.cos(pitch), Math.sin(pitch), 0]);
  const right: Vec = [0, 0, 1];
  const upAxis = normalise(cross(right, forward));

  const sunElevation = (panel.sunElevation * Math.PI) / 180;
  const sun: Vec = normalise([Math.cos(sunElevation), Math.sin(sunElevation), 0]);

  const tanH = Math.tan(((panel.fov * Math.PI) / 180) / 2);
  const tanV = (tanH * PANEL_HEIGHT) / PANEL_WIDTH;

  let cloudPixels = 0;

  for (let y = 0; y < PANEL_HEIGHT; y++) {
    const ndcY = 1 - (2 * (y + 0.5)) / PANEL_HEIGHT;

    for (let x = 0; x < PANEL_WIDTH; x++) {
      const ndcX = (2 * (x + 0.5)) / PANEL_WIDTH - 1;

      const direction = normalise(
        add(add(forward, scaleVec(right, ndcX * tanH)), scaleVec(upAxis, ndcY * tanV)),
      );

      // The sky, in the atmosphere model's (radius, zenith cosine) terms.
      const sky = integrateScattering(atmosphere, lut, {
        r,
        mu: direction[1],
        muSun: sun[1],
        nu: dot(direction, sun),
      });

      const clouds = marchClouds(layer, {
        origin: [0, panel.altitude, 0],
        direction,
        sunDirection: sun,
        // Jitter by pixel, as the shader will, so banding is visible here too.
        jitter: blueNoise(x, y),
      });

      if (clouds.transmittance < 0.95) cloudPixels++;

      // Sky behind, attenuated by cloud, plus the light the cloud scatters.
      const cloudLight = clouds.luminance * CLOUD_BRIGHTNESS;
      const colour: Vec = [
        sky.radiance[0] * SUN_INTENSITY * clouds.transmittance + cloudLight,
        sky.radiance[1] * SUN_INTENSITY * clouds.transmittance + cloudLight * 0.98,
        sky.radiance[2] * SUN_INTENSITY * clouds.transmittance + cloudLight * 0.95,
      ];

      const shaded = sky.hitGround
        ? [colour[0] * 0.5 + 0.05, colour[1] * 0.5 + 0.07, colour[2] * 0.5 + 0.04]
        : colour;

      const offset = (y * imageWidth + originX + x) * 3;
      pixels[offset] = toByte(reinhard(shaded[0]!));
      pixels[offset + 1] = toByte(reinhard(shaded[1]!));
      pixels[offset + 2] = toByte(reinhard(shaded[2]!));
    }
  }

  const coverage = ((100 * cloudPixels) / (PANEL_WIDTH * PANEL_HEIGHT)).toFixed(1);
  console.log(`${panel.label}: ${coverage}% of pixels show cloud`);
}

/** Cheap hash-based dither, standing in for a blue-noise texture. */
function blueNoise(x: number, y: number): number {
  const h = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return h - Math.floor(h);
}

type Vec = readonly [number, number, number];

function reinhard(value: number): number {
  const exposed = Math.max(0, value);
  return Math.pow(exposed / (1 + exposed), 1 / 2.2);
}

function toByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value * 255)));
}

function normalise(v: Vec): Vec {
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
