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
import type { Object3D } from 'three/webgpu';
import type { Body } from '../bodies/types.js';
import { stateFromElements } from '../sim/orbit.js';
import type { Vec3 } from '../sim/vec3.js';
import { createAtmosphereModel } from '../atmosphere/model.js';
import type { AtmosphereModel } from '../atmosphere/model.js';
import { integrateScattering } from '../atmosphere/scattering.js';
import { buildTransmittanceLut } from '../atmosphere/transmittance.js';
import type { TransmittanceLut } from '../atmosphere/transmittance.js';
import { DEFAULT_CLOUD_LAYER } from '../clouds/density.js';
import { CloudBakeRunner } from './clouds/cloudBakeRunner.js';
import { uploadCloudTextures } from './clouds/cloudTextureUpload.js';
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
  /** Present only for bodies with an atmosphere, for sky-brightness queries. */
  readonly model: AtmosphereModel | null;
  readonly lut: TransmittanceLut | null;
}

export class SystemView {
  readonly group = new Group();
  private readonly entries: BodyEntry[] = [];
  private readonly bakes = new Map<string, CloudBakeRunner>();

  constructor() {
    this.group.name = 'system';

    for (const body of BODIES) {
      const parent = parentOf(body);
      const view = createPlanetView(body);
      const orbitLine = parent ? buildBodyOrbit(body, parent) : null;

      // The same model the shader uses, kept on the CPU so the renderer can
      // ask how bright the sky is without reading back from the GPU.
      const model = createAtmosphereModel(body);
      const lut = model ? buildTransmittanceLut(model) : null;

      this.group.add(view.group);
      if (orbitLine) this.group.add(orbitLine);

      this.entries.push({ body, parent, view, orbitLine, model, lut });

      // Bodies with a sky get clouds, once their noise has finished baking.
      if (view.sky) this.bakes.set(body.id, new CloudBakeRunner(DEFAULT_CLOUD_LAYER.seed));
    }
  }

  /**
   * Advance any outstanding cloud bakes, handing over the textures on the
   * frame each one finishes. Cheap no-op once they are all done.
   */
  stepCloudBakes(): void {
    for (const [bodyId, runner] of this.bakes) {
      const baked = runner.step();
      if (!baked) continue;

      const entry = this.entries.find((candidate) => candidate.body.id === bodyId);
      entry?.view.sky?.setCloudTextures(uploadCloudTextures(baked));
      this.bakes.delete(bodyId);
    }
  }

  /**
   * The atmosphere shells, which draw in the reduced-resolution sky pass.
   * Smooth gradients, so they lose nothing to it.
   */
  get skyMeshes(): Object3D[] {
    return this.entries.flatMap((entry) => (entry.view.sky ? [entry.view.sky.mesh] : []));
  }

  /**
   * The solid bodies and their orbit lines, which draw at full resolution
   * because they have edges worth resolving.
   */
  get surfaceMeshes(): Object3D[] {
    return this.entries.flatMap((entry) =>
      entry.orbitLine ? [entry.view.surface, entry.orbitLine] : [entry.view.surface],
    );
  }

  /**
   * Sky brightness overhead at a viewpoint, in the atmosphere model's units.
   * Used to decide how far to fade the stars; zero for an airless body.
   */
  skyBrightnessAt(body: Body, altitude: number): number {
    const entry = this.entries.find((candidate) => candidate.body.id === body.id);
    const model = entry?.model;
    const lut = entry?.lut;
    if (!model || !lut) return 0;

    const sky = integrateScattering(model, lut, {
      r: model.bottomRadius + Math.max(0, altitude),
      mu: 1,
      muSun: 1,
      nu: 1,
    });

    // One channel is enough to drive a fade, and green sits nearest the eye's
    // peak sensitivity.
    return sky.radiance[1];
  }

  /** Overall bake progress in [0, 1]; 1 when there is nothing left to do. */
  get cloudBakeProgress(): number {
    if (this.bakes.size === 0) return 1;

    let total = 0;
    for (const runner of this.bakes.values()) total += runner.progress;
    return total / this.bakes.size;
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
