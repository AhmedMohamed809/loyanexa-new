# Notes for Claude Code

Read `docs/BUILD.md` first — it is the complete specification.

## Hard rules

- **No mobile app, ever.** Not for the customer, not for the merchant. Stamping is a
  browser page using `BarcodeDetector` with a manual-entry fallback.
- **The customer enrol page stays plain HTML/CSS/JS.** No framework, no bundler. It is one
  form opened on café wifi and enrolment rate is the metric the business rests on. Target
  ~4 KB.
- **Never use `localStorage` or `sessionStorage`.** Cookies only, so the server can read
  language and theme.
- **Never commit `certs/` or `.env`.**
- **`letter-spacing: 0` under `html[lang=ar]`** — tracking breaks Arabic letter joining.
- **Logical CSS properties only** — `margin-inline-start`, never `left`/`right`.
- **Never translate merchant-authored text** — card name, reward, terms stay as written.
- **The short-link catch-all `GET /:code` is registered last**, or it shadows every API route.

## Before you optimise anything else

1. The **strip-image cache** is a 455× measured improvement. Build it first.
2. **Logos go to R2**, never as data URLs in the database.
3. Wallet work needs a **persistent server** — serverless breaks APNs connection reuse.

## Port, do not rebuild

A pure-JS PNG encoder, a verified QR encoder, the correct `pass.json` layout, the four
PassKit endpoints and the bilingual dictionaries already exist and are proven. `BUILD.md`
§19 lists them.
