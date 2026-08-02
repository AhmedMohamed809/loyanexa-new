import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { encodePNG } from '../src/png/encode.ts';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunks(png: Buffer): { type: string; data: Buffer }[] {
  const out: { type: string; data: Buffer }[] = [];
  let o = 8;
  while (o < png.length) {
    const len = png.readUInt32BE(o);
    const type = png.subarray(o + 4, o + 8).toString('latin1');
    out.push({ type, data: png.subarray(o + 8, o + 8 + len) });
    o += 12 + len;
  }
  return out;
}

test('starts with the PNG signature', () => {
  const png = encodePNG(new Uint8Array(4), 1, 1);
  assert.deepEqual(png.subarray(0, 8), SIG);
});

test('emits IHDR, IDAT then IEND, and nothing else', () => {
  const png = encodePNG(new Uint8Array(2 * 2 * 4), 2, 2);
  assert.deepEqual(chunks(png).map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
});

test('IHDR describes 8-bit RGBA, non-interlaced', () => {
  const png = encodePNG(new Uint8Array(3 * 5 * 4), 3, 5);
  const ihdr = chunks(png)[0]!.data;
  assert.equal(ihdr.readUInt32BE(0), 3, 'width');
  assert.equal(ihdr.readUInt32BE(4), 5, 'height');
  assert.equal(ihdr[8], 8, 'bit depth');
  assert.equal(ihdr[9], 6, 'colour type RGBA');
  assert.equal(ihdr[12], 0, 'interlace');
});

test('IDAT inflates to filter-0 scanlines carrying the exact pixels', () => {
  const rgba = Uint8Array.from([
    1, 2, 3, 4, 5, 6, 7, 8,
    9, 10, 11, 12, 13, 14, 15, 16,
  ]);
  const png = encodePNG(rgba, 2, 2);
  const raw = inflateSync(chunks(png)[1]!.data);
  assert.equal(raw.length, (2 * 4 + 1) * 2);
  assert.equal(raw[0], 0, 'row 0 filter byte');
  assert.deepEqual([...raw.subarray(1, 9)], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(raw[9], 0, 'row 1 filter byte');
  assert.deepEqual([...raw.subarray(10, 18)], [9, 10, 11, 12, 13, 14, 15, 16]);
});

test('rejects a buffer whose length does not match the dimensions', () => {
  assert.throws(() => encodePNG(new Uint8Array(5), 2, 2), /expected 16 bytes/);
});

test('is deterministic', () => {
  const rgba = new Uint8Array(8 * 8 * 4).fill(0x5a);
  assert.deepEqual(encodePNG(rgba, 8, 8), encodePNG(rgba, 8, 8));
});
