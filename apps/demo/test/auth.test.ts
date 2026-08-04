// apps/demo/test/auth.test.ts — apps/demo/auth.ts's own unit tests: password
// hashing/verification, the password policy, and the session lifecycle
// against the real local Postgres (no mocks, same convention as
// cardEdit.test.ts / stamp.test.ts). HTTP-level sign-up/sign-in/sign-out and
// cross-merchant scoping are covered separately (authHttp.test.ts /
// scoping.test.ts) — this file is the pure logic underneath them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';

import { loadEnvFile } from '../env.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnvFile(path.join(__dirname, '../../../.env'));

const { prisma } = await import('../../../packages/db/src/index.ts');
const {
  hashPassword,
  verifyPassword,
  validatePassword,
  MIN_PASSWORD_LENGTH,
  createSession,
  deleteSession,
  getMerchantForSession,
  setSessionCookie,
  clearSessionCookie,
  readCookie,
  sessionIdFromRequest,
  normalizeEmail,
  SESSION_COOKIE_NAME,
} = await import('../auth.ts');

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

async function makeMerchant(): Promise<{ id: string }> {
  const merchant = await prisma.merchant.create({
    data: { email: `auth-test-${randomHex(8)}@example.test`, name: 'Auth Test Merchant' },
  });
  return { id: merchant.id };
}

async function cleanupMerchant(merchantId: string): Promise<void> {
  await prisma.merchant.delete({ where: { id: merchantId } }).catch(() => {});
}

// ---------------------------------------------------------------------------
// hashPassword / verifyPassword
// ---------------------------------------------------------------------------

test('hashPassword output never contains the plaintext password and round-trips through verifyPassword', () => {
  const password = 'correct horse battery staple';
  const hash = hashPassword(password);
  assert.ok(!hash.includes(password), 'the stored hash must never contain the plaintext password');
  assert.match(hash, /^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]+\$[0-9a-f]+$/, 'expected the scrypt$N$r$p$salt$hash shape');
  assert.equal(verifyPassword(password, hash), true);
});

test('verifyPassword rejects a wrong password', () => {
  const hash = hashPassword('the-real-password-123');
  assert.equal(verifyPassword('a-completely-different-password', hash), false);
});

test('two hashes of the same password are different (random salt) and both verify', () => {
  const password = 'same password twice over';
  const a = hashPassword(password);
  const b = hashPassword(password);
  assert.notEqual(a, b, 'a fresh random salt must make repeat hashes of the same password differ');
  assert.equal(verifyPassword(password, a), true);
  assert.equal(verifyPassword(password, b), true);
});

test('verifyPassword rejects a tampered hash (flipped hex character) rather than throwing', () => {
  const hash = hashPassword('some password here');
  const tampered = hash.slice(0, -1) + (hash.endsWith('0') ? '1' : '0');
  assert.equal(verifyPassword('some password here', tampered), false);
});

test('verifyPassword rejects malformed stored values instead of throwing', () => {
  for (const bad of ['', 'not-a-hash-at-all', 'scrypt$only$three$parts', 'md5$1$1$1$aa$bb', 'scrypt$abc$8$1$aa$bb']) {
    assert.doesNotThrow(() => verifyPassword('whatever', bad));
    assert.equal(verifyPassword('whatever', bad), false, `expected "${bad}" to fail verification, not throw`);
  }
});

// ---------------------------------------------------------------------------
// validatePassword — length and the common-password blocklist
// ---------------------------------------------------------------------------

test(`validatePassword rejects passwords under ${MIN_PASSWORD_LENGTH} characters`, () => {
  const result = validatePassword('short1');
  assert.deepEqual(result, { ok: false, reason: 'too_short' });
});

test('validatePassword accepts a long-enough, non-common password', () => {
  assert.deepEqual(validatePassword('correct horse battery staple 42'), { ok: true });
});

test('validatePassword rejects common passwords case-insensitively even when long enough', () => {
  assert.deepEqual(validatePassword('Password123'), { ok: false, reason: 'too_common' });
  assert.deepEqual(validatePassword('WELCOME123'), { ok: false, reason: 'too_common' });
});

test('validatePassword requires exactly MIN_PASSWORD_LENGTH characters to pass the length check', () => {
  const exact = 'x'.repeat(MIN_PASSWORD_LENGTH);
  const oneShort = 'x'.repeat(MIN_PASSWORD_LENGTH - 1);
  assert.deepEqual(validatePassword(exact), { ok: true });
  assert.deepEqual(validatePassword(oneShort), { ok: false, reason: 'too_short' });
});

// ---------------------------------------------------------------------------
// Sessions — real Postgres round trip
// ---------------------------------------------------------------------------

test('createSession persists a row that getMerchantForSession resolves back to the right merchant', async () => {
  const { id: merchantId } = await makeMerchant();
  try {
    const session = await createSession(merchantId);
    assert.ok(session.id.length > 20, 'expected a long, random session id');
    assert.ok(session.expiresAt.getTime() > Date.now(), 'expected a future expiry');

    const resolved = await getMerchantForSession(session.id);
    assert.ok(resolved, 'expected the session to resolve to a merchant');
    assert.equal(resolved!.id, merchantId);
  } finally {
    await cleanupMerchant(merchantId);
  }
});

