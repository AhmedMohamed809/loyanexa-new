// apps/demo/test/broadcastWorker.test.ts — apps/demo/broadcastWorker.ts,
// the consumer side of the Postgres-backed broadcast queue (BUILD.md
// §8.12 / §18 item 6 / §10). Real local Postgres, no mocks — `sendOne` is
// always a stub injected by each test (this file never constructs an
// ApnsClient and never touches Apple's servers, per the job's own "do not
// contact Apple from a test" constraint).
//
// The one thing this file exists to prove, above everything else: running
// two BroadcastWorker instances concurrently against the same queue rows
// never sends to the same recipient twice. That's `SELECT … FOR UPDATE
// SKIP LOCKED` doing its job — see broadcastWorker.ts's own file header
// comment for the full claim query.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from '../env.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnvFile(path.join(__dirname, '../../../.env'));

const { prisma } = await import('../../../packages/db/src/index.ts');
const { enqueueBroadcast } = await import('../broadcast.ts');
const { BroadcastWorker } = await import('../broadcastWorker.ts');
type SendPushOutcome = { ok: true } | { ok: false; gone?: boolean; error?: string };
type Device = { deviceId: string; passSerial: string; pushToken: string };

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}
function randomLinkCode(): number {
  return 500_000_000 + Math.floor(Math.random() * 500_000_000);
}

interface Fixture {
  merchantId: string;
  cardId: string;
}

async function makeMerchantAndCard(): Promise<Fixture> {
  const merchant = await prisma.merchant.create({
    data: { email: `broadcastworker-test-${randomHex(8)}@example.test`, name: 'Broadcast Worker Test Merchant' },
  });
  const card = await prisma.card.create({
    data: {
      merchantId: merchant.id,
      slot: 1,
      linkCode: randomLinkCode(),
      shortCode: `C${randomHex(4)}`.toUpperCase(),
      name: 'Broadcast Worker Test Card',
      stampsGoal: 8,
      bgColor: '#203757',
      fgColor: '#FFFFFF',
      stampActive: '#F96400',
      stampInactive: '#8794A5',
      rewardText: 'Free coffee',
      active: true,
    },
  });
  return { merchantId: merchant.id, cardId: card.id };
}

async function addPassWithDevices(cardId: string, merchantId: string, deviceCount = 1): Promise<string> {
  const serial = `TESTSER${randomHex(6)}`.toUpperCase();
  await prisma.pass.create({
    data: { serial, shortCode: `P${randomHex(4)}`.toUpperCase(), cardId, merchantId, authToken: randomHex(12) },
  });
  for (let i = 0; i < deviceCount; i++) {
    await prisma.device.create({
      data: { deviceId: `dev-${randomHex(8)}`, passSerial: serial, pushToken: `token-${randomHex(16)}` },
    });
  }
  return serial;
}

async function cleanup(fx: Fixture): Promise<void> {
  await prisma.merchant.delete({ where: { id: fx.merchantId } }).catch(() => {});
}

/** A sendOne stub that always succeeds and records every call it received, keyed by pushToken. */
function makeRecordingSender(): { sendOne: (device: Device) => Promise<SendPushOutcome>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    sendOne: async (device: Device) => {
      calls.push(device.pushToken);
      return { ok: true };
    },
  };
}

async function drainAll(worker: InstanceType<typeof BroadcastWorker>, maxCycles = 50): Promise<void> {
  for (let i = 0; i < maxCycles; i++) {
    const claimed = await worker.runOnce();
    if (claimed === 0) return;
  }
  throw new Error('drainAll: queue never emptied within maxCycles — a test bug, not real infrastructure behaviour');
}

// ---------------------------------------------------------------------------
// Basic delivery
// ---------------------------------------------------------------------------

