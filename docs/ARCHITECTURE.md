# How this codebase is laid out

Written 5 August 2026, to answer one question quickly: **where is this thing done?**

`docs/BUILD.md` is the specification — *what* the product does and why. This file is the map
— *where* each part of it lives. If the two ever disagree, BUILD.md is right and this file is
stale.

---

## The shape of it

```
apps/demo/          the web application — one Node process, no framework, no bundler
  server.ts         the router, and the handlers that have not been extracted yet
  views/            how pages are drawn
  *.ts              one file per domain concept (enrolment, stamping, broadcasts, …)

packages/
  image/            the whole image pipeline, written from scratch — PNG, QR, the stamp strip
  pass/             Apple Wallet and Google Wallet: building, signing, pushing
  i18n/             the two dictionaries, and nothing else
  db/               the Prisma schema and one shared client
```

There is no build step. Node 25 strips the types and runs the TypeScript directly, which is
why every import carries a `.ts` extension.

---

## `apps/demo/` — the application

### The shell

| File | What it is |
|---|---|
| `server.ts` | The HTTP router, and the page handlers not yet extracted. Route order matters: the short-link catch-all `GET /:code` is registered **last**, or it shadows every API route. |
| `views/chrome.ts` | The frame every merchant page is drawn into: design tokens, the stylesheet, the desktop top bar, the mobile tab bar, and `layout()`. |
| `views/stampScreen.ts` | The counter screen. The one page that does not use `layout()` — it needs camera CSS nothing else wants, and a staff PIN session gets a shorter header. |
| `views/html.ts` | HTML escaping. Deliberately one function. |

> **The rule that keeps the shell honest.** `CHROME_CSS` is emitted by `layout()` and by the
> stamp screen, and by nothing else. It used to be *copied* into the stamp screen, and the
> copy drifted: its `:root` never declared `--sunk`, so the top bar rendered flat against the
> canvas, and it never declared `.btn` at all, so Sign out came out as a raw browser button.
> A test walks all eight merchant pages and fails if a second `:root` block appears anywhere.

### Who the request is

| File | What it is |
|---|---|
| `auth.ts` | Passwords (scrypt), sessions in Postgres, the session cookie. |
| `staffAuth.ts` | The staff PIN session. Reaches the stamp screen and nothing else. |
| `staff.ts` | Staff accounts and their PINs. |
| `rateLimit.ts` | Per-IP and per-email limits. Sign-up and sign-in are both behind it — `scryptSync` blocks the event loop, so an unauthenticated loop would pin the machine. |

### The card, and the customer's copy of it

| File | What it is |
|---|---|
| `cardEdit.ts` | Updating a card, and the lock rule: once a customer has joined, the economics freeze. |
| `cardTemplates.ts` | The eight trade presets and their search. Pure data plus four functions — no I/O. |
| `cardImages.ts` | Logo/cover/icon uploads, content-addressed by hash. |
| `enrol.ts` | Turning a scan into a `Pass`. Idempotent by phone number, which is why re-scanning returns the same card with its stamps intact. |
| `stamp.ts` | Adding a stamp, including the 24-hour guard, re-checked inside the `WHERE` of the increment so two taps cannot both win. |
| `passContent.ts` | What the wallet pass actually says — fields, labels, the news banner. |
| `passkit.ts` | Apple's four web-service endpoints. |
| `pkpassCache.ts` | Cache key for a built pass. |
| `cardPush.ts` | Pushing every device holding a card. |
| `locations.ts` | Geofences inside the pass, capped at Apple's limit of ten. |

### Messages

| File | What it is |
|---|---|
| `broadcast.ts` | Sanitising a message and enqueuing a job. Every message path goes through here. |
| `broadcastWorker.ts` | The queue worker. Claims with `SELECT … FOR UPDATE SKIP LOCKED`. |
| `messageSweeper.ts` | Expires messages and pushes, so a notification stops existing after its TTL. |
| `automations.ts` | The birthday and win-back schedulers. |

