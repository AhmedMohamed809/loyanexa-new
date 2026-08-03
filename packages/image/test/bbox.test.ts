import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opaqueBoundingBox } from '../src/raster/bbox.ts';
import { resizeToFit } from '../src/raster/resize.ts';

function solid(w: number, h: number): { width: number; height: number; rgba: Uint8Array } {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 10; rgba[i + 1] = 20; rgba[i + 2] = 30; rgba[i + 3] = 255;
  }
  return { width: w, height: h, rgba };
}

test('returns undefined for a fully transparent image', () => {
  const img = { width: 4, height: 4, rgba: new Uint8Array(4 * 4 * 4) };
  assert.equal(opaqueBoundingBox(img), undefined);
});

test('a fully opaque image reports its own full size', () => {
  const box = opaqueBoundingBox(solid(10, 6));
  assert.deepEqual(box, { width: 10, height: 6 });
});

test('recovers the source aspect ratio of a logo letterboxed by resizeToFit(contain)', () => {
  // A 5:1 wordmark, contain-fit onto a 100x100 transparent canvas.
  const letterboxed = resizeToFit(solid(200, 40), 100, 100, 'contain');
  const box = opaqueBoundingBox(letterboxed);
  assert.ok(box);
  const ratio = box!.width / box!.height;
  assert.ok(Math.abs(ratio - 5) < 0.3, `expected ~5:1, got ${box!.width}x${box!.height}`);
});

test('threshold ignores low-alpha anti-aliasing fringe', () => {
  const img = { width: 4, height: 1, rgba: new Uint8Array(4 * 1 * 4) };
  // Pixel 0: fully opaque. Pixel 3: barely-there fringe alpha.
  img.rgba[3] = 255;
  img.rgba[15] = 5;
  const box = opaqueBoundingBox(img, 8);
  assert.deepEqual(box, { width: 1, height: 1 });
});
