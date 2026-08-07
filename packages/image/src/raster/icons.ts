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
  | 'gift'
  // Trade marks, added 6 August 2026. The first ten cover a café and a gym
  // and then run out: a butcher stamping a star, or a dental clinic stamping
  // a heart, is a card that looks like it was assembled from whatever was to
  // hand. These are the trades the template catalogue actually ships.
  | 'cutlery'
  | 'hanger'
  | 'basket'
  | 'fish'
  | 'cleaver'
  | 'shoe'
  | 'paw'
  | 'tooth'
  | 'bottle'
  | 'kettlebell'
  // A second trade batch, 6 August 2026, for the categories the catalogue
  // gained at the same time: nurseries, music schools, tyre shops, boxing
  // gyms and martial-arts clubs.
  | 'glove'
  | 'gi'
  | 'baby'
  | 'musicNote'
  | 'tyre';

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
  'cutlery',
  'hanger',
  'basket',
  'fish',
  'cleaver',
  'shoe',
  'paw',
  'tooth',
  'bottle',
  'kettlebell',
  'glove',
  'gi',
  'baby',
  'musicNote',
  'tyre',
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
type Pt = readonly [number, number];

/**
 * A stroked polyline with round caps and round joins, painted in **one**
 * coverage pass.
 *
 * Drawing a path as a series of separate capsules is the obvious approach and
 * it is wrong: each capsule anti-aliases its own edge, so wherever two
 * overlap the two partial coverages blend twice and leave a visible seam. The
 * old heart had exactly that — a white band straight through the middle where
 * its two lobes met. Taking the *minimum distance to any segment* and
 * converting that once into coverage makes the path a single shape, so joins
 * are seamless by construction.
 */
function strokePath(s: Surface, pts: readonly Pt[], w: number, color: RGBA, closed = false): void {
  if (pts.length === 0) return;
  const r = w / 2;
  const segs: Array<readonly [number, number, number, number]> = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    segs.push([pts[i]![0], pts[i]![1], pts[i + 1]![0], pts[i + 1]![1]]);
  }
  if (closed && pts.length > 2) {
    const a = pts[pts.length - 1]!;
    const b = pts[0]!;
    segs.push([a[0], a[1], b[0], b[1]]);
  }
  if (segs.length === 0) {
    // A single point is a dot.
    const [x, y] = pts[0]!;
    paintCoverage(s, x - r - 1, y - r - 1, x + r + 1, y + r + 1, color, (px, py) =>
      discCoverage(px, py, x, y, r)
    );
    return;
  }
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [ax, ay, bx, by] of segs) {
    x0 = Math.min(x0, ax, bx);
    y0 = Math.min(y0, ay, by);
    x1 = Math.max(x1, ax, bx);
    y1 = Math.max(y1, ay, by);
  }
  paintCoverage(s, x0 - r - 1, y0 - r - 1, x1 + r + 1, y1 + r + 1, color, (px, py) => {
    let best = Infinity;
    for (const [ax, ay, bx, by] of segs) {
      const abx = bx - ax;
      const aby = by - ay;
      const len2 = abx * abx + aby * aby || 1;
      const t = clamp01(((px - ax) * abx + (py - ay) * aby) / len2);
      best = Math.min(best, Math.hypot(px - (ax + abx * t), py - (ay + aby * t)));
      if (best <= 0) break;
    }
    return clamp01(r + 0.5 - best);
  });
}

/**
 * An arc as a stroked path. `a0`/`a1` in radians, clockwise in screen space.
 * Segment count scales with radius so a large icon stays smooth and a small
 * one does not pay for detail it cannot show.
 */
function strokeArc(
  s: Surface,
  cx: number,
  cy: number,
  radius: number,
  a0: number,
  a1: number,
  w: number,
  color: RGBA
): void {
  const steps = Math.max(6, Math.ceil(Math.abs(a1 - a0) * radius * 0.5));
  const pts: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    pts.push([cx + Math.cos(a) * radius, cy + Math.sin(a) * radius]);
  }
  strokePath(s, pts, w, color);
}

