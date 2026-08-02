import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Surface, parseHexColor } from '../src/raster/surface.ts';

test('parses 6-digit hex with and without the hash', () => {
  assert.deepEqual(parseHexColor('#203757'), { r: 32, g: 55, b: 87, a: 1 });
  assert.deepEqual(parseHexColor('203757'), { r: 32, g: 55, b: 87, a: 1 });
});

test('parses 3-digit shorthand', () => {
  assert.deepEqual(parseHexColor('#f60'), { r: 255, g: 102, b: 0, a: 1 });
});

test('applies an explicit alpha', () => {
  assert.equal(parseHexColor('#000000', 0.5).a, 0.5);
});

test('rejects nonsense', () => {
  assert.throws(() => parseHexColor('#12345'), /invalid colour/i);
  assert.throws(() => parseHexColor('zzzzzz'), /invalid colour/i);
});

test('fill sets every pixel', () => {
  const s = new Surface(2, 2);
  s.fill(parseHexColor('#F96400'));
  const px = s.toRGBA();
  assert.deepEqual([...px.subarray(0, 4)], [249, 100, 0, 255]);
  assert.deepEqual([...px.subarray(12, 16)], [249, 100, 0, 255]);
});

test('blend at full coverage replaces the pixel', () => {
  const s = new Surface(1, 1);
  s.fill(parseHexColor('#000000'));
  s.blend(0, 0, parseHexColor('#ffffff'), 1);
  assert.deepEqual([...s.toRGBA()], [255, 255, 255, 255]);
});

test('blend at half coverage is source-over', () => {
  const s = new Surface(1, 1);
  s.fill(parseHexColor('#000000'));
  s.blend(0, 0, parseHexColor('#ffffff'), 0.5);
  const px = s.toRGBA();
  assert.ok(Math.abs(px[0]! - 128) <= 1, `expected ~128, got ${px[0]}`);
});

test('blend ignores out-of-bounds and zero coverage', () => {
  const s = new Surface(1, 1);
  s.fill(parseHexColor('#000000'));
  s.blend(-1, 0, parseHexColor('#ffffff'), 1);
  s.blend(0, 5, parseHexColor('#ffffff'), 1);
  s.blend(0, 0, parseHexColor('#ffffff'), 0);
  assert.deepEqual([...s.toRGBA()], [0, 0, 0, 255]);
});
