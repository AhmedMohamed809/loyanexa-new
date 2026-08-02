import type { DecodedImage } from '../png/decode.ts';
import { resizeRGBA } from './resize.ts';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Crop `src` to a circle of `size` px. `rimWidth` darkens the outermost ring
 * so a logo that is nearly white still reads as a stamp against a white card
 * (BUILD.md §9.2).
 */
export function circularMask(src: DecodedImage, size: number, rimWidth = 0): DecodedImage {
  if (size <= 0) throw new RangeError('size must be positive');
  const scaled = resizeRGBA(src, size, size);
  const out = new Uint8Array(size * size * 4);
  const c = size / 2;
  const r = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      const cov = clamp01(r + 0.5 - d);
      out[i] = scaled.rgba[i]!;
      out[i + 1] = scaled.rgba[i + 1]!;
      out[i + 2] = scaled.rgba[i + 2]!;
      out[i + 3] = Math.round(scaled.rgba[i + 3]! * cov);

      if (rimWidth > 0 && cov > 0) {
        // Strength ramps from 0 at (r - rimWidth) to 1 at the edge.
        const t = clamp01((d - (r - rimWidth)) / rimWidth);
        if (t > 0) {
          const k = 1 - 0.45 * t;
          out[i] = Math.round(out[i]! * k);
          out[i + 1] = Math.round(out[i + 1]! * k);
          out[i + 2] = Math.round(out[i + 2]! * k);
        }
      }
    }
  }
  return { width: size, height: size, rgba: out };
}
