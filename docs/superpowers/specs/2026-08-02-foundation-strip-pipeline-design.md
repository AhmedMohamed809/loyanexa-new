# Sub-project 1 — Foundation and the stamp-strip pipeline

**Date:** 2026-08-02
**Status:** Approved, ready for planning
**Covers:** the first of seven sub-projects decomposed from `docs/BUILD.md`

---

## 1 · Why this is decomposed

`BUILD.md` is a 6–8 week, seven-phase build spanning at least five independent
subsystems. That is too large for one spec and one implementation plan. It is split into
seven sub-projects, each with its own spec → plan → build cycle:

| # | Sub-project | Needs wallet credentials? |
|---|---|---|
| **1** | **Foundation + stamp-strip image pipeline** | No |
| 2 | Pass engine — `pass.json`, QR, `.pkpass` zip, signing, Google Wallet JWT | Only final signing |
| 3 | Public customer path — short link, enrol page, stamp screen, anti-fraud | No |
| 4 | Merchant auth + billing — Firebase, onboarding, Stripe | No |
| 5 | Merchant dashboard — Next.js | No |
| 6 | Live updates — PassKit endpoints, APNs, BullMQ broadcasts | **Yes** |
| 7 | Landing site | No |
| 8 | **Optional** Flutter merchant app — opens straight to the camera after login | No |

This document specifies **sub-project 1 only**.

Sub-project 8 is an *addition*, never a replacement: the browser stamp screen must remain
fully sufficient on its own, or the product loses the constraint it is differentiated on
(§0). It is also why §8.15 must not depend on `BarcodeDetector` — see §12 below.

## 2 · Correction to BUILD.md §19

§19 says a pure-JS PNG encoder, a verified QR encoder, the PassKit endpoints and the
bilingual dictionaries already exist and should be *ported, not rebuilt*.

**None of that code exists in this repository or anywhere else the author has.** The
prototype contains only a canvas-based `qrMatrix`/`drawQR`. Every item in §19 is a
from-scratch build. This spec plans accordingly; §19 should be treated as aspirational
rather than as a description of available assets.

## 3 · Deliverable

A repository that passes `npm ci && npm test`, containing:

- an npm-workspaces monorepo under TypeScript strict
- the Prisma schema, migrated against local Postgres
- a CI gate running typecheck, tests and the i18n parity check
- **one substantive package**: the stamp-strip renderer and its content-addressed cache

There is no HTTP server and no UI. Nothing here can be opened in a browser. The payoff is
that the two highest-ranked risks in §18 are retired before anything is built on them.

## 4 · Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Monorepo | **npm workspaces** | npm 11 already present; no extra installs |
| Tests | **`node:test`** | Built into Node 25; this slice is pure functions over buffers |
| Image pipeline | **Strict pure JS**, `node:zlib` only | §17 forbids native deps in the image pipeline. `node:zlib` is Node core, not an npm native dependency, so it is in scope |
| Only image npm dep | **`jpeg-js`** | Merchants upload JPGs; a pure-JS decoder is the one thing not worth hand-writing |
| Local infra | Local Postgres 16 | Docker is not installed. Redis is not needed in this slice |

Rejected: `sharp` and `@napi-rs/canvas`. Both are native and contradict §17, and the 93 ms
budget in §10 was measured against a pure-JS implementation.

## 5 · Workspace layout

```
package.json           workspaces; scripts: typecheck / test / test:i18n / bench
tsconfig.base.json     strict + noUncheckedIndexedAccess
packages/image/        @loyanexa/image   the substance of this slice
packages/db/           @loyanexa/db      prisma schema + client singleton
packages/i18n/         @loyanexa/i18n    dictionaries + parity checker
scripts/check-i18n.mjs
.github/workflows/ci.yml
```

No `apps/` directory yet — those arrive with sub-project 3. Empty scaffolding is not
created ahead of need.

## 6 · `packages/image`

Small units, each independently testable:

| Unit | Responsibility |
|---|---|
| `png/crc.ts` | CRC32 table and checksum |
| `png/encode.ts` | IHDR/IDAT/IEND chunks, per-scanline filter, deflate via `node:zlib` |
| `png/decode.ts` | 8-bit RGB/RGBA/palette/grey + `tRNS` → RGBA; rejects interlaced with a clear error |
| `jpeg.ts` | Wrapper over `jpeg-js` → RGBA |
| `raster/surface.ts` | RGBA buffer; `fill`, `blendPixel`, `compositeOver` |
| `raster/shapes.ts` | Anti-aliased circle fill/stroke and rounded square via analytic edge coverage |
| `raster/mask.ts` | Circular mask with the thin rim §9.2 requires so a pale logo still reads as a stamp |
| `raster/resize.ts` | Box/bilinear downscale for logos and cover images |
| `strip.ts` | Composition: background → slots → filled/empty → optional logo stamp |
| `stripCache.ts` | `StripStore` interface, bounded LRU `MemoryStore`, `cachedStrip()` |
| `densities.ts` | `strip.png`, `@2x`, `@3x` in one call |

### 6.1 The cache thesis, enforced by the type system

§10's central claim is that a strip depends only on `(goal, filled, colours, logo, scale)`
and **never on which customer holds the pass** — an 8-stamp card has 9 possible images, not
one per customer. `StripSpec` therefore has no customer field, making a per-customer strip a
compile error rather than a code-review catch:

```ts
export interface StripSpec {
  goal: number;            // 3..20
  filled: number;          // 0..goal
  shape: 'circle' | 'square';
  bgColor: string;
  bgOpacity: number;
  activeColor: string;
  inactiveColor: string;
  logo?: ImageRef;         // { rgba, w, h, hash }
  cover?: ImageRef;
  scale: 1 | 2 | 3;
}
```

Cache key = SHA-256 over a canonical serialisation of that object. Images contribute their
**content hash, not their bytes**, so a render never hashes a megabyte.

### 6.2 Geometry

Base canvas 375×144 pt; @3x is 1125×432 px.

Slot layout is defined **once**, exported from this package, and imported by the dashboard's
live preview — reimplementing it there would let the preview and the real pass drift.

```
goal <= 6  → one row
goal >  6  → two rows: ceil(goal/2) then floor(goal/2)
```

This satisfies the cases §8.5 states (8 → 4+4, 11 → 6+5). At goal 20 that is 10+10 across
375 pt, roughly 37 pt per slot — tight but legible.

Empty slot renders as a hollow ring; filled as a solid disc, or the merchant's logo
circularly masked when custom stamps are enabled.

## 7 · `packages/db`

`schema.prisma` ported from §11 with four corrections:

1. **`LinkCounter` as written in §11 does not parse.** It declares two fields on one line;
   Prisma requires one per line. Reformatted.
2. **`Card` gains `logoStampHash` and `coverHash`.** Without stored content hashes the cache
   key can only reference the R2 URL, so re-uploading an image to the same URL would serve
   stale strips indefinitely. Hash once at upload.
3. **`Pass.merchantId` stays denormalised** with no relation to `Merchant`. This is
   load-bearing, not an oversight: it lets `[merchantId, lastStampAt]` answer the "gone
   quiet" query without a join.
4. Every index in §11 is retained. §11 states plainly that removing them breaks at a
   million rows.

The package exports a single `PrismaClient` singleton and nothing else. Migrations run
against local Postgres 16.

## 8 · `packages/i18n`

`ar.ts` and `en.ts`, with the key type derived from `en` so a missing Arabic key is a
compile error, plus `scripts/check-i18n.mjs` for the runtime set comparison CI runs.

Seeded with only the keys needed now — mostly error strings. Writing full dictionaries
before the screens exist is guesswork. It belongs in this slice because `CONTRIBUTING.md`
already requires `npm run test:i18n` before every commit, so the gate must exist from the
first commit and grow with the app.

## 9 · Testing

