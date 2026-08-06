// apps/demo/test/authHttp.test.ts — the sign-up/sign-in/sign-out HTTP flow
// (BUILD.md §8.1/§8.2), and proof that every route BUILD.md's job brief
// lists as "must keep working with no session" actually does. Spawns the
// real server as a child process against the real local Postgres, same
// convention as httpIntegration.test.ts / scoping.test.ts.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import { loadEnvFile } from '../env.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
loadEnvFile(path.join(ROOT, '.env'));

const { prisma } = await import('../../../packages/db/src/index.ts');

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}
function randomLinkCode(): number {
  return 500_000_000 + Math.floor(Math.random() * 500_000_000);
}
function randomPort(): number {
  return 46000 + Math.floor(Math.random() * 3000);
}

interface SpawnedServer {
  baseUrl: string;
  proc: ChildProcessByStdio<null, Readable, Readable>;
  close(): Promise<void>;
}

async function spawnServer(): Promise<SpawnedServer> {
  const port = randomPort();
  const proc = spawn(process.execPath, ['apps/demo/server.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DISABLE_BROADCAST_WORKER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return { baseUrl, proc, close: () => closeProc(proc) };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await closeProc(proc);
  throw new Error('server did not become healthy in time');
}

function closeProc(proc: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    proc.once('exit', () => resolve());
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    }, 3000);
  });
}

/** Extracts just the `name=value` pair off a Set-Cookie header (dropping attributes) so it can be replayed as a `Cookie` header on the next request — fetch() has no cookie jar of its own. */
function cookieValueFrom(setCookieHeader: string | null): string | undefined {
  return setCookieHeader?.split(';')[0];
}

async function cleanupMerchant(merchantId: string): Promise<void> {
  await prisma.stampEvent.deleteMany({ where: { merchantId } });
  await prisma.merchant.delete({ where: { id: merchantId } }).catch(() => {});
}

let server: SpawnedServer;

before(async () => {
  server = await spawnServer();
});

after(async () => {
  await server.close();
});

// ---------------------------------------------------------------------------
// Sign-up / sign-in / sign-out
// ---------------------------------------------------------------------------

