// apps/demo/test/staffAuth.test.ts — staff session lifecycle
// (apps/demo/staffAuth.ts): create/delete/resolve, expiry, and the
// deactivate-cuts-off-an-existing-session rule. Same convention as
// apps/demo/test/auth.test.ts, against the real local Postgres, no HTTP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from '../env.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnvFile(path.join(__dirname, '../../../.env'));

const { prisma } = await import('../../../packages/db/src/index.ts');
const {
  createStaffSession,
  deleteStaffSession,
  getStaffForSession,
  STAFF_SESSION_COOKIE_NAME,
} = await import('../staffAuth.ts');
const { createStaff, setStaffActive } = await import('../staff.ts');

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

async function makeMerchantWithStaff(): Promise<{ merchantId: string; staffId: string }> {
  const merchant = await prisma.merchant.create({
    data: { email: `staffauth-test-${randomHex(8)}@example.test`, name: 'Staff Auth Test Merchant' },
  });
  const staff = await createStaff(merchant.id, 'Test Staff', '1234');
  return { merchantId: merchant.id, staffId: staff.id };
}

async function cleanup(merchantId: string): Promise<void> {
  await prisma.merchant.delete({ where: { id: merchantId } }).catch(() => {});
}

test('STAFF_SESSION_COOKIE_NAME differs from the merchant session cookie name', () => {
  assert.equal(STAFF_SESSION_COOKIE_NAME, 'lnx-staff');
});

test('createStaffSession + getStaffForSession round-trip to the right staff and merchant', async () => {
  const { merchantId, staffId } = await makeMerchantWithStaff();
  try {
    const session = await createStaffSession(staffId, merchantId);
    const resolved = await getStaffForSession(session.id);
    assert.ok(resolved);
    assert.equal(resolved?.staff.id, staffId);
    assert.equal(resolved?.merchant.id, merchantId);
  } finally {
    await cleanup(merchantId);
  }
});

test('getStaffForSession returns null for a missing/unknown/undefined session id', async () => {
  assert.equal(await getStaffForSession(undefined), null);
  assert.equal(await getStaffForSession(`not-a-real-id-${randomHex(8)}`), null);
});

test('deleteStaffSession invalidates the session server-side — reusing the id afterward resolves to null', async () => {
  const { merchantId, staffId } = await makeMerchantWithStaff();
  try {
    const session = await createStaffSession(staffId, merchantId);
    assert.ok(await getStaffForSession(session.id));

    await deleteStaffSession(session.id);
    assert.equal(await getStaffForSession(session.id), null);
  } finally {
    await cleanup(merchantId);
  }
});

test('deleteStaffSession never throws on an already-gone id', async () => {
  await assert.doesNotReject(() => deleteStaffSession(`never-existed-${randomHex(8)}`));
});

test('an expired session resolves to null and is best-effort cleaned up', async () => {
  const { merchantId, staffId } = await makeMerchantWithStaff();
  try {
    const id = crypto.randomBytes(32).toString('base64url');
    await prisma.staffSession.create({
      data: { id, staffId, merchantId, expiresAt: new Date(Date.now() - 1000) },
    });
    const resolved = await getStaffForSession(id);
    assert.equal(resolved, null);
  } finally {
    await cleanup(merchantId);
  }
});

test('deactivating staff cuts off an already-open session immediately, not just new sign-ins', async () => {
  const { merchantId, staffId } = await makeMerchantWithStaff();
  try {
    const session = await createStaffSession(staffId, merchantId);
    assert.ok(await getStaffForSession(session.id), 'session must resolve while staff is active');

    await setStaffActive(staffId, merchantId, false);

    const resolved = await getStaffForSession(session.id);
    assert.equal(resolved, null, 'a deactivated staff member\'s existing session must stop resolving, not just block new PIN sign-ins');
  } finally {
    await cleanup(merchantId);
  }
});
