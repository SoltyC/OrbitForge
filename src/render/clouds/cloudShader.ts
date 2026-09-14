/**
 * The cloud shader: a WGSL transcription of src/clouds/.
 *
 * Same discipline as the atmosphere. The TypeScript reference is unit-tested
 * and rendered offline by tools/renderCloudReference.ts, and this is a port of
 * it rather than an independent implementation — so if the game disagrees with
 * that reference image, the shader is wrong and the model is not.
 *
 * If you change the maths here, change it there too, and let the tests judge.
 *
 * Noise comes from the three baked 3D textures, read with hardware trilinear
 * filtering. The analytic field is around three hundred operations per sample
 * and the march wants thousands of samples per pixel.
 */
import {
  DETAIL_PERIOD,
  SHAPE_PERIOD,
  WEATHER_PERIOD,
} from '../../clouds/textures.js';
import { LIGHT_STEPS, MAX_VIEW_STEPS } from '../../clouds/march.js';

/**
 * Loop bounds have to be literals in WGSL, so the view march runs to its
 * maximum and breaks early. The step *count* still adapts: the loop reads a
 * value computed from the span and stops there.
 */
export const CLOUD_MAX_STEPS = MAX_VIEW_STEPS;
export const CLOUD_LIGHT_STEPS = LIGHT_STEPS;

/** Rescale between ranges, clamped — used constantly to carve one field from another. */
export const CLOUD_REMAP_WGSL = /* wgsl */ `
fn cloudRemap( value: f32, fromMin: f32, fromMax: f32, toMin: f32, toMax: f32 ) -> f32 {
  if ( fromMax == fromMin ) { return toMin; }
  let t = ( value - fromMin ) / ( fromMax - fromMin );
  let mapped = toMin + t * ( toMax - toMin );
  return clamp( mapped, min( toMin, toMax ), max( toMin, toMax ) );
}
`;

/**
 * Vertical profile through the slab. Stratus are a flat sheet low down;
 * cumulus have narrow bases and broad tops. This shape is most of what makes a
 * cloud read as a cloud rather than as fog.
 */
export const CLOUD_GRADIENT_WGSL = /* wgsl */ `
fn cloudHeightGradient( h: f32, cloudType: f32 ) -> f32 {
  if ( h < 0.0 || h > 1.0 ) { return 0.0; }

  let stratus = cloudRemap( h, 0.0, 0.1, 0.0, 1.0 ) * cloudRemap( h, 0.2, 0.35, 1.0, 0.0 );
  let cumulus = cloudRemap( h, 0.0, 0.2, 0.0, 1.0 ) * cloudRemap( h, 0.7, 1.0, 1.0, 0.0 );
  let stratocumulus =
    cloudRemap( h, 0.0, 0.15, 0.0, 1.0 ) * cloudRemap( h, 0.4, 0.7, 1.0, 0.0 );

  if ( cloudType < 0.5 ) {
    return mix( stratus, stratocumulus, clamp( cloudType * 2.0, 0.0, 1.0 ) );
  }
  return mix( stratocumulus, cumulus, clamp( ( cloudType - 0.5 ) * 2.0, 0.0, 1.0 ) );
}
`;

/**
 * Density at a planet-centric point, in m^-1.
 *
 * `layerA` is (planetRadius, bottomAltitude, topAltitude, density).
 * `layerB` is (shapeScale, detailScale, weatherScale, lightMarchDistance).
 * `layerC` is (coverage, erosion, unused, unused).
 *
 * The erosion fetch happens here even when called from the light march. That
 * is the innermost loop and dropping it is the usual saving, but it was
 * measured on the reference: erosion removes about a third of the field's mass,
 * and a light march blind to those holes shadows cloud that is not there.
 */
