import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { encodePNG } from '../src/png/encode.ts';
import { decodePNG } from '../src/png/decode.ts';
import { crc32 } from '../src/png/crc.ts';

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

// Test helper: build PNG files by hand
function buildPNG(params: {
  width: number;
  height: number;
  depth: number;
  colourType: number;
  interlace: boolean;
  palette?: Uint8Array;
  transparency?: Uint8Array;
  scanlines: Uint8Array;
}): Buffer {
  const chunks: Buffer[] = [];

  // PNG signature
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  chunks.push(sig);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(params.width, 0);
  ihdr.writeUInt32BE(params.height, 4);
  ihdr[8] = params.depth;
  ihdr[9] = params.colourType;
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = params.interlace ? 1 : 0;
  chunks.push(createChunk('IHDR', ihdr));

  // PLTE chunk (if palette)
  if (params.palette) {
    chunks.push(createChunk('PLTE', params.palette));
  }

  // tRNS chunk (if transparency)
  if (params.transparency) {
    chunks.push(createChunk('tRNS', params.transparency));
  }

  // IDAT chunk
  const compressed = deflateSync(params.scanlines);
  chunks.push(createChunk('IDAT', compressed));

  // IEND chunk
  chunks.push(createChunk('IEND', Buffer.alloc(0)));

  return Buffer.concat(chunks);
}

function createChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([len, typeBytes, data, crc]);
}

// Colour type tests
test('decodes colour type 0 (greyscale) to RGBA', () => {
  // 2x2 greyscale image
  const scanlines = Buffer.from([
    0, // filter type 0 (None)
    100, 150, // two grey pixels
    0, // filter type 0
    200, 50, // two more grey pixels
  ]);
  const png = buildPNG({
    width: 2,
    height: 2,
    depth: 8,
    colourType: 0,
    interlace: false,
    scanlines,
  });
  const decoded = decodePNG(png);
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 2);
  // Each greyscale pixel expands to (grey, grey, grey, 255)
  assert.deepEqual(decoded.rgba, Uint8Array.from([
    100, 100, 100, 255, 150, 150, 150, 255,
    200, 200, 200, 255, 50, 50, 50, 255,
  ]));
});

test('decodes colour type 2 (RGB) to RGBA', () => {
  // 2x2 RGB image
  const scanlines = Buffer.from([
    0, // filter
    255, 0, 0, 0, 255, 0, // red, green
    0, // filter
    0, 0, 255, 100, 100, 100, // blue, grey
  ]);
  const png = buildPNG({
    width: 2,
    height: 2,
    depth: 8,
    colourType: 2,
    interlace: false,
    scanlines,
  });
  const decoded = decodePNG(png);
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 2);
  // RGB expands to RGBA with A=255
  assert.deepEqual(decoded.rgba, Uint8Array.from([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 100, 100, 100, 255,
  ]));
});

test('decodes colour type 4 (greyscale + alpha) to RGBA', () => {
  // 2x2 greyscale+alpha image
  const scanlines = Buffer.from([
    0, // filter
    100, 255, 150, 128, // grey+alpha pairs
    0, // filter
    200, 0, 50, 64, // grey+alpha pairs
  ]);
  const png = buildPNG({
    width: 2,
    height: 2,
    depth: 8,
    colourType: 4,
    interlace: false,
    scanlines,
  });
  const decoded = decodePNG(png);
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 2);
  // Greyscale+alpha expands to RGBA
  assert.deepEqual(decoded.rgba, Uint8Array.from([
    100, 100, 100, 255, 150, 150, 150, 128,
    200, 200, 200, 0, 50, 50, 50, 64,
  ]));
});

test('decodes colour type 3 (palette) to RGBA', () => {
  // Build a small palette (first 4 entries only)
  const palette = Buffer.alloc(256 * 3);
  palette[0] = 255; palette[1] = 0; palette[2] = 0; // red
  palette[3] = 0; palette[4] = 255; palette[5] = 0; // green
  palette[6] = 0; palette[7] = 0; palette[8] = 255; // blue
  palette[9] = 128; palette[10] = 128; palette[11] = 128; // grey

  // tRNS chunk: make index 0 semi-transparent
  const transparency = Buffer.alloc(256, 255); // default opaque
  transparency[0] = 128; // index 0 is semi-transparent

  // 2x2 palette image
  const scanlines = Buffer.from([
    0, // filter
    0, 1, // indices to palette
    0, // filter
    2, 3, // indices to palette
  ]);
  const png = buildPNG({
    width: 2,
    height: 2,
    depth: 8,
    colourType: 3,
    interlace: false,
    palette,
    transparency,
    scanlines,
  });
  const decoded = decodePNG(png);
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 2);
  // Palette indices expand to RGBA with transparency honoured
  assert.deepEqual(decoded.rgba, Uint8Array.from([
    255, 0, 0, 128, 0, 255, 0, 255, // index 0 with transparency, index 1
    0, 0, 255, 255, 128, 128, 128, 255, // index 2, index 3
  ]));
});

