// apps/demo/test/staff.test.ts — apps/demo/staff.ts's pure(ish) staff
// account logic: PIN validation/hashing, CRUD, and findStaffByPin. Same
// convention as cardEdit.test.ts / stamp.test.ts: exercises the module
// directly against the real local Postgres, no HTTP.

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
  validatePin,
  generatePin,
  hashPin,
  verifyPin,
  createStaff,
  listStaff,
  setStaffActive,
  deleteStaff,
  findStaffByPin,
  MIN_PIN_LENGTH,
  MAX_PIN_LENGTH,
} = await import('../staff.ts');

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

async function makeMerchant(): Promise<{ id: string; email: string }> {
  const email = `staff-test-${randomHex(8)}@example.test`;
  const merchant = await prisma.merchant.create({ data: { email, name: 'Staff Test Merchant' } });
  return { id: merchant.id, email };
}

async function cleanupMerchant(merchantId: string): Promise<void> {
  await prisma.merchant.delete({ where: { id: merchantId } }).catch(() => {});
}

// ---------------------------------------------------------------------------
// validatePin / generatePin
// ---------------------------------------------------------------------------

test('validatePin accepts exactly 4-6 ASCII digits, nothing else', () => {
  assert.equal(validatePin('1234').ok, true);
  assert.equal(validatePin('123456').ok, true);
  assert.equal(validatePin('12345').ok, true);
  assert.equal(validatePin('123').ok, false, 'too short');
  assert.equal(validatePin('1234567').ok, false, 'too long');
  assert.equal(validatePin('12a4').ok, false, 'letters');
  assert.equal(validatePin('12.4').ok, false, 'punctuation');
  assert.equal(validatePin('').ok, false, 'empty');
  assert.equal(validatePin(' 1234').ok, false, 'leading whitespace');
  assert.equal(validatePin('+1234').ok, false, 'a leading sign must not sneak past a numeric-looking check');
});

test('MIN_PIN_LENGTH/MAX_PIN_LENGTH are 4 and 6, per the job brief', () => {
  assert.equal(MIN_PIN_LENGTH, 4);
  assert.equal(MAX_PIN_LENGTH, 6);
});

test('generatePin() produces a valid, all-digit PIN of the requested length, and differs across calls', () => {
  const a = generatePin();
  const b = generatePin();
  assert.equal(validatePin(a).ok, true);
  assert.equal(a.length, MAX_PIN_LENGTH);
  assert.match(a, /^[0-9]+$/);
  assert.notEqual(a, b, 'two generated PINs should not collide in a small sample (astronomically unlikely if they do)');

  const short = generatePin(4);
  assert.equal(short.length, 4);
  assert.equal(validatePin(short).ok, true);
});

// ---------------------------------------------------------------------------
// hashPin / verifyPin — thin wrappers over auth.ts's scrypt hashPassword/verifyPassword.
// ---------------------------------------------------------------------------

test('hashPin never stores the PIN in plain text, and verifyPin round-trips correctly', () => {
  const hash = hashPin('1234');
  assert.ok(!hash.includes('1234'), 'the raw PIN must never appear inside its own hash');
  assert.match(hash, /^scrypt\$/, 'must use the same scrypt encoding as password hashing');
  assert.equal(verifyPin('1234', hash), true);
  assert.equal(verifyPin('4321', hash), false);
});

// ---------------------------------------------------------------------------
// CRUD — createStaff / listStaff / setStaffActive / deleteStaff, all scoped
// to merchantId.
// ---------------------------------------------------------------------------

test('createStaff + listStaff round-trip, PIN hashed not plain, active by default', async () => {
  const merchant = await makeMerchant();
  try {
    const staff = await createStaff(merchant.id, 'Aisha', '1234');
    assert.equal(staff.name, 'Aisha');
    assert.equal(staff.active, true);
    assert.notEqual(staff.pinHash, '1234');

    const list = await listStaff(merchant.id);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.id, staff.id);
  } finally {
    await cleanupMerchant(merchant.id);
  }
});

