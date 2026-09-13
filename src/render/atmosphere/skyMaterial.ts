/**
 * The atmosphere shell: a sphere at the top of the atmosphere whose fragments
 * evaluate the scattering integral along the view ray.
 *
 * Rendered double-sided and additively, so it works both from the ground
 * (camera inside the shell, looking out through air) and from orbit (camera
 * outside, seeing the lit limb). Additive blending contributes in-scattered
 * light but does not attenuate what is behind it; extinction of the ground
 * arrives with the terrain shader in milestone 7, where there is a surface
 * worth attenuating.
 *
 * This replaces the flat translucent shell that stood in until now, which read
 * as an opaque blue ring around the planet rather than as air.
 */
import {
  AdditiveBlending,
  DoubleSide,
  Mesh,
  NodeMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
} from 'three/webgpu';
import { cameraPosition, positionWorld, texture, uniform, vec3, wgslFn } from 'three/tsl';
import type { AtmosphereModel } from '../../atmosphere/model.js';
import { buildTransmittanceLut } from '../../atmosphere/transmittance.js';
import { createTransmittanceTexture } from './lutTexture.js';
import {
  MIE_PHASE_WGSL,
  SAMPLE_TRANSMITTANCE_WGSL,
  SEGMENT_TRANSMITTANCE_WGSL,
  SKY_RADIANCE_WGSL,
  TRANSMITTANCE_UV_WGSL,
} from './skyShader.js';

/**
 * Pass helper functions to `wgslFn` as includes.
 *
 * Three's `nativeFn` unwraps a callable's `.functionNode` at runtime, but its
 * published types only admit the unwrapped node, so this documents the cast in
 * one place rather than scattering it through the call sites.
 */
function includes(...helpers: unknown[]): never[] {
  return helpers as never[];
}

/** Segments on the shell. It is only ever seen as a smooth gradient. */
const SHELL_SEGMENTS = 96;

/**
 * Scales radiance into a displayable range. The model works in physical units
 * where a clear sky is a small number; this is the exposure, not a fudge.
 */
const DEFAULT_SUN_INTENSITY = 22;

export interface SkyView {
  readonly mesh: Mesh;
  /** Planet centre in render space; the shader needs it to find "up". */
  setPlanetCentre(x: number, y: number, z: number): void;
  setSunDirection(x: number, y: number, z: number): void;
}

export function createSkyView(model: AtmosphereModel): SkyView {
  const lut = buildTransmittanceLut(model);
  const lutTexture = createTransmittanceTexture(lut);

  const planetCentre = uniform(new Vector3(0, 0, 0));
  const sunDirection = uniform(new Vector3(1, 0, 0));
  const lutSize = uniform(new Vector2(lut.width, lut.height));

  // Helpers must be passed as includes: three's WGSL parser treats everything
  // after the first declaration as that function's body, so several functions
  // in one string would nest illegally.
  const miePhase = wgslFn(MIE_PHASE_WGSL);
  const transmittanceUv = wgslFn(TRANSMITTANCE_UV_WGSL);
  const sampleTransmittance = wgslFn(SAMPLE_TRANSMITTANCE_WGSL, includes(transmittanceUv));
  const segmentTransmittance = wgslFn(
    SEGMENT_TRANSMITTANCE_WGSL,
    includes(sampleTransmittance),
  );

  const skyRadiance = wgslFn(
    SKY_RADIANCE_WGSL,
    includes(miePhase, transmittanceUv, sampleTransmittance, segmentTransmittance),
  );

  // Everything the integrator needs, in the planet's own frame.
  const viewPosition = cameraPosition.sub(planetCentre);
  const viewDirection = positionWorld.sub(cameraPosition).normalize();

  const radiance = skyRadiance({
    viewPosition,
    viewDirection,
    sunDirection,
    bottomRadius: model.bottomRadius,
    topRadius: model.topRadius,
    rayleighScattering: vec3(
      model.rayleighScattering[0],
      model.rayleighScattering[1],
      model.rayleighScattering[2],
    ),
    rayleighScaleHeight: model.rayleighScaleHeight,
    mieScattering: model.mieScattering,
    mieScaleHeight: model.mieScaleHeight,
    miePhaseG: model.miePhaseG,
    sunIntensity: DEFAULT_SUN_INTENSITY,
    lut: texture(lutTexture),
    lutSize,
  });

  const material = new NodeMaterial();
  material.colorNode = radiance;
  material.transparent = true;
  material.blending = AdditiveBlending;
  material.depthWrite = false;
  // Seen from inside and outside, so neither face can be culled.
  material.side = DoubleSide;

  const mesh = new Mesh(
    new SphereGeometry(model.topRadius, SHELL_SEGMENTS, SHELL_SEGMENTS / 2),
    material,
  );
  mesh.name = 'atmosphere';
  mesh.frustumCulled = false;
  // Draw after the planet so the haze lies over it.
  mesh.renderOrder = 10;

  return {
    mesh,
    setPlanetCentre(x, y, z) {
      planetCentre.value.set(x, y, z);
    },
    setSunDirection(x, y, z) {
      sunDirection.value.set(x, y, z).normalize();
    },
  };
}
