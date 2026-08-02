import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slotRows, slotPositions, MIN_GOAL, MAX_GOAL } from '../src/layout.ts';

test('the two cases BUILD.md §8.5 names', () => {
  assert.deepEqual(slotRows(8), [4, 4]);
  assert.deepEqual(slotRows(11), [6, 5]);
});

test('six or fewer stamps sit on one row', () => {
  for (let g = 3; g <= 6; g++) assert.deepEqual(slotRows(g), [g], `goal ${g}`);
});

test('more than six splits into two rows, larger row first', () => {
  for (let g = 7; g <= MAX_GOAL; g++) {
    const rows = slotRows(g);
    assert.equal(rows.length, 2, `goal ${g}`);
    assert.ok(rows[0]! >= rows[1]!, `goal ${g}: first row must not be smaller`);
  }
});

test('rows always account for exactly the goal', () => {
  for (let g = MIN_GOAL; g <= MAX_GOAL; g++) {
    assert.equal(slotRows(g).reduce((a, b) => a + b, 0), g, `goal ${g}`);
  }
});

test('rejects goals outside 3-20', () => {
  assert.throws(() => slotRows(2), /between 3 and 20/);
  assert.throws(() => slotRows(21), /between 3 and 20/);
  assert.throws(() => slotRows(4.5), /integer/);
});

test('produces one position per stamp, all inside the canvas', () => {
  for (let g = MIN_GOAL; g <= MAX_GOAL; g++) {
    const pos = slotPositions(g, 1125, 432);
    assert.equal(pos.length, g, `goal ${g}`);
    for (const p of pos) {
      assert.ok(p.r > 0, `goal ${g}: radius must be positive`);
      assert.ok(p.x - p.r >= 0 && p.x + p.r <= 1125, `goal ${g}: x out of bounds`);
      assert.ok(p.y - p.r >= 0 && p.y + p.r <= 432, `goal ${g}: y out of bounds`);
    }
  }
});

test('slots never overlap', () => {
  for (let g = MIN_GOAL; g <= MAX_GOAL; g++) {
    const pos = slotPositions(g, 1125, 432);
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const a = pos[i]!, b = pos[j]!;
        assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.r + b.r, `goal ${g}: slots ${i} and ${j} overlap`);
      }
    }
  }
});

test('positions scale linearly with the canvas', () => {
  const at1x = slotPositions(8, 375, 144);
  const at2x = slotPositions(8, 750, 288);
  const at3x = slotPositions(8, 1125, 432);
  assert.ok(Math.abs(at2x[0]!.x - at1x[0]!.x * 2) < 0.001);
  assert.ok(Math.abs(at2x[0]!.r - at1x[0]!.r * 2) < 0.001);
  assert.ok(Math.abs(at3x[0]!.x - at1x[0]!.x * 3) < 0.001);
  assert.ok(Math.abs(at3x[0]!.r - at1x[0]!.r * 3) < 0.001);
});

test('rows are horizontally centred', () => {
  for (let g = MIN_GOAL; g <= MAX_GOAL; g++) {
    const pos = slotPositions(g, 1125, 432);
    const rows = slotRows(g);

    // Group slots by row (by y coordinate)
    const slotsByRow: (typeof pos)[] = [];
    let currentY = pos[0]!.y;
    let currentRow: (typeof pos) = [];
    for (const slot of pos) {
      if (Math.abs(slot.y - currentY) > 1e-9) {
        slotsByRow.push(currentRow);
        currentRow = [];
        currentY = slot.y;
      }
      currentRow.push(slot);
    }
    if (currentRow.length > 0) slotsByRow.push(currentRow);

    for (let ri = 0; ri < slotsByRow.length; ri++) {
      const row = slotsByRow[ri]!;
      const leftmost = Math.min(...row.map((s) => s.x - s.r));
      const rightmost = Math.max(...row.map((s) => s.x + s.r));
      const leftMargin = leftmost;
      const rightMargin = 1125 - rightmost;
      assert.ok(Math.abs(leftMargin - rightMargin) < 1e-9, `goal ${g}, row ${ri}: left margin ${leftMargin} !== right margin ${rightMargin}`);
    }
  }
});

test('the block is vertically centred', () => {
  for (let g = MIN_GOAL; g <= MAX_GOAL; g++) {
    const pos = slotPositions(g, 1125, 432);
    const topmost = Math.min(...pos.map((s) => s.y - s.r));
    const bottommost = Math.max(...pos.map((s) => s.y + s.r));
    const topMargin = topmost;
    const bottomMargin = 432 - bottommost;
    assert.ok(Math.abs(topMargin - bottomMargin) < 1e-9, `goal ${g}: top margin ${topMargin} !== bottom margin ${bottomMargin}`);
  }
});
