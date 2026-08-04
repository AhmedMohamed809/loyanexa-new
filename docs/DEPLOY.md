# Deploying the demo to Fly.io

This covers `apps/demo/server.ts` only — the merchant + enrol demo, not the
main LoyaNexa product. Fly.io was chosen because the app shells out to the
system `openssl` and `zip` binaries to sign and bundle real `.pkpass`
archives (`packages/pass/src/buildPass.ts`); a real container gives us both,
which a serverless platform would not.

This repository is **public**. Nothing in `certs/` — the Apple signer
certificate, its private key, the WWDR intermediate, or the unused APNs
`.p8` — is ever committed, and none of it is ever baked into the Docker
image (see `.dockerignore`). Every secret below reaches the running
container only as a Fly secret (an encrypted runtime env var), never as a
file in an image layer.

## Environment variables

| Variable | Required | Set via | Notes |
|---|---|---|---|
| `DATABASE_URL` | yes | `fly secrets set` | Postgres connection string. `@loyanexa/db` (Prisma) needs this at runtime; `prisma generate` at build time does not. |
| `APPLE_TEAM_ID` | yes | `fly secrets set` | Apple Developer Team ID. Not secret-shaped, but keep it with the other Apple config. |
| `APPLE_PASS_TYPE_ID` | yes | `fly secrets set` or `[env]` in `fly.toml` | e.g. `pass.com.loyanexa.loyalty`. Identifies the pass type, not sensitive on its own. |
| `APPLE_SIGNER_CERT` | yes (production) | `fly secrets set` | **PEM contents** of the Apple Wallet signer certificate — the file, not a path. Read by `packages/pass/src/credentials.ts`. |
| `APPLE_SIGNER_KEY` | yes (production) | `fly secrets set` | **PEM contents** of the signer's private key. |
| `APPLE_WWDR_CERT` | yes (production) | `fly secrets set` | **PEM contents** of the Apple WWDR intermediate certificate. |
| `PUBLIC_BASE_URL` | yes (production) | `[env]` in `fly.toml`, or `fly secrets set` | The app's public HTTPS origin, e.g. `https://loyanexa-demo.fly.dev`. Every enrol link and QR code uses this host. **Without it, links fall back to the container's own LAN-discovery logic, which is meaningless inside a container** — always set this in production. |
| `PORT` | no | `[env]` in `fly.toml` (already set to `8080`) | Falls back to `8080` if unset. Fly's `internal_port` in `fly.toml` must match. |
| `APPLE_SIGNER_CERT_PATH` / `APPLE_SIGNER_KEY_PATH` / `APPLE_WWDR_CERT_PATH` | no (local dev only) | local `.env` | File-path fallback used only when the `APPLE_SIGNER_CERT` / `_KEY` / `APPLE_WWDR_CERT` content vars above are **not** set. This is how local development has always worked; do not set these in Fly — there are no cert files in the container to point at. |
| `APNS_KEY_ID` | yes (production, for live updates) | `fly secrets set` | The 10-character key ID of the APNs `.p8` auth key. Not secret-shaped, but keep it with the other Apple config. |
| `APNS_KEY` | yes (production, for live updates) | `fly secrets set` | **PEM contents** of the APNs `.p8` signing key — the file, not a path. Read by `packages/pass/src/credentials.ts`'s `resolveApnsKeyPem()`, same env-content-over-path pattern as the signer cert trio above. |
| `APNS_KEY_PATH` | no (local dev only) | local `.env` | File-path fallback for `APNS_KEY`, used only when `APNS_KEY` is unset — same local-dev convention as `APPLE_SIGNER_CERT_PATH`. Do not set on Fly. |
| `APNS_AUTH` | no | `[env]` in `fly.toml`, or `fly secrets set` | `certificate` (default) or `token` — which of the two ways `packages/pass/src/apns.ts` authenticates to APNs. **Leave unset in production**: `certificate` mode reuses the `APPLE_SIGNER_CERT`/`_KEY`/`APPLE_WWDR_CERT` values above as an mTLS client certificate and is the only mode proven to work against production right now — see `docs/BUILD.md` §2's 2026-08-03 note. `token` mode needs `APNS_KEY_ID`/`APNS_KEY` and 403s (`BadEnvironmentKeyInToken`) until that key is provisioned for Production in the Apple Developer portal. |
| `APNS_ENV` | no | `[env]` in `fly.toml`, or `fly secrets set` | `production` (default) or `sandbox` — which Apple gateway to push to. Wallet devices register against production; leave unset. |

