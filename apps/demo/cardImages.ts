// apps/demo/cardImages.ts — validating, normalising and storing merchant
// image uploads (the card designer's logo/cover controls, BUILD.md §8.5
// step 1 and §8.9 step 2). Split out of server.ts, same reasoning as
// cardEdit.ts: this is pure(ish) logic — decode, resize, encode, hash,
// upsert one row — that apps/demo/test/cardImages.test.ts exercises
// directly against the real local Postgres, without going through HTTP.
//
// This is a public, unauthenticated endpoint (POST /cards/:id/image), so
// every check here is a hard reject, not a best-effort clamp:
//   - size, checked before the body is even fully read (server.ts/multipart.ts)
//   - decodability, via @loyanexa/image's own decodeImage (PNG/JPEG only)
//   - pixel dimensions, rejected here with a clear message *before* the
//     decoder's own 100-megapixel cap would otherwise be the only backstop
// A validated upload is then normalised — resized to a fixed target size and
// re-encoded as PNG — before it is ever stored or hashed. That bounds
// storage to a known size regardless of what was uploaded (a 12 MP phone
// photo becomes one sensible asset), strips any embedded metadata, and
// means the hash used everywhere downstream (StripSpec's cache key, the
// pass bundle) is computed from the exact bytes the renderer will use.

import { decodeImage, resizeRGBA, encodePNG, imageHash } from '../../packages/image/src/index.ts';
import { prisma } from '../../packages/db/src/index.ts';

/** Hard cap on an upload's raw size, checked before it is fully read into memory (server.ts). */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/** Hard cap on an upload's pixel dimensions — well under the decoder's own 100-megapixel cap, so a bad upload fails with a specific, actionable message instead of a generic one. */
export const MAX_UPLOAD_DIMENSION = 4000;

/** Google Wallet requires a 512×512 icon (BUILD.md §8.9) — the same normalised size doubles as the merchant-logo stamp image (StripSpec.logo). */
export const LOGO_SIZE = 512;

/** The @3x stamp-strip canvas size (packages/image/src/strip.ts's BASE_WIDTH/BASE_HEIGHT × 3) — covers is normalised to exactly this so it is pixel-matched to the highest-density strip render. */
export const COVER_WIDTH = 1125;
export const COVER_HEIGHT = 432;

export type UploadKind = 'logo' | 'cover';

export type NormalizeResult =
  | { ok: true; bytes: Buffer; width: number; height: number; hash: string }
  | { ok: false; error: string };

/** Decodes, validates and normalises a raw upload for `kind`. Pure — no I/O, no database. */
export function normalizeUpload(kind: UploadKind, raw: Buffer): NormalizeResult {
  if (raw.length === 0) {
    return { ok: false, error: 'the uploaded file is empty' };
  }
  if (raw.length > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `image is ${raw.length} bytes, over the ${MAX_UPLOAD_BYTES}-byte (2 MB) limit`,
    };
  }

  let decoded: ReturnType<typeof decodeImage>;
  try {
    decoded = decodeImage(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `could not decode image: ${message}` };
  }

  if (decoded.width > MAX_UPLOAD_DIMENSION || decoded.height > MAX_UPLOAD_DIMENSION) {
    return {
      ok: false,
      error:
        `image is ${decoded.width}x${decoded.height}, over the ` +
        `${MAX_UPLOAD_DIMENSION}x${MAX_UPLOAD_DIMENSION} maximum`,
    };
  }

  const [targetWidth, targetHeight] = kind === 'logo' ? [LOGO_SIZE, LOGO_SIZE] : [COVER_WIDTH, COVER_HEIGHT];
  const resized = resizeRGBA(decoded, targetWidth, targetHeight);
  const png = encodePNG(resized.rgba, targetWidth, targetHeight);
  const hash = imageHash(png);

  return { ok: true, bytes: png, width: targetWidth, height: targetHeight, hash };
}

/**
 * Stores a normalised image's bytes, keyed by content hash — an upsert with
 * an empty `update`, so uploading the same (already-normalised) bytes twice
 * writes the row once (BUILD.md §18 item 2's "rows reach megabytes" harm is
 * avoided at the `Card` level; this is the one place those bytes live at
 * all — see the `CardImage` model's own doc comment in schema.prisma).
 */
export async function storeCardImage(result: { bytes: Buffer; width: number; height: number; hash: string }): Promise<void> {
  // Prisma's generated `Bytes` type is `Uint8Array<ArrayBuffer>`; a Node
  // `Buffer` is a `Uint8Array<ArrayBufferLike>` (its backing store can be a
  // `SharedArrayBuffer`), which TypeScript won't narrow automatically —
  // copy into a plain `Uint8Array` to satisfy that at the type level.
  const bytes = new Uint8Array(result.bytes);
  await prisma.cardImage.upsert({
    where: { hash: result.hash },
    update: {},
    create: { hash: result.hash, bytes, width: result.width, height: result.height, mime: 'image/png' },
  });
}

/** The public, cacheable URL for a stored image — used both for `Card.logoIconUrl`/`coverUrl` and the designer's `<img>` previews. */
export function imageUrl(hash: string): string {
  return `/img/${hash}`;
}

const HASH_RE = /^[0-9a-f]{64}$/;

/** True for a syntactically valid sha256 hex hash — cheap guard before a DB lookup by hash (GET /img/:hash, preview.png's logo=/cover= params). */
export function isValidHash(value: string | null | undefined): value is string {
  return typeof value === 'string' && HASH_RE.test(value);
}