test('POST /signup creates a Merchant, logs them in, and lands on the dashboard', async () => {
  const email = `signup-${randomHex(8)}@example.test`;
  const res = await fetch(`${server.baseUrl}/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ businessName: 'Signup Test Bakery', email, password: 'a genuinely strong passphrase' }).toString(),
    redirect: 'manual',
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/app');
  const cookie = cookieValueFrom(res.headers.get('set-cookie'));
  assert.ok(cookie, 'expected a session cookie to be set on sign-up');
  assert.match(res.headers.get('set-cookie') ?? '', /HttpOnly/);
  assert.match(res.headers.get('set-cookie') ?? '', /Secure/);
  assert.match(res.headers.get('set-cookie') ?? '', /SameSite=Lax/);

  const merchant = await prisma.merchant.findUnique({ where: { email } });
  assert.ok(merchant, 'expected a Merchant row to exist after sign-up');
  assert.equal(merchant!.name, 'Signup Test Bakery');
  assert.ok(merchant!.passwordHash, 'expected a password hash to be stored');
  assert.ok(!merchant!.passwordHash!.includes('a genuinely strong passphrase'), 'the plaintext password must never be stored');

  try {
    const dashboard = await fetch(`${server.baseUrl}/app`, { headers: { Cookie: cookie! } });
    assert.equal(dashboard.status, 200, 'the fresh session must actually work against a merchant route');
  } finally {
    await cleanupMerchant(merchant!.id);
  }
});

test('POST /signup rejects a short password, a common password, a missing business name, and a duplicate email', async () => {
  const email = `signup-reject-${randomHex(8)}@example.test`;
  const tooShort = await fetch(`${server.baseUrl}/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ businessName: 'X', email, password: 'short1' }).toString(),
  });
  assert.equal(tooShort.status, 400);
  assert.equal(await prisma.merchant.findUnique({ where: { email } }), null);

  const tooCommon = await fetch(`${server.baseUrl}/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ businessName: 'X', email, password: 'password123' }).toString(),
  });
  assert.equal(tooCommon.status, 400);

  const noName = await fetch(`${server.baseUrl}/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ businessName: '', email, password: 'a genuinely strong passphrase' }).toString(),
  });
  assert.equal(noName.status, 400);

  const merchant = await prisma.merchant.create({
    data: { subStatus: 'trialing', trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), email, name: 'Existing Merchant', passwordHash: 'scrypt$16384$8$1$aa$bb' },
  });
  try {
    const duplicate = await fetch(`${server.baseUrl}/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ businessName: 'Different Name', email, password: 'a genuinely strong passphrase' }).toString(),
    });
    assert.equal(duplicate.status, 409);
    const stillOriginal = await prisma.merchant.findUniqueOrThrow({ where: { email } });
    assert.equal(stillOriginal.name, 'Existing Merchant', 'the existing account must not be overwritten by a duplicate sign-up');
  } finally {
    await cleanupMerchant(merchant.id);
  }
});

test('sign in, sign out, and sign in again: sign-out invalidates the session server-side — reusing the old cookie fails', async () => {
  const email = `lifecycle-${randomHex(8)}@example.test`;
  const password = 'a genuinely strong passphrase two';
  const signUp = await fetch(`${server.baseUrl}/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ businessName: 'Lifecycle Test Biz', email, password }).toString(),
    redirect: 'manual',
  });
  const firstCookie = cookieValueFrom(signUp.headers.get('set-cookie'));
  assert.ok(firstCookie);
  const merchant = await prisma.merchant.findUniqueOrThrow({ where: { email } });

  try {
    // Signing in again (a second, independent session) must work and must
    // rotate to a brand-new session id, not reuse the sign-up session's.
    const signIn = await fetch(`${server.baseUrl}/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email, password, next: '/app' }).toString(),
      redirect: 'manual',
    });
    assert.equal(signIn.status, 303);
    assert.equal(signIn.headers.get('location'), '/app');
    const secondCookie = cookieValueFrom(signIn.headers.get('set-cookie'));
    assert.ok(secondCookie);
    assert.notEqual(secondCookie, firstCookie, 'signing in again must mint a fresh session id, not reuse an old one');

    const dashboardWithSecond = await fetch(`${server.baseUrl}/app`, { headers: { Cookie: secondCookie! } });
    assert.equal(dashboardWithSecond.status, 200);

    // Sign out with the second session.
    const signOut = await fetch(`${server.baseUrl}/signout`, {
      method: 'POST',
      headers: { Cookie: secondCookie! },
      redirect: 'manual',
    });
    assert.equal(signOut.status, 303);
    assert.equal(signOut.headers.get('location'), '/signin');
    assert.match(signOut.headers.get('set-cookie') ?? '', /Max-Age=0/, 'sign-out must clear the cookie client-side too');

    // The session row itself must be gone, not just the cookie cleared.
    const sessionIdFromSecondCookie = secondCookie!.split('=')[1];
    const sessionRow = await prisma.session.findUnique({ where: { id: sessionIdFromSecondCookie } });
    assert.equal(sessionRow, null, 'the Session row must be deleted server-side on sign-out');

    // Reusing the now-invalidated cookie must fail — this is the
    // server-side half of "logout invalidates the session"; a client-side
    // cookie clear alone would not stop this old cookie value from still
    // working.
    const reused = await fetch(`${server.baseUrl}/app`, { headers: { Cookie: secondCookie! }, redirect: 'manual' });
    assert.equal(reused.status, 302, 'a signed-out session cookie must no longer grant access');
    assert.match(reused.headers.get('location') ?? '', /^\/signin/);

    // The *first* (sign-up) session is untouched by signing out of the second.
    const firstStillWorks = await fetch(`${server.baseUrl}/app`, { headers: { Cookie: firstCookie! } });
    assert.equal(firstStillWorks.status, 200);
  } finally {
    await cleanupMerchant(merchant.id);
  }
});

test('sign-in returns the exact same generic message and status for a wrong password and for no such account', async () => {
  const email = `wrongpw-${randomHex(8)}@example.test`;
  const merchant = await prisma.merchant.create({
    data: { subStatus: 'trialing', trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      email,
      name: 'Wrong Password Test',
      // A real scrypt hash of a *different* password than the one the test submits below.
      passwordHash: (await import('../auth.ts')).hashPassword('the-actual-correct-password-123'),
    },
  });
  try {
    const wrongPassword = await fetch(`${server.baseUrl}/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email, password: 'totally-wrong-password-123' }).toString(),
    });
    const wrongPasswordHtml = await wrongPassword.text();

    const noSuchAccount = await fetch(`${server.baseUrl}/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: `nobody-${randomHex(8)}@example.test`, password: 'totally-wrong-password-123' }).toString(),
    });
    const noSuchAccountHtml = await noSuchAccount.text();

    assert.equal(wrongPassword.status, noSuchAccount.status, 'wrong password and no-such-account must return the same status');
    assert.equal(wrongPassword.status, 401);

    // Both pages must show the identical generic error text — extract the
    // error banner rather than diffing the whole page (session-independent
    // markup like nonces/timestamps would otherwise cause a false mismatch;
    // there are none here, but comparing the meaningful substring is the
    // robust form of this assertion).
    const errorRe = /<div class="error">([^<]+)<\/div>/;
    const wrongPasswordError = wrongPasswordHtml.match(errorRe)?.[1];
    const noSuchAccountError = noSuchAccountHtml.match(errorRe)?.[1];
    assert.ok(wrongPasswordError, 'expected an error message on the wrong-password response');
    assert.equal(wrongPasswordError, noSuchAccountError, 'the sign-in form must not be usable as an account-existence oracle');
  } finally {
    await cleanupMerchant(merchant.id);
  }
});

test('a wrong password and no-such-account also cost about the same time — not just the same message (no timing side channel)', async () => {
  // Regression guard for a real fix: handleSignIn used to skip the scrypt
  // verification entirely when no merchant row existed (nothing to check
  // against), so "no such account" answered near-instantly while "wrong
  // password on a real account" paid scrypt's full ~tens-of-ms cost — an
  // identical-message response that was still distinguishable by timing
  // alone. The fix (DUMMY_PASSWORD_HASH in server.ts) always runs a real
  // scrypt verification either way. Threshold is generous (10x, floor 50ms)
  // to stay robust under CI/local load noise while still catching the
  // specific "one path skips hashing entirely" regression this guards.
  const email = `timing-${randomHex(8)}@example.test`;
  const merchant = await prisma.merchant.create({
    data: { subStatus: 'trialing', trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), email, name: 'Timing Test', passwordHash: (await import('../auth.ts')).hashPassword('the-real-password-for-timing-test') },
  });
  try {
    const time = async (attemptEmail: string): Promise<number> => {
      const start = performance.now();
      await fetch(`${server.baseUrl}/signin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: attemptEmail, password: 'wrong-password-for-timing-test' }).toString(),
      }).then((r) => r.text());
      return performance.now() - start;
    };

    // A few samples each, averaged, to smooth out single-request noise.
    const existingTimes: number[] = [];
    const missingTimes: number[] = [];
    for (let i = 0; i < 3; i++) {
      existingTimes.push(await time(email));
      missingTimes.push(await time(`nobody-${randomHex(8)}@example.test`));
    }
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const existingAvg = avg(existingTimes);
    const missingAvg = avg(missingTimes);

    const ratio = Math.max(existingAvg, missingAvg) / Math.max(1, Math.min(existingAvg, missingAvg));
    assert.ok(
      ratio < 10,
      `expected existing-account and no-such-account sign-in attempts to cost roughly the same time; got ${existingAvg.toFixed(1)}ms vs ${missingAvg.toFixed(1)}ms (ratio ${ratio.toFixed(1)}x)`
    );
  } finally {
    await cleanupMerchant(merchant.id);
  }
});