/**
 * A filled polygon of any shape, using the even-odd rule — unlike
 * fillConvexPolygon above, this handles concave and self-intersecting outlines,
 * which is what a five-pointed star actually is. (The previous "star" was a
 * four-vertex diamond, because a convex fill cannot express a star at all.)
 *
 * Anti-aliased by 3x3 supersampling rather than analytically: an exact
 * coverage integral for an arbitrary polygon is a much larger piece of code,
 * and nine samples is visually indistinguishable at every size these icons
 * render at.
 */
function fillPolygon(s: Surface, pts: readonly Pt[], color: RGBA): void {
  if (pts.length < 3) return;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const inside = (px: number, py: number): boolean => {
    let hit = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i]!;
      const [xj, yj] = pts[j]!;
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  paintCoverage(s, x0 - 1, y0 - 1, x1 + 1, y1 + 1, color, (px, py) => {
    let hits = 0;
    for (let sy = 0; sy < 3; sy++) {
      for (let sx = 0; sx < 3; sx++) {
        if (inside(px + (sx - 1) / 3, py + (sy - 1) / 3)) hits++;
      }
    }
    return hits / 9;
  });
}

/**
 * Fills the union of several coverage functions in one pass.
 *
 * The same seam problem strokePath solves, for filled shapes: a heart drawn as
 * two discs and a triangle blended one after another shows its seams. Taking
 * the max coverage first makes it one silhouette.
 */
function fillUnion(
  s: Surface,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: RGBA,
  parts: ReadonlyArray<(x: number, y: number) => number>
): void {
  paintCoverage(s, x0, y0, x1, y1, color, (px, py) => {
    let best = 0;
    for (const part of parts) {
      const c = part(px, py);
      if (c > best) best = c;
      if (best >= 1) break;
    }
    return best;
  });
}

/**
 * The stroke weight every icon shares, as a fraction of the icon radius.
 *
 * A single shared weight is most of what makes a set look drawn by one hand.
 * The floor matters as much as the ratio: a stamp can render as small as 22px
 * across, where a purely proportional stroke would fall below a pixel and the
 * glyph would dissolve into grey mush — which is what the previous set did.
 */
function strokeWidth(r: number): number {
  return Math.max(1.7, r * 0.235);
}

/** Maps a design-space coordinate in [-1,1] onto the icon's actual centre and radius. */
function project(cx: number, cy: number, r: number, pts: readonly Pt[]): Pt[] {
  return pts.map(([x, y]) => [cx + x * r, cy + y * r] as Pt);
}

// ---------------------------------------------------------------------------
// The ten glyphs.
//
// Each is drawn in a design space of [-1,1] on both axes and projected onto
// the real centre/radius, so the shapes below read as geometry rather than as
// arithmetic. All are line-art at one shared weight (see strokeWidth) — the
// convention every modern interface icon set uses, and the reason a set looks
// coherent rather than assembled.
// ---------------------------------------------------------------------------

function drawCoffee(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  const w = strokeWidth(r);
  // Tapered vessel — wider at the rim than the base, which is what makes it a
  // cup rather than a tub. Kept symmetric about the centre line so the handle
  // reads as an addition rather than as a lopsided body.
  strokePath(s, project(cx, cy, r, [
    [-0.5, -0.28], [-0.38, 0.56], [0.38, 0.56], [0.5, -0.28],
  ]), w, c);
  // Rim, tucked just inside the body ends so its round caps do not bulge.
  // Rim ends flush with the body. Any overhang reads as a lopsided lid,
  // which is worse on the left where there is no handle to balance it.
  strokePath(s, project(cx, cy, r, [[-0.5, -0.28], [0.5, -0.28]]), w, c);
  // Handle, clear of the rim so the two never merge into a blob.
  // Radius comfortably larger than the stroke width, or the ring fills in
  // solid and reads as a blob stuck to the cup.
  strokeArc(s, cx + 0.62 * r, cy + 0.08 * r, 0.34 * r, -Math.PI * 0.46, Math.PI * 0.46, w, c);
}

