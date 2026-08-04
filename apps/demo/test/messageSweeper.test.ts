// apps/demo/test/messageSweeper.test.ts — apps/demo/messageSweeper.ts
// (sub-project 9, "ephemeral notifications"). Real local Postgres, no
// mocks — `sendOne` is always a stub injected by each test; this file
// never constructs an ApnsClient and never touches Apple's servers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from '../env.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnvFile(path.join(__dirname, '../../../.env'));

const { prisma } = await import('../../../packages/db/src/index.ts');
const { MessageSweeper } = await import('../messageSweeper.ts');

type SendPushOutcome = { ok: true } | { ok: false; gone?: boolean; error?: string };
type Device = { deviceId: string; passSerial: string; pushToken: string };

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

async function makeMerchantAndCard(): Promise<Fixture> {
  const merchant = await prisma.merchant.create({
    data: { email: `messagesweeper-test-${randomHex(8)}@example.test`, name: 'Message Sweeper Test Merchant' },
  });
  const card = await prisma.card.create({
    data: {
      merchantId: merchant.id,
      slot: 1,
      linkCode: randomLinkCode(),
      shortCode: `C${randomHex(4)}`.toUpperCase(),
      name: 'Message Sweeper Test Card',
      stampsGoal: 8,
      bgColor: '#203757',
      fgColor: '#FFFFFF',
      stampActive: '#F96400',
      stampInactive: '#8794A5',
      rewardText: 'Free coffee',
      active: true,
    },
  });
  return { merchantId: merchant.id, cardId: card.id };
}

/** Creates a Pass carrying an already-delivered broadcast message, with `deviceCount` registered devices, expiring at `messageExpiresAt`. */
async function addExpiringPass(
  fx: Fixture,
  messageExpiresAt: Date | null,
  deviceCount = 1,
  message = 'Half price today!'
): Promise<string> {
  const serial = `TESTSER${randomHex(6)}`.toUpperCase();
  await prisma.pass.create({
    data: {
      serial,
      shortCode: `P${randomHex(4)}`.toUpperCase(),
      cardId: fx.cardId,
      merchantId: fx.merchantId,
      authToken: randomHex(12),
      message,
      messageExpiresAt,
    },
  });
  for (let i = 0; i < deviceCount; i++) {
    await prisma.device.create({
      data: { deviceId: `dev-${randomHex(8)}`, passSerial: serial, pushToken: `token-${randomHex(16)}` },
    });
  }
  return serial;
}

async function cleanup(fx: Fixture): Promise<void> {
  await prisma.merchant.delete({ where: { id: fx.merchantId } }).catch(() => {});
}

/** A sendOne stub that always succeeds and records every call it received, keyed by pushToken. */
function makeRecordingSender(): { sendOne: (device: Device) => Promise<SendPushOutcome>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    sendOne: async (device: Device) => {
      calls.push(device.pushToken);
      return { ok: true };
    },
  };
}

const PAST = new Date(Date.now() - 60_000); // one minute ago — already expired
const FUTURE = new Date(Date.now() + 60 * 60_000); // one hour from now — not yet expired

test('runOnce() clears message/messageExpiresAt on an expired Pass and pushes every one of its devices', async () => {
  const fx = await makeMerchantAndCard();
  try {
    const serial = await addExpiringPass(fx, PAST, 2);
    const { sendOne, calls } = makeRecordingSender();
    const sweeper = new MessageSweeper({ sendOne, pushIntervalMs: 0 });

    const cleared = await sweeper.runOnce();
    assert.equal(cleared, 1);
    assert.equal(calls.length, 2, 'a push per device registered to the expired pass');

    const pass = await prisma.pass.findUniqueOrThrow({ where: { serial } });
    assert.equal(pass.message, '');
    assert.equal(pass.messageExpiresAt, null);
  } finally {
    await cleanup(fx);
  }
});

test('runOnce() sweeps a legacy Pass that has a message but NO expiry — a NULL expiry means expired, not eternal', async () => {
  const fx = await makeMerchantAndCard();
  try {
    // Exactly the shape of a row written before ephemeral notifications
    // existed: a real message, no expiry, because nothing stamped one. The
    // sweeper originally skipped these (WHERE "messageExpiresAt" IS NOT
    // NULL), which left every pre-existing customer pinned to a months-old
    // broadcast forever — the owner's original report.
    const serial = await addExpiringPass(fx, null, 1, 'A months-old broadcast');
    const { sendOne, calls } = makeRecordingSender();
    const sweeper = new MessageSweeper({ sendOne, pushIntervalMs: 0 });

    const cleared = await sweeper.runOnce();
    assert.ok(cleared >= 1, 'the legacy row must be swept, not skipped');
    assert.ok(calls.length >= 1, 'and its device pushed, so the phone drops the stale field');

    const pass = await prisma.pass.findUniqueOrThrow({ where: { serial } });
    assert.equal(pass.message, '', 'the stale message is gone from the row');
    assert.equal(pass.messageExpiresAt, null);
  } finally {
    await cleanup(fx);
  }
});

