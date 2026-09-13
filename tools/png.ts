/**
 * Minimal PNG encoder, so reference renders can be written without pulling in
 * an image library for a job this small.
 */
import { deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Encode 8-bit RGB pixel data as a PNG. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  // Each scanline is prefixed with a filter byte; 0 means "no filtering".
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);

  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);

  return Buffer.concat([length, typeAndData, crc]);
}

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);

  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }

  return table;
}

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
