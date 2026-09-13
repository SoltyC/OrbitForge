/**
 * Orbit visualisation: the trajectory ellipse plus apoapsis, periapsis and
 * vessel markers.
 *
 * The line's vertices live in body-centred simulation coordinates, and the
 * whole group is positioned at the body centre in render space. That way the
 * geometry only needs rebuilding when the orbit itself changes, not every
 * frame as the floating origin moves.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Line,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
} from 'three/webgpu';
import { stateFromElements } from '../sim/orbit.js';
import type { OrbitSummary } from '../sim/orbit.js';

/** Vertices around the ellipse. 256 is smooth at any practical zoom. */
const SEGMENTS = 256;

const ORBIT_COLOR = 0x5ad1ff;
const APOAPSIS_COLOR = 0x6fffa8;
const PERIAPSIS_COLOR = 0xffb45a;
const VESSEL_COLOR = 0xffffff;

export interface OrbitLineView {
  readonly group: Group;
  readonly line: Line;
  readonly apoapsisMarker: Mesh;
  readonly periapsisMarker: Mesh;
  readonly vesselMarker: Mesh;
}

export function createOrbitLineView(): OrbitLineView {
  const group = new Group();
  group.name = 'orbit';

  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array(SEGMENTS * 3), 3),
  );

  const line = new LineLoop(
    geometry,
    new LineBasicMaterial({ color: ORBIT_COLOR, transparent: true, opacity: 0.85 }),
  );
  line.name = 'orbitLine';
  line.frustumCulled = false;

  const apoapsisMarker = createMarker(APOAPSIS_COLOR, 'apoapsis');
  const periapsisMarker = createMarker(PERIAPSIS_COLOR, 'periapsis');
  const vesselMarker = createMarker(VESSEL_COLOR, 'vesselMarker');

  group.add(line, apoapsisMarker, periapsisMarker, vesselMarker);

  return { group, line, apoapsisMarker, periapsisMarker, vesselMarker };
}

function createMarker(color: number, name: string): Mesh {
  const marker = new Mesh(
    new SphereGeometry(1, 12, 8),
    new MeshBasicMaterial({ color, depthWrite: false }),
  );
  marker.name = name;
  marker.frustumCulled = false;
  return marker;
}

/**
 * Rebuild the ellipse for a new orbit.
 *
 * Unbound trajectories are hidden rather than drawn — hyperbolic paths need
 * their own treatment, which arrives with the SOI work in milestone 4.
 */
export function updateOrbitGeometry(view: OrbitLineView, elements: OrbitSummary, mu: number): void {
  if (!elements.isClosed) {
    view.group.visible = false;
    return;
  }

  view.group.visible = true;

  const positions = view.line.geometry.getAttribute('position') as BufferAttribute;
  const array = positions.array as Float32Array;

  for (let i = 0; i < SEGMENTS; i++) {
    const trueAnomaly = (i / SEGMENTS) * Math.PI * 2;
    const { position } = stateFromElements({ ...elements, trueAnomaly }, mu);
    array[i * 3] = position.x;
    array[i * 3 + 1] = position.y;
    array[i * 3 + 2] = position.z;
  }
  positions.needsUpdate = true;

  placeAtAnomaly(view.apoapsisMarker, elements, mu, Math.PI);
  placeAtAnomaly(view.periapsisMarker, elements, mu, 0);
}

/**
 * Move the vessel marker along the orbit. Separate from the geometry rebuild
 * because the vessel's true anomaly changes every frame while the orbit's
 * shape usually does not.
 */
export function updateVesselMarker(
  view: OrbitLineView,
  elements: OrbitSummary,
  mu: number,
): void {
  if (!elements.isClosed) return;
  placeAtAnomaly(view.vesselMarker, elements, mu, elements.trueAnomaly);
}

function placeAtAnomaly(
  marker: Mesh,
  elements: OrbitSummary,
  mu: number,
  trueAnomaly: number,
): void {
  const { position } = stateFromElements({ ...elements, trueAnomaly }, mu);
  marker.position.set(position.x, position.y, position.z);
}

/**
 * Scale the markers so they stay a constant size on screen regardless of how
 * far the camera has pulled back.
 */
export function updateMarkerScale(view: OrbitLineView, cameraDistance: number): void {
  const scale = Math.max(1, cameraDistance * 0.006);
  view.apoapsisMarker.scale.setScalar(scale);
  view.periapsisMarker.scale.setScalar(scale);
  view.vesselMarker.scale.setScalar(scale);
}

/** A compact signature of an orbit's shape, used to skip redundant rebuilds. */
export function orbitSignature(elements: OrbitSummary): string {
  return [
    elements.semiMajorAxis.toFixed(1),
    elements.eccentricity.toFixed(7),
    elements.inclination.toFixed(7),
    elements.longitudeOfAscendingNode.toFixed(7),
    elements.argumentOfPeriapsis.toFixed(7),
  ].join('|');
}