function drawCroissant(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  // Built from a centre-line arc whose thickness is modulated by sin(pi*t):
  // zero at both ends, greatest in the middle. That is precisely a croissant —
  // fat in the belly, tapering to two horns. Two concentric arcs cannot do
  // this (they give a constant-width band, i.e. an arch), and a plain crescent
  // reads as a moon, which is what the previous glyph was mistaken for.
  const steps = Math.max(14, Math.ceil(r));
  // Sweep past a half-turn so the horns turn downward — a shorter arc reads
  // as a hill. Thickness stays well under the radius or the inner edge
  // collapses through the centre and the crescent fills in.
  const A0 = Math.PI * 0.92;
  const A1 = Math.PI * 2.08;
  const RAD = 0.74;
  const MAXT = 0.23;
  const top: Pt[] = [];
  const bottom: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = A0 + (A1 - A0) * t;
    const nx = Math.cos(a);
    const ny = Math.sin(a);
    const h = MAXT * Math.sin(Math.PI * t);
    top.push([nx * (RAD + h), ny * (RAD + h) + 0.3]);
    bottom.push([nx * (RAD - h), ny * (RAD - h) + 0.3]);
  }
  fillPolygon(s, project(cx, cy, r, [...top, ...bottom.reverse()]), c);
}

function drawScissors(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  const w = strokeWidth(r);
  const pivot: Pt = [0, 0.12];
  // Two blades crossing at the pivot, opening upward.
  strokePath(s, project(cx, cy, r, [[-0.52, -0.82], pivot, [0.4, 0.52]]), w, c);
  strokePath(s, project(cx, cy, r, [[0.52, -0.82], pivot, [-0.4, 0.52]]), w, c);
  // Finger rings below, which is what distinguishes scissors from a cross.
  strokeArc(s, cx - 0.44 * r, cy + 0.66 * r, 0.26 * r, 0, Math.PI * 2, w, c);
  strokeArc(s, cx + 0.44 * r, cy + 0.66 * r, 0.26 * r, 0, Math.PI * 2, w, c);
}

function drawFlower(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  const w = strokeWidth(r);
  // Five stroked petals around a stroked centre. Filled petals made a solid
  // blob that read as a ball; outlines keep it a flower and keep it in the
  // same visual language as the other nine.
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / 5;
    strokeArc(s, cx + Math.cos(a) * 0.6 * r, cy + Math.sin(a) * 0.6 * r, 0.33 * r, 0, Math.PI * 2, w, c);
  }
  strokeArc(s, cx, cy, 0.17 * r, 0, Math.PI * 2, w, c);
}

function drawCar(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  const w = strokeWidth(r);
  // Cabin over body: the roofline is the whole reason a car silhouette reads.
  strokePath(s, project(cx, cy, r, [
    [-0.86, 0.18], [-0.78, -0.16], [-0.46, -0.2],
    [-0.24, -0.62], [0.3, -0.62], [0.6, -0.2],
    [0.82, -0.14], [0.88, 0.18],
  ]), w, c);
  strokePath(s, project(cx, cy, r, [[-0.46, -0.2], [0.6, -0.2]]), w, c);
  // Wheels.
  strokeArc(s, cx - 0.46 * r, cy + 0.42 * r, 0.24 * r, 0, Math.PI * 2, w, c);
  strokeArc(s, cx + 0.46 * r, cy + 0.42 * r, 0.24 * r, 0, Math.PI * 2, w, c);
}

function drawDumbbell(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  const w = strokeWidth(r);
  // Bar plus two plates at each end. The previous glyph was two discs joined
  // by a bar, which reads as an infinity sign; it is the *vertical* plates
  // that say dumbbell.
  strokePath(s, project(cx, cy, r, [[-0.5, 0], [0.5, 0]]), w, c);
  for (const sx of [-1, 1]) {
    strokePath(s, project(cx, cy, r, [[sx * 0.5, -0.54], [sx * 0.5, 0.54]]), w, c);
    strokePath(s, project(cx, cy, r, [[sx * 0.82, -0.34], [sx * 0.82, 0.34]]), w, c);
  }
}

