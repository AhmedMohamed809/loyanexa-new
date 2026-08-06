// apps/demo/test/httpIntegration.test.ts — HTTP-level checks for the final
// whole-branch review fixes that only show up at the request/response
// boundary (escaped output, cookie name, rate limiting, error-message
// leakage). Spawns the real server (apps/demo/server.ts) as a child
// process against the real local Postgres — same "no mocks" convention as
// every other test in this repo, just exercised over HTTP instead of by
// importing a module directly, because these particular fixes live in how
// the router wires things together, not in one pure function.

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
const { createSession, SESSION_COOKIE_NAME } = await import('../auth.ts');

/** Mints a real Session row for `merchantId` (bypassing the HTTP sign-in flow itself — that round trip is covered by auth.test.ts / authHttp.test.ts) and returns the `Cookie` header value every merchant-scoped request in this file needs to carry. */
async function sessionCookieFor(merchantId: string): Promise<string> {
  const session = await createSession(merchantId);
  return `${SESSION_COOKIE_NAME}=${session.id}`;
}

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}
function randomLinkCode(): number {
  return 500_000_000 + Math.floor(Math.random() * 500_000_000);
}
function randomPort(): number {
  return 41000 + Math.floor(Math.random() * 8000);
}

interface SpawnedServer {
  baseUrl: string;
  proc: ChildProcessByStdio<null, Readable, Readable>;
  stdout(): string;
  stderr(): string;
  close(): Promise<void>;
}

