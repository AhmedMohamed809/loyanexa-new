// apps/demo/test/notificationsHttp.test.ts — the Notifications screen
// (BUILD.md §8.12) over real HTTP against the real local Postgres, no
// mocks, spawning the actual server.ts child process (same pattern as
// apps/demo/test/scoping.test.ts and staffScoping.test.ts). Covers what
// those two files' own conventions exist to prove for every new
// merchant-facing surface:
//
//   - a staff PIN session is refused everywhere here, exactly like every
//     other owner-only route (staffScoping.test.ts's pattern)
//   - merchant A can never broadcast to merchant B's customers, and
//     merchant B's card is provably untouched (scoping.test.ts's pattern)
//   - POST /notifications/send returns immediately and creates one job
//     with the right recipient count
//   - the per-merchant broadcast rate limit actually limits

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
const { createStaffSession, STAFF_SESSION_COOKIE_NAME } = await import('../staffAuth.ts');
const { createStaff } = await import('../staff.ts');

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}
function randomLinkCode(): number {
  return 500_000_000 + Math.floor(Math.random() * 500_000_000);
}
function randomPort(): number {
  return 48000 + Math.floor(Math.random() * 3000);
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

async function sessionCookieFor(merchantId: string): Promise<string> {
  const session = await createSession(merchantId);
  return `${SESSION_COOKIE_NAME}=${session.id}`;
}

interface MerchantFixture {
  merchantId: string;
  merchantEmail: string;
  cookie: string;
  cardId: string;
}

async function makeMerchantFixture(label: string, recipientCount = 0): Promise<MerchantFixture> {
  const email = `notif-${label}-${randomHex(8)}@example.test`;
  const merchant = await prisma.merchant.create({ data: { email, name: `Notif Test ${label}` } });
  const card = await prisma.card.create({
    data: {
      merchantId: merchant.id,
      slot: 1,
      linkCode: randomLinkCode(),
      shortCode: `C${randomHex(4)}`.toUpperCase(),
      name: `${label} Card`,
      stampsGoal: 8,
      bgColor: '#203757',
      fgColor: '#FFFFFF',
      stampActive: '#F96400',
      stampInactive: '#8794A5',
      rewardText: 'Free coffee',
      active: true,
    },
  });
  for (let i = 0; i < recipientCount; i++) {
    await prisma.pass.create({
      data: {
        serial: `NOTIFSER${randomHex(6)}`.toUpperCase(),
        shortCode: `P${randomHex(4)}`.toUpperCase(),
        cardId: card.id,
        merchantId: merchant.id,
        authToken: randomHex(12),
      },
    });
  }
  const cookie = await sessionCookieFor(merchant.id);
  return { merchantId: merchant.id, merchantEmail: email, cookie, cardId: card.id };
}

async function cleanupMerchant(merchantId: string): Promise<void> {
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
// Owner session only — a staff PIN session is refused everywhere here.
// ---------------------------------------------------------------------------

test('a staff session is refused (302 -> /signin) on GET /notifications', async () => {
  const fx = await makeMerchantFixture('staff1');
  const staff = await createStaff(fx.merchantId, 'Barista', '4821');
  const staffSession = await createStaffSession(staff.id, fx.merchantId);
  const staffCookie = `${STAFF_SESSION_COOKIE_NAME}=${staffSession.id}`;
  try {
    const res = await fetch(`${server.baseUrl}/notifications`, { headers: { Cookie: staffCookie }, redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') ?? '', /^\/signin/);
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('a staff session is refused (302 -> /signin) on GET /notifications/recipient-count', async () => {
  const fx = await makeMerchantFixture('staff2');
  const staff = await createStaff(fx.merchantId, 'Barista', '4822');
  const staffSession = await createStaffSession(staff.id, fx.merchantId);
  const staffCookie = `${STAFF_SESSION_COOKIE_NAME}=${staffSession.id}`;
  try {
    const res = await fetch(`${server.baseUrl}/notifications/recipient-count?cardId=${fx.cardId}`, {
      headers: { Cookie: staffCookie },
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') ?? '', /^\/signin/);
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('a staff session is refused (302 -> /signin) on POST /notifications/send, and no job is created', async () => {
  const fx = await makeMerchantFixture('staff3');
  const staff = await createStaff(fx.merchantId, 'Barista', '4823');
  const staffSession = await createStaffSession(staff.id, fx.merchantId);
  const staffCookie = `${STAFF_SESSION_COOKIE_NAME}=${staffSession.id}`;
  try {
    const res = await fetch(`${server.baseUrl}/notifications/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({ cardId: fx.cardId, message: 'Sneaky staff broadcast' }),
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') ?? '', /^\/signin/);

    const jobCount = await prisma.broadcastJob.count({ where: { cardId: fx.cardId } });
    assert.equal(jobCount, 0, 'a staff session must never be able to enqueue a broadcast');
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('a staff session is refused (302 -> /signin) on GET /notifications/jobs/:id', async () => {
  const fx = await makeMerchantFixture('staff4');
  const staff = await createStaff(fx.merchantId, 'Barista', '4824');
  const staffSession = await createStaffSession(staff.id, fx.merchantId);
  const staffCookie = `${STAFF_SESSION_COOKIE_NAME}=${staffSession.id}`;
  try {
    const res = await fetch(`${server.baseUrl}/notifications/jobs/nonexistent-id`, {
      headers: { Cookie: staffCookie },
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') ?? '', /^\/signin/);
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('no session at all is refused (302 -> /signin) on GET /notifications', async () => {
  const res = await fetch(`${server.baseUrl}/notifications`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location') ?? '', /^\/signin/);
});

// ---------------------------------------------------------------------------
// Cross-merchant scoping — merchant A cannot broadcast to merchant B's
// customers, and B's data is provably untouched.
// ---------------------------------------------------------------------------

test('POST /notifications/send with merchant B\'s cardId, as merchant A, 404s — never 403 — and no job or recipient touches B\'s customers', async () => {
  const a = await makeMerchantFixture('crossA1', 0);
  const b = await makeMerchantFixture('crossB1', 3);
  try {
    const res = await fetch(`${server.baseUrl}/notifications/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: a.cookie },
      body: JSON.stringify({ cardId: b.cardId, message: 'Hijacked broadcast from A' }),
    });
    assert.equal(res.status, 404, 'expected 404, never 403 — a card id belonging to another merchant must read as not found');

    const jobsAgainstB = await prisma.broadcastJob.count({ where: { cardId: b.cardId } });
    assert.equal(jobsAgainstB, 0, "merchant A must never be able to create a broadcast job against merchant B's card");

    const bPasses = await prisma.pass.findMany({ where: { cardId: b.cardId } });
    for (const p of bPasses) {
      assert.equal(p.message, '', "merchant B's customers' Pass.message must be untouched by merchant A's attempt");
    }
  } finally {
    await cleanupMerchant(a.merchantId);
    await cleanupMerchant(b.merchantId);
  }
});

test('GET /notifications/recipient-count for merchant B\'s cardId, as merchant A, 404s and reveals no count', async () => {
  const a = await makeMerchantFixture('crossA2', 0);
  const b = await makeMerchantFixture('crossB2', 5);
  try {
    const res = await fetch(`${server.baseUrl}/notifications/recipient-count?cardId=${b.cardId}`, {
      headers: { Cookie: a.cookie },
    });
    assert.equal(res.status, 404);
    const json = (await res.json()) as { ok: boolean; count: number };
    assert.equal(json.ok, false);
    assert.equal(json.count, 0, "must not leak merchant B's real recipient count (5) to merchant A");
  } finally {
    await cleanupMerchant(a.merchantId);
    await cleanupMerchant(b.merchantId);
  }
});

test('GET /notifications/jobs/:id for a job merchant B created 404s for merchant A', async () => {
  const a = await makeMerchantFixture('crossA3', 0);
  const b = await makeMerchantFixture('crossB3', 2);
  try {
    const sendRes = await fetch(`${server.baseUrl}/notifications/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: b.cookie },
      body: JSON.stringify({ cardId: b.cardId, message: "B's own broadcast" }),
    });
    assert.equal(sendRes.status, 200);
    const sendJson = (await sendRes.json()) as { ok: boolean; job: { id: string } };
    assert.equal(sendJson.ok, true);

    const res = await fetch(`${server.baseUrl}/notifications/jobs/${sendJson.job.id}`, { headers: { Cookie: a.cookie } });
    assert.equal(res.status, 404, "merchant A must never be able to read merchant B's job status");
  } finally {
    await cleanupMerchant(a.merchantId);
    await cleanupMerchant(b.merchantId);
  }
});

// ---------------------------------------------------------------------------
// Enqueuing returns immediately and creates one job with the right
// recipient count.
// ---------------------------------------------------------------------------

test('POST /notifications/send returns immediately (200) and creates exactly one BroadcastJob with the right recipient count', async () => {
  const fx = await makeMerchantFixture('send1', 7);
  try {
    const started = Date.now();
    const res = await fetch(`${server.baseUrl}/notifications/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: fx.cookie },
      body: JSON.stringify({ cardId: fx.cardId, message: 'Half price today!' }),
    });
    const elapsedMs = Date.now() - started;
    assert.equal(res.status, 200);
    // Generous upper bound — the point is proving this is a plain INSERT,
    // not a fan-out that waits on any push; a real deployment answers in
    // low tens of milliseconds. A slow CI box still shouldn't need
    // anywhere close to a second for one row.
    assert.ok(elapsedMs < 2000, `expected an immediate response, took ${elapsedMs}ms`);

    const json = (await res.json()) as { ok: boolean; job: { id: string; status: string; recipientCount: number } };
    assert.equal(json.ok, true);
    assert.equal(json.job.recipientCount, 7);
    assert.ok(['queued', 'sending', 'sent'].includes(json.job.status));

    const jobCount = await prisma.broadcastJob.count({ where: { cardId: fx.cardId } });
    assert.equal(jobCount, 1, 'exactly one job must have been created');

    const recipientCount = await prisma.broadcastRecipient.count({ where: { jobId: json.job.id } });
    assert.equal(recipientCount, 7);
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('POST /notifications/send with an empty message is rejected (400) and creates no job', async () => {
  const fx = await makeMerchantFixture('send2', 2);
  try {
    const res = await fetch(`${server.baseUrl}/notifications/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: fx.cookie },
      body: JSON.stringify({ cardId: fx.cardId, message: '   ' }),
    });
    assert.equal(res.status, 400);
    const jobCount = await prisma.broadcastJob.count({ where: { cardId: fx.cardId } });
    assert.equal(jobCount, 0);
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('GET /notifications/recipient-count returns the live count for the merchant\'s own card', async () => {
  const fx = await makeMerchantFixture('count1', 4);
  try {
    const res = await fetch(`${server.baseUrl}/notifications/recipient-count?cardId=${fx.cardId}`, {
      headers: { Cookie: fx.cookie },
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { ok: boolean; count: number };
    assert.equal(json.ok, true);
    assert.equal(json.count, 4);
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

// ---------------------------------------------------------------------------
// Per-merchant broadcast rate limit — "a mistake cannot fire fifty in a
// minute."
// ---------------------------------------------------------------------------

test('sending more broadcasts than the per-merchant limit allows is refused with 429, and does not create a job', async () => {
  const fx = await makeMerchantFixture('ratelimit1', 1);
  try {
    let sawLimit = false;
    let jobsCreated = 0;
    for (let i = 0; i < 8; i++) {
      const res = await fetch(`${server.baseUrl}/notifications/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: fx.cookie },
        body: JSON.stringify({ cardId: fx.cardId, message: `Message number ${i}` }),
      });
      if (res.status === 429) {
        sawLimit = true;
        break;
      }
      assert.equal(res.status, 200, `attempt ${i} should succeed until the limit kicks in`);
      jobsCreated++;
    }
    assert.ok(sawLimit, 'enough broadcasts in a row must eventually be rate-limited (429) — "a mistake cannot fire fifty in a minute"');

    const actualJobCount = await prisma.broadcastJob.count({ where: { cardId: fx.cardId } });
    assert.equal(actualJobCount, jobsCreated, 'the rate-limited attempt itself must not have created a job');
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});