test('the worker sends to every recipient exactly once, and marks the job sent with the right counts', async () => {
  const fx = await makeMerchantAndCard();
  try {
    const serials = await Promise.all([
      addPassWithDevices(fx.cardId, fx.merchantId),
      addPassWithDevices(fx.cardId, fx.merchantId),
      addPassWithDevices(fx.cardId, fx.merchantId),
    ]);
    const card = await prisma.card.findUniqueOrThrow({ where: { id: fx.cardId } });
    const job = await enqueueBroadcast(card, 'Half price today!', 'manual');

    const { sendOne, calls } = makeRecordingSender();
    const worker = new BroadcastWorker({ sendOne, batchSize: 10, pushIntervalMs: 0 });
    await drainAll(worker);

    assert.equal(calls.length, 3, 'exactly one push per recipient (one device each)');

    const finished = await prisma.broadcastJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(finished.status, 'sent');
    assert.equal(finished.sentCount, 3);
    assert.equal(finished.failedCount, 0);
    assert.ok(finished.completedAt);

    for (const serial of serials) {
      const pass = await prisma.pass.findUniqueOrThrow({ where: { serial } });
      assert.equal(pass.message, job.pushMessage, "Pass.message must be set to the job's pushMessage");
    }

    const recipients = await prisma.broadcastRecipient.findMany({ where: { jobId: job.id } });
    assert.ok(recipients.every((r) => r.status === 'sent'));
    assert.ok(recipients.every((r) => r.attempts === 1), 'a clean send should only ever be claimed once');
  } finally {
    await cleanup(fx);
  }
});

test('a recipient with no registered devices yet is still marked sent (message stored, nothing to push to)', async () => {
  const fx = await makeMerchantAndCard();
  try {
    const serial = `TESTSER${randomHex(6)}`.toUpperCase();
    await prisma.pass.create({
      data: { serial, shortCode: `P${randomHex(4)}`.toUpperCase(), cardId: fx.cardId, merchantId: fx.merchantId, authToken: randomHex(12) },
    });
    const card = await prisma.card.findUniqueOrThrow({ where: { id: fx.cardId } });
    const job = await enqueueBroadcast(card, 'No devices yet', 'manual');

    const { sendOne, calls } = makeRecordingSender();
    const worker = new BroadcastWorker({ sendOne, pushIntervalMs: 0 });
    await drainAll(worker);

    assert.equal(calls.length, 0);
    const finished = await prisma.broadcastJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(finished.status, 'sent');
    assert.equal(finished.sentCount, 1);

    const pass = await prisma.pass.findUniqueOrThrow({ where: { serial } });
    assert.equal(pass.message, job.pushMessage, 'the message must still be stored even with no devices to wake yet');
  } finally {
    await cleanup(fx);
  }
});

// ---------------------------------------------------------------------------
// The core safety property: two workers running concurrently never
// double-send. This is what SELECT ... FOR UPDATE SKIP LOCKED is for.
// ---------------------------------------------------------------------------

