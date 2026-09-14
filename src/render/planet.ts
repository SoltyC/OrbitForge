/**
 * Planet rendering: a shaded sphere for the ground, plus a physically based
 * atmosphere shell for bodies that have air.
 *
 * The surface is still placeholder geometry — real quadtree terrain arrives in
 * milestone 7 — but the sky around it is the real scattering model.
 */
import { Mesh, MeshStandardMaterial, SphereGeometry, Group } from 'three/webgpu';
import { createAtmosphereModel } from '../atmosphere/model.js';
import { DEFAULT_CLOUD_LAYER } from '../clouds/density.js';
import type { Body } from '../bodies/types.js';
import { createSkyView } from './atmosphere/skyMaterial.js';
import type { SkyView } from './atmosphere/skyMaterial.js';
import { TerrainView } from './terrain/terrainView.js';

/** Latitude/longitude segments on the placeholder sphere. */
const SPHERE_SEGMENTS = 128;

/** How far below sea level the backstop sphere sits (m). */
const BACKSTOP_DROP = 400;

export interface PlanetView {
  readonly group: Group;
  readonly surface: Mesh;
  /** Present only for bodies with an atmosphere. */
  readonly sky: SkyView | null;
  /** Present only for bodies with a terrain profile. */
  readonly terrain: TerrainView | null;
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

  // Where there is real terrain the sphere drops below sea level and becomes a
  // backstop rather than the surface: it fills the view for the couple of
  // seconds the chunks take to build, and stays out of the ocean's way — both
  // sit at exactly the planet's radius otherwise, and would z-fight across
  // every sea on the planet.
  const surfaceRadius = body.terrain ? body.radius - BACKSTOP_DROP : body.radius;

  const surface = new Mesh(
    new SphereGeometry(surfaceRadius, SPHERE_SEGMENTS, SPHERE_SEGMENTS / 2),
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

  // Real terrain replaces the placeholder sphere where a body has a profile.
  // The sphere stays for bodies that do not, and as the thing terrain chunks
  // are drawn over until they have been generated.
  //
  // Attached to the planet, not to the spin frame. That frame exists only to
  // tilt SphereGeometry's Y-poles onto the +Z axis the simulation spins about,
  // and terrain chunks are already built in those coordinates — parenting them
  // there rotates the whole landscape ninety degrees off the planet it belongs
  // to. It carries its own rotation instead, applied below.
  const terrain = body.terrain ? new TerrainView(body.radius, body.terrain) : null;
  if (terrain) group.add(terrain.group);

  const model = createAtmosphereModel(body);
  // Clouds live in the sky pass, so the layer is described per body here.
  const sky = model
    ? createSkyView(model, { ...DEFAULT_CLOUD_LAYER, planetRadius: body.radius })
    : null;
  if (sky) group.add(sky.mesh);

  return { group, surface, sky, terrain };
}

/**
 * Rotate the planet to match elapsed mission time.
 *
 * Two rotations for the same spin, because the two meshes live in different
 * frames. Inside the tilted spin frame the sphere's local +Y is world +Z; the
 * terrain is already in world axes and turns about Z directly.
 */
export function updatePlanetRotation(view: PlanetView, body: Body, time: number): void {
  const angle = (2 * Math.PI * time) / body.rotationPeriod;

  view.surface.rotation.y = angle;
  if (view.terrain) view.terrain.group.rotation.z = angle;
}