/** Spawns apps/demo/server.ts as a real child process, with `envOverrides` layered on top of the current environment (so DATABASE_URL etc. carry through unless deliberately overridden). Waits for GET /health to answer before resolving. */
async function spawnServer(envOverrides: Record<string, string> = {}): Promise<SpawnedServer> {
  const port = randomPort();
  const proc = spawn(process.execPath, ['apps/demo/server.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DISABLE_BROADCAST_WORKER: '1', ...envOverrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  proc.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const baseUrl = `http://127.0.0.1:${port}`;

  const deadline = Date.now() + 15_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) {
        return { baseUrl, proc, stdout: () => stdout, stderr: () => stderr, close: () => closeProc(proc) };
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await closeProc(proc);
  throw new Error(`server did not become healthy in time (stderr: ${stderr}); last error: ${String(lastErr)}`);
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

async function makeActiveCard(): Promise<{
  merchantId: string;
  card: Awaited<ReturnType<typeof prisma.card.create>>;
  cookie: string;
}> {
  const merchant = await prisma.merchant.create({
    data: { subStatus: 'trialing', trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      firebaseUid: `http-test-${randomHex(8)}`,
      email: `http-test-${randomHex(8)}@example.test`,
      name: 'HTTP Test Merchant',
    },
  });
  const card = await prisma.card.create({
    data: {
      merchantId: merchant.id,
      slot: 1,
      linkCode: randomLinkCode(),
      shortCode: `C${randomHex(4)}`.toUpperCase(),
      name: 'HTTP Test Card',
      stampsGoal: 8,
      bgColor: '#203757',
      fgColor: '#FFFFFF',
      stampActive: '#F96400',
      stampInactive: '#8794A5',
      rewardText: 'Free coffee',
      active: true,
    },
  });
  const cookie = await sessionCookieFor(merchant.id);
  return { merchantId: merchant.id, card, cookie };
}

async function cleanupMerchant(merchantId: string): Promise<void> {
  await prisma.merchant.delete({ where: { id: merchantId } }).catch(() => {});
}

// ---------------------------------------------------------------------------
// One long-lived default-config server, shared by every test that doesn't
// need a deliberately broken environment.
// ---------------------------------------------------------------------------
let server: SpawnedServer;

before(async () => {
  server = await spawnServer();
});

after(async () => {
  await server.close();
});

test('/ and an existing short link are 200 with no session at all (public routes)', async () => {
  const fx = await makeActiveCard();
  try {
    for (const p of ['/', `/${fx.card.linkCode}`]) {
      const res = await fetch(`${server.baseUrl}${p}`);
      assert.equal(res.status, 200, `GET ${p} should be 200, got ${res.status}`);
    }
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('/app, /customers, /reports all redirect to /signin with no session, and 200 with a valid one', async () => {
  const fx = await makeActiveCard();
  try {
    for (const p of ['/app', '/customers', '/reports']) {
      const noSession = await fetch(`${server.baseUrl}${p}`, { redirect: 'manual' });
      assert.equal(noSession.status, 302, `GET ${p} with no session should redirect, got ${noSession.status}`);
      assert.match(noSession.headers.get('location') ?? '', /^\/signin/, `GET ${p} should redirect to /signin`);

      const withSession = await fetch(`${server.baseUrl}${p}`, { headers: { Cookie: fx.cookie } });
      assert.equal(withSession.status, 200, `GET ${p} with a valid session should be 200, got ${withSession.status}`);
    }
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

// /stamp is a deliberate exception to the redirect-to-/signin rule above
// (BUILD.md §8.13): with no session at all it shows the staff PIN entry
// screen (200), not a redirect — staff need to reach it without the
// owner's own credentials. A valid *merchant* session still reaches the
// stamp screen itself, 200, same as before.
test('/stamp shows the staff PIN screen (200, no merchant chrome) with no session, and the stamp screen itself with a valid merchant session', async () => {
  const fx = await makeActiveCard();
  try {
    const noSession = await fetch(`${server.baseUrl}/stamp`, { redirect: 'manual' });
    assert.equal(noSession.status, 200, 'GET /stamp with no session should show the PIN form, not redirect');
    const pinHtml = await noSession.text();
    assert.ok(pinHtml.includes('name="pin"'), 'the PIN entry form should be shown');
    assert.ok(!pinHtml.includes('id="video"'), 'the actual camera-scanning stamp screen must not render for an unauthenticated visitor');

    const withSession = await fetch(`${server.baseUrl}/stamp`, { headers: { Cookie: fx.cookie } });
    assert.equal(withSession.status, 200, 'GET /stamp with a valid merchant session should be 200');
    const html = await withSession.text();
    assert.ok(!html.includes('name="pin"'), 'a signed-in merchant should see the stamp screen, not the PIN form');
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('a script payload posted as a colour comes back escaped, not as live markup', async () => {
  const fx = await makeActiveCard();
  try {
    const payload = '"><script>alert(1)</script>';
    const body = new URLSearchParams({
      name: 'XSS Test Card',
      rewardText: 'Free coffee',
      goal: '8',
      bg: payload, // fails HEX_RE -> re-renders the form with the raw rejected value
      active: '#F96400',
      inactive: '#8794A5',
    });
    const res = await fetch(`${server.baseUrl}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: fx.cookie },
      body: body.toString(),
    });
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.ok(!html.includes('"><script>alert(1)</script>'), 'the raw payload must never appear unescaped in the response');
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the payload must appear HTML-escaped');
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('lnx-lang=en renders lang="en" dir="ltr"; lnx-lang=ar renders lang="ar" dir="rtl"; no cookie defaults to ar', async () => {
  const fx = await makeActiveCard();
  try {
    const en = await fetch(`${server.baseUrl}/app`, { headers: { Cookie: `lnx-lang=en; ${fx.cookie}` } });
    const enHtml = await en.text();
    assert.match(enHtml, /<html lang="en" dir="ltr"/);

    const ar = await fetch(`${server.baseUrl}/app`, { headers: { Cookie: `lnx-lang=ar; ${fx.cookie}` } });
    const arHtml = await ar.text();
    assert.match(arHtml, /<html lang="ar" dir="rtl"/);

    // The old, never-written cookie name must no longer be read.
    const staleName = await fetch(`${server.baseUrl}/app`, { headers: { Cookie: `lang=en; ${fx.cookie}` } });
    const staleHtml = await staleName.text();
    assert.match(staleHtml, /<html lang="ar" dir="rtl"/, 'a `lang=en` cookie (the old, wrong name) must not switch to English');

    const none = await fetch(`${server.baseUrl}/app`, { headers: { Cookie: fx.cookie } });
    assert.match(await none.text(), /<html lang="ar" dir="rtl"/);
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('a customer name/phone beginning with "=" is neutralised in the CSV export, not shipped as a live formula', async () => {
  const merchant = await prisma.merchant.create({
    data: { subStatus: 'trialing', trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), firebaseUid: `csv-test-${randomHex(8)}`, email: `csv-test-${randomHex(8)}@example.test`, name: 'CSV Test Merchant' },
  });
  const cookie = await sessionCookieFor(merchant.id);
  const card = await prisma.card.create({
    data: {
      merchantId: merchant.id,
      slot: 1,
      linkCode: randomLinkCode(),
      shortCode: `C${randomHex(4)}`.toUpperCase(),
      name: 'CSV Injection Test Card',
      stampsGoal: 8,
      bgColor: '#203757',
      fgColor: '#FFFFFF',
      stampActive: '#F96400',
      stampInactive: '#8794A5',
      rewardText: 'Free coffee',
      active: true,
    },
  });
  try {
    await prisma.pass.create({
      data: {
        serial: `SER${randomHex(8)}`.toUpperCase(),
        shortCode: `P${randomHex(4)}`.toUpperCase(),
        cardId: card.id,
        merchantId: merchant.id,
        authToken: randomHex(12),
        custName: '=HYPERLINK("https://evil/?x=1","Refund pending")',
        custPhone: '0551234567',
      },
    });
    const res = await fetch(`${server.baseUrl}/customers/export.csv`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const csv = await res.text();
    assert.ok(!csv.includes(',=HYPERLINK'), 'a bare "=..." must never appear as a live formula in the CSV');
    assert.ok(csv.includes("'=HYPERLINK"), 'the neutralising leading quote must be present');
  } finally {
    await cleanupMerchant(merchant.id);
  }
});

test('two enrolments with the same phone produce exactly one Pass row (verified by direct DB query)', async () => {
  const fx = await makeActiveCard();
  try {
    const body = new URLSearchParams({ name: 'Ahmed', phone: '0559998888' }).toString();
    const first = await fetch(`${server.baseUrl}/${fx.card.linkCode}/pass`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    assert.equal(first.status, 200);
    const second = await fetch(`${server.baseUrl}/${fx.card.linkCode}/pass`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    assert.equal(second.status, 200);

    const passes = await prisma.pass.findMany({ where: { cardId: fx.card.id, custPhone: '0559998888' } });
    assert.equal(passes.length, 1, `expected exactly one Pass row, found ${passes.length}`);
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('a built pass has empty primaryFields and a populated headerFields (BUILD.md §9.1)', async () => {
  const fx = await makeActiveCard();
  try {
    const res = await fetch(`${server.baseUrl}/${fx.card.linkCode}/pass`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '',
    });
    assert.equal(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());

    const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    const os = await import('node:os');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'loyanexa-http-test-'));
    const zipPath = path.join(dir, 'out.pkpass');
    writeFileSync(zipPath, buf);
    execFileSync('unzip', ['-q', zipPath, '-d', dir]);
    const passJson = JSON.parse(readFileSync(path.join(dir, 'pass.json'), 'utf8'));
    rmSync(dir, { recursive: true, force: true });

    assert.deepEqual(passJson.storeCard.primaryFields, []);
    assert.equal(passJson.storeCard.headerFields.length, 1);
    assert.equal(passJson.storeCard.headerFields[0].key, 'stamps');
    assert.deepEqual(
      passJson.storeCard.secondaryFields.map((f: { key: string }) => f.key),
      ['reward', 'stampsRemaining']
    );
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('the 11th pass issuance from one IP within the window returns 429', async () => {
  const fx = await makeActiveCard();
  try {
    const ip = `10.9.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
    const results: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await fetch(`${server.baseUrl}/${fx.card.linkCode}/pass`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': ip },
        body: '',
      });
      results.push(res.status);
      if (res.status === 200) await res.arrayBuffer(); // drain
      else await res.text();
    }
    assert.deepEqual(results.slice(0, 10), new Array(10).fill(200), `expected the first 10 to succeed, got ${results.slice(0, 10)}`);
    assert.equal(results[10], 429, `expected the 11th to be rate-limited, got ${results[10]}`);
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('a different IP is not affected by another IP\'s rate limit', async () => {
  const fx = await makeActiveCard();
  try {
    const res = await fetch(`${server.baseUrl}/${fx.card.linkCode}/pass`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 255)}.1` },
      body: '',
    });
    assert.equal(res.status, 200);
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

// ---------------------------------------------------------------------------
// Deliberately-broken-environment servers — each gets its own short-lived
// process so the default server above (and its rate-limit/idempotency
// state) is never disturbed.
// ---------------------------------------------------------------------------

test('a forced 500 (missing Apple credentials) shows a generic message to the client, with the detail only in the server log', async () => {
  const broken = await spawnServer({ APPLE_TEAM_ID: '' }); // present-but-empty beats loadEnvFile() refilling it from .env
  const fx = await makeActiveCard();
  try {
    const res = await fetch(`${broken.baseUrl}/${fx.card.linkCode}/pass`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '',
    });
    assert.equal(res.status, 500);
    const html = await res.text();
    assert.ok(!html.includes('.env is missing'), 'the client response must not leak the exception message');
    assert.ok(!html.includes('APPLE_TEAM_ID'), 'the client response must not name the missing env var');

    // Give the process a moment to flush its stderr write, then check the
    // detail landed in the server-side log instead.
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(broken.stderr().includes('APPLE_TEAM_ID'), 'the detail must still be logged server-side');
  } finally {
    await cleanupMerchant(fx.merchantId);
    await broken.close();
  }
});

test('an orphaned Pass row is cleaned up when pass building fails after it was created', async () => {
  // Credentials resolve fine (real cert files still exist); openssl/zip do
  // not, because PATH points nowhere — this fails buildPass() itself,
  // strictly after createPassForEnrolment() has already inserted the row,
  // exactly the failure window this fix closes.
  const broken = await spawnServer({ PATH: '/nonexistent-bin-dir' });
  const fx = await makeActiveCard();
  try {
    const res = await fetch(`${broken.baseUrl}/${fx.card.linkCode}/pass`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ phone: '0557778888' }).toString(),
    });
    assert.equal(res.status, 500);

    const passes = await prisma.pass.findMany({ where: { cardId: fx.card.id } });
    assert.equal(passes.length, 0, `expected no orphaned Pass row, found ${passes.length}`);
  } finally {
    await cleanupMerchant(fx.merchantId);
    await broken.close();
  }
});
