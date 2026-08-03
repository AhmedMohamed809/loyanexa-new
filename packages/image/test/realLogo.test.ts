// Regression test for the exact defect reported against a real asset: the
// owner's own logo (brand/logo.png, 1485x302 — a wide wordmark) rendered as
// a horizontally-crushed smear when used as a custom stamp, because
// circularMask used to stretch any non-square source to size×size before
// masking. This test exercises circularMask directly on the real file (not
// a synthetic stand-in) and measures the opaque region it produces, so a
// regression here — someone reintroducing a stretch — fails loudly against
// the actual asset the bug was found on, not just a synthetic rectangle.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeImage } from '../src/jpeg.ts';
import { circularMask } from '../src/raster/mask.ts';
import { opaqueBoundingBox } from '../src/raster/bbox.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = path.resolve(__dirname, '../../../brand/logo.png');
const REAL_ASPECT = 1485 / 302; // ≈ 4.917

test('the owner\'s real 1485x302 logo keeps its aspect ratio under a contain-fit stamp, not stretched', () => {
  const raw = fs.readFileSync(LOGO_PATH);
  const decoded = decodeImage(raw);
  assert.equal(decoded.width, 1485);
  assert.equal(decoded.height, 302);

  const size = 114; // the actual @3x first-slot diameter for an 8-stamp card (packages/image/src/strip.ts's slot sizing)
  const masked = circularMask(decoded, size, Math.max(1, size * 0.06), 'contain');
  assert.equal(masked.width, size);
  assert.equal(masked.height, size);

  const box = opaqueBoundingBox(masked);
  assert.ok(box, 'expected some opaque pixels in the masked stamp');
  const ratio = box!.width / box!.height;
  console.log(`[realLogo contain] measured opaque region: ${box!.width}x${box!.height} px (${ratio.toFixed(2)}:1, source is ${REAL_ASPECT.toFixed(2)}:1)`);
  assert.ok(Math.abs(ratio - REAL_ASPECT) < 0.6, `expected the opaque region's aspect to stay close to the source's ${REAL_ASPECT.toFixed(2)}:1, got ${box!.width}x${box!.height} (${ratio.toFixed(2)}:1)`);
  // A stretch-to-fill implementation (the old bug) would produce a region
  // close to the full size×size square; contain must letterbox it into a
  // band well under half the circle's height.
  assert.ok(box!.height < size * 0.4, `expected a short letterboxed band, got height ${box!.height} for size ${size}`);
});

test('the same real logo fills the circle edge to edge under cover', () => {
  const raw = fs.readFileSync(LOGO_PATH);
  const decoded = decodeImage(raw);

  const size = 114;
  const masked = circularMask(decoded, size, Math.max(1, size * 0.06), 'cover');
  const box = opaqueBoundingBox(masked);
  assert.ok(box);
  console.log(`[realLogo cover] measured opaque region: ${box!.width}x${box!.height} px`);
  // Cover crops to fill (scale = max(target/w, target/h), so the scaled
  // source's height exactly matches the target here, cropped horizontally)
  // — the ink itself has a little internal padding within its own bounding
  // box (real wordmark artwork, not a synthetic rectangle), so it does not
  // reach the literal top/bottom pixel row, but it must reach far closer to
  // the edges than contain's short letterboxed band did in the test above.
  assert.ok(box!.height > size * 0.6, `expected cover's opaque region to reach well beyond contain's letterboxed band, got height ${box!.height} for size ${size}`);
});
