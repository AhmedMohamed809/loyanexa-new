// apps/demo/cardPush.ts — the card-edit live-update push (BUILD.md §9.3,
// the "also" fix alongside the `.pkpass` cache-key regression: a design
// edit used to trigger no push at all, so an existing pass only picked up
// the new design on a device's next unprompted poll). Same
// fixture/cleanup pattern as apps/demo/test/cardEdit.test.ts: real local
// Postgres, no mocks — the one thing deliberately faked is `sendOne`
// itself, so this file never constructs an ApnsClient and never touches
// Apple's servers (the job's own "do not send any push to Apple from a
// test" constraint).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from '../env.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnvFile(path.join(__dirname, '../../../.env'));

const { prisma } = await import('../../../packages/db/src/index.ts');
const { devicesForCard, pushCardDevices } = await import('../cardPush.ts');

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

async function makeCard(): Promise<Fixture> {
  const merchant = await prisma.merchant.create({
    data: {
      firebaseUid: `cardpush-test-${randomHex(8)}`,
      email: `cardpush-test-${randomHex(8)}@example.test`,
      name: 'Card Push Test Merchant',
    },
  });
  const card = await prisma.card.create({
    data: {
      merchantId: merchant.id,
      slot: 1,
      linkCode: randomLinkCode(),
      shortCode: `C${randomHex(4)}`.toUpperCase(),
      name: 'Card Push Test Card',
      stampsGoal: 8,
      bgColor: '#203757',
      fgColor: '#FFFFFF',
      stampActive: '#F96400',
      stampInactive: '#8794A5',
      rewardText: 'Free coffee',
    },
  });
  return { merchantId: merchant.id, cardId: card.id };
}

async function addPassWithDevice(cardId: string, merchantId: string): Promise<{ serial: string; pushToken: string; deviceId: string }> {
  const serial = `TESTSER${randomHex(6)}`.toUpperCase();
  await prisma.pass.create({
    data: {
      serial,
      shortCode: `P${randomHex(4)}`.toUpperCase(),
      cardId,
      merchantId,
      authToken: randomHex(12),
    },
  });
  const deviceId = `dev-${randomHex(8)}`;
  const pushToken = `token-${randomHex(16)}`;
  await prisma.device.create({ data: { deviceId, passSerial: serial, pushToken } });
  return { serial, pushToken, deviceId };
}

async function cleanup(fx: Fixture): Promise<void> {
  await prisma.stampEvent.deleteMany({ where: { cardId: fx.cardId } });
  await prisma.merchant.delete({ where: { id: fx.merchantId } });
}

test('devicesForCard returns exactly the devices registered for that card\'s passes, not another card\'s', async () => {
  const cardA = await makeCard();
  const cardB = await makeCard();
  try {
    const devA1 = await addPassWithDevice(cardA.cardId, cardA.merchantId);
    const devA2 = await addPassWithDevice(cardA.cardId, cardA.merchantId);
    const devB1 = await addPassWithDevice(cardB.cardId, cardB.merchantId);

    const devices = await devicesForCard(cardA.cardId);
    const tokens = devices.map((d) => d.pushToken).sort();
    assert.deepEqual(tokens, [devA1.pushToken, devA2.pushToken].sort());
    assert.ok(!tokens.includes(devB1.pushToken), 'a device registered for another card must never be included');
  } finally {
    await cleanup(cardA);
    await cleanup(cardB);
  }
});

test('devicesForCard returns an empty list for a card with no passes', async () => {
  const fx = await makeCard();
  try {
    assert.deepEqual(await devicesForCard(fx.cardId), []);
  } finally {
    await cleanup(fx);
  }
});

test('pushCardDevices calls the push function once per device registered for the card, with the right tokens, and touches no other card', async () => {
  const cardA = await makeCard();
  const cardB = await makeCard();
  try {
    const devA1 = await addPassWithDevice(cardA.cardId, cardA.merchantId);
    const devA2 = await addPassWithDevice(cardA.cardId, cardA.merchantId);
    const devB1 = await addPassWithDevice(cardB.cardId, cardB.merchantId);

    const calls: Array<{ deviceId: string; pushToken: string }> = [];
    await pushCardDevices(cardA.cardId, async (device) => {
      calls.push({ deviceId: device.deviceId, pushToken: device.pushToken });
      return { ok: true };
    });

    assert.equal(calls.length, 2, 'exactly the two devices registered under card A must be pushed');
    const pushedTokens = calls.map((c) => c.pushToken).sort();
    assert.deepEqual(pushedTokens, [devA1.pushToken, devA2.pushToken].sort());
    assert.ok(
      !calls.some((c) => c.pushToken === devB1.pushToken),
      'a device registered under a different card must never be pushed'
    );
  } finally {
    await cleanup(cardA);
    await cleanup(cardB);
  }
});

test('pushCardDevices prunes a device whose push comes back "gone", and leaves the others alone', async () => {
  const fx = await makeCard();
  try {
    const goneDevice = await addPassWithDevice(fx.cardId, fx.merchantId);
    const okDevice = await addPassWithDevice(fx.cardId, fx.merchantId);

    await pushCardDevices(fx.cardId, async (device) => {
      if (device.deviceId === goneDevice.deviceId) return { ok: false, gone: true };
      return { ok: true };
    });

    const remaining = await devicesForCard(fx.cardId);
    const remainingIds = remaining.map((d) => d.deviceId);
    assert.ok(!remainingIds.includes(goneDevice.deviceId), 'a "gone" device must be pruned');
    assert.ok(remainingIds.includes(okDevice.deviceId), 'a device that was not reported gone must remain registered');
  } finally {
    await cleanup(fx);
  }
});

test('pushCardDevices never calls the push function when the card has no devices', async () => {
  const fx = await makeCard();
  try {
    let calls = 0;
    await pushCardDevices(fx.cardId, async () => {
      calls++;
      return { ok: true };
    });
    assert.equal(calls, 0);
  } finally {
    await cleanup(fx);
  }
});
