/**
 * Where plants actually end up.
 *
 * The failure this exists to catch is the field swimming: plants rehashing to
 * new cells as the camera moves, so the whole ground crawls. It is invisible
 * in a still frame and obvious the moment anything moves, which makes it
 * exactly the kind of thing to assert rather than to look for.
 *
 * As with the terrain, these compose the real scene graph and ask where things
 * landed — three terrain bugs got past tests that only examined pieces.
 */
import { describe, expect, it } from 'vitest';
import { InstancedMesh, Matrix4, Vector3 } from 'three/webgpu';
import { TERRIN } from '../src/bodies/system.js';
import { createPlanetView, updatePlanetRotation } from '../src/render/planet.js';
import { Vec3 } from '../src/sim/vec3.js';
import { directionToFace } from '../src/terrain/cubeSphere.js';
import type { FaceIndex } from '../src/terrain/cubeSphere.js';
import { elevationAt } from '../src/terrain/height.js';
import { SPECIES, onSpeciesGrid } from '../src/vegetation/species.js';
import {
  cellCoordinate,
  cellIndex,
  cellsPerFace,
  plantsInBlock,
  warmthAt,
} from '../src/vegetation/placement.js';

const PER_FACE = cellsPerFace(TERRIN.radius, 1);

/** A planet with its flora built around the launch site. */
function planetWithFlora(camera: Vec3) {
  const view = createPlanetView(TERRIN);
  const vegetation = view.vegetation;
  if (!vegetation) throw new Error('Terrin should have vegetation');

  vegetation.update(camera);
  for (let i = 0; i < 4_000 && vegetation.pending > 0; i++) vegetation.step();

  return { view, vegetation };
}

/** Every instance position in world space, as the renderer would draw them. */
function instancePositions(view: ReturnType<typeof planetWithFlora>['view']): Vector3[] {
  view.group.updateMatrixWorld(true);

  const positions: Vector3[] = [];
  const matrix = new Matrix4();

  view.vegetation!.group.traverse((object) => {
    if (!(object instanceof InstancedMesh)) return;

    for (let i = 0; i < object.count; i++) {
      object.getMatrixAt(i, matrix);
      const position = new Vector3().setFromMatrixPosition(matrix);
      positions.push(position.applyMatrix4(object.matrixWorld));
    }
  });

  return positions;
}

describe('cell addressing', () => {
  it('round-trips a coordinate through its cell', () => {
    for (const index of [0, 1, 500, PER_FACE - 1]) {
      expect(cellIndex(cellCoordinate(index, PER_FACE), PER_FACE)).toBe(index);
    }
  });

  it('spaces cells about a metre apart on the ground', () => {
    // The spacing the profile asks for, give or take the tangent warp.
    const arc = ((Math.PI / 2) * TERRIN.radius) / PER_FACE;
    expect(arc).toBeGreaterThan(0.5);
    expect(arc).toBeLessThan(2);
  });
});

