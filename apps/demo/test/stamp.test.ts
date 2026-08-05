// apps/demo/stamp.ts — the stamp screen's write path (BUILD.md §8.15, §9.6).
// Exercises applyStamp() against the real local Postgres (no mocks): every
// test creates its own Merchant/Card/Pass rows with randomised identifiers
// and deletes them afterwards in a `finally`, so tests are independent of
// each other and of execution order, and leave no residue on failure paths
// short of a process crash mid-test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from '../env.ts';

// Same ordering requirement as server.ts: DATABASE_URL must be in
// process.env before @loyanexa/db's module body runs and constructs its
// PrismaClient — so load .env first, then dynamically import anything that
// touches the database.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnvFile(path.join(__dirname, '../../../.env'));

const { prisma } = await import('../../../packages/db/src/index.ts');
const { applyStamp } = await import('../stamp.ts');

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/** Card.linkCode is a unique Int (32-bit) — pick from a high range unlikely to collide with the app's own sequential counter, which starts at 10000. */
function randomLinkCode(): number {
  return 500_000_000 + Math.floor(Math.random() * 500_000_000);
}

interface Fixture {
  merchantId: string;
  cardId: string;
  serial: string;
  shortCode: string;
}

async function makeFixture(
  opts: { stampsGoal?: number; stamps?: number; lastStampAt?: Date | null; lang?: string } = {}
): Promise<Fixture> {
  const merchant = await prisma.merchant.create({
    data: { subStatus: 'trialing', trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      firebaseUid: `stamp-test-${randomHex(8)}`,
      email: `stamp-test-${randomHex(8)}@example.test`,
      name: 'Stamp Test Merchant',
    },
  });
  const card = await prisma.card.create({
    data: {
      merchantId: merchant.id,
      slot: 1,
      linkCode: randomLinkCode(),
      shortCode: `C${randomHex(4)}`.toUpperCase(),
      name: 'Stamp Test Card',
      stampsGoal: opts.stampsGoal ?? 8,
      bgColor: '#203757',
      fgColor: '#FFFFFF',
      stampActive: '#F96400',
      stampInactive: '#8794A5',
      rewardText: 'Free coffee',
      ...(opts.lang !== undefined ? { lang: opts.lang } : {}),
    },
  });
  const pass = await prisma.pass.create({
    data: {
      serial: `TESTSER${randomHex(6)}`.toUpperCase(),
      shortCode: `P${randomHex(4)}`.toUpperCase(),
      cardId: card.id,
      merchantId: merchant.id,
      authToken: randomHex(12),
      stamps: opts.stamps ?? 0,
      lastStampAt: opts.lastStampAt === undefined ? null : opts.lastStampAt,
    },
  });
  return { merchantId: merchant.id, cardId: card.id, serial: pass.serial, shortCode: pass.shortCode };
}

/** Merchant.delete cascades to Card then Pass then Device (schema.prisma onDelete: Cascade); StampEvent has no FK, so it's cleaned up explicitly first. */
async function cleanup(fx: Fixture): Promise<void> {
  await prisma.stampEvent.deleteMany({ where: { cardId: fx.cardId } });
  await prisma.merchant.delete({ where: { id: fx.merchantId } });
}

test('a first stamp increments stamps/totalStamps and writes a STAMP event', async () => {
  const fx = await makeFixture({ stampsGoal: 8, stamps: 2 });
  try {
    const outcome = await applyStamp(fx.serial, fx.merchantId);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.stamps, 3);
    assert.equal(outcome.goal, 8);
    assert.equal(outcome.totalStamps, 1);
    assert.equal(outcome.rewardEarned, false);

    const pass = await prisma.pass.findUniqueOrThrow({ where: { serial: fx.serial } });
    assert.equal(pass.stamps, 3);
    assert.equal(pass.totalStamps, 1);
    assert.ok(pass.lastStampAt, 'lastStampAt should be set');

    const events = await prisma.stampEvent.findMany({ where: { cardId: fx.cardId, kind: 'STAMP' } });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.serial, fx.serial);
    assert.equal(events[0]?.source, 'browser');
  } finally {
    await cleanup(fx);
  }
});

