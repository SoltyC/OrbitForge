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
  BackSide,
  CustomBlending,
  Data3DTexture,
  LinearFilter,
  Mesh,
  NodeMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  RGFormat,
  RedFormat,
  RepeatWrapping,
  SphereGeometry,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
} from 'three/webgpu';
import {
  cameraPosition,
  float,
  positionWorld,
  sampler,
  screenCoordinate,
  texture,
  texture3D,
  uniform,
  vec3,
  wgslFn,
} from 'three/tsl';
import type { AtmosphereModel } from '../../atmosphere/model.js';
import { buildTransmittanceLut } from '../../atmosphere/transmittance.js';
import type { CloudLayer } from '../../clouds/density.js';
import type { CloudTextureHandles } from '../clouds/cloudTextureUpload.js';
import {
  CLOUD_DENSITY_WGSL,
  CLOUD_DUAL_LOBE_WGSL,
  CLOUD_GRADIENT_WGSL,
  CLOUD_LIGHT_MARCH_WGSL,
  CLOUD_MARCH_WGSL,
  CLOUD_MULTI_SCATTER_WGSL,
  CLOUD_PHASE_WGSL,
  CLOUD_REMAP_WGSL,
  CLOUD_SPHERE_HIT_WGSL,
} from '../clouds/cloudShader.js';
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
 * How far the cloud march will follow a ray (m). A ray skimming the inside of
 * the layer stays in it for hundreds of kilometres; past this the deck is
 * below the horizon and only costs time.
 */
const CLOUD_MAX_DISTANCE = 200_000;

/**
 * A 1x1x1 stand-in bound until the real noise arrives.
 *
 * The march needs its texture bindings to exist from the first frame, and the
 * bake takes seconds. `cloudStrength` holds the result at zero meanwhile, so
 * this is never actually read for anything visible.
 */
