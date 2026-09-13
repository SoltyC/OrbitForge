/**
 * Procedural starfield.
 *
 * Stars are drawn as points on a very large sphere with depth writing off, so
 * they always sit behind the scene regardless of the camera's far plane. The
 * distribution is uniform over the sphere (not uniform in angle, which would
 * bunch stars at the poles).
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Points,
  PointsMaterial,
} from 'three/webgpu';

const STAR_COUNT = 6_000;
const STAR_SHELL_RADIUS = 5e8;

/** Deterministic PRNG so the sky is identical every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createStarfield(seed = 1): Points {
  const random = mulberry32(seed);
  const positions = new Float32Array(STAR_COUNT * 3);
  const colors = new Float32Array(STAR_COUNT * 3);

  for (let i = 0; i < STAR_COUNT; i++) {
    // Uniform point on a sphere: z is uniform, azimuth is uniform.
    const z = random() * 2 - 1;
    const azimuth = random() * Math.PI * 2;
    const ringRadius = Math.sqrt(1 - z * z);

    positions[i * 3] = Math.cos(azimuth) * ringRadius * STAR_SHELL_RADIUS;
    positions[i * 3 + 1] = Math.sin(azimuth) * ringRadius * STAR_SHELL_RADIUS;
    positions[i * 3 + 2] = z * STAR_SHELL_RADIUS;

    // Slight blue/orange spread so the field is not flat white.
    const warmth = random();
    const brightness = 0.5 + random() * 0.5;
    colors[i * 3] = brightness * (0.8 + warmth * 0.2);
    colors[i * 3 + 1] = brightness * 0.9;
    colors[i * 3 + 2] = brightness * (1.0 - warmth * 0.2);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));

  const stars = new Points(
    geometry,
    new PointsMaterial({
      size: 2,
      sizeAttenuation: false,
      vertexColors: true,
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
    }),
  );

  stars.name = 'starfield';
  // Never frustum-cull the sky, and always draw it first.
  stars.frustumCulled = false;
  stars.renderOrder = -1;

  return stars;
}
