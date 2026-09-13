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
  BackSide,
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

/**
 * Segments on the shell. The view ray is interpolated across each triangle, so
 * too coarse a sphere distorts the angular mapping; this is ample and vertex
 * cost here is irrelevant.
 */
const SHELL_SEGMENTS = 64;

/**
 * Radius of the enclosing shell. Far beyond anything else in the system but
 * comfortably inside the camera's far plane.
 */
const SHELL_RADIUS = 2e8;

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

  const skyRadiance = wgslFn(
    SKY_RADIANCE_WGSL,
    includes(miePhase, transmittanceUv, sampleTransmittance),
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
    mieExtinction: model.mieExtinction,
    mieScaleHeight: model.mieScaleHeight,
    miePhaseG: model.miePhaseG,
    ozoneAbsorption: vec3(
      model.ozoneAbsorption[0],
      model.ozoneAbsorption[1],
      model.ozoneAbsorption[2],
    ),
    ozoneCentre: model.ozoneCentre,
    ozoneWidth: model.ozoneWidth,
    sunIntensity: DEFAULT_SUN_INTENSITY,
    lut: texture(lutTexture),
    lutSize,
  });

  const material = new NodeMaterial();
  material.colorNode = radiance;
  material.transparent = true;
  material.blending = AdditiveBlending;
  material.depthWrite = false;
  // Depth testing is kept on deliberately. The shell sits far away, so it is
  // rejected wherever solid geometry has already been drawn: early-z discards
  // most of the work for free, and the ray's full-atmosphere haze does not get
  // painted over a rocket sixty metres from the camera. The limb, which is sky
  // seen past the planet's silhouette, is unaffected.
  //
  // The cost is no aerial perspective over the surface itself; that arrives
  // with the terrain shader in milestone 7, where there is a surface worth
  // attenuating.
  material.depthTest = true;
  material.side = BackSide;

  // A shell large enough that the camera is always inside it.
  //
  // The shader only uses the geometry to interpolate a view direction, so the
  // radius is free — and being reliably inside a back-facing sphere means each
  // pixel is shaded exactly once. A shell at the atmosphere's own radius needed
  // DoubleSide, which shaded every pixel twice from outside: double the cost,
  // and double the brightness, since the two layers both add their radiance.
  const mesh = new Mesh(
    new SphereGeometry(SHELL_RADIUS, SHELL_SEGMENTS, SHELL_SEGMENTS / 2),
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
