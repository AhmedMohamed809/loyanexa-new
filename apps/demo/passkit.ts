// apps/demo/passkit.ts
//
// The DB-facing half of the four Apple PassKit web-service endpoints
// (BUILD.md §9.3 / §12) — split out of server.ts so
// apps/demo/test/passkit.test.ts can exercise it directly against the real
// local Postgres, without going through HTTP, the same pattern
// apps/demo/stamp.ts already uses. HTTP framing (parsing the
// `Authorization`/`If-Modified-Since` headers off a real request, writing
// status codes onto a real response, building the signed .pkpass bytes for
// the "get latest pass" endpoint) stays in server.ts; this module only
// knows about Prisma rows and PassKit's auth/response semantics.
//
// Apple's four endpoints (paths are fixed by Apple):
//   POST   /apple/v1/devices/:deviceId/registrations/:passTypeId/:serial
//   GET    /apple/v1/devices/:deviceId/registrations/:passTypeId?passesUpdatedSince=
//   GET    /apple/v1/passes/:passTypeId/:serial
//   DELETE /apple/v1/devices/:deviceId/registrations/:passTypeId/:serial
// (`POST /apple/v1/log` needs no DB access at all — it's handled entirely
// in server.ts.)

import crypto from 'node:crypto';
import type { Card, Pass } from '@prisma/client';

import { prisma } from '../../packages/db/src/index.ts';

/**
 * Constant-time comparison of the `Authorization: ApplePass <token>` header
 * against a pass's own `authToken`. This token is the only thing standing
 * between a customer's pass and anyone who has merely learned its serial
 * number (e.g. by watching network traffic) — a naive `===` leaks timing
 * information proportional to how many leading bytes match, letting an
 * attacker recover the token byte by byte. `node:crypto.timingSafeEqual`
 * is the fix; it requires equal-length buffers, so the length check below
 * happens first (comparing *lengths* isn't a meaningful leak: every real
 * authToken is the same fixed length, produced by `crypto.randomBytes`).
 */
export function isValidPassAuth(authHeader: string | undefined, expectedToken: string): boolean {
  const prefix = 'ApplePass ';
  if (!authHeader || !authHeader.startsWith(prefix)) return false;
  const provided = Buffer.from(authHeader.slice(prefix.length), 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

export type RegisterResult = { status: 404 } | { status: 401 } | { status: 200 | 201 };

/**
 * POST /apple/v1/devices/:deviceId/registrations/:passTypeId/:serial —
 * upserts the Device row. Apple distinguishes a brand-new registration
 * (201) from one that already existed (200), so the existence check must
 * happen before the upsert.
 */
export async function registerDevice(params: {
  deviceId: string;
  serial: string;
  authHeader: string | undefined;
  pushToken: string;
}): Promise<RegisterResult> {
  const pass = await prisma.pass.findUnique({ where: { serial: params.serial } });
  if (!pass) return { status: 404 };
  if (!isValidPassAuth(params.authHeader, pass.authToken)) return { status: 401 };

  const existing = await prisma.device.findUnique({
    where: { deviceId_passSerial: { deviceId: params.deviceId, passSerial: params.serial } },
  });
  await prisma.device.upsert({
    where: { deviceId_passSerial: { deviceId: params.deviceId, passSerial: params.serial } },
    create: { deviceId: params.deviceId, passSerial: params.serial, pushToken: params.pushToken },
    update: { pushToken: params.pushToken },
  });
  return { status: existing ? 200 : 201 };
}

export type SerialsResult =
  | { status: 404 }
  | { status: 401 }
  | { status: 204 }
  | { status: 200; body: { serialNumbers: string[]; lastUpdated: string } };

/**
 * GET /apple/v1/devices/:deviceId/registrations/:passTypeId?passesUpdatedSince=
 *
 * A device can hold more than one pass under the same passType, so there is
 * no single "the" pass to check the auth header against here (unlike the
 * three serial-scoped endpoints below). Authenticate against any one of
 * the device's own registered passes' tokens — Apple only ever calls this
 * with the token from a pass it itself registered on this exact deviceId.
 */
export async function getUpdatedSerials(params: {
  deviceId: string;
  authHeader: string | undefined;
  passesUpdatedSince: string | undefined;
}): Promise<SerialsResult> {
  const devices = await prisma.device.findMany({
    where: { deviceId: params.deviceId },
    include: { pass: true },
  });
  if (devices.length === 0) return { status: 404 };
  if (!devices.some((d) => isValidPassAuth(params.authHeader, d.pass.authToken))) {
    return { status: 401 };
  }

  let candidates = devices.map((d) => d.pass);
  if (params.passesUpdatedSince) {
    const since = new Date(params.passesUpdatedSince);
    if (!Number.isNaN(since.getTime())) {
      candidates = candidates.filter((p) => p.updatedAt.getTime() > since.getTime());
    }
  }
  if (candidates.length === 0) return { status: 204 };

  const lastUpdated = candidates.reduce(
    (max, p) => (p.updatedAt > max ? p.updatedAt : max),
    candidates[0]!.updatedAt
  );
  return {
    status: 200,
    body: { serialNumbers: candidates.map((p) => p.serial), lastUpdated: lastUpdated.toISOString() },
  };
}

export type UnregisterResult = { status: 404 } | { status: 401 } | { status: 200 };

/** DELETE /apple/v1/devices/:deviceId/registrations/:passTypeId/:serial */
export async function unregisterDevice(params: {
  deviceId: string;
  serial: string;
  authHeader: string | undefined;
}): Promise<UnregisterResult> {
  const pass = await prisma.pass.findUnique({ where: { serial: params.serial } });
  if (!pass) return { status: 404 };
  if (!isValidPassAuth(params.authHeader, pass.authToken)) return { status: 401 };

  await prisma.device.deleteMany({ where: { deviceId: params.deviceId, passSerial: params.serial } });
  return { status: 200 };
}

export type GetPassResult =
  | { status: 404 }
  | { status: 401 }
  | { status: 304 }
  | { status: 200; pass: Pass & { card: Card } };

/**
 * GET /apple/v1/passes/:passTypeId/:serial — the DB lookup, auth check and
 * `If-Modified-Since` handling. Building and signing the actual `.pkpass`
 * bytes needs `@loyanexa/pass`/`@loyanexa/image` and the Apple credentials,
 * so that stays in server.ts (mirrors how handleIssuePass already works);
 * this only decides *whether* a rebuild is needed.
 */
export async function getPassForDownload(params: {
  serial: string;
  authHeader: string | undefined;
  ifModifiedSince: string | undefined;
}): Promise<GetPassResult> {
  const pass = await prisma.pass.findUnique({ where: { serial: params.serial }, include: { card: true } });
  if (!pass) return { status: 404 };
  if (!isValidPassAuth(params.authHeader, pass.authToken)) return { status: 401 };

  if (params.ifModifiedSince) {
    const ims = new Date(params.ifModifiedSince);
    // If-Modified-Since is HTTP-date (second precision); pass.updatedAt
    // carries milliseconds. Compare truncated to seconds so a pass that
    // hasn't changed since the client's last fetch reliably 304s instead
    // of failing the comparison on sub-second noise.
    if (!Number.isNaN(ims.getTime())) {
      const updatedAtSeconds = Math.floor(pass.updatedAt.getTime() / 1000);
      const imsSeconds = Math.floor(ims.getTime() / 1000);
      if (updatedAtSeconds <= imsSeconds) return { status: 304 };
    }
  }
  return { status: 200, pass };
}
