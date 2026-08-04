#!/usr/bin/env node
// scripts/repush-cards.ts
//
// One-shot backfill for a pass.json CONTENT-SHAPE change that isn't a
// per-card data edit — sub-project 8's "clean the card face" (BUILD.md §9.1's
// 2026-08-04 note): the merchant-broadcast message moved from
// `storeCard.auxiliaryFields` (a card-face row) to `storeCard.backFields`.
//
// A normal card design edit (colour, logo, …) touches the `Card` row, which
// does two things automatically: Prisma's `Card.updatedAt @updatedAt` bumps,
// which changes apps/demo/pkpassCache.ts's cache key
// (serial:stamps:passUpdatedAt:cardUpdatedAt) and so invalidates every
// `.pkpass` already cached for that card's passes; and
// apps/demo/cardEdit.ts's handler fires apps/demo/server.ts's
// pushCardUpdate(id) afterwards, which wakes every device on every one of
// that card's passes to re-poll immediately (apps/demo/cardPush.ts's
// pushCardDevices — added in sub-project 5 alongside the cache-key fix,
// specifically because fixing the cache alone only means a device's *next*
// unprompted poll picks up a change, which could be a long time coming).
//
// A code-only shape change like this one touches no Card/Pass row on its
// own, so neither of those two things happens by itself. Without this
// script, every already-issued pass keeps rendering the old three-field face
// until whatever card it belongs to next gets edited or stamped for an
// unrelated reason. This script reuses the exact same mechanism a design
// edit already relies on, applied to every card at once:
//
//   1. A no-op `prisma.card.update({ where: { id }, data: {} })` per card —
//      bumps `Card.updatedAt` via Prisma's `@updatedAt`, invalidating the
//      `.pkpass` cache entry for every pass that card has issued.
//   2. `pushCardDevices(cardId, sendOne)` (apps/demo/cardPush.ts) — wakes
//      every device registered for any of that card's passes to re-poll
//      right away, via the same ApnsClient construction
//      apps/demo/server.ts's own getApnsClient() uses.
//
// No `changeMessage` fires for this: the message field's own *value* did not
// change, only where it lives in the pass, so no lock-screen banner appears
// for the layout change itself — correct, since nothing broadcast-worthy
// happened. Devices simply re-render the new layout on their next silent
// poll, which this script triggers immediately instead of leaving it to
// chance.
//
// --dry-run prints exactly what would happen (card count, per-card device
// count) without writing to Postgres or contacting Apple at all — safe to
// run against production first to see the blast radius.
//
// Usage:
//   node scripts/repush-cards.ts --dry-run
//   node scripts/repush-cards.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from '../apps/demo/env.ts';
import {
  resolveAppleCredentials as resolveAppleCredentialPaths,
  resolveApnsKeyPem,
} from '../packages/pass/src/credentials.ts';
import {
  ApnsClient,
  parseApnsEnvironment,
  parseApnsAuthMode,
  isBadEnvironmentKeyError,
} from '../packages/pass/src/apns.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
loadEnvFile(path.join(ROOT, '.env'));

const { prisma } = await import('../packages/db/src/index.ts');
const { devicesForCard, pushCardDevices } = await import('../apps/demo/cardPush.ts');

const DRY_RUN = process.argv.includes('--dry-run');

const APNS_ENV = parseApnsEnvironment(process.env.APNS_ENV);
const APNS_AUTH = parseApnsAuthMode(process.env.APNS_AUTH);

/** Mirrors apps/demo/server.ts's own getApnsClient() exactly — same auth-mode branch, same credential sources — so this script talks to Apple the same way the running server does. */
function buildApnsClient(): ApnsClient | undefined {
  try {
    if (APNS_AUTH === 'certificate') {
      const { signerCertPath, signerKeyPath, wwdrPath } = resolveAppleCredentialPaths(ROOT);
      const certChainPem = `${fs.readFileSync(signerCertPath, 'utf8')}\n${fs.readFileSync(wwdrPath, 'utf8')}`;
      const keyPem = fs.readFileSync(signerKeyPath, 'utf8');
      return new ApnsClient({ auth: { mode: 'certificate', certChainPem, keyPem }, environment: APNS_ENV });
    }
    const keyId = process.env.APNS_KEY_ID;
    const teamId = process.env.APPLE_TEAM_ID;
    if (!keyId) throw new Error('.env is missing APNS_KEY_ID');
    if (!teamId) throw new Error('.env is missing APPLE_TEAM_ID');
    const privateKeyPem = resolveApnsKeyPem(ROOT);
    return new ApnsClient({ auth: { mode: 'token', keyId, teamId, privateKeyPem }, environment: APNS_ENV });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[repush-cards] APNs not configured (auth=${APNS_AUTH}): ${message}`);
    return undefined;
  }
}

async function main(): Promise<void> {
  const passTypeId = process.env.APPLE_PASS_TYPE_ID;
  const client = DRY_RUN ? undefined : buildApnsClient();
  if (!DRY_RUN && (!client || !passTypeId)) {
    console.error(
      '[repush-cards] refusing to push: APNs client or APPLE_PASS_TYPE_ID unavailable. ' +
        'Use --dry-run to preview instead, or fix the environment first.'
    );
    process.exitCode = 1;
    return;
  }

  const cards = await prisma.card.findMany({ select: { id: true, name: true } });
  console.log(
    `[repush-cards] ${cards.length} card(s) found.` + (DRY_RUN ? ' (dry run — nothing will be written or pushed)' : '')
  );

  let cardsTouched = 0;
  let devicesPushedOk = 0;
  let devicesFailed = 0;
  let devicesPruned = 0;

  for (const card of cards) {
    if (DRY_RUN) {
      const devices = await devicesForCard(card.id);
      console.log(`  would touch card ${card.id} (${card.name}) and wake ${devices.length} device(s)`);
      continue;
    }

    // Step 1: bump Card.updatedAt — invalidates every pass this card has
    // issued in apps/demo/pkpassCache.ts's cache key. An empty `data` object
    // is enough: Prisma's `@updatedAt` fires on the write itself, not on
    // whether any other column's value actually changed.
    await prisma.card.update({ where: { id: card.id }, data: {} });
    cardsTouched++;

    // Step 2: wake every device on every one of this card's passes to
    // re-poll right away, exactly as apps/demo/server.ts's pushCardUpdate()
    // does after a merchant's own design edit.
    await pushCardDevices(card.id, async (device) => {
      const result = await client!.sendPush(device.pushToken, passTypeId!);
      if (result.ok) {
        devicesPushedOk++;
        return { ok: true };
      }
      if (result.reason === 'gone') {
        devicesPruned++;
        console.log(`[repush-cards] card ${card.id}: pruned device ${device.deviceId} (410 Gone)`);
        return { ok: false, gone: true };
      }
      devicesFailed++;
      if (isBadEnvironmentKeyError(result.status, result.body)) {
        console.error(
          `[repush-cards] card ${card.id}: push to device ${device.deviceId} rejected — ` +
            `BadEnvironmentKeyInToken (see docs/BUILD.md §2's 2026-08-03 note).`
        );
      } else {
        console.error(
          `[repush-cards] card ${card.id}: push to device ${device.deviceId} failed — ` +
            `status=${result.status} body=${result.body}`
        );
      }
      return { ok: false };
    });
  }

  if (DRY_RUN) {
    console.log('[repush-cards] dry run complete — nothing was written or pushed.');
    return;
  }
  console.log(
    `[repush-cards] done. cards touched=${cardsTouched} devices pushed ok=${devicesPushedOk} ` +
      `failed=${devicesFailed} pruned=${devicesPruned}`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
