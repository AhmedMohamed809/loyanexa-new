// apps/demo/test/log.test.ts — the structured logger (BUILD.md §15 Phase 7).
//
// The redaction tests are the point of this file. The privacy policy at
// /privacy makes specific promises about what happens to a customer's phone
// number and birthday, and logs are retained, shipped elsewhere, and read by
// people with no business seeing either. A logger that quietly writes them
// breaks a written promise.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { log, errorFields } = await import('../log.ts');

/** Captures whatever the logger writes, on both streams. */
function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  const origLog = console.log;
  const origErr = console.error;
  console.log = (v: unknown): void => void lines.push(String(v));
  console.error = (v: unknown): void => void lines.push(String(v));
  try {
    fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
  }
  return lines;
}

test('every line is one JSON object with a timestamp, a level and an event name', () => {
  const [line] = capture(() => log.info('apns.push', { serial: 'ABC123', ms: 143 }));
  const parsed = JSON.parse(line!);
  assert.equal(parsed.evt, 'apns.push');
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.serial, 'ABC123');
  assert.equal(parsed.ms, 143);
  assert.match(parsed.ts, /^\d{4}-\d{2}-\d{2}T/);
  // Machine-readable is the whole point: "pushed in 143ms" cannot answer
  // "what was the 95th percentile yesterday", and this can.
  assert.equal(typeof parsed.ms, 'number', 'a duration must stay a number, not become prose');
});

test('personal data is redacted even when a whole row is spread into a log call', () => {
  // The realistic mistake is not `log.info('x', { phone })`, it is someone
  // spreading a Pass or Merchant row and not noticing what came with it.
  const [line] = capture(() =>
    log.info('enrol.created', {
      serial: 'SER1',
      custName: 'Aisha',
      custPhone: '0501234567',
      custEmail: 'a@example.com',
      birthdayMonth: 3,
      cardId: 'card_1',
    })
  );
  const parsed = JSON.parse(line!);

  assert.equal(parsed.serial, 'SER1', 'identifiers are fine and are the useful part');
  assert.equal(parsed.cardId, 'card_1');
  for (const field of ['custName', 'custPhone', 'custEmail', 'birthdayMonth']) {
    assert.equal(parsed[field], '[redacted]', `${field} must never reach the log`);
  }
  assert.ok(!line!.includes('0501234567'), 'the number must not survive anywhere in the line');
  assert.ok(!line!.includes('Aisha'));
});

test('secrets are redacted', () => {
  const [line] = capture(() =>
    log.warn('auth.attempt', { sessionId: 's_abc', pushToken: 'tok_xyz', passwordHash: 'scrypt$…' })
  );
  const parsed = JSON.parse(line!);
  assert.equal(parsed.sessionId, '[redacted]');
  assert.equal(parsed.pushToken, '[redacted]');
  assert.equal(parsed.passwordHash, '[redacted]');
  assert.ok(!line!.includes('tok_xyz'));
});

test('warnings and errors go to stderr, everything else to stdout', () => {
  // So a log drain can separate them without parsing, and so an error is
  // still visible when stdout is being piped somewhere.
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (v: unknown): void => void out.push(String(v));
  console.error = (v: unknown): void => void err.push(String(v));
  try {
    log.info('a');
    log.debug('b');
    log.warn('c');
    log.error('d');
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  assert.equal(out.length, 2);
  assert.equal(err.length, 2);
});

test('errorFields keeps the message and a short stack, and drops the rest', () => {
  const err = new TypeError('something broke');
  // Prisma errors carry the failing query's parameters on the error object —
  // which is customer data. Only named fields are ever taken.
  (err as unknown as Record<string, unknown>).params = ['0501234567'];

  const fields = errorFields(err);
  assert.equal(fields.err, 'TypeError');
  assert.equal(fields.msg, 'something broke');
  assert.ok(String(fields.stack).length > 0);
  assert.equal(fields.params, undefined, "an error's own properties must not be logged");
  assert.ok(!JSON.stringify(fields).includes('0501234567'));

  assert.deepEqual(errorFields('a bare string'), { err: 'unknown', msg: 'a bare string' });
});

test('undefined fields are omitted rather than written as null', () => {
  const [line] = capture(() => log.info('x', { a: 1, b: undefined }));
  const parsed = JSON.parse(line!);
  assert.equal(parsed.a, 1);
  assert.ok(!('b' in parsed), 'an absent value should not take up space in every line');
});
