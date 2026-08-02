# Foundation and Stamp-Strip Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the LoyaNexa monorepo foundation plus a pure-JavaScript stamp-strip image renderer with a content-addressed cache, retiring the two highest-ranked risks in `BUILD.md` §18 before anything is built on top of them.

**Architecture:** An npm-workspaces monorepo under TypeScript strict. One substantive package, `@loyanexa/image`, builds PNGs from scratch — CRC32, chunk writer, inflate/deflate via `node:zlib`, an RGBA compositor with analytic anti-aliasing — and caches rendered strips by a SHA-256 of their visual identity, never by customer. Two supporting packages hold the Prisma schema and the bilingual dictionaries with a CI parity gate.

**Tech Stack:** Node 25, TypeScript 5 (strict + `noUncheckedIndexedAccess` + `erasableSyntaxOnly`), npm workspaces, `node:test`, `node:zlib`, `node:crypto`, Prisma + PostgreSQL 16, `jpeg-js`.

## Global Constraints

- **No native-dependency npm packages in the image pipeline.** `node:zlib` and `node:crypto` are Node core and are permitted. `sharp`, `@napi-rs/canvas`, `canvas` are forbidden (`BUILD.md` §17).
- **`jpeg-js` is the only npm dependency `@loyanexa/image` may add.**
- **TypeScript strict, plus `noUncheckedIndexedAccess`** (`BUILD.md` §17). Indexed access returns `T | undefined`; use `!` only where a bound has just been checked.
- **`erasableSyntaxOnly: true`** — Node 25 strips types natively, so no `enum`, no `namespace`, no parameter properties. This is what lets `node --test` run `.ts` files with no build step.
- **`StripSpec` must never contain a customer, pass, serial or merchant identifier.** The cache thesis in `BUILD.md` §10 depends on a strip being a pure function of its visual inputs.
- **Never commit `certs/`, `.env`, `*.pem`, `*.p8`, `*.cer`, `service-account*.json`.** The repository is public.
- **Slot layout is defined once**, exported from `@loyanexa/image`, and never reimplemented.
- **Canvas geometry:** 375 × 144 pt base; `@2x` = 750 × 288 px; `@3x` = 1125 × 432 px (`BUILD.md` §9.2).
- **Stamp goal range is 3–20 inclusive** (`BUILD.md` §8.5 step 5).
- Commit style: `feat(scope): summary`, `fix(scope): summary`, `chore(scope): summary` (`docs/CONTRIBUTING.md`).

---

## File Structure

```
package.json                          workspaces root; scripts
tsconfig.base.json                    strict compiler options, shared
.github/workflows/ci.yml              typecheck · test · i18n parity · secret guard

packages/image/
  package.json
  tsconfig.json
  src/
    index.ts                          public surface of the package
    png/crc.ts                        CRC32 table + checksum
    png/encode.ts                     PNG chunk writer, RGBA → Buffer
    png/decode.ts                     PNG reader, Buffer → RGBA
    jpeg.ts                           jpeg-js wrapper → RGBA
    raster/surface.ts                 RGBA buffer, source-over blending
    raster/shapes.ts                  anti-aliased disc, ring, rounded square
    raster/resize.ts                  box downscale
    raster/mask.ts                    circular mask with rim
    layout.ts                         goal → rows of slots
    strip.ts                          StripSpec → rendered Surface → PNG
    stripCache.ts                     StripStore, MemoryStore, cachedStrip
    densities.ts                      1x / 2x / 3x in one call
  test/
    crc.test.ts  encode.test.ts  decode.test.ts  jpeg.test.ts
    surface.test.ts  shapes.test.ts  resize.test.ts  mask.test.ts
    layout.test.ts  strip.test.ts  stripCache.test.ts  densities.test.ts
  bench/strip.bench.mjs               deliberate, never in CI

packages/db/
  package.json
  prisma/schema.prisma
  src/index.ts                        PrismaClient singleton

packages/i18n/
  package.json
  src/en.ts  src/ar.ts  src/index.ts
  test/parity.test.ts

scripts/check-i18n.mjs                CI-facing key-set comparison
```

**Why these boundaries.** `png/` knows about the file format and nothing about stamps. `raster/` knows about pixels and nothing about the file format. `strip.ts` knows about the product and composes the other two. That ordering means the cache can be reasoned about — and tested — without touching a single pixel routine.

---

### Task 1: Monorepo foundation and CI

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `packages/image/package.json`
- Create: `packages/image/tsconfig.json`
- Create: `packages/image/src/index.ts`
- Create: `packages/image/test/smoke.test.ts`
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm run typecheck`, `npm test`, `npm run test:i18n`, `npm run bench`. Workspace `@loyanexa/image` resolvable, with `exports` pointing at `./src/index.ts` (no build step — Node strips types).

- [ ] **Step 1: Write the failing test**

`packages/image/test/smoke.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PACKAGE_NAME } from '../src/index.ts';

