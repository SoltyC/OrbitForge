/**
 * The sky shader: a WGSL transcription of atmosphere/scattering.ts.
 *
 * Deliberately a direct port rather than an independent implementation. The
 * TypeScript version is unit-tested against physical facts — blue zenith, red
 * sunset, black space, glowing limb, an inverted transmittance ratio that the
 * tests caught — so keeping the two in step means the shader inherits that
 * evidence instead of relying on "it looks about right".
 *
 * If you change the maths here, change it there too, and let the tests judge.
 *
 * The lookup table is read with `textureLoad` and filtered by hand rather than
 * through a sampler. That costs a few lines but removes two things that cannot
 * be verified without a GPU in the loop: sampler binding through TSL, and
 * whether the float format happens to be filterable on a given device.
 */

/**
 * Raymarch steps. Matches SCATTERING_SAMPLES in the reference implementation;
 * WGSL needs the bound as a literal.
 */
export const SHADER_SAMPLES = 32;

/** Henyey-Greenstein phase function. */
export const MIE_PHASE_WGSL = /* wgsl */ `
fn miePhaseHG( cosTheta: f32, g: f32 ) -> f32 {
  let gg = g * g;
  let denom = max( 1e-6, 1.0 + gg - 2.0 * g * cosTheta );
  return ( ( 1.0 - gg ) / ( 4.0 * 3.14159265 ) ) * pow( denom, -1.5 );
}
`;

/**
 * Bruneton's (r, mu) mapping. Parameterising by distance to the top boundary
 * rather than by mu directly concentrates texels near the horizon, where
 * transmittance changes fastest and banding would otherwise show.
 */
export const TRANSMITTANCE_UV_WGSL = /* wgsl */ `
fn transmittanceUv( r: f32, mu: f32, bottomRadius: f32, topRadius: f32 ) -> vec2<f32> {
  let H = sqrt( max( 0.0, topRadius * topRadius - bottomRadius * bottomRadius ) );
  let rho = sqrt( max( 0.0, r * r - bottomRadius * bottomRadius ) );

  let disc = r * r * ( mu * mu - 1.0 ) + topRadius * topRadius;
  let d = max( 0.0, -r * mu + sqrt( max( 0.0, disc ) ) );

  let dMin = topRadius - r;
  let dMax = rho + H;

  var u = 0.0;
  if ( dMax > dMin ) { u = clamp( ( d - dMin ) / ( dMax - dMin ), 0.0, 1.0 ); }

  var v = 0.0;
  if ( H > 0.0 ) { v = clamp( rho / H, 0.0, 1.0 ); }

  return vec2<f32>( u, v );
}
`;

/** Bilinear fetch from the transmittance table, filtered by hand. */
export const SAMPLE_TRANSMITTANCE_WGSL = /* wgsl */ `
fn sampleTransmittance(
  lut: texture_2d<f32>,
  r: f32,
  mu: f32,
  bottomRadius: f32,
  topRadius: f32,
  lutSize: vec2<f32>
) -> vec3<f32> {
  let clampedR = clamp( r, bottomRadius, topRadius );
  let uv = transmittanceUv( clampedR, mu, bottomRadius, topRadius );

  let coord = uv * lutSize - vec2<f32>( 0.5 );
  let base = floor( coord );
  let frac = coord - base;

  let maxXY = lutSize - vec2<f32>( 1.0 );
  let p00 = clamp( base, vec2<f32>( 0.0 ), maxXY );
  let p11 = clamp( base + vec2<f32>( 1.0 ), vec2<f32>( 0.0 ), maxXY );

  let c00 = textureLoad( lut, vec2<i32>( i32( p00.x ), i32( p00.y ) ), 0 ).rgb;
  let c10 = textureLoad( lut, vec2<i32>( i32( p11.x ), i32( p00.y ) ), 0 ).rgb;
  let c01 = textureLoad( lut, vec2<i32>( i32( p00.x ), i32( p11.y ) ), 0 ).rgb;
  let c11 = textureLoad( lut, vec2<i32>( i32( p11.x ), i32( p11.y ) ), 0 ).rgb;

  let top = mix( c00, c10, frac.x );
  let bottom = mix( c01, c11, frac.x );
  return mix( top, bottom, frac.y );
}
`;

/**
 * Transmittance over a segment, as the ratio of the two to-top values: the
 * shared outer part of the path cancels exactly.
 *
 * The order of the ratio matters. Inverting it yields values above 1 that
 * clamp to 1, silently removing all attenuation — which is precisely the bug
 * the reference implementation's tests caught.
 */
