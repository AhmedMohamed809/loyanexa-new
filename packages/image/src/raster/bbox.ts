import type { DecodedImage } from '../png/decode.ts';

/**
 * The bounding box of `img`'s non-transparent pixels (alpha strictly above
 * `threshold`, default 8 to ignore the anti-aliased fringe rather than any
 * genuine content). Returns `undefined` when the image is fully transparent.
 *
 * The intended use is recovering a logo's original aspect ratio after
 * `resizeToFit(..., 'contain')` has letterboxed it onto a square canvas
 * (`normalizeUpload` in apps/demo/cardImages.ts does exactly this): a
 * uniform scale preserves aspect ratio, so the opaque region's own
 * width/height ratio equals the source image's — no need to store the
 * original dimensions separately.
 */
export function opaqueBoundingBox(img: DecodedImage, threshold = 8): { width: number; height: number } | undefined {
  let minX = img.width;
  let minY = img.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const a = img.rgba[(y * img.width + x) * 4 + 3]!;
      if (a > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) return undefined;
  return { width: maxX - minX + 1, height: maxY - minY + 1 };
}