test('two BroadcastWorker instances running concurrently against the same queue never claim the same recipient — no recipient is pushed twice', async () => {
  const fx = await makeMerchantAndCard();
  try {
    const RECIPIENT_COUNT = 40;
    for (let i = 0; i < RECIPIENT_COUNT; i++) {
      await addPassWithDevices(fx.cardId, fx.merchantId, 1);
    }
    const card = await prisma.card.findUniqueOrThrow({ where: { id: fx.cardId } });
    const job = await enqueueBroadcast(card, 'Concurrent test broadcast', 'manual');
    assert.equal(job.recipientCount, RECIPIENT_COUNT);

    // Each worker's sendOne appends into ITS OWN array first, then a small
    // artificial delay before resolving — real network latency, exaggerated
    // on purpose so the two workers' claim-and-process cycles genuinely
    // overlap in time rather than one finishing before the other starts.
    const callsByToken: string[] = [];
    async function sendOne(device: Device): Promise<SendPushOutcome> {
      callsByToken.push(device.pushToken);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: true };
    }

    const workerA = new BroadcastWorker({ sendOne, batchSize: 6, pushIntervalMs: 0 });
    const workerB = new BroadcastWorker({ sendOne, batchSize: 6, pushIntervalMs: 0 });

    // Drive both workers' cycles concurrently until the queue is
    // DB-confirmed empty — exactly the scenario two machines running this
    // worker in production would produce. Termination is checked against
    // the database on a wall-clock deadline, not a fixed round count:
    // under real contention (e.g. this whole suite's other spawned server
    // processes sharing the same local Postgres), a single round can
    // legitimately return 0-and-0 while unclaimed rows still remain — both
    // queries' `FOR UPDATE SKIP LOCKED` candidate scans overlapped and
    // neither happened to win a lock that instant — and DB round-trip
    // latency itself varies with how busy the box is. That's a timing
    // artefact of true concurrency and shared-resource contention, not a
    // stuck queue, and the next round always makes progress; a fixed round
    // budget ties the test's patience to how fast any given machine
    // happens to be. A production poll loop would simply try again next
    // interval; this test does the same, generously, rather than mistaking
    // one slow environment for "done".
    const deadline = Date.now() + 30_000;
    let remaining = RECIPIENT_COUNT;
    while (Date.now() < deadline) {
      await Promise.all([workerA.runOnce(), workerB.runOnce()]);
      remaining = await prisma.broadcastRecipient.count({
        where: { jobId: job.id, status: { in: ['pending', 'sending'] } },
      });
      if (remaining === 0) break;
    }
    assert.equal(remaining, 0, 'the queue must drain within the deadline — otherwise something really is stuck');

    assert.equal(callsByToken.length, RECIPIENT_COUNT, 'every recipient must be pushed exactly once in total, across both workers combined');
    assert.equal(new Set(callsByToken).size, RECIPIENT_COUNT, 'no push token may appear twice — that would mean the same recipient was claimed by both workers');

    const finished = await prisma.broadcastJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(finished.status, 'sent');
    assert.equal(finished.sentCount, RECIPIENT_COUNT);
    assert.equal(finished.failedCount, 0);

    const recipients = await prisma.broadcastRecipient.findMany({ where: { jobId: job.id } });
    assert.ok(recipients.every((r) => r.status === 'sent'));
    assert.ok(recipients.every((r) => r.attempts === 1), 'no recipient should have needed more than one claim — proves no row was claimed, lost, and re-claimed');
  } finally {
    await cleanup(fx);
  }
});

// ---------------------------------------------------------------------------
// Retry / backoff / bounded failure
// ---------------------------------------------------------------------------

test('a failing push is retried up to maxAttempts, then the recipient is marked failed with a reason, and the job still completes', async () => {
  const fx = await makeMerchantAndCard();
  try {
    await addPassWithDevices(fx.cardId, fx.merchantId, 1);
    const card = await prisma.card.findUniqueOrThrow({ where: { id: fx.cardId } });
    const job = await enqueueBroadcast(card, 'Always fails', 'manual');

    let callCount = 0;
    const sendOne = async (): Promise<SendPushOutcome> => {
      callCount++;
      return { ok: false, error: 'simulated Apple 500' };
    };

    // backoffBaseMs: 0 so retries are immediately claimable (nextAttemptAt
    // <= now with no real wait) — this test is about the *count* of
    // attempts and the terminal state, not real backoff timing (covered by
    // the next test).
    const worker = new BroadcastWorker({ sendOne, maxAttempts: 3, backoffBaseMs: 0, pushIntervalMs: 0 });
    await drainAll(worker, 20);

    assert.equal(callCount, 3, 'must retry exactly up to maxAttempts, not indefinitely');

    const recipient = await prisma.broadcastRecipient.findFirstOrThrow({ where: { jobId: job.id } });
    assert.equal(recipient.status, 'failed');
    assert.equal(recipient.attempts, 3);
    assert.equal(recipient.lastError, 'simulated Apple 500');

    const finished = await prisma.broadcastJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(finished.status, 'sent', 'the job itself reaches its terminal state once every recipient is terminal, even if some failed');
    assert.equal(finished.sentCount, 0);
    assert.equal(finished.failedCount, 1);
  } finally {
    await cleanup(fx);
  }
});