export const SEGMENT_TRANSMITTANCE_WGSL = /* wgsl */ `
fn segmentTransmittance(
  lut: texture_2d<f32>,
  r: f32,
  mu: f32,
  d: f32,
  bottomRadius: f32,
  topRadius: f32,
  groundHit: f32,
  lutSize: vec2<f32>
) -> vec3<f32> {
  let endRadius = clamp(
    sqrt( max( 0.0, d * d + 2.0 * r * mu * d + r * r ) ), bottomRadius, topRadius );
  let endMu = clamp( ( r * mu + d ) / max( 1.0, endRadius ), -1.0, 1.0 );

  var numerator = sampleTransmittance( lut, r, mu, bottomRadius, topRadius, lutSize );
  var denominator = sampleTransmittance(
    lut, endRadius, endMu, bottomRadius, topRadius, lutSize );

  if ( groundHit > 0.5 ) {
    numerator = sampleTransmittance(
      lut, endRadius, -endMu, bottomRadius, topRadius, lutSize );
    denominator = sampleTransmittance( lut, r, -mu, bottomRadius, topRadius, lutSize );
  }

  return clamp(
    numerator / max( denominator, vec3<f32>( 1e-6 ) ),
    vec3<f32>( 0.0 ),
    vec3<f32>( 1.0 ) );
}
`;

/**
 * The scattering integrator.
 *
 * `viewPosition` is the camera relative to the planet's centre, so the maths
 * stays in the frame the lookup table was built in no matter where the
 * floating origin has placed things in render space.
 */
export const SKY_RADIANCE_WGSL = /* wgsl */ `
fn skyRadiance(
  viewPosition: vec3<f32>,
  viewDirection: vec3<f32>,
  sunDirection: vec3<f32>,
  bottomRadius: f32,
  topRadius: f32,
  rayleighScattering: vec3<f32>,
  rayleighScaleHeight: f32,
  mieScattering: f32,
  mieScaleHeight: f32,
  miePhaseG: f32,
  sunIntensity: f32,
  lut: texture_2d<f32>,
  lutSize: vec2<f32>
) -> vec3<f32> {
  let r = length( viewPosition );
  if ( r < 1.0 ) { return vec3<f32>( 0.0 ); }

  let up = viewPosition / r;
  let mu = clamp( dot( up, viewDirection ), -1.0, 1.0 );
  let muSun = clamp( dot( up, sunDirection ), -1.0, 1.0 );
  let nu = clamp( dot( viewDirection, sunDirection ), -1.0, 1.0 );

  let topDisc = r * r * ( mu * mu - 1.0 ) + topRadius * topRadius;
  if ( topDisc < 0.0 ) { return vec3<f32>( 0.0 ); }
  let topSqrt = sqrt( topDisc );

  // From outside the atmosphere, skip forward to where the ray enters it so
  // every sample lands in air rather than vacuum.
  var start = 0.0;
  if ( r > topRadius ) {
    let entry = -r * mu - topSqrt;
    if ( entry < 0.0 ) { return vec3<f32>( 0.0 ); }
    start = entry;
  }

  var end = -r * mu + topSqrt;

  let groundDisc = r * r * ( mu * mu - 1.0 ) + bottomRadius * bottomRadius;
  var groundHit = 0.0;
  if ( mu < 0.0 && groundDisc >= 0.0 ) {
    groundHit = 1.0;
    end = max( 0.0, -r * mu - sqrt( groundDisc ) );
  }

  let span = end - start;
  if ( span <= 0.0 ) { return vec3<f32>( 0.0 ); }

  let stepSize = span / ${SHADER_SAMPLES}.0;
  let rayleighPhaseValue = ( 3.0 / ( 16.0 * 3.14159265 ) ) * ( 1.0 + nu * nu );
  let miePhaseValue = miePhaseHG( nu, miePhaseG );

  var radiance = vec3<f32>( 0.0 );

  for ( var i = 0; i < ${SHADER_SAMPLES}; i = i + 1 ) {
    // Midpoint rule: sampling at segment edges over-weights the dense air
    // nearest the viewer and visibly over-brightens the horizon.
    let d = start + stepSize * ( f32( i ) + 0.5 );

    let sampleRadius = sqrt( max( 0.0, d * d + 2.0 * r * mu * d + r * r ) );
    let altitude = max( 0.0, sampleRadius - bottomRadius );
    let sampleMuSun = clamp( ( r * muSun + d * nu ) / max( 1.0, sampleRadius ), -1.0, 1.0 );

    // Sunlight reaching this point, zero where the planet is in the way.
    var sunT = vec3<f32>( 0.0 );
    let sunDisc = sampleRadius * sampleRadius * ( sampleMuSun * sampleMuSun - 1.0 )
      + bottomRadius * bottomRadius;
    if ( !( sampleMuSun < 0.0 && sunDisc >= 0.0 ) ) {
      sunT = sampleTransmittance(
        lut, sampleRadius, sampleMuSun, bottomRadius, topRadius, lutSize );
    }

    let viewT = segmentTransmittance(
      lut, r, mu, d, bottomRadius, topRadius, groundHit, lutSize );

    let rayleigh = rayleighScattering * exp( -altitude / rayleighScaleHeight );
    let mie = mieScattering * exp( -altitude / mieScaleHeight );

    let scattered = rayleigh * rayleighPhaseValue + vec3<f32>( mie * miePhaseValue );
    radiance = radiance + scattered * sunT * viewT * stepSize;
  }

  return radiance * sunIntensity;
}
`;
