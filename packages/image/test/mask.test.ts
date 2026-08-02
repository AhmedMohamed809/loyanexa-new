import { test } from 'node:test';
import assert from 'node:assert/strict';
import { circularMask } from '../src/raster/mask.ts';

function opaqueSquare(n: number) {
  const rgba = new Uint8Array(n * n * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 250; rgba[i + 1] = 250; rgba[i + 2] = 250; rgba[i + 3] = 255;
  }
  return { width: n, height: n, rgba };
}

const alphaAt = (img: { width: number; rgba: Uint8Array }, x: number, y: number) =>
  img.rgba[(y * img.width + x) * 4 + 3]!;

test('produces a square of the requested size', () => {
  const out = circularMask(opaqueSquare(64), 32);
  assert.equal(out.width, 32);
  assert.equal(out.height, 32);
});

test('keeps the centre and clears the corners', () => {
  const out = circularMask(opaqueSquare(64), 32);
  assert.equal(alphaAt(out, 16, 16), 255, 'centre kept');
  assert.equal(alphaAt(out, 0, 0), 0, 'corner cleared');
});

test('draws a rim so a pale logo still reads as a stamp', () => {
  const out = circularMask(opaqueSquare(64), 40, 3);
  // Just inside the circle edge the rim darkens the pixel.
  const px = (x: number, y: number) => out.rgba[(y * out.width + x) * 4]!;
  assert.ok(px(20, 1) < 250, `expected the rim to darken the edge, got ${px(20, 1)}`);
  assert.equal(px(20, 20), 250, 'centre is untouched by the rim');
});
