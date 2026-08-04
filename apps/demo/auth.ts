// apps/demo/auth.ts — self-contained session authentication.
//
// docs/BUILD.md §2 specifies Firebase Auth. Standing up a real Firebase
// project needs console access the owner cannot do right now (see BUILD.md
// §2's 2026-08-04 note), so this ships a fully self-hosted alternative
// instead: email + password hashed with scrypt (node:crypto, never a plain
// or fast hash), and sessions stored in Postgres so sign-out and expiry
// invalidate a session server-side, not just by dropping a cookie. No new
// npm dependency — node:crypto covers both password hashing and session-id
// generation.
//
// Split out of server.ts so apps/demo/test/auth.test.ts can exercise the
// pure hashing/validation logic and the session lifecycle directly against
// the real local Postgres, without going through HTTP — same convention as
// cardEdit.ts / stamp.ts / enrol.ts.

import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { prisma } from '../../packages/db/src/index.ts';
import type { Merchant } from '@prisma/client';

// ---------------------------------------------------------------------------
// Password hashing — scrypt, node:crypto, a random salt per user.
//
// Encoded as `scrypt$N$r$p$saltHex$hashHex` so the cost parameters travel
// with the hash itself: a future bump to N (as hardware gets faster) never
// invalidates passwords hashed under the old cost, because verifyPassword
// reads N/r/p back out of the stored string rather than assuming today's
// constants. N=16384 (2^14) needs ~16 MiB of scratch memory per hash
// (128*N*r bytes) — comfortably under Node's default 32 MiB scrypt
// maxmem, and a standard "interactive login" cost as of 2026.
// ---------------------------------------------------------------------------
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/**
 * Verifies `password` against `stored` (hashPassword's own output).
 * Constant-time on the hash comparison (crypto.timingSafeEqual) so a
 * mismatch can't be distinguished by how long the check took; a malformed
 * `stored` value (wrong shape, bad hex, a cost scrypt now refuses) is just
 * treated as "does not match" rather than thrown.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltHex, hashHex] = parts;
  const N = Number.parseInt(nRaw!, 10);
  const r = Number.parseInt(rRaw!, 10);
  const p = Number.parseInt(pRaw!, 10);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (N <= 0 || r <= 0 || p <= 0) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex!, 'hex');
    expected = Buffer.from(hashHex!, 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = crypto.scryptSync(password, salt, expected.length, { N, r, p });
  } catch {
    return false; // e.g. N/r/p combination scrypt refuses (maxmem, non-power-of-two N, ...)
  }
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// Password policy — BUILD.md §8.1/§8.2's sign-up form: minimum length 10,
// and reject the ~20 most obvious passwords inline rather than shipping a
// password-strength library (no new dependency). Every listed password is
// itself >= 10 characters, so the "too common" reason is reachable on its
// own and never masked by the length check.
// ---------------------------------------------------------------------------
export const MIN_PASSWORD_LENGTH = 10;

const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  'password123',
  'password1234',
  '1234567890',
  '12345678910',
  'qwertyuiop',
  'qwerty12345',
  'letmein123',
  'welcome123',
  'admin12345',
  'iloveyou123',
  'monkey12345',
  'football123',
  'baseball123',
  'dragon12345',
  'sunshine123',
  'princess123',
  'trustno1234',
  'changeme123',
  'superman123',
  'whatever123',
  'freedom1234',
  'shadow12345',
]);

export type PasswordValidation = { ok: true } | { ok: false; reason: 'too_short' | 'too_common' };

export function validatePassword(password: string): PasswordValidation {
  if (password.length < MIN_PASSWORD_LENGTH) return { ok: false, reason: 'too_short' };
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return { ok: false, reason: 'too_common' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Sessions — an opaque random id (32 bytes, base64url — effectively
// unguessable) stored as the Session row's own primary key, so the id
// itself *is* the bearer token carried in the cookie. Deleting the row is
// what makes sign-out and expiry invalidate the session server-side: a
// cookie with a deleted or expired id resolves to no merchant at all.
// ---------------------------------------------------------------------------
const SESSION_ID_BYTES = 32;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — a sensible "stay signed in" lifetime for a merchant dashboard
export const SESSION_COOKIE_NAME = 'lnx-session';

export interface SessionRecord {
  id: string;
  expiresAt: Date;
}

/** Creates a new session row for `merchantId` and returns its id/expiry. Callers should always create a brand-new session on sign-in (never reuse/extend an old one) — that's what "rotation on login" means: a fresh, unrelated token every time, so an old leaked cookie can't be revived by a later legitimate sign-in. */
export async function createSession(merchantId: string): Promise<SessionRecord> {
  const id = crypto.randomBytes(SESSION_ID_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.session.create({ data: { id, merchantId, expiresAt } });
  return { id, expiresAt };
}

/** Deletes a session row outright — the server-side half of sign-out. Never throws on an already-gone id (double sign-out, or a raced expiry sweep). */
export async function deleteSession(id: string): Promise<void> {
  await prisma.session.delete({ where: { id } }).catch(() => {});
}

/**
 * Resolves a session cookie value to its Merchant, or `null` when the id is
 * missing, unknown, or expired. An expired session is best-effort deleted
 * here (never blocking the caller on it) so the table doesn't accumulate
 * dead rows forever — but the *decision* ("no merchant") never depends on
 * that cleanup succeeding.
 */
export async function getMerchantForSession(sessionId: string | undefined): Promise<Merchant | null> {
  if (!sessionId) return null;
  const session = await prisma.session.findUnique({ where: { id: sessionId }, include: { merchant: true } });
  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) {
    prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
    return null;
  }
  return session.merchant;
}

// ---------------------------------------------------------------------------
// Cookies — HttpOnly, Secure, SameSite=Lax, so the session id is never
// reachable from page JavaScript (HttpOnly), never sent over plain HTTP
// (Secure — this deployment is HTTPS-only, see docs/DEPLOY.md), and never
// attached to a cross-site POST (SameSite=Lax; still sent on a top-level
// GET navigation, e.g. following a link from email, which Strict would
// break).
// ---------------------------------------------------------------------------

/** Reads a single named cookie's value from a request, or undefined. Shared parsing logic — server.ts's own resolveLang() has an inline copy of this for `lnx-lang`; this is the same algorithm for any cookie name. */
export function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

export function sessionIdFromRequest(req: IncomingMessage): string | undefined {
  return readCookie(req, SESSION_COOKIE_NAME);
}

function appendSetCookie(res: ServerResponse, cookie: string): void {
  const existing = res.getHeader('Set-Cookie');
  if (existing === undefined) {
    res.setHeader('Set-Cookie', cookie);
  } else if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookie]);
  } else {
    res.setHeader('Set-Cookie', [String(existing), cookie]);
  }
}

export function setSessionCookie(res: ServerResponse, session: SessionRecord): void {
  appendSetCookie(
    res,
    `${SESSION_COOKIE_NAME}=${session.id}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${session.expiresAt.toUTCString()}`
  );
}

/** Clears the session cookie client-side. Callers must *also* deleteSession() the underlying row — clearing the cookie alone leaves a still-valid session id that a previously-copied cookie value (or a captured request) could keep using (BUILD.md job brief: "logout deletes the session row, not just the cookie"). */
export function clearSessionCookie(res: ServerResponse): void {
  appendSetCookie(res, `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

/** Normalises an email for storage/lookup — lowercased and trimmed, so `Ahmed@X.com` and `ahmed@x.com` are the same account rather than a silent duplicate-signup path. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}