test('sign-in is rate-limited per email: repeated wrong attempts against the same address eventually 429', async () => {
  // A dedicated server so this test's IP/email rate-limit counters can never
  // be polluted by (or pollute) any other test sharing the default server.
  const isolated = await spawnServer();
  const email = `ratelimit-${randomHex(8)}@example.test`;
  const merchant = await prisma.merchant.create({
    data: { subStatus: 'trialing', trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), email, name: 'Rate Limit Test', passwordHash: (await import('../auth.ts')).hashPassword('the-real-password-abc-123') },
  });
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) {
      const res = await fetch(`${isolated.baseUrl}/signin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email, password: 'wrong-every-time' }).toString(),
      });
      statuses.push(res.status);
    }
    assert.ok(statuses.slice(0, 8).every((s) => s === 401), `expected the first 8 attempts to be plain 401s, got ${statuses.slice(0, 8)}`);
    assert.equal(statuses[8], 429, `expected the 9th attempt within the window to be rate-limited, got ${statuses[8]}`);
  } finally {
    await cleanupMerchant(merchant.id);
    await isolated.close();
  }
});

// Regression guard for the final whole-branch review's finding #1: POST
// /signup had no rate limit at all, unlike every other credential path
// (sign-in, staff PIN, pass issuance, broadcasts) — an unbounded loop from
// one host could both fill the Merchant table and pin the one always-on
// Fly machine via hashPassword's blocking scrypt cost. signupLimiterByIp
// caps this at 5 per IP per 15 minutes.
test('sign-up is rate-limited per IP: the 6th sign-up attempt from one IP within the window is refused and creates no Merchant row', async () => {
  // A dedicated server, same reasoning as the sign-in rate-limit test above
  // — this test's IP-keyed counter must never be polluted by (or pollute)
  // any other test sharing the default server's own /signup traffic.
  const isolated = await spawnServer();
  const emails: string[] = [];
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const email = `signup-ratelimit-${randomHex(8)}@example.test`;
      emails.push(email);
      const res = await fetch(`${isolated.baseUrl}/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ businessName: 'Rate Limit Bakery', email, password: 'a genuinely strong passphrase' }).toString(),
        redirect: 'manual',
      });
      statuses.push(res.status);
    }
    assert.ok(statuses.slice(0, 5).every((s) => s === 303), `expected the first 5 sign-ups from one IP to succeed, got ${statuses.slice(0, 5)}`);
    assert.equal(statuses[5], 429, `expected the 6th sign-up attempt within the window to be rate-limited, got ${statuses[5]}`);

    const sixthEmail = emails[5]!;
    const rateLimitedRow = await prisma.merchant.findUnique({ where: { email: sixthEmail } });
    assert.equal(rateLimitedRow, null, 'the rate-limited 6th attempt must not have created a Merchant row');
  } finally {
    for (const email of emails.slice(0, 5)) {
      const merchant = await prisma.merchant.findUnique({ where: { email } });
      if (merchant) await cleanupMerchant(merchant.id);
    }
    await isolated.close();
  }
});

