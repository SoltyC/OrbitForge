/**
 * Grows a plant's geometry from its traits.
 *
 * Plain arrays of numbers, no renderer involved, so a plant can be grown and
 * inspected in a test. The renderer turns these into buffers.
 *
 * Every form is built rather than modelled: a conifer is a trunk with whorls
 * of branches that shorten as they climb, a broadleaf is a trunk that forks
 * into limbs carrying foliage masses, a fern is a crown of arching fronds. The
 * point is that changing one trait — height, limb count, spread — changes the
 * silhouette rather than just its scale, so two individuals of one species are
 * recognisably the same kind of plant and not the same plant.
 */
import { sample } from './species.js';
import type { Species } from './species.js';

export interface PlantMesh {
  /** Positions, relative to the base of the plant, in metres. */
  readonly positions: number[];
  readonly normals: number[];
  /** Linear RGB per vertex. */
  readonly colors: number[];
  readonly indices: number[];
  /**
   * How freely each vertex moves in wind, in [0, 1]. Zero at the roots, one at
   * the tips — so a trunk stays put while its foliage sways.
   */
  readonly sway: number[];
}

/** Traits drawn for one individual, from the hash of where it stands. */
export interface PlantTraits {
  readonly height: number;
  readonly spread: number;
  readonly limbs: number;
  /** Foliage colour, linear RGB. */
  readonly foliage: readonly [number, number, number];
  readonly wood: readonly [number, number, number];
  /** Rotation about the plant's own axis (rad). */
  readonly rotation: number;
  /** How far the whole plant leans (rad). */
  readonly lean: number;
  /** Which way it leans (rad). */
  readonly leanDirection: number;
}

/**
 * Draw an individual's traits from a sequence of rolls.
 *
 * Each trait gets its own roll, so they vary independently — a tall plant is
 * not automatically a broad one, which is what makes a stand of trees look
 * grown rather than scaled.
 */
export function drawTraits(species: Species, rolls: readonly number[]): PlantTraits {
  const roll = (i: number): number => rolls[i % rolls.length] ?? 0.5;

  const hue = sample(species.hue, roll(3));
  const saturation = sample(species.saturation, roll(4));
  const lightness = sample(species.lightness, roll(5));

  return {
    height: sample(species.height, roll(0)),
    spread: sample(species.spread, roll(1)),
    limbs: Math.round(sample(species.limbs, roll(2))),
    foliage: hslToLinearRgb(hue, saturation, lightness),
    wood: hexToLinearRgb(species.woodColour),
    rotation: roll(6) * Math.PI * 2,
    lean: (roll(7) - 0.5) * 0.22,
    leanDirection: roll(8) * Math.PI * 2,
  };
}

/**
 * Level of detail a plant is grown at.
 *
 * A tree is worth seeing from hundreds of metres away, and at that range its
 * eight hundred triangles are resolving detail smaller than a pixel. Growing a
 * coarser version of the same plant — fewer branches, fewer segments on each
 * foliage mass — keeps the silhouette, which is all that survives the distance
 * anyway, at a fraction of the cost.
 */
export type PlantDetail = 0 | 1 | 2;

/** Build the mesh for one plant. */
export function buildPlant(
  species: Species,
  traits: PlantTraits,
  detail: PlantDetail = 0,
): PlantMesh {
  const mesh: PlantMesh = {
    positions: [],
    normals: [],
    colors: [],
    indices: [],
    sway: [],
  };

  // Coarser plants shed limbs as well as segments: at distance a tree's
  // silhouette is a mass on a trunk, and the individual branches inside it are
  // no longer separable.
  const coarse: PlantTraits =
    detail === 0
      ? traits
      : { ...traits, limbs: Math.max(2, Math.round(traits.limbs / (detail + 1))) };

  switch (species.form) {
    case 'conifer':
      growConifer(mesh, coarse, detail);
      break;
    case 'canopy':
      growCanopy(mesh, coarse, detail);
      break;
    case 'frond':
      growFrond(mesh, coarse, detail);
      break;
    case 'tuft':
      growTuft(mesh, coarse, detail);
      break;
    case 'rock':
      growRock(mesh, coarse, detail);
      break;
  }

  return mesh;
}

/**
 * A conifer: a tapering trunk carrying whorls of branches that shorten and
 * steepen towards the top.
 */
