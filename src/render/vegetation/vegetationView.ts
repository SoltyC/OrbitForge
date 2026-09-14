/**
 * Draws the flora as instanced geometry.
 *
 * One instanced draw per species per patch, which is what makes a few hundred
 * thousand plants affordable: the geometry is uploaded once and the GPU is
 * handed a matrix per individual.
 *
 * The catch is that instancing draws the *same* mesh every time, and the whole
 * point of the species model is that no two plants are alike. So each species
 * keeps a handful of pre-grown variants — different heights, spreads, branch
 * counts and greens — and an individual is assigned one by its hash. Variants
 * give the shape variety; the per-instance matrix gives scale, facing and
 * lean on top. Eight variants of eight species is enough that the eye stops
 * finding the pattern.
 *
 * Patches are squares of cube-sphere cells, not of camera-relative ground, for
 * the reason set out in vegetation/placement.ts: a frame built from the viewer
 * drifts, and the field swims.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import { Vec3 } from '../../sim/vec3.js';
import { directionToFace } from '../../terrain/cubeSphere.js';
import type { FaceIndex } from '../../terrain/cubeSphere.js';
import type { TerrainProfile } from '../../terrain/height.js';
import { DEFAULT_TERRAIN } from '../../terrain/height.js';
import { buildPlant, drawTraits } from '../../vegetation/plantGeometry.js';
import type { PlantMesh } from '../../vegetation/plantGeometry.js';
import { cellIndex, cellsPerFace, plantsInBlock } from '../../vegetation/placement.js';
import { DEFAULT_VEGETATION, hashUnit } from '../../vegetation/scatter.js';
import type { VegetationProfile } from '../../vegetation/scatter.js';
import { SPECIES } from '../../vegetation/species.js';
import type { Species, SpeciesId } from '../../vegetation/species.js';

/**
 * Cells along one side of a patch.
 *
 * Larger patches amortise the shared border of height samples over more cells:
 * at 24 a patch costs 1.8 ms for 394 plants, at 32 it is 2.4 ms for 751. The
 * ceiling is responsiveness — a patch is the unit of work, so an oversized one
 * cannot be interrupted partway through a frame.
 */
const PATCH_CELLS = 32;

/**
 * How far plants are drawn (m).
 *
 * Measured, not chosen. Before the height samples were shared across a patch,
 * a 420 m radius wanted 1369 patches at 14 ms each — some nineteen seconds
 * before the field appeared. At 150 m it is 121 patches of 2.4 ms, about a
 * third of a second, and individual plants have stopped being resolvable well
 * before that distance anyway: past it the terrain's own slope-and-altitude
 * colouring is a better and far cheaper representation than geometry.
 */
const DRAW_DISTANCE = 150;

/** Above this altitude nothing is drawn (m). */
const MAX_ALTITUDE = 900;

/** Pre-grown shapes per species. */
const VARIANTS = 8;

/** Milliseconds of patch building per frame. */
const BUDGET_MS = 4;

/** Patches kept before the least recently seen are dropped. */
const CACHE_LIMIT = 96;

interface Variant {
  readonly geometry: BufferGeometry;
  /** Height the variant was grown at, so instances can scale relative to it. */
  readonly height: number;
}

interface Patch {
  readonly group: Group;
  lastUsed: number;
}

interface QueuedPatch {
  readonly face: FaceIndex;
  readonly x: number;
  readonly y: number;
}

export class VegetationView {
  readonly group = new Group();

  private readonly variants = new Map<SpeciesId, Variant[]>();
  private readonly materials = new Map<SpeciesId, MeshStandardMaterial>();
  private readonly patches = new Map<string, Patch>();
  private readonly queue: QueuedPatch[] = [];

  private readonly perFace: number;
  private frame = 0;
  private lastCamera: Vec3 | null = null;

  constructor(
    private readonly planetRadius: number,
    private readonly terrain: TerrainProfile = DEFAULT_TERRAIN,
    private readonly profile: VegetationProfile = DEFAULT_VEGETATION,
  ) {
    this.group.name = 'vegetation';
    this.perFace = cellsPerFace(planetRadius, profile.cellSize);

    for (const species of SPECIES) {
      this.variants.set(species.id, growVariants(species));

      // Colour rides on the vertices, so one material serves every variant.
      this.materials.set(
        species.id,
        new MeshStandardMaterial({
          vertexColors: true,
          roughness: species.form === 'rock' ? 0.85 : 1,
          metalness: 0,
          // Foliage is thin; lighting it from both faces stops leaves going
          // black wherever a quad happens to face away from the sun.
          flatShading: false,
        }),
      );
    }
  }

