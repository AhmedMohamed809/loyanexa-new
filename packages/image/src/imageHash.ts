import { createHash } from 'node:crypto';

/**
 * Content hash for an uploaded image, used as the sole cache identity for
 * that image throughout the strip pipeline (see `ImageRef.hash` in
 * strip.ts, and `stripCacheKey` in stripCache.ts, which hashes only this
 * string — never the pixels).
 *
 * Must be computed from the encoded upload bytes (the PNG/JPEG file exactly
 * as uploaded), not from the decoded RGBA. Never derive it from a URL,
 * filename, or timestamp: any of those let two different images collide
 * under one cache key (serving one merchant's logo in place of another's),
 * or let one unchanged image miss the cache on every request.
 */
export function imageHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