function growConifer(mesh: PlantMesh, traits: PlantTraits, detail: PlantDetail): void {
  const { height, spread, limbs } = traits;

  addTaperedStem(mesh, height, height * 0.045, height * 0.008, traits.wood, detail === 0 ? 6 : 3);

  for (let i = 0; i < limbs; i++) {
    // Whorls start a third of the way up and crowd together near the crown.
    const t = i / Math.max(1, limbs - 1);
    const y = height * (0.3 + 0.68 * Math.pow(t, 0.85));

    // Branch length falls off towards the top, which is the whole silhouette.
    const reach = height * spread * (1 - Math.pow(t, 1.4)) * 1.15;
    if (reach < height * 0.02) continue;

    const perWhorl = detail === 0 ? 3 + (i % 2) : 2;
    for (let b = 0; b < perWhorl; b++) {
      const angle = traits.rotation + (b / perWhorl) * Math.PI * 2 + i * 1.1;
      const droop = -0.25 - 0.3 * (1 - t);

      addBough(mesh, y, angle, reach, droop, height * 0.02, traits.foliage, t, detail);
    }
  }
}

/**
 * A broadleaf or shrub: a short trunk forking into limbs, each carrying a
 * rounded mass of foliage.
 */
function growCanopy(mesh: PlantMesh, traits: PlantTraits, detail: PlantDetail): void {
  const { height, spread, limbs } = traits;

  const trunkHeight = height * 0.45;
  addTaperedStem(mesh, trunkHeight, height * 0.05, height * 0.03, traits.wood, detail === 0 ? 6 : 3);

  for (let i = 0; i < limbs; i++) {
    const angle = traits.rotation + (i / limbs) * Math.PI * 2 + (i % 2) * 0.4;
    const lift = 0.55 + 0.35 * ((i * 7) % 5) / 5;

    const reach = height * spread * (0.55 + 0.45 * ((i * 3) % 4) / 4);
    const crownY = trunkHeight + height * 0.12 * lift;

    // A limb out to the crown, then the foliage mass sitting on its end.
    if (detail === 0) {
      addBough(mesh, trunkHeight * 0.8, angle, reach * 0.7, 0.5, height * 0.022, traits.wood, 0.3, detail);
    }

    // Each mass is tinted a little differently, so a canopy has variation
    // within it rather than being one flat colour across the whole tree.
    const tint = 0.86 + 0.28 * ((i * 5) % 7) / 7;

    addBlob(
      mesh,
      Math.cos(angle) * reach * 0.62,
      crownY + height * 0.18 * lift,
      Math.sin(angle) * reach * 0.62,
      height * spread * 0.42,
      [traits.foliage[0] * tint, traits.foliage[1] * tint, traits.foliage[2] * tint],
      0.85,
      detail,
    );
  }

  // A crown mass over the middle, so the canopy closes rather than reading as
  // separate lumps on sticks.
  addBlob(mesh, 0, height * 0.82, 0, height * spread * 0.52, traits.foliage, 0.7, detail);
}

/** A palm or fern: a crown of long fronds arching out and down. */
function growFrond(mesh: PlantMesh, traits: PlantTraits, detail: PlantDetail): void {
  const { height, spread, limbs } = traits;

  const stemHeight = height * 0.62;
  addTaperedStem(mesh, stemHeight, height * 0.035, height * 0.022, traits.wood, detail === 0 ? 5 : 3);

  for (let i = 0; i < limbs; i++) {
    const angle = traits.rotation + (i / limbs) * Math.PI * 2;
    const length = height * spread * (0.8 + 0.4 * ((i * 5) % 3) / 3);

    addFrondBlade(mesh, stemHeight, angle, length, height * 0.1, traits.foliage, detail);
  }
}

/** Grass or flowers: a clump of blades splaying from a point. */
function growTuft(mesh: PlantMesh, traits: PlantTraits, detail: PlantDetail): void {
  const { height, spread, limbs } = traits;

  for (let i = 0; i < limbs; i++) {
    const angle = traits.rotation + (i / limbs) * Math.PI * 2 + (i % 3) * 0.7;
    const bladeHeight = height * (0.55 + 0.45 * ((i * 11) % 7) / 7);
    const outward = height * spread * 0.35 * ((i * 5) % 4) / 4;

    addBlade(
      mesh,
      Math.cos(angle) * outward,
      Math.sin(angle) * outward,
      angle,
      bladeHeight,
      height * 0.07,
      traits.foliage,
      detail,
    );
  }
}

