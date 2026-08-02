import { encodePNG } from './png/encode.ts';
import type { DecodedImage } from './png/decode.ts';
import { Surface, parseHexColor } from './raster/surface.ts';
import { fillDisc, strokeRing, fillRoundedRect } from './raster/shapes.ts';
import { circularMask } from './raster/mask.ts';
import { resizeRGBA } from './raster/resize.ts';
import { slotPositions } from './layout.ts';

export const BASE_WIDTH = 375;
export const BASE_HEIGHT = 144;

/** A decoded image plus the content hash used in the cache key. */
export interface ImageRef extends DecodedImage {
  hash: string;
}

/**
 * Everything a strip's appearance depends on — and nothing else.
 *
 * There is deliberately no customer, pass, serial or merchant field here.
 * An 8-stamp card has 9 possible strips, not one per holder (BUILD.md §10).
 */
export interface StripSpec {
  goal: number;
  filled: number;
  shape: 'circle' | 'square';
  bgColor: string;
  bgOpacity: number;
  activeColor: string;
  inactiveColor: string;
  logo?: ImageRef;
  cover?: ImageRef;
  scale: 1 | 2 | 3;
}

export function renderStrip(spec: StripSpec): Buffer {
  if (!Number.isInteger(spec.filled) || spec.filled < 0 || spec.filled > spec.goal) {
    throw new RangeError(`filled must be an integer in 0..${spec.goal}, got ${spec.filled}`);
  }
  if (spec.bgOpacity < 0 || spec.bgOpacity > 1) {
    throw new RangeError(`bgOpacity must be 0..1, got ${spec.bgOpacity}`);
  }

  const width = BASE_WIDTH * spec.scale;
  const height = BASE_HEIGHT * spec.scale;
  const surface = new Surface(width, height);

  // 1. Background — the merchant's cover image if there is one, else flat colour.
  surface.fill(parseHexColor(spec.bgColor, spec.bgOpacity));
  if (spec.cover) {
    const cover = resizeRGBA(spec.cover, width, height);
    const alpha = spec.bgOpacity;
    for (let i = 0; i < width * height; i++) {
      const o = i * 4;
      surface.blend(i % width, Math.floor(i / width), {
        r: cover.rgba[o]!, g: cover.rgba[o + 1]!, b: cover.rgba[o + 2]!,
        a: (cover.rgba[o + 3]! / 255) * alpha,
      }, 1);
    }
  }

  // 2. Slots.
  const active = parseHexColor(spec.activeColor);
  const inactive = parseHexColor(spec.inactiveColor);
  const positions = slotPositions(spec.goal, width, height);
  const maskedLogo = spec.logo
    ? circularMask(spec.logo, Math.max(2, Math.round(positions[0]!.r * 2)), Math.max(1, positions[0]!.r * 0.12))
    : undefined;

  for (let i = 0; i < positions.length; i++) {
    const p = positions[i]!;
    const isFilled = i < spec.filled;

    if (spec.shape === 'square') {
      const size = p.r * 2;
      const radius = p.r * 0.28;
      if (isFilled) fillRoundedRect(surface, p.x - p.r, p.y - p.r, size, size, radius, active);
      else {
        // Hollow square: draw the outline as four thin filled rects.
        const t = Math.max(1, p.r * 0.16);
        fillRoundedRect(surface, p.x - p.r, p.y - p.r, size, t, 0, inactive);
        fillRoundedRect(surface, p.x - p.r, p.y + p.r - t, size, t, 0, inactive);
        fillRoundedRect(surface, p.x - p.r, p.y - p.r, t, size, 0, inactive);
        fillRoundedRect(surface, p.x + p.r - t, p.y - p.r, t, size, 0, inactive);
      }
      continue;
    }

    if (!isFilled) {
      strokeRing(surface, p.x, p.y, p.r, Math.max(1, p.r * 0.16), inactive);
    } else if (maskedLogo) {
      const size = maskedLogo.width;
      const ox = Math.round(p.x - size / 2);
      const oy = Math.round(p.y - size / 2);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const o = (y * size + x) * 4;
          const a = maskedLogo.rgba[o + 3]! / 255;
          if (a > 0) {
            surface.blend(ox + x, oy + y, {
              r: maskedLogo.rgba[o]!, g: maskedLogo.rgba[o + 1]!, b: maskedLogo.rgba[o + 2]!, a,
            }, 1);
          }
        }
      }
    } else {
      fillDisc(surface, p.x, p.y, p.r, active);
    }
  }

  return encodePNG(surface.toRGBA(), width, height);
}
