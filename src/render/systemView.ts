/**
 * Renders every body in the system, positioned relative to the active vessel.
 *
 * The floating origin puts the vessel at the scene origin, so each body is
 * drawn at its absolute position minus the vessel's. Working through the
 * shared root frame means this is correct no matter which body's sphere of
 * influence the vessel currently occupies — the view does not change when the
 * vessel is handed from a planet to a moon, only what is near the camera does.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  LineBasicMaterial,
  LineLoop,
} from 'three/webgpu';
import { chainToRoot } from '../bodies/ephemeris.js';
import { BODIES, parentOf } from '../bodies/system.js';
import type { Body } from '../bodies/types.js';
import { stateFromElements } from '../sim/orbit.js';
import type { Vec3 } from '../sim/vec3.js';
import { createPlanetView, updatePlanetRotation } from './planet.js';
import { SUN_DIRECTION } from './renderer.js';
import type { PlanetView } from './planet.js';

/** Segments in a body's orbit line. */
const ORBIT_SEGMENTS = 192;
const BODY_ORBIT_COLOR = 0x44607a;

interface BodyEntry {
  readonly body: Body;
  readonly parent: Body | null;
  readonly view: PlanetView;
  readonly orbitLine: LineLoop | null;
}

export class SystemView {
  readonly group = new Group();
  private readonly entries: BodyEntry[] = [];

  constructor() {
    this.group.name = 'system';

    for (const body of BODIES) {
      const parent = parentOf(body);
      const view = createPlanetView(body);
      const orbitLine = parent ? buildBodyOrbit(body, parent) : null;

      this.group.add(view.group);
      if (orbitLine) this.group.add(orbitLine);

      this.entries.push({ body, parent, view, orbitLine });
    }
  }

  /**
   * Place every body for this frame.
   *
   * @param vesselBody The body whose frame the vessel's position is expressed in.
   * @param vesselPosition The vessel's position within that frame.
   */
  update(vesselBody: Body, vesselPosition: Vec3, time: number): void {
    const frameOrigin = chainToRoot(vesselBody, time).position;
    const vesselAbsolute = frameOrigin.add(vesselPosition);

    for (const entry of this.entries) {
      const absolute = chainToRoot(entry.body, time).position;
      const relative = absolute.sub(vesselAbsolute);

      entry.view.group.position.set(relative.x, relative.y, relative.z);
      updatePlanetRotation(entry.view, entry.body, time);

      // The sky shader works in the planet's own frame, so it needs to know
      // where that planet ended up in render space this frame.
      entry.view.sky?.setPlanetCentre(relative.x, relative.y, relative.z);
      entry.view.sky?.setSunDirection(
        SUN_DIRECTION.x,
        SUN_DIRECTION.y,
        SUN_DIRECTION.z,
      );

      // A body's orbit is drawn centred on its parent, not on itself.
      if (entry.orbitLine && entry.parent) {
        const parentRelative = chainToRoot(entry.parent, time).position.sub(
          vesselAbsolute,
        );
        entry.orbitLine.position.set(
          parentRelative.x,
          parentRelative.y,
          parentRelative.z,
        );
      }
    }
  }

  /** Show body orbit lines only where they are useful — in map view. */
  setOrbitLinesVisible(visible: boolean): void {
    for (const entry of this.entries) {
      if (entry.orbitLine) entry.orbitLine.visible = visible;
    }
  }

  /** The rendered position of a body, for aiming the map camera. */
  positionOf(bodyId: string): Group['position'] | null {
    return this.entries.find((e) => e.body.id === bodyId)?.view.group.position ?? null;
  }
}

/** Trace a body's orbit around its parent as a closed line. */
function buildBodyOrbit(body: Body, parent: Body): LineLoop | null {
  if (!body.orbit) return null;

  const positions = new Float32Array(ORBIT_SEGMENTS * 3);
  for (let i = 0; i < ORBIT_SEGMENTS; i++) {
    const trueAnomaly = (i / ORBIT_SEGMENTS) * Math.PI * 2;
    const { position } = stateFromElements({ ...body.orbit, trueAnomaly }, parent.mu);
    positions[i * 3] = position.x;
    positions[i * 3 + 1] = position.y;
    positions[i * 3 + 2] = position.z;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));

  const line = new LineLoop(
    geometry,
    new LineBasicMaterial({ color: BODY_ORBIT_COLOR, transparent: true, opacity: 0.5 }),
  );
  line.name = `orbit:${body.id}`;
  line.frustumCulled = false;

  return line;
}
