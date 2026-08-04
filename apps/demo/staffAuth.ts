// apps/demo/staffAuth.ts — staff session lifecycle for the stamp screen
// (BUILD.md §8.13). Deliberately separate from apps/demo/auth.ts's merchant
// Session: a different cookie name (`lnx-staff` vs `lnx-session`), a
// different database table (`StaffSession` vs `Session`), and a shorter
// TTL. That separation is the whole security property this feature rests
// on — every merchant-facing route (requireMerchant() in server.ts) only
// ever reads the `lnx-session` cookie, so a staff session is simply
// invisible to it; there is no shared code path that could accidentally
// treat one as the other.
//
// Split out of server.ts, same convention as auth.ts itself:
// apps/demo/test/staffAuth.test.ts exercises the session lifecycle directly
// against the real local Postgres, without going through HTTP.

import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { prisma } from '../../packages/db/src/index.ts';
import type { Staff, Merchant } from '@prisma/client';
import { readCookie, appendSetCookie } from './auth.ts';

const STAFF_SESSION_ID_BYTES = 32;
/** A work shift, not a month — unlike a merchant's own 30-day session, a staff PIN session sits on a shared/unattended shop device more often than not, so it should not stay valid indefinitely. Still generous enough to cover a long single shift without re-entering a PIN. */
export const STAFF_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const STAFF_SESSION_COOKIE_NAME = 'lnx-staff';

export interface StaffSessionRecord {
  id: string;
  expiresAt: Date;
}

/** Creates a new staff session row and returns its id/expiry — always a fresh, unrelated token on every PIN sign-in, same "rotation on login" rule as auth.ts's own createSession. */
export async function createStaffSession(staffId: string, merchantId: string): Promise<StaffSessionRecord> {
  const id = crypto.randomBytes(STAFF_SESSION_ID_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + STAFF_SESSION_TTL_MS);
  await prisma.staffSession.create({ data: { id, staffId, merchantId, expiresAt } });
  return { id, expiresAt };
}

/** Deletes a staff session row outright. Never throws on an already-gone id. */
export async function deleteStaffSession(id: string): Promise<void> {
  await prisma.staffSession.delete({ where: { id } }).catch(() => {});
}

/**
 * Resolves a staff session cookie value to its (staff, merchant), or `null`
 * when the id is missing, unknown, expired, or belongs to staff who have
 * since been deactivated. That last check runs on *every* resolution, not
 * only at PIN sign-in time — deactivating a staff member (apps/demo/staff.ts's
 * setStaffActive) must cut off an already-open session immediately, not
 * just block new sign-ins, or "deactivate" would not actually revoke access
 * until the session naturally expired up to 12 hours later.
 */
export async function getStaffForSession(
  sessionId: string | undefined
): Promise<{ staff: Staff; merchant: Merchant } | null> {
  if (!sessionId) return null;
  const session = await prisma.staffSession.findUnique({
    where: { id: sessionId },
    include: { staff: { include: { merchant: true } } },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) {
    prisma.staffSession.delete({ where: { id: sessionId } }).catch(() => {});
    return null;
  }
  if (!session.staff.active) return null;
  return { staff: session.staff, merchant: session.staff.merchant };
}

export function staffSessionIdFromRequest(req: IncomingMessage): string | undefined {
  return readCookie(req, STAFF_SESSION_COOKIE_NAME);
}

export function setStaffSessionCookie(res: ServerResponse, session: StaffSessionRecord): void {
  appendSetCookie(
    res,
    `${STAFF_SESSION_COOKIE_NAME}=${session.id}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${session.expiresAt.toUTCString()}`
  );
}

export function clearStaffSessionCookie(res: ServerResponse): void {
  appendSetCookie(res, `${STAFF_SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}