test('a failed attempt schedules the retry in the future via backoff — it is not immediately reclaimable', async () => {
  const fx = await makeMerchantAndCard();
  try {
    await addPassWithDevices(fx.cardId, fx.merchantId, 1);
    const card = await prisma.card.findUniqueOrThrow({ where: { id: fx.cardId } });
    const job = await enqueueBroadcast(card, 'Fails once then would succeed', 'manual');
    const recipient = await prisma.broadcastRecipient.findFirstOrThrow({ where: { jobId: job.id } });

    let callCount = 0;
    const sendOne = async (): Promise<SendPushOutcome> => {
      callCount++;
      return { ok: false, error: 'transient' };
    };

    // claimed/secondClaim below are asserted loosely (>= our own row, not
    // strictly equal): runOnce() claims globally across the whole queue
    // table (correct — see broadcastWorker.ts's own file comment), and
    // this suite runs many test files concurrently against one shared
    // local Postgres, so an unrelated file's own in-flight fixture can
    // legitimately be sitting in the table at the same instant. What this
    // test actually needs proven — that *our* recipient specifically was
    // claimed once and then not reclaimed before its own backoff — is
    // checked directly against that row by id below, which is unaffected
    // by whatever else may or may not have been claimed alongside it.
    const worker = new BroadcastWorker({ sendOne, maxAttempts: 5, backoffBaseMs: 60_000, pushIntervalMs: 0 });
    const firstClaim = await worker.runOnce();
    assert.ok(firstClaim >= 1);
    assert.equal(callCount, 1, 'exactly one push attempt for our one device — device-scoped, so unaffected by any other test\'s concurrently-running fixture');

    const afterFirst = await prisma.broadcastRecipient.findUniqueOrThrow({ where: { id: recipient.id } });
    assert.equal(afterFirst.status, 'pending');
    assert.equal(afterFirst.attempts, 1);
    assert.ok(afterFirst.nextAttemptAt.getTime() > Date.now() + 30_000, 'backoff must push nextAttemptAt well into the future');

    // Immediately trying again must not reclaim *our* recipient — it is
    // pending but its own nextAttemptAt is a minute in the future.
    await worker.runOnce();
    assert.equal(callCount, 1, 'no second push attempt for our device before its backoff elapses');

    const afterSecond = await prisma.broadcastRecipient.findUniqueOrThrow({ where: { id: recipient.id } });
    assert.equal(afterSecond.attempts, 1, 'our row must not have been reclaimed a second time before its own nextAttemptAt');
    assert.equal(afterSecond.status, 'pending');
  } finally {
    await cleanup(fx);
  }
});

// ---------------------------------------------------------------------------
// Crash recovery: a stale "sending" claim is reclaimed, not lost — and
// never re-writes Pass.message with a fresh marker (which would re-show a
// banner a device already caught up on).
// ---------------------------------------------------------------------------