function drawStar(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  // An actual five-pointed star: ten alternating vertices, filled even-odd.
  // The previous glyph was a four-vertex diamond, because the convex fill it
  // used cannot represent a concave outline.
  const pts: Pt[] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 === 0 ? 0.98 : 0.42;
    pts.push([Math.cos(a) * rad, Math.sin(a) * rad]);
  }
  fillPolygon(s, project(cx, cy, r, pts), c);
}

function drawHeart(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  // Two lobes and a point, unioned in one pass. Blended separately they left
  // a white seam straight across the middle — which the old glyph had.
  const lobeR = 0.45 * r;
  const lx = cx - 0.42 * r;
  const rx = cx + 0.42 * r;
  const ly = cy - 0.32 * r;
  const tri: Pt[] = project(cx, cy, r, [[-0.9, -0.16], [0.9, -0.16], [0, 0.92]]);
  const insideTri = (px: number, py: number): boolean => {
    let hit = false;
    for (let i = 0, j = tri.length - 1; i < tri.length; j = i++) {
      const [xi, yi] = tri[i]!;
      const [xj, yj] = tri[j]!;
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  fillUnion(s, cx - r - 2, cy - r - 2, cx + r + 2, cy + r + 2, c, [
    (x, y) => discCoverage(x, y, lx, ly, lobeR),
    (x, y) => discCoverage(x, y, rx, ly, lobeR),
    (x, y) => {
      let hits = 0;
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) if (insideTri(x + (sx - 1) / 3, y + (sy - 1) / 3)) hits++;
      }
      return hits / 9;
    },
  ]);
}

function drawCheck(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  // One polyline, round caps and a round join — a tick, not two crossed bars.
  strokePath(s, project(cx, cy, r, [[-0.68, 0.02], [-0.2, 0.5], [0.7, -0.5]]), strokeWidth(r) * 1.15, c);
}

function drawGift(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  const w = strokeWidth(r);
  // Box.
  strokePath(s, project(cx, cy, r, [
    [-0.72, -0.1], [0.72, -0.1], [0.72, 0.8], [-0.72, 0.8],
  ]), w, c, true);
  // Lid, slightly proud of the box on both sides.
  strokePath(s, project(cx, cy, r, [[-0.82, -0.1], [0.82, -0.1]]), w, c);
  // Ribbon down the front.
  strokePath(s, project(cx, cy, r, [[0, -0.1], [0, 0.8]]), w, c);
  // Bow: two half-loops sitting above the lid. Full loops, or teardrops
  // crossing down into the box, turn the whole top into noise at small sizes.
  for (const sx of [-1, 1]) {
    strokeArc(s, cx + sx * 0.3 * r, cy - 0.38 * r, 0.26 * r, Math.PI * 0.06, Math.PI * 0.94, w, c);
  }
}


function drawCutlery(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  const w = strokeWidth(r);
  // Fork on one side, knife on the other — the pair is what reads as
  // "restaurant"; either alone reads as a utensil.
  strokePath(s, project(cx, cy, r, [[-0.42, -0.86], [-0.42, -0.3]]), w, c);
  strokePath(s, project(cx, cy, r, [[-0.66, -0.86], [-0.66, -0.42], [-0.18, -0.42], [-0.18, -0.86]]), w, c);
  strokePath(s, project(cx, cy, r, [[-0.42, -0.42], [-0.42, 0.86]]), w, c);
  strokePath(s, project(cx, cy, r, [[0.46, 0.86], [0.46, -0.24]]), w, c);
  strokePath(s, project(cx, cy, r, [[0.46, -0.24], [0.2, -0.44], [0.34, -0.86], [0.6, -0.86], [0.66, -0.5], [0.46, -0.24]]), w, c);
}