test('setStaffActive scoped to merchantId: toggling another merchant\'s staff id does nothing and returns null', async () => {
  const owner = await makeMerchant();
  const attacker = await makeMerchant();
  try {
    const staff = await createStaff(owner.id, 'Bilal', '1234');

    const result = await setStaffActive(staff.id, attacker.id, false);
    assert.equal(result, null, 'a staff id belonging to a different merchant must resolve to null, never mutate');

    const after = await prisma.staff.findUniqueOrThrow({ where: { id: staff.id } });
    assert.equal(after.active, true, "the real owner's staff row must be untouched by the attacker's call");

    const legit = await setStaffActive(staff.id, owner.id, false);
    assert.ok(legit);
    assert.equal(legit?.active, false);
  } finally {
    await cleanupMerchant(owner.id);
    await cleanupMerchant(attacker.id);
  }
});

test('deleteStaff scoped to merchantId: returns false and deletes nothing for another merchant\'s staff id', async () => {
  const owner = await makeMerchant();
  const attacker = await makeMerchant();
  try {
    const staff = await createStaff(owner.id, 'Carla', '1234');

    const attackerResult = await deleteStaff(staff.id, attacker.id);
    assert.equal(attackerResult, false);
    assert.ok(await prisma.staff.findUnique({ where: { id: staff.id } }), 'must still exist');

    const legit = await deleteStaff(staff.id, owner.id);
    assert.equal(legit, true);
    assert.equal(await prisma.staff.findUnique({ where: { id: staff.id } }), null);
  } finally {
    await cleanupMerchant(owner.id);
    await cleanupMerchant(attacker.id);
  }
});

// ---------------------------------------------------------------------------
// findStaffByPin — the PIN-login resolver.
// ---------------------------------------------------------------------------

test('findStaffByPin resolves the (merchant, staff) pair for a correct email + PIN', async () => {
  const merchant = await makeMerchant();
  try {
    const staff = await createStaff(merchant.id, 'Dana', '5678');
    const result = await findStaffByPin(merchant.email, '5678');
    assert.ok(result);
    assert.equal(result?.merchant.id, merchant.id);
    assert.equal(result?.staff.id, staff.id);
  } finally {
    await cleanupMerchant(merchant.id);
  }
});

test('findStaffByPin is case/whitespace-insensitive on email, matching normalizeEmail', async () => {
  const merchant = await makeMerchant();
  try {
    await createStaff(merchant.id, 'Eve', '5678');
    const result = await findStaffByPin(`  ${merchant.email.toUpperCase()}  `, '5678');
    assert.ok(result, 'email lookup must normalise the same way sign-in does');
  } finally {
    await cleanupMerchant(merchant.id);
  }
});

test('findStaffByPin returns null for an unknown business email', async () => {
  const result = await findStaffByPin(`no-such-merchant-${randomHex(8)}@example.test`, '1234');
  assert.equal(result, null);
});

test('findStaffByPin returns null for the wrong PIN', async () => {
  const merchant = await makeMerchant();
  try {
    await createStaff(merchant.id, 'Fahd', '5678');
    const result = await findStaffByPin(merchant.email, '0000');
    assert.equal(result, null);
  } finally {
    await cleanupMerchant(merchant.id);
  }
});

test('findStaffByPin never matches a deactivated staff member\'s PIN, even though it is otherwise correct', async () => {
  const merchant = await makeMerchant();
  try {
    const staff = await createStaff(merchant.id, 'Ghada', '5678');
    await setStaffActive(staff.id, merchant.id, false);

    const result = await findStaffByPin(merchant.email, '5678');
    assert.equal(result, null, "a deactivated staff member's PIN must not open a new session");
  } finally {
    await cleanupMerchant(merchant.id);
  }
});

test('findStaffByPin distinguishes between multiple staff on the same merchant by PIN', async () => {
  const merchant = await makeMerchant();
  try {
    const a = await createStaff(merchant.id, 'Staff A', '1111');
    const b = await createStaff(merchant.id, 'Staff B', '2222');

    const resultA = await findStaffByPin(merchant.email, '1111');
    assert.equal(resultA?.staff.id, a.id);

    const resultB = await findStaffByPin(merchant.email, '2222');
    assert.equal(resultB?.staff.id, b.id);
  } finally {
    await cleanupMerchant(merchant.id);
  }
});
