// apps/demo/test/welcomeAutomation.test.ts — the "welcome" automated
// broadcast (BUILD.md §8.12's Automated tab), built end to end: fires once
// per genuine new enrolment. Spawns the real server.ts child process
// against the real local Postgres and real Apple signing certs (same
// pattern as apps/demo/test/httpIntegration.test.ts) — POST /:code/pass
// is a real, unauthenticated enrolment, exactly as a customer's browser
// would call it. Never touches Apple's push servers: this only proves the
// BroadcastJob got enqueued, not that a push was sent (that's
// apps/demo/broadcastWorker.ts's own test file, which never constructs an
// ApnsClient either).

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
  return 49000 + Math.floor(Math.random() * 3000);
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

async function makeActiveCard(lang: 'en' | 'ar' = 'en'): Promise<{ merchantId: string; card: Awaited<ReturnType<typeof prisma.card.create>> }> {
  const merchant = await prisma.merchant.create({
    data: { email: `welcome-test-${randomHex(8)}@example.test`, name: 'Welcome Automation Test Merchant' },
  });
  const card = await prisma.card.create({
    data: {
      merchantId: merchant.id,
      slot: 1,
      linkCode: randomLinkCode(),
      shortCode: `C${randomHex(4)}`.toUpperCase(),
      name: 'Welcome Test Card',
      stampsGoal: 8,
      bgColor: '#203757',
      fgColor: '#FFFFFF',
      stampActive: '#F96400',
      stampInactive: '#8794A5',
      rewardText: 'Free coffee',
      lang,
      active: true,
    },
  });
  return { merchantId: merchant.id, card };
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

test('a new enrolment (POST /:code/pass) enqueues exactly one "welcome" BroadcastJob targeting the new pass', async () => {
  const fx = await makeActiveCard('en');
  try {
    const res = await fetch(`${server.baseUrl}/${fx.card.linkCode}/pass`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'Ahmed', phone: '0559990001' }).toString(),
    });
    assert.equal(res.status, 200);
    await res.arrayBuffer(); // drain the .pkpass body

    const pass = await prisma.pass.findFirstOrThrow({ where: { cardId: fx.card.id, custPhone: '0559990001' } });

    const jobs = await prisma.broadcastJob.findMany({ where: { cardId: fx.card.id, kind: 'welcome' } });
    assert.equal(jobs.length, 1, 'exactly one welcome job must be enqueued for this enrolment');
    assert.equal(jobs[0]?.recipientCount, 1);

    const recipient = await prisma.broadcastRecipient.findFirst({ where: { jobId: jobs[0]!.id } });
    assert.ok(recipient, 'a recipient row must exist for the welcome job');
    assert.equal(recipient?.passSerial, pass.serial, 'the welcome job must target the newly-enrolled pass, not some other one');
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('a returning customer reusing an existing pass (same phone, second enrolment) does not get welcomed a second time', async () => {
  const fx = await makeActiveCard('en');
  try {
    const body = new URLSearchParams({ name: 'Sara', phone: '0559990002' }).toString();
    const first = await fetch(`${server.baseUrl}/${fx.card.linkCode}/pass`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    assert.equal(first.status, 200);
    await first.arrayBuffer();

    const second = await fetch(`${server.baseUrl}/${fx.card.linkCode}/pass`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    assert.equal(second.status, 200);
    await second.arrayBuffer();

    const passes = await prisma.pass.findMany({ where: { cardId: fx.card.id, custPhone: '0559990002' } });
    assert.equal(passes.length, 1, 'the same phone number must reuse the same Pass row (enrol.ts\'s own idempotency)');

    const jobs = await prisma.broadcastJob.findMany({ where: { cardId: fx.card.id, kind: 'welcome' } });
    assert.equal(jobs.length, 1, 'a reused pass (returning customer) must not trigger a second welcome broadcast');
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('a second, genuinely new customer enrolling on a card that already has one customer only welcomes the new one — the existing customer is not re-targeted', async () => {
  const fx = await makeActiveCard('en');
  try {
    const first = await fetch(`${server.baseUrl}/${fx.card.linkCode}/pass`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'Existing Customer', phone: '0559990010' }).toString(),
    });
    assert.equal(first.status, 200);
    await first.arrayBuffer();
    const existingPass = await prisma.pass.findFirstOrThrow({ where: { cardId: fx.card.id, custPhone: '0559990010' } });

    const second = await fetch(`${server.baseUrl}/${fx.card.linkCode}/pass`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'New Customer', phone: '0559990011' }).toString(),
    });
    assert.equal(second.status, 200);
    await second.arrayBuffer();
    const newPass = await prisma.pass.findFirstOrThrow({ where: { cardId: fx.card.id, custPhone: '0559990011' } });

    const jobs = await prisma.broadcastJob.findMany({ where: { cardId: fx.card.id, kind: 'welcome' } });
    assert.equal(jobs.length, 2, 'each enrolment gets its own welcome job');

    for (const job of jobs) {
      assert.equal(job.recipientCount, 1, 'a welcome job must target only the customer who just enrolled, never every existing customer on the card');
    }

    const secondJob = jobs.find((j) => j.createdAt.getTime() === Math.max(...jobs.map((j) => j.createdAt.getTime())))!;
    const secondJobRecipients = await prisma.broadcastRecipient.findMany({ where: { jobId: secondJob.id } });
    assert.equal(secondJobRecipients.length, 1);
    assert.equal(secondJobRecipients[0]?.passSerial, newPass.serial, 'the second enrolment\'s welcome job must target the new pass');
    assert.notEqual(
      secondJobRecipients[0]?.passSerial,
      existingPass.serial,
      'the existing customer\'s pass must never be a recipient of a welcome job triggered by someone else\'s enrolment'
    );
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('the welcome message is localised to the card\'s own language', async () => {
  const fx = await makeActiveCard('ar');
  try {
    const res = await fetch(`${server.baseUrl}/${fx.card.linkCode}/pass`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'Layla', phone: '0559990003' }).toString(),
    });
    assert.equal(res.status, 200);
    await res.arrayBuffer();

    const job = await prisma.broadcastJob.findFirstOrThrow({ where: { cardId: fx.card.id, kind: 'welcome' } });
    // The Arabic dictionary's own notifWelcomeMessage text — asserting it's
    // not the English string is enough to prove card.lang drove the choice
    // without hardcoding the Arabic copy (which could legitimately be
    // reworded later) into this test.
    assert.notEqual(job.message, 'Welcome! Collect a stamp every visit and watch your reward get closer.');
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});