test('a stale claimed-but-never-finished recipient (simulating a crashed worker) is reclaimed by a later runOnce() and completes — the message is not re-marked', async () => {
  const fx = await makeMerchantAndCard();
  try {
    const serial = await addPassWithDevices(fx.cardId, fx.merchantId, 1);
    const card = await prisma.card.findUniqueOrThrow({ where: { id: fx.cardId } });
    const job = await enqueueBroadcast(card, 'Crash recovery test', 'manual');

    // Simulate: a previous worker claimed this row and even got as far as
    // writing Pass.message, then the process died before recording the
    // push result. staleClaimMs is tiny here so the *next* runOnce() call
    // (a fresh worker instance, as a restarted process would be) reclaims
    // it without waiting real wall-clock time.
    const recipient = await prisma.broadcastRecipient.findFirstOrThrow({ where: { jobId: job.id } });
    const staleClaimAt = new Date(Date.now() - 10_000);
    await prisma.broadcastRecipient.update({
      where: { id: recipient.id },
      data: { status: 'sending', attempts: 1, claimedAt: staleClaimAt },
    });
    await prisma.pass.update({ where: { serial }, data: { message: job.pushMessage } });

    const { sendOne, calls } = makeRecordingSender();
    const worker = new BroadcastWorker({ sendOne, staleClaimMs: 1_000, pushIntervalMs: 0 });
    // Asserted loosely (>= 1), not strictly 1: runOnce() claims globally
    // across the whole queue (correct, real production behaviour), and
    // this suite runs many test files concurrently against one shared
    // local Postgres — an unrelated file's own fixture can legitimately
    // be pending in the table at this exact instant. The precise claim
    // this test exists to prove — that *our* specific stale row was
    // reclaimed and pushed exactly once — is checked directly below,
    // scoped to `recipient.id`/`serial`, which contamination from another
    // file cannot affect.
    const claimed = await worker.runOnce();
    assert.ok(claimed >= 1, 'the stale row must be reclaimed');
    assert.equal(calls.length, 1, 'exactly one push must be sent on the reclaim, for our one device — device-scoped, so unaffected by any other test\'s concurrently-running fixture');

    const finished = await prisma.broadcastRecipient.findUniqueOrThrow({ where: { id: recipient.id } });
    assert.equal(finished.status, 'sent');
    assert.equal(finished.attempts, 2, 'the reclaim counts as a second attempt');

    const pass = await prisma.pass.findUniqueOrThrow({ where: { serial } });
    assert.equal(pass.message, job.pushMessage, 'the reclaim writes the exact same pushMessage — never a freshly re-marked one, which would re-show a banner a device already saw');
  } finally {
    await cleanup(fx);
  }
});

// ---------------------------------------------------------------------------
// Out-of-order retries across *different* broadcasts to the same pass — the
// scenario the final whole-branch review flagged: job 1's push fails and
// backs off (up to 5 minutes) while job 2 is enqueued and lands cleanly;
// job 1's retry must not then resurrect its older text over job 2's newer
// one on the customer's pass.
// ---------------------------------------------------------------------------

