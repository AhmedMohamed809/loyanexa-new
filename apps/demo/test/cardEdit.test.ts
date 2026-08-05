// apps/demo/cardEdit.ts — the lock rule (BUILD.md §8.7): once any customer
// has joined a card, its economics (stamps required, starter stamps,
// reward details, expiry type/days/date) freeze; aesthetics (name,
// colours, images, text) stay editable forever. Enforced server-side, not
// just in the UI — this is the test the job explicitly calls out as the
// one most likely to be quietly skipped. Same fixture/cleanup pattern as
// apps/demo/test/stamp.test.ts: real local Postgres, no mocks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from '../env.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnvFile(path.join(__dirname, '../../../.env'));

const { prisma } = await import('../../../packages/db/src/index.ts');
const { updateCard, activateCard, passCountForCard } = await import('../cardEdit.ts');

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

function randomLinkCode(): number {
  return 500_000_000 + Math.floor(Math.random() * 500_000_000);
}

interface Fixture {
  merchantId: string;
  cardId: string;
}

async function makeFixture(): Promise<Fixture> {
  const merchant = await prisma.merchant.create({
    data: { subStatus: 'trialing', trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      firebaseUid: `cardedit-test-${randomHex(8)}`,
      email: `cardedit-test-${randomHex(8)}@example.test`,
      name: 'Card Edit Test Merchant',
    },
  });
  const card = await prisma.card.create({
    data: {
      merchantId: merchant.id,
      slot: 1,
      linkCode: randomLinkCode(),
      shortCode: `C${randomHex(4)}`.toUpperCase(),
      name: 'Card Edit Test Card',
      stampsGoal: 8,
      starterStamps: 0,
      bgColor: '#203757',
      fgColor: '#FFFFFF',
      stampActive: '#F96400',
      stampInactive: '#8794A5',
      rewardText: 'Free coffee',
      expiryType: 'unlimited',
    },
  });
  return { merchantId: merchant.id, cardId: card.id };
}

async function addPass(fx: Fixture): Promise<void> {
  await prisma.pass.create({
    data: {
      serial: `TESTSER${randomHex(6)}`.toUpperCase(),
      shortCode: `P${randomHex(4)}`.toUpperCase(),
      cardId: fx.cardId,
      merchantId: fx.merchantId,
      authToken: randomHex(12),
    },
  });
}

async function cleanup(fx: Fixture): Promise<void> {
  await prisma.stampEvent.deleteMany({ where: { cardId: fx.cardId } });
  await prisma.merchant.delete({ where: { id: fx.merchantId } });
}