// ---------------------------------------------------------------------------
// staffId (BUILD.md §8.13's fraud story: "who did what"). Owner-recorded
// stamps carry staffId: null; staff-recorded ones carry the real id.
// ---------------------------------------------------------------------------

test('StampEvent.staffId is null when applyStamp is called with no staffId (the owner stamped)', async () => {
  const fx = await makeFixture({ stampsGoal: 8, stamps: 2 });
  try {
    const outcome = await applyStamp(fx.serial, fx.merchantId);
    assert.equal(outcome.ok, true);

    const event = await prisma.stampEvent.findFirstOrThrow({ where: { cardId: fx.cardId, kind: 'STAMP' } });
    assert.equal(event.staffId, null);
  } finally {
    await cleanup(fx);
  }
});

test('StampEvent.staffId is populated when applyStamp is called with a staffId (a staff member stamped)', async () => {
  const fx = await makeFixture({ stampsGoal: 8, stamps: 2 });
  const staff = await prisma.staff.create({
    data: { merchantId: fx.merchantId, name: 'Test Staff', pinHash: 'scrypt$1$1$1$00$00' },
  });
  try {
    const outcome = await applyStamp(fx.serial, fx.merchantId, 'browser', staff.id);
    assert.equal(outcome.ok, true);

    const event = await prisma.stampEvent.findFirstOrThrow({ where: { cardId: fx.cardId, kind: 'STAMP' } });
    assert.equal(event.staffId, staff.id);
  } finally {
    await cleanup(fx);
  }
});

test('the REWARD event also carries staffId when a staff member\'s stamp completes the goal', async () => {
  const fx = await makeFixture({ stampsGoal: 3, stamps: 2 });
  const staff = await prisma.staff.create({
    data: { merchantId: fx.merchantId, name: 'Test Staff', pinHash: 'scrypt$1$1$1$00$00' },
  });
  try {
    const outcome = await applyStamp(fx.serial, fx.merchantId, 'browser', staff.id);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.rewardEarned, true);

    const rewardEvent = await prisma.stampEvent.findFirstOrThrow({ where: { cardId: fx.cardId, kind: 'REWARD' } });
    assert.equal(rewardEvent.staffId, staff.id);
  } finally {
    await cleanup(fx);
  }
});

test('a second stamp within 24 hours is rejected (too_soon) and does not change stamps', async () => {
  const fx = await makeFixture({ stampsGoal: 8, stamps: 1 });
  try {
    const first = await applyStamp(fx.serial, fx.merchantId);
    assert.equal(first.ok, true);

    const second = await applyStamp(fx.serial, fx.merchantId);
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.equal(second.reason, 'too_soon');

    // The count after the rejected attempt must match the count right
    // after the first stamp — not merely "the request was rejected".
    const pass = await prisma.pass.findUniqueOrThrow({ where: { serial: fx.serial } });
    assert.equal(pass.stamps, 2); // 1 (starting) + 1 (first stamp only)
    assert.equal(pass.totalStamps, 1);

    const events = await prisma.stampEvent.findMany({ where: { cardId: fx.cardId } });
    assert.equal(events.length, 1, 'the rejected second attempt must write nothing');
  } finally {
    await cleanup(fx);
  }
});

test('a stamp after 24 hours have passed succeeds', async () => {
  const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
  const fx = await makeFixture({ stampsGoal: 8, stamps: 3, lastStampAt: twentyFiveHoursAgo });
  try {
    const outcome = await applyStamp(fx.serial, fx.merchantId);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.stamps, 4);

    const pass = await prisma.pass.findUniqueOrThrow({ where: { serial: fx.serial } });
    assert.equal(pass.stamps, 4);
    assert.ok(pass.lastStampAt);
    assert.ok(pass.lastStampAt && pass.lastStampAt.getTime() > twentyFiveHoursAgo.getTime());
  } finally {
    await cleanup(fx);
  }
});

