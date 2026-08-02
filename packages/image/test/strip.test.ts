import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderStrip, BASE_WIDTH, BASE_HEIGHT, type StripSpec } from '../src/strip.ts';
import { decodePNG } from '../src/png/decode.ts';

const base: StripSpec = {
  goal: 8,
  filled: 3,
  shape: 'circle',
  bgColor: '#203757',
  bgOpacity: 1,
  activeColor: '#F96400',
  inactiveColor: '#8794A5',
  scale: 1,
};

test('renders at the documented canvas size for each density', () => {
  for (const [scale, w, h] of [[1, 375, 144], [2, 750, 288], [3, 1125, 432]] as const) {
    const img = decodePNG(renderStrip({ ...base, scale }));
    assert.equal(img.width, w, `scale ${scale} width`);
    assert.equal(img.height, h, `scale ${scale} height`);
  }
  assert.equal(BASE_WIDTH, 375);
  assert.equal(BASE_HEIGHT, 144);
});

test('the background colour is honoured', () => {
  const img = decodePNG(renderStrip(base));
  // Top-left corner is background, never a slot.
  assert.deepEqual([...img.rgba.subarray(0, 3)], [32, 55, 87]);
});

test('changing how many are filled changes the pixels', () => {
  const a = renderStrip({ ...base, filled: 0 });
  const b = renderStrip({ ...base, filled: 8 });
  assert.notDeepEqual(a, b);
});

test('the same spec always produces identical bytes', () => {
  assert.deepEqual(renderStrip(base), renderStrip({ ...base }));
});

test('square shape differs from circle', () => {
  assert.notDeepEqual(renderStrip(base), renderStrip({ ...base, shape: 'square' }));
});

test('background opacity is applied', () => {
  const img = decodePNG(renderStrip({ ...base, bgOpacity: 0.5 }));
  assert.ok(img.rgba[3]! < 255, `expected a translucent background, got alpha ${img.rgba[3]}`);
});

test('rejects filled outside 0..goal', () => {
  assert.throws(() => renderStrip({ ...base, filled: -1 }), /filled/);
  assert.throws(() => renderStrip({ ...base, filled: 9 }), /filled/);
});

test('rejects a goal outside 3..20', () => {
  assert.throws(() => renderStrip({ ...base, goal: 2, filled: 0 }), /between 3 and 20/);
});

test('a logo stamp renders differently from a plain disc', () => {
  const logo = {
    rgba: new Uint8Array(32 * 32 * 4).fill(255),
    width: 32,
    height: 32,
    hash: 'test-logo',
  };
  assert.notDeepEqual(renderStrip(base), renderStrip({ ...base, logo }));
});
