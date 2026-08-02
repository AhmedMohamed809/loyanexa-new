import type { RGBA, Surface } from './surface.ts';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Coverage of a pixel centre at distance `d` from an edge at radius `r`.
 * A half-pixel ramp is a good approximation of exact area coverage and is
 * what keeps stamp circles from looking jagged at @1x.
 */
const edge = (r: number, d: number): number => clamp01(r + 0.5 - d);

function bounds(s: Surface, cx: number, cy: number, r: number) {
  return {
    x0: Math.max(0, Math.floor(cx - r - 1)),
    x1: Math.min(s.width - 1, Math.ceil(cx + r + 1)),
    y0: Math.max(0, Math.floor(cy - r - 1)),
    y1: Math.min(s.height - 1, Math.ceil(cy + r + 1)),
  };
}

export function fillDisc(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  if (r <= 0) return;
  const { x0, x1, y0, y1 } = bounds(s, cx, cy, r);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const cov = edge(r, d);
      if (cov > 0) s.blend(x, y, c, cov);
    }
  }
}

/** An annulus centred on `r`, `thickness` px wide. */
export function strokeRing(
  s: Surface,
  cx: number,
  cy: number,
  r: number,
  thickness: number,
  c: RGBA
): void {
  if (r <= 0 || thickness <= 0) return;
  const outer = r + thickness / 2;
  const inner = Math.max(0, r - thickness / 2);
  const { x0, x1, y0, y1 } = bounds(s, cx, cy, outer);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      // Inside the outer edge AND outside the inner edge.
      const cov = edge(outer, d) * (inner === 0 ? 1 : clamp01(d - inner + 0.5));
      if (cov > 0) s.blend(x, y, c, cov);
    }
  }
}

export function fillRoundedRect(
  s: Surface,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  c: RGBA
): void {
  if (w <= 0 || h <= 0) return;
  const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
  const cx = x + w / 2;
  const cy = y + h / 2;
  const hx = w / 2 - r;
  const hy = h / 2 - r;

  const x0 = Math.max(0, Math.floor(x - 1));
  const x1 = Math.min(s.width - 1, Math.ceil(x + w + 1));
  const y0 = Math.max(0, Math.floor(y - 1));
  const y1 = Math.min(s.height - 1, Math.ceil(y + h + 1));

  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      // Signed distance to the rounded rectangle: negative inside, positive
      // outside, zero on the boundary. Keeping the sign is what the previous
      // clamp-to-zero version threw away.
      const qx = Math.abs(px + 0.5 - cx) - hx;
      const qy = Math.abs(py + 0.5 - cy) - hy;
      const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
      const inside = Math.min(Math.max(qx, qy), 0);
      const d = outside + inside - r;
      const cov = clamp01(0.5 - d);
      if (cov > 0) s.blend(px, py, c, cov);
    }
  }
}