function drawHanger(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  const w = strokeWidth(r);
  strokeArc(s, cx, cy - 0.52 * r, 0.22 * r, Math.PI * 0.15, Math.PI * 0.85, w, c);
  strokePath(s, project(cx, cy, r, [[0, -0.3], [0, -0.08]]), w, c);
  strokePath(s, project(cx, cy, r, [[0, -0.08], [-0.86, 0.5], [0.86, 0.5], [0, -0.08]]), w, c);
}

function drawBasket(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  const w = strokeWidth(r);
  // The handle is what separates a basket from a box.
  strokeArc(s, cx, cy - 0.16 * r, 0.36 * r, Math.PI, Math.PI * 2, w, c);
  strokePath(s, project(cx, cy, r, [[-0.88, -0.16], [0.88, -0.16]]), w, c);
  strokePath(s, project(cx, cy, r, [[-0.72, -0.16], [-0.5, 0.76], [0.5, 0.76], [0.72, -0.16]]), w, c);
}

function drawFish(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  const w = strokeWidth(r);
  // Body as two mirrored arcs meeting at nose and tail, then the tail fin.
  strokePath(s, project(cx, cy, r, [
    [-0.3, 0], [-0.02, -0.44], [0.42, -0.34], [0.7, 0], [0.42, 0.34], [-0.02, 0.44], [-0.3, 0],
  ]), w, c);
  strokePath(s, project(cx, cy, r, [[-0.3, 0], [-0.82, -0.36], [-0.82, 0.36], [-0.3, 0]]), w, c);
  strokeArc(s, cx + 0.46 * r, cy - 0.1 * r, 0.07 * r, 0, Math.PI * 2, w * 0.8, c);
}

function drawCleaver(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  const w = strokeWidth(r);
  // A deep rectangular blade with the handle coming off its top-right
  // corner. The first attempt drew the handle at mid-height and the result
  // read as a blocky letter rather than as a tool — on a cleaver the handle
  // sits ABOVE the spine, which is what makes the silhouette recognisable.
  strokePath(s, project(cx, cy, r, [
    [-0.8, -0.34], [0.24, -0.34], [0.24, 0.56], [-0.8, 0.56],
  ]), w, c, true);
  strokePath(s, project(cx, cy, r, [[0.24, -0.2], [0.8, -0.2], [0.8, -0.48], [0.24, -0.48]]), w, c);
  // The hanging hole, which nothing else in the set has.
  strokeArc(s, cx - 0.56 * r, cy - 0.1 * r, 0.1 * r, 0, Math.PI * 2, w * 0.75, c);
}

function drawShoe(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  const w = strokeWidth(r);
  // Side profile: a flat sole, a toe that lifts at one end, and an ankle
  // opening at the other. The first attempt had no opening and no toe lift,
  // so it read as a wedge — those two features are the whole silhouette.
  strokePath(s, project(cx, cy, r, [
    [-0.86, 0.5],        // heel, on the ground
    [-0.86, -0.2],       // up the back
    [-0.42, -0.34],      // ankle collar
    [-0.28, 0.04],       // down into the instep
    [0.34, 0.12],        // along the foot
    [0.86, 0.34],        // toe, lifting
    [0.86, 0.5],         // toe tip down to the sole
  ]), w, c);
  strokePath(s, project(cx, cy, r, [[-0.86, 0.5], [0.86, 0.5]]), w, c);
  // Laces.
  strokePath(s, project(cx, cy, r, [[-0.18, -0.06], [0.06, 0.0]]), w * 0.7, c);
  strokePath(s, project(cx, cy, r, [[-0.06, -0.18], [0.18, -0.1]]), w * 0.7, c);
}

