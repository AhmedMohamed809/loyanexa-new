// apps/demo/cardImages.ts — validating, normalising and storing merchant
// image uploads (the card designer's logo/icon/cover controls, BUILD.md
// §8.5 step 1 and §8.9 step 2). Split out of server.ts, same reasoning as
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
// A validated upload is then normalised and re-encoded as PNG before it is
// ever stored or hashed. That bounds storage regardless of what was
// uploaded (a 12 MP phone photo becomes one sensible asset), strips any
// embedded metadata, and means the hash used everywhere downstream
// (StripSpec's cache key, the pass bundle) is computed from the exact bytes
// the renderer will use. The cover is resized to a fixed target size (it
// fills a fixed-shape band); the logo and icon are both scaled to fit
// within their own bounding box, keeping their own aspect ratio — see
// `LOGO_MAX_DIMENSION`'s own doc comment for why forcing either into a
// square *at upload time* would have been wrong: it would bake in a
// Fit/Fill decision the designer's live toggle (StripSpec.iconFit) needs to
// keep being able to change without a re-upload.

import { decodeImage, resizeRGBA, resizeToFit, encodePNG, imageHash, opaqueBoundingBox, decodePNG } from '../../packages/image/src/index.ts';
import type { DecodedImage, Fit } from '../../packages/image/src/index.ts';
import { prisma } from '../../packages/db/src/index.ts';

/** Hard cap on an upload's raw size, checked before it is fully read into memory (server.ts). */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/**
 * The cap applied to the *whole* multipart request body (server.ts /
 * multipart.ts), a little above `MAX_UPLOAD_BYTES` to leave room for
 * multipart boundary/header overhead around the one file part. The file
 * part itself is still checked against the exact `MAX_UPLOAD_BYTES` limit
 * in `normalizeUpload` — this constant only bounds how much the server will
 * ever buffer for one request.
 */
export const MAX_UPLOAD_REQUEST_BYTES = MAX_UPLOAD_BYTES + 64 * 1024;

/** Hard cap on an upload's pixel dimensions — well under the decoder's own 100-megapixel cap, so a bad upload fails with a specific, actionable message instead of a generic one. */
export const MAX_UPLOAD_DIMENSION = 4000;

/**
 * Longest-side cap for a normalised logo — the logo is scaled to fit within
 * a `LOGO_MAX_DIMENSION` × `LOGO_MAX_DIMENSION` box, keeping its own aspect
 * ratio, not padded or stretched into an exact square.
 *
 * This used to force every logo into an exact 512×512 square (padded onto
 * transparent, "the same normalised size doubles as the merchant-logo
 * stamp image" per BUILD.md §8.9's mention of a 512×512 Google-Wallet
 * icon). That was wrong: padding the *stored* asset into a square made
 * every downstream consumer's own aspect handling a no-op by the time it
 * ever saw the image — circularMask's contain/cover fit had nothing left
 * to do (the source was already square), silently defeating the
 * merchant's Fit/Fill choice for any non-square logo, and the same padded
 * square was also what ended up as the Apple Wallet header's logo.png,
 * where a real merchant wordmark should keep its own rectangular shape.
 * BUILD.md §8.9 actually describes the logo and the square Google-Wallet
 * icon as two *separate* assets ("logo · icon 512×512, required by Google
 * Wallet · cover") — the logo (this constant) and the icon (see
 * `ICON_MAX_DIMENSION` below) are now genuinely separate uploads, each
 * kept in its own natural aspect ratio; a hard square is only ever derived
 * on demand (see `squareIconAsset`), never baked into the stored asset.
 */
export const LOGO_MAX_DIMENSION = 512;

/**
 * Longest-side cap for a normalised icon — same reasoning as
 * `LOGO_MAX_DIMENSION`, kept as its own named constant (even though the
 * number happens to match today) because it constrains a conceptually
 * different upload: the icon is the merchant's own square-ish mark used as
 * the filled-stamp graphic (BUILD.md §8.5 step 2 / §8.9), never the
 * wordmark. Storing it aspect-preserving (not force-padded into a square)
 * is what lets the designer's Fit/Fill toggle (`iconFit`) actually change
 * anything at render time — see strip.ts's `circularMask` call and
 * `squareIconAsset` below, which derive a true square on demand instead.
 */
export const ICON_MAX_DIMENSION = 512;

/** The @3x stamp-strip canvas size (packages/image/src/strip.ts's BASE_WIDTH/BASE_HEIGHT × 3) — covers is normalised to exactly this so it is pixel-matched to the highest-density strip render. */
export const COVER_WIDTH = 1125;
export const COVER_HEIGHT = 432;

export type UploadKind = 'logo' | 'icon' | 'cover';

export type NormalizeResult =
  | { ok: true; bytes: Buffer; width: number; height: number; hash: string; wideLogo: boolean }
  | { ok: false; error: string };

/**
 * A logo whose opaque content is at least this many times wider than tall —
 * a wordmark shape, the overwhelmingly common case for a real merchant logo
 * (the reasoning behind BUILD.md §8.5's transparent-logo-detection hint
 * extends naturally here: inform, don't block). Used by `isWideLogo` and
 * surfaced to the designer so it can show a non-blocking hint that a wide
 * mark makes a small stamp under a contain fit.
 */