> **The rule that keeps messages honest.** Selecting a recipient and marking it done are one
> statement — `UPDATE … WHERE … RETURNING`. Read-then-write would let a second tick, or a
> second machine, send the same customer the same message twice, and a customer greeted twice
> is worse off than one never greeted.

### Odds and ends

`csv.ts` (export, with formula-injection escaping), `multipart.ts` (upload parsing),
`env.ts` (`.env` loading), `appleCredentials.ts`.

---

## `packages/`

### `image/` — everything drawn

Written from scratch: there is no image library in this repo.

| Area | Files |
|---|---|
| PNG | `png/encode.ts`, `png/decode.ts` (bounded at 100 megapixels), `png/crc.ts` |
| Raster primitives | `raster/surface.ts`, `raster/shapes.ts`, `raster/resize.ts` (premultiplied), `raster/mask.ts`, `raster/bbox.ts` |
| The stamp icons | `raster/icons.ts` — ten glyphs drawn as line art at one shared stroke weight |
| The strip | `layout.ts`, `strip.ts`, `stripCache.ts`, `densities.ts` |
| Other | `qr.ts`, `contrast.ts` |

> **The strip cache is a 455× measured improvement.** It is content-addressed, so a card that
> has not changed is never re-rendered. `StripSpec` deliberately carries no customer
> identifier — two customers on the same card at the same stamp count are the same picture.

### `pass/` — the wallet

| File | What it is |
|---|---|
| `buildPass.ts` | Builds and signs the `.pkpass`. **Never** pass `-noattr` to the CMS signing step: it strips the signed attributes and iOS rejects the pass with a generic error that tells you nothing. A test asserts on the ASN.1 because `openssl smime -verify` cannot detect it. |
| `apns.ts` | The push connection. Keeps one long-lived HTTP/2 session, pings it every 30s, and gives each push a 5-second deadline. |
| `googleWallet.ts` | The Android half. |
| `credentials.ts` | Certificates and keys, read at call time and never inlined. |

> **Why the ping matters.** A TCP connection dropped by a NAT idle timeout leaves a
> *half-open* socket: `closed` and `destroyed` are both false, so the session looks alive and
> every push written into it hangs until the OS gives up minutes later. A quiet café hit this
> constantly and a busy one never did — which is what "sometimes the stamp doesn't show"
> actually was.

### `i18n/` and `db/`

`en.ts` is the reference dictionary; `ar.ts` is typed against its keys, so a missing
translation fails `tsc` rather than rendering as a blank element. `npm run test:i18n` checks
parity.

`db/` holds the Prisma schema, the migrations, and one shared client.

---

## Rules that are not obvious from the code

These have all been learned the hard way. Each one has a comment at the site, and most have a
test.

1. **`GET /:code` is registered last.** It is a catch-all; anywhere else it shadows every API
   route.
2. **`getUpdatedSerials` takes no `Authorization` header.** Apple sends none. Requiring one
   returns 401 to every iPhone, which looks exactly like the push never arriving.
3. **Cookies only — never `localStorage`.** The server has to be able to read the language.
4. **Never translate merchant-authored text.** Card names, rewards and broadcast messages are
   theirs. Our own copy — template presets, UI chrome — ships in both languages.
5. **This repository is public.** Never `git add -A`; stage explicit paths. No `certs/`, no
   `.env`, no `*.p8` / `*.pem` / `*.cer`.
6. **A NULL message expiry means expired, not eternal.** Reading it the other way exempted
   every pre-existing pass from the ephemeral-notifications feature.
7. **`font-weight: 800` does not exist.** IBM Plex Sans Arabic stops at 700; asking for more
   makes the browser fake it. See `docs/FONTS.md`.

---

## Testing

`npm test` runs everything against a **real local Postgres** — there are no database mocks.
Test files run in parallel, which is why several workers accept an `onlyJobIds` /
`onlyMerchantIds` scope: those are **test-isolation seams, never production features**, and
without them one file's worker claims another file's rows and the victim sees zero.

`npm run typecheck` is the authority on types — `node --test` strips types without checking
them, so a green test run proves nothing about the type layer.
