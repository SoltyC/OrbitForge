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
import type { PlantDetail, PlantMesh } from '../../vegetation/plantGeometry.js';
import { cellIndex, cellsPerFace, plantsInBlock } from '../../vegetation/placement.js';
import { DEFAULT_VEGETATION, hashUnit } from '../../vegetation/scatter.js';
import type { VegetationProfile } from '../../vegetation/scatter.js';
import { SPECIES } from '../../vegetation/species.js';
import type { Species, SpeciesId } from '../../vegetation/species.js';

/**
 * Cells along one side of a patch, in the nearest band.
 *
 * Larger patches amortise the shared border of height samples over more cells:
 * at 24 a patch costs 1.8 ms for 394 plants, at 32 it is 2.4 ms for 751. The
 * ceiling is responsiveness — a patch is the unit of work, so an oversized one
 * cannot be interrupted partway through a frame.
 *
 * Distant bands use multiples of this. Holding one size across a 900 m radius
 * needed 2,477 patches and 7,109 draw calls, almost all of them a handful of
 * trees apiece; doubling the patch with each band keeps the count flat as the
 * area grows, which is the whole point of the bands.
 */
const PATCH_CELLS = 32;

/**
 * How far plants are drawn (m).
 *
 * Trees have to carry much further than undergrowth. At 150 m the vegetation
 * stopped in a square underfoot while the terrain ran to the horizon, which
 * reads as a patch of forest sitting on a bare planet. Undergrowth still fades
 * out within tens of metres — see `drawDistanceFor` — so what reaches this far
 * is only the canopy, which is sparse and, at distance, cheap.
 */
const DRAW_DISTANCE = 700;

/** Above this altitude nothing is drawn (m). */
const MAX_ALTITUDE = 900;

/**
 * Pre-grown shapes per species.
 *
 * Four rather than eight: every variant is its own geometry and so its own
 * draw call per patch, and eight put nearly four thousand of them on screen.
 * The per-instance matrix still varies scale, facing and lean on top, so four
 * distinct silhouettes is enough that the eye does not find the repeat.
 */
const VARIANTS = 4;

/**
 * Variants actually used at a detail level.
 *
 * Every variant is its own geometry and so its own draw call per patch. Close
 * up the differences between four silhouettes are what stops the field reading
 * as tiling; at several hundred metres a tree is a few pixels of canopy and
 * two are indistinguishable from four, so the far bands halve their draws for
 * nothing anyone can see.
 */
function variantsForDetail(detail: PlantDetail): number {
  return detail === 0 ? VARIANTS : detail === 1 ? 3 : 2;
}

/**
 * Metres of draw distance a plant earns per metre of its own height.
 *
 * Undergrowth is the whole cost: grass sits a metre apart, so a wide radius
 * holds tens of thousands of tufts for something indistinguishable from ground
 * colour past about forty metres. Tying the distance to the plant's own size
 * keeps the trees, which are visible from far off and sparse enough to be
 * cheap, and drops the rest as it stops mattering.
 */
const DISTANCE_PER_METRE = 46;

/** Baseline distance every plant is drawn to, however small (m). */
const MINIMUM_DISTANCE = 12;

/** The smallest plant still worth drawing at a given distance (m). */
function minimumHeightAt(distance: number): number {
  return Math.max(0, (distance - MINIMUM_DISTANCE) / DISTANCE_PER_METRE);
}

/**
 * Near edges of the distance bands a patch can be built for (m).
 *
 * A patch takes the largest band at or below its own distance, and then keeps
 * only plants still worth drawing that far out. Caching by band means walking
 * towards a patch rebuilds it with its undergrowth rather than leaving bare
 * ground, and walking away drops it again.
 */
const BANDS: readonly number[] = [0, 45, 110, 260, 520];

/**
 * Cells along a patch in a given band.
 *
 * Doubling with each band keeps the patch count flat as the area grows, but
 * only up to a point: a patch must be several times narrower than the band it
 * sits in, or none fits and the band silently draws nothing. That happened —
 * the outermost band used 512 m patches inside a 380 m annulus and contributed
 * not one plant, which looked exactly like the draw distance being ignored.
 */
function patchCellsForBand(bandIndex: number): number {
  return PATCH_CELLS * 2 ** Math.min(bandIndex, 2);
}

/**
 * How coarsely a band's plants are grown.
 *
 * Detail is shed with distance rather than plants being dropped: past a couple
 * of hundred metres a tree is a silhouette, and the branches inside it resolve
 * to less than a pixel.
 */
function detailForBand(band: number): PlantDetail {
  if (band < 110) return 0;
  if (band < 260) return 1;
  return 2;
}

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
  /** Near edge of the distance band this patch is being built for (m). */
  readonly band: number;
  readonly bandIndex: number;
}