test('reaching the goal increments rewards, resets stamps to 0, and writes a REWARD event', async () => {
  const fx = await makeFixture({ stampsGoal: 5, stamps: 4 });
  try {
    const outcome = await applyStamp(fx.serial, fx.merchantId);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.stamps, 0);
    assert.equal(outcome.rewards, 1);
    assert.equal(outcome.rewardEarned, true);

    const pass = await prisma.pass.findUniqueOrThrow({ where: { serial: fx.serial } });
    assert.equal(pass.stamps, 0);
    assert.equal(pass.rewards, 1);
    assert.equal(pass.totalStamps, 1);

    const stampEvents = await prisma.stampEvent.findMany({ where: { cardId: fx.cardId, kind: 'STAMP' } });
    const rewardEvents = await prisma.stampEvent.findMany({ where: { cardId: fx.cardId, kind: 'REWARD' } });
    assert.equal(stampEvents.length, 1);
    assert.equal(rewardEvents.length, 1);
    assert.equal(rewardEvents[0]?.serial, fx.serial);
  } finally {
    await cleanup(fx);
  }
});

test('an unknown serial or short code 404s (not_found), with no side effects', async () => {
  const fx = await makeFixture();
  try {
    const bogus = `NOPE${randomHex(8)}`.toUpperCase();
    const outcome = await applyStamp(bogus, fx.merchantId);
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.reason, 'not_found');
  } finally {
    await cleanup(fx);
  }
});

test('the manual-entry shortCode resolves the same pass as the QR-encoded serial', async () => {
  const fx = await makeFixture({ stampsGoal: 8, stamps: 0 });
  try {
    const outcome = await applyStamp(fx.shortCode, fx.merchantId);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.serial, fx.serial);
    assert.equal(outcome.stamps, 1);
  } finally {
    await cleanup(fx);
  }
});

test('a pass belonging to a different merchant is not_found — a merchant cannot stamp another merchant\'s pass, by serial or by short code', async () => {
  const owner = await makeFixture({ stampsGoal: 8, stamps: 2 });
  const intruder = await makeFixture({ stampsGoal: 8, stamps: 0 });
  try {
    const bySerial = await applyStamp(owner.serial, intruder.merchantId);
    assert.equal(bySerial.ok, false);
    if (!bySerial.ok) assert.equal(bySerial.reason, 'not_found');

    const byShortCode = await applyStamp(owner.shortCode, intruder.merchantId);
    assert.equal(byShortCode.ok, false);
    if (!byShortCode.ok) assert.equal(byShortCode.reason, 'not_found');

    // Nothing about the owner's pass changed as a side effect of the attempts.
    const pass = await prisma.pass.findUniqueOrThrow({ where: { serial: owner.serial } });
    assert.equal(pass.stamps, 2);
    assert.equal(pass.totalStamps, 0);
  } finally {
    await cleanup(owner);
    await cleanup(intruder);
  }
});

// ---------------------------------------------------------------------------
// StampOutcome.lang (BUILD.md §13) — carries the stamped card's own
// language so server.ts's live-update fan-out (pushPassUpdate ->
// pushGoogleWalletUpdate) can localise the Google Wallet balance PATCH
// without a second database read. This was the one stamp-time surface
// still hardcoding Western digits regardless of card.lang before this
// change (docs/COPY.md §5's own "known follow-up, not fixed this pass").
// ---------------------------------------------------------------------------

test('a successful stamp\'s outcome carries the card\'s own language, coerced from Card.lang', async () => {
  const en = await makeFixture({ lang: 'en' });
  const ar = await makeFixture({ lang: 'ar' });
  try {
    const enOutcome = await applyStamp(en.serial, en.merchantId);
    assert.equal(enOutcome.ok, true);
    if (enOutcome.ok) assert.equal(enOutcome.lang, 'en');

    const arOutcome = await applyStamp(ar.serial, ar.merchantId);
    assert.equal(arOutcome.ok, true);
    if (arOutcome.ok) assert.equal(arOutcome.lang, 'ar');
  } finally {
    await cleanup(en);
    await cleanup(ar);
  }
});
