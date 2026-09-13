/**
 * Planet rendering: a shaded sphere for the ground, plus a physically based
 * atmosphere shell for bodies that have air.
 *
 * The surface is still placeholder geometry — real quadtree terrain arrives in
 * milestone 7 — but the sky around it is the real scattering model.
 */
import { Mesh, MeshStandardMaterial, SphereGeometry, Group } from 'three/webgpu';
import { createAtmosphereModel } from '../atmosphere/model.js';
import type { Body } from '../bodies/types.js';
import { createSkyView } from './atmosphere/skyMaterial.js';
import type { SkyView } from './atmosphere/skyMaterial.js';

/** Latitude/longitude segments on the placeholder sphere. */
const SPHERE_SEGMENTS = 128;

export interface PlanetView {
  readonly group: Group;
  readonly surface: Mesh;
  /** Present only for bodies with an atmosphere. */
  readonly sky: SkyView | null;
}

export function createPlanetView(body: Body): PlanetView {
  const group = new Group();
  group.name = `planet:${body.id}`;

  // Three's SphereGeometry puts its poles on +/-Y, but the force model spins
  // bodies about +Z. Tilt the spin frame so the two agree.
  const spinFrame = new Group();
  spinFrame.name = 'spinFrame';
  spinFrame.rotation.x = Math.PI / 2;
  group.add(spinFrame);

  const surface = new Mesh(
    new SphereGeometry(body.radius, SPHERE_SEGMENTS, SPHERE_SEGMENTS / 2),
    new MeshStandardMaterial({
      color: body.surface.color,
      roughness: 0.95,
      metalness: 0,
      // Flat shading reads as faceted terrain and makes rotation legible
      // without any actual heightfield behind it.
      flatShading: true,
    }),
  );
  surface.name = 'surface';
  spinFrame.add(surface);

  const model = createAtmosphereModel(body);
  const sky = model ? createSkyView(model) : null;
  if (sky) group.add(sky.mesh);

  return { group, surface, sky };
}

/**
 * Rotate the planet to match elapsed mission time. Inside the tilted spin
 * frame, local +Y is world +Z, so this spins about the correct axis.
 */
export function updatePlanetRotation(view: PlanetView, body: Body, time: number): void {
  const angle = (2 * Math.PI * time) / body.rotationPeriod;
  view.surface.rotation.y = angle;
}