// Regression guard for finding #2: the auth migration adds
// Merchant.passwordHash as nullable (the pre-existing demo Merchant row has
// no password yet), and handleSignIn must tell a real, known account with
// no password set apart from a wrong-password/no-such-account attempt —
// silently folding it into the generic message would be a permanent,
// unexplained lockout for anyone in that state.
test('sign-in shows a specific "needs a password set" message, not the generic one, for a Merchant row with a null passwordHash', async () => {
  const email = `nullhash-${randomHex(8)}@example.test`;
  // No passwordHash at all — exactly the shape the auth migration leaves
  // a pre-existing Merchant row in.
  const merchant = await prisma.merchant.create({ data: { subStatus: 'trialing', trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), email, name: 'Null Password Hash Test' } });
  try {
    assert.equal(merchant.passwordHash, null);
    const res = await fetch(`${server.baseUrl}/signin`, {
      method: 'POST',
      // lnx-lang=en so the response is asserted in a known language — with
      // no cookie at all resolveLang() defaults to Arabic (BUILD.md §13),
      // same convention as httpIntegration.test.ts's own lang tests.
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: 'lnx-lang=en' },
      body: new URLSearchParams({ email, password: 'whatever-the-attempted-password-is' }).toString(),
    });
    assert.equal(res.status, 401);
    const html = await res.text();
    assert.ok(html.includes('needs a password set'), 'expected the specific null-password-hash message');
    assert.ok(!html.includes('Incorrect email or password'), 'must not show the generic wrong-credentials message for this specific, known case');
  } finally {
    await cleanupMerchant(merchant.id);
  }
});

// ---------------------------------------------------------------------------
// Public routes — must keep working with no session at all (BUILD.md job
// brief's explicit list).
// ---------------------------------------------------------------------------

