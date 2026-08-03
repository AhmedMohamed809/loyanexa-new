#!/usr/bin/env node
// scripts/resize-logo.ts
//
// Downscales the owner's real logo files (brand/logo.png, brand/logo-dark.png
// — 1485x302, ~150-180 KB each, sampled straight from the source artwork) to
// a sensible on-page display size, using our own @loyanexa/image resampler
// (decodePNG / resizeRGBA / encodePNG) rather than reaching for a
// third-party image tool — dogfooding the project's own PNG pipeline.
//
// The landing page shows the logo lockup at ~19-28px tall (see
// apps/demo/public/index.html's `lockup()`), which at the real file's
// 1485:302 aspect ratio is roughly 95-140 CSS px wide. 300px wide covers a
// crisp 2x/retina render at every size the page actually uses, at a
// fraction of the source file's bytes.
//
// Output lands directly in apps/demo/public/ — the demo server already
// serves that directory's contents as static files verbatim
// (apps/demo/server.ts's serveStaticFile()), so no route changes are
// needed to make the resized files reachable over HTTP.
//
// Run: node scripts/resize-logo.ts

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG, resizeRGBA, encodePNG } from '../packages/image/src/index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SOURCE_WIDTH = 1485;
const SOURCE_HEIGHT = 302;
const TARGET_WIDTH = 300;
const TARGET_HEIGHT = Math.round((TARGET_WIDTH * SOURCE_HEIGHT) / SOURCE_WIDTH);

const FILES = ['logo.png', 'logo-dark.png'];

for (const name of FILES) {
  const srcPath = path.join(ROOT, 'brand', name);
  const destPath = path.join(ROOT, 'apps/demo/public', name);

  const srcBytes = readFileSync(srcPath);
  const decoded = decodePNG(srcBytes);
  if (decoded.width !== SOURCE_WIDTH || decoded.height !== SOURCE_HEIGHT) {
    throw new Error(
      `${name}: expected ${SOURCE_WIDTH}x${SOURCE_HEIGHT}, got ${decoded.width}x${decoded.height} — ` +
        'update the SOURCE_WIDTH/SOURCE_HEIGHT constants above if the source logo changed.'
    );
  }

  const resized = resizeRGBA(decoded, TARGET_WIDTH, TARGET_HEIGHT);
  const outBytes = encodePNG(resized.rgba, resized.width, resized.height);
  writeFileSync(destPath, outBytes);

  const before = srcBytes.length;
  const after = outBytes.length;
  const pct = Math.round((1 - after / before) * 100);
  console.log(
    `${name}: ${before.toLocaleString()} bytes (${SOURCE_WIDTH}x${SOURCE_HEIGHT}) -> ` +
      `${after.toLocaleString()} bytes (${TARGET_WIDTH}x${TARGET_HEIGHT}), ${pct}% smaller`
  );
}