test('before any customer joins, an economic edit is allowed', async () => {
  const fx = await makeFixture();
  try {
    assert.equal(await passCountForCard(fx.cardId), 0);
    const result = await updateCard(fx.cardId, fx.merchantId, { stampsGoal: 12 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.card.stampsGoal, 12);
  } finally {
    await cleanup(fx);
  }
});

test('once a pass exists, an economic edit is rejected and the database value is unchanged', async () => {
  const fx = await makeFixture();
  try {
    await addPass(fx);
    assert.equal(await passCountForCard(fx.cardId), 1);

    const before = await prisma.card.findUniqueOrThrow({ where: { id: fx.cardId } });
    assert.equal(before.stampsGoal, 8);

    const result = await updateCard(fx.cardId, fx.merchantId, { stampsGoal: 20 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'locked');
    assert.deepEqual(result.lockedFields, ['stampsGoal']);
    assert.equal(result.passCount, 1);

    const after = await prisma.card.findUniqueOrThrow({ where: { id: fx.cardId } });
    assert.equal(after.stampsGoal, 8, 'a rejected edit must leave the database untouched');
  } finally {
    await cleanup(fx);
  }
});

test('every economic field is locked once a pass exists: starterStamps, rewardText, expiryType, expiryDays, expiryDate', async () => {
  const fx = await makeFixture();
  try {
    await addPass(fx);

    const attempts: Array<[string, Parameters<typeof updateCard>[2]]> = [
      ['starterStamps', { starterStamps: 3 }],
      ['rewardText', { rewardText: 'Free cake instead' }],
      ['expiryType', { expiryType: 'duration' }],
      ['expiryDays', { expiryDays: 30 }],
      ['expiryDate', { expiryDate: new Date('2027-01-01') }],
    ];
    for (const [label, patch] of attempts) {
      const result = await updateCard(fx.cardId, fx.merchantId, patch);
      assert.equal(result.ok, false, `${label} should be locked`);
      if (result.ok) continue;
      assert.equal(result.reason, 'locked');
    }

    const after = await prisma.card.findUniqueOrThrow({ where: { id: fx.cardId } });
    assert.equal(after.starterStamps, 0);
    assert.equal(after.rewardText, 'Free coffee');
    assert.equal(after.expiryType, 'unlimited');
    assert.equal(after.expiryDays, null);
    assert.equal(after.expiryDate, null);
  } finally {
    await cleanup(fx);
  }
});

test('once a pass exists, a cosmetic edit still succeeds', async () => {
  const fx = await makeFixture();
  try {
    await addPass(fx);

    const result = await updateCard(fx.cardId, fx.merchantId, {
      name: 'Renamed Bakery',
      bgColor: '#111111',
      stampActive: '#00FF00',
      labelStamps: 'Punches',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.card.name, 'Renamed Bakery');
    assert.equal(result.card.bgColor, '#111111');
    assert.equal(result.card.stampActive, '#00FF00');
    assert.equal(result.card.labelStamps, 'Punches');

    const after = await prisma.card.findUniqueOrThrow({ where: { id: fx.cardId } });
    assert.equal(after.name, 'Renamed Bakery');
  } finally {
    await cleanup(fx);
  }
});

test('editing images on a card that already has passes succeeds (they are cosmetic), while editing stampsGoal still returns 409', async () => {
  const fx = await makeFixture();
  try {
    await addPass(fx);

    const imageResult = await updateCard(fx.cardId, fx.merchantId, {
      iconHash: 'a'.repeat(64),
      iconUrl: `/img/${'a'.repeat(64)}`,
      coverHash: 'b'.repeat(64),
      coverUrl: `/img/${'b'.repeat(64)}`,
      stampSource: 'icon',
      stampShape: 'square',
      bgOpacity: 0.5,
    });
    assert.equal(imageResult.ok, true, 'image/design edits must succeed on a locked card');
    if (!imageResult.ok) return;
    assert.equal(imageResult.card.iconHash, 'a'.repeat(64));
    assert.equal(imageResult.card.coverHash, 'b'.repeat(64));
    assert.equal(imageResult.card.stampSource, 'icon');
    assert.equal(imageResult.card.stampShape, 'square');
    assert.equal(imageResult.card.bgOpacity, 0.5);

    const goalResult = await updateCard(fx.cardId, fx.merchantId, { stampsGoal: 15 });
    assert.equal(goalResult.ok, false, 'stampsGoal must still be locked on the very same card');
    if (goalResult.ok) return;
    assert.equal(goalResult.reason, 'locked');

    const after = await prisma.card.findUniqueOrThrow({ where: { id: fx.cardId } });
    assert.equal(after.iconHash, 'a'.repeat(64), 'the successful image edit must persist');
    assert.equal(after.stampsGoal, 8, 'the rejected economic edit must leave stampsGoal untouched');
  } finally {
    await cleanup(fx);
  }
});

test('a mixed patch (cosmetic + economic) is rejected wholesale once a pass exists — nothing is written, not even the cosmetic part', async () => {
  const fx = await makeFixture();
  try {
    await addPass(fx);

    const result = await updateCard(fx.cardId, fx.merchantId, { name: 'Should not apply', stampsGoal: 99 });
    assert.equal(result.ok, false);

    const after = await prisma.card.findUniqueOrThrow({ where: { id: fx.cardId } });
    assert.equal(after.name, 'Card Edit Test Card', 'the cosmetic half of a locked patch must not be applied either');
    assert.equal(after.stampsGoal, 8);
  } finally {
    await cleanup(fx);
  }
});

test('a mixed patch (lang + economic) is also rejected wholesale — a language change in the same request as a locked field does not sneak through', async () => {
  const fx = await makeFixture();
  try {
    await addPass(fx);

    const result = await updateCard(fx.cardId, fx.merchantId, { lang: 'en', stampsGoal: 99 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'locked');
    assert.deepEqual(result.lockedFields, ['stampsGoal']);

    const after = await prisma.card.findUniqueOrThrow({ where: { id: fx.cardId } });
    assert.equal(after.lang, 'ar', 'the lang half of a locked patch must not be applied either — this is a wholesale rejection, not a partial one');
    assert.equal(after.stampsGoal, 8);
  } finally {
    await cleanup(fx);
  }
});

test('re-submitting the same economic value a card already has is not an "attempt to change" and is allowed', async () => {
  const fx = await makeFixture();
  try {
    await addPass(fx);
    const result = await updateCard(fx.cardId, fx.merchantId, { stampsGoal: 8, name: 'Same Goal Renamed' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.card.stampsGoal, 8);
    assert.equal(result.card.name, 'Same Goal Renamed');
  } finally {
    await cleanup(fx);
  }
});

test("editing a card's colours bumps Card.updatedAt — this is what lets the .pkpass cache key (apps/demo/pkpassCache.ts) invalidate on a design edit", async () => {
  const fx = await makeFixture();
  try {
    const before = await prisma.card.findUniqueOrThrow({ where: { id: fx.cardId } });

    // Prisma's @updatedAt has millisecond resolution — make sure this test
    // can't land in the same millisecond as row creation and get a false
    // pass.
    await new Promise((r) => setTimeout(r, 5));

    const result = await updateCard(fx.cardId, fx.merchantId, { bgColor: '#ABCDEF' });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.ok(
      result.card.updatedAt.getTime() > before.updatedAt.getTime(),
      'updateCard must bump Card.updatedAt on every write, including an aesthetic-only edit'
    );

    const after = await prisma.card.findUniqueOrThrow({ where: { id: fx.cardId } });
    assert.equal(after.updatedAt.getTime(), result.card.updatedAt.getTime());
  } finally {
    await cleanup(fx);
  }
});

// ---------------------------------------------------------------------------
// Card language (BUILD.md §8.5 step 3 / §8.9) — a presentation field, not
// an economic one: 'lang' lives in AESTHETIC_FIELDS, so it must behave
// exactly like the images/colours cases above — always editable, even once
// a pass exists — while stampsGoal on the very same card stays locked.
// ---------------------------------------------------------------------------

test('changing lang on a card that already has passes succeeds (it is a presentation field), while stampsGoal on the very same card still returns 409', async () => {
  const fx = await makeFixture();
  try {
    await addPass(fx);

    const langResult = await updateCard(fx.cardId, fx.merchantId, { lang: 'en' });
    assert.equal(langResult.ok, true, 'a language edit must succeed on a card that already has passes');
    if (!langResult.ok) return;
    assert.equal(langResult.card.lang, 'en');

    const goalResult = await updateCard(fx.cardId, fx.merchantId, { stampsGoal: 15 });
    assert.equal(goalResult.ok, false, 'stampsGoal must still be locked on the very same card');
    if (goalResult.ok) return;
    assert.equal(goalResult.reason, 'locked');
    assert.deepEqual(goalResult.lockedFields, ['stampsGoal']);

    const after = await prisma.card.findUniqueOrThrow({ where: { id: fx.cardId } });
    assert.equal(after.lang, 'en', 'the successful language edit must persist');
    assert.equal(after.stampsGoal, 8, 'the rejected economic edit must leave stampsGoal untouched');
  } finally {
    await cleanup(fx);
  }
});

test('setting lang bumps Card.updatedAt (invalidates the .pkpass cache key, same as any other design edit) — this is what pushes a language change to already-issued passes', async () => {
  const fx = await makeFixture();
  try {
    const before = await prisma.card.findUniqueOrThrow({ where: { id: fx.cardId } });
    await new Promise((r) => setTimeout(r, 5));

    const result = await updateCard(fx.cardId, fx.merchantId, { lang: 'en' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(
      result.card.updatedAt.getTime() > before.updatedAt.getTime(),
      'a lang-only edit must still bump Card.updatedAt'
    );
  } finally {
    await cleanup(fx);
  }
});

// ---------------------------------------------------------------------------
// Location reminders (BUILD.md §9.4/§9.1) — 'locations' is an
// AESTHETIC_FIELDS entry: always editable, even once a pass exists, and
// every write bumps Card.updatedAt exactly like any other design edit —
// which is what invalidates the .pkpass cache and (server.ts's
// pushCardUpdate) pushes the new geofence to already-issued passes.
// ---------------------------------------------------------------------------

test('locations round-trips through updateCard and is never locked, even once a pass exists', async () => {
  const fx = await makeFixture();
  try {
    await addPass(fx);

    const locations = [
      { name: 'Downtown branch', latitude: 24.7136, longitude: 46.6753 },
      { name: 'Mall branch', latitude: 21.5433, longitude: 39.1728, relevantText: 'Come say hi at the mall!' },
    ];
    const result = await updateCard(fx.cardId, fx.merchantId, { locations });
    assert.equal(result.ok, true, 'locations must be editable even on a locked (has-passes) card');
    if (!result.ok) return;
    assert.deepEqual(result.card.locations, locations);

    const after = await prisma.card.findUniqueOrThrow({ where: { id: fx.cardId } });
    assert.deepEqual(after.locations, locations, 'the write must persist to Postgres');
  } finally {
    await cleanup(fx);
  }
});

test('setting locations bumps Card.updatedAt (invalidates the .pkpass cache key, same as any other design edit)', async () => {
  const fx = await makeFixture();
  try {
    const before = await prisma.card.findUniqueOrThrow({ where: { id: fx.cardId } });
    await new Promise((r) => setTimeout(r, 5));

    const result = await updateCard(fx.cardId, fx.merchantId, {
      locations: [{ name: 'HQ', latitude: 24.7136, longitude: 46.6753 }],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(
      result.card.updatedAt.getTime() > before.updatedAt.getTime(),
      'a locations-only edit must still bump Card.updatedAt'
    );
  } finally {
    await cleanup(fx);
  }
});

test('activateCard sets active = true', async () => {
  const fx = await makeFixture();
  try {
    const before = await prisma.card.findUniqueOrThrow({ where: { id: fx.cardId } });
    assert.equal(before.active, false);

    const result = await activateCard(fx.cardId, fx.merchantId);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.card.active, true);

    const after = await prisma.card.findUniqueOrThrow({ where: { id: fx.cardId } });
    assert.equal(after.active, true);
  } finally {
    await cleanup(fx);
  }
});

test('updateCard on an unknown card id returns not_found', async () => {
  const fx = await makeFixture();
  try {
    const result = await updateCard('nonexistent-card-id', fx.merchantId, { name: 'X' });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'not_found');
  } finally {
    await cleanup(fx);
  }
});

test('activateCard on an unknown card id returns not_found', async () => {
  const fx = await makeFixture();
  try {
    const result = await activateCard('nonexistent-card-id', fx.merchantId);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'not_found');
  } finally {
    await cleanup(fx);
  }
});

test('updateCard and activateCard return not_found (never the real card) for a card id that belongs to a different merchant', async () => {
  const owner = await makeFixture();
  const intruder = await makeFixture();
  try {
    const updateResult = await updateCard(owner.cardId, intruder.merchantId, { name: 'Hijacked' });
    assert.equal(updateResult.ok, false);
    if (!updateResult.ok) assert.equal(updateResult.reason, 'not_found');

    const activateResult = await activateCard(owner.cardId, intruder.merchantId);
    assert.equal(activateResult.ok, false);
    if (!activateResult.ok) assert.equal(activateResult.reason, 'not_found');

    const after = await prisma.card.findUniqueOrThrow({ where: { id: owner.cardId } });
    assert.equal(after.name, 'Card Edit Test Card', 'the owner\'s card must be completely untouched by another merchant\'s attempt');
    assert.equal(after.active, false);
  } finally {
    await cleanup(owner);
    await cleanup(intruder);
  }
});