async function makePublicRouteFixture(): Promise<{
  merchantId: string;
  card: Awaited<ReturnType<typeof prisma.card.create>>;
  pass: Awaited<ReturnType<typeof prisma.pass.create>>;
}> {
  const merchant = await prisma.merchant.create({
    data: { subStatus: 'trialing', trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), firebaseUid: `pubroute-${randomHex(8)}`, email: `pubroute-${randomHex(8)}@example.test`, name: 'Public Route Test' },
  });
  const card = await prisma.card.create({
    data: {
      merchantId: merchant.id,
      slot: 1,
      linkCode: randomLinkCode(),
      shortCode: `C${randomHex(4)}`.toUpperCase(),
      name: 'Public Route Test Card',
      lang: 'en', // the enrol-page assertion below checks English copy; Card.lang defaults to 'ar' otherwise (BUILD.md §13)
      stampsGoal: 8,
      bgColor: '#203757',
      fgColor: '#FFFFFF',
      stampActive: '#F96400',
      stampInactive: '#8794A5',
      rewardText: 'Free coffee',
      active: true,
    },
  });
  const pass = await prisma.pass.create({
    data: {
      serial: `PUB${randomHex(9)}`.toUpperCase(),
      shortCode: `P${randomHex(4)}`.toUpperCase(),
      cardId: card.id,
      merchantId: merchant.id,
      authToken: randomHex(16),
    },
  });
  return { merchantId: merchant.id, card, pass };
}

