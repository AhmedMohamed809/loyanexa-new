// apps/demo/test/enrol.test.ts — createPassForEnrolment() must be
// idempotent per card (BUILD.md §9.6's one-stamp-per-24h rule is enforced
// per *pass*, so minting a new Pass on every enrolment let a customer
// re-enrol and collect the "first stamp of the day" repeatedly — see
// apps/demo/enrol.ts's own doc comment). Exercises the real local Postgres,
// no mocks — same convention as apps/demo/test/stamp.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from '../env.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnvFile(path.join(__dirname, '../../../.env'));

const { prisma } = await import('../../../packages/db/src/index.ts');
const { createPassForEnrolment, isPassExpired, __testing } = await import('../enrol.ts');

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

function randomLinkCode(): number {
  return 500_000_000 + Math.floor(Math.random() * 500_000_000);
}

interface Fixture {
  merchantId: string;
  card: Awaited<ReturnType<typeof prisma.card.create>>;
}

async function makeFixture(opts: { expiryType?: string; expiryDays?: number } = {}): Promise<Fixture> {
  const merchant = await prisma.merchant.create({
    data: { subStatus: 'trialing', trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      firebaseUid: `enrol-test-${randomHex(8)}`,
      email: `enrol-test-${randomHex(8)}@example.test`,
      name: 'Enrol Test Merchant',
    },
  });
  const card = await prisma.card.create({
    data: {
      merchantId: merchant.id,
      slot: 1,
      linkCode: randomLinkCode(),
      shortCode: `C${randomHex(4)}`.toUpperCase(),
      name: 'Enrol Test Card',
      stampsGoal: 8,
      bgColor: '#203757',
      fgColor: '#FFFFFF',
      stampActive: '#F96400',
      stampInactive: '#8794A5',
      rewardText: 'Free coffee',
      ...(opts.expiryType !== undefined ? { expiryType: opts.expiryType } : {}),
      ...(opts.expiryDays !== undefined ? { expiryDays: opts.expiryDays } : {}),
    },
  });
  return { merchantId: merchant.id, card };
}

async function cleanup(fx: Fixture): Promise<void> {
  await prisma.stampEvent.deleteMany({ where: { cardId: fx.card.id } });
  await prisma.merchant.delete({ where: { id: fx.merchantId } });
}

test('two enrolments with the same phone number yield exactly one Pass row', async () => {
  const fx = await makeFixture();
  try {
    const first = await createPassForEnrolment(fx.card, 'Ahmed', '0551234567');
    const second = await createPassForEnrolment(fx.card, 'Ahmed', '0551234567');
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.pass.id, second.pass.id);
    assert.equal(first.pass.serial, second.pass.serial);

    const count = await prisma.pass.count({ where: { cardId: fx.card.id } });
    assert.equal(count, 1, 'exactly one Pass row must exist for this card');
  } finally {
    await cleanup(fx);
  }
});

test('two enrolments with different phone numbers yield two Pass rows', async () => {
  const fx = await makeFixture();
  try {
    const first = await createPassForEnrolment(fx.card, 'Ahmed', '0551111111');
    const second = await createPassForEnrolment(fx.card, 'Sara', '0552222222');
    assert.equal(first.created, true);
    assert.equal(second.created, true);
    assert.notEqual(first.pass.id, second.pass.id);

    const count = await prisma.pass.count({ where: { cardId: fx.card.id } });
    assert.equal(count, 2, 'two distinct customers must get two distinct Pass rows');
  } finally {
    await cleanup(fx);
  }
});

test('no phone and no idempotency key: every call creates its own Pass (unchanged pre-fix behaviour for anonymous enrolment)', async () => {
  const fx = await makeFixture();
  try {
    const first = await createPassForEnrolment(fx.card, '', '');
    const second = await createPassForEnrolment(fx.card, '', '');
    assert.equal(first.created, true);
    assert.equal(second.created, true);
    assert.notEqual(first.pass.id, second.pass.id);
  } finally {
    await cleanup(fx);
  }
});

