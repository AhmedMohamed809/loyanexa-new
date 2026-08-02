import jpeg from 'jpeg-js';
import { decodePNG, type DecodedImage } from './png/decode.ts';

export function decodeJPEG(buf: Uint8Array): DecodedImage {
  const out = jpeg.decode(Buffer.from(buf), { useTArray: true, formatAsRGBA: true });
  return { width: out.width, height: out.height, rgba: new Uint8Array(out.data) };
}

/** Decode a merchant upload, sniffing PNG vs JPEG from its magic bytes. */
export function decodeImage(buf: Uint8Array): DecodedImage {
  if (buf[0] === 0x89 && buf[1] === 0x50) return decodePNG(buf);
  if (buf[0] === 0xff && buf[1] === 0xd8) return decodeJPEG(buf);
  throw new Error('unsupported image format: expected PNG or JPEG');
}
