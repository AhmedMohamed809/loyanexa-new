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
  const at3x = slotPositions(8, 1125, 432);
  assert.ok(Math.abs(at3x[0]!.x - at1x[0]!.x * 3) < 0.001);
  assert.ok(Math.abs(at3x[0]!.r - at1x[0]!.r * 3) < 0.001);
});
