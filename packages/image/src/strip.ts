import { encodePNG } from './png/encode.ts';
import type { DecodedImage } from './png/decode.ts';
import { Surface, parseHexColor } from './raster/surface.ts';
import { fillDisc, strokeRing, fillRoundedRect } from './raster/shapes.ts';
import { circularMask } from './raster/mask.ts';
import { resizeRGBA, type Fit } from './raster/resize.ts';
import { slotPositions } from './layout.ts';
import { drawBuiltinIcon, type BuiltinIconId } from './raster/icons.ts';

export const BASE_WIDTH = 375;
export const BASE_HEIGHT = 144;

/**
 * A decoded image plus the content hash used in the cache key.
 *
 * `hash` must uniquely determine `rgba` — it is the *sole* cache identity a
 * strip has for this image (see `stripCacheKey` in stripCache.ts, which
 * hashes `logo?.hash` / `cover?.hash` and never touches the pixels). Compute
 * it with `imageHash()` (imageHash.ts) over the original encoded upload
 * bytes. Never derive it from a URL, filename, or timestamp: doing so can
 * make one merchant's logo get served in place of another's, or make a
 * merchant's own logo miss the cache on every request.
 */
export interface ImageRef extends DecodedImage {
  hash: string;
}

/**
 * Which artwork fills a *completed* stamp slot (BUILD.md §8.5 step 2's
 * three-way choice) — an empty slot is always the same hollow ring
 * regardless of this value.
 *
 * - `'builtin'` — a glyph drawn by packages/image/src/raster/icons.ts
 *   (`builtinIcon` below picks which one). The default: a card looks
 *   designed with zero uploads.
 * - `'icon'` — the merchant's own uploaded square-ish mark (`icon` below),
 *   masked into the circle exactly like the old "logo as stamp" did.
 * - `'plain'` — a solid disc, the original, upload-free behaviour.
 */
export type StampSource = 'builtin' | 'icon' | 'plain';

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
  /**
   * See `StampSource`'s own doc comment. Only meaningful for `shape:
   * 'circle'` — a square slot has never supported anything but a plain
   * filled/hollow rounded rect (see the render loop below), same
   * limitation this had before `icon`/`builtinIcon` existed.
   */
  stampSource?: StampSource;
  /**
   * The merchant's own uploaded icon, used when `stampSource === 'icon'`.
   * Renamed from the old `logo` field — a wordmark logo is never masked
   * into a stamp any more (see mask.ts's own doc comment on why a wide
   * wordmark reads illegibly at stamp size); this is always meant to be a
   * square-ish mark.
   */
  icon?: ImageRef;
  /**
   * How `icon` maps onto the round stamp slot when `stampSource ===
   * 'icon'` — see `circularMask`'s own doc comment. Defaults to
   * `'contain'`. Renamed from `logoFit`: the same Fit/Fill choice, now
   * correctly scoped to the icon (the logo itself never needs a fit — it
   * only ever appears in the pass header/enrol page at its own aspect
   * ratio).
   */
  iconFit?: Fit;
  /** Which built-in icon to draw when `stampSource === 'builtin'`. */
  builtinIcon?: BuiltinIconId;
  cover?: ImageRef;
  scale: 1 | 2 | 3;
}

export function renderStrip(spec: StripSpec): Buffer {
  if (spec.bgOpacity < 0 || spec.bgOpacity > 1) {
    throw new RangeError(`bgOpacity must be 0..1, got ${spec.bgOpacity}`);
  }

  const width = BASE_WIDTH * spec.scale;
  const height = BASE_HEIGHT * spec.scale;
  const surface = new Surface(width, height);

  // slotPositions validates `goal` — do this before validating `filled` against
  // it, so an out-of-range goal is reported as a goal problem, not a filled one.
  const positions = slotPositions(spec.goal, width, height);
  if (!Number.isInteger(spec.filled) || spec.filled < 0 || spec.filled > spec.goal) {
    throw new RangeError(`filled must be an integer in 0..${spec.goal}, got ${spec.filled}`);
  }

  // 1. Background — the merchant's cover image if there is one, else flat colour.
  surface.fill(parseHexColor(spec.bgColor, 1));
  if (spec.cover) {
    const cover = resizeRGBA(spec.cover, width, height);
    for (let i = 0; i < width * height; i++) {
      const o = i * 4;
      surface.blend(i % width, Math.floor(i / width), {
        r: cover.rgba[o]!, g: cover.rgba[o + 1]!, b: cover.rgba[o + 2]!,
        a: cover.rgba[o + 3]! / 255,
      }, 1);
    }
  }
  // Apply background opacity once, to the composed background layer. Doing it
  // during the fill and again during the cover blend compounds it.
  if (spec.bgOpacity < 1) {
    const data = surface.data;
    for (let i = 3; i < data.length; i += 4) data[i] = data[i]! * spec.bgOpacity;
  }

  // 2. Slots.
  const active = parseHexColor(spec.activeColor);
  const inactive = parseHexColor(spec.inactiveColor);
  // Circular masking only makes sense for round slots; square slots do not
  // currently support icon stamps, so skip the (otherwise wasted) mask work.
  const maskedIcon = spec.icon && spec.shape === 'circle' && spec.stampSource === 'icon'
    ? circularMask(
        spec.icon,
        Math.max(2, Math.round(positions[0]!.r * 2)),
        Math.max(1, positions[0]!.r * 0.12),
        spec.iconFit
      )
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
    } else if (maskedIcon) {
      const size = maskedIcon.width;
      const ox = Math.round(p.x - size / 2);
      const oy = Math.round(p.y - size / 2);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const o = (y * size + x) * 4;
          const a = maskedIcon.rgba[o + 3]! / 255;
          if (a > 0) {
            surface.blend(ox + x, oy + y, {
              r: maskedIcon.rgba[o]!, g: maskedIcon.rgba[o + 1]!, b: maskedIcon.rgba[o + 2]!, a,
            }, 1);
          }
        }
      }
    } else if (spec.stampSource === 'builtin' && spec.builtinIcon) {
      drawBuiltinIcon(surface, p.x, p.y, p.r * 0.82, active, spec.builtinIcon);
    } else {
      fillDisc(surface, p.x, p.y, p.r, active);
    }
  }

  return encodePNG(surface.toRGBA(), width, height);
}