/** A boulder: a lumpy, irregular solid. */
function growRock(mesh: PlantMesh, traits: PlantTraits, detail: PlantDetail): void {
  const { height, spread } = traits;
  const radius = height * spread * 0.5;

  const rings = detail === 0 ? 4 : 2;
  const segments = detail === 0 ? 7 : 4;
  const base = mesh.positions.length / 3;

  for (let r = 0; r <= rings; r++) {
    const v = r / rings;
    const polar = v * Math.PI * 0.55;

    for (let s = 0; s <= segments; s++) {
      const u = s / segments;
      const azimuth = u * Math.PI * 2;

      // Deterministic lumpiness, so a boulder is not an egg.
      const lump =
        0.78 +
        0.22 * Math.sin(azimuth * 3 + traits.rotation) * Math.cos(polar * 4) +
        0.12 * Math.sin(azimuth * 5 - polar * 3);

      const rr = radius * lump;
      const x = Math.sin(polar) * Math.cos(azimuth) * rr;
      const y = Math.cos(polar) * rr * 0.9;
      const z = Math.sin(polar) * Math.sin(azimuth) * rr;

      pushVertex(mesh, x, y, z, x, y + radius * 0.2, z, traits.foliage, 0);
    }
  }

  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = base + r * (segments + 1) + s;
      const b = a + segments + 1;
      mesh.indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
}

