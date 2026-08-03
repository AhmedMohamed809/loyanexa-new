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
const { encodePNG, decodePNG } = await import('../../../packages/image/src/index.ts');
const {
  normalizeUpload,
  storeCardImage,
  imageUrl,
  isValidHash,
  isStoredLogoWide,
  squareIconAsset,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_DIMENSION,
  LOGO_MAX_DIMENSION,
  ICON_MAX_DIMENSION,
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

test('a valid logo upload is scaled to fit within 512 on its longer side, keeping its own aspect ratio', () => {
  const upload = samplePng(37, 61); // an odd, non-square, portrait source
  const result = normalizeUpload('logo', upload);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // The taller side (61) hits the cap; the narrower side (37) is scaled by
  // the same factor, not stretched to also hit 512 (that would be the old,
  // wrong "always exactly 512x512" behaviour).
  assert.equal(result.height, LOGO_MAX_DIMENSION);
  assert.ok(result.width < LOGO_MAX_DIMENSION, `expected the narrower side to stay under ${LOGO_MAX_DIMENSION}, got ${result.width}`);
  assert.ok(Math.abs(result.width / result.height - 37 / 61) < 0.01, `expected aspect ratio to be preserved, got ${result.width}x${result.height}`);
  assert.ok(result.hash.length === 64, 'hash should be a sha256 hex digest');
});

/** A fully-opaque solid-colour source of an exact aspect ratio, distinct from samplePng's noise (which would make an opaque-bounding-box check meaningless). */
function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = rgb[0]; rgba[i + 1] = rgb[1]; rgba[i + 2] = rgb[2]; rgba[i + 3] = 255;
  }
  return encodePNG(rgba, width, height);
}

test('a wide wordmark logo keeps its own rectangular shape when normalised — not stretched, not padded into a square', () => {
  // 1485x302 is the exact shape of the owner's real brand/logo.png (~4.9:1).
  const upload = solidPng(1485, 302, [255, 128, 0]);
  const result = normalizeUpload('logo', upload);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.wideLogo, true, 'a ~4.9:1 wordmark should be flagged wide');
  assert.equal(result.width, LOGO_MAX_DIMENSION, 'the wider side hits the cap');
  assert.ok(Math.abs(result.width / result.height - 1485 / 302) < 0.02, `expected the ~4.9:1 aspect ratio to survive, got ${result.width}x${result.height}`);

  // A fully-opaque source stays fully opaque — there is nothing to pad or
  // crop once the output is no longer forced into a square canvas.
  const decoded = decodePNG(result.bytes);
  assert.equal(decoded.width, result.width);
  assert.equal(decoded.height, result.height);
  assert.equal(decoded.rgba[3], 255, 'top-left corner should be opaque, not transparent letterboxing');
  const lastPixel = (decoded.width * decoded.height - 1) * 4;
  assert.equal(decoded.rgba[lastPixel + 3], 255, 'bottom-right corner should be opaque, not transparent letterboxing');
});

test('a square logo upload stays square, unaffected either way', () => {
  const upload = solidPng(300, 300, [10, 20, 30]);
  const result = normalizeUpload('logo', upload);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.wideLogo, false);
  assert.equal(result.width, LOGO_MAX_DIMENSION);
  assert.equal(result.height, LOGO_MAX_DIMENSION);
  const decoded = decodePNG(result.bytes);
  assert.equal(decoded.rgba[3], 255, 'a square source should leave nothing transparent');
});

test('isStoredLogoWide reflects a previously-stored wide logo by hash, and false for an unknown/invalid hash', async () => {
  const upload = solidPng(1485, 302, [255, 128, 0]);
  const result = normalizeUpload('logo', upload);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  try {
    await storeCardImage(result);
    assert.equal(await isStoredLogoWide(result.hash), true);
    assert.equal(await isStoredLogoWide('a'.repeat(64)), false, 'unknown hash');
    assert.equal(await isStoredLogoWide('not-a-hash'), false, 'invalid hash');
    assert.equal(await isStoredLogoWide(null), false);
  } finally {
    await cleanupHash(result.hash);
  }
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
    assert.equal(rows[0]!.width, LOGO_MAX_DIMENSION);
    assert.equal(rows[0]!.mime, 'image/png');
    assert.equal(rows[0]!.bytes.length, result.bytes.length);
  } finally {
    await cleanupHash(result.hash);
  }
});

test('a valid icon upload is scaled to fit within 512 on its longer side, keeping its own aspect ratio — not force-squared at upload time', () => {
  const upload = samplePng(37, 61);
  const result = normalizeUpload('icon', upload);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.height, ICON_MAX_DIMENSION);
  assert.ok(result.width < ICON_MAX_DIMENSION);
  assert.ok(Math.abs(result.width / result.height - 37 / 61) < 0.01);
  // The wordmark-specific "wide" hint is a logo-only concept — an icon
  // upload never sets it, regardless of its own aspect ratio.
  assert.equal(result.wideLogo, false);
});

test('an uploaded non-square icon is normalized to 512×512 by squareIconAsset — the exact square Google Wallet requires (BUILD.md §8.9)', () => {
  const upload = solidPng(1485, 302, [255, 128, 0]); // a real-world non-square shape
  const normalized = normalizeUpload('icon', upload);
  assert.equal(normalized.ok, true);
  if (!normalized.ok) return;
  assert.notEqual(normalized.width, normalized.height, 'sanity: the normalised icon source itself is still non-square');

  const decoded = decodePNG(normalized.bytes);
  for (const fit of ['contain', 'cover'] as const) {
    const square = squareIconAsset(decoded, fit);
    assert.equal(square.width, 512, `${fit}: width`);
    assert.equal(square.height, 512, `${fit}: height`);
    const squareDecoded = decodePNG(square.bytes);
    assert.equal(squareDecoded.width, 512);
    assert.equal(squareDecoded.height, 512);
  }
  // contain (letterboxed) and cover (cropped) must differ for a genuinely
  // non-square source — the same Fit/Fill distinction the stamp mask uses.
  const contain = squareIconAsset(decoded, 'contain');
  const cover = squareIconAsset(decoded, 'cover');
  assert.notDeepEqual(contain.bytes, cover.bytes);
});

test('a square icon is unaffected by squareIconAsset\'s fit choice', () => {
  const upload = solidPng(300, 300, [10, 20, 30]);
  const normalized = normalizeUpload('icon', upload);
  assert.equal(normalized.ok, true);
  if (!normalized.ok) return;
  const decoded = decodePNG(normalized.bytes);
  const contain = squareIconAsset(decoded, 'contain');
  const cover = squareIconAsset(decoded, 'cover');
  assert.deepEqual(contain.bytes, cover.bytes);
});

test('imageUrl and isValidHash', () => {
  const hash = 'a'.repeat(64);
  assert.equal(imageUrl(hash), `/img/${hash}`);
  assert.equal(isValidHash(hash), true);
  assert.equal(isValidHash('not-a-hash'), false);
  assert.equal(isValidHash(null), false);
  assert.equal(isValidHash(undefined), false);
});