describe('placement stability', () => {
  it('answers identically however many times it is asked', () => {
    const site = directionOfLaunchSite();

    const first = plantsInBlock(site.face, site.x, site.y, 16, PER_FACE, TERRIN.radius);
    const second = plantsInBlock(site.face, site.x, site.y, 16, PER_FACE, TERRIN.radius);

    expect(first.length).toBeGreaterThan(20);
    expect(second.length).toBe(first.length);

    for (let i = 0; i < first.length; i++) {
      expect(second[i]!.species.id).toBe(first[i]!.species.id);
      expect(second[i]!.position.distanceTo(first[i]!.position)).toBe(0);
      expect(second[i]!.traits.height).toBe(first[i]!.traits.height);
    }
  });

  it('places a cell the same way wherever the block around it starts', () => {
    // A block is only a unit of work; a plant must not depend on which one it
    // happened to be built in, or the field changes at every patch boundary.
    const site = directionOfLaunchSite();

    const wide = plantsInBlock(site.face, site.x, site.y, 24, PER_FACE, TERRIN.radius);
    const offset = plantsInBlock(site.face, site.x + 8, site.y, 16, PER_FACE, TERRIN.radius);

    const index = new Map(
      wide.map((plant) => [plant.position.toArray().map((v) => v.toFixed(3)).join(','), plant]),
    );

    let shared = 0;
    for (const plant of offset) {
      const match = index.get(plant.position.toArray().map((v) => v.toFixed(3)).join(','));
      if (!match) continue;

      shared++;
      expect(match.species.id).toBe(plant.species.id);
      expect(match.traits.height).toBe(plant.traits.height);
    }

    expect(shared).toBeGreaterThan(20);
  });

  it('does not move a plant when the camera does', () => {
    // The whole reason cells are addressed in face coordinates rather than in
    // a frame built from the viewer. A camera-relative grid rehashes every
    // plant as it moves and the ground crawls underfoot.
    const site = TERRIN.launchSite.normalized();

    const near = planetWithFlora(site.scale(TERRIN.radius + 3));
    const far = planetWithFlora(site.scale(TERRIN.radius + 60));

    const a = instancePositions(near.view);
    const b = instancePositions(far.view);

    expect(a.length).toBeGreaterThan(500);

    // Every plant in the closer view must appear, untouched, in the wider one.
    const index = new Map(b.map((p) => [key(p), p]));
    let matched = 0;

    for (const position of a) {
      const found = index.get(key(position));
      if (found) {
        expect(found.distanceTo(position)).toBeLessThan(0.01);
        matched++;
      }
    }

    expect(matched / a.length).toBeGreaterThan(0.9);
  });

  it('grows different fields on different faces', () => {
    // Without salting the hash by face, all six grow identical fields — six
    // identical continents.
    //
    // Compared at the same cell coordinates on each face, so any difference is
    // the salt rather than the terrain. Searched for rather than assumed,
    // because most cells are ocean or bare rock and an unlucky pair would
    // compare two empty lists and pass for the wrong reason.
    const summarise = (face: FaceIndex, x: number, y: number): string =>
      plantsInBlock(face, x, y, 12, PER_FACE, TERRIN.radius)
        .map((p) => `${p.species.id}/${p.traits.height.toFixed(2)}`)
        .join('|');

    let compared = 0;

    // Sweep the face rather than naming a coordinate: most of the planet is
    // ocean or bare rock, and a guessed pair compares two empty lists and
    // passes for entirely the wrong reason.
    for (let i = 1; i < 10 && compared < 3; i++) {
      for (let j = 1; j < 10 && compared < 3; j++) {
        const x = Math.floor((PER_FACE * i) / 10);
        const y = Math.floor((PER_FACE * j) / 10);

        const a = summarise(0, x, y);
        const b = summarise(3, x, y);
        if (a === '' || b === '') continue;

        expect(a).not.toBe(b);
        compared++;
      }
    }

    expect(compared, 'found no populated cells to compare').toBeGreaterThan(0);
  });
});

describe('plants on the ground', () => {
  const site = TERRIN.launchSite.normalized();
  const { view, vegetation } = planetWithFlora(site.scale(TERRIN.radius + 3));

  it('builds a field around the camera', () => {
    expect(vegetation.patchCount).toBeGreaterThan(4);
    expect(vegetation.plantCount).toBeGreaterThan(1_000);
  });

  it('stands every plant on the terrain surface', () => {
    updatePlanetRotation(view, TERRIN, 0);

    for (const position of instancePositions(view).slice(0, 400)) {
      const direction = new Vec3(position.x, position.y, position.z).normalized();
      const ground = TERRIN.radius + Math.max(0, elevationAt(direction, TERRIN.terrain!));

      // On the ground, not floating above it or buried under it.
      expect(Math.abs(position.length() - ground)).toBeLessThan(2);
    }
  });

  it('turns the field with the planet', () => {
    // Flora is in world axes like the terrain, so it needs the same rotation.
    const time = TERRIN.rotationPeriod / 4;

    updatePlanetRotation(view, TERRIN, 0);
    const before = instancePositions(view)[0]!.clone();

    updatePlanetRotation(view, TERRIN, time);
    const after = instancePositions(view)[0]!.clone();

    // It moved, and it moved by the planet's own rotation.
    expect(after.distanceTo(before)).toBeGreaterThan(1_000);
    expect(after.length()).toBeCloseTo(before.length(), 0);
  });

  it('draws nothing from orbit', () => {
    const { vegetation: orbital } = planetWithFlora(site.scale(TERRIN.radius + 80_000));
    expect(orbital.plantCount).toBe(0);
  });
});