test('package exposes its name', () => {
  assert.equal(PACKAGE_NAME, '@loyanexa/image');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test packages/image/test/smoke.test.ts`
Expected: FAIL — cannot find module `../src/index.ts`.

- [ ] **Step 3: Create the workspace root**

`package.json`:

```json
{
  "name": "loyanexa",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "engines": { "node": ">=25" },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.base.json",
    "test": "node --test 'packages/*/test/*.test.ts'",
    "test:i18n": "node scripts/check-i18n.mjs",
    "bench": "node packages/image/bench/strip.bench.mjs"
  },
  "devDependencies": { "typescript": "^5.7.0" }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["packages/*/src/**/*.ts", "packages/*/test/**/*.ts", "scripts/**/*.mjs"]
}
```

`packages/image/package.json`:

```json
{
  "name": "@loyanexa/image",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

`packages/image/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }
```

`packages/image/src/index.ts`:

```ts
export const PACKAGE_NAME = '@loyanexa/image';
```

- [ ] **Step 4: Install and run**

Run: `npm install && npm test`
Expected: PASS, 1 test.

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 5: Add CI**

`.github/workflows/ci.yml`:

```yaml
name: CI
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '25' }
      - run: npm ci
      - name: Secrets must never be tracked
        run: |
          if git ls-files | grep -E '(^certs/|\.env$|\.pem$|\.p8$|\.cer$|service-account.*\.json$)'; then
            echo "::error::secret material is tracked in git"; exit 1
          fi
      - run: npm run typecheck
      - run: npm test
      - run: npm run test:i18n
```

The secret guard runs **before** the other checks so a leak fails fast and loudly.

> `npm run test:i18n` and `npm run bench` reference files created in Tasks 15 and 14. CI will fail on those two steps until then; that is expected and is fixed by the end of the plan. Do not stub them.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.base.json packages/image .github
git commit -m "chore: npm workspaces monorepo, strict tsconfig, CI"
```

---

### Task 2: CRC32

**Files:**
- Create: `packages/image/src/png/crc.ts`
- Test: `packages/image/test/crc.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `crc32(buf: Uint8Array): number` — unsigned 32-bit, PNG polynomial.

- [ ] **Step 1: Write the failing test**

`packages/image/test/crc.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from '../src/png/crc.ts';

test('matches the standard CRC-32 check vector', () => {
  // The canonical check value for "123456789" under the PNG/zlib polynomial.
  assert.equal(crc32(Buffer.from('123456789', 'latin1')), 0xcbf43926);
});

test('empty input is zero', () => {
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('IEND chunk body has the well-known CRC', () => {
  // Every PNG ends with this exact chunk, so its CRC is a fixed constant.
  assert.equal(crc32(Buffer.from('IEND', 'latin1')), 0xae426082);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test packages/image/test/crc.test.ts`
Expected: FAIL — cannot find module `../src/png/crc.ts`.

- [ ] **Step 3: Implement**

`packages/image/src/png/crc.ts`:

```ts
const TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test packages/image/test/crc.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/image/src/png/crc.ts packages/image/test/crc.test.ts
git commit -m "feat(image): CRC32 for PNG chunks"
```

---

### Task 3: PNG encoder

**Files:**
- Create: `packages/image/src/png/encode.ts`
- Test: `packages/image/test/encode.test.ts`

**Interfaces:**
- Consumes: `crc32` from Task 2.
- Produces: `encodePNG(rgba: Uint8Array, width: number, height: number): Buffer` — 8-bit RGBA, colour type 6, non-interlaced, filter type 0 on every scanline.

- [ ] **Step 1: Write the failing test**

`packages/image/test/encode.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test packages/image/test/encode.test.ts`
Expected: FAIL — cannot find module `../src/png/encode.ts`.

- [ ] **Step 3: Implement**

`packages/image/src/png/encode.ts`:

```ts
import { deflateSync } from 'node:zlib';
import { crc32 } from './crc.ts';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Encode 8-bit RGBA pixels as a non-interlaced PNG. */
export function encodePNG(rgba: Uint8Array, width: number, height: number): Buffer {
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new RangeError(`expected ${expected} bytes for ${width}x${height}, got ${rgba.length}`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive
  ihdr[12] = 0; // interlace: none

  // Filter type 0 (None) on every scanline. Deliberate: it keeps output
  // byte-stable and costs little, because stamp strips are large flat areas
  // that deflate compresses well regardless of filtering.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.subarray(y * stride, (y + 1) * stride)).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test packages/image/test/encode.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/image/src/png/encode.ts packages/image/test/encode.test.ts
git commit -m "feat(image): pure-JS PNG encoder over node:zlib"
```

---

### Task 4: PNG decoder

**Files:**
- Create: `packages/image/src/png/decode.ts`
- Test: `packages/image/test/decode.test.ts`

**Interfaces:**
- Consumes: `encodePNG` from Task 3 (tests only).
- Produces: `decodePNG(buf: Uint8Array): DecodedImage` where `DecodedImage = { width: number; height: number; rgba: Uint8Array }`. Handles 8-bit colour types 0, 2, 3 and 6, honours `tRNS`, throws on interlaced or non-8-bit input.

- [ ] **Step 1: Write the failing test**

`packages/image/test/decode.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePNG } from '../src/png/encode.ts';
import { decodePNG } from '../src/png/decode.ts';

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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test packages/image/test/decode.test.ts`
Expected: FAIL — cannot find module `../src/png/decode.ts`.

- [ ] **Step 3: Implement**

`packages/image/src/png/decode.ts`:

```ts
import { inflateSync } from 'node:zlib';

export interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode an 8-bit, non-interlaced PNG to RGBA. */
export function decodePNG(buf: Uint8Array): DecodedImage {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < 8) throw new Error('truncated: shorter than the PNG signature');
  for (let i = 0; i < 8; i++) {
    if (b[i] !== SIGNATURE[i]) throw new Error('bad PNG signature');
  }

  let width = 0;
  let height = 0;
  let colourType = 6;
  let palette: Uint8Array | undefined;
  let transparency: Uint8Array | undefined;
  const idat: Buffer[] = [];
  let sawIEND = false;

  let o = 8;
  while (o + 8 <= b.length) {
    const len = b.readUInt32BE(o);
    const type = b.subarray(o + 4, o + 8).toString('latin1');
    const end = o + 8 + len;
    if (end + 4 > b.length) throw new Error(`truncated: chunk ${type} runs past end of file`);
    const data = b.subarray(o + 8, end);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8]!;
      colourType = data[9]!;
      if (depth !== 8) throw new Error(`unsupported bit depth ${depth}; only 8 is supported`);
      if (data[12] !== 0) throw new Error('interlaced PNGs are not supported');
    } else if (type === 'PLTE') {
      palette = Uint8Array.from(data);
    } else if (type === 'tRNS') {
      transparency = Uint8Array.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      sawIEND = true;
      break;
    }
    o = end + 4;
  }

  if (!sawIEND) throw new Error('truncated: no IEND chunk');
  if (idat.length === 0) throw new Error('truncated: no IDAT data');

  const channels = colourType === 0 ? 1 : colourType === 2 ? 3 : colourType === 3 ? 1 : colourType === 4 ? 2 : 4;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));

  // Undo per-scanline filtering in place.
  const lines = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const rv = row[x]!;
      const a = x >= channels ? cur[x - channels]! : 0;
      const up = prev[x]!;
      const ul = x >= channels ? prev[x - channels]! : 0;
      let v: number;
      switch (filter) {
        case 0: v = rv; break;
        case 1: v = rv + a; break;
        case 2: v = rv + up; break;
        case 3: v = rv + ((a + up) >> 1); break;
        case 4: v = rv + paeth(a, up, ul); break;
        default: throw new Error(`unknown filter type ${filter} on row ${y}`);
      }
      cur[x] = v & 0xff;
    }
    lines.set(cur, y * stride);
    prev = cur;
  }

  // Expand whatever colour type we got into straight RGBA.
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    const s = i * channels;
    if (colourType === 6) {
      rgba[p] = lines[s]!; rgba[p + 1] = lines[s + 1]!; rgba[p + 2] = lines[s + 2]!; rgba[p + 3] = lines[s + 3]!;
    } else if (colourType === 2) {
      rgba[p] = lines[s]!; rgba[p + 1] = lines[s + 1]!; rgba[p + 2] = lines[s + 2]!; rgba[p + 3] = 255;
    } else if (colourType === 0) {
      const g = lines[s]!;
      rgba[p] = g; rgba[p + 1] = g; rgba[p + 2] = g; rgba[p + 3] = 255;
    } else if (colourType === 4) {
      const g = lines[s]!;
      rgba[p] = g; rgba[p + 1] = g; rgba[p + 2] = g; rgba[p + 3] = lines[s + 1]!;
    } else if (colourType === 3) {
      if (!palette) throw new Error('palette image with no PLTE chunk');
      const idx = lines[s]!;
      rgba[p] = palette[idx * 3] ?? 0;
      rgba[p + 1] = palette[idx * 3 + 1] ?? 0;
      rgba[p + 2] = palette[idx * 3 + 2] ?? 0;
      rgba[p + 3] = transparency ? (transparency[idx] ?? 255) : 255;
    } else {
      throw new Error(`unsupported colour type ${colourType}`);
    }
  }

  return { width, height, rgba };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test packages/image/test/decode.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/image/src/png/decode.ts packages/image/test/decode.test.ts
git commit -m "feat(image): PNG decoder for merchant logo uploads"
```

---

### Task 5: JPEG decoding

**Files:**
- Create: `packages/image/src/jpeg.ts`
- Modify: `packages/image/package.json` (add the `jpeg-js` dependency)
- Test: `packages/image/test/jpeg.test.ts`

**Interfaces:**
- Consumes: `DecodedImage` from Task 4.
- Produces: `decodeJPEG(buf: Uint8Array): DecodedImage`, and `decodeImage(buf: Uint8Array): DecodedImage` which sniffs the magic bytes and dispatches to PNG or JPEG.

> Nothing in this slice renders a JPEG — merchant uploads land in sub-project 3. It is built here because it belongs to this package and is three lines, and because `decodeImage` is the entry point the upload path will import.

- [ ] **Step 1: Write the failing test**

`packages/image/test/jpeg.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import { encodePNG } from '../src/png/encode.ts';
import { decodeJPEG, decodeImage } from '../src/jpeg.ts';

function sampleJPEG(w: number, h: number): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 200; data[i + 1] = 100; data[i + 2] = 50; data[i + 3] = 255;
  }
  return jpeg.encode({ data: Buffer.from(data), width: w, height: h }, 100).data;
}

test('decodes a JPEG to RGBA of the right shape', () => {
  const out = decodeJPEG(sampleJPEG(8, 4));
  assert.equal(out.width, 8);
  assert.equal(out.height, 4);
  assert.equal(out.rgba.length, 8 * 4 * 4);
  assert.equal(out.rgba[3], 255, 'opaque');
});

test('decodeImage sniffs JPEG', () => {
  assert.equal(decodeImage(sampleJPEG(4, 4)).width, 4);
});

test('decodeImage sniffs PNG', () => {
  assert.equal(decodeImage(encodePNG(new Uint8Array(2 * 2 * 4), 2, 2)).width, 2);
});

test('decodeImage rejects an unknown format', () => {
  assert.throws(() => decodeImage(Buffer.from('GIF89a....')), /unsupported image format/i);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm install jpeg-js --workspace @loyanexa/image && node --test packages/image/test/jpeg.test.ts`
Expected: FAIL — cannot find module `../src/jpeg.ts`.

- [ ] **Step 3: Implement**

`packages/image/src/jpeg.ts`:

```ts
import jpeg from 'jpeg-js';
import { decodePNG, type DecodedImage } from './png/decode.ts';

export function decodeJPEG(buf: Uint8Array): DecodedImage {
  const out = jpeg.decode(Buffer.from(buf), { useTArray: true, formatAsRGBA: true });
  return { width: out.width, height: out.height, rgba: new Uint8Array(out.data) };
}

/** Decode a merchant upload, sniffing PNG vs JPEG from its magic bytes. */
export function decodeImage(buf: Uint8Array): DecodedImage {
  if (buf[0] === 0x89 && buf[1] === 0x50) return decodePNG(buf);
  if (buf[0] === 0xff && buf[1] === 0xd8) return decodeJPEG(buf);
  throw new Error('unsupported image format: expected PNG or JPEG');
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test packages/image/test/jpeg.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/image/src/jpeg.ts packages/image/package.json package-lock.json packages/image/test/jpeg.test.ts
git commit -m "feat(image): JPEG decoding and format sniffing"
```

---

### Task 6: Surface

**Files:**
- Create: `packages/image/src/raster/surface.ts`
- Test: `packages/image/test/surface.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type RGBA = { r: number; g: number; b: number; a: number }` (`a` is 0–1)
  - `parseHexColor(hex: string, alpha?: number): RGBA` — accepts `#rgb`, `#rrggbb`, with or without `#`
  - `class Surface` with `width`, `height`, `data: Uint8ClampedArray`, `fill(c: RGBA): void`, `blend(x: number, y: number, c: RGBA, coverage: number): void`, `toRGBA(): Uint8Array`

- [ ] **Step 1: Write the failing test**

`packages/image/test/surface.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Surface, parseHexColor } from '../src/raster/surface.ts';

test('parses 6-digit hex with and without the hash', () => {
  assert.deepEqual(parseHexColor('#203757'), { r: 32, g: 55, b: 87, a: 1 });
  assert.deepEqual(parseHexColor('203757'), { r: 32, g: 55, b: 87, a: 1 });
});

test('parses 3-digit shorthand', () => {
  assert.deepEqual(parseHexColor('#f60'), { r: 255, g: 102, b: 0, a: 1 });
});

test('applies an explicit alpha', () => {
  assert.equal(parseHexColor('#000000', 0.5).a, 0.5);
});

test('rejects nonsense', () => {
  assert.throws(() => parseHexColor('#12345'), /invalid colour/i);
  assert.throws(() => parseHexColor('zzzzzz'), /invalid colour/i);
});

test('fill sets every pixel', () => {
  const s = new Surface(2, 2);
  s.fill(parseHexColor('#F96400'));
  const px = s.toRGBA();
  assert.deepEqual([...px.subarray(0, 4)], [249, 100, 0, 255]);
  assert.deepEqual([...px.subarray(12, 16)], [249, 100, 0, 255]);
});

test('blend at full coverage replaces the pixel', () => {
  const s = new Surface(1, 1);
  s.fill(parseHexColor('#000000'));
  s.blend(0, 0, parseHexColor('#ffffff'), 1);
  assert.deepEqual([...s.toRGBA()], [255, 255, 255, 255]);
});

test('blend at half coverage is source-over', () => {
  const s = new Surface(1, 1);
  s.fill(parseHexColor('#000000'));
  s.blend(0, 0, parseHexColor('#ffffff'), 0.5);
  const px = s.toRGBA();
  assert.ok(Math.abs(px[0]! - 128) <= 1, `expected ~128, got ${px[0]}`);
});

test('blend ignores out-of-bounds and zero coverage', () => {
  const s = new Surface(1, 1);
  s.fill(parseHexColor('#000000'));
  s.blend(-1, 0, parseHexColor('#ffffff'), 1);
  s.blend(0, 5, parseHexColor('#ffffff'), 1);
  s.blend(0, 0, parseHexColor('#ffffff'), 0);
  assert.deepEqual([...s.toRGBA()], [0, 0, 0, 255]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test packages/image/test/surface.test.ts`
Expected: FAIL — cannot find module `../src/raster/surface.ts`.

- [ ] **Step 3: Implement**

`packages/image/src/raster/surface.ts`:

```ts
export interface RGBA {
  r: number;
  g: number;
  b: number;
  /** 0–1 */
  a: number;
}

export function parseHexColor(hex: string, alpha = 1): RGBA {
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  const full =
    h.length === 3 ? h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]! : h;
  if (full.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`invalid colour: ${hex}`);
  }
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
    a: alpha,
  };
}

/** A straight-alpha RGBA raster that composites source-over. */
export class Surface {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;

  constructor(width: number, height: number) {
    if (width <= 0 || height <= 0) throw new RangeError('surface must be at least 1x1');
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }

  fill(c: RGBA): void {
    const a = Math.round(c.a * 255);
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = c.r;
      this.data[i + 1] = c.g;
      this.data[i + 2] = c.b;
      this.data[i + 3] = a;
    }
  }

  /** Composite `c` over the pixel at (x, y) with `coverage` in 0–1. */
  blend(x: number, y: number, c: RGBA, coverage: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const sa = c.a * coverage;
    if (sa <= 0) return;
    const i = (y * this.width + x) * 4;
    const da = this.data[i + 3]! / 255;
    const outA = sa + da * (1 - sa);
    if (outA <= 0) return;
    this.data[i] = (c.r * sa + this.data[i]! * da * (1 - sa)) / outA;
    this.data[i + 1] = (c.g * sa + this.data[i + 1]! * da * (1 - sa)) / outA;
    this.data[i + 2] = (c.b * sa + this.data[i + 2]! * da * (1 - sa)) / outA;
    this.data[i + 3] = outA * 255;
  }

  toRGBA(): Uint8Array {
    return new Uint8Array(this.data.buffer, this.data.byteOffset, this.data.byteLength);
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test packages/image/test/surface.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/image/src/raster/surface.ts packages/image/test/surface.test.ts
git commit -m "feat(image): RGBA surface with source-over blending"
```

---

### Task 7: Anti-aliased shapes

**Files:**
- Create: `packages/image/src/raster/shapes.ts`
- Test: `packages/image/test/shapes.test.ts`

**Interfaces:**
- Consumes: `Surface`, `RGBA` from Task 6.
- Produces:
  - `fillDisc(s: Surface, cx: number, cy: number, r: number, c: RGBA): void`
  - `strokeRing(s: Surface, cx: number, cy: number, r: number, thickness: number, c: RGBA): void`
  - `fillRoundedRect(s: Surface, x: number, y: number, w: number, h: number, radius: number, c: RGBA): void`

All take centre and radius in pixels and anti-alias by analytic edge coverage: `coverage = clamp(r + 0.5 − distance, 0, 1)`.

- [ ] **Step 1: Write the failing test**

`packages/image/test/shapes.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Surface, parseHexColor } from '../src/raster/surface.ts';
import { fillDisc, strokeRing, fillRoundedRect } from '../src/raster/shapes.ts';

const WHITE = parseHexColor('#ffffff');
const BLACK = parseHexColor('#000000');

function alphaAt(s: Surface, x: number, y: number): number {
  return s.toRGBA()[(y * s.width + x) * 4 + 3]!;
}
function redAt(s: Surface, x: number, y: number): number {
  return s.toRGBA()[(y * s.width + x) * 4]!;
}

test('a disc paints its centre and leaves the corners alone', () => {
  const s = new Surface(21, 21);
  s.fill(BLACK);
  fillDisc(s, 10, 10, 8, WHITE);
  assert.equal(redAt(s, 10, 10), 255, 'centre is filled');
  assert.equal(redAt(s, 0, 0), 0, 'corner is untouched');
});

test('a disc edge is anti-aliased, not binary', () => {
  const s = new Surface(21, 21);
  s.fill(BLACK);
  fillDisc(s, 10, 10, 8, WHITE);
  // Walk out along the x axis; at least one pixel must be partially covered.
  const values = [];
  for (let x = 10; x < 21; x++) values.push(redAt(s, x, 10));
  assert.ok(values.some((v) => v > 0 && v < 255), `expected a partial pixel, got ${values}`);
});

test('a ring is hollow in the middle', () => {
  const s = new Surface(21, 21);
  s.fill(BLACK);
  strokeRing(s, 10, 10, 8, 2, WHITE);
  assert.equal(redAt(s, 10, 10), 0, 'centre stays empty');
  assert.ok(redAt(s, 18, 10) > 0, 'the stroke itself is painted');
});

test('a ring thicker than its radius does not invert', () => {
  const s = new Surface(21, 21);
  s.fill(BLACK);
  strokeRing(s, 10, 10, 4, 10, WHITE);
  assert.ok(redAt(s, 10, 10) > 0, 'degenerates to a filled disc rather than nothing');
});

test('a rounded rect fills its middle and softens its corners', () => {
  const s = new Surface(20, 20);
  fillRoundedRect(s, 2, 2, 16, 16, 6, WHITE);
  assert.equal(alphaAt(s, 10, 10), 255, 'centre');
  assert.equal(alphaAt(s, 2, 2), 0, 'outer corner is cut away');
});

test('radius 0 gives square corners', () => {
  const s = new Surface(20, 20);
  fillRoundedRect(s, 2, 2, 16, 16, 0, WHITE);
  assert.equal(alphaAt(s, 2, 2), 255);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test packages/image/test/shapes.test.ts`
Expected: FAIL — cannot find module `../src/raster/shapes.ts`.

- [ ] **Step 3: Implement**

`packages/image/src/raster/shapes.ts`:

```ts
import type { RGBA, Surface } from './surface.ts';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Coverage of a pixel centre at distance `d` from an edge at radius `r`.
 * A half-pixel ramp is a good approximation of exact area coverage and is
 * what keeps stamp circles from looking jagged at @1x.
 */
const edge = (r: number, d: number): number => clamp01(r + 0.5 - d);

function bounds(s: Surface, cx: number, cy: number, r: number) {
  return {
    x0: Math.max(0, Math.floor(cx - r - 1)),
    x1: Math.min(s.width - 1, Math.ceil(cx + r + 1)),
    y0: Math.max(0, Math.floor(cy - r - 1)),
    y1: Math.min(s.height - 1, Math.ceil(cy + r + 1)),
  };
}

export function fillDisc(s: Surface, cx: number, cy: number, r: number, c: RGBA): void {
  if (r <= 0) return;
  const { x0, x1, y0, y1 } = bounds(s, cx, cy, r);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const cov = edge(r, d);
      if (cov > 0) s.blend(x, y, c, cov);
    }
  }
}

/** An annulus centred on `r`, `thickness` px wide. */
export function strokeRing(
  s: Surface,
  cx: number,
  cy: number,
  r: number,
  thickness: number,
  c: RGBA
): void {
  if (r <= 0 || thickness <= 0) return;
  const outer = r + thickness / 2;
  const inner = Math.max(0, r - thickness / 2);
  const { x0, x1, y0, y1 } = bounds(s, cx, cy, outer);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      // Inside the outer edge AND outside the inner edge.
      const cov = edge(outer, d) * (inner === 0 ? 1 : clamp01(d - inner + 0.5));
      if (cov > 0) s.blend(x, y, c, cov);
    }
  }
}

export function fillRoundedRect(
  s: Surface,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  c: RGBA
): void {
  if (w <= 0 || h <= 0) return;
  const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
  const x0 = Math.max(0, Math.floor(x - 1));
  const x1 = Math.min(s.width - 1, Math.ceil(x + w + 1));
  const y0 = Math.max(0, Math.floor(y - 1));
  const y1 = Math.min(s.height - 1, Math.ceil(y + h + 1));

  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const cxp = px + 0.5;
      const cyp = py + 0.5;
      // Distance outside the inner rectangle inset by r, per axis.
      const dx = Math.max(x + r - cxp, 0, cxp - (x + w - r));
      const dy = Math.max(y + r - cyp, 0, cyp - (y + h - r));
      const cov = r === 0
        ? clamp01(Math.min(cxp - x, x + w - cxp) + 0.5) * clamp01(Math.min(cyp - y, y + h - cyp) + 0.5)
        : edge(r, Math.hypot(dx, dy));
      if (cov > 0) s.blend(px, py, c, cov);
    }
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test packages/image/test/shapes.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/image/src/raster/shapes.ts packages/image/test/shapes.test.ts
git commit -m "feat(image): anti-aliased disc, ring and rounded rect"
```

---

### Task 8: Resize and circular mask

**Files:**
- Create: `packages/image/src/raster/resize.ts`
- Create: `packages/image/src/raster/mask.ts`
- Test: `packages/image/test/resize.test.ts`
- Test: `packages/image/test/mask.test.ts`

**Interfaces:**
- Consumes: `DecodedImage` from Task 4.
- Produces:
  - `resizeRGBA(src: DecodedImage, width: number, height: number): DecodedImage` — box filter
  - `circularMask(src: DecodedImage, size: number, rimWidth?: number): DecodedImage` — square output, alpha ramped at the circle edge, with an inset rim so a pale logo still reads as a stamp (`BUILD.md` §9.2)

- [ ] **Step 1: Write the failing tests**

`packages/image/test/resize.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resizeRGBA } from '../src/raster/resize.ts';

function solid(w: number, h: number, r: number): { width: number; height: number; rgba: Uint8Array } {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = r; rgba[i + 1] = 0; rgba[i + 2] = 0; rgba[i + 3] = 255;
  }
  return { width: w, height: h, rgba };
}

test('downscales to the requested size', () => {
  const out = resizeRGBA(solid(64, 64, 200), 16, 16);
  assert.equal(out.width, 16);
  assert.equal(out.height, 16);
  assert.equal(out.rgba.length, 16 * 16 * 4);
});

test('a solid colour survives downscaling unchanged', () => {
  const out = resizeRGBA(solid(64, 64, 200), 8, 8);
  assert.equal(out.rgba[0], 200);
  assert.equal(out.rgba[3], 255);
});

test('averages a two-tone image rather than point-sampling', () => {
  const src = solid(2, 1, 0);
  src.rgba[0] = 0;
  src.rgba[4] = 255;
  const out = resizeRGBA(src, 1, 1);
  assert.ok(Math.abs(out.rgba[0]! - 128) <= 2, `expected ~128, got ${out.rgba[0]}`);
});

test('upscaling is allowed and preserves colour', () => {
  const out = resizeRGBA(solid(2, 2, 90), 4, 4);
  assert.equal(out.width, 4);
  assert.equal(out.rgba[0], 90);
});

test('rejects a non-positive target', () => {
  assert.throws(() => resizeRGBA(solid(4, 4, 1), 0, 4), /positive/i);
});
```

`packages/image/test/mask.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { circularMask } from '../src/raster/mask.ts';

function opaqueSquare(n: number) {
  const rgba = new Uint8Array(n * n * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 250; rgba[i + 1] = 250; rgba[i + 2] = 250; rgba[i + 3] = 255;
  }
  return { width: n, height: n, rgba };
}

const alphaAt = (img: { width: number; rgba: Uint8Array }, x: number, y: number) =>
  img.rgba[(y * img.width + x) * 4 + 3]!;

test('produces a square of the requested size', () => {
  const out = circularMask(opaqueSquare(64), 32);
  assert.equal(out.width, 32);
  assert.equal(out.height, 32);
});

test('keeps the centre and clears the corners', () => {
  const out = circularMask(opaqueSquare(64), 32);
  assert.equal(alphaAt(out, 16, 16), 255, 'centre kept');
  assert.equal(alphaAt(out, 0, 0), 0, 'corner cleared');
});

test('draws a rim so a pale logo still reads as a stamp', () => {
  const out = circularMask(opaqueSquare(64), 40, 3);
  // Just inside the circle edge the rim darkens the pixel.
  const px = (x: number, y: number) => out.rgba[(y * out.width + x) * 4]!;
  assert.ok(px(20, 1) < 250, `expected the rim to darken the edge, got ${px(20, 1)}`);
  assert.equal(px(20, 20), 250, 'centre is untouched by the rim');
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test packages/image/test/resize.test.ts packages/image/test/mask.test.ts`
Expected: FAIL — cannot find those modules.

- [ ] **Step 3: Implement**

`packages/image/src/raster/resize.ts`:

```ts
import type { DecodedImage } from '../png/decode.ts';

/**
 * Box-filter resample. Averaging every source pixel that falls inside a
 * destination pixel is what stops a downscaled logo from shimmering; nearest
 * neighbour would alias badly at stamp sizes.
 */
export function resizeRGBA(src: DecodedImage, width: number, height: number): DecodedImage {
  if (width <= 0 || height <= 0) throw new RangeError('target size must be positive');
  const out = new Uint8Array(width * height * 4);
  const sx = src.width / width;
  const sy = src.height / height;

  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(src.height, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(src.width, Math.ceil((x + 1) * sx)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * src.width + xx) * 4;
          r += src.rgba[i]!; g += src.rgba[i + 1]!; b += src.rgba[i + 2]!; a += src.rgba[i + 3]!;
          n++;
        }
      }
      const o = (y * width + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width, height, rgba: out };
}
```

`packages/image/src/raster/mask.ts`:

```ts
import type { DecodedImage } from '../png/decode.ts';
import { resizeRGBA } from './resize.ts';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Crop `src` to a circle of `size` px. `rimWidth` darkens the outermost ring
 * so a logo that is nearly white still reads as a stamp against a white card
 * (BUILD.md §9.2).
 */
export function circularMask(src: DecodedImage, size: number, rimWidth = 0): DecodedImage {
  if (size <= 0) throw new RangeError('size must be positive');
  const scaled = resizeRGBA(src, size, size);
  const out = new Uint8Array(size * size * 4);
  const c = size / 2;
  const r = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      const cov = clamp01(r + 0.5 - d);
      out[i] = scaled.rgba[i]!;
      out[i + 1] = scaled.rgba[i + 1]!;
      out[i + 2] = scaled.rgba[i + 2]!;
      out[i + 3] = Math.round(scaled.rgba[i + 3]! * cov);

      if (rimWidth > 0 && cov > 0) {
        // Strength ramps from 0 at (r - rimWidth) to 1 at the edge.
        const t = clamp01((d - (r - rimWidth)) / rimWidth);
        if (t > 0) {
          const k = 1 - 0.45 * t;
          out[i] = Math.round(out[i]! * k);
          out[i + 1] = Math.round(out[i + 1]! * k);
          out[i + 2] = Math.round(out[i + 2]! * k);
        }
      }
    }
  }
  return { width: size, height: size, rgba: out };
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test packages/image/test/resize.test.ts packages/image/test/mask.test.ts`
Expected: PASS, 8 tests total.

- [ ] **Step 5: Commit**

```bash
git add packages/image/src/raster/resize.ts packages/image/src/raster/mask.ts packages/image/test/resize.test.ts packages/image/test/mask.test.ts
git commit -m "feat(image): box resize and circular logo mask with rim"
```

---

### Task 9: Slot layout

**Files:**
- Create: `packages/image/src/layout.ts`
- Test: `packages/image/test/layout.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `MIN_GOAL = 3`, `MAX_GOAL = 20`
  - `slotRows(goal: number): number[]` — slots per row
  - `slotPositions(goal: number, width: number, height: number): { x: number; y: number; r: number }[]` — centres and radius in px, in fill order

This is the single definition referred to by the Global Constraints. The dashboard preview imports it rather than reimplementing it.

- [ ] **Step 1: Write the failing test**

`packages/image/test/layout.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slotRows, slotPositions, MIN_GOAL, MAX_GOAL } from '../src/layout.ts';

test('the two cases BUILD.md §8.5 names', () => {
  assert.deepEqual(slotRows(8), [4, 4]);
  assert.deepEqual(slotRows(11), [6, 5]);
});

test('six or fewer stamps sit on one row', () => {
  for (let g = 3; g <= 6; g++) assert.deepEqual(slotRows(g), [g], `goal ${g}`);
});

test('more than six splits into two rows, larger row first', () => {
  for (let g = 7; g <= MAX_GOAL; g++) {
    const rows = slotRows(g);
    assert.equal(rows.length, 2, `goal ${g}`);
    assert.ok(rows[0]! >= rows[1]!, `goal ${g}: first row must not be smaller`);
  }
});

test('rows always account for exactly the goal', () => {
  for (let g = MIN_GOAL; g <= MAX_GOAL; g++) {
    assert.equal(slotRows(g).reduce((a, b) => a + b, 0), g, `goal ${g}`);
  }
});

test('rejects goals outside 3-20', () => {
  assert.throws(() => slotRows(2), /between 3 and 20/);
  assert.throws(() => slotRows(21), /between 3 and 20/);
  assert.throws(() => slotRows(4.5), /integer/);
});

test('produces one position per stamp, all inside the canvas', () => {
  for (let g = MIN_GOAL; g <= MAX_GOAL; g++) {
    const pos = slotPositions(g, 1125, 432);
    assert.equal(pos.length, g, `goal ${g}`);
    for (const p of pos) {
      assert.ok(p.r > 0, `goal ${g}: radius must be positive`);
      assert.ok(p.x - p.r >= 0 && p.x + p.r <= 1125, `goal ${g}: x out of bounds`);
      assert.ok(p.y - p.r >= 0 && p.y + p.r <= 432, `goal ${g}: y out of bounds`);
    }
  }
});

test('slots never overlap', () => {
  for (let g = MIN_GOAL; g <= MAX_GOAL; g++) {
    const pos = slotPositions(g, 1125, 432);
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const a = pos[i]!, b = pos[j]!;
        assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.r + b.r, `goal ${g}: slots ${i} and ${j} overlap`);
      }
    }
  }
});

