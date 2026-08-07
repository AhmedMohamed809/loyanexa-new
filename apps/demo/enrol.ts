// apps/demo/enrol.ts — creates the Pass row for a new enrolment, shared by
// both wallet issuance routes (POST /:code/pass for Apple, POST
// /:code/google-pass for Google). Split out of server.ts so
// apps/demo/test/enrol.test.ts can exercise it directly against the real
// local Postgres, same reasoning as cardEdit.ts / stamp.ts.
//
// Idempotent per card, by design (BUILD.md §9.6's one-stamp-per-24h rule is
// a per-*pass* guard — see stamp.ts's applyStamp — so if enrolling twice
// created two Pass rows, a customer could tap "Add to Apple Wallet", enrol
// again, tap "Add to Google Wallet", and walk away with two independent
// cards that never stay in sync, each good for its own free stamp today).
// Two paths reuse an existing Pass instead of inserting a new one:
//
//   1. A phone number was supplied: look up an existing, not-yet-expired
//      Pass for this cardId + custPhone and reuse it. This is the durable
//      path — it survives across browser sessions, so a customer who lost
//      their pass and re-scans the QR still lands on the same card instead
//      of a fresh one.
//   2. No phone was supplied: fall back to a short-lived idempotency key
//      (a random token minted once per enrol-page render, carried as a
//      hidden form field — see server.ts's renderEnrolPage). A double
//      submit (back-button resubmit, or tapping both wallet buttons off the
//      same page load) carries the same key and reuses the same row. This
//      path is intentionally ephemeral, in-memory only, and bounded (see
//      IdempotencyStore below) — it exists to catch the "same page load,
//      two submits" case, not to identify a returning customer across
//      visits the way a phone number does.
//
// Neither path applies when both custPhone and the idempotency key are
// absent/unrecognised: that enrolment always gets its own new Pass, same as
// before this fix.

import crypto from 'node:crypto';
import { Prisma, type Card, type Pass } from '@prisma/client';
import { prisma } from '../../packages/db/src/index.ts';

function generateShortCode(): string {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

/**
 * Whether `pass` has expired under its own card's expiry rule, computed
 * relative to when the pass itself was issued (`pass.createdAt`) — the same
 * three-way switch server.ts's buildTermsText() uses to describe the rule
 * to the customer, applied here to decide whether an old Pass row is still
 * a valid match to reuse.
 */
export function isPassExpired(card: Pick<Card, 'expiryType' | 'expiryDays' | 'expiryDate'>, pass: Pick<Pass, 'createdAt'>): boolean {
  if (card.expiryType === 'duration') {
    if (!card.expiryDays || card.expiryDays <= 0) return false;
    const expiresAt = pass.createdAt.getTime() + card.expiryDays * 24 * 60 * 60 * 1000;
    return Date.now() >= expiresAt;
  }
  if (card.expiryType === 'fixed') {
    if (!card.expiryDate) return false;
    return Date.now() >= card.expiryDate.getTime();
  }
  return false; // 'unlimited', or any unrecognised value — never expires
}

// ---------------------------------------------------------------------------
// The short-lived idempotency-key store — path 2 above. In-memory only (an
// enrol-page hidden token has no reason to survive a process restart), and
// bounded on both axes that could otherwise make it a leak: every entry
// carries a TTL, checked and swept before every write, and the map itself
// is capped at MAX_ENTRIES with oldest-first eviction if that cap is ever
// hit (it shouldn't be, in practice — that would mean tens of thousands of
// enrolments within one TTL window).
// ---------------------------------------------------------------------------
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000; // 10 minutes — long enough for a slow double-tap, short enough to never be mistaken for "remembers you"
const MAX_ENTRIES = 10_000;

interface IdempotencyEntry {
  passId: string;
  expiresAt: number;
}

class IdempotencyStore {
  private readonly entries = new Map<string, IdempotencyEntry>();

  private sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  get(key: string, now = Date.now()): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.passId;
  }

  set(key: string, passId: string, now = Date.now()): void {
    this.sweep(now);
    if (this.entries.size >= MAX_ENTRIES) {
      // Defensive only — see class doc comment. Evict the oldest (first
      // inserted, Map preserves insertion order) rather than refuse the
      // write.
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { passId, expiresAt: now + IDEMPOTENCY_TTL_MS });
  }
}

const idempotencyStore = new IdempotencyStore();

/** Namespaces an idempotency token by card, so the same random token can never accidentally match a different card's enrolment. */
function idempotencyStoreKey(cardId: string, idempotencyKey: string): string {
  return `${cardId}:${idempotencyKey}`;
}

export interface EnrolmentResult {
  pass: Pass;
  /** false when an existing Pass was reused — callers must never delete a reused row on a later failure (it may be a returning customer's real card), only one they just inserted themselves. */
  created: boolean;
}

/**
 * The live pass this phone number already holds on this card, if any.
 *
 * Shared by createPassForEnrolment and the plan-capacity check below so the
 * two cannot disagree about what counts as a returning customer. If they
 * did, a returning customer could be turned away as "new" at a full plan
 * while still being handed their existing card — or vice versa.
 */
async function findReusablePass(card: Card, custPhone: string): Promise<Pass | undefined> {
  const candidates = await prisma.pass.findMany({
    where: { cardId: card.id, custPhone },
    orderBy: { createdAt: 'desc' },
  });
  return candidates.find((p) => !isPassExpired(card, p));
}

