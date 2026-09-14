/**
 * Where terrain chunks actually end up in the scene.
 *
 * Every other terrain test checks the geometry in isolation — the right
 * vertices, the right normals, the right winding — and all of them passed
 * while the landscape sat ninety degrees away from the planet it belonged to.
 * The scene graph is where that kind of mistake lives, so it is checked here
 * by composing the real world matrices and asking where a chunk landed.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three/webgpu';
import { TERRIN } from '../src/bodies/system.js';
import { createPlanetView, updatePlanetRotation } from '../src/render/planet.js';
import { Vec3 } from '../src/sim/vec3.js';

/** Build a planet with its terrain generated around the launch site. */
function planetWithTerrain() {
  const view = createPlanetView(TERRIN);
  const terrain = view.terrain;
  if (!terrain) throw new Error('Terrin should have terrain');

  const site = TERRIN.launchSite.normalized();
  terrain.update(site.scale(TERRIN.radius + 200));

  // Drain the build queue; the budget is a per-frame limit, not a cap.
  for (let i = 0; i < 2_000 && terrain.pending > 0; i++) terrain.step();

  return { view, terrain, site };
}

/** Direction of the nearest chunk to a given one, in world space. */
function nearestChunkDirection(
  terrain: ReturnType<typeof planetWithTerrain>['terrain'],
  target: Vec3,
): { direction: Vector3; angle: number } {
  const wanted = new Vector3(target.x, target.y, target.z).normalize();

  let angle = Infinity;
  let direction = new Vector3();

  terrain.group.traverse((object) => {
    const position = new Vector3().setFromMatrixPosition(object.matrixWorld);
    if (position.length() < 1) return;

    const candidate = position.clone().normalize();
    const separation = candidate.angleTo(wanted);
    if (separation < angle) {
      angle = separation;
      direction = candidate;
    }
  });

  return { direction, angle };
}

/** Where a body-fixed direction points once the planet has turned. */
function rotated(direction: Vec3, time: number): Vec3 {
  const angle = (2 * Math.PI * time) / TERRIN.rotationPeriod;
  return new Vec3(
    direction.x * Math.cos(angle) - direction.y * Math.sin(angle),
    direction.x * Math.sin(angle) + direction.y * Math.cos(angle),
    direction.z,
  );
}

describe('terrain placement in the scene', () => {
  const { view, terrain, site } = planetWithTerrain();

  it('builds chunks around the camera', () => {
    expect(terrain.chunkCount).toBeGreaterThan(100);
    expect(terrain.pending).toBe(0);
  });

  it('puts the finest terrain under the launch site', () => {
    updatePlanetRotation(view, TERRIN, 0);
    view.group.updateMatrixWorld(true);

    // Parented to the spin frame — which exists only to tilt a sphere's poles
    // onto the simulation's axis — this came out ninety degrees away.
    const { angle } = nearestChunkDirection(terrain, site);
    expect(angle * (180 / Math.PI)).toBeLessThan(1);
  });

  it('turns the landscape with the planet', () => {
    // The terrain is in world axes and the placeholder sphere is inside a
    // tilted frame, so the two need different rotations for the same spin. If
    // the terrain does not turn, the ground slides out from under the pad.
    const time = TERRIN.rotationPeriod / 4;

    updatePlanetRotation(view, TERRIN, time);
    view.group.updateMatrixWorld(true);

    const { angle } = nearestChunkDirection(terrain, rotated(site, time));
    expect(angle * (180 / Math.PI)).toBeLessThan(1);
  });

  it('keeps chunks on the planet’s surface', () => {
    updatePlanetRotation(view, TERRIN, 0);
    view.group.updateMatrixWorld(true);

    let checked = 0;
    terrain.group.traverse((object) => {
      const position = new Vector3().setFromMatrixPosition(object.matrixWorld);
      if (position.length() < 1) return;

      checked++;
      // Sea level at worst, and never above the tallest ground the field makes.
      expect(position.length()).toBeGreaterThan(TERRIN.radius - 1);
      expect(position.length()).toBeLessThan(TERRIN.radius + 12_000);
    });

    expect(checked).toBeGreaterThan(100);
  });
});
