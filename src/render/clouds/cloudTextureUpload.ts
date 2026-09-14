/**
 * Uploads the baked cloud noise to the GPU as 3D textures.
 *
 * Unlike the atmosphere's transmittance table, these are sampled with real
 * hardware filtering rather than filtered by hand. The march needs seven
 * density samples per view step — one for the view, six towards the sun — and
 * each density reads three textures. Doing trilinear manually would be eight
 * fetches apiece, which is the difference between a shader and a slideshow.
 *
 * The formats are chosen for that: single-byte channels are filterable
 * everywhere, so no optional device feature is involved.
 */
import {
  Data3DTexture,
  LinearFilter,
  RGFormat,
  RedFormat,
  RepeatWrapping,
  UnsignedByteType,
} from 'three/webgpu';
import type { CloudTextures } from '../../clouds/textures.js';
import {
  DETAIL_RESOLUTION,
  SHAPE_RESOLUTION,
  WEATHER_RESOLUTION,
} from '../../clouds/textures.js';

export interface CloudTextureHandles {
  readonly shape: Data3DTexture;
  readonly detail: Data3DTexture;
  readonly weather: Data3DTexture;
  dispose(): void;
}

export function uploadCloudTextures(baked: CloudTextures): CloudTextureHandles {
  const shape = create(baked.shape, SHAPE_RESOLUTION, RedFormat, 'cloudShape');
  const detail = create(baked.detail, DETAIL_RESOLUTION, RedFormat, 'cloudDetail');
  const weather = create(baked.weather, WEATHER_RESOLUTION, RGFormat, 'cloudWeather');

  return {
    shape,
    detail,
    weather,
    dispose() {
      shape.dispose();
      detail.dispose();
      weather.dispose();
    },
  };
}

function create(
  data: Uint8Array,
  resolution: number,
  format: typeof RedFormat | typeof RGFormat,
  name: string,
): Data3DTexture {
  const texture = new Data3DTexture(data, resolution, resolution, resolution);

  texture.format = format;
  texture.type = UnsignedByteType;

  // The noise tiles, and the march reads far outside the unit cube. Repeat
  // wrapping is what makes that work; clamping would smear the edge texels
  // across the sky.
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.wrapR = RepeatWrapping;

  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
  texture.name = name;
  texture.needsUpdate = true;

  return texture;
}