/** A tapering cylinder, for trunks and stems. */
function addTaperedStem(
  mesh: PlantMesh,
  height: number,
  bottomRadius: number,
  topRadius: number,
  colour: readonly [number, number, number],
  sides: number,
): void {
  const base = mesh.positions.length / 3;

  for (let ring = 0; ring <= 1; ring++) {
    const y = ring * height;
    const radius = ring === 0 ? bottomRadius : topRadius;

    for (let s = 0; s <= sides; s++) {
      const angle = (s / sides) * Math.PI * 2;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;

      // Trunks barely move; the sway weight rises with height.
      pushVertex(mesh, x, y, z, Math.cos(angle), 0.2, Math.sin(angle), colour, ring * 0.15);
    }
  }

  for (let s = 0; s < sides; s++) {
    const a = base + s;
    const b = base + sides + 1 + s;
    mesh.indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
}

/** A branch: a thin tapered limb angled out and usually drooping. */
function addBough(
  mesh: PlantMesh,
  y: number,
  angle: number,
  length: number,
  droop: number,
  radius: number,
  colour: readonly [number, number, number],
  swayBase: number,
  detail: PlantDetail,
): void {
  const base = mesh.positions.length / 3;
  const sides = detail === 0 ? 4 : 3;

  const dirX = Math.cos(angle);
  const dirZ = Math.sin(angle);

  for (let ring = 0; ring <= 1; ring++) {
    const t = ring;
    const r = radius * (1 - t * 0.75);

    const cx = dirX * length * t;
    const cy = y + droop * length * t * t;
    const cz = dirZ * length * t;

    for (let s = 0; s <= sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      // Ring lies roughly perpendicular to the branch.
      const ox = Math.cos(a) * r * -dirZ;
      const oy = Math.sin(a) * r;
      const oz = Math.cos(a) * r * dirX;

      pushVertex(
        mesh,
        cx + ox,
        cy + oy,
        cz + oz,
        dirX * 0.3 + ox,
        0.5 + oy,
        dirZ * 0.3 + oz,
        colour,
        swayBase + t * 0.5,
      );
    }
  }

  for (let s = 0; s < sides; s++) {
    const a = base + s;
    const b = base + sides + 1 + s;
    mesh.indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
}

/** A rounded mass of foliage. */
function addBlob(
  mesh: PlantMesh,
  x: number,
  y: number,
  z: number,
  radius: number,
  colour: readonly [number, number, number],
  sway: number,
  detail: PlantDetail,
): void {
  // Enough segments that a canopy reads as a mass rather than as facets. At
  // three by six the foliage came out as flat angular plates, which is the
  // single thing that most made these look modelled rather than grown — but
  // that only matters close up, so distance sheds them again.
  const rings = detail === 0 ? 6 : detail === 1 ? 4 : 3;
  const segments = detail === 0 ? 10 : detail === 1 ? 6 : 4;
  const base = mesh.positions.length / 3;

  for (let r = 0; r <= rings; r++) {
    const polar = (r / rings) * Math.PI;

    for (let s = 0; s <= segments; s++) {
      const azimuth = (s / segments) * Math.PI * 2;

      // Irregularity at two frequencies, so no two masses share a silhouette.
      const wobble =
        0.82 +
        0.14 * Math.sin(azimuth * 3 + polar * 2.3) +
        0.08 * Math.sin(azimuth * 7 - polar * 4.1);
      const rr = radius * wobble;

      const px = Math.sin(polar) * Math.cos(azimuth) * rr;
      const py = Math.cos(polar) * rr * 0.92;
      const pz = Math.sin(polar) * Math.sin(azimuth) * rr;

      // Shade the underside of the mass darker than the crown, which is most
      // of what gives a canopy depth without any real self-shadowing.
      const shade = 0.62 + 0.38 * (0.5 + 0.5 * Math.cos(polar));

      pushVertex(
        mesh,
        x + px,
        y + py,
        z + pz,
        px,
        py,
        pz,
        [colour[0] * shade, colour[1] * shade, colour[2] * shade],
        sway,
      );
    }
  }

  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = base + r * (segments + 1) + s;
      const b = a + segments + 1;
      mesh.indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
}

/** A long arching frond, as a tapering strip. */
function addFrondBlade(
  mesh: PlantMesh,
  y: number,
  angle: number,
  length: number,
  width: number,
  colour: readonly [number, number, number],
  detail: PlantDetail,
): void {
  const base = mesh.positions.length / 3;
  const steps = detail === 0 ? 5 : 2;

  const dirX = Math.cos(angle);
  const dirZ = Math.sin(angle);

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;

    // Arch: out and up, then over and down.
    const reach = length * t;
    const height = y + length * (0.42 * t - 0.72 * t * t);
    const halfWidth = width * (1 - t * 0.8) * Math.sin(Math.PI * Math.min(1, t * 1.4 + 0.1));

    for (const side of [-1, 1]) {
      pushVertex(
        mesh,
        dirX * reach + -dirZ * halfWidth * side,
        height,
        dirZ * reach + dirX * halfWidth * side,
        0,
        1,
        0,
        colour,
        0.2 + t * 0.8,
      );
    }
  }

  for (let i = 0; i < steps; i++) {
    const a = base + i * 2;
    mesh.indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
}

/** A single upright blade, for grass and flower tufts. */
function addBlade(
  mesh: PlantMesh,
  x: number,
  z: number,
  angle: number,
  height: number,
  width: number,
  colour: readonly [number, number, number],
  detail: PlantDetail,
): void {
  const base = mesh.positions.length / 3;
  const steps = detail === 0 ? 3 : 1;

  const leanX = Math.cos(angle) * height * 0.3;
  const leanZ = Math.sin(angle) * height * 0.3;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const halfWidth = (width / 2) * (1 - t * 0.9);

    // Blades curve over as they rise.
    const px = x + leanX * t * t;
    const py = height * t;
    const pz = z + leanZ * t * t;

    for (const side of [-1, 1]) {
      pushVertex(
        mesh,
        px + -Math.sin(angle) * halfWidth * side,
        py,
        pz + Math.cos(angle) * halfWidth * side,
        0,
        1,
        0,
        colour,
        t,
      );
    }
  }

  for (let i = 0; i < steps; i++) {
    const a = base + i * 2;
    mesh.indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
}

function pushVertex(
  mesh: PlantMesh,
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
  colour: readonly [number, number, number],
  sway: number,
): void {
  mesh.positions.push(x, y, z);

  const length = Math.hypot(nx, ny, nz) || 1;
  mesh.normals.push(nx / length, ny / length, nz / length);

  mesh.colors.push(colour[0], colour[1], colour[2]);
  mesh.sway.push(Math.min(1, Math.max(0, sway)));
}

/** HSL to linear RGB, which is the space the renderer lights in. */
export function hslToLinearRgb(
  hue: number,
  saturation: number,
  lightness: number,
): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = (((hue % 1) + 1) % 1) * 6;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));
  const match = lightness - chroma / 2;

  let rgb: [number, number, number];
  if (sector < 1) rgb = [chroma, second, 0];
  else if (sector < 2) rgb = [second, chroma, 0];
  else if (sector < 3) rgb = [0, chroma, second];
  else if (sector < 4) rgb = [0, second, chroma];
  else if (sector < 5) rgb = [second, 0, chroma];
  else rgb = [chroma, 0, second];

  return [
    srgbToLinear(rgb[0] + match),
    srgbToLinear(rgb[1] + match),
    srgbToLinear(rgb[2] + match),
  ];
}

function hexToLinearRgb(hex: number): [number, number, number] {
  return [
    srgbToLinear(((hex >> 16) & 0xff) / 255),
    srgbToLinear(((hex >> 8) & 0xff) / 255),
    srgbToLinear((hex & 0xff) / 255),
  ];
}

function srgbToLinear(value: number): number {
  const c = Math.min(1, Math.max(0, value));
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