test('no phone, same idempotency key (the same enrol-page load, e.g. tapping both wallet buttons): reused, not duplicated', async () => {
  const fx = await makeFixture();
  try {
    const token = randomHex(16);
    const first = await createPassForEnrolment(fx.card, '', '', token);
    const second = await createPassForEnrolment(fx.card, '', '', token);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.pass.id, second.pass.id);

    const count = await prisma.pass.count({ where: { cardId: fx.card.id } });
    assert.equal(count, 1);
  } finally {
    await cleanup(fx);
  }
});

test('no phone, different idempotency keys: two distinct Pass rows', async () => {
  const fx = await makeFixture();
  try {
    const first = await createPassForEnrolment(fx.card, '', '', randomHex(16));
    const second = await createPassForEnrolment(fx.card, '', '', randomHex(16));
    assert.notEqual(first.pass.id, second.pass.id);
  } finally {
    await cleanup(fx);
  }
});

test('an idempotency token from one card never matches the same-value token on a different card', async () => {
  const fxA = await makeFixture();
  const fxB = await makeFixture();
  try {
    const token = randomHex(16); // same literal token, deliberately
    const onA = await createPassForEnrolment(fxA.card, '', '', token);
    const onB = await createPassForEnrolment(fxB.card, '', '', token);
    assert.notEqual(onA.pass.cardId, onB.pass.cardId);
    assert.notEqual(onA.pass.id, onB.pass.id);
  } finally {
    await cleanup(fxA);
    await cleanup(fxB);
  }
});

test('the idempotency store itself expires an entry once its TTL has elapsed (injected clock, no real waiting)', () => {
  // Uses the exported store directly with a synthetic key — never touches
  // the database, so it cannot collide with or delete state another test
  // depends on (unlike calling .get() with a future timestamp against a
  // key a DB-backed test still expects to find: that call itself deletes
  // the entry as a side effect of reading it as expired).
  const key = __testing.idempotencyStoreKey('synthetic-card', randomHex(8));
  const t0 = 1_000_000;
  __testing.idempotencyStore.set(key, 'synthetic-pass-id', t0);

  assert.equal(__testing.idempotencyStore.get(key, t0 + 1000), 'synthetic-pass-id', 'well within the TTL, the entry is still found');
  assert.equal(
    __testing.idempotencyStore.get(key, t0 + __testing.IDEMPOTENCY_TTL_MS + 1),
    undefined,
    'past the TTL, the entry must read as gone'
  );
});

test('isPassExpired: unlimited never expires, duration expires after createdAt + days, fixed expires at the fixed date', () => {
  const now = Date.now();
  const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000);

  assert.equal(isPassExpired({ expiryType: 'unlimited', expiryDays: null, expiryDate: null }, { createdAt: tenDaysAgo }), false);
  assert.equal(
    isPassExpired({ expiryType: 'duration', expiryDays: 5, expiryDate: null }, { createdAt: tenDaysAgo }),
    true,
    '5-day expiry on a pass created 10 days ago must read as expired'
  );
  assert.equal(
    isPassExpired({ expiryType: 'duration', expiryDays: 30, expiryDate: null }, { createdAt: tenDaysAgo }),
    false,
    '30-day expiry on a pass created 10 days ago must not read as expired yet'
  );
  assert.equal(
    isPassExpired({ expiryType: 'fixed', expiryDays: null, expiryDate: new Date(now - 1000) }, { createdAt: tenDaysAgo }),
    true
  );
  assert.equal(
    isPassExpired({ expiryType: 'fixed', expiryDays: null, expiryDate: new Date(now + 1000 * 60 * 60) }, { createdAt: tenDaysAgo }),
    false
  );
});