export const WIDE_LOGO_RATIO = 2;

/**
 * True when `img`'s opaque content is a wordmark shape (see
 * `WIDE_LOGO_RATIO`). Uses `opaqueBoundingBox` rather than `img.width` /
 * `img.height` directly so a logo with its own internal transparent margin
 * (common in real logo artwork — see the doc comment on `LOGO_MAX_DIMENSION`
 * for the real brand/logo.png example) is measured by its actual ink, not
 * by the canvas it happens to sit on.
 */
export function isWideLogo(img: DecodedImage): boolean {
  const box = opaqueBoundingBox(img);
  if (!box) return false;
  return box.width / box.height >= WIDE_LOGO_RATIO;
}

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

  if (kind === 'cover') {
    // The cover fills the strip's fixed-shape band exactly, so it keeps a
    // plain stretch-resize to that exact target size.
    const resized = resizeRGBA(decoded, COVER_WIDTH, COVER_HEIGHT);
    const png = encodePNG(resized.rgba, COVER_WIDTH, COVER_HEIGHT);
    const hash = imageHash(png);
    return { ok: true, bytes: png, width: COVER_WIDTH, height: COVER_HEIGHT, hash, wideLogo: false };
  }

  // Logo and icon are both scaled to fit within their own bounding box on
  // the longer side, keeping their own aspect ratio — never padded or
  // stretched into a square (see LOGO_MAX_DIMENSION's/ICON_MAX_DIMENSION's
  // own doc comments for why that would defeat circularMask's contain/cover
  // fit and distort the pass header's logo.png).
  const maxDimension = kind === 'icon' ? ICON_MAX_DIMENSION : LOGO_MAX_DIMENSION;
  const scale = Math.min(maxDimension / decoded.width, maxDimension / decoded.height);
  const width = Math.max(1, Math.round(decoded.width * scale));
  const height = Math.max(1, Math.round(decoded.height * scale));
  const resized = resizeRGBA(decoded, width, height);
  const png = encodePNG(resized.rgba, width, height);
  const hash = imageHash(png);
  // Reused for both logo and icon uploads: a wordmark-shaped logo gets the
  // "looks small as a stamp" hint (moot now that a logo is never the
  // stamp, but still useful as "this looks like a wordmark, are you sure?"
  // feedback); a similarly non-square icon gets the designer's Fit/Fill
  // reminder that some of it will be cropped or padded.
  const wideLogo = isWideLogo(resized);

  return { ok: true, bytes: png, width, height, hash, wideLogo };
}

/**
 * The exact square PNG Google Wallet's icon requirement (BUILD.md §8.9)
 * needs, derived on demand from a normalised icon upload (which itself
 * preserves the source's own aspect ratio — see `ICON_MAX_DIMENSION`'s doc
 * comment). `fit` is the same Fit/Fill choice (and the same underlying
 * `resizeToFit`) the live stamp mask uses at render time
 * (packages/image/src/strip.ts's `circularMask` call), so what a merchant
 * sees in the designer's Fit/Fill toggle is exactly what a square export
 * would contain. A source that is already square makes `fit` a no-op — see
 * `resizeToFit`'s own doc comment.
 *
 * Not yet wired into a live Google Wallet call:
 * packages/pass/src/googleWallet.ts's `ensureLoyaltyClass` still points
 * `programLogo` at a static brand asset, because Google fetches that URL
 * itself and needs a publicly reachable HTTPS origin — this local dev
 * environment does not have one (see that file's own `programLogo`
 * comment). Wiring it up is then a matter of exposing this function's
 * output at a public URL and passing it through, not changing this
 * function.
 */
export function squareIconAsset(icon: DecodedImage, fit: Fit): { bytes: Buffer; width: number; height: number } {
  const squared = resizeToFit(icon, ICON_MAX_DIMENSION, ICON_MAX_DIMENSION, fit);
  const bytes = encodePNG(squared.rgba, ICON_MAX_DIMENSION, ICON_MAX_DIMENSION);
  return { bytes, width: ICON_MAX_DIMENSION, height: ICON_MAX_DIMENSION };
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

/** The public, cacheable URL for a stored image — used for `Card.logoUrl`/`iconUrl`/`coverUrl` alike, and the designer's `<img>` previews. */
export function imageUrl(hash: string): string {
  return `/img/${hash}`;
}

const HASH_RE = /^[0-9a-f]{64}$/;

/** True for a syntactically valid sha256 hex hash — cheap guard before a DB lookup by hash (GET /img/:hash, preview.png's logo=/cover= params). */
export function isValidHash(value: string | null | undefined): value is string {
  return typeof value === 'string' && HASH_RE.test(value);
}

/**
 * Same check as `isWideLogo`, but reading a previously-stored `CardImage`
 * by hash — used to render the designer's wide-logo hint on page load
 * (`GET /cards/:id/edit`) for a card whose logo was uploaded in an earlier
 * request, not just the upload response of the current one.
 */
export async function isStoredLogoWide(hash: string | null | undefined): Promise<boolean> {
  if (!isValidHash(hash)) return false;
  const row = await prisma.cardImage.findUnique({ where: { hash } });
  if (!row) return false;
  return isWideLogo(decodePNG(new Uint8Array(row.bytes)));
}
