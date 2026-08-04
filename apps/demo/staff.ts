// apps/demo/staff.ts — Staff PIN accounts (BUILD.md §8.13: "add staff and
// give them a PIN to open the stamp screen in a browser — no app").
//
// A Staff row belongs to exactly one Merchant and can only ever reach the
// stamp screen (see apps/demo/staffAuth.ts and server.ts's
// resolveStampAuth) — never /app, /customers, /reports, card editing or
// settings. The PIN itself is hashed with the same scrypt
// hashPassword/verifyPassword this branch already built for merchant
// passwords (apps/demo/auth.ts) — never stored in plain text, even though
// BUILD.md's own job brief is explicit that a 4-6 digit PIN is "staff
// convenience, not strong security", not a real access-control boundary.
//
// Split out of server.ts, same convention as cardEdit.ts / stamp.ts:
// apps/demo/test/staff.test.ts exercises this directly against the real
// local Postgres, without going through HTTP.

import crypto from 'node:crypto';
import { prisma } from '../../packages/db/src/index.ts';
import type { Staff, Merchant } from '@prisma/client';
import { hashPassword, verifyPassword, verifyPasswordAsync, normalizeEmail } from './auth.ts';

export const MIN_PIN_LENGTH = 4;
export const MAX_PIN_LENGTH = 6;
const PIN_RE = /^[0-9]{4,6}$/;

export type PinValidation = { ok: true } | { ok: false; reason: 'invalid_format' };

/** A PIN must be 4-6 ASCII digits — nothing else (BUILD.md job brief). Rejects anything with letters, punctuation, or the wrong length, including a technically-numeric string with a leading `+`/decimal point that `Number()` would otherwise accept. */
export function validatePin(pin: string): PinValidation {
  return PIN_RE.test(pin) ? { ok: true } : { ok: false, reason: 'invalid_format' };
}

/** Generates a random all-digit PIN of `length` digits (default the more brute-force-resistant end of the 4-6 range: 6) for the Settings page's "Generate PIN" button — crypto.randomInt, not Math.random, even though this value is about to be shown to the merchant and typed by a human, not used as a cryptographic secret itself. */
export function generatePin(length: number = MAX_PIN_LENGTH): string {
  let out = '';
  for (let i = 0; i < length; i++) out += crypto.randomInt(0, 10).toString();
  return out;
}

/** scrypt-hashes a PIN — a thin, PIN-flavoured name for auth.ts's hashPassword, which is exactly the same algorithm and encoding (`scrypt$N$r$p$saltHex$hashHex`); a PIN is just a very short password as far as scrypt is concerned. */
export function hashPin(pin: string): string {
  return hashPassword(pin);
}

/** Constant-time PIN check — a thin, PIN-flavoured name for auth.ts's verifyPassword. */
export function verifyPin(pin: string, hash: string): boolean {
  return verifyPassword(pin, hash);
}

/** Async, non-blocking counterpart to verifyPin — a thin, PIN-flavoured name for auth.ts's verifyPasswordAsync. Used by findStaffByPin, which may need to check a PIN against every active staff member on the same merchant, concurrently rather than one scryptSync call at a time. */
export function verifyPinAsync(pin: string, hash: string): Promise<boolean> {
  return verifyPasswordAsync(pin, hash);
}

export async function createStaff(merchantId: string, name: string, pin: string): Promise<Staff> {
  return prisma.staff.create({ data: { merchantId, name, pinHash: hashPin(pin), active: true } });
}

/** Every staff row for `merchantId`, oldest first — the order Settings lists them in. Includes inactive rows; the caller renders their state, never hides them (BUILD.md job brief: deactivate is reversible, distinct from remove). */
export function listStaff(merchantId: string): Promise<Staff[]> {
  return prisma.staff.findMany({ where: { merchantId }, orderBy: { createdAt: 'asc' } });
}

/**
 * Sets `active` for staff `staffId`, scoped to `merchantId` — a staff id
 * belonging to a different merchant is treated as not found, same
 * not-found-not-403 reasoning as cardEdit.ts's updateCard/activateCard.
 * Deactivating does not delete anything: a deactivated staff member's past
 * StampEvent rows (and the row itself) stay exactly as they were, they can
 * simply no longer open a new StaffSession (getStaffForSession checks
 * `active` on every resolution, not only at login, so an *existing* session
 * is cut off immediately too — see apps/demo/staffAuth.ts).
 */
