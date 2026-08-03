import { parseHexColor } from './raster/surface.ts';

/** WCAG relative luminance (0..1) of an sRGB hex colour. */
function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHexColor(hex);
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * WCAG contrast ratio between two hex colours: 1 (identical) .. 21
 * (black on white). Order does not matter. Used by the card designer to
 * warn (not block — it is the merchant's brand) when a stamp colour is too
 * close to the background to read reliably; WCAG's own AA threshold for
 * large text/graphics is 3:1, which is what the designer checks against.
 */
export function contrastRatio(hexA: string, hexB: string): number {
  const a = relativeLuminance(hexA);
  const b = relativeLuminance(hexB);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The hex colour the merchant actually sees as the strip's flat background,
 * approximating `bgColor` composited at `bgOpacity` — a lower opacity lets
 * more of whatever sits behind the strip show through. There is no single
 * representative colour once a cover photo is involved (its pixels vary),
 * so this is deliberately a heuristic: it blends `bgColor` toward white,
 * the common case of a pass rendered on a light background. Good enough for
 * a non-blocking warning, not a claim of pixel-exact accuracy.
 */
export function effectiveBackgroundHex(bgColor: string, bgOpacity: number): string {
  const clamped = Math.min(1, Math.max(0, bgOpacity));
  const { r, g, b } = parseHexColor(bgColor);
  const mix = (c: number): number => Math.round(c * clamped + 255 * (1 - clamped));
  const toHex = (c: number): string => c.toString(16).padStart(2, '0');
  return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`;
}