export class VegetationView {
  readonly group = new Group();

  /** Variants per species, keyed by detail level. */
  private readonly variants = new Map<string, Variant[]>();
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
      for (const detail of [0, 1, 2] as PlantDetail[]) {
        this.variants.set(`${species.id}/${detail}`, growVariants(species, detail));
      }

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
    const nearestPatch = PATCH_CELLS * this.profile.cellSize;
    if (this.lastCamera && this.lastCamera.distanceTo(camera) < nearestPatch * 0.2) {
      return;
    }
    this.lastCamera = camera;

    const here = directionToFace(camera);
    const cameraCellX = cellIndex(here.u, this.perFace);
    const cameraCellY = cellIndex(here.v, this.perFace);

    const wanted = new Set<string>();
    this.queue.length = 0;

    // Each band is an annulus, walked at its own patch size.
    for (let bandIndex = 0; bandIndex < BANDS.length; bandIndex++) {
      const band = BANDS[bandIndex]!;
      const outer = BANDS[bandIndex + 1] ?? DRAW_DISTANCE;
      if (band >= DRAW_DISTANCE) break;

      const cells = patchCellsForBand(bandIndex);
      const size = cells * this.profile.cellSize;

      const centreX = Math.floor(cameraCellX / cells);
      const centreY = Math.floor(cameraCellY / cells);
      const reach = Math.ceil(outer / size);

      for (let y = -reach; y <= reach; y++) {
        for (let x = -reach; x <= reach; x++) {
          // Distance to the nearest point of this patch, so a patch straddling
          // a band edge is claimed by the nearer band and drawn only once.
          const distance =
            Math.hypot(Math.max(0, Math.abs(x) - 0.5), Math.max(0, Math.abs(y) - 0.5)) * size;

          if (distance < band || distance >= outer) continue;

          const key = `${here.face}/${bandIndex}/${centreX + x}/${centreY + y}`;
          wanted.add(key);

          const existing = this.patches.get(key);
          if (existing) {
            existing.lastUsed = this.frame;
            existing.group.visible = true;
          } else {
            this.queue.push({
              face: here.face,
              x: centreX + x,
              y: centreY + y,
              band,
              bandIndex,
            });
          }
        }
      }
    }

    for (const [key, patch] of this.patches) {
      if (!wanted.has(key)) patch.group.visible = false;
    }

    // Nearest bands first, so the ground underfoot fills in before the horizon.
    this.queue.sort((a, b) => a.bandIndex - b.bandIndex);

    this.evict();
  }

  /** Build queued patches for up to the frame budget. */
  step(): void {
    if (this.queue.length === 0) return;

    const deadline = performance.now() + BUDGET_MS;

    while (this.queue.length > 0 && performance.now() < deadline) {
      const next = this.queue.shift()!;
      const key = `${next.face}/${next.bandIndex}/${next.x}/${next.y}`;
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
    group.name = `flora:${patch.face}/${patch.bandIndex}/${patch.x}/${patch.y}`;

    // Keyed by species and variant, since each variant is its own geometry.
    const batches = new Map<string, { species: Species; variant: number; matrices: Matrix4[] }>();

    const cells = patchCellsForBand(patch.bandIndex);
    const baseX = patch.x * cells;
    const baseY = patch.y * cells;

    const detail = detailForBand(patch.band);

    // One pass over the whole patch, sharing its height-field samples.
    const plants = plantsInBlock(
      patch.face,
      baseX,
      baseY,
      cells,
      this.perFace,
      this.planetRadius,
      this.terrain,
      this.profile,
      minimumHeightAt(patch.band),
    );

    plants.forEach((plant, index) => {

      {
        const variant = Math.floor(
          hashUnit(baseX + index, baseY + index * 7, this.profile.seed + 601) *
            variantsForDetail(detail),
        );

        const key = `${plant.species.id}/${variant}`;
        let batch = batches.get(key);
        if (!batch) {
          batch = { species: plant.species, variant, matrices: [] };
          batches.set(key, batch);
        }

        const grown = this.variants.get(`${plant.species.id}/${detail}`)![variant]!;

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
      const variant = this.variants.get(`${batch.species.id}/${detail}`)![batch.variant]!;

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
function growVariants(species: Species, detail: PlantDetail): Variant[] {
  const variants: Variant[] = [];

  for (let i = 0; i < VARIANTS; i++) {
    const rolls: number[] = [];
    for (let r = 0; r < 9; r++) rolls.push(hashUnit(i, r, 7_717));

    const traits = drawTraits(species, rolls);
    variants.push({
      geometry: toGeometry(buildPlant(species, traits, detail)),
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
