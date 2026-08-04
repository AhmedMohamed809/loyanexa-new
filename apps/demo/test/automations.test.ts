// apps/demo/test/automations.test.ts — birthday and win-back scheduling
// (BUILD.md §8.12), against the real local Postgres.
//
// The thing under test is not really "does it send" — it is "does it send
// exactly once". A customer greeted twice on their birthday, or nagged every
// hour, is worse off than one never greeted at all: §8.12's own advisory is
// that over-notifying is what makes people delete the card. So most of what
// follows runs the scheduler repeatedly and asserts nothing new happens.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import { loadEnvFile } from '../env.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnvFile(path.join(__dirname, '../../../.env'));

const { prisma } = await import('../../../packages/db/src/index.ts');
const { AutomationRunner, localDateIn, birthdayMatchesToday, isLeapYear, resolveAutomationTimezone } =
  await import('../automations.ts');
const { parseBirthday, createPassForEnrolment } = await import('../enrol.ts');

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}
function randomLinkCode(): number {
  return 500_000_000 + Math.floor(Math.random() * 500_000_000);
}

let merchantId: string;

before(async () => {
  const merchant = await prisma.merchant.create({
    data: { email: `automations-${randomHex(8)}@example.test`, name: 'Automations Test Cafe' },
  });
  merchantId = merchant.id;
});

after(async () => {
  await prisma.stampEvent.deleteMany({ where: { merchantId } });
  await prisma.merchant.delete({ where: { id: merchantId } }).catch(() => {});
});

async function makeCard(overrides: Record<string, unknown> = {}): Promise<string> {
  const maxSlot = await prisma.card.aggregate({ where: { merchantId }, _max: { slot: true } });
  const card = await prisma.card.create({
    data: {
      merchantId,
      slot: (maxSlot._max.slot ?? 0) + 1,
      linkCode: randomLinkCode(),
      shortCode: `C${randomHex(4)}`.toUpperCase(),
      name: 'Automations Card',
      stampsGoal: 8,
      bgColor: '#203757',
      fgColor: '#FFFFFF',
      stampActive: '#F96400',
      stampInactive: '#8794A5',
      rewardText: 'Free coffee',
      ...overrides,
    },
  });
  return card.id;
}

async function makePass(cardId: string, data: Record<string, unknown> = {}): Promise<string> {
  const pass = await prisma.pass.create({
    data: {
      serial: `TESTSER${randomHex(6)}`.toUpperCase(),
      shortCode: `P${randomHex(4)}`.toUpperCase(),
      cardId,
      merchantId,
      authToken: randomHex(12),
      ...data,
    },
  });
  return pass.serial;
}

/** Jobs this run created, by kind — the scheduler's only observable output. */
async function jobsFor(cardId: string, kind: string): Promise<number> {
  return prisma.broadcastJob.count({ where: { cardId, kind } });
}

