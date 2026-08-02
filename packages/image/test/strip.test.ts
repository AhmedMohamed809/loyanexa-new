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

test('reports a bad goal, not a bad filled, when both are off', () => {
  // filled: 5 happens to fit inside the bogus 0..2 window a naive filled-first
  // check would use — this must still report the goal problem, not filled.
  assert.throws(() => renderStrip({ ...base, goal: 2, filled: 5 }), /between 3 and 20/);
});

function solidCover(width: number, height: number, rgba: [number, number, number, number]) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0]; data[i + 1] = rgba[1]; data[i + 2] = rgba[2]; data[i + 3] = rgba[3];
  }
  return { rgba: data, width, height, hash: 'test-cover' };
}

test('background opacity is applied once, even with a cover image', () => {
  // An opaque red cover over a navy background: checking alpha alone cannot
  // tell whether the cover code ran at all, because the flat-colour fallback
  // alone would also land at alpha~128 here (this exact gap once let the
  // `if (spec.cover)` block be deleted without failing this test). The RGB
  // assertion is the one that actually exercises the cover path.
  const cover = solidCover(4, 4, [255, 0, 0, 255]);
  const img = decodePNG(renderStrip({ ...base, cover, bgOpacity: 0.5 }));
  const corner = [...img.rgba.subarray(0, 3)];
  assert.deepEqual(corner, [255, 0, 0], `expected corner RGB to be the cover's red, got ${corner}`);
  const alpha = img.rgba[3]!;
  assert.ok(Math.abs(alpha - 128) <= 2, `expected corner alpha ~128, got ${alpha}`);
});

test('a spec with a cover differs from the same spec without one', () => {
  const cover = solidCover(4, 4, [255, 0, 0, 255]);
  assert.notDeepEqual(renderStrip(base), renderStrip({ ...base, cover }));
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