/**
 * Whether the merchant's plan has room for this enrolment.
 *
 * Only a genuinely new customer counts against the cap. A returning
 * customer re-adding a card they already hold is not a new customer, and
 * turning them away at the counter over the merchant's plan tier would
 * punish the wrong person entirely.
 *
 * The cap blocks the next enrolment; it never touches passes already
 * issued. Same rule as every other limit here — "you cannot create more",
 * never "what you have stops working" — except that the person inconvenienced
 * is the customer standing at the till, which is why the message they see
 * says nothing about the merchant's subscription.
 */
export async function hasCustomerCapacity(
  card: Card,
  custPhone: string,
  limit: number
): Promise<boolean> {
  if (limit === Infinity) return true;
  if (custPhone && (await findReusablePass(card, custPhone))) return true;
  const used = await prisma.pass.count({ where: { merchantId: card.merchantId } });
  return used < limit;
}

/**
 * Creates (or reuses) the Pass row for an enrolment on `card` — see this
 * file's own doc comment above for the two reuse paths. Whichever wallet
 * button the customer taps, and whether or not this is a resubmission, the
 * caller gets back the one Pass row that enrolment maps to, plus whether it
 * was newly inserted (so a caller that fails a later step — e.g. signing
 * the .pkpass — knows whether it is safe to delete it again).
 */
/**
 * Parses the enrol form's `<input type="date">` into month and day, **throwing
 * the year away**.
 *
 * The native date picker is by far the easiest control to use on a phone, so
 * the form asks for a whole date — but a full date of birth is a real
 * identity-theft input and one of the most sensitive things a corner café
 * could end up holding. Month and day is everything a birthday greeting
 * needs. The year is discarded here, at the boundary, before anything is
 * written: it never reaches the database, a log, or a CSV export.
 *
 * Returns nulls for anything unparseable rather than throwing — an optional
 * field a customer fumbled must never cost them their card.
 */
export function parseBirthday(raw: string): { birthdayMonth: number | null; birthdayDay: number | null } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!match) return { birthdayMonth: null, birthdayDay: null };
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return { birthdayMonth: null, birthdayDay: null };
  }
  // Rejects 31 February and friends. Day counts use a leap year so 29
  // February is accepted — those customers exist, and automations.ts folds
  // them onto the 28th in non-leap years rather than never greeting them.
  const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > daysInMonth[month - 1]!) return { birthdayMonth: null, birthdayDay: null };
  return { birthdayMonth: month, birthdayDay: day };
}

export async function createPassForEnrolment(
  card: Card,
  custName: string,
  custPhone: string,
  idempotencyKey?: string,
  birthday: { birthdayMonth: number | null; birthdayDay: number | null } = {
    birthdayMonth: null,
    birthdayDay: null,
  }
): Promise<EnrolmentResult> {
  if (custPhone) {
    const reusable = await findReusablePass(card, custPhone);
    if (reusable) return { pass: reusable, created: false };
  } else if (idempotencyKey) {
    const passId = idempotencyStore.get(idempotencyStoreKey(card.id, idempotencyKey));
    if (passId) {
      const existing = await prisma.pass.findUnique({ where: { id: passId } });
      if (existing) return { pass: existing, created: false };
    }
  }

  const stamps = card.starterStamps;
  for (let attempt = 0; attempt < 5; attempt++) {
    const serial = crypto.randomBytes(14).toString('base64url').slice(0, 18); // 18 random base64url chars
    const shortCode = generateShortCode(); // 8 uppercase hex chars
    const authToken = crypto.randomBytes(24).toString('base64url'); // 32 random chars
    try {
      const pass = await prisma.pass.create({
        data: {
          serial,
          shortCode,
          cardId: card.id,
          merchantId: card.merchantId,
          authToken,
          stamps,
          custName,
          custPhone,
          // Month and day only — parseBirthday() discarded the year at the
          // HTTP boundary, so no year ever reaches this insert.
          birthdayMonth: birthday.birthdayMonth,
          birthdayDay: birthday.birthdayDay,
        },
      });
      if (!custPhone && idempotencyKey) {
        idempotencyStore.set(idempotencyStoreKey(card.id, idempotencyKey), pass.id);
      }
      return { pass, created: true };
    } catch (err) {
      // P2002: unique constraint failed (serial or shortCode collision) — retry with fresh values.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && attempt < 4) continue;
      throw err;
    }
  }
  // Unreachable in practice: the loop above always either returns or
  // rethrows on its final iteration.
  throw new Error('pass creation loop exited without creating a pass or throwing');
}

/** Deletes a Pass row that was just created by createPassForEnrolment, when a later step in the same request (e.g. signing the .pkpass) fails — never call this on a `created: false` result (see EnrolmentResult's doc comment). Swallows a "not found" race (e.g. a concurrent request already cleaned it up) rather than masking the original error with a second one. */
export async function deleteOrphanedPass(passId: string): Promise<void> {
  await prisma.pass.delete({ where: { id: passId } }).catch(() => {});
}

/** Test-only escape hatch: lets apps/demo/test/enrol.test.ts exercise the idempotency-key path deterministically without waiting out IDEMPOTENCY_TTL_MS. */
export const __testing = { idempotencyStore, idempotencyStoreKey, IDEMPOTENCY_TTL_MS };