function drawPaw(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  // Four toes and a pad, filled in one pass so nothing seams where they meet.
  const parts: Array<(x: number, y: number) => number> = [];
  const toes: Array<[number, number, number]> = [
    [-0.52, -0.3, 0.24], [-0.18, -0.56, 0.25], [0.18, -0.56, 0.25], [0.52, -0.3, 0.24],
  ];
  for (const [tx, ty, tr] of toes) {
    parts.push((x, y) => discCoverage(x, y, cx + tx * r, cy + ty * r, tr * r));
  }
  parts.push((x, y) => discCoverage(x, y, cx, cy + 0.36 * r, 0.44 * r));
  parts.push((x, y) => discCoverage(x, y, cx - 0.3 * r, cy + 0.2 * r, 0.3 * r));
  parts.push((x, y) => discCoverage(x, y, cx + 0.3 * r, cy + 0.2 * r, 0.3 * r));
  fillUnion(s, cx - r - 2, cy - r - 2, cx + r + 2, cy + r + 2, c, parts);
}

function drawTooth(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  const w = strokeWidth(r);
  // Crown across the top, two roots below.
  strokePath(s, project(cx, cy, r, [
    [-0.62, -0.36], [-0.5, -0.72], [0.5, -0.72], [0.62, -0.36],
    [0.5, 0.2], [0.24, 0.78], [0.06, 0.2], [-0.06, 0.2], [-0.24, 0.78], [-0.5, 0.2], [-0.62, -0.36],
  ]), w, c);
}

function drawBottle(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  const w = strokeWidth(r);
  // Neck, shoulder, body — a grooming or shampoo bottle.
  strokePath(s, project(cx, cy, r, [[-0.2, -0.86], [0.2, -0.86], [0.2, -0.56]]), w, c);
  strokePath(s, project(cx, cy, r, [[-0.2, -0.86], [-0.2, -0.56]]), w, c);
  strokePath(s, project(cx, cy, r, [
    [-0.2, -0.56], [-0.56, -0.26], [-0.56, 0.78], [0.56, 0.78], [0.56, -0.26], [0.2, -0.56],
  ]), w, c);
  strokePath(s, project(cx, cy, r, [[-0.56, 0.14], [0.56, 0.14]]), w, c);
}

function drawKettlebell(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  const w = strokeWidth(r);
  // Handle over a heavy bell. The gym already has a dumbbell; a kettlebell
  // is the mark a studio or a personal trainer actually uses.
  strokeArc(s, cx, cy - 0.4 * r, 0.3 * r, Math.PI * 1.05, Math.PI * 1.95, w, c);
  strokePath(s, project(cx, cy, r, [
    [-0.3, -0.32], [-0.62, 0.06], [-0.62, 0.5], [-0.4, 0.78], [0.4, 0.78], [0.62, 0.5], [0.62, 0.06], [0.3, -0.32],
  ]), w, c);
}


function drawGlove(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  const w = strokeWidth(r);
  // A rounded mitt with a thumb bump low on one side and a cuff beneath.
  // The first attempt used straight segments and read as an angular arrow;
  // a boxing glove is defined by being round everywhere except the cuff.
  strokeArc(s, cx + 0.06 * r, cy - 0.18 * r, 0.56 * r, Math.PI * 1.05, Math.PI * 2.15, w, c);
  strokePath(s, project(cx, cy, r, [[-0.5, -0.14], [-0.5, 0.24]]), w, c);
  strokePath(s, project(cx, cy, r, [[0.62, -0.14], [0.62, 0.24]]), w, c);
  // Thumb.
  strokeArc(s, cx - 0.5 * r, cy + 0.06 * r, 0.22 * r, Math.PI * 0.5, Math.PI * 1.5, w, c);
  // Cuff.
  strokePath(s, project(cx, cy, r, [[-0.5, 0.24], [-0.5, 0.74], [0.62, 0.74], [0.62, 0.24], [-0.5, 0.24]]), w, c);
}

function drawGi(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  const w = strokeWidth(r);
  // Two lapels meeting in a V, over a belt. The first attempt put the collar
  // points high and apart, which made a crown; bringing them down and in is
  // what turns the same outline into a jacket.
  strokePath(s, project(cx, cy, r, [[-0.66, -0.44], [-0.2, -0.6], [0, -0.26], [0.2, -0.6], [0.66, -0.44]]), w, c);
  strokePath(s, project(cx, cy, r, [[-0.66, -0.44], [-0.56, 0.16]]), w, c);
  strokePath(s, project(cx, cy, r, [[0.66, -0.44], [0.56, 0.16]]), w, c);
  // Belt, and the skirt below it.
  strokePath(s, project(cx, cy, r, [[-0.66, 0.16], [0.66, 0.16]]), w, c);
  strokePath(s, project(cx, cy, r, [[-0.56, 0.16], [-0.56, 0.74], [0.56, 0.74], [0.56, 0.16]]), w, c);
  strokePath(s, project(cx, cy, r, [[0, -0.26], [0, 0.16]]), w, c);
}

