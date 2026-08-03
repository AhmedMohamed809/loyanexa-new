// packages/image/src/raster/icons.ts — the built-in stamp icon set (BUILD.md
// §8.5 step 2's icon picker). Drawn procedurally with this package's own
// raster primitives (Surface.blend, fillDisc, strokeRing, fillRoundedRect) —
// no image files, no icon font, no new dependency. Vector-drawn at whatever
// size the caller asks for, so it stays crisp at @1x/@2x/@3x instead of
// resampling a fixed bitmap.
//
// Ten icons, chosen to cover the businesses docs/BUILD.md §1 names (cafés,
// bakeries, barbers, salons, car washes, gyms) plus a handful of generic
// marks any merchant can reach for. Ten deliberately — a hundred mediocre
// icons is worse than ten that read clearly at 22px (the smallest a stamp
// gets, at goal 20 scale 1 — see MIN_STAMP_DIAMETER_NOTE below).
//
// fillDisc/strokeRing/fillRoundedRect cover circles, rings and rounded
// rects; several of these glyphs (a scissors blade, a star point, a
// croissant's crescent) need a straight stroke, a filled polygon or a
// disc-minus-offset-disc cutout that none of the three can express alone.
// Rather than reach for a new dependency, `paintCoverage` below generalises
// the exact analytic-coverage technique fillDisc/strokeRing/fillRoundedRect
// already use (a per-pixel 0..1 coverage function fed into Surface.blend) —
// still nothing but Surface under the hood.

import { Surface, type RGBA } from './surface.ts';
import { fillDisc, strokeRing, fillRoundedRect } from './shapes.ts';
import { encodePNG } from '../png/encode.ts';

export type BuiltinIconId =
  | 'coffee'
  | 'croissant'
  | 'scissors'
  | 'flower'
  | 'car'
  | 'dumbbell'
  | 'star'
  | 'heart'
  | 'check'
  | 'gift';

/** Every built-in icon id, in the order the designer's picker shows them. */
export const BUILTIN_ICON_IDS: readonly BuiltinIconId[] = [
  'coffee',
  'croissant',
  'scissors',
  'flower',
  'car',
  'dumbbell',
  'star',
  'heart',
  'check',
  'gift',
];

/** True for any string that names a real built-in icon — the guard every caller reading one off a query string or a Card row needs before trusting it. */
export function isBuiltinIconId(value: string | null | undefined): value is BuiltinIconId {
  return typeof value === 'string' && (BUILTIN_ICON_IDS as readonly string[]).includes(value);
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Paints `color` into every pixel of the bounding box whose centre `cov(x,
 * y)` reports positive coverage (0..1, source-over via Surface.blend) — the
 * same per-pixel analytic-coverage pattern fillDisc/strokeRing/
 * fillRoundedRect use internally, generalised so a handful of icon-only
 * shapes below (capsule, convex polygon, crescent) can be expressed without
 * a new drawing dependency. Bounds are clamped to the surface, same as the
 * three exported primitives.
 */
function paintCoverage(
  s: Surface,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: RGBA,
  cov: (x: number, y: number) => number
): void {
  const ix0 = Math.max(0, Math.floor(x0));
  const ix1 = Math.min(s.width - 1, Math.ceil(x1));
  const iy0 = Math.max(0, Math.floor(y0));
  const iy1 = Math.min(s.height - 1, Math.ceil(y1));
  for (let y = iy0; y <= iy1; y++) {
    for (let x = ix0; x <= ix1; x++) {
      const c = cov(x + 0.5, y + 0.5);
      if (c > 0) s.blend(x, y, color, c);
    }
  }
}

function discCoverage(px: number, py: number, cx: number, cy: number, r: number): number {
  return clamp01(r + 0.5 - Math.hypot(px - cx, py - cy));
}

/** A thick straight stroke from (ax,ay) to (bx,by), radius `r`, round caps — a 2D capsule. Used for scissors blades, the dumbbell bar, and the checkmark. */
function fillCapsule(s: Surface, ax: number, ay: number, bx: number, by: number, r: number, color: RGBA): void {
  const abx = bx - ax;
  const aby = by - ay;
  const abLen2 = abx * abx + aby * aby || 1;
  paintCoverage(s, Math.min(ax, bx) - r - 1, Math.min(ay, by) - r - 1, Math.max(ax, bx) + r + 1, Math.max(ay, by) + r + 1, color, (px, py) => {
    const apx = px - ax;
    const apy = py - ay;
    const t = clamp01((apx * abx + apy * aby) / abLen2);
    return discCoverage(px, py, ax + abx * t, ay + aby * t, r);
  });
}

/**
 * A filled convex polygon (`pts` in either winding order) — the same
 * clamp(0.5 - distance) technique fillRoundedRect already uses for its
 * signed-distance edge, generalised from "distance to a rounded rect" to
 * "max distance to any of a convex shape's edges". Used for the star and
 * the heart's lower point.
 */
function fillConvexPolygon(s: Surface, pts: ReadonlyArray<readonly [number, number]>, color: RGBA): void {
  const n = pts.length;
  if (n < 3) return;
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i]!;
    const [x2, y2] = pts[(i + 1) % n]!;
    area2 += x1 * y2 - x2 * y1;
  }
  const sign = area2 < 0 ? -1 : 1;
  let x0 = Infinity, y0 = Infinity, x1b = -Infinity, y1b = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1b) x1b = x;
    if (y > y1b) y1b = y;
  }
  paintCoverage(s, x0 - 1, y0 - 1, x1b + 1, y1b + 1, color, (px, py) => {
    let maxD = -Infinity;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = pts[i]!;
      const [bx, by] = pts[(i + 1) % n]!;
      const ex = bx - ax;
      const ey = by - ay;
      const nx = sign * ey;
      const ny = -sign * ex;
      const len = Math.hypot(nx, ny) || 1;
      const d = ((px - ax) * nx + (py - ay) * ny) / len;
      if (d > maxD) maxD = d;
    }
    return clamp01(0.5 - maxD);
  });
}

