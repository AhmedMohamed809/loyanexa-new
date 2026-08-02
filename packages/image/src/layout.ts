export const MIN_GOAL = 3;
export const MAX_GOAL = 20;

export interface SlotPosition {
  x: number;
  y: number;
  r: number;
}

function assertGoal(goal: number): void {
  if (!Number.isInteger(goal)) throw new RangeError(`stamp goal must be an integer, got ${goal}`);
  if (goal < MIN_GOAL || goal > MAX_GOAL) {
    throw new RangeError(`stamp goal must be between 3 and 20, got ${goal}`);
  }
}

/** Slots per row. 8 → [4,4] and 11 → [6,5], per BUILD.md §8.5. */
export function slotRows(goal: number): number[] {
  assertGoal(goal);
  if (goal <= 6) return [goal];
  return [Math.ceil(goal / 2), Math.floor(goal / 2)];
}

/**
 * Slot centres and radius for a canvas of `width` x `height` px, in fill order
 * (left to right, top row first). Radius is chosen so the widest row fits with
 * a consistent gap, then capped so rows never collide vertically.
 */
export function slotPositions(goal: number, width: number, height: number): SlotPosition[] {
  const rows = slotRows(goal);
  const widest = Math.max(...rows);

  // A gap is GAP_RATIO of a diameter, i.e. 2 * GAP_RATIO * r. A row of n slots
  // needs n diameters plus (n + 1) gaps — the +1 covers the margin at each end.
  // Keep the `* 2` here in step with `gap` below; dropping it overflows the
  // canvas at goal 20.
  const GAP_RATIO = 0.6;
  const rByWidth = width / (2 * widest + 2 * GAP_RATIO * (widest + 1));
  const rByHeight = height / (2 * rows.length + 2 * GAP_RATIO * (rows.length + 1));
  const r = Math.min(rByWidth, rByHeight);

  const gap = r * GAP_RATIO * 2;
  const rowHeight = 2 * r + gap;
  const totalHeight = rows.length * rowHeight - gap;
  const top = (height - totalHeight) / 2;

  const out: SlotPosition[] = [];
  for (let ri = 0; ri < rows.length; ri++) {
    const n = rows[ri]!;
    const rowWidth = n * 2 * r + (n - 1) * gap;
    const left = (width - rowWidth) / 2;
    const y = top + ri * rowHeight + r;
    for (let i = 0; i < n; i++) {
      out.push({ x: left + i * (2 * r + gap) + r, y, r });
    }
  }
  return out;
}
