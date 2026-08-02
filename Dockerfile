# syntax=docker/dockerfile:1
#
# LoyaNexa merchant demo (apps/demo/server.ts). Fly.io was chosen over any
# serverless platform specifically so this container can shell out to real
# `openssl` and `zip` binaries — packages/pass/src/buildPass.ts signs and
# bundles real .pkpass archives that way, and that stays true here.
#
# No build step: Node 25 strips TypeScript's erasable syntax at load time,
# so the app runs straight from apps/demo/server.ts.

FROM node:25-slim

# openssl: signs .pkpass archives (packages/pass/src/buildPass.ts shells
#   out to it via execFileSync) and is also what Prisma's query engine
#   needs at runtime.
# zip: bundles the signed .pkpass archive (same file, same mechanism).
# ca-certificates: TLS trust store for outbound HTTPS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl zip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# .dockerignore keeps certs/, .env, *.pem/*.p8/*.cer/*.pkpass, node_modules/,
# .git/, .superpowers/, prototype/ and docs/ out of the build context
# entirely — none of that can land in an image layer if it's never sent to
# the daemon in the first place. Apple Wallet credentials reach this
# container only via `fly secrets set` (see docs/DEPLOY.md), never as
# files baked into the image.
COPY . .

# npm ci's own postinstall hook runs `prisma generate`, but call it again
# explicitly — an image build should not depend on a lifecycle script
# quietly doing the right thing.
RUN npm ci \
    && npx prisma generate --schema packages/db/prisma/schema.prisma

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "apps/demo/server.ts"]