/** A crescent: `r`-radius disc at (cx,cy) with a `cutR`-radius disc cut out, offset by (dx,dy) — the same subtractive-coverage idea strokeRing uses for a ring, generalised to an off-centre cut. Used for the croissant. */
function fillCrescent(s: Surface, cx: number, cy: number, r: number, dx: number, dy: number, cutR: number, color: RGBA): void {
  paintCoverage(s, cx - r - 1, cy - r - 1, cx + r + 1, cy + r + 1, color, (px, py) => {
    const outer = discCoverage(px, py, cx, cy, r);
    const inner = discCoverage(px, py, cx + dx, cy + dy, cutR);
    return clamp01(outer - inner);
  });
}

// ---------------------------------------------------------------------------
// The ten glyphs. Each draws into a circle of radius `r` centred at (cx,
// cy) — the same footprint fillDisc(surface, cx, cy, r, ...) would have
// occupied, so swapping "plain disc" for "built-in icon" never changes how
// much of the slot the stamp fills. Proportions are picked to still read as
// their subject at the smallest a stamp ever gets: r≈11px (goal 20, @1x) —
// see icons.test.ts's own render-at-every-scale test.
// ---------------------------------------------------------------------------

function drawCoffee(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  const bodyW = r * 1.2;
  const bodyH = r * 1.15;
  const bodyX = cx - bodyW * 0.62;
  const bodyY = cy - bodyH * 0.48;
  fillRoundedRect(s, bodyX, bodyY, bodyW, bodyH, bodyH * 0.22, c);
  const handleR = r * 0.34;
  const handleCx = bodyX + bodyW + handleR * 0.6;
  strokeRing(s, handleCx, cy, handleR, Math.max(1, r * 0.17), c);
}

function drawCroissant(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  const outerR = r * 0.86;
  fillCrescent(s, cx, cy, outerR, outerR * 0.55, -outerR * 0.05, outerR * 0.82, c);
}

function drawScissors(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  // A symmetric X pivoting just left of centre: two blades fan out to the
  // right (no loop — a real blade tip), two handle arms fan out to the
  // left, each ending in a finger loop. The first version of this icon
  // crossed the blades and handles asymmetrically, which at a 37px stamp
  // (goal 8, scale 1 — the size this was checked at) blurred into an
  // unreadable blob; this symmetric layout reads as an open pair of
  // scissors at every size down to a 22px stamp (goal 20, scale 1).
  const pivotX = cx - r * 0.05;
  const pivotY = cy;
  const armLen = r * 0.82;
  const thickness = Math.max(1, r * 0.2);
  fillCapsule(s, pivotX, pivotY, pivotX + armLen * 0.95, pivotY - armLen * 0.62, thickness, c);
  fillCapsule(s, pivotX, pivotY, pivotX + armLen * 0.95, pivotY + armLen * 0.62, thickness, c);
  const handleTipX = pivotX - armLen * 0.8;
  const handleTipYUp = pivotY - armLen * 0.58;
  const handleTipYDown = pivotY + armLen * 0.58;
  fillCapsule(s, pivotX, pivotY, handleTipX, handleTipYUp, thickness * 0.8, c);
  fillCapsule(s, pivotX, pivotY, handleTipX, handleTipYDown, thickness * 0.8, c);
  const loopR = r * 0.32;
  const loopT = Math.max(1, r * 0.15);
  strokeRing(s, handleTipX, handleTipYUp, loopR, loopT, c);
  strokeRing(s, handleTipX, handleTipYDown, loopR, loopT, c);
  fillDisc(s, pivotX, pivotY, thickness * 0.55, c);
}

function drawFlower(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  const petalR = r * 0.4;
  const orbit = r * 0.46;
  const petals = 5;
  for (let i = 0; i < petals; i++) {
    const a = (Math.PI * 2 * i) / petals - Math.PI / 2;
    fillDisc(s, cx + Math.cos(a) * orbit, cy + Math.sin(a) * orbit, petalR, c);
  }
  fillDisc(s, cx, cy, r * 0.3, c);
}

