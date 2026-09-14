/**
 * Keeps the set of drawn terrain chunks in step with where the camera is.
 *
 * Chunk meshes are built on demand and cached by key, because building one
 * costs a few hundred height-field evaluations and the set changes only when
 * the camera moves far enough to cross a subdivision threshold. Generation is
 * spent against a frame budget for the same reason the cloud noise is: a
 * descent from orbit to the pad crosses a dozen levels, and building them all
 * in the frame the threshold is crossed is a visible stall.
 *
 * Until a chunk's replacement is ready the old one keeps drawing. Dropping it
 * the moment it stops being selected would open a hole in the planet for
 * however many frames the finer chunks take to arrive.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
} from 'three/webgpu';
import { Vec3 } from '../../sim/vec3.js';
import { buildChunkGeometry } from '../../terrain/chunkMesh.js';
import type { TerrainProfile } from '../../terrain/height.js';
import { DEFAULT_TERRAIN } from '../../terrain/height.js';
import type { Chunk } from '../../terrain/quadtree.js';
import { chunkKey, selectChunks } from '../../terrain/quadtree.js';

/**
 * Milliseconds of chunk building per frame.
 *
 * The visible set costs about a second and a half to build outright, so this
 * spreads it over roughly three seconds of play rather than dropping a frame.
 */
const BUDGET_MS = 8;

/** Cap on chunks kept in memory; the furthest are evicted first. */
const CACHE_LIMIT = 1_200;

/**
 * How far the camera must move before chunks are reselected, as a fraction of
 * its altitude. Reselecting every frame is wasted work: the answer only
 * changes when a subdivision threshold is crossed.
 */
const RESELECT_FRACTION = 0.02;

interface CachedChunk {
  readonly mesh: Mesh;
  /** Frame index when this was last selected, for eviction. */
  lastUsed: number;
}

export class TerrainView {
  readonly group = new Group();

  private readonly cache = new Map<string, CachedChunk>();
  private readonly queue: Chunk[] = [];
  private readonly material: MeshStandardMaterial;

  private lastCamera: Vec3 | null = null;
  private frame = 0;

  constructor(
    private readonly planetRadius: number,
    private readonly profile: TerrainProfile = DEFAULT_TERRAIN,
  ) {
    this.group.name = 'terrain';

    // Ground colour is baked per vertex during generation, so the material
    // only has to light it.
    this.material = new MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0,
    });
  }

  /**
   * Reselect chunks for a camera position, given in the planet's own frame.
   * Cheap to call every frame; it does nothing until the camera has moved.
   */
  update(camera: Vec3): void {
    this.frame++;

    const altitude = Math.max(1, camera.length - this.planetRadius);
    if (
      this.lastCamera &&
      this.lastCamera.distanceTo(camera) < altitude * RESELECT_FRACTION
    ) {
      return;
    }
    this.lastCamera = camera;

    const wanted = selectChunks({ planetRadius: this.planetRadius, camera });
    const wantedKeys = new Set<string>();

    this.queue.length = 0;

    for (const chunk of wanted) {
      const key = chunkKey(chunk);
      wantedKeys.add(key);

      const cached = this.cache.get(key);
      if (cached) {
        cached.lastUsed = this.frame;
        cached.mesh.visible = true;
      } else {
        this.queue.push(chunk);
      }
    }

    // Hide what is no longer wanted rather than deleting it: the camera
    // usually comes back, and rebuilding is far dearer than keeping.
    for (const [key, cached] of this.cache) {
      if (!wantedKeys.has(key)) cached.mesh.visible = false;
    }

    // Build the coarsest first, so something covers the ground immediately and
    // detail fills in, rather than the reverse.
    this.queue.sort((a, b) => a.depth - b.depth);

    this.evict();
  }

  /** Build queued chunks for up to the frame budget. */
  step(): void {
    if (this.queue.length === 0) return;

    const deadline = performance.now() + BUDGET_MS;

    while (this.queue.length > 0 && performance.now() < deadline) {
      const chunk = this.queue.shift()!;
      const key = chunkKey(chunk);
      if (this.cache.has(key)) continue;

      const mesh = this.buildMesh(chunk);
      this.cache.set(key, { mesh, lastUsed: this.frame });
      this.group.add(mesh);
    }
  }

  /** Chunks still waiting to be built. */
  get pending(): number {
    return this.queue.length;
  }

  get chunkCount(): number {
    return this.cache.size;
  }

  private buildMesh(chunk: Chunk): Mesh {
    const data = buildChunkGeometry(chunk, this.planetRadius, this.profile);

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(data.normals, 3));
    geometry.setAttribute('color', new BufferAttribute(data.colors, 3));
    geometry.setIndex(new BufferAttribute(data.indices, 1));

    const mesh = new Mesh(geometry, this.material);

    // The chunk's own centre carries the planet-scale magnitude. Three
    // composes the model-view matrix in double precision before handing it to
    // the GPU, so the large offset cancels against the camera's before it ever
    // reaches a 32-bit float.
    mesh.position.set(data.centre.x, data.centre.y, data.centre.z);
    mesh.name = `chunk:${chunkKey(chunk)}`;

    // Chunks are placed by the quadtree and never leave their own area, so the
    // bounding sphere can be set directly instead of computed.
    geometry.boundingSphere = null;
    geometry.computeBoundingSphere();

    return mesh;
  }

  /** Drop the least recently used chunks once the cache grows too large. */
  private evict(): void {
    if (this.cache.size <= CACHE_LIMIT) return;

    const entries = [...this.cache.entries()].sort(
      (a, b) => a[1].lastUsed - b[1].lastUsed,
    );

    for (const [key, cached] of entries) {
      if (this.cache.size <= CACHE_LIMIT) break;
      if (cached.mesh.visible) continue;

      this.group.remove(cached.mesh);
      cached.mesh.geometry.dispose();
      this.cache.delete(key);
    }
  }

  dispose(): void {
    for (const cached of this.cache.values()) cached.mesh.geometry.dispose();
    this.cache.clear();
    this.material.dispose();
  }
}
