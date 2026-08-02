import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Surface, parseHexColor } from '../src/raster/surface.ts';
import { fillDisc, strokeRing, fillRoundedRect } from '../src/raster/shapes.ts';

const WHITE = parseHexColor('#ffffff');
const BLACK = parseHexColor('#000000');

function alphaAt(s: Surface, x: number, y: number): number {
  return s.toRGBA()[(y * s.width + x) * 4 + 3]!;
}
function redAt(s: Surface, x: number, y: number): number {
  return s.toRGBA()[(y * s.width + x) * 4]!;
}

test('a disc paints its centre and leaves the corners alone', () => {
  const s = new Surface(21, 21);
  s.fill(BLACK);
  fillDisc(s, 10, 10, 8, WHITE);
  assert.equal(redAt(s, 10, 10), 255, 'centre is filled');
  assert.equal(redAt(s, 0, 0), 0, 'corner is untouched');
});

test('a disc edge is anti-aliased, not binary', () => {
  const s = new Surface(21, 21);
  s.fill(BLACK);
  fillDisc(s, 10, 10, 8, WHITE);
  // Walk out along the x axis; at least one pixel must be partially covered.
  const values = [];
  for (let x = 10; x < 21; x++) values.push(redAt(s, x, 10));
  assert.ok(values.some((v) => v > 0 && v < 255), `expected a partial pixel, got ${values}`);
});

test('a ring is hollow in the middle', () => {
  const s = new Surface(21, 21);
  s.fill(BLACK);
  strokeRing(s, 10, 10, 8, 2, WHITE);
  assert.equal(redAt(s, 10, 10), 0, 'centre stays empty');
  assert.ok(redAt(s, 18, 10) > 0, 'the stroke itself is painted');
});

test('a ring thicker than its radius does not invert', () => {
  const s = new Surface(21, 21);
  s.fill(BLACK);
  strokeRing(s, 10, 10, 4, 10, WHITE);
  assert.ok(redAt(s, 10, 10) > 0, 'degenerates to a filled disc rather than nothing');
});

test('a rounded rect fills its middle and softens its corners', () => {
  const s = new Surface(20, 20);
  fillRoundedRect(s, 2, 2, 16, 16, 6, WHITE);
  assert.equal(alphaAt(s, 10, 10), 255, 'centre');
  assert.equal(alphaAt(s, 2, 2), 0, 'outer corner is cut away');
});

test('radius 0 gives square corners', () => {
  const s = new Surface(20, 20);
  fillRoundedRect(s, 2, 2, 16, 16, 0, WHITE);
  assert.equal(alphaAt(s, 2, 2), 255);
});
