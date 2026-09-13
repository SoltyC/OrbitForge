/**
 * Uploads the precomputed transmittance table to the GPU.
 *
 * Point-sampled on purpose: the shader reads it with `textureLoad` and does
 * its own bilinear filtering. That sidesteps whether a given float format
 * happens to be filterable on a given device, which is not something that can
 * be checked without running on one.
 */
import {
  ClampToEdgeWrapping,
  DataTexture,
  FloatType,
  NearestFilter,
  RGBAFormat,
} from 'three/webgpu';
import type { TransmittanceLut } from '../../atmosphere/transmittance.js';

export function createTransmittanceTexture(lut: TransmittanceLut): DataTexture {
  const texture = new DataTexture(
    lut.data,
    lut.width,
    lut.height,
    RGBAFormat,
    FloatType,
  );

  // Clamping matters: wrapping would fetch horizon values for zenith lookups.
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  texture.name = 'transmittanceLut';

  return texture;
}
