import type { DecodedImage } from '../png/decode.ts';

/**
 * Box-filter resample. Averaging every source pixel that falls inside a
 * destination pixel is what stops a downscaled logo from shimmering; nearest
 * neighbour would alias badly at stamp sizes.
 */
export function resizeRGBA(src: DecodedImage, width: number, height: number): DecodedImage {
  if (width <= 0 || height <= 0) throw new RangeError('target size must be positive');
  const out = new Uint8Array(width * height * 4);
  const sx = src.width / width;
  const sy = src.height / height;

  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(src.height, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(src.width, Math.ceil((x + 1) * sx)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * src.width + xx) * 4;
          r += src.rgba[i]!; g += src.rgba[i + 1]!; b += src.rgba[i + 2]!; a += src.rgba[i + 3]!;
          n++;
        }
      }
      const o = (y * width + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width, height, rgba: out };
}
