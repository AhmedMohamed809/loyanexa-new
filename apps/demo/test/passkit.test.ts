// apps/demo/test/passkit.test.ts — apps/demo/passkit.ts (BUILD.md §9.3, §12).
// Exercises the four PassKit web-service endpoints' DB logic against the
// real local Postgres (no mocks), same pattern as stamp.test.ts: every test
// creates its own Merchant/Card/Pass rows with randomised identifiers and
// deletes them afterwards in a `finally`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from '../env.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnvFile(path.join(__dirname, '../../../.env'));

const { prisma } = await import('../../../packages/db/src/index.ts');
const { isValidPassAuth, registerDevice, getUpdatedSerials, unregisterDevice, getPassForDownload } =
  await import('../passkit.ts');

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

function randomLinkCode(): number {
  return 500_000_000 + Math.floor(Math.random() * 500_000_000);
}

interface Fixture {
  merchantId: string;
  cardId: string;
  serial: string;
  authToken: string;
}

async function makeFixture(): Promise<Fixture> {
  const merchant = await prisma.merchant.create({
    data: { subStatus: 'trialing', trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      firebaseUid: `passkit-test-${randomHex(8)}`,
      email: `passkit-test-${randomHex(8)}@example.test`,
      name: 'PassKit Test Merchant',
    },
  });
  const card = await prisma.card.create({
    data: {
      merchantId: merchant.id,
      slot: 1,
      linkCode: randomLinkCode(),
      shortCode: `C${randomHex(4)}`.toUpperCase(),
      name: 'PassKit Test Card',
      stampsGoal: 8,
      bgColor: '#203757',
      fgColor: '#FFFFFF',
      stampActive: '#F96400',
      stampInactive: '#8794A5',
      rewardText: 'Free coffee',
    },
  });
  const authToken = randomHex(16);
  const pass = await prisma.pass.create({
    data: {
      serial: `TESTSER${randomHex(6)}`.toUpperCase(),
      shortCode: `P${randomHex(4)}`.toUpperCase(),
      cardId: card.id,
      merchantId: merchant.id,
      authToken,
    },
  });
  return { merchantId: merchant.id, cardId: card.id, serial: pass.serial, authToken };
}

/** Merchant.delete cascades to Card -> Pass -> Device (schema.prisma onDelete: Cascade). */
async function cleanup(fx: Fixture): Promise<void> {
  await prisma.stampEvent.deleteMany({ where: { cardId: fx.cardId } });
  await prisma.merchant.delete({ where: { id: fx.merchantId } });
}

test('isValidPassAuth rejects a wrong token and accepts the right one', () => {
  assert.equal(isValidPassAuth(undefined, 'secret'), false);
  assert.equal(isValidPassAuth('Bearer secret', 'secret'), false, 'must be the ApplePass scheme, not Bearer');
  assert.equal(isValidPassAuth('ApplePass wrong', 'secret'), false);
  assert.equal(isValidPassAuth('ApplePass secre', 'secret'), false, 'a shorter wrong token must not match');
  assert.equal(isValidPassAuth('ApplePass secrets', 'secret'), false, 'a longer wrong token must not match');
  assert.equal(isValidPassAuth('ApplePass secret', 'secret'), true);
});

test('registerDevice 401s on a wrong token and 404s on an unknown serial', async () => {
  const fx = await makeFixture();
  try {
    const wrongToken = await registerDevice({
      deviceId: 'dev-1',
      serial: fx.serial,
      authHeader: 'ApplePass not-the-token',
      pushToken: 'push-token-1',
    });
    assert.deepEqual(wrongToken, { status: 401 });

    const unknownSerial = await registerDevice({
      deviceId: 'dev-1',
      serial: `NOPE${randomHex(8)}`.toUpperCase(),
      authHeader: `ApplePass ${fx.authToken}`,
      pushToken: 'push-token-1',
    });
    assert.deepEqual(unknownSerial, { status: 404 });

    const devices = await prisma.device.findMany({ where: { passSerial: fx.serial } });
    assert.equal(devices.length, 0, 'a rejected registration must create no Device row');
  } finally {
    await cleanup(fx);
  }
});

test('registerDevice returns 201 the first time, 200 the second, and creates exactly one Device row', async () => {
  const fx = await makeFixture();
  try {
    const first = await registerDevice({
      deviceId: 'dev-first',
      serial: fx.serial,
      authHeader: `ApplePass ${fx.authToken}`,
      pushToken: 'push-token-original',
    });
    assert.deepEqual(first, { status: 201 });

    const second = await registerDevice({
      deviceId: 'dev-first',
      serial: fx.serial,
      authHeader: `ApplePass ${fx.authToken}`,
      pushToken: 'push-token-updated',
    });
    assert.deepEqual(second, { status: 200 });

    const devices = await prisma.device.findMany({ where: { passSerial: fx.serial } });
    assert.equal(devices.length, 1, 'registering twice must upsert, not duplicate, the Device row');
    assert.equal(devices[0]?.deviceId, 'dev-first');
    assert.equal(devices[0]?.pushToken, 'push-token-updated', 'the second call must refresh the push token');
  } finally {
    await cleanup(fx);
  }
});

