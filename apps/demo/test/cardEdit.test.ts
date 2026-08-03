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
    data: {
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
    const result = await updateCard(fx.cardId, { stampsGoal: 12 });
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

    const result = await updateCard(fx.cardId, { stampsGoal: 20 });
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

    const attempts: Array<[string, Parameters<typeof updateCard>[1]]> = [
      ['starterStamps', { starterStamps: 3 }],
      ['rewardText', { rewardText: 'Free cake instead' }],
      ['expiryType', { expiryType: 'duration' }],
      ['expiryDays', { expiryDays: 30 }],
      ['expiryDate', { expiryDate: new Date('2027-01-01') }],
    ];
    for (const [label, patch] of attempts) {
      const result = await updateCard(fx.cardId, patch);
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

    const result = await updateCard(fx.cardId, {
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

test('a mixed patch (cosmetic + economic) is rejected wholesale once a pass exists — nothing is written, not even the cosmetic part', async () => {
  const fx = await makeFixture();
  try {
    await addPass(fx);

    const result = await updateCard(fx.cardId, { name: 'Should not apply', stampsGoal: 99 });
    assert.equal(result.ok, false);

    const after = await prisma.card.findUniqueOrThrow({ where: { id: fx.cardId } });
    assert.equal(after.name, 'Card Edit Test Card', 'the cosmetic half of a locked patch must not be applied either');
    assert.equal(after.stampsGoal, 8);
  } finally {
    await cleanup(fx);
  }
});

test('re-submitting the same economic value a card already has is not an "attempt to change" and is allowed', async () => {
  const fx = await makeFixture();
  try {
    await addPass(fx);
    const result = await updateCard(fx.cardId, { stampsGoal: 8, name: 'Same Goal Renamed' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.card.stampsGoal, 8);
    assert.equal(result.card.name, 'Same Goal Renamed');
  } finally {
    await cleanup(fx);
  }
});

test('activateCard sets active = true', async () => {
  const fx = await makeFixture();
  try {
    const before = await prisma.card.findUniqueOrThrow({ where: { id: fx.cardId } });
    assert.equal(before.active, false);

    const result = await activateCard(fx.cardId);
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
  const result = await updateCard('nonexistent-card-id', { name: 'X' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'not_found');
});

test('activateCard on an unknown card id returns not_found', async () => {
  const result = await activateCard('nonexistent-card-id');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'not_found');
});