  /** Reselect patches for a camera position in the planet's own frame. */
  update(camera: Vec3): void {
    this.frame++;

    if (camera.length - this.planetRadius > MAX_ALTITUDE) {
      this.hideAll();
      return;
    }

    // The answer only changes once the camera crosses a patch boundary.
    const patchSize = PATCH_CELLS * this.profile.cellSize;
    if (this.lastCamera && this.lastCamera.distanceTo(camera) < patchSize * 0.2) {
      return;
    }
    this.lastCamera = camera;

    const here = directionToFace(camera);
    const centreX = Math.floor(cellIndex(here.u, this.perFace) / PATCH_CELLS);
    const centreY = Math.floor(cellIndex(here.v, this.perFace) / PATCH_CELLS);

    const reach = Math.ceil(DRAW_DISTANCE / patchSize);
    const wanted = new Set<string>();

    this.queue.length = 0;

    for (let y = -reach; y <= reach; y++) {
      for (let x = -reach; x <= reach; x++) {
        const key = `${here.face}/${centreX + x}/${centreY + y}`;
        wanted.add(key);

        const existing = this.patches.get(key);
        if (existing) {
          existing.lastUsed = this.frame;
          existing.group.visible = true;
        } else {
          this.queue.push({ face: here.face, x: centreX + x, y: centreY + y });
        }
      }
    }

    for (const [key, patch] of this.patches) {
      if (!wanted.has(key)) patch.group.visible = false;
    }

    // Nearest first, so the ground the camera is standing on fills in before
    // the distance does.
    this.queue.sort(
      (a, b) =>
        Math.hypot(a.x - centreX, a.y - centreY) - Math.hypot(b.x - centreX, b.y - centreY),
    );

    this.evict();
  }

  /** Build queued patches for up to the frame budget. */
  step(): void {
    if (this.queue.length === 0) return;

    const deadline = performance.now() + BUDGET_MS;

    while (this.queue.length > 0 && performance.now() < deadline) {
      const next = this.queue.shift()!;
      const key = `${next.face}/${next.x}/${next.y}`;
      if (this.patches.has(key)) continue;

      const group = this.buildPatch(next);
      this.patches.set(key, { group, lastUsed: this.frame });
      this.group.add(group);
    }
  }