function drawBaby(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  const w = strokeWidth(r);
  // Head with a single curl, and two eyes. A face reads as an infant far
  // more reliably than a body does at this size.
  strokeArc(s, cx, cy + 0.08 * r, 0.62 * r, 0, Math.PI * 2, w, c);
  strokeArc(s, cx + 0.06 * r, cy - 0.62 * r, 0.2 * r, Math.PI * 0.7, Math.PI * 1.9, w, c);
  strokeArc(s, cx - 0.22 * r, cy - 0.02 * r, 0.05 * r, 0, Math.PI * 2, w * 0.8, c);
  strokeArc(s, cx + 0.22 * r, cy - 0.02 * r, 0.05 * r, 0, Math.PI * 2, w * 0.8, c);
  strokeArc(s, cx, cy + 0.16 * r, 0.2 * r, Math.PI * 0.15, Math.PI * 0.85, w * 0.85, c);
}

function drawMusicNote(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  const w = strokeWidth(r);
  // A beamed pair. One note alone is thinner and reads less clearly small.
  strokePath(s, project(cx, cy, r, [[-0.3, 0.42], [-0.3, -0.66], [0.56, -0.86], [0.56, 0.2]]), w, c);
  strokePath(s, project(cx, cy, r, [[-0.3, -0.34], [0.56, -0.54]]), w, c);
  strokeArc(s, cx - 0.52 * r, cy + 0.46 * r, 0.24 * r, 0, Math.PI * 2, w, c);
  strokeArc(s, cx + 0.34 * r, cy + 0.24 * r, 0.24 * r, 0, Math.PI * 2, w, c);
}

function drawTyre(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  const w = strokeWidth(r);
  // Outer wall, hub, and four spokes — a plain ring would read as a circle.
  strokeArc(s, cx, cy, 0.86 * r, 0, Math.PI * 2, w, c);
  strokeArc(s, cx, cy, 0.34 * r, 0, Math.PI * 2, w, c);
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    strokePath(s, [
      [cx + Math.cos(a) * 0.36 * r, cy + Math.sin(a) * 0.36 * r],
      [cx + Math.cos(a) * 0.84 * r, cy + Math.sin(a) * 0.84 * r],
    ], w, c);
  }
}

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
    case 'glove':
      drawGlove(s, cx, cy, r, color);
      return;
    case 'gi':
      drawGi(s, cx, cy, r, color);
      return;
    case 'baby':
      drawBaby(s, cx, cy, r, color);
      return;
    case 'musicNote':
      drawMusicNote(s, cx, cy, r, color);
      return;
    case 'tyre':
      drawTyre(s, cx, cy, r, color);
      return;
    case 'cutlery':
      drawCutlery(s, cx, cy, r, color);
      return;
    case 'hanger':
      drawHanger(s, cx, cy, r, color);
      return;
    case 'basket':
      drawBasket(s, cx, cy, r, color);
      return;
    case 'fish':
      drawFish(s, cx, cy, r, color);
      return;
    case 'cleaver':
      drawCleaver(s, cx, cy, r, color);
      return;
    case 'shoe':
      drawShoe(s, cx, cy, r, color);
      return;
    case 'paw':
      drawPaw(s, cx, cy, r, color);
      return;
    case 'tooth':
      drawTooth(s, cx, cy, r, color);
      return;
    case 'bottle':
      drawBottle(s, cx, cy, r, color);
      return;
    case 'kettlebell':
      drawKettlebell(s, cx, cy, r, color);
      return;
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
