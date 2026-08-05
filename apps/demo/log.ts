// apps/demo/log.ts — structured logging (BUILD.md §15 Phase 7).
//
// One line of JSON per event, on stdout, which is where Fly already collects
// logs from. No pino, no transport, no new dependency: pino's value is its
// speed at tens of thousands of lines a second and its ecosystem of
// transports, and this application emits a handful of lines per stamp. What
// it actually needed was not a faster logger but a *parseable* one.
//
// The failure this exists to fix is specific and recent. When the owner asked
// "why is the stamp sometimes slow?", the honest answer was that nobody could
// tell: successes logged nothing at all, failures logged a sentence of prose,
// and neither could be counted, filtered or compared. `[apns] pass X pushed
// in 143ms` is readable but you cannot ask it "what was the 95th percentile
// yesterday". `{"evt":"apns.push","ms":143}` you can.
//
// Two rules, both deliberate:
//
//   1. **Never log personal data.** Not a customer name, phone, email or
//      birthday; not a merchant email. Identifiers only — a pass serial, a
//      card id, a merchant id. Logs are retained, shipped to third parties
//      and read by people who have no business seeing a customer's phone
//      number, and the privacy policy at /privacy makes promises that a
//      careless log line would break.
//   2. **Never log a secret.** No session ids, no auth tokens, no push
//      tokens, no credentials. A push token is a device identifier and is
//      truncated where it appears at all.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Fields common to every line, so a query can always group by them. */
interface BaseFields {
  ts: string;
  level: LogLevel;
  evt: string;
}

export type LogFields = Record<string, string | number | boolean | null | undefined>;

/**
 * Anything whose *name* suggests it carries a secret or personal data is
 * dropped before it can be written, rather than trusted not to be passed.
 *
 * A denylist is the weaker of the two designs — an allowlist cannot be
 * bypassed by a new field name — but an allowlist on a logger this small
 * means every new call site needs the logger changed too, and the realistic
 * outcome of that is people going back to console.log. This catches the
 * mistakes that actually happen: someone spreading a whole row into a log
 * call.
 */
const FORBIDDEN = /pass(word|Hash)|token|secret|session|cookie|pin|email|phone|birthday|custName/i;

function emit(level: LogLevel, evt: string, fields: LogFields = {}): void {
  const line: BaseFields & LogFields = {
    ts: new Date().toISOString(),
    level,
    evt,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (FORBIDDEN.test(key)) {
      line[key] = '[redacted]';
      continue;
    }
    line[key] = value;
  }
  const out = JSON.stringify(line);
  if (level === 'error' || level === 'warn') console.error(out);
  else console.log(out);
}

export const log = {
  debug: (evt: string, fields?: LogFields): void => emit('debug', evt, fields),
  info: (evt: string, fields?: LogFields): void => emit('info', evt, fields),
  warn: (evt: string, fields?: LogFields): void => emit('warn', evt, fields),
  error: (evt: string, fields?: LogFields): void => emit('error', evt, fields),
};

/**
 * Turns a thrown value into log fields.
 *
 * Takes the message and the error's own name, and the stack only at error
 * level — a stack in every warning is noise that makes the real ones harder
 * to find. Never logs the error's arbitrary own properties: a Prisma error,
 * for one, carries the failing query's parameters, which is exactly the
 * personal data rule 1 above exists to keep out of logs.
 */
export function errorFields(err: unknown): LogFields {
  if (err instanceof Error) {
    return { err: err.name, msg: err.message, stack: err.stack?.split('\n').slice(0, 4).join(' | ') };
  }
  return { err: 'unknown', msg: String(err) };
}