test('runOnce() leaves a Pass whose messageExpiresAt is still in the future untouched, and pushes nothing for it', async () => {
  const fx = await makeMerchantAndCard();
  try {
    const serial = await addExpiringPass(fx, FUTURE, 1);
    const { sendOne, calls } = makeRecordingSender();
    const sweeper = new MessageSweeper({ sendOne, pushIntervalMs: 0 });

    const cleared = await sweeper.runOnce();
    assert.equal(cleared, 0);
    assert.equal(calls.length, 0);

    const pass = await prisma.pass.findUniqueOrThrow({ where: { serial } });
    assert.equal(pass.message, 'Half price today!', 'unexpired message must be left exactly as it was');
    assert.ok(pass.messageExpiresAt);
  } finally {
    await cleanup(fx);
  }
});

test('runOnce() never touches a Pass with no active message (messageExpiresAt === null)', async () => {
  const fx = await makeMerchantAndCard();
  try {
    const serial = await addExpiringPass(fx, null, 1, '');
    const { sendOne, calls } = makeRecordingSender();
    const sweeper = new MessageSweeper({ sendOne, pushIntervalMs: 0 });

    const cleared = await sweeper.runOnce();
    assert.equal(cleared, 0);
    assert.equal(calls.length, 0);

    const pass = await prisma.pass.findUniqueOrThrow({ where: { serial } });
    assert.equal(pass.message, '');
  } finally {
    await cleanup(fx);
  }
});

test('runOnce() clears several expired passes across different merchants in one cycle, but caps at batchSize', async () => {
  const fx1 = await makeMerchantAndCard();
  const fx2 = await makeMerchantAndCard();
  try {
    const serials = await Promise.all([
      addExpiringPass(fx1, PAST, 1),
      addExpiringPass(fx1, PAST, 1),
      addExpiringPass(fx2, PAST, 1),
    ]);
    const { sendOne, calls } = makeRecordingSender();
    const sweeper = new MessageSweeper({ sendOne, batchSize: 2, pushIntervalMs: 0 });

    const firstCycle = await sweeper.runOnce();
    assert.equal(firstCycle, 2, 'a batch never clears more than batchSize rows in one cycle');
    assert.equal(calls.length, 2);

    const secondCycle = await sweeper.runOnce();
    assert.equal(secondCycle, 1, 'the remaining expired row is picked up on the next cycle');

    for (const serial of serials) {
      const pass = await prisma.pass.findUniqueOrThrow({ where: { serial } });
      assert.equal(pass.message, '');
      assert.equal(pass.messageExpiresAt, null);
    }
  } finally {
    await cleanup(fx1);
    await cleanup(fx2);
  }
});

test('a 410 Gone push result deletes the Device row, and the Pass is still cleared', async () => {
  const fx = await makeMerchantAndCard();
  try {
    const serial = await addExpiringPass(fx, PAST, 1);
    const sweeper = new MessageSweeper({
      sendOne: async () => ({ ok: false, gone: true }),
      pushIntervalMs: 0,
    });

    await sweeper.runOnce();

    const devices = await prisma.device.findMany({ where: { passSerial: serial } });
    assert.equal(devices.length, 0, '410 Gone must prune the Device row');

    const pass = await prisma.pass.findUniqueOrThrow({ where: { serial } });
    assert.equal(pass.message, '');
  } finally {
    await cleanup(fx);
  }
});

test('a Pass with no registered devices is still cleared — nothing to push to, but the clear itself does not depend on it', async () => {
  const fx = await makeMerchantAndCard();
  try {
    const serial = await addExpiringPass(fx, PAST, 0);
    const { sendOne, calls } = makeRecordingSender();
    const sweeper = new MessageSweeper({ sendOne, pushIntervalMs: 0 });

    const cleared = await sweeper.runOnce();
    assert.equal(cleared, 1);
    assert.equal(calls.length, 0);

    const pass = await prisma.pass.findUniqueOrThrow({ where: { serial } });
    assert.equal(pass.message, '');
  } finally {
    await cleanup(fx);
  }
});

test('start() then stop() clears expired passes and leaves no dangling timer', async () => {
  const fx = await makeMerchantAndCard();
  try {
    await addExpiringPass(fx, PAST, 1);
    const { sendOne, calls } = makeRecordingSender();
    const sweeper = new MessageSweeper({ sendOne, pushIntervalMs: 0, pollIntervalMs: 10 });

    sweeper.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await sweeper.stop();

    assert.ok(calls.length >= 1, 'the interval loop must have run at least one cycle');
  } finally {
    await cleanup(fx);
  }
});