| Test | Guards against |
|---|---|
| PNG encode → decode round-trip | Chunk, CRC and filter errors |
| Golden-file byte comparison | Silent output drift across refactors |
| Cached bytes byte-identical to fresh render | The cache corrupting output — §10's core claim |
| Different logos produce different keys | Serving one merchant's logo to another |
| LRU stays bounded | Unbounded memory growth |
| Layout for 8, 11 and all of 3–20 | Preview/pass divergence across the slider range |
| Same spec → same bytes across processes | Non-determinism, which makes content-addressing meaningless |

**No timing assertions in CI.** Performance tests are flaky on shared runners and train
people to ignore red builds. The 27/55/93 ms figures from §10 get a separate `npm run bench`
run deliberately.

## 10 · Explicitly out of scope

No Fastify, no routes, no Redis (the `StripStore` interface exists; `RedisStore` arrives with
the server in sub-project 3), no R2 uploads, no `pass.json`, no QR encoder, no `.pkpass`
signing, no Google Wallet code, no Next.js, no enrol page, no auth, no Stripe.

## 11 · Phase 0 — provisioned 2026-08-02

Completed before this slice begins. Values live in `.env`; **no identifiers or secrets are
recorded in this repository.**

**Apple — complete.** Pass Type ID registered; signing certificate issued and verified
(certificate public key matches the private key, chain verifies to Apple Root CA via WWDR
G4); APNs auth key created; WWDR G4 installed. `certs/` holds `signerKey.pem`,
`signerCert.pem`, `wwdr.pem` and the `.p8`, all gitignored.

**Google — working in demo mode.** Issuer account created; GCP project created with the
Wallet API enabled; service account created and granted **Developer** on the issuer; a
loyalty class created and verified via `loyaltyClass.list` returning it as `approved`.
Publishing access is pending the business profile re-review.

### Corrections to BUILD.md arising from Phase 0

- **§2 describes APNs as authenticated by the Pass Type ID certificate.** That is the older
  mTLS route. We use token-based `.p8` auth instead, with `apns-topic` set to the Pass Type
  ID. The certificate remains mandatory for *signing* passes but is not used for pushing.
  This matters because the certificate expires yearly and the key does not — it removes one
  of two silent annual failure modes.
- **The Pass Type ID certificate expires 1 September 2027.** §18 ranks forgetting this as
  risk 9 because the failure is silent: existing passes keep working while new ones quietly
  stop being issued. A reminder belongs in a calendar, not only in a document.
- **The Google Pay *Merchant ID* and the Wallet *Issuer ID* are different values.** Only the
  numeric issuer ID belongs in `GOOGLE_ISSUER_ID`.
- **Creating a loyalty class through the Business Console UI failed silently** — no error, no
  class. Creating it through the REST API returned a real status. Prefer the API for
  anything verifiable.

## 12 · Merchant stamping — decided 2026-08-02

Not part of this slice (it lands in sub-project 3), recorded here because it changes §0,
§8.15 and §19 of `BUILD.md`.

**`BarcodeDetector` cannot carry the stamp screen.** Per MDN compat data:

| Platform | Support |
|---|---|
| Chrome Android | 83+ |
| Chrome macOS / ChromeOS | 88+ |
| Chrome Windows / Linux | none |
| Safari, iOS and macOS | behind a `Shape Detection API` preference — effectively unavailable |
| Firefox, all platforms | none |

A café stamping on an iPad would fall through to §8.15's manual-entry path, i.e. typing a
code per customer — worse than the competitor app the product is built to displace.

**Decision:** the stamp screen uses `getUserMedia` with a **WASM QR decoder** (~40 KB) as
the path that always works, optionally using `BarcodeDetector` as a fast path where it
exists. This affects only the merchant stamp screen; the customer enrol page stays at its
~4 KB budget.

**Decision:** an **optional** Flutter merchant app becomes sub-project 8, built after the
platform ships. Browser stamping remains the guaranteed, fully sufficient path. An app that
becomes required would forfeit §0, which is the product's entire differentiation.