  get patchCount(): number {
    return this.patches.size;
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Total plants currently instanced, for reporting. */
  get plantCount(): number {
    let total = 0;
    for (const patch of this.patches.values()) {
      patch.group.traverse((object) => {
        if (object instanceof InstancedMesh) total += object.count;
      });
    }
    return total;
  }

  /**
   * Walk a patch's cells, ask placement what grows in each, and pack the
   * results into one instanced draw per species variant.
   */
  private buildPatch(patch: QueuedPatch): Group {
    const group = new Group();
    group.name = `flora:${patch.face}/${patch.x}/${patch.y}`;

    // Keyed by species and variant, since each variant is its own geometry.
    const batches = new Map<string, { species: Species; variant: number; matrices: Matrix4[] }>();

    const baseX = patch.x * PATCH_CELLS;
    const baseY = patch.y * PATCH_CELLS;

    // One pass over the whole patch, sharing its height-field samples.
    const plants = plantsInBlock(
      patch.face,
      baseX,
      baseY,
      PATCH_CELLS,
      this.perFace,
      this.planetRadius,
      this.terrain,
      this.profile,
    );

    plants.forEach((plant, index) => {
      {
        const variant = Math.floor(
          hashUnit(baseX + index, baseY + index * 7, this.profile.seed + 601) * VARIANTS,
        );

        const key = `${plant.species.id}/${variant}`;
        let batch = batches.get(key);
        if (!batch) {
          batch = { species: plant.species, variant, matrices: [] };
          batches.set(key, batch);
        }

        const grown = this.variants.get(plant.species.id)![variant]!;

        batch.matrices.push(
          standingMatrix(
            plant.position,
            plant.up,
            plant.traits.height / grown.height,
            plant.traits.rotation,
            plant.traits.lean,
            plant.traits.leanDirection,
          ),
        );
      }
    });

    for (const batch of batches.values()) {
      const variant = this.variants.get(batch.species.id)![batch.variant]!;

      const mesh = new InstancedMesh(
        variant.geometry,
        this.materials.get(batch.species.id)!,
        batch.matrices.length,
      );

      for (let i = 0; i < batch.matrices.length; i++) {
        mesh.setMatrixAt(i, batch.matrices[i]!);
      }
      mesh.instanceMatrix.needsUpdate = true;

      // A patch spans hundreds of metres and the instances are placed by the
      // quadtree's own coordinates; culling per instance would cost more than
      // it saves at this count.
      mesh.frustumCulled = false;

      group.add(mesh);
    }

    return group;
  }

  private hideAll(): void {
    for (const patch of this.patches.values()) patch.group.visible = false;
  }

  private evict(): void {
    if (this.patches.size <= CACHE_LIMIT) return;

    const entries = [...this.patches.entries()].sort(
      (a, b) => a[1].lastUsed - b[1].lastUsed,
    );

    for (const [key, patch] of entries) {
      if (this.patches.size <= CACHE_LIMIT) break;
      if (patch.group.visible) continue;

      this.group.remove(patch.group);
      disposeGroup(patch.group);
      this.patches.delete(key);
    }
  }

  dispose(): void {
    for (const patch of this.patches.values()) disposeGroup(patch.group);
    this.patches.clear();

    for (const variants of this.variants.values()) {
      for (const variant of variants) variant.geometry.dispose();
    }
    for (const material of this.materials.values()) material.dispose();
  }
}

/**
 * Pre-grow a species' variants.
 *
 * Each is a different individual, not the same one at a different size — the
 * branch count and spread differ too, so the silhouettes differ rather than
 * just the scales.
 */
function growVariants(species: Species): Variant[] {
  const variants: Variant[] = [];

  for (let i = 0; i < VARIANTS; i++) {
    const rolls: number[] = [];
    for (let r = 0; r < 9; r++) rolls.push(hashUnit(i, r, 7_717));

    const traits = drawTraits(species, rolls);
    variants.push({
      geometry: toGeometry(buildPlant(species, traits)),
      height: traits.height,
    });
  }

  return variants;
}

function toGeometry(mesh: PlantMesh): BufferGeometry {
  const geometry = new BufferGeometry();

  geometry.setAttribute('position', new BufferAttribute(new Float32Array(mesh.positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(mesh.normals), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(mesh.colors), 3));

  // Carried for the wind shader to read; harmless until then.
  geometry.setAttribute('sway', new BufferAttribute(new Float32Array(mesh.sway), 1));

  geometry.setIndex(new BufferAttribute(new Uint16Array(mesh.indices), 1));
  geometry.computeBoundingSphere();

  return geometry;
}

const scratchQuaternion = new Quaternion();
const scratchTilt = new Quaternion();
const scratchPosition = new Vector3();
const scratchScale = new Vector3();
const scratchUp = new Vector3();
const scratchAxis = new Vector3();
const MODEL_UP = new Vector3(0, 1, 0);

/**
 * Place one plant: standing on the surface, spun about its own axis, leaning a
 * little, and scaled to the height its traits called for.
 *
 * Plant geometry is grown with its base at the origin and +Y up, so the
 * position is the point on the ground rather than the plant's centre.
 */
function standingMatrix(
  position: Vec3,
  up: Vec3,
  scale: number,
  rotation: number,
  lean: number,
  leanDirection: number,
): Matrix4 {
  scratchUp.set(up.x, up.y, up.z).normalize();

  // Stand the model's +Y along the surface normal, then spin it.
  scratchQuaternion.setFromUnitVectors(MODEL_UP, scratchUp);
  scratchTilt.setFromAxisAngle(MODEL_UP, rotation);
  scratchQuaternion.multiply(scratchTilt);

  // Lean about a horizontal axis, so the plant tips rather than twisting.
  scratchAxis
    .set(Math.cos(leanDirection), 0, Math.sin(leanDirection))
    .applyQuaternion(scratchQuaternion)
    .normalize();
  scratchTilt.setFromAxisAngle(scratchAxis, lean);
  scratchQuaternion.premultiply(scratchTilt);

  scratchPosition.set(position.x, position.y, position.z);
  scratchScale.setScalar(scale);

  return new Matrix4().compose(scratchPosition, scratchQuaternion, scratchScale);
}

function disposeGroup(group: Group): void {
  group.traverse((object) => {
    if (object instanceof InstancedMesh) object.dispose();
  });
}