export async function setStaffActive(staffId: string, merchantId: string, active: boolean): Promise<Staff | null> {
  const staff = await prisma.staff.findFirst({ where: { id: staffId, merchantId } });
  if (!staff) return null;
  return prisma.staff.update({ where: { id: staffId }, data: { active } });
}

/** Deletes staff `staffId` outright, scoped to `merchantId`. Past StampEvent rows survive (schema.prisma's StampEvent.staffId is `onDelete: SetNull`) — only the name attached to future/removed sessions is gone, never the history "who did what" was built to preserve. Returns false when the id doesn't belong to this merchant (or doesn't exist) rather than throwing. */
export async function deleteStaff(staffId: string, merchantId: string): Promise<boolean> {
  const staff = await prisma.staff.findFirst({ where: { id: staffId, merchantId } });
  if (!staff) return false;
  await prisma.staff.delete({ where: { id: staffId } });
  return true;
}

/**
 * A fixed, valid-shaped scrypt hash that no real PIN will ever match —
 * mirrors auth.ts's own DUMMY_PASSWORD_HASH so a PIN attempt against an
 * unknown business email still pays a real scrypt cost, not an
 * instant-return one. Computed once at module load.
 */
const DUMMY_PIN_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));

/**
 * Resolves a staff PIN login attempt to the (merchant, staff) it names, or
 * `null`. There is no per-merchant stamp-screen URL in this app (`/stamp`
 * is one shared path — see server.ts's router), so the business email is
 * how a shared/unattended device identifies *which* merchant's staff list
 * to check against, the same identifier the owner's own sign-in form uses;
 * this is a deliberate design choice given Staff has no route of its own to
 * be scoped by, not something the job brief specified directly.
 *
 * Checks the merchant's *active* staff only (a deactivated staff member's
 * PIN never opens a new session, even if it's still typed correctly) —
 * every candidate concurrently (Promise.all + verifyPinAsync), not a
 * sequential loop over verifyPin/scryptSync. Final whole-branch review: the
 * sequential form was O(active staff) *blocking* scrypt hashes per attempt
 * — it froze the single Node event loop for the sum of every candidate's
 * cost, and it leaked headcount by timing (an 8-staff business answered
 * ~8x slower than an unknown one, since verifyPin only stopped once it hit
 * a match). Concurrent, async verification fixes both: scrypt work runs on
 * libuv's threadpool instead of the JS thread, and every candidate's cost
 * overlaps instead of stacking, so response time no longer scales linearly
 * with staff count. Always resolves the merchant first: when no merchant
 * matches `email` (or it matches but has zero active staff), one dummy
 * verifyPinAsync call still runs (against DUMMY_PIN_HASH) so those cases
 * cost roughly the same as a real check — same reasoning as auth.ts's own
 * handleSignIn, applied here because rate-limiting alone does not close a
 * timing side channel.
 */
export async function findStaffByPin(email: string, pin: string): Promise<{ merchant: Merchant; staff: Staff } | null> {
  const merchant = await prisma.merchant.findUnique({ where: { email: normalizeEmail(email) } });
  if (!merchant) {
    await verifyPinAsync(pin, DUMMY_PIN_HASH);
    return null;
  }
  const staffList = await prisma.staff.findMany({ where: { merchantId: merchant.id, active: true } });
  if (staffList.length === 0) {
    // No active staff at all for this merchant — still pay the scrypt cost
    // so "a real business with zero staff configured" isn't distinguishable
    // by timing from "a real business whose staff list was just checked".
    await verifyPinAsync(pin, DUMMY_PIN_HASH);
    return null;
  }

  const results = await Promise.all(
    staffList.map(async (staff) => ({ staff, ok: await verifyPinAsync(pin, staff.pinHash) }))
  );
  const match = results.find((r) => r.ok)?.staff;
  if (!match) return null;
  return { merchant, staff: match };
}
