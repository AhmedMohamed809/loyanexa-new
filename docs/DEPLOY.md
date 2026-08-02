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

Not currently needed: the APNs `.p8` key (`certs/AuthKey_*.p8`). The demo
issues passes without a `webServiceURL`/`authenticationToken` (see
`packages/pass/src/buildPass.ts`), so it never calls APNs — push-based live
updates are sub-project 6's job. Nothing in this deploy depends on it.

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

Then open `https://loyanexa-demo.fly.dev/` and create a card — the "Scan to
enrol" QR on the card detail page should encode
`https://loyanexa-demo.fly.dev/<code>`, not a LAN address. If it doesn't,
`PUBLIC_BASE_URL` isn't set (or isn't set to the app's real hostname).
