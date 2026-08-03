#!/usr/bin/env node
// scripts/vendor-jsqr.ts
//
// The stamp screen's camera scanner (apps/demo/public/index.html,
// BUILD.md §8.15) needs a real QR decoder that works even where
// `BarcodeDetector` does not — absent on iOS/iPadOS Safari, every Firefox,
// and Chrome on Windows/Linux (§8.15's own note). jsQR is the pure-JS
// decoder BUILD.md names for that job. It ships no build step and no WASM
// toolchain, but it is still a *browser* dependency: this plain-http demo
// has no bundler, so `import jsqr from 'jsqr'` (Node module resolution)
// cannot reach the page. Instead, jsQR is an ordinary npm dependency (see
// package.json) purely so its published `dist/jsQR.js` — a self-contained
// UMD bundle that sets `window.jsQR` when loaded via a plain <script> tag —
// has a pinned, auditable version and lockfile entry, and this script
// copies that one file, verbatim, into apps/demo/public/ so the demo
// server's existing static handler serves it from our own origin. No CDN
// <script src> is used anywhere.
//
// Idempotent: safe to run on every `npm install`/`npm ci` (see the
// "postinstall" script in package.json) as well as by hand.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'node_modules/jsqr/package.json'), 'utf8')) as {
  version: string;
  license: string;
};

const srcPath = require.resolve('jsqr');
const destPath = path.join(ROOT, 'apps/demo/public/jsQR.js');

const banner = `/*
 * jsQR v${pkg.version} — vendored, unmodified, from https://www.npmjs.com/package/jsqr
 * License: ${pkg.license} — see node_modules/jsqr/LICENSE after \`npm install\`.
 * Copied verbatim by scripts/vendor-jsqr.ts; served from our own origin
 * (never a CDN) so the stamp screen's camera scanner has no third-party
 * runtime dependency. Exposes a global \`jsQR\` function.
 */
`;

const source = readFileSync(srcPath, 'utf8');
writeFileSync(destPath, banner + source);

console.log(`vendored jsqr@${pkg.version} (${pkg.license}) -> apps/demo/public/jsQR.js (${(banner + source).length.toLocaleString()} bytes)`);
