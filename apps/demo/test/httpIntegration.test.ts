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
    env: { ...process.env, PORT: String(port), ...envOverrides },
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

async function makeActiveCard(): Promise<{ merchantId: string; card: Awaited<ReturnType<typeof prisma.card.create>> }> {
  const merchant = await prisma.merchant.create({
    data: {
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
  return { merchantId: merchant.id, card };
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

test('/, /app, /customers, /reports, /stamp and an existing short link all still 200', async () => {
  const fx = await makeActiveCard();
  try {
    for (const p of ['/', '/app', '/customers', '/reports', '/stamp', `/${fx.card.linkCode}`]) {
      const res = await fetch(`${server.baseUrl}${p}`);
      assert.equal(res.status, 200, `GET ${p} should be 200, got ${res.status}`);
    }
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('a script payload posted as a colour comes back escaped, not as live markup', async () => {
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
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  assert.equal(res.status, 400);
  const html = await res.text();
  assert.ok(!html.includes('"><script>alert(1)</script>'), 'the raw payload must never appear unescaped in the response');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the payload must appear HTML-escaped');
});

test('lnx-lang=en renders lang="en" dir="ltr"; lnx-lang=ar renders lang="ar" dir="rtl"; no cookie defaults to ar', async () => {
  const en = await fetch(`${server.baseUrl}/app`, { headers: { Cookie: 'lnx-lang=en' } });
  const enHtml = await en.text();
  assert.match(enHtml, /<html lang="en" dir="ltr">/);

  const ar = await fetch(`${server.baseUrl}/app`, { headers: { Cookie: 'lnx-lang=ar' } });
  const arHtml = await ar.text();
  assert.match(arHtml, /<html lang="ar" dir="rtl">/);

  // The old, never-written cookie name must no longer be read.
  const staleName = await fetch(`${server.baseUrl}/app`, { headers: { Cookie: 'lang=en' } });
  const staleHtml = await staleName.text();
  assert.match(staleHtml, /<html lang="ar" dir="rtl">/, 'a `lang=en` cookie (the old, wrong name) must not switch to English');

  const none = await fetch(`${server.baseUrl}/app`);
  assert.match(await none.text(), /<html lang="ar" dir="rtl">/);
});

test('a customer name/phone beginning with "=" is neutralised in the CSV export, not shipped as a live formula', async () => {
  // GET /customers/export.csv exports for getOrCreateMerchant()'s merchant
  // — this build's single-merchant demo (server.ts's own TODO on that
  // function) — not whichever merchant a test happens to create, so the
  // fixture pass must be attached to that same existing merchant. Only the
  // pass and its own throwaway card are cleaned up afterward; the
  // long-lived demo merchant itself is never touched.
  const merchant = await prisma.merchant.findFirst({ orderBy: { createdAt: 'asc' } });
  assert.ok(merchant, 'expected an existing merchant row (created by getOrCreateMerchant on first use)');
  const card = await prisma.card.create({
    data: {
      merchantId: merchant!.id,
      slot: 9_000_000 + Math.floor(Math.random() * 1000),
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
        merchantId: merchant!.id,
        authToken: randomHex(12),
        custName: '=HYPERLINK("https://evil/?x=1","Refund pending")',
        custPhone: '0551234567',
      },
    });
    const res = await fetch(`${server.baseUrl}/customers/export.csv`);
    assert.equal(res.status, 200);
    const csv = await res.text();
    assert.ok(!csv.includes(',=HYPERLINK'), 'a bare "=..." must never appear as a live formula in the CSV');
    assert.ok(csv.includes("'=HYPERLINK"), 'the neutralising leading quote must be present');
  } finally {
    await prisma.stampEvent.deleteMany({ where: { cardId: card.id } });
    await prisma.pass.deleteMany({ where: { cardId: card.id } });
    await prisma.card.delete({ where: { id: card.id } }).catch(() => {});
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