test('getMerchantForSession returns null for an unknown session id', async () => {
  const resolved = await getMerchantForSession(`nonexistent-${randomHex(16)}`);
  assert.equal(resolved, null);
});

test('getMerchantForSession returns null for undefined (no cookie presented)', async () => {
  const resolved = await getMerchantForSession(undefined);
  assert.equal(resolved, null);
});

test('deleteSession invalidates the session server-side: the same id no longer resolves to a merchant', async () => {
  const { id: merchantId } = await makeMerchant();
  try {
    const session = await createSession(merchantId);
    assert.ok(await getMerchantForSession(session.id));

    await deleteSession(session.id);

    const afterDelete = await getMerchantForSession(session.id);
    assert.equal(afterDelete, null, 'a deleted session id must never resolve to a merchant again');

    const row = await prisma.session.findUnique({ where: { id: session.id } });
    assert.equal(row, null, 'the Session row itself must be gone, not just unresolvable');
  } finally {
    await cleanupMerchant(merchantId);
  }
});

test('deleteSession on an already-deleted / unknown id does not throw', async () => {
  await assert.doesNotReject(deleteSession(`already-gone-${randomHex(16)}`));
});

test('an expired session resolves to null even though its row still exists at read time', async () => {
  const { id: merchantId } = await makeMerchant();
  try {
    const id = `expired-${randomHex(16)}`;
    await prisma.session.create({ data: { id, merchantId, expiresAt: new Date(Date.now() - 1000) } });

    const resolved = await getMerchantForSession(id);
    assert.equal(resolved, null, 'an expired session must not resolve to a merchant');
  } finally {
    await cleanupMerchant(merchantId);
  }
});

test('two sessions created for the same merchant (rotation on login) get distinct ids and both work until one is deleted', async () => {
  const { id: merchantId } = await makeMerchant();
  try {
    const first = await createSession(merchantId);
    const second = await createSession(merchantId);
    assert.notEqual(first.id, second.id);

    await deleteSession(first.id);
    assert.equal(await getMerchantForSession(first.id), null);
    const stillGood = await getMerchantForSession(second.id);
    assert.ok(stillGood, 'the second, still-live session must be unaffected by deleting the first');
  } finally {
    await cleanupMerchant(merchantId);
  }
});

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

function fakeReq(cookieHeader: string | undefined): { headers: { cookie: string | undefined } } {
  return { headers: { cookie: cookieHeader } };
}

test('readCookie extracts a named cookie among several, and returns undefined when absent', () => {
  const req = fakeReq('lnx-lang=en; lnx-session=abc123; other=1');
  assert.equal(readCookie(req as never, 'lnx-session'), 'abc123');
  assert.equal(readCookie(req as never, 'lnx-lang'), 'en');
  assert.equal(readCookie(req as never, 'missing'), undefined);
  assert.equal(readCookie(fakeReq(undefined) as never, 'lnx-session'), undefined);
});

test('sessionIdFromRequest reads the lnx-session cookie specifically', () => {
  const req = fakeReq(`${SESSION_COOKIE_NAME}=the-session-id; lnx-lang=ar`);
  assert.equal(sessionIdFromRequest(req as never), 'the-session-id');
});

function fakeRes(): { headers: string[]; getHeader: ServerResponse['getHeader']; setHeader: ServerResponse['setHeader'] } {
  const state: { value: string | string[] | undefined } = { value: undefined };
  return {
    headers: [],
    getHeader: ((name: string) => (name.toLowerCase() === 'set-cookie' ? state.value : undefined)) as ServerResponse['getHeader'],
    setHeader: ((name: string, value: string | string[]) => {
      if (name.toLowerCase() === 'set-cookie') state.value = value;
      return undefined as unknown as ServerResponse;
    }) as ServerResponse['setHeader'],
  };
}

test('setSessionCookie sets HttpOnly, Secure, SameSite=Lax and the session id', () => {
  const res = fakeRes();
  setSessionCookie(res as unknown as ServerResponse, { id: 'sess-123', expiresAt: new Date('2030-01-01T00:00:00Z') });
  const cookie = String(res.getHeader('Set-Cookie'));
  assert.match(cookie, /^lnx-session=sess-123;/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Expires=/);
});

test('clearSessionCookie expires the cookie immediately (Max-Age=0)', () => {
  const res = fakeRes();
  clearSessionCookie(res as unknown as ServerResponse);
  const cookie = String(res.getHeader('Set-Cookie'));
  assert.match(cookie, /^lnx-session=;/);
  assert.match(cookie, /Max-Age=0/);
});

// ---------------------------------------------------------------------------
// normalizeEmail
// ---------------------------------------------------------------------------

test('normalizeEmail lowercases and trims', () => {
  assert.equal(normalizeEmail('  Ahmed@Example.COM  '), 'ahmed@example.com');
});
