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
      let pr = 0, pg = 0, pb = 0, pa = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * src.width + xx) * 4;
          const a = src.rgba[i + 3]! / 255;
          pr += src.rgba[i]! * a;
          pg += src.rgba[i + 1]! * a;
          pb += src.rgba[i + 2]! * a;
          pa += a;
          n++;
        }
      }
      const o = (y * width + x) * 4;
      out[o + 3] = Math.round((pa / n) * 255);
      if (pa > 0) {
        out[o] = Math.round(pr / pa);
        out[o + 1] = Math.round(pg / pa);
        out[o + 2] = Math.round(pb / pa);
      } else {
        out[o] = 0; out[o + 1] = 0; out[o + 2] = 0;
      }
    }
  }
  return { width, height, rgba: out };
}

/** How `resizeToFit` maps a source aspect ratio onto a differently-shaped target. */
export type Fit = 'contain' | 'cover';

/**
 * Scales `src` to `targetWidth`×`targetHeight` while preserving its aspect
 * ratio, unlike `resizeRGBA` which stretches to fill exactly. Two modes:
 *
 * - `'contain'` (default): the whole source fits inside the target, centred,
 *   with the leftover border left fully transparent. Nothing is cropped.
 * - `'cover'`: the source fills the target completely, centred, with the
 *   overflow cropped off. Nothing is left transparent.
 *
 * A source that already matches the target's aspect ratio (the common case
 * of a square logo going into a square slot) produces the same result under
 * either mode — there is no leftover border and nothing to crop.
 */
export function resizeToFit(
  src: DecodedImage,
  targetWidth: number,
  targetHeight: number,
  fit: Fit = 'contain'
): DecodedImage {
  if (targetWidth <= 0 || targetHeight <= 0) throw new RangeError('target size must be positive');

  const scale =
    fit === 'cover'
      ? Math.max(targetWidth / src.width, targetHeight / src.height)
      : Math.min(targetWidth / src.width, targetHeight / src.height);
  const scaledWidth = Math.max(1, Math.round(src.width * scale));
  const scaledHeight = Math.max(1, Math.round(src.height * scale));
  const scaled = resizeRGBA(src, scaledWidth, scaledHeight);

  const out = new Uint8Array(targetWidth * targetHeight * 4);

  if (fit === 'contain') {
    // scaled fits entirely inside the target (or matches one dimension
    // exactly) — centre it on a transparent canvas, the `out` array's own
    // zero-initialised default.
    const offsetX = Math.floor((targetWidth - scaledWidth) / 2);
    const offsetY = Math.floor((targetHeight - scaledHeight) / 2);
    for (let y = 0; y < scaledHeight; y++) {
      const dy = y + offsetY;
      if (dy < 0 || dy >= targetHeight) continue;
      for (let x = 0; x < scaledWidth; x++) {
        const dx = x + offsetX;
        if (dx < 0 || dx >= targetWidth) continue;
        const si = (y * scaledWidth + x) * 4;
        const di = (dy * targetWidth + dx) * 4;
        out[di] = scaled.rgba[si]!;
        out[di + 1] = scaled.rgba[si + 1]!;
        out[di + 2] = scaled.rgba[si + 2]!;
        out[di + 3] = scaled.rgba[si + 3]!;
      }
    }
  } else {
    // scaled fills (or overflows) the target — crop the excess evenly from
    // both sides. Clamp the source read to guard against a ±1px rounding
    // mismatch between `scale` and the target size.
    const cropX = Math.floor((scaledWidth - targetWidth) / 2);
    const cropY = Math.floor((scaledHeight - targetHeight) / 2);
    for (let y = 0; y < targetHeight; y++) {
      const sy = Math.min(scaledHeight - 1, Math.max(0, y + cropY));
      for (let x = 0; x < targetWidth; x++) {
        const sx = Math.min(scaledWidth - 1, Math.max(0, x + cropX));
        const si = (sy * scaledWidth + sx) * 4;
        const di = (y * targetWidth + x) * 4;
        out[di] = scaled.rgba[si]!;
        out[di + 1] = scaled.rgba[si + 1]!;
        out[di + 2] = scaled.rgba[si + 2]!;
        out[di + 3] = scaled.rgba[si + 3]!;
      }
    }
  }

  return { width: targetWidth, height: targetHeight, rgba: out };
}
