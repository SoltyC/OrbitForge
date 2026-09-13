/**
 * Placeholder planet rendering: a shaded sphere plus a translucent shell
 * marking the top of the atmosphere.
 *
 * This is intentionally simple. Real quadtree terrain arrives in milestone 7
 * and atmospheric scattering in milestone 5; until then the sphere exists only
 * to give the flight a visible frame of reference.
 */
import {
  BackSide,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  Group,
} from 'three/webgpu';
import type { Body } from '../bodies/types.js';

/** Latitude/longitude segments on the placeholder sphere. */
const SPHERE_SEGMENTS = 128;

export interface PlanetView {
  readonly group: Group;
  readonly surface: Mesh;
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

  if (body.atmosphere) {
    group.add(createAtmosphereShell(body));
  }

  return { group, surface };
}

/**
 * A thin inside-out shell at the atmosphere boundary. Viewed from outside it
 * reads as a haze halo; from inside it does not occlude the vessel.
 */
function createAtmosphereShell(body: Body): Mesh {
  const atmosphere = body.atmosphere!;
  const shell = new Mesh(
    new SphereGeometry(
      body.radius + atmosphere.height,
      SPHERE_SEGMENTS / 2,
      SPHERE_SEGMENTS / 4,
    ),
    new MeshBasicMaterial({
      color: 0x4a90d9,
      transparent: true,
      opacity: 0.12,
      side: BackSide,
      depthWrite: false,
    }),
  );
  shell.name = 'atmosphere';
  return shell;
}

/**
 * Rotate the planet to match elapsed mission time. Inside the tilted spin
 * frame, local +Y is world +Z, so this spins about the correct axis.
 */
export function updatePlanetRotation(view: PlanetView, body: Body, time: number): void {
  const angle = (2 * Math.PI * time) / body.rotationPeriod;
  view.surface.rotation.y = angle;
}
