/**
 * Placeholder vessel rendering: the stack built from simple cylinders, plus an
 * additive exhaust plume that scales with throttle.
 *
 * Parts are stacked along local +Y, matching the thrust axis used by the
 * simulation, so applying the simulated orientation quaternion Just Works.
 */
import {
  AdditiveBlending,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
} from 'three/webgpu';
import type { Quat } from '../sim/quat.js';
import { AMBIENT_THERMAL, glowColour, glowIntensity } from '../sim/heating.js';
import type { ThermalState } from '../sim/heating.js';
import type { Vessel } from '../sim/vessel.js';

/** Shared with the editor so a part looks the same in the VAB and in flight. */
export const PART_COLORS: Record<string, number> = {
  command: 0xd8d8dc,
  tank: 0xb8bcc4,
  engine: 0x51555c,
  decoupler: 0x8a6a3a,
};

export interface VesselView {
  readonly group: Group;
  readonly plume: Mesh;
  /** Part materials, so reentry heating can make them glow. */
  readonly skins: MeshStandardMaterial[];
}

/**
 * Build the vessel mesh. Stages render bottom-up: `stages[0]` is the lowest,
 * so it is placed first and everything else stacks on top of it.
 */
export function createVesselView(vessel: Vessel): VesselView {
  const group = new Group();
  group.name = `vessel:${vessel.name}`;

  const skins: MeshStandardMaterial[] = [];

  let offset = 0;
  for (const stage of vessel.stages) {
    for (const part of stage.parts) {
      const material = new MeshStandardMaterial({
        color: PART_COLORS[part.category] ?? 0x999999,
        roughness: 0.55,
        metalness: 0.35,
      });
      skins.push(material);

      const mesh = new Mesh(
        new CylinderGeometry(part.diameter / 2, part.diameter / 2, part.length, 24),
        material,
      );
      // Cylinders are centred on their origin; shift up by half a length.
      mesh.position.y = offset + part.length / 2;
      mesh.name = part.id;
      group.add(mesh);
      offset += part.length;
    }
  }

  const plume = createPlume();
  group.add(plume);

  return { group, plume, skins };
}

/** Exhaust cone pointing down from the base of the stack. */
function createPlume(): Mesh {
  const plume = new Mesh(
    new ConeGeometry(0.5, 6, 16, 1, true),
    new MeshBasicMaterial({
      color: 0xffb066,
      transparent: true,
      opacity: 0.75,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
  );
  plume.name = 'plume';
  // Point the cone downward (-Y), tip away from the engine bell.
  plume.rotation.x = Math.PI;
  plume.visible = false;
  return plume;
}

/**
 * Apply the simulated orientation, throttle and skin temperature.
 *
 * Heating shows as emission rather than as a colour change: a glowing surface
 * emits light of its own, so it stays bright on the shadowed side of the
 * vehicle — which is exactly where a reentry is most visible.
 */
export function updateVesselView(
  view: VesselView,
  orientation: Quat,
  throttle: number,
  thermal: ThermalState = AMBIENT_THERMAL,
): void {
  view.group.quaternion.copy(
    new Quaternion(orientation.x, orientation.y, orientation.z, orientation.w),
  );

  const glow = glowIntensity(thermal.temperature);
  if (glow > 0) {
    const [r, g, b] = glowColour(thermal.temperature);
    for (const skin of view.skins) {
      skin.emissive.setRGB(r, g, b);
      skin.emissiveIntensity = glow * 2.5;
    }
  } else {
    for (const skin of view.skins) skin.emissiveIntensity = 0;
  }

  view.plume.visible = throttle > 0;
  if (throttle > 0) {
    // Plume grows with throttle; the cone's own origin is at its centre.
    const length = 4 + throttle * 8;
    view.plume.scale.set(0.6 + throttle * 0.6, length / 6, 0.6 + throttle * 0.6);
    view.plume.position.y = -length / 2;
  }
}