function drawCar(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  const bodyW = r * 1.7;
  const bodyH = r * 0.6;
  const bodyY = cy - bodyH * 0.1;
  fillRoundedRect(s, cx - bodyW / 2, bodyY, bodyW, bodyH, bodyH * 0.4, c);
  const cabinW = bodyW * 0.5;
  const cabinH = bodyH * 0.85;
  fillRoundedRect(s, cx - cabinW / 2, bodyY - cabinH * 0.72, cabinW, cabinH, cabinH * 0.35, c);
  const wheelR = r * 0.22;
  fillDisc(s, cx - bodyW * 0.28, bodyY + bodyH * 0.92, wheelR, c);
  fillDisc(s, cx + bodyW * 0.28, bodyY + bodyH * 0.92, wheelR, c);
}

function drawDumbbell(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  const barLen = r * 1.05;
  fillCapsule(s, cx - barLen / 2, cy, cx + barLen / 2, cy, Math.max(1, r * 0.14), c);
  const plateR = r * 0.4;
  fillDisc(s, cx - barLen / 2, cy, plateR, c);
  fillDisc(s, cx + barLen / 2, cy, plateR, c);
}

function drawStar(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  // A single elongated diamond — the simplest four-point "sparkle" shape,
  // chosen over a classic five-point star because a five-point star's
  // narrow points are the first detail to vanish at a 22px stamp (goal 20,
  // @1x); a bold diamond keeps its silhouette at any size.
  fillConvexPolygon(
    s,
    [
      [cx, cy - r * 0.92],
      [cx + r * 0.55, cy],
      [cx, cy + r * 0.92],
      [cx - r * 0.55, cy],
    ],
    c
  );
}

function drawHeart(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  const lobeR = r * 0.42;
  const lobeY = cy - r * 0.18;
  fillDisc(s, cx - lobeR * 0.95, lobeY, lobeR, c);
  fillDisc(s, cx + lobeR * 0.95, lobeY, lobeR, c);
  fillConvexPolygon(
    s,
    [
      [cx - lobeR * 1.85, lobeY],
      [cx + lobeR * 1.85, lobeY],
      [cx, cy + r * 0.85],
    ],
    c
  );
}

function drawCheck(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  const t = Math.max(1, r * 0.22);
  fillCapsule(s, cx - r * 0.55, cy, cx - r * 0.1, cy + r * 0.45, t, c);
  fillCapsule(s, cx - r * 0.1, cy + r * 0.45, cx + r * 0.6, cy - r * 0.45, t, c);
}

function drawGift(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  const boxW = r * 1.3;
  const boxH = r * 1.1;
  const boxY = cy - boxH * 0.35;
  fillRoundedRect(s, cx - boxW / 2, boxY, boxW, boxH, boxH * 0.14, c);
  const ribbonW = Math.max(1, boxW * 0.16);
  fillRoundedRect(s, cx - ribbonW / 2, boxY, ribbonW, boxH, 0, c);
  const ribbonH = Math.max(1, boxH * 0.16);
  fillRoundedRect(s, cx - boxW / 2, cy - ribbonH / 2, boxW, ribbonH, 0, c);
  const bowR = r * 0.18;
  fillDisc(s, cx - bowR * 0.9, boxY - bowR * 0.5, bowR, c);
  fillDisc(s, cx + bowR * 0.9, boxY - bowR * 0.5, bowR, c);
}

/**
 * Draws built-in icon `id` filled with `color`, occupying the same
 * radius-`r` footprint a plain `fillDisc(s, cx, cy, r, color)` would have —
 * the drop-in replacement strip.ts's render loop reaches for when
 * `stampSource === 'builtin'`.
 */
export function drawBuiltinIcon(s: Surface, cx: number, cy: number, r: number, color: RGBA, id: BuiltinIconId): void {
  switch (id) {
    case 'coffee':
      return drawCoffee(s, cx, cy, r, color);
    case 'croissant':
      return drawCroissant(s, cx, cy, r, color);
    case 'scissors':
      return drawScissors(s, cx, cy, r, color);
    case 'flower':
      return drawFlower(s, cx, cy, r, color);
    case 'car':
      return drawCar(s, cx, cy, r, color);
    case 'dumbbell':
      return drawDumbbell(s, cx, cy, r, color);
    case 'star':
      return drawStar(s, cx, cy, r, color);
    case 'heart':
      return drawHeart(s, cx, cy, r, color);
    case 'check':
      return drawCheck(s, cx, cy, r, color);
    case 'gift':
      return drawGift(s, cx, cy, r, color);
  }
}

/**
 * A small standalone PNG of icon `id` alone on a transparent background —
 * what the designer's icon picker (`GET /icon-swatch.png`, apps/demo/
 * server.ts) points each swatch `<img>` at, so the picker never
 * reimplements this drawing code client-side (same "render endpoint, never
 * a second renderer" discipline as the strip preview).
 */
export function renderIconSwatch(id: BuiltinIconId, size: number, color: RGBA): Buffer {
  const s = new Surface(size, size);
  drawBuiltinIcon(s, size / 2, size / 2, size * 0.42, color, id);
  return encodePNG(s.toRGBA(), size, size);
}
