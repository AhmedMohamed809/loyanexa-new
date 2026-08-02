import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePNG } from '../src/png/encode.ts';
import { decodePNG } from '../src/png/decode.ts';

test('round-trips RGBA pixels unchanged', () => {
  const rgba = new Uint8Array(16 * 9 * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 7) % 256;
  const out = decodePNG(encodePNG(rgba, 16, 9));
  assert.equal(out.width, 16);
  assert.equal(out.height, 9);
  assert.deepEqual(out.rgba, rgba);
});

test('round-trips a single pixel', () => {
  const rgba = Uint8Array.from([10, 20, 30, 40]);
  const out = decodePNG(encodePNG(rgba, 1, 1));
  assert.deepEqual(out.rgba, rgba);
});

test('rejects input that is not a PNG', () => {
  assert.throws(() => decodePNG(Buffer.from('not a png at all')), /signature/i);
});

test('rejects a truncated file', () => {
  const png = encodePNG(new Uint8Array(4), 1, 1);
  assert.throws(() => decodePNG(png.subarray(0, 20)), /truncated|IEND|IDAT/i);
});
