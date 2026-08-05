// apps/demo/templateAssets.ts — the photography that ships with the card
// templates (BUILD.md §8.4).
//
// The images live in apps/demo/assets/ rather than apps/demo/public/ on
// purpose: they are *source* images, not served files. Each one is put
// through the same `normalizeUpload('cover')` pipeline a merchant's own
// upload goes through — decoded, resized to the strip's 1125x432, re-encoded
// and content-addressed — so a template's cover is stored, cached and served
// by exactly the code paths a real upload uses. Nothing here is a special
// case downstream; by the time a template is applied, its cover is an
// ordinary CardImage row.
//
// Ingestion is lazy and single-flight. Doing it at boot would spend a second
// or two decoding two dozen JPEGs on a 512MB machine before the first request
// could be served, and most boots never show the template gallery at all.
// Doing it per-request would redo the work every time. So: the first caller
// pays, everybody after that gets the cached map, and concurrent first
// callers share one promise rather than racing.
//
// LICENCE. Every photograph is from Unsplash or Pexels, both of which grant
// free commercial use with no attribution required. They are redistributed
// here inside a public repository on that basis. `docs/PHOTO-CREDITS.md`
// records where each one came from — not because attribution is required,
// but because "where did this file come from?" is a question that becomes
// unanswerable surprisingly quickly, and an unanswerable licence question is
// the kind that eventually has to be settled by deleting the file.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeUpload, storeCardImage } from './cardImages.ts';
import { log, errorFields } from './log.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = path.join(__dirname, 'assets', 'templates');

/** Photo id → content hash of the stored cover, once ingested. */
let cache: Map<string, string> | undefined;
let inFlight: Promise<Map<string, string>> | undefined;

async function ingestAll(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let files: string[];
  try {
    files = fs.readdirSync(ASSET_DIR).filter((f) => f.endsWith('.jpg'));
  } catch {
    // No asset directory (a trimmed deployment, or a test fixture) is not an
    // error: templates simply render without photography, which is exactly
    // how they behaved before the photos existed.
    return map;
  }

  for (const file of files) {
    const id = file.replace(/\.jpg$/, '');
    try {
      const result = normalizeUpload('cover', fs.readFileSync(path.join(ASSET_DIR, file)));
      if (!result.ok) {
        log.warn('templates.photo_rejected', { file, reason: result.error });
        continue;
      }
      await storeCardImage(result);
      map.set(id, result.hash);
    } catch (err) {
      // One unreadable photo must not cost the whole gallery its imagery.
      log.error('templates.photo_failed', { file, ...errorFields(err) });
    }
  }
  return map;
}

/**
 * The photo id → hash map, ingesting on first call.
 *
 * Callers should treat a missing id as "this template has no photo" rather
 * than as a failure — see the empty-map case above.
 */
export async function templatePhotoHashes(): Promise<Map<string, string>> {
  if (cache) return cache;
  if (!inFlight) {
    inFlight = ingestAll()
      .then((map) => {
        cache = map;
        log.info('templates.photos_ready', { count: map.size });
        return map;
      })
      .finally(() => {
        inFlight = undefined;
      });
  }
  return inFlight;
}

/** Test seam: forget what has been ingested so the next call re-reads the directory. */
export function resetTemplatePhotoCache(): void {
  cache = undefined;
  inFlight = undefined;
}