test('positions scale linearly with the canvas', () => {
  const at1x = slotPositions(8, 375, 144);
  const at3x = slotPositions(8, 1125, 432);
  assert.ok(Math.abs(at3x[0]!.x - at1x[0]!.x * 3) < 0.001);
  assert.ok(Math.abs(at3x[0]!.r - at1x[0]!.r * 3) < 0.001);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test packages/image/test/layout.test.ts`
Expected: FAIL — cannot find module `../src/layout.ts`.

- [ ] **Step 3: Implement**

`packages/image/src/layout.ts`:

```ts
export const MIN_GOAL = 3;
export const MAX_GOAL = 20;

export interface SlotPosition {
  x: number;
  y: number;
  r: number;
}

function assertGoal(goal: number): void {
  if (!Number.isInteger(goal)) throw new RangeError(`stamp goal must be an integer, got ${goal}`);
  if (goal < MIN_GOAL || goal > MAX_GOAL) {
    throw new RangeError(`stamp goal must be between 3 and 20, got ${goal}`);
  }
}

/** Slots per row. 8 → [4,4] and 11 → [6,5], per BUILD.md §8.5. */
export function slotRows(goal: number): number[] {
  assertGoal(goal);
  if (goal <= 6) return [goal];
  return [Math.ceil(goal / 2), Math.floor(goal / 2)];
}

/**
 * Slot centres and radius for a canvas of `width` x `height` px, in fill order
 * (left to right, top row first). Radius is chosen so the widest row fits with
 * a consistent gap, then capped so rows never collide vertically.
 */
export function slotPositions(goal: number, width: number, height: number): SlotPosition[] {
  const rows = slotRows(goal);
  const widest = Math.max(...rows);

  // Horizontal budget: n slots plus (n+1) gaps, where a gap is 0.6 of a diameter.
  const GAP_RATIO = 0.6;
  const rByWidth = width / (2 * widest + GAP_RATIO * (widest + 1));
  // Vertical budget: same rule down the rows.
  const rByHeight = height / (2 * rows.length + GAP_RATIO * (rows.length + 1));
  const r = Math.min(rByWidth, rByHeight);

  const gap = r * GAP_RATIO * 2;
  const rowHeight = 2 * r + gap;
  const totalHeight = rows.length * rowHeight - gap;
  const top = (height - totalHeight) / 2;

  const out: SlotPosition[] = [];
  for (let ri = 0; ri < rows.length; ri++) {
    const n = rows[ri]!;
    const rowWidth = n * 2 * r + (n - 1) * gap;
    const left = (width - rowWidth) / 2;
    const y = top + ri * rowHeight + r;
    for (let i = 0; i < n; i++) {
      out.push({ x: left + i * (2 * r + gap) + r, y, r });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test packages/image/test/layout.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/image/src/layout.ts packages/image/test/layout.test.ts
git commit -m "feat(image): single source of truth for stamp slot layout"
```

---

### Task 10: Strip renderer

**Files:**
- Create: `packages/image/src/strip.ts`
- Test: `packages/image/test/strip.test.ts`

**Interfaces:**
- Consumes: `Surface`/`parseHexColor` (Task 6), `fillDisc`/`strokeRing`/`fillRoundedRect` (Task 7), `circularMask`/`resizeRGBA` (Task 8), `slotPositions` (Task 9), `encodePNG` (Task 3), `DecodedImage` (Task 4).
- Produces:
  - `BASE_WIDTH = 375`, `BASE_HEIGHT = 144`
  - `interface ImageRef { rgba: Uint8Array; width: number; height: number; hash: string }`
  - `interface StripSpec { goal; filled; shape; bgColor; bgOpacity; activeColor; inactiveColor; logo?; cover?; scale }`
  - `renderStrip(spec: StripSpec): Buffer` — a PNG

**`StripSpec` carries no customer, pass or merchant identifier.** That is the cache thesis, enforced by the type.

- [ ] **Step 1: Write the failing test**

`packages/image/test/strip.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderStrip, BASE_WIDTH, BASE_HEIGHT, type StripSpec } from '../src/strip.ts';
import { decodePNG } from '../src/png/decode.ts';

const base: StripSpec = {
  goal: 8,
  filled: 3,
  shape: 'circle',
  bgColor: '#203757',
  bgOpacity: 1,
  activeColor: '#F96400',
  inactiveColor: '#8794A5',
  scale: 1,
};

test('renders at the documented canvas size for each density', () => {
  for (const [scale, w, h] of [[1, 375, 144], [2, 750, 288], [3, 1125, 432]] as const) {
    const img = decodePNG(renderStrip({ ...base, scale }));
    assert.equal(img.width, w, `scale ${scale} width`);
    assert.equal(img.height, h, `scale ${scale} height`);
  }
  assert.equal(BASE_WIDTH, 375);
  assert.equal(BASE_HEIGHT, 144);
});

test('the background colour is honoured', () => {
  const img = decodePNG(renderStrip(base));
  // Top-left corner is background, never a slot.
  assert.deepEqual([...img.rgba.subarray(0, 3)], [32, 55, 87]);
});

test('changing how many are filled changes the pixels', () => {
  const a = renderStrip({ ...base, filled: 0 });
  const b = renderStrip({ ...base, filled: 8 });
  assert.notDeepEqual(a, b);
});

test('the same spec always produces identical bytes', () => {
  assert.deepEqual(renderStrip(base), renderStrip({ ...base }));
});

test('square shape differs from circle', () => {
  assert.notDeepEqual(renderStrip(base), renderStrip({ ...base, shape: 'square' }));
});

test('background opacity is applied', () => {
  const img = decodePNG(renderStrip({ ...base, bgOpacity: 0.5 }));
  assert.ok(img.rgba[3]! < 255, `expected a translucent background, got alpha ${img.rgba[3]}`);
});

test('rejects filled outside 0..goal', () => {
  assert.throws(() => renderStrip({ ...base, filled: -1 }), /filled/);
  assert.throws(() => renderStrip({ ...base, filled: 9 }), /filled/);
});

test('rejects a goal outside 3..20', () => {
  assert.throws(() => renderStrip({ ...base, goal: 2, filled: 0 }), /between 3 and 20/);
});

test('a logo stamp renders differently from a plain disc', () => {
  const logo = {
    rgba: new Uint8Array(32 * 32 * 4).fill(255),
    width: 32,
    height: 32,
    hash: 'test-logo',
  };
  assert.notDeepEqual(renderStrip(base), renderStrip({ ...base, logo }));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test packages/image/test/strip.test.ts`
Expected: FAIL — cannot find module `../src/strip.ts`.

- [ ] **Step 3: Implement**

`packages/image/src/strip.ts`:

```ts
import { encodePNG } from './png/encode.ts';
import type { DecodedImage } from './png/decode.ts';
import { Surface, parseHexColor } from './raster/surface.ts';
import { fillDisc, strokeRing, fillRoundedRect } from './raster/shapes.ts';
import { circularMask } from './raster/mask.ts';
import { resizeRGBA } from './raster/resize.ts';
import { slotPositions } from './layout.ts';

export const BASE_WIDTH = 375;
export const BASE_HEIGHT = 144;

/** A decoded image plus the content hash used in the cache key. */
export interface ImageRef extends DecodedImage {
  hash: string;
}

/**
 * Everything a strip's appearance depends on — and nothing else.
 *
 * There is deliberately no customer, pass, serial or merchant field here.
 * An 8-stamp card has 9 possible strips, not one per holder (BUILD.md §10).
 */
export interface StripSpec {
  goal: number;
  filled: number;
  shape: 'circle' | 'square';
  bgColor: string;
  bgOpacity: number;
  activeColor: string;
  inactiveColor: string;
  logo?: ImageRef;
  cover?: ImageRef;
  scale: 1 | 2 | 3;
}

export function renderStrip(spec: StripSpec): Buffer {
  if (!Number.isInteger(spec.filled) || spec.filled < 0 || spec.filled > spec.goal) {
    throw new RangeError(`filled must be an integer in 0..${spec.goal}, got ${spec.filled}`);
  }
  if (spec.bgOpacity < 0 || spec.bgOpacity > 1) {
    throw new RangeError(`bgOpacity must be 0..1, got ${spec.bgOpacity}`);
  }

  const width = BASE_WIDTH * spec.scale;
  const height = BASE_HEIGHT * spec.scale;
  const surface = new Surface(width, height);

  // 1. Background — the merchant's cover image if there is one, else flat colour.
  surface.fill(parseHexColor(spec.bgColor, spec.bgOpacity));
  if (spec.cover) {
    const cover = resizeRGBA(spec.cover, width, height);
    const alpha = spec.bgOpacity;
    for (let i = 0; i < width * height; i++) {
      const o = i * 4;
      surface.blend(i % width, Math.floor(i / width), {
        r: cover.rgba[o]!, g: cover.rgba[o + 1]!, b: cover.rgba[o + 2]!,
        a: (cover.rgba[o + 3]! / 255) * alpha,
      }, 1);
    }
  }

  // 2. Slots.
  const active = parseHexColor(spec.activeColor);
  const inactive = parseHexColor(spec.inactiveColor);
  const positions = slotPositions(spec.goal, width, height);
  const maskedLogo = spec.logo
    ? circularMask(spec.logo, Math.max(2, Math.round(positions[0]!.r * 2)), Math.max(1, positions[0]!.r * 0.12))
    : undefined;

  for (let i = 0; i < positions.length; i++) {
    const p = positions[i]!;
    const isFilled = i < spec.filled;

    if (spec.shape === 'square') {
      const size = p.r * 2;
      const radius = p.r * 0.28;
      if (isFilled) fillRoundedRect(surface, p.x - p.r, p.y - p.r, size, size, radius, active);
      else {
        // Hollow square: draw the outline as four thin filled rects.
        const t = Math.max(1, p.r * 0.16);
        fillRoundedRect(surface, p.x - p.r, p.y - p.r, size, t, 0, inactive);
        fillRoundedRect(surface, p.x - p.r, p.y + p.r - t, size, t, 0, inactive);
        fillRoundedRect(surface, p.x - p.r, p.y - p.r, t, size, 0, inactive);
        fillRoundedRect(surface, p.x + p.r - t, p.y - p.r, t, size, 0, inactive);
      }
      continue;
    }

    if (!isFilled) {
      strokeRing(surface, p.x, p.y, p.r, Math.max(1, p.r * 0.16), inactive);
    } else if (maskedLogo) {
      const size = maskedLogo.width;
      const ox = Math.round(p.x - size / 2);
      const oy = Math.round(p.y - size / 2);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const o = (y * size + x) * 4;
          const a = maskedLogo.rgba[o + 3]! / 255;
          if (a > 0) {
            surface.blend(ox + x, oy + y, {
              r: maskedLogo.rgba[o]!, g: maskedLogo.rgba[o + 1]!, b: maskedLogo.rgba[o + 2]!, a,
            }, 1);
          }
        }
      }
    } else {
      fillDisc(surface, p.x, p.y, p.r, active);
    }
  }

  return encodePNG(surface.toRGBA(), width, height);
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test packages/image/test/strip.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/image/src/strip.ts packages/image/test/strip.test.ts
git commit -m "feat(image): stamp strip renderer"
```

---

### Task 11: Content-addressed strip cache

**Files:**
- Create: `packages/image/src/stripCache.ts`
- Test: `packages/image/test/stripCache.test.ts`

**Interfaces:**
- Consumes: `StripSpec`, `renderStrip` from Task 10.
- Produces:
  - `stripCacheKey(spec: StripSpec): string` — hex SHA-256
  - `interface StripStore { get(key: string): Promise<Buffer | undefined>; set(key: string, value: Buffer): Promise<void> }`
  - `class MemoryStore implements StripStore` — bounded LRU, `constructor(maxEntries = 256)`, exposes `size`
  - `cachedStrip(store: StripStore, spec: StripSpec): Promise<Buffer>`

- [ ] **Step 1: Write the failing test**

`packages/image/test/stripCache.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripCacheKey, MemoryStore, cachedStrip } from '../src/stripCache.ts';
import { renderStrip, type StripSpec } from '../src/strip.ts';

const base: StripSpec = {
  goal: 8, filled: 3, shape: 'circle',
  bgColor: '#203757', bgOpacity: 1,
  activeColor: '#F96400', inactiveColor: '#8794A5',
  scale: 1,
};

const logoA = { rgba: new Uint8Array(16 * 16 * 4).fill(255), width: 16, height: 16, hash: 'logo-a' };
const logoB = { rgba: new Uint8Array(16 * 16 * 4).fill(255), width: 16, height: 16, hash: 'logo-b' };

test('the key is a stable hex SHA-256', () => {
  const k = stripCacheKey(base);
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.equal(k, stripCacheKey({ ...base }));
});

test('key order in the object literal does not matter', () => {
  const reordered: StripSpec = {
    scale: 1, inactiveColor: '#8794A5', activeColor: '#F96400',
    bgOpacity: 1, bgColor: '#203757', shape: 'circle', filled: 3, goal: 8,
  };
  assert.equal(stripCacheKey(base), stripCacheKey(reordered));
});

test('every visual field changes the key', () => {
  const variants: StripSpec[] = [
    { ...base, goal: 9 }, { ...base, filled: 4 }, { ...base, shape: 'square' },
    { ...base, bgColor: '#000000' }, { ...base, bgOpacity: 0.5 },
    { ...base, activeColor: '#000000' }, { ...base, inactiveColor: '#000000' },
    { ...base, scale: 2 }, { ...base, logo: logoA },
  ];
  const keys = new Set(variants.map(stripCacheKey));
  keys.add(stripCacheKey(base));
  assert.equal(keys.size, variants.length + 1, 'each variant must hash differently');
});

test('different logos never collide', () => {
  assert.notEqual(stripCacheKey({ ...base, logo: logoA }), stripCacheKey({ ...base, logo: logoB }));
});

test('the logo hash, not its bytes, drives the key', () => {
  const sameHashDifferentPixels = { ...logoA, rgba: new Uint8Array(16 * 16 * 4).fill(7) };
  assert.equal(
    stripCacheKey({ ...base, logo: logoA }),
    stripCacheKey({ ...base, logo: sameHashDifferentPixels })
  );
});

test('an 8-stamp card has exactly 9 distinct strips', () => {
  const keys = new Set<string>();
  for (let filled = 0; filled <= 8; filled++) keys.add(stripCacheKey({ ...base, filled }));
  assert.equal(keys.size, 9);
});

test('cached bytes are byte-identical to a fresh render', async () => {
  const store = new MemoryStore();
  const fresh = renderStrip(base);
  const first = await cachedStrip(store, base);
  const second = await cachedStrip(store, base);
  assert.deepEqual(first, fresh);
  assert.deepEqual(second, fresh);
});

test('a repeat request does not re-render', async () => {
  const store = new MemoryStore();
  let renders = 0;
  const counting: typeof store = {
    get: (k) => { return store.get(k); },
    set: (k, v) => { renders++; return store.set(k, v); },
  } as unknown as MemoryStore;
  await cachedStrip(counting, base);
  await cachedStrip(counting, base);
  assert.equal(renders, 1, 'second call must be served from the store');
});

test('the store is bounded and evicts least-recently-used', async () => {
  const store = new MemoryStore(2);
  await store.set('a', Buffer.from('1'));
  await store.set('b', Buffer.from('2'));
  await store.get('a');            // 'a' is now the most recent
  await store.set('c', Buffer.from('3')); // evicts 'b'
  assert.equal(store.size, 2);
  assert.ok(await store.get('a'));
  assert.equal(await store.get('b'), undefined);
  assert.ok(await store.get('c'));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test packages/image/test/stripCache.test.ts`
Expected: FAIL — cannot find module `../src/stripCache.ts`.

- [ ] **Step 3: Implement**

`packages/image/src/stripCache.ts`:

```ts
import { createHash } from 'node:crypto';
import { renderStrip, type StripSpec } from './strip.ts';

/**
 * A strip depends only on its visual inputs — never on which customer holds
 * the pass. Images contribute their content hash, so a render never has to
 * hash a megabyte of pixels (BUILD.md §10).
 */
export function stripCacheKey(spec: StripSpec): string {
  // Written out field by field so the order is fixed regardless of how the
  // caller built the object, and so adding a field to StripSpec without
  // updating this function is a visible omission rather than a silent one.
  const identity = [
    spec.goal,
    spec.filled,
    spec.shape,
    spec.bgColor.toLowerCase(),
    spec.bgOpacity,
    spec.activeColor.toLowerCase(),
    spec.inactiveColor.toLowerCase(),
    spec.logo?.hash ?? null,
    spec.cover?.hash ?? null,
    spec.scale,
  ];
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export interface StripStore {
  get(key: string): Promise<Buffer | undefined>;
  set(key: string, value: Buffer): Promise<void>;
}

/** Bounded LRU. The production implementation is Redis (sub-project 3). */
export class MemoryStore implements StripStore {
  readonly #map = new Map<string, Buffer>();
  readonly #max: number;

  constructor(maxEntries = 256) {
    if (maxEntries < 1) throw new RangeError('maxEntries must be at least 1');
    this.#max = maxEntries;
  }

  get size(): number {
    return this.#map.size;
  }

  async get(key: string): Promise<Buffer | undefined> {
    const hit = this.#map.get(key);
    if (hit === undefined) return undefined;
    this.#map.delete(key); // reinsert so Map iteration order tracks recency
    this.#map.set(key, hit);
    return hit;
  }

  async set(key: string, value: Buffer): Promise<void> {
    if (this.#map.has(key)) this.#map.delete(key);
    this.#map.set(key, value);
    while (this.#map.size > this.#max) {
      const oldest = this.#map.keys().next();
      if (oldest.done) break;
      this.#map.delete(oldest.value);
    }
  }
}

export async function cachedStrip(store: StripStore, spec: StripSpec): Promise<Buffer> {
  const key = stripCacheKey(spec);
  const hit = await store.get(key);
  if (hit) return hit;
  const png = renderStrip(spec);
  await store.set(key, png);
  return png;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test packages/image/test/stripCache.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/image/src/stripCache.ts packages/image/test/stripCache.test.ts
git commit -m "feat(image): content-addressed strip cache with bounded LRU"
```

---

### Task 12: Three densities, and the package's public surface

**Files:**
- Create: `packages/image/src/densities.ts`
- Modify: `packages/image/src/index.ts`
- Create: `packages/image/bench/strip.bench.mjs`
- Test: `packages/image/test/densities.test.ts`
- Delete: `packages/image/test/smoke.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `type StripSet = { 'strip.png': Buffer; 'strip@2x.png': Buffer; 'strip@3x.png': Buffer }`
  - `renderAllDensities(store: StripStore, spec: Omit<StripSpec, 'scale'>): Promise<StripSet>`
  - `index.ts` re-exports the public API.

- [ ] **Step 1: Write the failing test**

`packages/image/test/densities.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderAllDensities } from '../src/densities.ts';
import { MemoryStore } from '../src/stripCache.ts';
import { decodePNG } from '../src/png/decode.ts';
import type { StripSpec } from '../src/strip.ts';

const spec: Omit<StripSpec, 'scale'> = {
  goal: 8, filled: 3, shape: 'circle',
  bgColor: '#203757', bgOpacity: 1,
  activeColor: '#F96400', inactiveColor: '#8794A5',
};

test('produces the three PassKit filenames at the right sizes', async () => {
  const set = await renderAllDensities(new MemoryStore(), spec);
  assert.deepEqual(Object.keys(set).sort(), ['strip.png', 'strip@2x.png', 'strip@3x.png']);
  assert.equal(decodePNG(set['strip.png']).width, 375);
  assert.equal(decodePNG(set['strip@2x.png']).width, 750);
  assert.equal(decodePNG(set['strip@3x.png']).width, 1125);
});

test('a second call is served entirely from cache and is byte-identical', async () => {
  const store = new MemoryStore();
  const a = await renderAllDensities(store, spec);
  const b = await renderAllDensities(store, spec);
  assert.deepEqual(a['strip.png'], b['strip.png']);
  assert.deepEqual(a['strip@3x.png'], b['strip@3x.png']);
  assert.equal(store.size, 3, 'exactly one entry per density');
});

test('the public entry point re-exports the API', async () => {
  const api = await import('../src/index.ts');
  for (const name of ['renderStrip', 'cachedStrip', 'MemoryStore', 'stripCacheKey', 'slotRows', 'renderAllDensities']) {
    assert.equal(typeof (api as Record<string, unknown>)[name], 'function', `missing export: ${name}`);
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test packages/image/test/densities.test.ts`
Expected: FAIL — cannot find module `../src/densities.ts`.

- [ ] **Step 3: Implement**

`packages/image/src/densities.ts`:

```ts
import { cachedStrip, type StripStore } from './stripCache.ts';
import type { StripSpec } from './strip.ts';

export interface StripSet {
  'strip.png': Buffer;
  'strip@2x.png': Buffer;
  'strip@3x.png': Buffer;
}

/** Every density a .pkpass needs, each cached independently. */
export async function renderAllDensities(
  store: StripStore,
  spec: Omit<StripSpec, 'scale'>
): Promise<StripSet> {
  const [x1, x2, x3] = await Promise.all([
    cachedStrip(store, { ...spec, scale: 1 }),
    cachedStrip(store, { ...spec, scale: 2 }),
    cachedStrip(store, { ...spec, scale: 3 }),
  ]);
  return { 'strip.png': x1, 'strip@2x.png': x2, 'strip@3x.png': x3 };
}
```

`packages/image/src/index.ts` (replace the placeholder from Task 1):

```ts
export { crc32 } from './png/crc.ts';
export { encodePNG } from './png/encode.ts';
export { decodePNG, type DecodedImage } from './png/decode.ts';
export { decodeJPEG, decodeImage } from './jpeg.ts';
export { Surface, parseHexColor, type RGBA } from './raster/surface.ts';
export { fillDisc, strokeRing, fillRoundedRect } from './raster/shapes.ts';
export { resizeRGBA } from './raster/resize.ts';
export { circularMask } from './raster/mask.ts';
export { slotRows, slotPositions, MIN_GOAL, MAX_GOAL, type SlotPosition } from './layout.ts';
export { renderStrip, BASE_WIDTH, BASE_HEIGHT, type StripSpec, type ImageRef } from './strip.ts';
export { stripCacheKey, cachedStrip, MemoryStore, type StripStore } from './stripCache.ts';
export { renderAllDensities, type StripSet } from './densities.ts';
```

`packages/image/bench/strip.bench.mjs`:

```js
// Deliberate benchmark. Never run in CI — timing assertions are flaky on
// shared runners and train people to ignore red builds. Compare against the
// figures in BUILD.md §10: 27 ms @2x, 55 ms @3x, 93 ms for a full pass.
import { renderStrip } from '../src/strip.ts';
import { MemoryStore, cachedStrip } from '../src/stripCache.ts';
import { renderAllDensities } from '../src/densities.ts';

const spec = {
  goal: 8, filled: 3, shape: 'circle',
  bgColor: '#203757', bgOpacity: 1,
  activeColor: '#F96400', inactiveColor: '#8794A5',
};

function time(label, fn, runs = 20) {
  fn();
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) fn();
  const ms = (performance.now() - t0) / runs;
  console.log(`${label.padEnd(34)} ${ms.toFixed(1)} ms`);
  return ms;
}

time('strip @2x', () => renderStrip({ ...spec, scale: 2 }));
time('strip @3x', () => renderStrip({ ...spec, scale: 3 }));

const uncached = time('full pass, three densities', () => {
  renderStrip({ ...spec, scale: 1 });
  renderStrip({ ...spec, scale: 2 });
  renderStrip({ ...spec, scale: 3 });
});

const store = new MemoryStore();
await renderAllDensities(store, spec);
const t0 = performance.now();
for (let i = 0; i < 5000; i++) await cachedStrip(store, { ...spec, scale: 3 });
const cachedTotal = performance.now() - t0;

console.log('');
console.log(`5,000 cached fetches               ${cachedTotal.toFixed(0)} ms`);
console.log(`same uncached would be roughly     ${((uncached * 5000) / 1000).toFixed(0)} s`);
```

- [ ] **Step 4: Run it and watch it pass**

Run: `rm packages/image/test/smoke.test.ts && node --test 'packages/image/test/*.test.ts'`
Expected: PASS, all image tests.

Run: `npm run bench`
Expected: timings printed; no assertions.

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/image/src/densities.ts packages/image/src/index.ts packages/image/bench packages/image/test
git rm --cached packages/image/test/smoke.test.ts 2>/dev/null || true
git commit -m "feat(image): three-density rendering, public API, benchmark"
```

---

### Task 13: Prisma schema

**Files:**
- Create: `packages/db/package.json`
- Create: `packages/db/prisma/schema.prisma`
- Create: `packages/db/src/index.ts`
- Test: `packages/db/test/schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `prisma` (a `PrismaClient` singleton) from `@loyanexa/db`.

- [ ] **Step 1: Write the failing test**

`packages/db/test/schema.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');

test('every model BUILD.md §11 names is present', () => {
  for (const m of ['Merchant', 'Card', 'Pass', 'Device', 'StampEvent', 'LinkCounter']) {
    assert.match(schema, new RegExp(`model ${m}\\b`), `missing model ${m}`);
  }
});

test('the indexes BUILD.md §11 says must never be removed are present', () => {
  assert.match(schema, /@@index\(\[merchantId, lastStampAt\]\)/, 'the "gone quiet" query index');
  assert.match(schema, /@@index\(\[updatedAt\]\)/, 'the PassKit device-poll index');
  assert.match(schema, /@@index\(\[linkCode\]\)/, 'the short-link resolution index');
});

test('Card carries the image content hashes the strip cache needs', () => {
  assert.match(schema, /logoStampHash\s+String\?/);
  assert.match(schema, /coverHash\s+String\?/);
});

test('LinkCounter declares one field per line so Prisma can parse it', () => {
  const block = schema.match(/model LinkCounter \{[^}]*\}/)?.[0] ?? '';
  assert.match(block, /\bid\s+Int\b/);
  assert.match(block, /\bvalue\s+Int\b/);
  assert.equal(block.split('\n').filter((l) => /Int/.test(l)).length, 2, 'id and value on separate lines');
});

test('serials and short codes are unique', () => {
  assert.match(schema, /serial\s+String\s+@unique/);
  assert.match(schema, /shortCode\s+String\s+@unique/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test packages/db/test/schema.test.ts`
Expected: FAIL — no such file `../prisma/schema.prisma`.

- [ ] **Step 3: Implement**

`packages/db/package.json`:

```json
{
  "name": "@loyanexa/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "migrate": "prisma migrate dev",
    "generate": "prisma generate"
  },
  "dependencies": { "@prisma/client": "^6.1.0" },
  "devDependencies": { "prisma": "^6.1.0" }
}
```

`packages/db/prisma/schema.prisma` — ported from `BUILD.md` §11 with the four corrections in the spec:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Merchant {
  id           String    @id @default(cuid())
  firebaseUid  String    @unique
  email        String    @unique
  name         String
  locale       String    @default("ar")
  plan         Plan      @default(STARTER)
  stripeCustId String?
  subStatus    String    @default("trialing")
  trialEndsAt  DateTime?
  cards        Card[]
  createdAt    DateTime  @default(now())

  @@index([firebaseUid])
}

model Card {
  id            String    @id @default(cuid())
  merchantId    String
  merchant      Merchant  @relation(fields: [merchantId], references: [id], onDelete: Cascade)
  slot          Int
  linkCode      Int       @unique
  linkAlias     String?   @unique
  shortCode     String    @unique
  name          String
  logoIconUrl   String?
  logoStampHash String?
  coverUrl      String?
  coverHash     String?
  stampsGoal    Int       @default(8)
  starterStamps Int       @default(0)
  stampShape    String    @default("circle")
  customStamps  Boolean   @default(false)
  bgColor       String
  fgColor       String
  stampActive   String
  stampInactive String
  labelStamps   String    @default("")
  labelRewards  String    @default("")
  lang          String    @default("ar")
  expiryType    String    @default("unlimited")
  expiryDays    Int?
  expiryDate    DateTime?
  rewardText    String
  formFields    Json      @default("[\"name\",\"phone\"]")
  locations     Json      @default("[]")
  active        Boolean   @default(false)
  passes        Pass[]
  createdAt     DateTime  @default(now())

  @@unique([merchantId, slot])
  @@index([linkCode])
  @@index([linkAlias])
}

model Pass {
  id           String    @id @default(cuid())
  serial       String    @unique
  shortCode    String    @unique
  cardId       String
  card         Card      @relation(fields: [cardId], references: [id], onDelete: Cascade)
  merchantId   String
  authToken    String
  custName     String    @default("")
  custEmail    String    @default("")
  custPhone    String    @default("")
  custBirthday DateTime?
  stamps       Int       @default(0)
  totalStamps  Int       @default(0)
  rewards      Int       @default(0)
  message      String    @default("")
  platform     String    @default("")
  lastStampAt  DateTime?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
  devices      Device[]

  @@index([cardId])
  @@index([merchantId, lastStampAt])
  @@index([updatedAt])
}

model Device {
  deviceId   String
  passSerial String
  pushToken  String
  pass       Pass   @relation(fields: [passSerial], references: [serial], onDelete: Cascade)

  @@id([deviceId, passSerial])
  @@index([passSerial])
}

model StampEvent {
  id         BigInt    @id @default(autoincrement())
  merchantId String
  cardId     String
  serial     String
  kind       EventKind
  source     String    @default("browser")
  at         DateTime  @default(now())

  @@index([merchantId, at])
  @@index([cardId, kind])
}

model LinkCounter {
  id    Int @id @default(1)
  value Int @default(10000)
}

enum Plan {
  STARTER
  GROWTH
  PRO
}

enum EventKind {
  ENROLL
  STAMP
  REWARD
  REDEEM
}
```

`packages/db/src/index.ts`:

```ts
import { PrismaClient } from '@prisma/client';

// One client per process. Prisma pools connections internally; constructing
// more than one exhausts Postgres connections under load.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.prisma ?? new PrismaClient();

if (process.env['NODE_ENV'] !== 'production') globalForPrisma.prisma = prisma;
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm install --workspace @loyanexa/db && node --test packages/db/test/schema.test.ts`
Expected: PASS, 5 tests.

Now prove the schema is valid and migrates, against your local Postgres:

```bash
createdb loyanexa 2>/dev/null || true
npx --workspace @loyanexa/db prisma validate
npx --workspace @loyanexa/db prisma migrate dev --name init
```

Expected: `The schema at prisma/schema.prisma is valid`, then a migration applied and the client generated.

- [ ] **Step 5: Commit**

```bash
git add packages/db package-lock.json
git commit -m "feat(db): Prisma schema with strip-cache image hashes"
```

---

### Task 14: Bilingual dictionaries and the parity gate

**Files:**
- Create: `packages/i18n/package.json`
- Create: `packages/i18n/src/en.ts`
- Create: `packages/i18n/src/ar.ts`
- Create: `packages/i18n/src/index.ts`
- Create: `packages/i18n/test/parity.test.ts`
- Create: `scripts/check-i18n.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Lang = 'ar' | 'en'`, `type MessageKey = keyof typeof en`
  - `t(lang: Lang, key: MessageKey, vars?: Record<string, string | number>): string`
  - `arabicDigits(value: string | number, lang: Lang): string` — Arabic-Indic numerals under `ar` (`BUILD.md` §13)

The Arabic dictionary is typed as `Record<MessageKey, string>`, so a missing key is a **compile error**; `scripts/check-i18n.mjs` catches the reverse case (an extra Arabic key) at runtime for CI.

- [ ] **Step 1: Write the failing test**

`packages/i18n/test/parity.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { en } from '../src/en.ts';
import { ar } from '../src/ar.ts';
import { t, arabicDigits } from '../src/index.ts';

test('both dictionaries hold exactly the same keys', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ar).sort());
});

test('no message is empty — a blank renders as an invisible element', () => {
  for (const [k, v] of Object.entries({ ...en, ...ar })) {
    assert.ok(v.trim().length > 0, `empty message for ${k}`);
  }
});

test('t returns the message for the requested language', () => {
  assert.equal(t('en', 'stampTooSoon'), en.stampTooSoon);
  assert.equal(t('ar', 'stampTooSoon'), ar.stampTooSoon);
});

test('t interpolates named variables', () => {
  assert.equal(t('en', 'stampsRemaining', { count: '4' }), '4 stamps remaining');
});

test('an unreplaced placeholder is loud, not silent', () => {
  assert.throws(() => t('en', 'stampsRemaining'), /missing variable: count/);
});

test('Arabic-Indic numerals under ar only', () => {
  assert.equal(arabicDigits(2026, 'ar'), '٢٠٢٦');
  assert.equal(arabicDigits(2026, 'en'), '2026');
  assert.equal(arabicDigits('3/8', 'ar'), '٣/٨');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test packages/i18n/test/parity.test.ts`
Expected: FAIL — cannot find module `../src/en.ts`.

- [ ] **Step 3: Implement**

`packages/i18n/package.json`:

```json
{
  "name": "@loyanexa/i18n",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

`packages/i18n/src/en.ts`:

```ts
/** English is the reference dictionary: its keys define the required set. */
export const en = {
  stampTooSoon: 'This card was already stamped today. Try again tomorrow.',
  stampsRemaining: '{count} stamps remaining',
  rewardEarned: 'Reward earned',
  cardNotFound: 'That card could not be found.',
  cardExpired: 'This card has expired.',
  serverError: 'Something went wrong. Please try again.',
} as const;
```

`packages/i18n/src/ar.ts`:

```ts
import type { en } from './en.ts';

/**
 * Typed against the English keys, so omitting one fails `tsc` rather than
 * rendering as a blank element (BUILD.md §13).
 */
export const ar: Record<keyof typeof en, string> = {
  stampTooSoon: 'تم ختم هذه البطاقة اليوم بالفعل. حاول مرة أخرى غدًا.',
  stampsRemaining: 'متبقٍ {count} ختم',
  rewardEarned: 'تم الحصول على المكافأة',
  cardNotFound: 'تعذر العثور على هذه البطاقة.',
  cardExpired: 'انتهت صلاحية هذه البطاقة.',
  serverError: 'حدث خطأ ما. يرجى المحاولة مرة أخرى.',
};
```

`packages/i18n/src/index.ts`:

```ts
import { en } from './en.ts';
import { ar } from './ar.ts';

export type Lang = 'ar' | 'en';
export type MessageKey = keyof typeof en;

export { en, ar };

const DICTIONARIES: Record<Lang, Record<MessageKey, string>> = { en, ar };
const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';

/** Translate, interpolating `{name}` placeholders. */
export function t(
  lang: Lang,
  key: MessageKey,
  vars?: Record<string, string | number>
): string {
  const template = DICTIONARIES[lang][key];
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = vars?.[name];
    if (value === undefined) throw new Error(`missing variable: ${name} for message ${key}`);
    return String(value);
  });
}

/** Arabic-Indic numerals under `ar`, Western digits otherwise (BUILD.md §13). */
export function arabicDigits(value: string | number, lang: Lang): string {
  const s = String(value);
  if (lang !== 'ar') return s;
  return s.replace(/\d/g, (d) => ARABIC_INDIC[Number(d)]!);
}
```

`scripts/check-i18n.mjs`:

```js
// Fails CI when the dictionaries diverge. A missing key renders as a blank
// element — silent and easy to ship (BUILD.md §13, CONTRIBUTING.md).
import { en } from '../packages/i18n/src/en.ts';
import { ar } from '../packages/i18n/src/ar.ts';

const enKeys = new Set(Object.keys(en));
const arKeys = new Set(Object.keys(ar));

const missingInAr = [...enKeys].filter((k) => !arKeys.has(k));
const missingInEn = [...arKeys].filter((k) => !enKeys.has(k));
const empty = Object.entries({ ...en, ...ar }).filter(([, v]) => !String(v).trim());

let failed = false;
if (missingInAr.length) { console.error('missing from ar:', missingInAr.join(', ')); failed = true; }
if (missingInEn.length) { console.error('missing from en:', missingInEn.join(', ')); failed = true; }
if (empty.length) { console.error('empty messages:', empty.map(([k]) => k).join(', ')); failed = true; }

if (failed) process.exit(1);
console.log(`i18n parity OK — ${enKeys.size} keys in both dictionaries`);
```

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test packages/i18n/test/parity.test.ts`
Expected: PASS, 6 tests.

Run: `npm run test:i18n`
Expected: `i18n parity OK — 6 keys in both dictionaries`, exit 0.

Prove the gate actually bites — temporarily delete a key from `ar.ts`:

Run: `npm run test:i18n`
Expected: `missing from ar: …`, exit 1. Restore the key afterwards.

- [ ] **Step 5: Commit**

```bash
git add packages/i18n scripts/check-i18n.mjs
git commit -m "feat(i18n): ar/en dictionaries with a CI parity gate"
```

---

### Task 15: Green build and documentation

**Files:**
- Modify: `README.md` (Status section)
- Modify: `docs/superpowers/plans/2026-08-02-foundation-strip-pipeline.md` (tick every box)

**Interfaces:**
- Consumes: everything.
- Produces: a repository where `npm ci && npm run typecheck && npm test && npm run test:i18n` all pass from clean.

- [ ] **Step 1: Verify from a clean checkout**

```bash
rm -rf node_modules packages/*/node_modules
npm ci
npm run typecheck
npm test
npm run test:i18n
```

Expected: all four exit 0. Record the total test count.

- [ ] **Step 2: Verify no secret material is tracked**

```bash
git ls-files | grep -E '(^certs/|\.env$|\.pem$|\.p8$|\.cer$|service-account.*\.json$)' && echo "LEAK" || echo "clean"
```

Expected: `clean`.

- [ ] **Step 3: Update the README status**

Replace the `## Status` section of `README.md` with:

```markdown
## Status

Specification complete · prototype complete · **sub-project 1 built**.

`@loyanexa/image` renders stamp strips at three densities with a content-addressed
cache; `@loyanexa/db` holds the Prisma schema; `@loyanexa/i18n` holds the dictionaries
with a CI parity gate. Next: sub-project 2, the pass engine.

```bash
npm ci && npm test
```
```

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/plans/2026-08-02-foundation-strip-pipeline.md
git commit -m "docs: record sub-project 1 as built"
```

- [ ] **Step 5: Open the pull request**

```bash
git push -u origin HEAD
gh pr create --fill --title "feat: foundation and stamp-strip pipeline"
```

---

## Self-Review

**Spec coverage.** Every section of the design doc maps to a task: §5 workspace → Task 1; §6 image units → Tasks 2–12 (`png/crc` 2, `png/encode` 3, `png/decode` 4, `jpeg` 5, `surface` 6, `shapes` 7, `resize`+`mask` 8, `layout` 9, `strip` 10, `stripCache` 11, `densities` 12); §6.1 cache thesis → Task 11; §6.2 geometry → Task 9; §7 database → Task 13; §8 i18n → Task 14; §9 testing → the test blocks throughout, with the bench script in Task 12 covering the "no timing assertions in CI" rule; §10 non-goals → nothing here implements them.

**Placeholder scan.** No TBD/TODO. Every code step carries real code. Every test step carries real assertions. No "similar to Task N" references.

**Type consistency.** `DecodedImage` is defined once in Task 4 and consumed by Tasks 5, 8 and 10. `ImageRef extends DecodedImage` adding `hash`, used by `StripSpec` in Task 10 and by `stripCacheKey` in Task 11. `StripStore` is defined in Task 11 and consumed by `renderAllDensities` in Task 12. `slotPositions` returns `SlotPosition[]` in Task 9, consumed in Task 10. `parseHexColor(hex, alpha?)` in Task 6 is called with two arguments in Task 10 for `bgOpacity`.

**One deliberate deviation from the spec, worth flagging at review time.** The spec's §9 lists "golden-file byte comparison" as a test. This plan does **not** include one, because PNG bytes depend on the zlib version bundled with Node — a golden file would turn a Node upgrade into a spurious failure. The guarantee is instead split across `test('is deterministic')` in Task 3 (same input, same bytes, same process) and `test('cached bytes are byte-identical to a fresh render')` in Task 11, which is the property §10 actually depends on. If you want stronger regression cover, add a fixture comparing *decoded RGBA* rather than encoded bytes.