test('a phone match that is expired is not reused — a fresh Pass is created instead', async () => {
  const fx = await makeFixture({ expiryType: 'duration', expiryDays: 1 });
  try {
    const first = await createPassForEnrolment(fx.card, 'Ahmed', '0551234567');
    // Backdate the pass's createdAt to 2 days ago so it reads as expired
    // under the card's 1-day duration rule.
    await prisma.pass.update({
      where: { id: first.pass.id },
      data: { createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) },
    });

    const second = await createPassForEnrolment(fx.card, 'Ahmed', '0551234567');
    assert.equal(second.created, true);
    assert.notEqual(second.pass.id, first.pass.id);

    const count = await prisma.pass.count({ where: { cardId: fx.card.id } });
    assert.equal(count, 2, 'an expired match must not be reused — a new Pass is created alongside it');
  } finally {
    await cleanup(fx);
  }
});

// ---------------------------------------------------------------------------
// Plan capacity (BUILD.md §14). Starter caps customers at 500; the cap must
// block the next *new* customer and never a returning one.
// ---------------------------------------------------------------------------

const { hasCustomerCapacity } = await import('../enrol.ts');

test('an unlimited allowance never blocks, and never counts rows to find that out', async () => {
  const fx = await makeFixture();
  try {
    // Infinity short-circuits before touching the database — a per-enrolment
    // COUNT on every merchant would be paid by the plans that do not need it.
    assert.equal(await hasCustomerCapacity(fx.card, '0550000001', Infinity), true);
  } finally {
    await cleanup(fx);
  }
});

test('a full plan blocks a genuinely new customer', async () => {
  const fx = await makeFixture();
  try {
    await createPassForEnrolment(fx.card, 'First', '0551110001');
    await createPassForEnrolment(fx.card, 'Second', '0551110002');
    // Two passes exist, so a limit of 2 is already reached.
    assert.equal(
      await hasCustomerCapacity(fx.card, '0551110003', 2),
      false,
      'the third customer must be turned away when the plan allows two'
    );
    assert.equal(await hasCustomerCapacity(fx.card, '0551110003', 3), true);
  } finally {
    await cleanup(fx);
  }
});

test('a returning customer is never blocked by a full plan', async () => {
  // The important case. Someone who already holds this card re-adding it to a
  // new phone is not a new customer, and refusing them at the counter over
  // the merchant's plan tier would punish entirely the wrong person.
  const fx = await makeFixture();
  try {
    await createPassForEnrolment(fx.card, 'Regular', '0552220001');
    await createPassForEnrolment(fx.card, 'Another', '0552220002');
    assert.equal(
      await hasCustomerCapacity(fx.card, '0552220001', 1),
      true,
      'the existing holder must still get their card even though the plan is over its cap'
    );
    assert.equal(
      await hasCustomerCapacity(fx.card, '0559990000', 1),
      false,
      'a new number at the same cap is still refused'
    );
  } finally {
    await cleanup(fx);
  }
});

test('the cap counts the whole merchant, not just the one card', async () => {
  // Two cards on one Starter account share the 500 allowance; counting per
  // card would have let a merchant multiply their cap by making more cards.
  const fx = await makeFixture();
  try {
    const second = await prisma.card.create({
      data: {
        merchantId: fx.merchantId,
        slot: 2,
        linkCode: randomLinkCode(),
        shortCode: `D${randomHex(4)}`.toUpperCase(),
        name: 'Second Card',
        stampsGoal: 6,
        bgColor: '#203757',
        fgColor: '#FFFFFF',
        stampActive: '#F96400',
        stampInactive: '#8794A5',
        rewardText: 'Free pastry',
      },
    });
    await createPassForEnrolment(fx.card, 'On card one', '0553330001');
    await createPassForEnrolment(second, 'On card two', '0553330002');
    assert.equal(
      await hasCustomerCapacity(second, '0553330003', 2),
      false,
      'both cards draw on the same merchant allowance'
    );
    await prisma.stampEvent.deleteMany({ where: { cardId: second.id } });
  } finally {
    await cleanup(fx);
  }
});