function runner(now: Date, extra: Record<string, unknown> = {}) {
  // Scoped to this file's merchant: node --test runs files in parallel
  // against one Postgres, and the scheduler is otherwise install-wide.
  return new AutomationRunner({
    now: () => now,
    timeZone: 'UTC',
    onlyMerchantIds: [merchantId],
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Date handling
// ---------------------------------------------------------------------------

test('parseBirthday keeps the day and month and throws the year away', () => {
  assert.deepEqual(parseBirthday('1990-03-17'), { birthdayMonth: 3, birthdayDay: 17 });
  // The year is the whole point: it must not survive in any form.
  assert.ok(!Object.values(parseBirthday('1990-03-17')).includes(1990));

  assert.deepEqual(parseBirthday('2000-02-29'), { birthdayMonth: 2, birthdayDay: 29 }, 'leap-day births are real');
  assert.deepEqual(parseBirthday('1990-02-31'), { birthdayMonth: null, birthdayDay: null }, '31 February is not a date');
  assert.deepEqual(parseBirthday('1990-13-01'), { birthdayMonth: null, birthdayDay: null });
  // A fumbled optional field must never cost a customer their card, so these
  // return nulls rather than throwing.
  assert.deepEqual(parseBirthday(''), { birthdayMonth: null, birthdayDay: null });
  assert.deepEqual(parseBirthday('not a date'), { birthdayMonth: null, birthdayDay: null });
});

test('a birthday given at enrolment actually reaches the Pass row', async () => {
  // Regression guard. parseBirthday and the scheduler were both correct while
  // createPassForEnrolment quietly dropped the fields on insert, so every
  // birthday was stored as null and the automation could never fire for a
  // real customer. The rest of this file creates passes through Prisma
  // directly, which is exactly why it did not notice — this one goes through
  // the enrolment path a real customer uses.
  const cardId = await makeCard();
  const card = await prisma.card.findUniqueOrThrow({ where: { id: cardId } });

  const { pass } = await createPassForEnrolment(
    card,
    'Birthday Person',
    `05${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
    undefined,
    parseBirthday('1990-03-17')
  );

  assert.equal(pass.birthdayMonth, 3);
  assert.equal(pass.birthdayDay, 17);
  // And the year is nowhere on the row.
  assert.ok(!JSON.stringify(pass).includes('1990'), 'the year of birth must never be persisted');
});

test('localDateIn reads the calendar date in the given zone, not UTC', () => {
  // 22:30 UTC is already tomorrow in Riyadh (+03).
  const at = new Date('2026-03-17T22:30:00.000Z');
  assert.deepEqual(localDateIn('UTC', at), { year: 2026, month: 3, day: 17 });
  assert.deepEqual(localDateIn('Asia/Riyadh', at), { year: 2026, month: 3, day: 18 });
});

test('a 29 February birthday is greeted on the 28th in non-leap years, not skipped for three years', () => {
  assert.equal(isLeapYear(2024), true);
  assert.equal(isLeapYear(2026), false);
  assert.equal(isLeapYear(2100), false, 'centuries are not leap years unless divisible by 400');
  assert.equal(isLeapYear(2000), true);

  // Leap year: greeted on the real day, and NOT early on the 28th.
  assert.equal(birthdayMatchesToday(2, 29, { year: 2024, month: 2, day: 29 }), true);
  assert.equal(birthdayMatchesToday(2, 29, { year: 2024, month: 2, day: 28 }), false);
  // Non-leap year: folded onto the 28th, because otherwise they are never
  // greeted at all.
  assert.equal(birthdayMatchesToday(2, 29, { year: 2026, month: 2, day: 28 }), true);
  // And an ordinary 28 February birthday is unaffected either way.
  assert.equal(birthdayMatchesToday(2, 28, { year: 2026, month: 2, day: 28 }), true);
});

test('resolveAutomationTimezone falls back rather than throwing on a bad zone', () => {
  const prev = process.env.AUTOMATION_TIMEZONE;
  try {
    process.env.AUTOMATION_TIMEZONE = 'Not/AZone';
    assert.equal(resolveAutomationTimezone(), 'Asia/Riyadh', 'a bad zone must not kill both automations');
    process.env.AUTOMATION_TIMEZONE = 'Europe/London';
    assert.equal(resolveAutomationTimezone(), 'Europe/London');
    delete process.env.AUTOMATION_TIMEZONE;
    assert.equal(resolveAutomationTimezone(), 'Asia/Riyadh');
  } finally {
    if (prev === undefined) delete process.env.AUTOMATION_TIMEZONE;
    else process.env.AUTOMATION_TIMEZONE = prev;
  }
});

// ---------------------------------------------------------------------------
// Birthday
// ---------------------------------------------------------------------------

test('a birthday fires once, and running again the same day does nothing', async () => {
  const cardId = await makeCard({ birthdayEnabled: true, birthdayMessage: 'Happy birthday!' });
  await makePass(cardId, { birthdayMonth: 3, birthdayDay: 17 });
  const today = new Date('2026-03-17T09:00:00.000Z');

  const first = await runner(today).runOnce();
  assert.equal(first.birthdaysSent, 1);
  assert.equal(await jobsFor(cardId, 'birthday'), 1);

  // The scheduler ticks hourly, so this is the normal case, not an edge one.
  const second = await runner(new Date('2026-03-17T10:00:00.000Z')).runOnce();
  assert.equal(second.birthdaysSent, 0, 'a second tick the same day must send nothing');
  assert.equal(await jobsFor(cardId, 'birthday'), 1);
});

test('the same customer is greeted again the following year', async () => {
  const cardId = await makeCard({ birthdayEnabled: true, birthdayMessage: 'Happy birthday!' });
  await makePass(cardId, { birthdayMonth: 4, birthdayDay: 2 });

  await runner(new Date('2026-04-02T09:00:00.000Z')).runOnce();
  assert.equal(await jobsFor(cardId, 'birthday'), 1);

  await runner(new Date('2027-04-02T09:00:00.000Z')).runOnce();
  assert.equal(await jobsFor(cardId, 'birthday'), 2, 'a birthday is annual, not once ever');
});

test('nothing fires for a card with the automation off, or with no message written', async () => {
  const off = await makeCard({ birthdayEnabled: false, birthdayMessage: 'Happy birthday!' });
  await makePass(off, { birthdayMonth: 5, birthdayDay: 5 });
  // Enabled but empty: an automation with no message would schedule a job
  // that either sends nothing or throws in the worker on every fire.
  const empty = await makeCard({ birthdayEnabled: true, birthdayMessage: '' });
  await makePass(empty, { birthdayMonth: 5, birthdayDay: 5 });

  const result = await runner(new Date('2026-05-05T09:00:00.000Z')).runOnce();
  assert.equal(result.birthdaysSent, 0);
  assert.equal(await jobsFor(off, 'birthday'), 0);
  assert.equal(await jobsFor(empty, 'birthday'), 0);
});

test('customers who gave no birthday are simply skipped', async () => {
  const cardId = await makeCard({ birthdayEnabled: true, birthdayMessage: 'Happy birthday!' });
  await makePass(cardId); // birthdayMonth/Day both null — the field is optional
  const result = await runner(new Date('2026-06-06T09:00:00.000Z')).runOnce();
  assert.equal(result.birthdaysSent, 0);
});

test('the birthday is judged in the configured zone, so a late-evening UTC tick is already tomorrow in Riyadh', async () => {
  const cardId = await makeCard({ birthdayEnabled: true, birthdayMessage: 'Happy birthday!' });
  await makePass(cardId, { birthdayMonth: 7, birthdayDay: 11 });
  // 22:00 UTC on the 10th is 01:00 on the 11th in Riyadh.
  const at = new Date('2026-07-10T22:00:00.000Z');

  const utc = await runner(at).runOnce();
  assert.equal(utc.birthdaysSent, 0, 'still the 10th in UTC');

  const riyadh = await new (await import('../automations.ts')).AutomationRunner({
    now: () => at,
    timeZone: 'Asia/Riyadh',
    onlyMerchantIds: [merchantId],
  }).runOnce();
  assert.equal(riyadh.birthdaysSent, 1, 'already the 11th in Riyadh');
});

// ---------------------------------------------------------------------------
// Win-back
// ---------------------------------------------------------------------------

test('win-back fires for a lapsed customer, once per window rather than every tick', async () => {
  const cardId = await makeCard({ winbackEnabled: true, winbackMessage: 'We miss you!', winbackDays: 30 });
  const now = new Date('2026-08-01T09:00:00.000Z');
  await makePass(cardId, { lastStampAt: new Date('2026-06-01T09:00:00.000Z') }); // 61 days ago

  const first = await runner(now).runOnce();
  assert.equal(first.winbacksSent, 1);

  // An hour later — the scheduler's normal cadence.
  const second = await runner(new Date('2026-08-01T10:00:00.000Z')).runOnce();
  assert.equal(second.winbacksSent, 0, 'a lapsed customer must not be nagged every hour');
  assert.equal(await jobsFor(cardId, 'winback'), 1);

  // Still lapsed a full window later: chase once more, not never again.
  const later = await runner(new Date('2026-09-05T09:00:00.000Z')).runOnce();
  assert.equal(later.winbacksSent, 1, 'after the window passes they are eligible again');
  assert.equal(await jobsFor(cardId, 'winback'), 2);
});

test('a customer who visited recently is left alone', async () => {
  const cardId = await makeCard({ winbackEnabled: true, winbackMessage: 'We miss you!', winbackDays: 30 });
  const now = new Date('2026-08-01T09:00:00.000Z');
  await makePass(cardId, { lastStampAt: new Date('2026-07-25T09:00:00.000Z') }); // 7 days ago

  const result = await runner(now).runOnce();
  assert.equal(result.winbacksSent, 0);
});

test('a customer who joined but never earned a stamp is NOT a win-back target', async () => {
  // lastStampAt IS NULL means they enrolled and never came back — that is
  // what the welcome message is for. Treating it as "lapsed" would fire a
  // "we miss you" at someone who has never been.
  const cardId = await makeCard({ winbackEnabled: true, winbackMessage: 'We miss you!', winbackDays: 30 });
  await makePass(cardId, { lastStampAt: null, createdAt: new Date('2026-01-01T09:00:00.000Z') });

  const result = await runner(new Date('2026-08-01T09:00:00.000Z')).runOnce();
  assert.equal(result.winbacksSent, 0);
});

test('winbackDays is honoured per card, not hardcoded', async () => {
  const impatient = await makeCard({ winbackEnabled: true, winbackMessage: 'Come back', winbackDays: 10 });
  const patient = await makeCard({ winbackEnabled: true, winbackMessage: 'Come back', winbackDays: 90 });
  const lapsed = new Date('2026-07-17T09:00:00.000Z'); // 15 days before `now`
  await makePass(impatient, { lastStampAt: lapsed });
  await makePass(patient, { lastStampAt: lapsed });

  await runner(new Date('2026-08-01T09:00:00.000Z')).runOnce();
  assert.equal(await jobsFor(impatient, 'winback'), 1, '15 days is lapsed at a 10-day setting');
  assert.equal(await jobsFor(patient, 'winback'), 0, '15 days is not lapsed at a 90-day setting');
});

// ---------------------------------------------------------------------------
// Both at once
// ---------------------------------------------------------------------------

test('two runners racing the same queue never double-send', async () => {
  // The production guarantee: selecting a pass and marking it done are one
  // statement, so a second machine (or an overlapping tick) cannot re-claim.
  const cardId = await makeCard({ birthdayEnabled: true, birthdayMessage: 'Happy birthday!' });
  for (let i = 0; i < 6; i++) await makePass(cardId, { birthdayMonth: 9, birthdayDay: 9 });
  const now = new Date('2026-09-09T09:00:00.000Z');

  const [a, b] = await Promise.all([runner(now).runOnce(), runner(now).runOnce()]);
  assert.equal(a.birthdaysSent + b.birthdaysSent, 6, 'every customer greeted exactly once between them');
  assert.equal(await jobsFor(cardId, 'birthday'), 6);
});

test('the enqueued job targets only that one customer, not the whole card', async () => {
  const cardId = await makeCard({ birthdayEnabled: true, birthdayMessage: 'Happy birthday!' });
  const lucky = await makePass(cardId, { birthdayMonth: 10, birthdayDay: 10 });
  await makePass(cardId, { birthdayMonth: 11, birthdayDay: 11 }); // not today
  await makePass(cardId, { birthdayMonth: 12, birthdayDay: 12 }); // not today

  await runner(new Date('2026-10-10T09:00:00.000Z')).runOnce();

  const job = await prisma.broadcastJob.findFirstOrThrow({ where: { cardId, kind: 'birthday' } });
  const recipients = await prisma.broadcastRecipient.findMany({ where: { jobId: job.id } });
  assert.equal(recipients.length, 1, 'a birthday greeting must not fan out to the whole card');
  assert.equal(recipients[0]?.passSerial, lucky);
});
