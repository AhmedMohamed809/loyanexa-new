import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resizeRGBA } from '../src/raster/resize.ts';

function solid(w: number, h: number, r: number): { width: number; height: number; rgba: Uint8Array } {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = r; rgba[i + 1] = 0; rgba[i + 2] = 0; rgba[i + 3] = 255;
  }
  return { width: w, height: h, rgba };
}

test('downscales to the requested size', () => {
  const out = resizeRGBA(solid(64, 64, 200), 16, 16);
  assert.equal(out.width, 16);
  assert.equal(out.height, 16);
  assert.equal(out.rgba.length, 16 * 16 * 4);
});

test('a solid colour survives downscaling unchanged', () => {
  const out = resizeRGBA(solid(64, 64, 200), 8, 8);
  assert.equal(out.rgba[0], 200);
  assert.equal(out.rgba[3], 255);
});

test('averages a two-tone image rather than point-sampling', () => {
  const src = solid(2, 1, 0);
  src.rgba[0] = 0;
  src.rgba[4] = 255;
  const out = resizeRGBA(src, 1, 1);
  assert.ok(Math.abs(out.rgba[0]! - 128) <= 2, `expected ~128, got ${out.rgba[0]}`);
});

test('upscaling is allowed and preserves colour', () => {
  const out = resizeRGBA(solid(2, 2, 90), 4, 4);
  assert.equal(out.width, 4);
  assert.equal(out.rgba[0], 90);
});

test('rejects a non-positive target', () => {
  assert.throws(() => resizeRGBA(solid(4, 4, 1), 0, 4), /positive/i);
});

test('premultiplies alpha when blending opaque and transparent', () => {
  const src = new Uint8Array(2 * 1 * 4);
  // Opaque red (255, 0, 0, 255)
  src[0] = 255; src[1] = 0; src[2] = 0; src[3] = 255;
  // Fully transparent (0, 0, 0, 0)
  src[4] = 0; src[5] = 0; src[6] = 0; src[7] = 0;
  const out = resizeRGBA({ width: 2, height: 1, rgba: src }, 1, 1);
  assert.equal(out.rgba[0], 255, 'red channel must stay saturated, not darken to ~128');
  assert.ok(out.rgba[3]! > 100 && out.rgba[3]! < 160, `alpha should be ~128, got ${out.rgba[3]}`);
});