// Filter type tests
test('decodes filter type 1 (Sub)', () => {
  // 2x1 image with filter type 1 (Sub)
  // Filter encodes: byte = (value - left_byte) & 0xff
  // So to get decoded [100, 200], we encode: [100, (200 - 100) & 0xff] = [100, 100]
  const scanlines = Buffer.from([
    1, // filter type 1 (Sub)
    100, 100, // encoded as Sub: 100, then (200 - 100) = 100
  ]);
  const png = buildPNG({
    width: 2,
    height: 1,
    depth: 8,
    colourType: 0,
    interlace: false,
    scanlines,
  });
  const decoded = decodePNG(png);
  // Decoded greyscale [100, 200] should expand to RGBA
  assert.deepEqual(decoded.rgba, Uint8Array.from([
    100, 100, 100, 255, 200, 200, 200, 255,
  ]));
});

test('decodes filter type 2 (Up)', () => {
  // 2x2 image with filter type 2 (Up)
  // Filter encodes: byte = (value - up_byte) & 0xff
  // Row 0: [100, 150] with no up, so filter = [100, 150]
  // Row 1: [100, 150] but filter = (value - up) so [0, 0] encodes to get [100, 150]
  const scanlines = Buffer.from([
    2, // filter type 2 (Up)
    100, 150,
    2, // filter type 2
    0, 0, // (100 - 100) = 0, (150 - 150) = 0
  ]);
  const png = buildPNG({
    width: 2,
    height: 2,
    depth: 8,
    colourType: 0,
    interlace: false,
    scanlines,
  });
  const decoded = decodePNG(png);
  assert.deepEqual(decoded.rgba, Uint8Array.from([
    100, 100, 100, 255, 150, 150, 150, 255,
    100, 100, 100, 255, 150, 150, 150, 255,
  ]));
});

test('decodes filter type 3 (Average)', () => {
  // 2x2 image with filter type 3 (Average)
  // Filter encodes: byte = (value - floor((left + up) / 2)) & 0xff
  // Row 0, col 0: no left/up, so avg = 0, encode 100 as 100
  // Row 0, col 1: left=100, no up, so avg = 50, encode 150 as (150 - 50) = 100
  // Row 1, col 0: up=100, no left, so avg = 50, encode 100 as (100 - 50) = 50
  // Row 1, col 1: left=100, up=150, so avg = floor((100+150)/2) = 125, encode 150 as (150 - 125) = 25
  const scanlines = Buffer.from([
    3, // filter type 3
    100, 100,
    3, // filter type 3
    50, 25,
  ]);
  const png = buildPNG({
    width: 2,
    height: 2,
    depth: 8,
    colourType: 0,
    interlace: false,
    scanlines,
  });
  const decoded = decodePNG(png);
  assert.deepEqual(decoded.rgba, Uint8Array.from([
    100, 100, 100, 255, 150, 150, 150, 255,
    100, 100, 100, 255, 150, 150, 150, 255,
  ]));
});

test('decodes filter type 4 (Paeth)', () => {
  // 2x2 image with filter type 4 (Paeth)
  // Paeth predictor: choose among left, up, upleft based on distance
  // Row 0: no left/up/upleft, all predictors = 0
  // Row 0, col 0: encode 100 as 100
  // Row 0, col 1: left=100, no up/upleft, paeth picks left=100, encode 200 as (200 - 100) = 100
  // Row 1, col 0: up=100, no left/upleft, paeth picks up=100, encode 50 as (50 - 100) = -50 = 206 (mod 256)
  // Row 1, col 1: left=50, up=200, upleft=100
  //   p = 50 + 200 - 100 = 150
  //   pa = |150 - 50| = 100, pb = |150 - 200| = 50, pc = |150 - 100| = 50
  //   pb == pc, so paeth = 200
  //   encode 75 as (75 - 200) = -125 = 131 (mod 256)
  const scanlines = Buffer.from([
    4, // filter type 4
    100, 100,
    4, // filter type 4
    206, 131,
  ]);
  const png = buildPNG({
    width: 2,
    height: 2,
    depth: 8,
    colourType: 0,
    interlace: false,
    scanlines,
  });
  const decoded = decodePNG(png);
  assert.deepEqual(decoded.rgba, Uint8Array.from([
    100, 100, 100, 255, 200, 200, 200, 255,
    50, 50, 50, 255, 75, 75, 75, 255,
  ]));
});

test('rejects interlaced PNGs', () => {
  const scanlines = Buffer.from([0, 100, 150]);
  const png = buildPNG({
    width: 2,
    height: 1,
    depth: 8,
    colourType: 0,
    interlace: true, // This should cause rejection
    scanlines,
  });
  assert.throws(() => decodePNG(png), /interlaced/i);
});

test('rejects non-8-bit depth', () => {
  const scanlines = Buffer.from([0, 100, 150]);
  const png = buildPNG({
    width: 2,
    height: 1,
    depth: 16, // 16-bit, not supported
    colourType: 0,
    interlace: false,
    scanlines,
  });
  assert.throws(() => decodePNG(png), /unsupported|depth/i);
});