describe('biomes', () => {
  it('cools towards the poles', () => {
    const equator = warmthAt(new Vec3(1, 0, 0), 0);
    const pole = warmthAt(new Vec3(0, 0, 1), 0);

    expect(equator).toBeGreaterThan(pole);
  });

  it('cools with altitude', () => {
    const low = warmthAt(new Vec3(1, 0, 0), 0);
    const high = warmthAt(new Vec3(1, 0, 0), 3_000);

    expect(high).toBeLessThan(low);
  });

  it('breaks the latitude bands up rather than leaving perfect rings', () => {
    // Warmth by latitude alone puts identical vegetation right around the
    // planet at every latitude, which reads as stripes from orbit.
    const values: number[] = [];
    for (let i = 0; i < 60; i++) {
      const angle = (i / 60) * Math.PI * 2;
      values.push(warmthAt(new Vec3(Math.cos(angle), Math.sin(angle), 0.2), 0));
    }

    const spread = Math.max(...values) - Math.min(...values);
    expect(spread).toBeGreaterThan(0.1);
  });

  it('stays within range everywhere', () => {
    for (let i = 0; i < 500; i++) {
      const direction = new Vec3(
        Math.sin(i * 1.1),
        Math.cos(i * 0.7),
        Math.sin(i * 0.3),
      ).normalized();

      const warmth = warmthAt(direction, (i % 40) * 100);
      expect(warmth).toBeGreaterThanOrEqual(0);
      expect(warmth).toBeLessThanOrEqual(1);
    }
  });
});

/** Cell coordinates of the launch site. */
function directionOfLaunchSite(): { face: 0 | 1 | 2 | 3 | 4 | 5; x: number; y: number } {
  const site = TERRIN.launchSite.normalized();

  const mapped = directionToFace(site);

  return {
    face: mapped.face,
    x: cellIndex(mapped.u, PER_FACE),
    y: cellIndex(mapped.v, PER_FACE),
  };
}

/** Quantised position key, for matching the same plant between two views. */
function key(position: Vector3): string {
  return [position.x, position.y, position.z].map((v) => v.toFixed(2)).join(',');
}

describe('the placement walk and the grid test agree', () => {
  it('finds every plant the per-cell rule would place', () => {
    // The walk enumerates each species' grid directly rather than testing
    // every cell against it, so the two calculations have to land on exactly
    // the same cells. A walk offset by one finds nothing of that species at
    // all, and an earlier fixed-stride version quietly lost three quarters of
    // the field this way.
    const site = directionOfLaunchSite();
    const size = 48;

    const walked = plantsInBlock(site.face, site.x, site.y, size, PER_FACE, TERRIN.radius);

    // Independently: every cell in the block whose species grid includes it.
    let expected = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const onAnyGrid = SPECIES.some((species) =>
          onSpeciesGrid(species, site.x + x, site.y + y, 1),
        );
        if (onAnyGrid) expected++;
      }
    }

    // Not every candidate cell grows something, but the walk must have had the
    // chance to consider each one.
    expect(expected).toBeGreaterThan(walked.length);
    expect(walked.length).toBeGreaterThan(expected * 0.3);
  });

  it('places the large species a walk for trees alone would find', () => {
    // A distant patch asks only for plants above a height, and skips the grids
    // of everything smaller. It must still find every tree.
    const site = directionOfLaunchSite();

    const everything = plantsInBlock(
      site.face, site.x, site.y, 64, PER_FACE, TERRIN.radius, undefined, undefined, 0,
    ).filter((plant) => plant.traits.height >= 4);

    const treesOnly = plantsInBlock(
      site.face, site.x, site.y, 64, PER_FACE, TERRIN.radius, undefined, undefined, 4,
    );

    expect(treesOnly.length).toBe(everything.length);
  });
});