test('getUpdatedSerials 404s for an unknown device, needs NO auth header, 204s when nothing changed, and returns the serial when it did', async () => {
  const fx = await makeFixture();
  try {
    const unknownDevice = await getUpdatedSerials({
      deviceId: 'never-registered',
      passesUpdatedSince: undefined,
    });
    assert.deepEqual(unknownDevice, { status: 404 });

    const registered = await registerDevice({
      deviceId: 'dev-serials',
      serial: fx.serial,
      authHeader: `ApplePass ${fx.authToken}`,
      pushToken: 'push-token-serials',
    });
    assert.equal(registered.status, 201);

    // Regression guard. Apple sends NO Authorization header to this endpoint.
    // Requiring one made every real iPhone receive a 401 and silently stop
    // updating, which is indistinguishable from the push never arriving.
    // If this ever starts returning 401 again, live pass updates are broken.
    const noAuthHeader = await getUpdatedSerials({
      deviceId: 'dev-serials',
      passesUpdatedSince: undefined,
    });
    assert.equal(
      noAuthHeader.status,
      200,
      'get-serial-numbers must succeed without an Authorization header'
    );

    // No `passesUpdatedSince` — everything registered for this device counts as "changed".
    const initial = await getUpdatedSerials({
      deviceId: 'dev-serials',
      passesUpdatedSince: undefined,
    });
    assert.equal(initial.status, 200);
    if (initial.status !== 200) return;
    assert.deepEqual(initial.body.serialNumbers, [fx.serial]);
    assert.equal(typeof initial.body.lastUpdated, 'string');

    // Asking again "since" a point in the future — nothing changed since then.
    const future = new Date(Date.now() + 60_000).toISOString();
    const nothingChanged = await getUpdatedSerials({
      deviceId: 'dev-serials',
      passesUpdatedSince: future,
    });
    assert.deepEqual(nothingChanged, { status: 204 });

    // Actually touch the pass, then ask "since" a point before that change.
    const justBefore = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await prisma.pass.update({ where: { serial: fx.serial }, data: { stamps: { increment: 1 } } });

    const changed = await getUpdatedSerials({
      deviceId: 'dev-serials',
      passesUpdatedSince: justBefore,
    });
    assert.equal(changed.status, 200);
    if (changed.status !== 200) return;
    assert.deepEqual(changed.body.serialNumbers, [fx.serial]);
  } finally {
    await cleanup(fx);
  }
});

test('unregisterDevice 404s for an unknown serial, 401s on a wrong token, and removes the Device row on success', async () => {
  const fx = await makeFixture();
  try {
    const registered = await registerDevice({
      deviceId: 'dev-unreg',
      serial: fx.serial,
      authHeader: `ApplePass ${fx.authToken}`,
      pushToken: 'push-token-unreg',
    });
    assert.equal(registered.status, 201);

    const unknownSerial = await unregisterDevice({
      deviceId: 'dev-unreg',
      serial: `NOPE${randomHex(8)}`.toUpperCase(),
      authHeader: `ApplePass ${fx.authToken}`,
    });
    assert.deepEqual(unknownSerial, { status: 404 });

    const wrongToken = await unregisterDevice({
      deviceId: 'dev-unreg',
      serial: fx.serial,
      authHeader: 'ApplePass wrong-token',
    });
    assert.deepEqual(wrongToken, { status: 401 });

    let devices = await prisma.device.findMany({ where: { passSerial: fx.serial } });
    assert.equal(devices.length, 1, 'a failed unregister attempt must not remove the row');

    const ok = await unregisterDevice({
      deviceId: 'dev-unreg',
      serial: fx.serial,
      authHeader: `ApplePass ${fx.authToken}`,
    });
    assert.deepEqual(ok, { status: 200 });

    devices = await prisma.device.findMany({ where: { passSerial: fx.serial } });
    assert.equal(devices.length, 0);
  } finally {
    await cleanup(fx);
  }
});

test('getPassForDownload 401s on a missing or malformed Authorization header before ever looking up the serial — even for a serial that does not exist', async () => {
  const unknownSerial = `NOPE${randomHex(8)}`.toUpperCase();

  const missing = await getPassForDownload({
    serial: unknownSerial,
    authHeader: undefined,
    ifModifiedSince: undefined,
  });
  assert.deepEqual(missing, { status: 401 }, 'a missing header must 401, not 404, even for an unknown serial');

  const wrongScheme = await getPassForDownload({
    serial: unknownSerial,
    authHeader: 'Bearer whatever',
    ifModifiedSince: undefined,
  });
  assert.deepEqual(wrongScheme, { status: 401 }, 'a malformed header (wrong scheme) must also 401 before the lookup');

  const noToken = await getPassForDownload({
    serial: unknownSerial,
    authHeader: 'ApplePass',
    ifModifiedSince: undefined,
  });
  assert.deepEqual(noToken, { status: 401 }, '"ApplePass" with no trailing space/token is malformed too');
});

test('getPassForDownload 404s for an unknown serial, 401s on a wrong token, 304s when unmodified, and 200s with the pass when modified', async () => {
  const fx = await makeFixture();
  try {
    const unknownSerial = await getPassForDownload({
      serial: `NOPE${randomHex(8)}`.toUpperCase(),
      authHeader: `ApplePass ${fx.authToken}`,
      ifModifiedSince: undefined,
    });
    assert.deepEqual(unknownSerial, { status: 404 });

    const wrongToken = await getPassForDownload({
      serial: fx.serial,
      authHeader: 'ApplePass wrong-token',
      ifModifiedSince: undefined,
    });
    assert.deepEqual(wrongToken, { status: 401 });

    const fresh = await getPassForDownload({
      serial: fx.serial,
      authHeader: `ApplePass ${fx.authToken}`,
      ifModifiedSince: undefined,
    });
    assert.equal(fresh.status, 200);
    if (fresh.status !== 200) return;
    assert.equal(fresh.pass.serial, fx.serial);
    assert.equal(fresh.pass.card.id, fx.cardId);

    const future = new Date(Date.now() + 60_000).toUTCString();
    const notModified = await getPassForDownload({
      serial: fx.serial,
      authHeader: `ApplePass ${fx.authToken}`,
      ifModifiedSince: future,
    });
    assert.deepEqual(notModified, { status: 304 });
  } finally {
    await cleanup(fx);
  }
});
