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

test('anti-aliases the circle edge with a ramp, not a hard cut', () => {
  const out = circularMask(opaqueSquare(64), 32);
  const alpha = alphaAt(out, 16, 0);
  // Pixel (16, 0) is at the edge of the circle (centre 16, radius 16).
  // A hard-cut implementation would give exactly 255.
  // An anti-aliased ramp gives a value strictly between 0 and 255.
  assert.ok(0 < alpha && alpha < 255, `alpha at edge should be partial, got ${alpha}`);
});

function opaqueRect(w: number, h: number) {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 200; rgba[i + 1] = 100; rgba[i + 2] = 50; rgba[i + 3] = 255;
  }
  return { width: w, height: h, rgba };
}

/** The bounding box of alpha>0 pixels in a (small, test-sized) masked output. */
function opaqueBBox(img: { width: number; height: number; rgba: Uint8Array }) {
  let minX = img.width, minY = img.height, maxX = -1, maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const a = img.rgba[(y * img.width + x) * 4 + 3]!;
      if (a > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? undefined : { width: maxX - minX + 1, height: maxY - minY + 1 };
}

test('defaults to contain — a wide source keeps its aspect ratio, not stretched to fill the circle', () => {
  // A 5:1 wordmark-shaped source, same order of magnitude as a real wide
  // logo (the owner's is ~4.9:1). A stretch-to-square implementation would
  // fill the entire circle; contain must letterbox it into a short band
  // whose own aspect ratio still reads as ~5:1.
  const src = opaqueRect(100, 20);
  const out = circularMask(src, 64);
  const box = opaqueBBox(out);
  assert.ok(box, 'expected some opaque pixels');
  const ratio = box!.width / box!.height;
  assert.ok(Math.abs(ratio - 5) < 0.5, `expected the opaque region's aspect to stay ~5:1, got ${box!.width}x${box!.height} (${ratio.toFixed(2)}:1)`);
  assert.ok(box!.height < 40, `expected a short letterboxed band well under the full 64px height, got ${box!.height}`);
});

test('contain leaves the top and bottom of a wide logo transparent (letterboxed, not smeared)', () => {
  const src = opaqueRect(100, 20);
  const out = circularMask(src, 64, 0, 'contain');
  assert.equal(alphaAt(out, 32, 0), 0, 'top-centre should be transparent letterboxing');
  assert.equal(alphaAt(out, 32, 63), 0, 'bottom-centre should be transparent letterboxing');
});

test('cover fills the circle edge to edge, even for the same wide source', () => {
  const src = opaqueRect(100, 20);
  const out = circularMask(src, 64, 0, 'cover');
  // (32, 0) sits right at the top of the circle's rim (centre 32,32, radius
  // 32) — under contain this is transparent letterboxing (previous test);
  // under cover the source has been scaled to fill the full square, so the
  // only thing that can make this pixel non-opaque is the circle's own
  // anti-aliasing, not missing logo content.
  assert.ok(alphaAt(out, 32, 0) > 0, `expected cover fit to reach the rim, got alpha ${alphaAt(out, 32, 0)}`);
  assert.ok(alphaAt(out, 32, 63) > 0, `expected cover fit to reach the rim, got alpha ${alphaAt(out, 32, 63)}`);
});

test('a square source is unaffected by fit — contain and cover agree', () => {
  const src = opaqueSquare(64);
  assert.deepEqual(circularMask(src, 32, 0, 'contain'), circularMask(src, 32, 0, 'cover'));
});