describe('what it costs to draw', () => {
  /** Triangles and draw calls for the field around the launchpad. */
  function budgetAtPad(): { plants: number; draws: number; triangles: number } {
    const { view } = planetWithFlora(TERRIN.launchSite.normalized().scale(TERRIN.radius + 3));

    let draws = 0;
    let triangles = 0;

    view.vegetation!.group.traverse((object) => {
      if (!(object instanceof InstancedMesh)) return;
      draws++;
      triangles += ((object.geometry.getIndex()?.count ?? 0) / 3) * object.count;
    });

    return { plants: view.vegetation!.plantCount, draws, triangles };
  }

  it('stays inside a drawable budget', () => {
    // These numbers regressed silently once: a plant in every cell put 89,371
    // of them around the pad, 16.4 million triangles and 6,564 draw calls, and
    // nothing in the model objected.
    //
    // The ceilings are generous against today's figures — roughly 23,000
    // plants, 3.3 million triangles and 950 draws across a 700 m radius —
    // because they exist to catch an order-of-magnitude mistake, not to pin
    // the current tuning. Anything approaching them is the same class of bug.
    const { plants, draws, triangles } = budgetAtPad();

    expect(plants, 'plants').toBeLessThan(45_000);
    expect(draws, 'draw calls').toBeLessThan(2_000);
    expect(triangles, 'triangles').toBeLessThan(7_000_000);
  });

  it('keeps every distance band contributing', () => {
    // A patch must be several times narrower than the band it sits in, or none
    // fits and the band draws nothing. The outermost band did exactly that —
    // 512 m patches in a 380 m annulus — and the symptom was the draw distance
    // appearing to have no effect at all.
    const site = TERRIN.launchSite.normalized();
    const { view } = planetWithFlora(site.scale(TERRIN.radius + 3));

    const bands = new Set<string>();
    for (const child of view.vegetation!.group.children) {
      const match = /^flora:\d+\/(\d+)\//.exec(child.name);
      if (match) bands.add(match[1]!);
    }

    expect(bands.size, 'distance bands with patches in them').toBeGreaterThanOrEqual(4);
  });

  it('still draws enough to look like a field', () => {
    // The complement: a budget is only interesting if the ground is covered.
    const { plants, triangles } = budgetAtPad();

    expect(plants).toBeGreaterThan(1_500);
    expect(triangles).toBeGreaterThan(50_000);
  });

  it('spaces each species at its own scale', () => {
    // Ground cover a metre or two apart; trees tens of metres apart. One
    // spacing for everything is what made the first version a wall of canopy.
    const site = directionOfLaunchSite();
    const plants = plantsInBlock(site.face, site.x, site.y, 32, PER_FACE, TERRIN.radius);

    const counts = new Map<string, number>();
    for (const plant of plants) {
      counts.set(plant.species.id, (counts.get(plant.species.id) ?? 0) + 1);
    }

    const area = 32 * 32;
    const spacingOf = (id: string): number => area / (counts.get(id) ?? 0.5);

    // Grass dense, trees sparse, and a clear order of magnitude between them.
    expect(spacingOf('grass')).toBeLessThan(5);
    expect(spacingOf('shrub')).toBeGreaterThan(spacingOf('grass') * 4);
  });
});