export const CLOUD_DENSITY_WGSL = /* wgsl */ `
fn cloudDensityAt(
  p: vec3<f32>,
  layerA: vec4<f32>,
  layerB: vec4<f32>,
  layerC: vec4<f32>,
  shapeTex: texture_3d<f32>,
  shapeSampler: sampler,
  detailTex: texture_3d<f32>,
  detailSampler: sampler,
  weatherTex: texture_3d<f32>,
  weatherSampler: sampler
) -> f32 {
  let planetRadius = layerA.x;
  let radius = length( p );
  if ( radius <= 0.0 ) { return 0.0; }

  let span = layerA.z - layerA.y;
  if ( span <= 0.0 ) { return 0.0; }

  let h = ( radius - planetRadius - layerA.y ) / span;
  if ( h <= 0.0 || h >= 1.0 ) { return 0.0; }

  // Weather is read on a reference sphere at the planet's radius, so a column
  // of air has one coverage from base to top: coverage belongs to a patch of
  // sky, not to a height within it.
  let s = planetRadius / radius;
  let weatherUvw = ( p * s ) / ( layerB.z * ${WEATHER_PERIOD}.0 );
  let weather = textureSampleLevel( weatherTex, weatherSampler, weatherUvw, 0.0 );

  let cloudType = clamp( weather.g, 0.0, 1.0 );
  let gradient = cloudHeightGradient( h, cloudType );
  if ( gradient <= 0.0 ) { return 0.0; }

  let coverage = clamp(
    cloudRemap( weather.r, 0.25, 0.85, 0.0, 1.0 ) * layerC.x * 2.0, 0.0, 1.0 );

  let shapeUvw = p / ( layerB.x * ${SHAPE_PERIOD}.0 );
  let shape = textureSampleLevel( shapeTex, shapeSampler, shapeUvw, 0.0 ).r;

  let base = cloudRemap( shape * gradient, 1.0 - coverage, 1.0, 0.0, 1.0 );
  if ( base <= 0.0 ) { return 0.0; }

  // Eroding harder at the base than the top gives the wispy underside and firm
  // cauliflower crown that convective clouds have.
  let detailUvw = p / ( layerB.y * ${DETAIL_PERIOD}.0 );
  let detail = textureSampleLevel( detailTex, detailSampler, detailUvw, 0.0 ).r;

  let erosionStrength = layerC.y * sqrt( max( 0.0, 1.0 - h ) );
  let eroded = cloudRemap( base, detail * erosionStrength, 1.0, 0.0, 1.0 );

  return clamp( eroded, 0.0, 1.0 ) * layerA.w;
}
`;

/**
 * Multiple scattering as a few octaves of progressively wider, dimmer, less
 * extincting light.
 *
 * Each octave stands in for one more bounce. Without them a dense cloud is
 * exp(-depth) all the way through, which is a silhouette rather than a cloud.
 */
export const CLOUD_PHASE_WGSL = /* wgsl */ `
fn cloudPhase( cosTheta: f32, g: f32 ) -> f32 {
  let gg = g * g;
  let denom = max( 1e-6, 1.0 + gg - 2.0 * g * cosTheta );
  return ( ( 1.0 - gg ) / ( 4.0 * 3.14159265 ) ) * pow( denom, -1.5 );
}
`;

/**
 * Two lobes: a strong forward one for the silver lining, and a weak backward
 * one so the anti-solar sky does not go flat.
 */
export const CLOUD_DUAL_LOBE_WGSL = /* wgsl */ `
fn cloudDualLobe( cosTheta: f32, forwardG: f32, backwardG: f32, blend: f32 ) -> f32 {
  return ( 1.0 - blend ) * cloudPhase( cosTheta, forwardG )
    + blend * cloudPhase( cosTheta, -backwardG );
}
`;

export const CLOUD_MULTI_SCATTER_WGSL = /* wgsl */ `
fn cloudMultiScatter( sunOpticalDepth: f32, cosTheta: f32 ) -> f32 {
  var luminance = 0.0;
  var attenuation = 1.0;
  var contribution = 1.0;
  var phaseAttenuation = 1.0;

  for ( var i = 0; i < 3; i = i + 1 ) {
    let phase = cloudDualLobe(
      cosTheta, 0.8 * phaseAttenuation, 0.3 * phaseAttenuation, 0.15 );

    luminance = luminance + contribution * phase * exp( -sunOpticalDepth * attenuation );

    attenuation = attenuation * 0.5;
    contribution = contribution * 0.5;
    phaseAttenuation = phaseAttenuation * 0.5;
  }

  return luminance;
}
`;

/** Optical depth from a point towards the sun, over a short growing march. */
export const CLOUD_LIGHT_MARCH_WGSL = /* wgsl */ `
fn cloudLightMarch(
  p: vec3<f32>,
  sunDirection: vec3<f32>,
  layerA: vec4<f32>,
  layerB: vec4<f32>,
  layerC: vec4<f32>,
  shapeTex: texture_3d<f32>,
  shapeSampler: sampler,
  detailTex: texture_3d<f32>,
  detailSampler: sampler,
  weatherTex: texture_3d<f32>,
  weatherSampler: sampler
) -> f32 {
  let distance = layerB.w;
  if ( distance <= 0.0 ) { return 0.0; }

  var opticalDepth = 0.0;

  for ( var i = 0; i < ${CLOUD_LIGHT_STEPS}; i = i + 1 ) {
    let u0 = f32( i ) / ${CLOUD_LIGHT_STEPS}.0;
    let u1 = f32( i + 1 ) / ${CLOUD_LIGHT_STEPS}.0;
    let t0 = u0 * u0;
    let t1 = u1 * u1;

    let step = distance * ( t1 - t0 );
    let d = distance * ( ( t0 + t1 ) * 0.5 );

    opticalDepth = opticalDepth + cloudDensityAt(
      p + sunDirection * d, layerA, layerB, layerC,
      shapeTex, shapeSampler, detailTex, detailSampler,
      weatherTex, weatherSampler ) * step;
  }

  return opticalDepth;
}
`;

