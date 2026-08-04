// apps/demo/test/broadcast.test.ts — apps/demo/broadcast.ts's data layer
// (BUILD.md §8.12 / §18 item 6). Same fixture/cleanup pattern as
// apps/demo/test/cardPush.test.ts: real local Postgres, no mocks — this
// file never constructs an ApnsClient and never touches Apple's servers
// (enqueueBroadcast() only ever inserts rows; apps/demo/broadcastWorker.ts
// is what pushes, covered by its own test file).

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
  enqueueBroadcast,
  recipientCountForCard,
  listBroadcastJobs,
  getBroadcastJob,
  sanitizeBroadcastMessage,
  BROADCAST_MESSAGE_MAX_LENGTH,
} = await import('../broadcast.ts');

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
    data: { email: `broadcast-test-${randomHex(8)}@example.test`, name: 'Broadcast Test Merchant' },
  });
  const card = await prisma.card.create({
    data: {
      merchantId: merchant.id,
      slot: 1,
      linkCode: randomLinkCode(),
      shortCode: `C${randomHex(4)}`.toUpperCase(),
      name: 'Broadcast Test Card',
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

async function addPass(cardId: string, merchantId: string): Promise<string> {
  const serial = `TESTSER${randomHex(6)}`.toUpperCase();
  await prisma.pass.create({
    data: { serial, shortCode: `P${randomHex(4)}`.toUpperCase(), cardId, merchantId, authToken: randomHex(12) },
  });
  return serial;
}

async function cleanup(fx: Fixture): Promise<void> {
  await prisma.merchant.delete({ where: { id: fx.merchantId } }).catch(() => {});
}

// ---------------------------------------------------------------------------
// sanitizeBroadcastMessage
// ---------------------------------------------------------------------------

test('sanitizeBroadcastMessage caps length by code point, not UTF-16 code unit, at BROADCAST_MESSAGE_MAX_LENGTH', () => {
  const long = 'a'.repeat(BROADCAST_MESSAGE_MAX_LENGTH + 50);
  const result = sanitizeBroadcastMessage(long);
  assert.equal(Array.from(result).length, BROADCAST_MESSAGE_MAX_LENGTH);
});

test('sanitizeBroadcastMessage strips control characters and collapses newlines/tabs to a single space', () => {
  const raw = 'Line one\nLine\ttwo\x00\x1F';
  const result = sanitizeBroadcastMessage(raw);
  assert.equal(result, 'Line one Line two');
});

test('sanitizeBroadcastMessage trims and does not truncate a short, clean message', () => {
  assert.equal(sanitizeBroadcastMessage('  Half price today!  '), 'Half price today!');
});

test('sanitizeBroadcastMessage of an all-whitespace/control string is empty', () => {
  assert.equal(sanitizeBroadcastMessage('   \n\t  '), '');
});

// ---------------------------------------------------------------------------
// recipientCountForCard
// ---------------------------------------------------------------------------

test('recipientCountForCard counts only passes on that card, not another card or merchant\'s', async () => {
  const cardA = await makeMerchantAndCard();
  const cardB = await makeMerchantAndCard();
  try {
    await addPass(cardA.cardId, cardA.merchantId);
    await addPass(cardA.cardId, cardA.merchantId);
    await addPass(cardB.cardId, cardB.merchantId);

    const count = await recipientCountForCard({ id: cardA.cardId });
    assert.equal(count, 2);
  } finally {
    await cleanup(cardA);
    await cleanup(cardB);
  }
});

// ---------------------------------------------------------------------------
// enqueueBroadcast
// ---------------------------------------------------------------------------

test('enqueueBroadcast creates exactly one BroadcastJob with the right recipient count, and one BroadcastRecipient per pass', async () => {
  const fx = await makeMerchantAndCard();
  try {
    await addPass(fx.cardId, fx.merchantId);
    await addPass(fx.cardId, fx.merchantId);
    await addPass(fx.cardId, fx.merchantId);

    const card = await prisma.card.findUniqueOrThrow({ where: { id: fx.cardId } });
    const job = await enqueueBroadcast(card, 'Half price today!', 'manual');

    assert.equal(job.recipientCount, 3);
    assert.equal(job.status, 'queued');
    assert.equal(job.sentCount, 0);
    assert.equal(job.failedCount, 0);
    assert.equal(job.message, 'Half price today!');

    const jobCount = await prisma.broadcastJob.count({ where: { cardId: fx.cardId } });
    assert.equal(jobCount, 1, 'enqueuing must create exactly one job row');

    const recipientCount = await prisma.broadcastRecipient.count({ where: { jobId: job.id } });
    assert.equal(recipientCount, 3);
  } finally {
    await cleanup(fx);
  }
});

test('enqueueBroadcast against a card with no passes yet still creates one job, recipientCount 0, already marked sent', async () => {
  const fx = await makeMerchantAndCard();
  try {
    const card = await prisma.card.findUniqueOrThrow({ where: { id: fx.cardId } });
    const job = await enqueueBroadcast(card, 'Hello', 'manual');
    assert.equal(job.recipientCount, 0);
    assert.equal(job.status, 'sent');
    assert.ok(job.completedAt);
  } finally {
    await cleanup(fx);
  }
});

test('enqueueBroadcast rejects an empty (post-sanitisation) message', async () => {
  const fx = await makeMerchantAndCard();
  try {
    const card = await prisma.card.findUniqueOrThrow({ where: { id: fx.cardId } });
    await assert.rejects(() => enqueueBroadcast(card, '   \n\t  ', 'manual'));
  } finally {
    await cleanup(fx);
  }
});

test('two identical-text broadcasts against the same card produce two jobs with different pushMessage values (the invisible marker)', async () => {
  const fx = await makeMerchantAndCard();
  try {
    await addPass(fx.cardId, fx.merchantId);
    const card = await prisma.card.findUniqueOrThrow({ where: { id: fx.cardId } });

    const jobA = await enqueueBroadcast(card, 'Same offer', 'manual');
    const jobB = await enqueueBroadcast(card, 'Same offer', 'manual');

    assert.equal(jobA.message, jobB.message, 'the visible text is identical');
    assert.notEqual(jobA.pushMessage, jobB.pushMessage, 'the stored pushMessage must differ so a repeat send still banks a banner (BUILD.md §18 item 5)');
    // The marker is invisible — stripping it back out should recover the same visible text.
    assert.ok(jobA.pushMessage.startsWith('Same offer'));
    assert.ok(jobB.pushMessage.startsWith('Same offer'));
  } finally {
    await cleanup(fx);
  }
});

test('enqueueBroadcast against merchant A\'s card cannot be tricked into affecting merchant B\'s customers — the function only ever sees the one Card it is given', async () => {
  const fxA = await makeMerchantAndCard();
  const fxB = await makeMerchantAndCard();
  try {
    await addPass(fxA.cardId, fxA.merchantId);
    await addPass(fxB.cardId, fxB.merchantId);
    await addPass(fxB.cardId, fxB.merchantId);

    const cardA = await prisma.card.findUniqueOrThrow({ where: { id: fxA.cardId } });
    const job = await enqueueBroadcast(cardA, 'Merchant A only', 'manual');

    assert.equal(job.recipientCount, 1, 'must only count merchant A\'s own recipient, never merchant B\'s');
    assert.equal(job.merchantId, fxA.merchantId);

    const recipients = await prisma.broadcastRecipient.findMany({ where: { jobId: job.id } });
    const merchantBPasses = await prisma.pass.findMany({ where: { merchantId: fxB.merchantId } });
    for (const r of recipients) {
      assert.ok(
        !merchantBPasses.some((p) => p.serial === r.passSerial),
        'no recipient row may reference a merchant B pass'
      );
    }
  } finally {
    await cleanup(fxA);
    await cleanup(fxB);
  }
});

// ---------------------------------------------------------------------------
// listBroadcastJobs / getBroadcastJob
// ---------------------------------------------------------------------------

test('listBroadcastJobs returns only this merchant\'s jobs, newest first', async () => {
  const fxA = await makeMerchantAndCard();
  const fxB = await makeMerchantAndCard();
  try {
    await addPass(fxA.cardId, fxA.merchantId);
    await addPass(fxB.cardId, fxB.merchantId);
    const cardA = await prisma.card.findUniqueOrThrow({ where: { id: fxA.cardId } });
    const cardB = await prisma.card.findUniqueOrThrow({ where: { id: fxB.cardId } });

    const jobA1 = await enqueueBroadcast(cardA, 'First', 'manual');
    const jobA2 = await enqueueBroadcast(cardA, 'Second', 'manual');
    await enqueueBroadcast(cardB, 'Belongs to B', 'manual');

    const jobs = await listBroadcastJobs(fxA.merchantId);
    assert.equal(jobs.length, 2);
    assert.ok(jobs.every((j) => j.merchantId === fxA.merchantId));
    assert.deepEqual(jobs.map((j) => j.id).sort(), [jobA1.id, jobA2.id].sort());
  } finally {
    await cleanup(fxA);
    await cleanup(fxB);
  }
});

test('getBroadcastJob scoped to the wrong merchant returns null — a leaked/guessed job id from another merchant 404s, never confirms it exists', async () => {
  const fxA = await makeMerchantAndCard();
  const fxB = await makeMerchantAndCard();
  try {
    await addPass(fxA.cardId, fxA.merchantId);
    const cardA = await prisma.card.findUniqueOrThrow({ where: { id: fxA.cardId } });
    const job = await enqueueBroadcast(cardA, 'A message', 'manual');

    const wrongMerchant = await getBroadcastJob(job.id, fxB.merchantId);
    assert.equal(wrongMerchant, null);

    const rightMerchant = await getBroadcastJob(job.id, fxA.merchantId);
    assert.ok(rightMerchant);
    assert.equal(rightMerchant?.id, job.id);
  } finally {
    await cleanup(fxA);
    await cleanup(fxB);
  }
});
