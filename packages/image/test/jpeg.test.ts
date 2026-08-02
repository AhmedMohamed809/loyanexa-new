import { test } from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import { encodePNG } from '../src/png/encode.ts';
import { decodeJPEG, decodeImage } from '../src/jpeg.ts';

function sampleJPEG(w: number, h: number): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 200; data[i + 1] = 100; data[i + 2] = 50; data[i + 3] = 255;
  }
  return jpeg.encode({ data: Buffer.from(data), width: w, height: h }, 100).data;
}

test('decodes a JPEG to RGBA of the right shape', () => {
  const out = decodeJPEG(sampleJPEG(8, 4));
  assert.equal(out.width, 8);
  assert.equal(out.height, 4);
  assert.equal(out.rgba.length, 8 * 4 * 4);
  assert.equal(out.rgba[3], 255, 'opaque');
});

test('decodeImage sniffs JPEG', () => {
  assert.equal(decodeImage(sampleJPEG(4, 4)).width, 4);
});

test('decodeImage sniffs PNG', () => {
  assert.equal(decodeImage(encodePNG(new Uint8Array(2 * 2 * 4), 2, 2)).width, 2);
});

test('decodeImage rejects an unknown format', () => {
  assert.throws(() => decodeImage(Buffer.from('GIF89a....')), /unsupported image format/i);
});