test('GET / and the customer enrol page work with zero cookies', async () => {
  const fx = await makePublicRouteFixture();
  try {
    const landing = await fetch(`${server.baseUrl}/`);
    assert.equal(landing.status, 200);

    const enrol = await fetch(`${server.baseUrl}/${fx.card.linkCode}`);
    assert.equal(enrol.status, 200);
    const html = await enrol.text();
    assert.ok(html.includes('Add to Apple Wallet'));
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

// BUILD.md §8.16 ("the highest-value page") / §13 — the enrol page used to
// hardcode lang="en" and every string in it regardless of Card.lang, so an
// Arabic card (the Prisma default) sent its own customers to an English
// enrol page. This is the regression test for that fix.
test('the customer enrol page renders in Arabic, RTL, with Arabic-Indic digits, for a card whose lang is ar (the Prisma default)', async () => {
  const merchant = await prisma.merchant.create({
    data: { subStatus: 'trialing', trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), firebaseUid: `pubroute-${randomHex(8)}`, email: `pubroute-${randomHex(8)}@example.test`, name: 'Public Route Test AR' },
  });
  const card = await prisma.card.create({
    data: {
      merchantId: merchant.id,
      slot: 1,
      linkCode: randomLinkCode(),
      shortCode: `C${randomHex(4)}`.toUpperCase(),
      name: 'بطاقة اختبار',
      lang: 'ar',
      stampsGoal: 8,
      bgColor: '#203757',
      fgColor: '#FFFFFF',
      stampActive: '#F96400',
      stampInactive: '#8794A5',
      rewardText: 'Free coffee', // merchant-authored — must survive untranslated (BUILD.md §13)
      active: true,
    },
  });
  try {
    const enrol = await fetch(`${server.baseUrl}/${card.linkCode}`);
    assert.equal(enrol.status, 200);
    const html = await enrol.text();
    assert.match(html, /<html lang="ar" dir="rtl">/);
    assert.ok(html.includes('أضف إلى محفظة آبل'), 'Apple Wallet button must be translated');
    assert.ok(html.includes('أضف إلى محفظة جوجل'), 'Google Wallet button must be translated');
    assert.ok(html.includes('مدعوم من لويانيكسا'), 'footer must be translated');
    assert.ok(html.includes('٨ أختام'), 'the stamps-goal sentence must use Arabic-Indic digits, not "8"');
    assert.ok(html.includes('Free coffee'), 'merchant-authored reward text must never be machine-translated');
    assert.ok(!html.includes('Add to Apple Wallet'), 'no leftover English copy on the Arabic page');
  } finally {
    await cleanupMerchant(merchant.id);
  }
});

test('POST /:code/pass and POST /:code/google-pass work with zero cookies (no /signin redirect)', async () => {
  const fx = await makePublicRouteFixture();
  try {
    const applePass = await fetch(`${server.baseUrl}/${fx.card.linkCode}/pass`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '',
      redirect: 'manual',
    });
    assert.equal(applePass.status, 200, 'expected a real signed .pkpass, not a redirect or error');
    assert.equal(applePass.headers.get('content-type'), 'application/vnd.apple.pkpass');
    await applePass.arrayBuffer(); // drain

    // Google Wallet's own success path needs a live network call to Google
    // (OAuth token exchange) that this environment may or may not be able
    // to make — the one thing this test asserts unconditionally is that the
    // route was never gated behind a session, whatever it answers.
    const googlePass = await fetch(`${server.baseUrl}/${fx.card.linkCode}/google-pass`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '',
      redirect: 'manual',
    });
    assert.notEqual(googlePass.status, 404, 'the card must resolve — this is not a "card not found"');
    if (googlePass.status === 302) {
      assert.doesNotMatch(googlePass.headers.get('location') ?? '', /^\/signin/, 'must never redirect to /signin');
    }
    await (googlePass.status === 302 ? Promise.resolve() : googlePass.text().catch(() => {}));
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('GET /img/:hash, /qr.png, /preview.png and /health work with zero cookies', async () => {
  const health = await fetch(`${server.baseUrl}/health`);
  assert.equal(health.status, 200);

  const qr = await fetch(`${server.baseUrl}/qr.png?data=${encodeURIComponent('https://loyn.me/12345')}`);
  assert.equal(qr.status, 200);
  assert.equal(qr.headers.get('content-type'), 'image/png');

  const preview = await fetch(`${server.baseUrl}/preview.png?goal=8&filled=3&bg=%23203757&active=%23F96400&inactive=%238794A5`);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('content-type'), 'image/png');

  const unknownHash = 'a'.repeat(64);
  const img = await fetch(`${server.baseUrl}/img/${unknownHash}`);
  assert.equal(img.status, 404, 'a well-formed but unknown hash 404s — the point is it is not a 302 to /signin');
});

test('the five /apple/v1/... PassKit endpoints work with zero cookies (they authenticate by pass token, not session)', async () => {
  const fx = await makePublicRouteFixture();
  try {
    const deviceId = `device-${randomHex(8)}`;
    const passTypeId = 'pass.com.loyanexa.loyalty';

    const log = await fetch(`${server.baseUrl}/apple/v1/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logs: ['test log line'] }),
      redirect: 'manual',
    });
    assert.equal(log.status, 200);

    const register = await fetch(
      `${server.baseUrl}/apple/v1/devices/${deviceId}/registrations/${passTypeId}/${fx.pass.serial}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `ApplePass ${fx.pass.authToken}` },
        body: JSON.stringify({ pushToken: randomHex(16) }),
        redirect: 'manual',
      }
    );
    assert.equal(register.status, 201, 'a brand-new registration should 201, not redirect');

    const serials = await fetch(
      `${server.baseUrl}/apple/v1/devices/${deviceId}/registrations/${passTypeId}`,
      { redirect: 'manual' }
    );
    assert.ok([200, 204].includes(serials.status), `expected 200 or 204, got ${serials.status}`);

    const getPass = await fetch(`${server.baseUrl}/apple/v1/passes/${passTypeId}/${fx.pass.serial}`, {
      headers: { Authorization: `ApplePass ${fx.pass.authToken}` },
      redirect: 'manual',
    });
    assert.equal(getPass.status, 200, 'expected a real rebuilt .pkpass, not a redirect');
    await getPass.arrayBuffer(); // drain

    const unregister = await fetch(
      `${server.baseUrl}/apple/v1/devices/${deviceId}/registrations/${passTypeId}/${fx.pass.serial}`,
      { method: 'DELETE', headers: { Authorization: `ApplePass ${fx.pass.authToken}` }, redirect: 'manual' }
    );
    assert.equal(unregister.status, 200);

    // Wrong token is a 401 from PassKit's own auth, never a redirect to /signin.
    const badAuth = await fetch(`${server.baseUrl}/apple/v1/passes/${passTypeId}/${fx.pass.serial}`, {
      headers: { Authorization: 'ApplePass totally-wrong-token' },
      redirect: 'manual',
    });
    assert.equal(badAuth.status, 401);
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});
