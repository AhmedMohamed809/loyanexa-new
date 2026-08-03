// apps/demo/test/cardImages.test.ts — the upload validation/normalisation/
// storage pipeline (apps/demo/cardImages.ts). Real local Postgres for the
// storage half, same "no mocks" convention as cardEdit.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from '../env.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnvFile(path.join(__dirname, '../../../.env'));

const { prisma } = await import('../../../packages/db/src/index.ts');
const { encodePNG } = await import('../../../packages/image/src/index.ts');
const {
  normalizeUpload,
  storeCardImage,
  imageUrl,
  isValidHash,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_DIMENSION,
  LOGO_SIZE,
  COVER_WIDTH,
  COVER_HEIGHT,
} = await import('../cardImages.ts');

/** A small, valid, randomised PNG so repeated test runs never collide on hash. */
function samplePng(width: number, height: number): Buffer {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = Math.floor(Math.random() * 256);
    rgba[i + 1] = Math.floor(Math.random() * 256);
    rgba[i + 2] = Math.floor(Math.random() * 256);
    rgba[i + 3] = 255;
  }
  return encodePNG(rgba, width, height);
}

async function cleanupHash(hash: string): Promise<void> {
  await prisma.cardImage.delete({ where: { hash } }).catch(() => {});
}

test('an upload over 2 MB is rejected with a clear message, before decoding', () => {
  const oversized = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 1);
  const result = normalizeUpload('logo', oversized);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /2 MB|byte/i);
});

test('an upload that is not a decodable image is rejected with a clear message', () => {
  const notAnImage = Buffer.from('this is definitely not an image file');
  const result = normalizeUpload('cover', notAnImage);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /decode/i);
});

test('an upload whose dimensions exceed 4000x4000 is rejected with a clear message', () => {
  // A real, decodable PNG — just one dimension over the cap. Kept 1px tall
  // so the file itself stays tiny even though the width is large.
  const tooWide = samplePng(MAX_UPLOAD_DIMENSION + 1, 1);
  const result = normalizeUpload('logo', tooWide);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /4000/);
});

test('a valid logo upload is normalised to 512x512', () => {
  const upload = samplePng(37, 61); // an odd, non-square source size
  const result = normalizeUpload('logo', upload);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.width, LOGO_SIZE);
  assert.equal(result.height, LOGO_SIZE);
  assert.ok(result.hash.length === 64, 'hash should be a sha256 hex digest');
});

test('a valid cover upload is normalised to the @3x strip size (1125x432)', () => {
  const upload = samplePng(200, 200);
  const result = normalizeUpload('cover', upload);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.width, COVER_WIDTH);
  assert.equal(result.height, COVER_HEIGHT);
});

test('the hash is computed from the normalised bytes, not the upload — two different uploads that normalise identically hash the same', () => {
  // A 1x1 solid-colour source and a 3x3 same-colour source both resize to a
  // uniform 512x512 of that colour — proving the hash is over the *output*.
  const solid = (w: number, h: number, rgb: [number, number, number]): Buffer => {
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = rgb[0]; rgba[i + 1] = rgb[1]; rgba[i + 2] = rgb[2]; rgba[i + 3] = 255;
    }
    return encodePNG(rgba, w, h);
  };
  const a = normalizeUpload('logo', solid(1, 1, [10, 20, 30]));
  const b = normalizeUpload('logo', solid(3, 3, [10, 20, 30]));
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(a.hash, b.hash);
});

test('storing the same normalised image twice writes exactly one CardImage row', async () => {
  const upload = samplePng(64, 64);
  const result = normalizeUpload('logo', upload);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  try {
    await storeCardImage(result);
    await storeCardImage(result);
    const rows = await prisma.cardImage.findMany({ where: { hash: result.hash } });
    assert.equal(rows.length, 1, `expected exactly one row, found ${rows.length}`);
    assert.equal(rows[0]!.width, LOGO_SIZE);
    assert.equal(rows[0]!.mime, 'image/png');
    assert.equal(rows[0]!.bytes.length, result.bytes.length);
  } finally {
    await cleanupHash(result.hash);
  }
});

test('imageUrl and isValidHash', () => {
  const hash = 'a'.repeat(64);
  assert.equal(imageUrl(hash), `/img/${hash}`);
  assert.equal(isValidHash(hash), true);
  assert.equal(isValidHash('not-a-hash'), false);
  assert.equal(isValidHash(null), false);
  assert.equal(isValidHash(undefined), false);
});
