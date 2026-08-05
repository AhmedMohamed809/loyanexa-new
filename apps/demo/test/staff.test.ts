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
  const merchant = await prisma.merchant.create({ data: { subStatus: 'trialing', trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), email, name: 'Staff Test Merchant' } });
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

// ---------------------------------------------------------------------------
// findStaffByPin response time must not scale with staff count. Regression
// guard for a real fix (final whole-branch review): findStaffByPin used to
// verify each active staff member's PIN one at a time with the blocking
// crypto.scryptSync, so a business with N staff configured paid N times the
// scrypt cost of one — both freezing the event loop for that long and
// leaking headcount by timing (an 8-staff business answered ~8x slower than
// an unknown one). The fix checks every candidate concurrently
// (verifyPinAsync + Promise.all), so wall-clock cost should stay close to
// one scrypt op's cost regardless of how many staff there are, not scale
// linearly with the count.
// ---------------------------------------------------------------------------

test('findStaffByPin response time does not scale with staff count (concurrent, non-blocking verification)', async () => {
  const fewStaffMerchant = await makeMerchant();
  const manyStaffMerchant = await makeMerchant();
  try {
    await createStaff(fewStaffMerchant.id, 'Solo', '1111');

    const MANY = 12;
    for (let i = 0; i < MANY; i++) {
      await createStaff(manyStaffMerchant.id, `Staff ${i}`, String(1000 + i));
    }

    const time = async (merchantEmail: string): Promise<number> => {
      const start = performance.now();
      // A PIN that matches nothing on either merchant — every candidate on
      // the many-staff merchant must actually be checked, the worst case
      // the old sequential loop paid in full.
      await findStaffByPin(merchantEmail, '999999');
      return performance.now() - start;
    };

    // A few samples each, averaged, to smooth out single-call noise.
    const fewTimes: number[] = [];
    const manyTimes: number[] = [];
    for (let i = 0; i < 3; i++) {
      fewTimes.push(await time(fewStaffMerchant.email));
      manyTimes.push(await time(manyStaffMerchant.email));
    }
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const fewAvg = avg(fewTimes);
    const manyAvg = avg(manyTimes);

    // The old sequential/blocking code would put this ratio at roughly
    // MANY (12x) — every extra staff member added one full scrypt op in
    // series. A generous threshold (well under 12x, floor 20ms) stays
    // robust under CI/local load noise while still catching a regression
    // back to the sequential form.
    const ratio = Math.max(fewAvg, manyAvg) / Math.max(20, Math.min(fewAvg, manyAvg));
    assert.ok(
      ratio < 6,
      `expected a ${MANY}-staff merchant to answer roughly as fast as a 1-staff merchant, not scale with headcount; got ${fewAvg.toFixed(1)}ms vs ${manyAvg.toFixed(1)}ms (ratio ${ratio.toFixed(1)}x)`
    );
  } finally {
    await cleanupMerchant(fewStaffMerchant.id);
    await cleanupMerchant(manyStaffMerchant.id);
  }
});