`PUBLIC_BASE_URL` now does double duty: besides enrol links and QR codes,
every pass issued (or rebuilt by the PassKit web service) while it's set
carries `webServiceURL: "<PUBLIC_BASE_URL>/apple"` and a per-pass
`authenticationToken`, which is what makes a stamp show up on the lock
screen without reopening Wallet (BUILD.md §9.3). Set it to the app's real
HTTPS origin before relying on live updates — an http origin is rejected by
`buildPassJson` outright (not just "silently ignored by Apple"), and an
unset one omits both fields, which is a valid but static pass.

`APPLE_SIGNER_CERT` / `APPLE_SIGNER_KEY` / `APPLE_WWDR_CERT` win whenever
all three are set — that's the production path. Leave all three unset and
the app falls back to `APPLE_SIGNER_CERT_PATH` / `APPLE_SIGNER_KEY_PATH` /
`APPLE_WWDR_CERT_PATH`, which is local dev. Setting only *some* of the three
content vars is treated as a misconfiguration and the app refuses to start
issuing passes rather than silently falling back.

## Setting the certificate secrets

`fly secrets set` takes `KEY=value` pairs. For multi-line PEM content, pass
the *file's contents* as the value — do **not** paste the value inline in a
shell command where it could end up in shell history; read it from the file
directly:

```bash
fly secrets set \
  APPLE_TEAM_ID="<your Apple Team ID>" \
  APPLE_PASS_TYPE_ID="pass.com.loyanexa.loyalty" \
  APPLE_SIGNER_CERT="$(cat certs/signerCert.pem)" \
  APPLE_SIGNER_KEY="$(cat certs/signerKey.pem)" \
  APPLE_WWDR_CERT="$(cat certs/wwdr.pem)" \
  APNS_KEY_ID="<your APNs Auth Key ID>" \
  APNS_KEY="$(cat certs/AuthKey_XXXXXXXXXX.p8)" \
  DATABASE_URL="<your production Postgres connection string>"
```

Run that from the repository root, on your own machine, with the real
`certs/*.pem` files present locally (they are gitignored — this command
reads them off disk, it does not need them committed). `fly secrets set`
sends values over an encrypted channel and stores them as machine
secrets; they are never written to `fly.toml`, never logged, and never
appear in `git status`/`git diff` because the command substitutes the file
contents client-side.

Do not run `fly secrets set APPLE_SIGNER_CERT=<paste the actual PEM here>`
by hand — beyond the shell-history risk, this file documents the *shape* of
the command intentionally without a real value inlined anywhere.

## Deploying

Once secrets are set:

```bash
fly launch --no-deploy   # first time only, if the app doesn't exist yet — it will detect fly.toml
fly deploy
```

`fly deploy` builds the image from the repository's `Dockerfile` (context
filtered by `.dockerignore`, so `certs/`, `.env`, and `node_modules/` never
leave your machine), runs `prisma generate` inside the container against
`packages/db/prisma/schema.prisma`, and starts `node apps/demo/server.ts`.

## Verifying after deploy

```bash
curl https://loyanexa-demo.fly.dev/health
# => {"status":"ok"}
```

## First deploy after auth — set a password for the existing account (added 2026-08-04)

**Do this once, immediately after the first `fly deploy` of the branch that added
email+password sign-in** (BUILD.md §8.1/§8.2). Skip it and the merchant dashboard —
`/app`, `/customers`, `/reports`, `/settings`, `/notifications`, the card designer —
is unreachable for the owner's own account until you do this. Customer-facing routes
(enrol, pass issuance, stamping, live updates) are unaffected either way; this is a
dashboard-only outage.

Why: this branch's migration
(`packages/db/prisma/migrations/20260803233404_add_auth_sessions`) adds
`Merchant.passwordHash` as **nullable**, specifically because the database already
has one Merchant row from before auth existed — the live demo account,
`ahmedabdulalgane@gmail.com`, which owns every card currently live. That row comes
out of this migration with `passwordHash = NULL`. Sign-in refuses a null hash (it
never has a password to check the submitted one against) and shows a specific
message telling you so, rather than the generic "wrong password" — see
`apps/demo/server.ts`'s `handleSignIn`. Sign-up can't help either: it 409s with
"an account with that email already exists," because it does. There is no
self-serve password-reset flow yet, so a real password has to be set once, by hand,
from the server side.

`scripts/create-merchant.ts` is that escape hatch. It is idempotent by email — since
`ahmedabdulalgane@gmail.com` already exists, it **updates** that row's password (and
name) in place rather than inserting a second Merchant, so every Card already
attached to it stays attached to the same `Merchant.id`; nothing is orphaned.

Run it inside the running machine, over `fly ssh console`, reading the password from
the `MERCHANT_PASSWORD` environment variable rather than an argv flag — typing the
password as a command-line argument would land it in that shell's own history:

```bash
fly ssh console -a loyanexa-new
# now inside the machine, at /app (the image's WORKDIR — see Dockerfile):
MERCHANT_PASSWORD='choose a strong passphrase here, at least 10 characters' \
  node scripts/create-merchant.ts --email ahmedabdulalgane@gmail.com --name "<business name>"
```

Expect output like:

```
Updated existing merchant <id> (ahmedabdulalgane@gmail.com) — password set, name set to "<business name>".
This account already owns N card(s) — they remain attached, nothing was orphaned.
```

Check that the card count (`N`) matches what you expect before treating this as
done. Then sign in normally at `/signin` with that email and the password you just
set — the specific "this account needs a password set" message should not appear
again for this account.

If a different Merchant (a real new signup, not this pre-existing account) ever ends
up with `passwordHash = NULL` some other way, the same command — with that
Merchant's own email — fixes it the same way.

## Live Wallet updates need a warm machine (added 2026-08-03)

`fly.toml`'s `[http_service]` now sets `min_machines_running = 1` (was `0`). This is not
optional for live pass updates: `packages/pass/src/apns.ts` keeps one long-lived HTTP/2
session to Apple's APNs gateway open and reuses it for every push (BUILD.md §18 item 3),
because a fresh TLS handshake to Apple costs hundreds of milliseconds — a large fraction
of the 1-2 second stamp-to-banner target on its own. Scaling to zero machines
(`auto_stop_machines` with no floor) tears that session down along with the container;
the next stamp then pays for a cold container start *and* a cold TLS handshake to Apple on
the same request that is supposed to land in 1-2 seconds. `auto_stop_machines` stays `true`
so a genuine traffic spike can still add capacity — only the floor changed, from "scale to
nothing when idle" to "always keep one machine, and its one warm APNs session, running."

This also affects `APNS_AUTH` (see the table above and `docs/BUILD.md` §2's 2026-08-03
note): certificate mode's mTLS handshake and token mode's cached JWT both benefit equally
from a session that survives between requests instead of one torn down and rebuilt by a
cold start.

**Cost note:** `min_machines_running = 1` means this app now bills for one Fly machine
continuously, 24/7, instead of only while traffic is actually arriving — the tradeoff this
section exists to make explicit. `auto_stop_machines` staying `true` only adds *extra*
machines under real load and scales those back down again; it no longer lets the app scale
to zero the way it could before live updates needed a warm APNs session. Budget for one
always-on machine as a fixed cost of live Wallet updates, not an occasional one.

Then open `https://loyanexa-demo.fly.dev/` and create a card — the "Scan to
enrol" QR on the card detail page should encode
`https://loyanexa-demo.fly.dev/<code>`, not a LAN address. If it doesn't,
`PUBLIC_BASE_URL` isn't set (or isn't set to the app's real hostname).

## Known consideration: card logos/covers live in Postgres until R2 lands (2026-08-03)

Merchant-uploaded logos and cover images (`packages/db/prisma/schema.prisma`'s
`CardImage` table) are stored as bytes in Postgres, keyed by content hash.
This is a deliberate interim step, not the intended end state — `docs/BUILD.md`
§18 item 2 ranks "leaving logos in the database" as a real risk ("rows reach
megabytes and are read on every query"). The design here avoids the specific
harm that item describes: `Card` rows themselves stay small (they store only
a hash, never bytes), and `CardImage` rows are read only by `GET /img/:hash`
(cached forever, since a hash can never point at different bytes) — never as
part of an ordinary Card/dashboard query. There are no R2 credentials
configured for this app yet. When they exist, `CardImage` should be replaced
with an R2 object keyed the same way (content hash), and `GET /img/:hash`
becomes a redirect (or proxy) to the object store instead of a Postgres read;
nothing else in the schema or the upload path should need to change, since
every consumer already only knows the hash, not where the bytes live.

## Known consideration: the landing page loads a font from Google (2026-08-03)

`apps/demo/public/index.html` — the marketing landing page served at `GET /` —
loads the Alexandria typeface from `fonts.googleapis.com` / `fonts.gstatic.com`
(`<link rel="preconnect">` / `<link rel="stylesheet">` near the top of `<head>`).
That is an external network dependency on an otherwise self-contained page: if
Google Fonts is unreachable or blocked (corporate proxies, some regions), the
page still renders — `display=swap` means text shows in the fallback
`system-ui` face immediately — but Alexandria itself won't load until/unless
the request succeeds.

This is acceptable for the marketing site as shipped. The eventual fix is to
self-host the font instead of depending on Google's CDN — e.g. via the
`@fontsource-variable/alexandria` package — which removes the external request
entirely and the layout-shift risk that comes with it. `docs/FONTS.md`
(copied from the owner's font spec) documents that self-hosting path, plus the
plain `<link>`, Next.js, Vite, and Tailwind loading snippets in use elsewhere.
No action is required before this deploy; treat this as backlog.
