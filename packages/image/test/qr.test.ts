import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qrMatrix, renderQrPng } from '../src/qr.ts';
import { decodePNG } from '../src/png/decode.ts';

/** True if the 7x7 block at (r0, c0) is a standard QR finder pattern:
 * a solid ring one module wide, a one-module light gap, then a solid 3x3
 * core. */
function isFinderPattern(m: boolean[][], r0: number, c0: number): boolean {
  for (let i = 0; i < 7; i++) {
    for (let j = 0; j < 7; j++) {
      const expected = i === 0 || i === 6 || j === 0 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4);
      const row = m[r0 + i];
      if (!row) return false;
      if (row[c0 + j] !== expected) return false;
    }
  }
  return true;
}

test('the matrix is square and its size is a valid QR version size', () => {
  const m = qrMatrix('hello world');
  const size = m.length;
  assert.ok(
    m.every((row) => row.length === size),
    'every row must have `size` columns'
  );
  assert.equal((size - 21) % 4, 0, `size ${size} must be 21 + 4n`);
  assert.ok(size >= 21 && size <= 33, `size ${size} must be within versions 1-4 (21..33)`);
});

test('the three finder patterns are present at top-left, top-right and bottom-left', () => {
  const m = qrMatrix('https://loyanexa.com/enrol/abc123');
  const size = m.length;
  assert.ok(isFinderPattern(m, 0, 0), 'top-left finder pattern');
  assert.ok(isFinderPattern(m, 0, size - 7), 'top-right finder pattern');
  assert.ok(isFinderPattern(m, size - 7, 0), 'bottom-left finder pattern');
});

test('the quiet zone in the rendered PNG is genuinely blank', () => {
  const moduleSize = 4;
  const quietZone = 4;
  const png = renderQrPng('http://192.168.1.50:8087/12345', moduleSize, quietZone);
  const img = decodePNG(png);
  const quietPx = quietZone * moduleSize;

  const isWhite = (x: number, y: number): void => {
    const o = (y * img.width + x) * 4;
    assert.equal(img.rgba[o], 255, `pixel (${x},${y}) red channel`);
    assert.equal(img.rgba[o + 1], 255, `pixel (${x},${y}) green channel`);
    assert.equal(img.rgba[o + 2], 255, `pixel (${x},${y}) blue channel`);
    assert.equal(img.rgba[o + 3], 255, `pixel (${x},${y}) alpha channel`);
  };

  // Corners, and midpoints of each border strip — all inside the quiet zone
  // regardless of what the matrix itself contains.
  isWhite(0, 0);
  isWhite(img.width - 1, 0);
  isWhite(0, img.height - 1);
  isWhite(img.width - 1, img.height - 1);
  isWhite(Math.floor(quietPx / 2), Math.floor(img.height / 2)); // left strip
  isWhite(img.width - 1 - Math.floor(quietPx / 2), Math.floor(img.height / 2)); // right strip
  isWhite(Math.floor(img.width / 2), Math.floor(quietPx / 2)); // top strip
  isWhite(Math.floor(img.width / 2), img.height - 1 - Math.floor(quietPx / 2)); // bottom strip
});

test('encoding the same text twice gives an identical matrix', () => {
  const a = qrMatrix('repeat-me');
  const b = qrMatrix('repeat-me');
  assert.deepEqual(a, b);
});

test('different text gives a different matrix', () => {
  const a = qrMatrix('text-a');
  const b = qrMatrix('text-b');
  assert.notDeepEqual(a, b);
});

test('a URL of the length we actually use encodes without throwing', () => {
  const url = 'http://192.168.1.42:8087/12345';
  let matrix: boolean[][] = [];
  assert.doesNotThrow(() => {
    matrix = qrMatrix(url);
  });
  assert.ok(matrix.length >= 21);

  const png = renderQrPng(url);
  const img = decodePNG(png);
  assert.ok(img.width > 0 && img.height > 0);
  assert.equal(img.width, img.height);
});