function placeholderVolume(channels = 1): Data3DTexture {
  const texture = new Data3DTexture(new Uint8Array(channels), 1, 1, 1);
  texture.format = channels === 2 ? RGFormat : RedFormat;
  texture.type = UnsignedByteType;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.wrapR = RepeatWrapping;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Scales radiance into a displayable range. The model works in physical units
 * where a clear sky is a small number; this is the exposure, not a fudge.
 */
const DEFAULT_SUN_INTENSITY = 22;

/**
 * Scales cloud luminance into the same units as the sky. Matches
 * CLOUD_BRIGHTNESS in tools/renderCloudReference.ts.
 */
const CLOUD_BRIGHTNESS = 9;

export interface SkyView {
  readonly mesh: Mesh;
  /** Planet centre in render space; the shader needs it to find "up". */
  setPlanetCentre(x: number, y: number, z: number): void;
  setSunDirection(x: number, y: number, z: number): void;
  /**
   * Hand over the baked noise once it exists. Clouds are off until then, so
   * the sky renders normally while the bake runs.
   */
  setCloudTextures(textures: CloudTextureHandles): void;
}

export function createSkyView(model: AtmosphereModel, layer: CloudLayer): SkyView {
  const lut = buildTransmittanceLut(model);
  const lutTexture = createTransmittanceTexture(lut);

  const planetCentre = uniform(new Vector3(0, 0, 0));
  const sunDirection = uniform(new Vector3(1, 0, 0));
  const lutSize = uniform(new Vector2(lut.width, lut.height));

  // Cloud layer constants, packed so the shader signature stays readable.
  const layerA = uniform(
    new Vector4(layer.planetRadius, layer.bottomAltitude, layer.topAltitude, layer.density),
  );
  const layerB = uniform(
    new Vector4(
      layer.shapeScale,
      layer.detailScale,
      layer.weatherScale,
      layer.lightMarchDistance,
    ),
  );
  const layerC = uniform(new Vector4(layer.coverage, layer.erosion, 0, 0));

  // Zero until the bake finishes, which switches the cloud march off entirely.
  const cloudStrength = uniform(0);

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

  // The cloud march. Placeholder textures until the bake lands; the strength
  // uniform keeps the whole thing switched off until then.
  const cloudShape = placeholderVolume();
  const cloudDetail = placeholderVolume();
  const cloudWeather = placeholderVolume(2);

  const shapeNode = texture3D(cloudShape);
  const detailNode = texture3D(cloudDetail);
  const weatherNode = texture3D(cloudWeather);

  const cloudRemap = wgslFn(CLOUD_REMAP_WGSL);
  const cloudGradient = wgslFn(CLOUD_GRADIENT_WGSL, includes(cloudRemap));
  const cloudDensity = wgslFn(
    CLOUD_DENSITY_WGSL,
    includes(cloudRemap, cloudGradient),
  );
  const cloudPhase = wgslFn(CLOUD_PHASE_WGSL);
  const cloudDualLobe = wgslFn(CLOUD_DUAL_LOBE_WGSL, includes(cloudPhase));
  const cloudMultiScatter = wgslFn(
    CLOUD_MULTI_SCATTER_WGSL,
    includes(cloudPhase, cloudDualLobe),
  );
  const cloudLightMarch = wgslFn(
    CLOUD_LIGHT_MARCH_WGSL,
    includes(cloudRemap, cloudGradient, cloudDensity),
  );
  const cloudSphereHit = wgslFn(CLOUD_SPHERE_HIT_WGSL);
  const marchCloudLayer = wgslFn(
    CLOUD_MARCH_WGSL,
    includes(
      cloudRemap,
      cloudGradient,
      cloudDensity,
      cloudPhase,
      cloudDualLobe,
      cloudMultiScatter,
      cloudLightMarch,
      cloudSphereHit,
    ),
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

  // Per-pixel dither, so the march's steps break up into noise rather than
  // stacking into visible bands across the sky.
  const jitter = screenCoordinate.x
    .mul(12.9898)
    .add(screenCoordinate.y.mul(78.233))
    .sin()
    .mul(43758.5453)
    .fract();

  const clouds = marchCloudLayer({
    origin: viewPosition,
    direction: viewDirection,
    sunDirection,
    layerA,
    layerB,
    layerC,
    jitter,
    maxDistance: float(CLOUD_MAX_DISTANCE),
    shapeTex: shapeNode,
    shapeSampler: sampler(shapeNode),
    detailTex: detailNode,
    detailSampler: sampler(detailNode),
    weatherTex: weatherNode,
    weatherSampler: sampler(weatherNode),
  }).mul(cloudStrength);

  // Composite exactly as the reference renderer does: the sky behind is
  // attenuated by the cloud, and the cloud's own scattered light is added.
  const cloudTransmittance = float(1).sub(clouds.w);
  const colour = radiance.xyz.mul(cloudTransmittance).add(clouds.xyz.mul(CLOUD_BRIGHTNESS));

  // Combined occlusion of whatever is behind: air and cloud in series.
  const opacity = float(1).sub(float(1).sub(radiance.w).mul(cloudTransmittance));

  const material = new NodeMaterial();
  material.colorNode = colour;
  material.opacityNode = opacity;
  material.transparent = true;

  // Not additive. Additive light can only ever be added, never taken away, so
  // stars stayed visible straight through a bright daytime sky however much
  // air was in front of them — and a cloud could not hide anything either.
  // src + dst * (1 - a) composites properly: the shader already returns colour
  // in absolute radiance, so no premultiply is wanted on top.
  material.blending = CustomBlending;
  material.blendSrc = OneFactor;
  material.blendDst = OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = OneFactor;
  material.blendDstAlpha = OneMinusSrcAlphaFactor;
  material.depthWrite = false;
  // No depth testing. The sky is drawn in its own pass with nothing else in
  // it, so there is nothing to test against — and that pass renders into a
  // target with no depth attachment, which a pipeline that wants depth cannot
  // legally draw into at all.
  //
  // It used to be on, back when the sky shared a pass with the planet and the
  // vessel: it bought early-z rejection behind solid geometry and kept the
  // full-atmosphere haze off a rocket sixty metres away. Splitting the passes
  // achieves both by construction, since the foreground is simply drawn over
  // the sky afterwards.
  material.depthTest = false;
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
    setCloudTextures(handles) {
      shapeNode.value = handles.shape;
      detailNode.value = handles.detail;
      weatherNode.value = handles.weather;
      cloudStrength.value = 1;
    },
  };
}