test("an out-of-order retry of an older broadcast never overwrites a newer broadcast's message on the same pass", async () => {
  const fx = await makeMerchantAndCard();
  try {
    const serial = await addPassWithDevices(fx.cardId, fx.merchantId, 1);
    const card = await prisma.card.findUniqueOrThrow({ where: { id: fx.cardId } });

    // Job 1 (older): its first attempt fails and would normally back off
    // for 5 minutes before retrying.
    const job1 = await enqueueBroadcast(card, 'Old broadcast', 'manual');
    const failingSend = async (): Promise<SendPushOutcome> => ({ ok: false, error: 'simulated failure' });
    const worker1 = new BroadcastWorker({ sendOne: failingSend, maxAttempts: 5, backoffBaseMs: 5 * 60_000, batchSize: 50, pushIntervalMs: 0 });
    await worker1.runOnce();

    const recipient1 = await prisma.broadcastRecipient.findFirstOrThrow({ where: { jobId: job1.id } });
    assert.equal(recipient1.status, 'pending', "job 1's failed first attempt must be pending its retry, not terminal");
    assert.equal(recipient1.attempts, 1);

    const passAfterJob1FirstAttempt = await prisma.pass.findUniqueOrThrow({ where: { serial } });
    assert.equal(
      passAfterJob1FirstAttempt.message,
      job1.pushMessage,
      "job 1's own first attempt writes its own message, as normal — nothing has raced it yet"
    );

    // Job 2 (newer): enqueued and fully delivered while job 1 is still
    // sitting out its backoff.
    const job2 = await enqueueBroadcast(card, 'New broadcast', 'manual');
    assert.ok(job2.createdAt.getTime() >= job1.createdAt.getTime(), 'job 2 must genuinely be the newer job for this test to mean anything');
    const { sendOne: succeedingSend } = makeRecordingSender();
    const worker2 = new BroadcastWorker({ sendOne: succeedingSend, batchSize: 50, pushIntervalMs: 0 });
    await drainAll(worker2);

    const passAfterJob2 = await prisma.pass.findUniqueOrThrow({ where: { serial } });
    assert.equal(passAfterJob2.message, job2.pushMessage, 'job 2 must win — it is the newer broadcast and it completed cleanly');

    // Force job 1's retry to be immediately claimable, bypassing its real
    // 5-minute backoff — simulating that backoff having now elapsed,
    // *after* job 2 already completed. This is the out-of-order landing
    // the review describes.
    await prisma.broadcastRecipient.update({ where: { id: recipient1.id }, data: { nextAttemptAt: new Date(0) } });
    const worker1Retry = new BroadcastWorker({ sendOne: succeedingSend, maxAttempts: 5, backoffBaseMs: 5 * 60_000, batchSize: 50, pushIntervalMs: 0 });
    await worker1Retry.runOnce();

    const recipient1After = await prisma.broadcastRecipient.findUniqueOrThrow({ where: { id: recipient1.id } });
    assert.equal(recipient1After.status, 'sent', "job 1's retry itself still succeeds and reaches a terminal state — only the message write is guarded, not the push");

    const passAfterJob1Retry = await prisma.pass.findUniqueOrThrow({ where: { serial } });
    assert.equal(
      passAfterJob1Retry.message,
      job2.pushMessage,
      "job 1's out-of-order retry must NOT resurrect its older message over job 2's newer one"
    );
  } finally {
    await cleanup(fx);
  }
});

// ---------------------------------------------------------------------------
// 410 Gone
// ---------------------------------------------------------------------------

test('a 410 Gone result deletes the Device row and still marks the recipient sent', async () => {
  const fx = await makeMerchantAndCard();
  try {
    const serial = await addPassWithDevices(fx.cardId, fx.merchantId, 1);
    const card = await prisma.card.findUniqueOrThrow({ where: { id: fx.cardId } });
    const job = await enqueueBroadcast(card, 'Gone device test', 'manual');

    const sendOne = async (): Promise<SendPushOutcome> => ({ ok: false, gone: true });
    const worker = new BroadcastWorker({ sendOne, pushIntervalMs: 0 });
    await drainAll(worker);

    const devices = await prisma.device.findMany({ where: { passSerial: serial } });
    assert.equal(devices.length, 0, '410 Gone must prune the Device row');

    const finished = await prisma.broadcastJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(finished.status, 'sent');
    assert.equal(finished.sentCount, 1, 'a gone device is not a failure for the recipient — nothing else to do');
    assert.equal(finished.failedCount, 0);
  } finally {
    await cleanup(fx);
  }
});

// ---------------------------------------------------------------------------
// start()/stop() lifecycle — never crash-loops, cleans up its timer.
// ---------------------------------------------------------------------------

test('start() then stop() processes queued work and leaves no dangling timer', async () => {
  const fx = await makeMerchantAndCard();
  try {
    await addPassWithDevices(fx.cardId, fx.merchantId, 1);
    const card = await prisma.card.findUniqueOrThrow({ where: { id: fx.cardId } });
    const job = await enqueueBroadcast(card, 'start/stop test', 'manual');

    const { sendOne } = makeRecordingSender();
    const worker = new BroadcastWorker({ sendOne, pollIntervalMs: 20, pushIntervalMs: 0 });
    worker.start();

    const deadline = Date.now() + 5_000;
    let status = 'queued';
    while (Date.now() < deadline) {
      const current = await prisma.broadcastJob.findUniqueOrThrow({ where: { id: job.id } });
      status = current.status;
      if (status === 'sent') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(status, 'sent');

    await worker.stop();
  } finally {
    await cleanup(fx);
  }
});
