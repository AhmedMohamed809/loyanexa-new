// apps/demo/test/ephemeralNotifications.test.ts — sub-project 9's own
// end-to-end regression test for the owner's original report: "If I send
// two notifications and after that there is a new customer, when the new
// customer installs the card in the wallet it's showing all the previous
// notifications." Real local Postgres, no mocks, and no ApnsClient — this
// file exercises apps/demo/enrol.ts, apps/demo/broadcast.ts,
// apps/demo/broadcastWorker.ts, apps/demo/messageSweeper.ts and
// apps/demo/passContent.ts together, the same combination a real request
// sequence produces, rather than any one of them in isolation (each already
// has its own unit-level test file).
//
// The root cause (found by reproducing the bug against this same local
// Postgres before writing any fix): enrolment is idempotent by phone number
// (apps/demo/enrol.ts's own doc comment) — a *genuinely* new phone number
// always gets a brand-new Pass row with no message, exactly as
// enqueueBroadcast()'s recipient snapshot already promised. What the owner
// was actually seeing was the *same* Pass being reused (an old message and
// all) whenever the "new" customer re-enrolled on a phone number the card
// already had a Pass for — most likely the owner's own phone, tested twice.
// The two behaviours this file proves side by side below make both halves
// of that finding testable at once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from '../env.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnvFile(path.join(__dirname, '../../../.env'));

const { prisma } = await import('../../../packages/db/src/index.ts');
const { createPassForEnrolment } = await import('../enrol.ts');
const { enqueueBroadcast } = await import('../broadcast.ts');
const { BroadcastWorker } = await import('../broadcastWorker.ts');
const { MessageSweeper } = await import('../messageSweeper.ts');
const { buildPassContentFor } = await import('../passContent.ts');

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
  card: Awaited<ReturnType<typeof prisma.card.create>>;
}

async function makeFixture(): Promise<Fixture> {
  const merchant = await prisma.merchant.create({
    data: { email: `ephemeral-test-${randomHex(8)}@example.test`, name: 'Ephemeral Test Merchant' },
  });
  const card = await prisma.card.create({
    data: {
      merchantId: merchant.id,
      slot: 1,
      linkCode: randomLinkCode(),
      shortCode: `C${randomHex(4)}`.toUpperCase(),
      name: 'Ephemeral Test Card',
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

async function cleanup(fx: Fixture): Promise<void> {
  await prisma.merchant.delete({ where: { id: fx.merchantId } }).catch(() => {});
}

function noopSender(): (device: Device) => Promise<SendPushOutcome> {
  return async () => ({ ok: true });
}

async function drainAll(worker: InstanceType<typeof BroadcastWorker>, maxCycles = 50): Promise<void> {
  for (let i = 0; i < maxCycles; i++) {
    const claimed = await worker.runOnce();
    if (claimed === 0) return;
  }
  throw new Error('drainAll: queue never emptied within maxCycles');
}

test('the owner\'s exact scenario: two broadcasts sent, then a genuinely new customer enrols — their pass has no news field at all', async () => {
  const fx = await makeFixture();
  try {
    // An existing customer, already on the card before either broadcast.
    const { pass: existingPass } = await createPassForEnrolment(fx.card, 'Existing Customer', '0501111111');

    await enqueueBroadcast(fx.card, 'First notification!');
    await enqueueBroadcast(fx.card, 'Second notification!!');
    const worker = new BroadcastWorker({ sendOne: noopSender(), pushIntervalMs: 0 });
    await drainAll(worker);

    // The existing customer does see the latest broadcast — expected.
    const existingAfter = await prisma.pass.findUniqueOrThrow({ where: { id: existingPass.id } });
    assert.notEqual(existingAfter.message, '', 'the existing customer should see the latest broadcast');
    const existingContent = buildPassContentFor(fx.card, existingAfter);
    assert.ok(existingContent.backFields?.some((f) => f.key === 'msg'), 'existing customer sees the msg field');

    // A genuinely new customer — a phone number the card has never seen —
    // enrols *after* both broadcasts were sent and delivered.
    const { pass: newPass, created } = await createPassForEnrolment(fx.card, 'New Customer', '0509999999');
    assert.equal(created, true, 'this must be a brand-new Pass row, not a reused one');
    assert.equal(newPass.message, '', "a genuinely new customer's pass must never have carried the old message");
    assert.equal(newPass.messageExpiresAt, null);

    const newContent = buildPassContentFor(fx.card, newPass);
    assert.equal(
      newContent.backFields?.some((f) => f.key === 'msg'),
      false,
      "THE FIX: the new customer's pass.json has no news field at all — not even a blank one"
    );
  } finally {
    await cleanup(fx);
  }
});

test('a returning customer re-scanning (same phone) gets their existing card back, stamps intact, but without a stale message once it has expired', async () => {
  const fx = await makeFixture();
  try {
    const { pass: firstVisit } = await createPassForEnrolment(fx.card, 'Returning Customer', '0507777777');
    // Simulate stamps collected on this card over time.
    await prisma.pass.update({ where: { id: firstVisit.id }, data: { stamps: 5, totalStamps: 5 } });

    const job = await enqueueBroadcast(fx.card, 'Weekend special!');
    const worker = new BroadcastWorker({ sendOne: noopSender(), pushIntervalMs: 0 });
    await drainAll(worker);

    const afterBroadcast = await prisma.pass.findUniqueOrThrow({ where: { id: firstVisit.id } });
    assert.equal(afterBroadcast.message, job.pushMessage, 'the message was delivered');
    assert.ok(afterBroadcast.messageExpiresAt, 'an expiry was stamped');

    // The TTL elapses (the sweeper's own unit tests already cover its
    // batching/pushing in isolation — here we only need the clock-forward
    // effect, so back-date the expiry directly rather than waiting).
    await prisma.pass.update({
      where: { id: firstVisit.id },
      data: { messageExpiresAt: new Date(Date.now() - 60_000) },
    });
    const sweeper = new MessageSweeper({ sendOne: noopSender(), pushIntervalMs: 0 });
    const cleared = await sweeper.runOnce();
    assert.equal(cleared, 1);

    // The same customer re-scans the QR code and re-"enrols" — the exact
    // request path a lost-pass re-scan takes (server.ts's /:code/pass).
    const { pass: returningPass, created } = await createPassForEnrolment(fx.card, 'Returning Customer', '0507777777');
    assert.equal(created, false, 'must be the SAME Pass row — this is the whole point of idempotent-by-phone enrolment');
    assert.equal(returningPass.id, firstVisit.id);
    assert.equal(returningPass.stamps, 5, 'their stamps must still be there');
    assert.equal(returningPass.totalStamps, 5);
    assert.equal(returningPass.message, '', 'the stale message must be gone (swept)');

    const content = buildPassContentFor(fx.card, returningPass);
    assert.equal(content.backFields?.some((f) => f.key === 'msg'), false, 'no news field once the message has expired');
    assert.match(
      content.headerFields?.[0]?.value ?? '',
      /٥|5/,
      'the stamp count on the rebuilt pass.json still reflects their real progress (5 stamps)'
    );
  } finally {
    await cleanup(fx);
  }
});
