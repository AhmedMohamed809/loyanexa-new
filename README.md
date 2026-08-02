# LoyaNexa

Digital loyalty cards that live in **Apple Wallet** and **Google Wallet**.
No app for the customer. **No app for the merchant either** — stamping runs in the browser.

Arabic and English, full RTL.

---

## Start here

| File | What it is |
|---|---|
| **[`docs/BUILD.md`](docs/BUILD.md)** | The complete build specification — stack, schema, API, flows, measured performance numbers. **Single source of truth.** |
| [`prototype/index.html`](prototype/index.html) | A working prototype of the entire merchant + customer flow. Open it in a browser — no build, no server. |
| [`prototype/landing.html`](prototype/landing.html) | Marketing site prototype |
| [`brand/`](brand/) | Logo files and colour tokens |

Open the prototype first. Every screen in the spec is there and behaves correctly, so you
can see the intended behaviour before writing production code.

```bash
open prototype/index.html          # macOS
xdg-open prototype/index.html      # Linux
start prototype\index.html         # Windows
```

---

## The constraint that defines the product

**Nobody is ever required to install an app.** The customer scans a printed QR and the card
lands in the wallet already on their phone. The merchant stamps from a browser page using
the device camera.

Competitors require merchants to download a scanner app. We do not. Reject any proposal
that makes an app **mandatory** for either party — the whole business must stay runnable
from a browser, on any device, with nothing installed.

An **optional** Flutter merchant app is planned later, for high-volume merchants who want
the camera to open straight after login. Addition, never replacement.

---

## Planned stack

| Layer | Choice |
|---|---|
| Auth | Firebase Auth |
| Database | Postgres + Prisma |
| API | Node + TypeScript + Fastify |
| Cache | Redis |
| Queue | BullMQ |
| Storage | Cloudflare R2 |
| Hosting | Fly.io |
| Frontend | Next.js — except the customer enrol page, which stays plain HTML |

Rationale for each choice, and for what was **rejected** (Firestore, Cloud Functions for
wallet work, FCM), is in [`docs/BUILD.md`](docs/BUILD.md) §2.

---

## Status

Specification complete · prototype complete · **sub-project 1 built**.

`@loyanexa/image` renders stamp strips at three densities with a content-addressed
cache; `@loyanexa/db` holds the Prisma schema; `@loyanexa/i18n` holds the dictionaries
with a CI parity gate. Next: sub-project 2, the pass engine.

```bash
npm ci && npm test
```

---

## Security

**Never commit** `certs/`, `.env`, `*.p8`, `*.pem`, `*.cer`, or any database file.
If wallet credentials ever reach this repository they must be revoked and reissued.