/**
 * Distance to a sphere along a ray, near or far root, or -1 for a miss.
 *
 * Returns the raw root, negative values included, exactly as the reference
 * does — every caller reads the sign, so clamping here would be a silent
 * divergence from the code this is a port of.
 */
export const CLOUD_SPHERE_HIT_WGSL = /* wgsl */ `
fn cloudSphereHit( r: f32, mu: f32, radius: f32, nearRoot: bool ) -> f32 {
  let discriminant = r * r * ( mu * mu - 1.0 ) + radius * radius;
  if ( discriminant < 0.0 ) { return -1.0; }

  let root = sqrt( discriminant );
  return select( -r * mu + root, -r * mu - root, nearRoot );
}
`;

/**
 * March a view ray through the cloud shell.
 *
 * The layer is two concentric spheres, not a flat slab. At Terrin's radius a
 * level ray has left a flat slab after about 65 km while the real deck stays
 * visible for hundreds — the flat version answered that by marching through a
 * layer it could never leave, which is a wall across the horizon.
 *
 * Returns scattered light in rgb and, in alpha, how much of the background the
 * clouds hide.
 */
export const CLOUD_MARCH_WGSL = /* wgsl */ `
fn marchCloudLayer(
  origin: vec3<f32>,
  direction: vec3<f32>,
  sunDirection: vec3<f32>,
  layerA: vec4<f32>,
  layerB: vec4<f32>,
  layerC: vec4<f32>,
  jitter: f32,
  maxDistance: f32,
  shapeTex: texture_3d<f32>,
  shapeSampler: sampler,
  detailTex: texture_3d<f32>,
  detailSampler: sampler,
  weatherTex: texture_3d<f32>,
  weatherSampler: sampler
) -> vec4<f32> {
  let planetRadius = layerA.x;
  let inner = planetRadius + layerA.y;
  let outer = planetRadius + layerA.z;

  let r = length( origin );
  if ( r <= 0.0 ) { return vec4<f32>( 0.0 ); }

  let mu = dot( origin, direction ) / r;

  let innerNear = cloudSphereHit( r, mu, inner, true );

  var near = 0.0;
  var far = 0.0;

  if ( r > outer ) {
    near = cloudSphereHit( r, mu, outer, true );
    if ( near < 0.0 ) { return vec4<f32>( 0.0 ); }
    far = select( cloudSphereHit( r, mu, outer, false ), innerNear, innerNear > 0.0 );
  } else if ( r < inner ) {
    // Below the layer, every ray reaches the base eventually — including ones
    // pointed at the ground, which is the one case the planet has to be tested
    // for. Everywhere else the march already stops at the cloud base.
    if ( mu < 0.0 && cloudSphereHit( r, mu, planetRadius, true ) >= 0.0 ) {
      return vec4<f32>( 0.0 );
    }
    near = cloudSphereHit( r, mu, inner, false );
    if ( near < 0.0 ) { return vec4<f32>( 0.0 ); }
    far = cloudSphereHit( r, mu, outer, false );
  } else {
    near = 0.0;
    far = select( cloudSphereHit( r, mu, outer, false ), innerNear, innerNear > 0.0 );
  }

  far = min( far, maxDistance );
  near = max( 0.0, near );

  let span = far - near;
  if ( span <= 0.0 ) { return vec4<f32>( 0.0 ); }

  // The distance spent inside the layer runs from 3.5 km straight up to well
  // over a hundred grazing it, so a fixed count either wastes samples or steps
  // straight over clouds. Hold the step size instead.
  let wanted = ceil( span / 250.0 );
  let steps = clamp( wanted, 32.0, ${CLOUD_MAX_STEPS}.0 );
  let stepSize = span / steps;
  let stepCount = i32( steps );

  let cosTheta = dot( direction, sunDirection );

  var transmittance = 1.0;
  var luminance = 0.0;

  for ( var i = 0; i < ${CLOUD_MAX_STEPS}; i = i + 1 ) {
    if ( i >= stepCount ) { break; }

    let d = near + stepSize * ( f32( i ) + jitter );
    let p = origin + direction * d;

    let density = cloudDensityAt(
      p, layerA, layerB, layerC,
      shapeTex, shapeSampler, detailTex, detailSampler,
      weatherTex, weatherSampler );

    if ( density > 0.0 ) {
      let sunDepth = cloudLightMarch(
        p, sunDirection, layerA, layerB, layerC,
        shapeTex, shapeSampler, detailTex, detailSampler,
        weatherTex, weatherSampler );

      let inScatter = cloudMultiScatter( sunDepth, cosTheta );

      // Closed-form over the segment, as the atmosphere does: light scattered
      // at the start of a step is attenuated across the rest of it.
      let stepTransmittance = exp( -density * stepSize );
      luminance = luminance + transmittance * inScatter * ( 1.0 - stepTransmittance );
      transmittance = transmittance * stepTransmittance;

      if ( transmittance < 0.01 ) { break; }
    }
  }

  return vec4<f32>( vec3<f32>( luminance ), 1.0 - transmittance );
}
`;
