// LoyaNexa merchant demo — sub-project 3, first working screens.
//
// Plain node:http, no framework, no new dependencies. Production uses
// Fastify; this slice deliberately avoids it so there is nothing between
// the owner and a working screen. Persists to the real local Postgres via
// @loyanexa/db (Prisma) — no mocks, no fixtures.
//
// Run: npm run demo   (see package.json)
//
// Routes:
//   GET  /              — the marketing landing page (apps/demo/public/)
//   GET  /app            merchant card list
//   GET  /cards/new, POST /cards, GET /cards/:id
//   GET/POST /cards/:id/edit  the card designer (BUILD.md §8.5/§8.9) — POST
//                          fires an APNs live-update push to every device
//                          registered for that card's passes after
//                          responding, same fire-and-forget rule as
//                          POST /api/stamp below (see pushCardUpdate)
//   GET  /preview.png, GET /qr.png
//   GET  /stamp           the merchant stamp screen (BUILD.md §8.15)
//   POST /api/stamp        its write path — 24h anti-fraud guard (§9.6),
//                          fires APNs + Google Wallet live-update pushes
//                          after responding
//   Apple PassKit web service (BUILD.md §9.3 / §12 — paths fixed by Apple):
//     POST   /apple/v1/devices/:deviceId/registrations/:passTypeId/:serial
//     GET    /apple/v1/devices/:deviceId/registrations/:passTypeId
//     GET    /apple/v1/passes/:passTypeId/:serial
//     DELETE /apple/v1/devices/:deviceId/registrations/:passTypeId/:serial
//     POST   /apple/v1/log
//   GET  /:code           the customer enrol page (registered last — catch-all)
//   POST /:code/pass       issues a real signed Apple Wallet pass
//   POST /:code/google-pass  issues a Google Wallet pass (BUILD.md §9.5) —
//                          302s to a https://pay.google.com/gp/v/save/<jwt> link
//   GET  /health

import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import querystring from 'node:querystring';
import { fileURLToPath } from 'node:url';
import { Prisma, type Card, type Pass, type Merchant, type Staff, type BroadcastJob, type Device } from '@prisma/client';
import { buildPass, type PassCredentials, type PassImages } from '../../packages/pass/src/buildPass.ts';
import { buildPassContentFor } from './passContent.ts';
import {
  resolveAppleCredentials as resolveAppleCredentialPaths,
  resolveApnsKeyPem,
  resolveGoogleServiceAccount,
} from '../../packages/pass/src/credentials.ts';
import {
  ApnsClient,
  parseApnsEnvironment,
  parseApnsAuthMode,
  isBadEnvironmentKeyError,
} from '../../packages/pass/src/apns.ts';
import { GoogleWalletClient } from '../../packages/pass/src/googleWallet.ts';
import { t, arabicDigits, type Lang } from '../../packages/i18n/src/index.ts';
import { loadEnvFile } from './env.ts';
import {
  registerDevice,
  getUpdatedSerials,
  unregisterDevice,
  getPassForDownload,
} from './passkit.ts';
import { updateCard, activateCard, passCountForCard, type CardEditInput } from './cardEdit.ts';
import { pushCardDevices } from './cardPush.ts';
import { pkpassCacheKey } from './pkpassCache.ts';
import { createAppleCredentialsResolver } from './appleCredentials.ts';
import { csvRow } from './csv.ts';
import { createPassForEnrolment, deleteOrphanedPass } from './enrol.ts';
import { RateLimiter, resolveClientIp } from './rateLimit.ts';
import {
  enqueueBroadcast,
  recipientCountForCard,
  listBroadcastJobs,
  getBroadcastJob,
  sanitizeBroadcastMessage,
  BROADCAST_MESSAGE_MAX_LENGTH,
} from './broadcast.ts';
import { BroadcastWorker, type SendPushOutcome } from './broadcastWorker.ts';
import {
  hashPassword,
  verifyPassword,
  validatePassword,
  MIN_PASSWORD_LENGTH,
  createSession,
  deleteSession,
  getMerchantForSession,
  setSessionCookie,
  clearSessionCookie,
  sessionIdFromRequest,
  normalizeEmail,
} from './auth.ts';
import {
  createStaffSession,
  deleteStaffSession,
  getStaffForSession,
  setStaffSessionCookie,
  clearStaffSessionCookie,
  staffSessionIdFromRequest,
} from './staffAuth.ts';
import {
  createStaff,
  listStaff,
  setStaffActive,
  deleteStaff,
  validatePin,
  generatePin,
  findStaffByPin,
  MIN_PIN_LENGTH,
  MAX_PIN_LENGTH,
} from './staff.ts';
import {
  parseCardLocations,
  validateCardLocations,
  MAX_CARD_LOCATIONS,
  type RawLocationRow,
} from './locations.ts';
import {
  normalizeUpload,
  storeCardImage,
  imageUrl,
  isValidHash,
  isStoredLogoWide,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_REQUEST_BYTES,
  type UploadKind,
} from './cardImages.ts';
import { readMultipart } from './multipart.ts';
import type { ImageRef, StripSpec, StampSource, Fit, BuiltinIconId } from '../../packages/image/src/index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

loadEnvFile(path.join(ROOT, '.env'));

// ---------------------------------------------------------------------------
// Reuse the real packages — this is where design tokens and rendering come
// from. Native TS import (no build step): Node strips the erasable TS
// syntax these packages are written in. Dynamic (not static) import here,
// after loadEnvFile() above has run: @loyanexa/db constructs its
// PrismaClient — reading process.env.DATABASE_URL — the moment its module
// body executes, so that must happen after the .env values are in place,
// not at static-import hoist time.
// ---------------------------------------------------------------------------
const { prisma } = await import('../../packages/db/src/index.ts');
const {
  renderStrip,
  renderQrPng,
  MIN_GOAL,
  MAX_GOAL,
  renderAllDensities,
  MemoryStore,
  Surface,
  parseHexColor,
  fillDisc,
  encodePNG,
  decodePNG,
  contrastRatio,
  effectiveBackgroundHex,
  renderIconSwatch,
  BUILTIN_ICON_IDS,
  isBuiltinIconId,
} = await import('../../packages/image/src/index.ts');
// stamp.ts itself statically imports @loyanexa/db — dynamic here for the
// same reason as the block above (it must not run before loadEnvFile()).
const { applyStamp } = await import('./stamp.ts');

// PORT: containers (Fly.io included) inject the port to listen on via
// $PORT and expect the process to bind it — 8080 is Fly's own convention
// and a sane default for local runs too. An invalid/non-numeric value
// falls back to the default rather than crashing the server.
function resolvePort(): number {
  const raw = process.env.PORT;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 8080;
}
const PORT = resolvePort();

// PUBLIC_BASE_URL: set in production (Fly.io) to the app's public HTTPS
// origin, e.g. https://loyanexa-demo.fly.dev. When set, every enrol link
// and QR code uses it. Locally, where there is no public origin, we fall
// back to the machine's own LAN IP so the QR still resolves to something
// reachable from an iPhone on the same network. Getting this wrong means a
// deployed QR encodes a LAN address nobody outside the container can reach.
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '') || undefined;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const HEX_RE = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
function validHex(raw: unknown, fallback: string): string {
  const v = String(raw ?? '').trim();
  if (!HEX_RE.test(v)) return fallback;
  return v.startsWith('#') ? v : `#${v}`;
}

/** `raw` as a `StampSource` (BUILD.md §8.5 step 2's three-way stamp-source choice) if it names one, else `fallback` — shared by every place a query string or form field supplies this. */
function parseStampSource(raw: unknown, fallback: StampSource): StampSource {
  const v = String(raw ?? '').trim();
  return v === 'builtin' || v === 'icon' || v === 'plain' ? v : fallback;
}

/** A representative "some stamps punched" count for demo thumbnails/previews. */
function defaultFilled(goal: number): number {
  return Math.max(1, Math.floor(goal / 3));
}

function findLanUrl(port: number): string {
  const nets = os.networkInterfaces();
  for (const ifaceName of Object.keys(nets)) {
    for (const net of nets[ifaceName] ?? []) {
      if (net.family === 'IPv4' && !net.internal) {
        return `http://${net.address}:${port}`;
      }
    }
  }
  return `http://localhost:${port}`;
}
const LAN_URL = findLanUrl(PORT);
/** The origin every generated enrol link / QR code should use. */
const PUBLIC_URL = PUBLIC_BASE_URL ?? LAN_URL;

/** An Error carrying an HTTP status code, as produced by readUrlencodedBody. */
type HttpError = Error & { statusCode: number };
function isHttpError(e: unknown): e is HttpError {
  return e instanceof Error && typeof (e as { statusCode?: unknown }).statusCode === 'number';
}

/** Reads and caps a request body; returns the parsed urlencoded object. */
function readUrlencodedBody(
  req: http.IncomingMessage,
  maxBytes = 64 * 1024
): Promise<querystring.ParsedUrlQuery> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        const err: HttpError = Object.assign(new Error('request body too large'), {
          statusCode: 413,
        });
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      resolve(querystring.parse(raw));
    });
    req.on('error', reject);
  });
}

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
  });
  res.end(html);
}

function sendPng(res: http.ServerResponse, buffer: Buffer): void {
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store',
  });
  res.end(buffer);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
  });
  res.end(json);
}

/** Reads and caps a JSON request body. `{}` for an empty body — POST /api/stamp treats a missing `code` as a 400, not a parse error. */
function readJsonBody(req: http.IncomingMessage, maxBytes = 16 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        const err: HttpError = Object.assign(new Error('request body too large'), {
          statusCode: 413,
        });
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        const err: HttpError = Object.assign(new Error('invalid JSON body'), { statusCode: 400 });
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/** Reads the `lnx-lang` cookie (BUILD.md §13 — language persists in cookies, never localStorage, so the server can read it). This is the same cookie name the landing page's own language toggle writes (apps/demo/public/index.html) — one name shared by the whole site, or the merchant dashboard and the landing page silently diverge (as they did before this fix: this function used to read a `lang` cookie nothing ever wrote). Defaults to `ar`, matching Card/Merchant's own default locale. */
function resolveLang(req: http.IncomingMessage): Lang {
  const header = req.headers.cookie;
  if (!header) return 'ar';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== 'lnx-lang') continue;
    return part.slice(eq + 1).trim() === 'en' ? 'en' : 'ar';
  }
  return 'ar';
}

function sendNotFound(res: http.ServerResponse, message = 'Not found'): void {
  sendHtml(res, 404, layout('Not found', `<div class="panel"><h1>404</h1><p>${escapeHtml(message)}</p><p><a class="btn" href="/app">Back to cards</a></p></div>`));
}

/** A friendly, customer-facing 404 for the enrol page — no merchant chrome. */
function sendEnrolNotFound(res: http.ServerResponse, code: string): void {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Card not found · LoyaNexa</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body {
    background: #203757;
    color: #fff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px;
    text-align: center;
  }
  h1 { font-size: 22px; margin: 0 0 10px; }
  p { line-height: 1.5; opacity: 0.85; margin: 0; }
</style>
</head>
<body>
  <div>
    <h1>This card link isn't active</h1>
    <p>We couldn't find a loyalty card for &ldquo;${escapeHtml(code)}&rdquo;. Please check the code on your receipt or ask the shop for a new link.</p>
  </div>
</body>
</html>`;
  res.writeHead(404, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
  });
  res.end(html);
}

// ---------------------------------------------------------------------------
// Apple Wallet credentials — resolved at call time (never inlined, copied
// or committed), and only when a pass is actually being issued. A
// misconfigured/missing cert should not take down the rest of the demo.
//
// The cert/key/WWDR material itself comes from @loyanexa/pass's
// credentials.ts, which prefers PEM content from APPLE_SIGNER_CERT /
// APPLE_SIGNER_KEY / APPLE_WWDR_CERT (how Fly.io secrets arrive) and falls
// back to the APPLE_*_PATH files (how local dev has always worked). Only
// teamId/passTypeId are read here — they're plain identifiers, not secrets
// that need a files-vs-env split.
// ---------------------------------------------------------------------------
// Memoized (apps/demo/appleCredentials.ts) — the first call resolves
// APPLE_TEAM_ID/APPLE_PASS_TYPE_ID and materialises the signer/WWDR PEM
// paths; every later call in this process reuses that same result rather
// than re-reading env and rewriting the three temp PEM files on every
// `.pkpass` request, including the cache *hits* that never sign anything
// (BUILD.md §18 item 3's "measured, not guessed" spirit — this was found
// costing a filesystem write per request for no benefit).
const resolveAppleCredentials = createAppleCredentialsResolver(
  (key: string): string => {
    const v = process.env[key];
    if (!v) throw new Error(`.env is missing ${key}`);
    return v;
  },
  () => resolveAppleCredentialPaths(ROOT)
);

// ---------------------------------------------------------------------------
// APNs — one ApnsClient for the whole process (BUILD.md §18 item 3: it
// reuses one HTTP/2 session across every push, and — in token mode —
// caches its JWT; building a fresh client per push would defeat both).
// Built lazily on first use, not at module load, so a machine missing its
// credentials (e.g. a contributor's laptop that never set the cert/key
// paths) still runs the rest of the demo — it just never sends live-update
// pushes, which is logged once, clearly, rather than crashing the whole
// server.
// ---------------------------------------------------------------------------
// APNS_ENV (production|sandbox, default production) picks which of Apple's
// two gateways every push in this process targets. APNS_AUTH
// (certificate|token, default certificate) picks how it authenticates —
// see apns.ts's file-level comment and parseApnsAuthMode()'s doc comment
// for why certificate is the default: this deployment's APNs Auth Key is
// provisioned sandbox-only, so token mode 403s (BadEnvironmentKeyInToken)
// against production until that's fixed in the Apple Developer portal,
// while the Pass Type ID certificate we already hold for signing works
// against both gateways today (docs/BUILD.md §2's 2026-08-03 note has the
// measured evidence). Both read once at module load: which gateway/mode a
// running process talks to should never change mid-process.
const APNS_ENV = parseApnsEnvironment(process.env.APNS_ENV);
const APNS_AUTH = parseApnsAuthMode(process.env.APNS_AUTH);

let apnsClient: ApnsClient | null | undefined; // undefined = not yet attempted; null = attempted, unavailable
function getApnsClient(): ApnsClient | undefined {
  if (apnsClient !== undefined) return apnsClient ?? undefined;
  try {
    if (APNS_AUTH === 'certificate') {
      // Reuse exactly the credentials already materialised for *signing*
      // passes (resolveAppleCredentialPaths(), just above) as the mTLS
      // client certificate — Apple's pre-token APNs provider-auth method.
      // The chain must carry the WWDR intermediate too (see apns.ts's
      // ApnsCertificateAuth doc comment for why), so read both files and
      // concatenate rather than just the leaf cert.
      const { signerCertPath, signerKeyPath, wwdrPath } = resolveAppleCredentialPaths(ROOT);
      const certChainPem = `${fs.readFileSync(signerCertPath, 'utf8')}\n${fs.readFileSync(wwdrPath, 'utf8')}`;
      const keyPem = fs.readFileSync(signerKeyPath, 'utf8');
      apnsClient = new ApnsClient({
        auth: { mode: 'certificate', certChainPem, keyPem },
        environment: APNS_ENV,
      });
    } else {
      const keyId = process.env.APNS_KEY_ID;
      const teamId = process.env.APPLE_TEAM_ID;
      if (!keyId) throw new Error('.env is missing APNS_KEY_ID');
      if (!teamId) throw new Error('.env is missing APPLE_TEAM_ID');
      const privateKeyPem = resolveApnsKeyPem(ROOT);
      apnsClient = new ApnsClient({
        auth: { mode: 'token', keyId, teamId, privateKeyPem },
        environment: APNS_ENV,
      });
    }
    return apnsClient;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[apns] not configured (auth=${APNS_AUTH}) — live-update pushes are disabled (${message})`);
    apnsClient = null;
    return undefined;
  }
}

/**
 * Pushes the content-free wake-up notification (BUILD.md §9.3) to every
 * device registered for `serial`, and prunes any Device row APNs reports
 * as 410 Gone (the pass was removed from that phone). Also PATCHes the
 * matching Google Wallet `LoyaltyObject`'s stamp balance, if one exists —
 * the Android counterpart to the APNs push (BUILD.md §9.5), which needs no
 * device-registration step of its own (see googleWallet.ts's
 * `updateLoyaltyObject` doc comment). Callers must invoke this *after*
 * responding to the triggering request (BUILD.md §18 item 6) — it is never
 * awaited by a request handler, only fired from one.
 */
async function pushPassUpdate(serial: string, stamps: number, goal: number): Promise<void> {
  await Promise.all([pushApnsUpdate(serial), pushGoogleWalletUpdate(serial, stamps, goal)]);
}

async function pushApnsUpdate(serial: string): Promise<void> {
  const client = getApnsClient();
  if (!client) return; // getApnsClient() already logged why, once.
  const passTypeId = process.env.APPLE_PASS_TYPE_ID;
  if (!passTypeId) {
    console.error('[apns] .env is missing APPLE_PASS_TYPE_ID — cannot set apns-topic, skipping push');
    return;
  }

  const devices = await prisma.device.findMany({ where: { passSerial: serial } });
  await Promise.all(
    devices.map(async (device) => {
      const result = await client.sendPush(device.pushToken, passTypeId);
      if (result.ok) return;
      if (result.reason === 'gone') {
        await prisma.device
          .delete({ where: { deviceId_passSerial: { deviceId: device.deviceId, passSerial: serial } } })
          .catch(() => {}); // already gone / raced with an unregister — fine either way
        console.log(`[apns] pass ${serial}: pruned device ${device.deviceId} (410 Gone)`);
      } else if (isBadEnvironmentKeyError(result.status, result.body)) {
        // The one failure mode worth a special, actionable line instead of
        // a raw Apple error: this is a portal setting, not a code bug (see
        // apns.ts's isBadEnvironmentKeyError doc comment) — whoever hits
        // this next should not have to re-derive that from a bare 403.
        console.error(
          `[apns] pass ${serial}: push to device ${device.deviceId} rejected — BadEnvironmentKeyInToken. ` +
            `APNs key ${process.env.APNS_KEY_ID ?? '(unknown)'} is not provisioned for the '${APNS_ENV}' ` +
            `environment this server is configured to use (${client.host}). Fix: in the Apple Developer ` +
            `portal, enable this key for '${APNS_ENV}' push, or set APNS_ENV to the environment the key ` +
            `actually supports.`
        );
      } else {
        // One clear line naming the auth mode, the host and Apple's own
        // `reason` — so the next person debugging a failed push does not
        // have to re-derive any of what's in apns.ts's file-level comment
        // (which mode is active, which gateway it's talking to) from a
        // bare status/body pair.
        console.error(
          `[apns] pass ${serial}: push to device ${device.deviceId} failed — auth=${client.authMode} ` +
            `host=${client.host} status=${result.status} body=${result.body}`
        );
      }
    })
  );
}

/**
 * Pushes the live-update wake-up (BUILD.md §9.3) to every device
 * registered for any pass issued against `cardId` — the design-edit
 * counterpart to pushApnsUpdate's per-pass fan-out above. A card's
 * colours/logo/stamp icon/background/shape are shared by every customer
 * holding one of its passes, so a single edit can affect every `.pkpass`
 * that card has ever issued (see PKPASS_STORE's doc comment: the cache key
 * now includes Card.updatedAt for exactly this reason). Fixing the cache
 * key alone only means the *next* device poll picks up the new design —
 * this is what makes it show up immediately instead. Uses
 * apps/demo/cardPush.ts's devicesForCard()/pushCardDevices() for the DB
 * side (testable without an ApnsClient); the send itself and its
 * error/gone handling mirror pushApnsUpdate above. Callers must invoke this
 * *after* responding to the triggering request (BUILD.md §18 item 6), same
 * as pushPassUpdate.
 */
async function pushCardUpdate(cardId: string): Promise<void> {
  const client = getApnsClient();
  if (!client) return; // getApnsClient() already logged why, once.
  const passTypeId = process.env.APPLE_PASS_TYPE_ID;
  if (!passTypeId) {
    console.error('[apns] .env is missing APPLE_PASS_TYPE_ID — cannot set apns-topic, skipping card-edit push');
    return;
  }

  await pushCardDevices(cardId, async (device) => {
    const result = await client.sendPush(device.pushToken, passTypeId);
    if (result.ok) return { ok: true };
    if (result.reason === 'gone') {
      console.log(`[apns] card ${cardId}: pruned device ${device.deviceId} (410 Gone, pass ${device.passSerial})`);
      return { ok: false, gone: true };
    }
    if (isBadEnvironmentKeyError(result.status, result.body)) {
      // Same actionable line as pushApnsUpdate's own — see that function's
      // comment for why this particular failure gets special treatment.
      console.error(
        `[apns] card ${cardId}: push to device ${device.deviceId} rejected — BadEnvironmentKeyInToken. ` +
          `APNs key ${process.env.APNS_KEY_ID ?? '(unknown)'} is not provisioned for the '${APNS_ENV}' ` +
          `environment this server is configured to use (${client.host}). Fix: in the Apple Developer ` +
          `portal, enable this key for '${APNS_ENV}' push, or set APNS_ENV to the environment the key ` +
          `actually supports.`
      );
    } else {
      console.error(
        `[apns] card ${cardId}: push to device ${device.deviceId} (pass ${device.passSerial}) failed — ` +
          `auth=${client.authMode} host=${client.host} status=${result.status} body=${result.body}`
      );
    }
    return { ok: false };
  });
}

// ---------------------------------------------------------------------------
// Google Wallet — one GoogleWalletClient for the whole process, mirroring
// ApnsClient just above: it caches its OAuth2 access token, so building a
// fresh client per request would defeat that (BUILD.md §9.5 / the job
// brief: "reuse the access token across calls with a short cache, the way
// the APNs JWT is cached"). Built lazily, and — same reasoning as
// getApnsClient() — a machine without GOOGLE_SERVICE_ACCOUNT_PATH configured
// still runs the rest of the demo; Google Wallet is just disabled, logged
// once, not a crash.
// ---------------------------------------------------------------------------
let googleWalletClient: GoogleWalletClient | null | undefined; // undefined = not yet attempted; null = attempted, unavailable
function getGoogleWalletClient(): GoogleWalletClient | undefined {
  if (googleWalletClient !== undefined) return googleWalletClient ?? undefined;
  try {
    const issuerId = process.env.GOOGLE_ISSUER_ID;
    if (!issuerId) throw new Error('.env is missing GOOGLE_ISSUER_ID');
    if (!PUBLIC_BASE_URL) {
      // programLogo and the save-link JWT's `origins` both need a real
      // public HTTPS origin (BUILD.md §9.5) — there is no meaningful LAN
      // fallback the way there is for enrol links/QR codes.
      throw new Error('PUBLIC_BASE_URL is not set — Google Wallet needs a public HTTPS origin');
    }
    const serviceAccount = resolveGoogleServiceAccount(ROOT);
    googleWalletClient = new GoogleWalletClient({
      issuerId,
      serviceAccountEmail: serviceAccount.client_email,
      privateKeyPem: serviceAccount.private_key,
      publicBaseUrl: PUBLIC_BASE_URL,
    });
    return googleWalletClient;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[google-wallet] not configured — Google Wallet is disabled (${message})`);
    googleWalletClient = null;
    return undefined;
  }
}

/**
 * PATCHes the Google Wallet `LoyaltyObject` balance for `serial`, if
 * Google Wallet is configured. `reason: 'not_found'` just means this pass
 * was never added to Google Wallet (the customer used Apple, or hasn't
 * saved either yet) — not worth logging, same as APNs' "no devices
 * registered" case above never logging anything either.
 */
async function pushGoogleWalletUpdate(serial: string, stamps: number, goal: number): Promise<void> {
  const client = getGoogleWalletClient();
  if (!client) return; // getGoogleWalletClient() already logged why, once.

  const result = await client.updateLoyaltyObject(serial, stamps, goal);
  if (!result.ok && result.reason === 'error') {
    console.error(
      `[google-wallet] pass ${serial}: updateLoyaltyObject failed — status=${result.status} body=${result.body}`
    );
  }
}

/** A shared strip-render cache, reused across every pass issuance (BUILD.md §10 — the strip cache is a 455x measured win; do not re-render per request). */
const PASS_STRIP_STORE = new MemoryStore();

// ---------------------------------------------------------------------------
// Rebuilt-.pkpass cache for the PassKit "get latest pass" web service
// (BUILD.md §9.3 step 5). The strip cache above already makes strip
// rendering cheap; signing does not — buildPass() shells out to `openssl
// smime` and `zip` on every call, measured at ~24ms even with a cached
// strip. That is a meaningful slice of the 1-2 second live-update budget
// when it happens on the critical path of the device's post-push GET, and
// it happens more than once per stamp: the device that owns the pass fetches
// it, but so can a second device with the same pass added, or the same
// device retrying after a dropped connection. A build is fully determined
// by the owning Pass's own (serial, stamps, updatedAt) *and* its Card's
// design (bgColor/logo/stampSource/… — everything the card designer lets a
// merchant change; see apps/demo/pkpassCache.ts's doc comment for the
// 2026-08-03 regression this covers) — the content and every image the
// pass carries derive from those and nothing else (buildPassContentFor,
// stripSpecForCard) — so a repeat fetch for a key already built is served
// from memory instead of re-signing. Bounded LRU, same MemoryStore used
// for strips; single-flight below prevents two concurrent requests for a
// still-uncached key each paying the ~24ms cost.
// ---------------------------------------------------------------------------
const PKPASS_STORE = new MemoryStore();
const pkpassInFlight = new Map<string, Promise<Buffer>>();

/** Builds (or reuses a cached / in-flight build of) the signed .pkpass for `pass` — see PKPASS_STORE's doc comment above for why this exists and what makes a cache entry valid. */
async function cachedBuildPass(
  credentials: PassCredentials,
  pass: Pass & { card: Card }
): Promise<Buffer> {
  const key = pkpassCacheKey(pass.serial, pass.stamps, pass.updatedAt, pass.card.updatedAt);
  const hit = await PKPASS_STORE.get(key);
  if (hit) return hit;

  const pending = pkpassInFlight.get(key);
  if (pending) return pending;

  const task = (async () => {
    const stripSet = await renderAllDensities(PASS_STRIP_STORE, await stripSpecForCard(pass.card, pass.stamps));
    const images = await buildPassImagesFor(pass.card, stripSet);
    const content = buildPassContentFor(pass.card, pass, { publicBaseUrl: PUBLIC_BASE_URL });
    const pkpass = buildPass(credentials, content, images);
    await PKPASS_STORE.set(key, pkpass);
    return pkpass;
  })();
  pkpassInFlight.set(key, task);
  try {
    return await task;
  } finally {
    // Always clear, on success or failure — otherwise a single thrown build
    // poisons this key forever (mirrors packages/image/src/stripCache.ts's
    // cachedStrip, which this is deliberately modelled on).
    pkpassInFlight.delete(key);
  }
}

/** icon.png / icon@2x.png — the merchant's own card colours, not ours (same principle as the enrol page). */
function makeCardIcon(size: number, bgColor: string, accentColor: string): Buffer {
  const surface = new Surface(size, size);
  surface.fill(parseHexColor(bgColor, 1));
  fillDisc(surface, size / 2, size / 2, size * 0.36, parseHexColor(accentColor, 1));
  return encodePNG(surface.toRGBA(), size, size);
}

/** A filesystem/header-safe filename stem from the card's own name. */
function passFilenameStem(name: string): string {
  const slug = name.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'card';
}

// ---------------------------------------------------------------------------
// Merchant resolution — session auth (see docs/BUILD.md §2's 2026-08-04
// note and apps/demo/auth.ts). Every merchant-facing route below resolves
// its merchant from the session cookie via requireMerchant(), never from
// "the only merchant row that exists" the way the old single-tenant demo
// did — that is exactly the gap this branch closes.
// ---------------------------------------------------------------------------

/**
 * Guards a merchant-facing route: resolves the signed-in Merchant from the
 * session cookie, or 302s to /signin (carrying the original path as `next`)
 * and returns `undefined` when there is no valid session. Callers must
 * check for `undefined` and return immediately without writing any further
 * response — requireMerchant has already sent one.
 */
async function requireMerchant(req: http.IncomingMessage, res: http.ServerResponse): Promise<Merchant | undefined> {
  const merchant = await getMerchantForSession(sessionIdFromRequest(req));
  if (merchant) return merchant;
  const next = encodeURIComponent(req.url ?? '/app');
  res.writeHead(302, { Location: `/signin?next=${next}` });
  res.end();
  return undefined;
}

/**
 * Loads Card `id`, scoped to `merchantId` — the one lookup every
 * merchant-facing card route uses instead of a bare `findUnique({ where:
 * { id } })`. A card that exists but belongs to a different merchant comes
 * back `null`, identical to one that doesn't exist at all: the caller's
 * usual `sendNotFound` renders the same 404 either way, so a request can
 * never learn that someone else's card id is real (BUILD.md job brief: 404,
 * not 403).
 */
function findOwnedCard(id: string, merchantId: string): Promise<Card | null> {
  return prisma.card.findFirst({ where: { id, merchantId } });
}

/**
 * Who is allowed to open the stamp screen (BUILD.md §8.13): the merchant
 * themself (`staff` absent — an owner-recorded stamp), or a signed-in staff
 * member (`staff` present — a staff-recorded one). This is the *only*
 * resolver GET /stamp and POST /api/stamp use — never requireMerchant(),
 * which would 302 a staff session straight to /signin. Every other
 * merchant-facing route keeps using requireMerchant() exactly as before, so
 * a staff session (the `lnx-staff` cookie) is simply invisible to them: it
 * is never read by anything except this function and staffAuth.ts's own
 * getStaffForSession.
 */
interface StampAuth {
  merchant: Merchant;
  staff?: Staff;
}
async function resolveStampAuth(req: http.IncomingMessage): Promise<StampAuth | undefined> {
  const staffSessionId = staffSessionIdFromRequest(req);
  if (staffSessionId) {
    const resolved = await getStaffForSession(staffSessionId);
    if (resolved) return { merchant: resolved.merchant, staff: resolved.staff };
  }
  const merchant = await getMerchantForSession(sessionIdFromRequest(req));
  if (merchant) return { merchant };
  return undefined;
}

/** Atomically allocate the next link code from the shared counter (starts at 10000). */
async function nextLinkCode(): Promise<number> {
  await prisma.linkCounter.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, value: 10000 },
  });
  const row = await prisma.linkCounter.update({
    where: { id: 1 },
    data: { value: { increment: 1 } },
  });
  return row.value;
}

function generateShortCode(): string {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

// ---------------------------------------------------------------------------
// HTML shell — BUILD.md §3 as revised 2026-08-03: dark canvas #0F172A, paper
// #1C2A42, sunk #162338, accent #F28C38, Alexandria typeface, radius
// 14-18px, borders doing the separating (no gradients, no glass blur). The
// same token set already used standalone by renderStampScreen() above — one
// shell for every merchant page from here on, so the two never drift apart.
// ---------------------------------------------------------------------------
type NavKey = 'cards' | 'customers' | 'reports' | 'stamp' | 'notifications' | 'settings';

/** The top nav bar BUILD.md §6 wants reachable from every merchant page: Cards · Customers · Reports · Stamp screen · Settings (this build's revision of the historical bottom tab bar list; Settings — BUILD.md §8.13 — added alongside staff PINs and location reminders). Shared between layout() below and renderStampScreen() *only when viewed as the merchant* — a staff session gets its own, deliberately shorter header (see renderStampScreen's own doc comment) that omits every link a staff session cannot reach. */
function navBar(active: NavKey | undefined, lang: Lang = 'en'): string {
  const items: Array<{ key: NavKey; href: string; label: string }> = [
    { key: 'cards', href: '/app', label: t(lang, 'navCards') },
    { key: 'customers', href: '/customers', label: t(lang, 'navCustomers') },
    { key: 'reports', href: '/reports', label: t(lang, 'navReports') },
    { key: 'stamp', href: '/stamp', label: t(lang, 'navStamp') },
    { key: 'notifications', href: '/notifications', label: t(lang, 'navNotifications') },
    { key: 'settings', href: '/settings', label: t(lang, 'navSettings') },
  ];
  return `<header class="top">
  <a class="brand" href="/app">LoyaNexa</a>
  <nav class="nav">
    ${items
      .map(
        (i) =>
          `<a href="${i.href}"${i.key === active ? ' class="active" aria-current="page"' : ''}>${escapeHtml(i.label)}</a>`
      )
      .join('\n    ')}
  </nav>
  <form method="POST" action="/signout" style="margin:0;">
    <button type="submit" class="btn secondary small">${escapeHtml(t(lang, 'navSignOut'))}</button>
  </form>
</header>`;
}

function layout(title: string, bodyHtml: string, active?: NavKey, lang: Lang = 'en'): string {
  return `<!doctype html>
<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · LoyaNexa</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Alexandria:wght@300;400;500;600;700;800&display=swap">
<style>
  :root {
    --canvas: #0F172A;
    --paper: #1C2A42;
    --sunk: #162338;
    --raise: #22314C;
    --accent: #F28C38;
    --accent-hover: #E67E22;
    --accent-light: #F7B267;
    --on-accent: #0F172A;
    --ink: #FFFFFF;
    --ink-2: #CBD5E1;
    --ink-3: #94A3B8;
    --line: rgba(255,255,255,.10);
    --green: #22C55E;
    --red: #EF4444;
    --amber: #F7B267;
    --radius: 14px;
    --radius-lg: 18px;
  }
  html[lang="ar"] * { letter-spacing: 0 !important; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--canvas);
    color: var(--ink);
    font-family: 'Alexandria', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  header.top {
    background: var(--sunk);
    border-bottom: 1px solid var(--line);
    padding: 14px 24px;
    display: flex;
    align-items: center;
    gap: 28px;
  }
  header.top a.brand { color: var(--ink); text-decoration: none; font-weight: 800; font-size: 17px; letter-spacing: 0.2px; }
  header.top nav.nav { display: flex; gap: 4px; flex-wrap: wrap; margin-inline-start: auto; }
  header.top nav.nav a {
    color: var(--ink-2); text-decoration: none; font-weight: 600; font-size: 14px;
    padding: 8px 14px; border-radius: 100px;
  }
  header.top nav.nav a:hover { color: var(--ink); background: var(--raise); }
  header.top nav.nav a.active { color: var(--on-accent); background: var(--accent); }
  main {
    max-width: 1000px;
    margin: 0 auto;
    padding: 24px 20px 64px;
  }
  .banner {
    background: rgba(242,140,56,.10);
    border: 1px solid rgba(242,140,56,.30);
    color: var(--accent-light);
    border-radius: var(--radius-lg);
    padding: 14px 18px;
    margin-bottom: 20px;
    font-size: 14px;
    line-height: 1.5;
  }
  .banner b { color: var(--ink); }
  .panel {
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    padding: 24px;
    margin-bottom: 20px;
  }
  h1 { font-size: 24px; margin: 0 0 6px; color: var(--ink); }
  h2 { font-size: 16px; margin: 0 0 14px; color: var(--ink); }
  p { line-height: 1.5; }
  .muted { color: var(--ink-3); }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .btn {
    display: inline-block;
    background: var(--accent);
    color: var(--on-accent);
    border: none;
    border-radius: 100px;
    padding: 12px 22px;
    font-weight: 700;
    font-size: 15px;
    text-decoration: none;
    cursor: pointer;
    font-family: inherit;
  }
  .btn:hover { background: var(--accent-hover); }
  .btn.secondary {
    background: transparent;
    color: var(--ink);
    border: 1px solid var(--line);
  }
  .btn.secondary:hover { background: var(--raise); }
  .btn[disabled] { opacity: .5; cursor: default; }
  .cards-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 16px;
  }
  .card-tile {
    display: block;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    overflow: hidden;
    text-decoration: none;
    color: inherit;
  }
  .card-tile img { display: block; width: 100%; height: auto; background: var(--sunk); }
  .card-tile .meta { padding: 14px 16px; border-top: 1px solid var(--line); }
  .card-tile .meta h3 { margin: 0 0 4px; font-size: 15px; color: var(--ink); }
  .card-tile .meta p { margin: 0; font-size: 13px; color: var(--ink-3); }
  .empty {
    text-align: center;
    padding: 48px 24px;
  }
  form .field { margin-bottom: 18px; }
  label { display: block; font-weight: 600; font-size: 13px; margin-bottom: 6px; color: var(--ink-2); }
  input[type="text"], input[type="number"], input[type="tel"], select, textarea {
    width: 100%;
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 12px 14px;
    font-size: 15px;
    background: var(--sunk);
    color: var(--ink);
    font-family: inherit;
  }
  select { appearance: auto; }
  input[disabled], select[disabled], textarea[disabled] { opacity: .55; cursor: not-allowed; }
  input[type="range"] { width: 100%; }
  input[type="color"] {
    width: 56px;
    height: 40px;
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 2px;
    background: var(--paper);
  }
  .colors { display: flex; gap: 24px; flex-wrap: wrap; }
  .colors .field { margin-bottom: 0; }
  .preview-panel { text-align: center; background: var(--sunk); border: 1px dashed var(--line); border-radius: var(--radius-lg); padding: 20px; }
  .preview-panel img { max-width: 100%; }
  .error { background: rgba(239,68,68,.12); border: 1px solid rgba(239,68,68,.35); color: #FCA5A5; border-radius: 12px; padding: 12px 16px; margin-bottom: 18px; font-size: 14px; }
  code.pill { background: var(--sunk); border: 1px solid var(--line); border-radius: 8px; padding: 4px 10px; font-size: 13px; color: var(--ink-2); font-family: inherit; }
  .kv { display: grid; grid-template-columns: 140px 1fr; gap: 10px 16px; font-size: 15px; }
  .kv dt { color: var(--ink-3); }
  .kv dd { margin: 0; color: var(--ink); }
  .qr-wrap { text-align: center; padding: 20px; background: var(--sunk); border-radius: var(--radius-lg); border: 1px solid var(--line); }
  .qr-wrap img { image-rendering: pixelated; border-radius: 8px; background: #fff; padding: 12px; }
  .lock { opacity: .55; }
  .lock label::after { content: ' 🔒'; }
  table.data { width: 100%; border-collapse: collapse; font-size: 14px; }
  table.data th, table.data td { text-align: start; padding: 10px 12px; border-bottom: 1px solid var(--line); }
  table.data th { color: var(--ink-3); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  table.data td { color: var(--ink); }
  table.data code.mono { font-variant-numeric: tabular-nums; letter-spacing: .04em; }
  .progress-bar { display: flex; align-items: center; gap: 8px; min-width: 120px; }
  .progress-bar .track { flex: 1; height: 6px; border-radius: 100px; background: var(--sunk); overflow: hidden; }
  .progress-bar .fill { height: 100%; background: var(--accent); }
  .progress-bar span.frac { font-size: 12px; color: var(--ink-3); white-space: nowrap; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-bottom: 20px; }
  .kpi { background: var(--paper); border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 18px 20px; }
  .kpi .n { font-size: 28px; font-weight: 800; color: var(--ink); }
  .kpi .label { font-size: 13px; color: var(--ink-3); margin-top: 4px; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; }
  .chip {
    display: inline-block; padding: 8px 16px; border-radius: 100px; font-size: 13px; font-weight: 600;
    border: 1px solid var(--line); color: var(--ink-2); text-decoration: none;
  }
  .chip.active { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
  .chip.locked { background: rgba(242,140,56,.12); color: var(--accent-light); border-color: rgba(242,140,56,.3); }
  .funnel { display: flex; flex-direction: column; gap: 12px; }
  .funnel .step { display: grid; grid-template-columns: 180px 1fr 60px; align-items: center; gap: 12px; font-size: 14px; }
  .funnel .track { height: 22px; border-radius: 8px; background: var(--sunk); overflow: hidden; }
  .funnel .fill { height: 100%; background: var(--accent); border-radius: 8px; }
  .weekday-chart { display: flex; align-items: flex-end; gap: 10px; height: 140px; }
  .weekday-chart .bar-wrap { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; gap: 6px; }
  .weekday-chart .bar { width: 100%; background: var(--accent); border-radius: 6px 6px 0 0; min-height: 2px; }
  .weekday-chart .day-label { font-size: 11px; color: var(--ink-3); }
  .weekday-chart .day-count { font-size: 11px; color: var(--ink-2); }
  .no-data { text-align: center; color: var(--ink-3); padding: 28px 12px; font-size: 14px; }

  /* Card designer (BUILD.md §8.5 / §8.9) — controls on the left, a live,
     sticky preview on the right; stacks to a single column with the
     preview pinned above the controls on narrow screens. */
  .designer { display: grid; grid-template-columns: 1fr 340px; gap: 20px; align-items: start; }
  .designer-controls { min-width: 0; }
  .designer-preview { position: sticky; top: 20px; }
  .designer-preview .preview-panel img { width: 100%; height: auto; border-radius: 10px; }
  .designer-preview .hint { font-size: 12px; color: var(--ink-3); margin-top: 10px; line-height: 1.5; }
  @media (max-width: 860px) {
    .designer { grid-template-columns: 1fr; }
    .designer-preview { position: static; order: -1; margin-bottom: 4px; }
  }
  .designer h2 { margin-top: 28px; padding-top: 20px; border-top: 1px solid var(--line); }
  .designer h2:first-child { margin-top: 0; padding-top: 0; border-top: none; }
  .upload-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .upload-thumb {
    width: 64px; height: 64px; border-radius: 10px; background: var(--sunk);
    border: 1px solid var(--line); object-fit: cover; display: none;
  }
  .upload-thumb.cover-thumb { width: 96px; height: 37px; }
  .upload-thumb.shown { display: block; }
  .upload-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  input[type="file"] { display: none; }
  .btn.small { padding: 8px 16px; font-size: 13px; }
  .btn.remove { background: transparent; color: var(--red); border: 1px solid rgba(239,68,68,.35); }
  .btn.remove:hover { background: rgba(239,68,68,.12); }
  .btn.remove[disabled] { opacity: .4; cursor: default; }
  .upload-error { color: #FCA5A5; font-size: 13px; margin-top: 6px; }
  .hex-row { display: flex; align-items: center; gap: 8px; }
  .hex-row input[type="color"] { flex: none; }
  .hex-row input[type="text"] { width: 96px; flex: none; text-transform: uppercase; }
  .range-row { display: flex; align-items: center; gap: 12px; }
  .range-row input[type="range"] { flex: 1; }
  .range-row .range-val { font-size: 13px; color: var(--ink-2); min-width: 34px; text-align: end; }
  .shape-toggle { display: flex; gap: 8px; }
  .shape-toggle label {
    display: flex; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: 10px;
    padding: 10px 14px; cursor: pointer; font-weight: 500; font-size: 14px; color: var(--ink-2); margin: 0;
    flex: 1; justify-content: center;
  }
  .shape-toggle input { accent-color: var(--accent); }
  .switch-row { display: flex; align-items: center; gap: 10px; }
  .switch-row label { margin: 0; font-weight: 500; }
  .switch-row input[type="checkbox"] { width: 18px; height: 18px; accent-color: var(--accent); }
  .icon-grid { display: flex; flex-wrap: wrap; gap: 8px; }
  .icon-swatch {
    position: relative; display: flex; align-items: center; justify-content: center;
    width: 52px; height: 52px; border-radius: 10px; border: 1px solid var(--line);
    background: var(--sunk); cursor: pointer; margin: 0;
  }
  .icon-swatch.selected { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent) inset; }
  .icon-swatch input { position: absolute; opacity: 0; width: 0; height: 0; }
  .icon-swatch img { width: 28px; height: 28px; }
  .field-hint { font-size: 12px; color: var(--ink-3); margin-top: 4px; }
  .field-hint.amber { color: var(--amber); }

  /* Location reminders (BUILD.md §9.4/§8.13) — a variable-length list of
     fieldsets, added/removed entirely client-side (plain JS, no server
     round trip) until Save is pressed. */
  .locations-heading-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .locations-counter { font-size: 13px; color: var(--ink-3); white-space: nowrap; }
  .locations-intro { font-size: 13px; color: var(--ink-2); line-height: 1.5; margin: 4px 0 16px; }
  .locations-empty { text-align: center; color: var(--ink-3); padding: 20px 12px; font-size: 13px; border: 1px dashed var(--line); border-radius: 12px; margin-bottom: 14px; }
  .location-row { border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin-bottom: 12px; background: var(--sunk); }
  .location-row .row-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .location-row .row-title { font-size: 13px; font-weight: 700; color: var(--ink-2); }
  .location-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .location-grid .field { margin-bottom: 12px; }
  .location-row .geo-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
  .location-row .geo-status { font-size: 12px; color: var(--ink-3); }
  .location-row .geo-status.error { color: var(--red); }

  /* Settings — staff PINs (BUILD.md §8.13). */
  .staff-pin-reveal { background: rgba(34,197,94,.10); border: 1px solid rgba(34,197,94,.35); border-radius: 12px; padding: 14px 16px; margin-bottom: 18px; }
  .staff-pin-reveal .pin { font-size: 24px; font-weight: 800; letter-spacing: 0.12em; color: var(--ink); font-variant-numeric: tabular-nums; }
  .staff-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--line); }
  .staff-row:last-child { border-bottom: none; }
  .staff-row .name { font-weight: 600; color: var(--ink); }
  .staff-row .badge { font-size: 11px; padding: 3px 10px; border-radius: 100px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
  .staff-row .badge.active { background: rgba(34,197,94,.14); color: var(--green); }
  .staff-row .badge.inactive { background: rgba(148,163,184,.14); color: var(--ink-3); }
  .staff-row .actions { display: flex; gap: 8px; }
  .settings-note { font-size: 13px; color: var(--ink-3); line-height: 1.5; margin: 6px 0 18px; }

  /* Notifications (BUILD.md §8.12). */
  .notif-tabs { display: flex; gap: 8px; margin-bottom: 20px; }
  .notif-tabs a { padding: 8px 16px; border-radius: 100px; font-size: 13px; font-weight: 600; text-decoration: none; color: var(--ink-2); border: 1px solid var(--line); }
  .notif-tabs a.active { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
  .notif-advisory { background: rgba(34,197,94,.10); border: 1px solid rgba(34,197,94,.35); color: var(--ink-2); border-radius: var(--radius-lg); padding: 14px 18px; margin-bottom: 20px; font-size: 13px; line-height: 1.5; }
  .notif-advisory b { color: var(--green); }
  .notif-recipient-count { font-size: 13px; color: var(--ink-3); margin-top: 6px; }
  .notif-counter { font-size: 12px; color: var(--ink-3); text-align: end; margin-top: 4px; }
  .notif-counter.over { color: var(--red); }
  .notif-history { margin-top: 28px; }
  .notif-job { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
  .notif-job:last-child { border-bottom: none; }
  .notif-job .msg { color: var(--ink); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .notif-job .meta { color: var(--ink-3); white-space: nowrap; }
  .notif-job .status-pill { font-size: 11px; padding: 3px 10px; border-radius: 100px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; white-space: nowrap; }
  .notif-job .status-pill.queued { background: rgba(148,163,184,.14); color: var(--ink-3); }
  .notif-job .status-pill.sending { background: rgba(242,140,56,.14); color: var(--accent-light); }
  .notif-job .status-pill.sent { background: rgba(34,197,94,.14); color: var(--green); }
  .automated-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
  .automated-card { background: var(--sunk); border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 18px; }
  .automated-card h3 { margin: 0 0 6px; font-size: 15px; color: var(--ink); display: flex; align-items: center; gap: 8px; }
  .automated-card p { margin: 0; font-size: 13px; color: var(--ink-3); line-height: 1.5; }
  .automated-card .status-pill { font-size: 10px; padding: 3px 9px; border-radius: 100px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
  .automated-card .status-pill.live { background: rgba(34,197,94,.14); color: var(--green); }
  .automated-card .status-pill.pending { background: rgba(148,163,184,.14); color: var(--ink-3); }
</style>
</head>
<body>
${navBar(active, lang)}
<main>
${bodyHtml}
</main>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Sign-up / sign-in / sign-out (BUILD.md §8.1/§8.2 — see BUILD.md §2's
// 2026-08-04 note on why this is self-contained session auth rather than
// Firebase). A minimal, unstyled-by-framework page each, matching §3's dark
// palette and Alexandria via the same layout() shell every merchant page
// uses (undefined `active` — neither is a nav-bar tab).
// ---------------------------------------------------------------------------

/** Login attempts are rate-limited both per email and per IP (BUILD.md job brief) — either alone lets an attacker route around the other (many emails from one IP, or one email from many IPs/a botnet). Separate, generous-for-a-human limits: a real merchant mistyping a password a few times must never be locked out by the same rule that stops a credential-stuffing script. */
const loginLimiterByEmail = new RateLimiter({ limit: 8, windowMs: 15 * 60 * 1000 });
const loginLimiterByIp = new RateLimiter({ limit: 30, windowMs: 15 * 60 * 1000 });

/**
 * POST /signup had no rate limit at all (final whole-branch review):
 * `hashPassword` runs `crypto.scryptSync` — tens of milliseconds locally,
 * measured 100-200ms on the shared-cpu-1x/512MB Fly machine this runs on —
 * which blocks the single-threaded event loop, and every request that
 * passes validation also inserts an unbounded `Merchant` row. A trivial
 * loop from one host can both pin the one always-on machine (there is no
 * second thread and no autoscaling headroom — see docs/DEPLOY.md) and fill
 * the table, taking down enrol, pass issuance and stamping for everyone
 * else along with it. Only IP-keyed (unlike sign-in's email+IP pair):
 * there is no existing account to key a per-email limit against before the
 * account exists, and one always-on machine behind one public form is
 * exactly the shape loginLimiterByIp already exists to defend.
 */
const signupLimiterByIp = new RateLimiter({ limit: 5, windowMs: 15 * 60 * 1000 });

/**
 * A fixed, valid-shaped scrypt hash that no real password will ever match,
 * computed once at module load. handleSignIn() always runs a verifyPassword
 * call against *some* hash — this one when there's no real merchant/password
 * to check against — so that scrypt's cost (tens of milliseconds) is paid on
 * every sign-in attempt equally. Without this, "no such account" returns
 * near-instantly (no hash to check) while "wrong password on a real
 * account" pays the full scrypt cost — a response-time side channel that
 * would let the identical, deliberately generic `signInInvalidCredentials`
 * message (BUILD.md job brief: "the same generic message for wrong password
 * and no such account") still leak which emails are registered, just
 * through timing instead of content.
 */
const DUMMY_PASSWORD_HASH = hashPassword(crypto.randomBytes(24).toString('hex'));

function authPageShell(title: string, bodyHtml: string, lang: Lang): string {
  return layout(title, `<div class="panel" style="max-width:420px;margin:40px auto;">${bodyHtml}</div>`, undefined, lang);
}

/** A safe `next` path to redirect to after sign-in — only ever an in-app, same-origin path (starts with exactly one `/`, never `//…` which browsers treat as protocol-relative), so this can never be turned into an open redirect off a query parameter. */
function safeNextPath(raw: string | null): string {
  if (!raw) return '/app';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/app';
  return raw;
}

function renderSignInForm(opts: { email?: string; next: string; error?: string }, lang: Lang): string {
  const { email = '', next, error } = opts;
  const body = `
    <h1>${escapeHtml(t(lang, 'signInTitle'))}</h1>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <form method="POST" action="/signin">
      <input type="hidden" name="next" value="${escapeHtml(next)}">
      <div class="field">
        <label for="email">${escapeHtml(t(lang, 'signInEmailLabel'))}</label>
        <input type="email" id="email" name="email" required autocomplete="email" inputmode="email" dir="ltr" autocapitalize="none" autocorrect="off" spellcheck="false" value="${escapeHtml(email)}">
      </div>
      <div class="field">
        <label for="password">${escapeHtml(t(lang, 'signInPasswordLabel'))}</label>
        <div class="hex-row">
          <input type="password" id="password" name="password" required autocomplete="current-password" dir="ltr" autocapitalize="none" autocorrect="off" spellcheck="false" style="flex:1;">
          <button type="button" class="btn secondary small" id="toggleSignInPassword">${escapeHtml(t(lang, 'signInShowPassword'))}</button>
        </div>
      </div>
      <button class="btn" type="submit" style="width:100%;">${escapeHtml(t(lang, 'signInSubmitButton'))}</button>
    </form>
    <p class="muted" style="margin-top:16px;">${escapeHtml(t(lang, 'signInNoAccountText'))} <a href="/signup">${escapeHtml(t(lang, 'signInSignUpLink'))}</a></p>
    <script>
      (function () {
        var btn = document.getElementById('toggleSignInPassword');
        var input = document.getElementById('password');
        if (!btn || !input) return;
        btn.addEventListener('click', function () {
          var show = input.type === 'password';
          input.type = show ? 'text' : 'password';
          btn.textContent = show ? ${JSON.stringify(t(lang, 'signInHidePassword'))} : ${JSON.stringify(t(lang, 'signInShowPassword'))};
        });
      })();
    </script>
  `;
  return authPageShell(t(lang, 'signInTitle'), body, lang);
}

function renderSignUpForm(
  opts: { businessName?: string; email?: string; next: string; error?: string },
  lang: Lang
): string {
  const { businessName = '', email = '', next, error } = opts;
  const body = `
    <h1>${escapeHtml(t(lang, 'signUpTitle'))}</h1>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <form method="POST" action="/signup">
      <input type="hidden" name="next" value="${escapeHtml(next)}">
      <div class="field">
        <label for="businessName">${escapeHtml(t(lang, 'signUpBusinessNameLabel'))}</label>
        <input type="text" id="businessName" name="businessName" required maxlength="120" value="${escapeHtml(businessName)}" placeholder="${escapeHtml(t(lang, 'signUpBusinessNamePlaceholder'))}">
      </div>
      <div class="field">
        <label for="email">${escapeHtml(t(lang, 'signUpEmailLabel'))}</label>
        <input type="email" id="email" name="email" required autocomplete="email" inputmode="email" dir="ltr" autocapitalize="none" autocorrect="off" spellcheck="false" value="${escapeHtml(email)}">
      </div>
      <div class="field">
        <label for="password">${escapeHtml(t(lang, 'signUpPasswordLabel'))}</label>
        <input type="password" id="password" name="password" required autocomplete="new-password" dir="ltr" autocapitalize="none" autocorrect="off" spellcheck="false" minlength="${MIN_PASSWORD_LENGTH}">
        <p class="field-hint">${escapeHtml(t(lang, 'signUpPasswordHint'))}</p>
      </div>
      <button class="btn" type="submit" style="width:100%;">${escapeHtml(t(lang, 'signUpSubmitButton'))}</button>
    </form>
    <p class="muted" style="margin-top:16px;">${escapeHtml(t(lang, 'signUpHaveAccountText'))} <a href="/signin">${escapeHtml(t(lang, 'signUpSignInLink'))}</a></p>
  `;
  return authPageShell(t(lang, 'signUpTitle'), body, lang);
}

function handleSignInForm(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  const lang = resolveLang(req);
  sendHtml(res, 200, renderSignInForm({ next: safeNextPath(url.searchParams.get('next')) }, lang));
}

function handleSignUpForm(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  const lang = resolveLang(req);
  sendHtml(res, 200, renderSignUpForm({ next: safeNextPath(url.searchParams.get('next')) }, lang));
}

/**
 * POST /signin — BUILD.md job brief: rate-limited per email and per IP, and
 * "wrong password" / "no such account" return the exact same generic
 * message, so the sign-in form can never be used to enumerate registered
 * emails. A fresh session is always minted here (never reused/extended from
 * an existing one) — that is what "rotation on login" means.
 */
async function handleSignIn(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const lang = resolveLang(req);
  let fields: querystring.ParsedUrlQuery;
  try {
    fields = await readUrlencodedBody(req);
  } catch (err) {
    const status = isHttpError(err) ? err.statusCode : 400;
    const message = err instanceof Error ? err.message : String(err);
    sendHtml(res, status, layout('Error', `<div class="panel"><h1>${status}</h1><p>${escapeHtml(message)}</p></div>`, undefined, lang));
    return;
  }

  const emailRaw = String(fields.email ?? '').trim();
  const password = String(fields.password ?? '');
  const next = safeNextPath(typeof fields.next === 'string' ? fields.next : null);
  const email = normalizeEmail(emailRaw);

  const ip = resolveClientIp(req.headers, req.socket.remoteAddress);
  if (!loginLimiterByEmail.check(email || `empty:${ip}`) || !loginLimiterByIp.check(ip)) {
    sendHtml(res, 429, renderSignInForm({ email: emailRaw, next, error: t(lang, 'signInRateLimited') }, lang));
    return;
  }

  // The same generic message either way — a missing merchant and a wrong
  // password must be indistinguishable to the caller (BUILD.md job brief).
  const invalid = () => sendHtml(res, 401, renderSignInForm({ email: emailRaw, next, error: t(lang, 'signInInvalidCredentials') }, lang));

  if (!email || !password) {
    invalid();
    return;
  }

  const merchant = await prisma.merchant.findUnique({ where: { email } });

  // A merchant row can exist with passwordHash === null — this branch's own
  // migration (packages/db/prisma/migrations/…_add_auth_sessions) added the
  // column nullable, precisely because the pre-auth demo Merchant row
  // already existed with none. That is not "wrong password" or "no such
  // account" — it's a real, known account this deploy simply hasn't been
  // given a password for yet (docs/DEPLOY.md's "First deploy after auth"
  // section is the fix: scripts/create-merchant.ts sets one). Collapsing it
  // into the generic invalid-credentials message would be a *silent*
  // permanent lockout — the owner (or anyone migrating an old row the same
  // way) would see "wrong password" forever with no way to tell that no
  // password was ever set to get wrong. Still pays the same scrypt cost as
  // every other path below (against DUMMY_PASSWORD_HASH) so this more
  // informative message differs only in content, never in timing, from the
  // no-such-account case.
  if (merchant && merchant.passwordHash === null) {
    verifyPassword(password, DUMMY_PASSWORD_HASH);
    sendHtml(res, 401, renderSignInForm({ email: emailRaw, next, error: t(lang, 'signInPasswordNotSet') }, lang));
    return;
  }

  // Always call verifyPassword — against the real hash when there is one,
  // against DUMMY_PASSWORD_HASH otherwise (no such merchant) — so a missing
  // account and a wrong password cost the same scrypt work and are not just
  // message-identical but time-identical (see DUMMY_PASSWORD_HASH's own doc
  // comment).
  const ok = verifyPassword(password, merchant?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!merchant || !ok) {
    invalid();
    return;
  }

  const session = await createSession(merchant.id);
  setSessionCookie(res, session);
  res.writeHead(303, { Location: next });
  res.end();
}

/** POST /signup — creates the Merchant, logs them in (a fresh session, same as sign-in), and lands on the dashboard (or `next`, if it was carrying one — e.g. a bookmarked merchant link that redirected here). */
async function handleSignUp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const lang = resolveLang(req);
  let fields: querystring.ParsedUrlQuery;
  try {
    fields = await readUrlencodedBody(req);
  } catch (err) {
    const status = isHttpError(err) ? err.statusCode : 400;
    const message = err instanceof Error ? err.message : String(err);
    sendHtml(res, status, layout('Error', `<div class="panel"><h1>${status}</h1><p>${escapeHtml(message)}</p></div>`, undefined, lang));
    return;
  }

  const businessName = String(fields.businessName ?? '').trim().slice(0, 120);
  const emailRaw = String(fields.email ?? '').trim();
  const email = normalizeEmail(emailRaw);
  const password = String(fields.password ?? '');
  const next = safeNextPath(typeof fields.next === 'string' ? fields.next : null);

  const fail = (error: string, status = 400) =>
    sendHtml(res, status, renderSignUpForm({ businessName, email: emailRaw, next, error }, lang));

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!businessName) {
    fail(t(lang, 'signUpBusinessNameRequired'));
    return;
  }
  if (!EMAIL_RE.test(email)) {
    fail(t(lang, 'signUpEmailInvalid'));
    return;
  }
  const passwordCheck = validatePassword(password);
  if (!passwordCheck.ok) {
    fail(passwordCheck.reason === 'too_short' ? t(lang, 'signUpPasswordTooShort') : t(lang, 'signUpPasswordTooCommon'));
    return;
  }

  // Checked here — after the cheap, synchronous field checks above (which
  // already cost nothing worth rate-limiting on their own) but *before*
  // the existing-account lookup, the 409 email-taken check, and above all
  // hashPassword below: everything from here on is the expensive/
  // informative part of this request (a DB round-trip, an "email taken or
  // not" answer, and — the main threat — a blocking scrypt hash), and
  // this is the last point before any of it runs. See signupLimiterByIp's
  // own doc comment for why this route needs a limiter at all.
  const ip = resolveClientIp(req.headers, req.socket.remoteAddress);
  if (!signupLimiterByIp.check(ip)) {
    fail(t(lang, 'signUpRateLimited'), 429);
    return;
  }

  // Deliberately kept as a distinct 409 rather than folded into the same
  // generic message sign-in uses (final whole-branch review raised this:
  // without a limiter, this response makes the registered-merchant email
  // list enumerable). Decision: keep it distinct. signupLimiterByIp above
  // now caps this at 5 checks per IP per 15 minutes — the same order of
  // magnitude slower an attacker already accepts against loginLimiterByIp
  // for the identical "which emails exist" question — and a plain, honest
  // "that email is taken" is real UX value for someone who has simply
  // forgotten they already signed up. Sign-in's oracle-proofing exists
  // because that form is hit far more often, by both real users and
  // attackers, all day, every day; sign-up's is a one-time action the rate
  // limit above already makes an unattractive enumeration channel.
  const existing = await prisma.merchant.findUnique({ where: { email } });
  if (existing) {
    fail(t(lang, 'signUpEmailTaken'), 409);
    return;
  }

  const passwordHash = hashPassword(password);
  let merchant: Merchant;
  try {
    merchant = await prisma.merchant.create({ data: { email, name: businessName, passwordHash } });
  } catch (err) {
    // A raced double-submit past the findUnique check above (P2002 on the
    // unique email constraint) — same user-facing message as the check
    // finding it first, not a 500.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      fail(t(lang, 'signUpEmailTaken'), 409);
      return;
    }
    throw err;
  }

  const session = await createSession(merchant.id);
  setSessionCookie(res, session);
  res.writeHead(303, { Location: next });
  res.end();
}

/** POST /signout — deletes the Session row (server-side invalidation — a copied/leaked cookie value stops working immediately, not just once it expires) and clears the cookie. Never errors on a missing/already-invalid session: signing out twice, or with a stale cookie, both just land back on the sign-in page. */
async function handleSignOut(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const sessionId = sessionIdFromRequest(req);
  if (sessionId) await deleteSession(sessionId);
  clearSessionCookie(res);
  res.writeHead(303, { Location: '/signin' });
  res.end();
}

/**
 * The full `/preview.png` query for `card` as it is actually saved — every
 * designer field, so the list thumbnail, the card detail preview and the
 * designer's own initial preview (before any control has been touched) all
 * show the exact same render. `filled` is passed separately because each
 * caller wants a different stamp count (a representative "some progress"
 * thumbnail vs. the merchant's own starterStamps).
 */
function stripPreviewParams(card: Card, filled: number, scale?: 1 | 2 | 3): URLSearchParams {
  const qs = new URLSearchParams({
    goal: String(card.stampsGoal),
    filled: String(filled),
    bg: card.bgColor,
    active: card.stampActive,
    inactive: card.stampInactive,
    shape: card.stampShape,
    opacity: String(card.bgOpacity),
    stampSource: card.stampSource,
  });
  if (scale) qs.set('scale', String(scale));
  if (card.stampSource === 'icon' && card.iconHash) {
    qs.set('icon', card.iconHash);
    qs.set('fit', card.iconFit);
  } else if (card.stampSource === 'builtin') {
    qs.set('builtinIcon', card.builtinIcon);
  }
  if (card.coverHash) qs.set('cover', card.coverHash);
  return qs;
}

// ---------------------------------------------------------------------------
// Route: GET /app — list cards. GET / itself now serves the owner's static
// marketing landing page (apps/demo/public/index.html) — see serveStaticFile.
// ---------------------------------------------------------------------------
function cardThumbSrc(card: Card): string {
  return `/preview.png?${stripPreviewParams(card, defaultFilled(card.stampsGoal)).toString()}`;
}

async function handleCardsList(req: http.IncomingMessage, res: http.ServerResponse, merchant: Merchant): Promise<void> {
  const lang = resolveLang(req);
  const cards = await prisma.card.findMany({ where: { merchantId: merchant.id }, orderBy: { createdAt: 'desc' } });

  const body = cards.length
    ? `<div class="row" style="margin-bottom:18px;">
         <div>
           <h1>${escapeHtml(t(lang, 'cardsListTitle'))}</h1>
           <p class="muted">${escapeHtml(t(lang, cards.length === 1 ? 'cardsListCountOne' : 'cardsListCountMany', { count: arabicDigits(cards.length, lang) }))}</p>
         </div>
         <a class="btn" href="/cards/new">${escapeHtml(t(lang, 'createCardButton'))}</a>
       </div>
       <div class="cards-grid">
         ${cards
           .map(
             (c) => `<a class="card-tile" href="/cards/${c.id}">
               <img src="${cardThumbSrc(c)}" alt="${escapeHtml(c.name)} stamp strip" width="375" height="144">
               <div class="meta">
                 <h3>${escapeHtml(c.name)}</h3>
                 <p>${escapeHtml(c.rewardText)} · ${arabicDigits(c.stampsGoal, lang)} ${escapeHtml(t(lang, 'stampsWord'))}</p>
               </div>
             </a>`
           )
           .join('\n')}
       </div>`
    : `<div class="panel empty">
         <h1>${escapeHtml(t(lang, 'cardsEmptyTitle'))}</h1>
         <p class="muted">${escapeHtml(t(lang, 'cardsEmptyBody'))}</p>
         <p><a class="btn" href="/cards/new">${escapeHtml(t(lang, 'createCardButton'))}</a></p>
       </div>`;

  sendHtml(res, 200, layout(t(lang, 'cardsListTitle'), body, 'cards', lang));
}

// ---------------------------------------------------------------------------
// Route: GET /cards/new — creation form with a live preview
// ---------------------------------------------------------------------------
interface NewCardFormValues {
  name?: string;
  rewardText?: string;
  goal?: number;
  bg?: string;
  active?: string;
  inactive?: string;
}

function renderNewCardForm(
  { name = '', rewardText = '', goal = 8, bg = '#203757', active = '#F96400', inactive = '#8794A5' }: NewCardFormValues = {},
  error?: string,
  lang: Lang = 'en'
): string {
  const goalNum = clampInt(goal, MIN_GOAL, MAX_GOAL, 8);
  const previewQs = new URLSearchParams({
    goal: String(goalNum),
    filled: String(defaultFilled(goalNum)),
    bg,
    active,
    inactive,
  });

  const body = `
    <h1>${escapeHtml(t(lang, 'newCardTitle'))}</h1>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <div class="panel">
      <form method="POST" action="/cards">
        <div class="field">
          <label for="name">${escapeHtml(t(lang, 'newCardNameLabel'))}</label>
          <input type="text" id="name" name="name" required maxlength="80" value="${escapeHtml(name)}" placeholder="${escapeHtml(t(lang, 'newCardNamePlaceholder'))}">
        </div>
        <div class="field">
          <label for="rewardText">${escapeHtml(t(lang, 'newCardRewardLabel'))}</label>
          <input type="text" id="rewardText" name="rewardText" required maxlength="120" value="${escapeHtml(rewardText)}" placeholder="${escapeHtml(t(lang, 'newCardRewardPlaceholder'))}">
        </div>
        <div class="field">
          <label for="goal">${escapeHtml(t(lang, 'newCardGoalLabel'))} <span id="goalVal">${goalNum}</span></label>
          <input type="range" id="goal" name="goal" min="${MIN_GOAL}" max="${MAX_GOAL}" value="${goalNum}">
        </div>
        <div class="field colors">
          <div class="field">
            <label for="bg">${escapeHtml(t(lang, 'newCardBgLabel'))}</label>
            <input type="color" id="bg" name="bg" value="${escapeHtml(bg)}">
          </div>
          <div class="field">
            <label for="active">${escapeHtml(t(lang, 'newCardActiveLabel'))}</label>
            <input type="color" id="active" name="active" value="${escapeHtml(active)}">
          </div>
          <div class="field">
            <label for="inactive">${escapeHtml(t(lang, 'newCardInactiveLabel'))}</label>
            <input type="color" id="inactive" name="inactive" value="${escapeHtml(inactive)}">
          </div>
        </div>
        <div class="field preview-panel">
          <img id="preview" src="/preview.png?${previewQs.toString()}" alt="Live stamp strip preview" width="375" height="144">
        </div>
        <button class="btn" type="submit">${escapeHtml(t(lang, 'createCardButton'))}</button>
        <a class="btn secondary" href="/app">${escapeHtml(t(lang, 'cancelButton'))}</a>
      </form>
    </div>
    <script>
      (function () {
        var goalInput = document.getElementById('goal');
        var goalVal = document.getElementById('goalVal');
        var bgInput = document.getElementById('bg');
        var activeInput = document.getElementById('active');
        var inactiveInput = document.getElementById('inactive');
        var preview = document.getElementById('preview');

        function refresh() {
          var goal = parseInt(goalInput.value, 10);
          goalVal.textContent = goal;
          var filled = Math.max(1, Math.floor(goal / 3));
          var qs = new URLSearchParams({
            goal: String(goal),
            filled: String(filled),
            bg: bgInput.value,
            active: activeInput.value,
            inactive: inactiveInput.value
          });
          // Point the <img> at the render endpoint — the preview is the same
          // renderer used everywhere else, never a re-implementation here.
          preview.src = '/preview.png?' + qs.toString();
        }

        goalInput.addEventListener('input', refresh);
        bgInput.addEventListener('input', refresh);
        activeInput.addEventListener('input', refresh);
        inactiveInput.addEventListener('input', refresh);
      })();
    </script>
  `;
  return layout(t(lang, 'newCardTitle'), body, 'cards', lang);
}

async function handleNewCardForm(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  sendHtml(res, 200, renderNewCardForm({}, undefined, resolveLang(req)));
}

// ---------------------------------------------------------------------------
// Route: POST /cards — validate, persist, redirect
// ---------------------------------------------------------------------------
async function handleCreateCard(req: http.IncomingMessage, res: http.ServerResponse, merchant: Merchant): Promise<void> {
  const lang = resolveLang(req);
  let fields: querystring.ParsedUrlQuery;
  try {
    fields = await readUrlencodedBody(req);
  } catch (err) {
    const status = isHttpError(err) ? err.statusCode : 400;
    const message = err instanceof Error ? err.message : String(err);
    sendHtml(res, status, layout('Error', `<div class="panel"><h1>${status}</h1><p>${escapeHtml(message)}</p></div>`, 'cards', lang));
    return;
  }

  const name = String(fields.name ?? '').trim();
  const rewardText = String(fields.rewardText ?? '').trim();
  const goalRaw = fields.goal;
  const bg = String(fields.bg ?? '').trim();
  const active = String(fields.active ?? '').trim();
  const inactive = String(fields.inactive ?? '').trim();

  const errors: string[] = [];
  if (!name) errors.push(t(lang, 'newCardNameRequired'));
  if (name.length > 80) errors.push(t(lang, 'newCardNameTooLong'));
  if (!rewardText) errors.push(t(lang, 'newCardRewardRequired'));
  if (rewardText.length > 120) errors.push(t(lang, 'newCardRewardTooLong'));

  const goalNum = Number.parseInt(String(goalRaw), 10);
  if (!Number.isInteger(goalNum) || goalNum < MIN_GOAL || goalNum > MAX_GOAL) {
    errors.push(t(lang, 'newCardGoalRange', { min: arabicDigits(MIN_GOAL, lang), max: arabicDigits(MAX_GOAL, lang) }));
  }
  if (!HEX_RE.test(bg)) errors.push(t(lang, 'newCardBgInvalid'));
  if (!HEX_RE.test(active)) errors.push(t(lang, 'newCardActiveInvalid'));
  if (!HEX_RE.test(inactive)) errors.push(t(lang, 'newCardInactiveInvalid'));

  if (errors.length) {
    sendHtml(
      res,
      400,
      renderNewCardForm(
        { name, rewardText, goal: Number.isFinite(goalNum) ? goalNum : 8, bg: bg || '#203757', active: active || '#F96400', inactive: inactive || '#8794A5' },
        errors.join(' '),
        lang
      )
    );
    return;
  }

  const bgColor = bg.startsWith('#') ? bg : `#${bg}`;
  const stampActive = active.startsWith('#') ? active : `#${active}`;
  const stampInactive = inactive.startsWith('#') ? inactive : `#${inactive}`;

  const maxSlot = await prisma.card.aggregate({
    where: { merchantId: merchant.id },
    _max: { slot: true },
  });
  const slot = (maxSlot._max.slot ?? 0) + 1;

  const linkCode = await nextLinkCode();

  let card: Card | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    const shortCode = generateShortCode();
    try {
      card = await prisma.card.create({
        data: {
          merchantId: merchant.id,
          slot,
          linkCode,
          shortCode,
          name,
          stampsGoal: goalNum,
          bgColor,
          fgColor: '#FFFFFF',
          stampActive,
          stampInactive,
          rewardText,
        },
      });
      break;
    } catch (err) {
      // P2002: unique constraint failed — retry with a fresh shortCode.
      // linkCode came from the atomic counter and cannot collide.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && attempt < 4) continue;
      throw err;
    }
  }

  if (!card) {
    // Unreachable in practice: the loop above always either assigns `card`
    // and breaks, or rethrows on its final iteration. Narrow guard so the
    // definite-assignment error below is a real check, not an assertion.
    throw new Error('card creation loop exited without creating a card or throwing');
  }

  // Straight into the designer (BUILD.md §8.5), not the bare detail page —
  // this quick-create form only collects the economics; logo, cover,
  // shape and colours are the edit page's job, and a merchant should land
  // there immediately rather than having to find "Edit" first.
  res.writeHead(303, { Location: `/cards/${card.id}/edit` });
  res.end();
}

// ---------------------------------------------------------------------------
// Route: GET /cards/:id — card detail with enrol URL + QR
// ---------------------------------------------------------------------------
/** The fixed, human list shown in both the activation modal and the edit banner — BUILD.md §8.7's own order: "stamps required, starter stamps, how stamps are earned, reward details, expiry type." `lockFieldHowEarned` has no database column of its own (see cardEdit.ts's ECONOMIC_FIELDS comment), so it is listed here alongside the fields that are actually enforced rather than derived from them. */
function lockedFieldChips(lang: Lang): string {
  const labels = [
    t(lang, 'lockFieldStampsGoal'),
    t(lang, 'lockFieldStarterStamps'),
    t(lang, 'lockFieldHowEarned'),
    t(lang, 'lockFieldRewardText'),
    t(lang, 'lockFieldExpiryType'),
  ];
  return labels.map((label) => `<span class="chip locked">${escapeHtml(label)}</span>`).join(' ');
}

async function handleCardDetail(req: http.IncomingMessage, res: http.ServerResponse, id: string, merchant: Merchant): Promise<void> {
  const lang = resolveLang(req);
  const card = await findOwnedCard(id, merchant.id);
  if (!card) {
    sendNotFound(res, `No card with id "${id}".`);
    return;
  }

  const [passCount, sums] = await Promise.all([
    passCountForCard(card.id),
    prisma.pass.aggregate({ where: { cardId: card.id }, _sum: { totalStamps: true, rewards: true } }),
  ]);
  const totalStamps = sums._sum.totalStamps ?? 0;
  const totalRewards = sums._sum.rewards ?? 0;

  const enrolUrl = `${PUBLIC_URL}/${card.linkCode}`;
  const stripQs = stripPreviewParams(card, defaultFilled(card.stampsGoal), 2);
  const qrQs = new URLSearchParams({ data: enrolUrl });

  const lockBanner =
    passCount > 0
      ? `<div class="banner">
          <b>${escapeHtml(t(lang, 'lockBannerTitle'))}</b> — ${escapeHtml(t(lang, 'lockBannerReason'))}<br>
          <span>${escapeHtml(t(lang, 'lockCustomersRegistered', { count: arabicDigits(passCount, lang) }))}</span>
        </div>`
      : '';

  const statusPill = card.active
    ? `<span class="chip active">${escapeHtml(t(lang, 'cardStatusActive'))}</span>`
    : `<span class="chip">${escapeHtml(t(lang, 'cardStatusDraft'))}</span>`;
  const activateCta = !card.active
    ? `<a class="btn" href="/cards/${card.id}/activate">${escapeHtml(t(lang, 'activateTitle'))}</a>`
    : '';

  const body = `
    <div class="row" style="margin-bottom:18px;">
      <div>
        <h1>${escapeHtml(card.name)} ${statusPill}</h1>
      </div>
      <div>
        ${activateCta}
        <a class="btn secondary" href="/cards/${card.id}/edit">${escapeHtml(t(lang, 'editTitle'))}</a>
        <a class="btn secondary" href="/cards/${card.id}/print">${escapeHtml(t(lang, 'activatePrintSheetLink'))}</a>
        <a class="btn secondary" href="/app">${escapeHtml(t(lang, 'cardDetailAllCardsLink'))}</a>
      </div>
    </div>
    ${lockBanner}
    <div class="kpis">
      <div class="kpi"><div class="n">${arabicDigits(passCount, lang)}</div><div class="label">${escapeHtml(t(lang, 'reportsKpiCustomers'))}</div></div>
      <div class="kpi"><div class="n">${arabicDigits(totalStamps, lang)}</div><div class="label">${escapeHtml(t(lang, 'cardDetailKpiStamps'))}</div></div>
      <div class="kpi"><div class="n">${arabicDigits(totalRewards, lang)}</div><div class="label">${escapeHtml(t(lang, 'customersColRewards'))}</div></div>
    </div>
    <div class="panel">
      <div class="preview-panel" style="margin-bottom:20px;">
        <img src="/preview.png?${stripQs.toString()}" alt="${escapeHtml(card.name)} stamp strip" width="375" height="144" style="max-width:375px;">
      </div>
      <dl class="kv">
        <dt>${escapeHtml(t(lang, 'cardDetailRewardLabel'))}</dt><dd>${escapeHtml(card.rewardText)}</dd>
        <dt>${escapeHtml(t(lang, 'cardDetailGoalLabel'))}</dt><dd>${arabicDigits(card.stampsGoal, lang)}</dd>
        <dt>${escapeHtml(t(lang, 'cardDetailShortCodeLabel'))}</dt><dd><code class="pill">${escapeHtml(card.shortCode)}</code></dd>
        <dt>${escapeHtml(t(lang, 'cardDetailEnrolUrlLabel'))}</dt><dd><code class="pill">${escapeHtml(enrolUrl)}</code></dd>
      </dl>
    </div>
    <div class="panel">
      <h2>${escapeHtml(t(lang, 'cardDetailScanHeading'))}</h2>
      <div class="qr-wrap">
        <img src="/qr.png?${qrQs.toString()}" alt="QR code for ${escapeHtml(enrolUrl)}">
      </div>
      <p class="muted" style="margin-top:14px;">${
        PUBLIC_BASE_URL
          ? escapeHtml(t(lang, 'cardDetailQrPublicNote', { url: PUBLIC_URL }))
          : escapeHtml(t(lang, 'cardDetailQrLanNote', { url: PUBLIC_URL }))
      }</p>
    </div>
  `;
  sendHtml(res, 200, layout(card.name, body, 'cards', lang));
}

// ---------------------------------------------------------------------------
// Route: GET /cards/:id/print — BUILD.md §8.8's print sheet. A print-ready
// A4 poster: reward as the headline, the join QR at least 40mm square when
// printed, the short code beneath it, four numbered "how it works" steps.
// The on-screen chrome (nav, back link) stays in the dashboard's dark
// theme; the printable sheet itself switches to dark-ink-on-white paper
// under @media print — printing the dark UI verbatim would waste a
// cartridge of ink on a background nobody wants on a counter poster.
// ---------------------------------------------------------------------------
async function handleCardPrint(req: http.IncomingMessage, res: http.ServerResponse, id: string, merchant: Merchant): Promise<void> {
  const lang = resolveLang(req);
  const card = await findOwnedCard(id, merchant.id);
  if (!card) {
    sendNotFound(res, `No card with id "${id}".`);
    return;
  }

  const enrolUrl = `${PUBLIC_URL}/${card.linkCode}`;
  // moduleSize 10 (vs. the site-wide default of 6) — a print sheet is
  // rendered once and viewed at a much larger physical size than a screen
  // preview; a bigger module keeps the code crisp once CSS stretches it to
  // the 45mm print size below.
  const qrQs = new URLSearchParams({ data: enrolUrl, size: '10' });

  const steps = [
    t(lang, 'printStep1'),
    t(lang, 'printStep2'),
    t(lang, 'printStep3'),
    t(lang, 'printStep4', { goal: arabicDigits(card.stampsGoal, lang) }),
  ];

  const html = `<!doctype html>
<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(card.name)} · ${escapeHtml(t(lang, 'printButton'))} · LoyaNexa</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Alexandria:wght@400;600;700;800&display=swap">
<style>
  :root { --canvas: #0F172A; --paper: #1C2A42; --sunk: #162338; --accent: #F28C38; --ink: #FFFFFF; --ink-2: #CBD5E1; --line: rgba(255,255,255,.12); }
  html[lang="ar"] * { letter-spacing: 0 !important; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--canvas); color: var(--ink); font-family: 'Alexandria', system-ui, sans-serif; }
  .toolbar { display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; border-bottom: 1px solid var(--line); background: var(--sunk); }
  .toolbar a { color: var(--ink-2); text-decoration: none; font-weight: 600; font-size: 14px; }
  .toolbar button {
    background: var(--accent); color: #0F172A; border: none; border-radius: 100px; padding: 10px 20px;
    font-weight: 700; font-size: 14px; cursor: pointer; font-family: inherit;
  }
  .sheet-wrap { display: flex; justify-content: center; padding: 32px 16px 56px; }
  /* On screen: an A4-proportioned dark-on-white card so the merchant can preview it before printing. */
  .sheet {
    width: 210mm; max-width: 100%; min-height: 297mm; background: #fff; color: #111827;
    border-radius: 8px; padding: 24mm 18mm; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,.4);
    display: flex; flex-direction: column; align-items: center;
  }
  .sheet .card-name { font-size: 16px; font-weight: 700; color: #6B7280; letter-spacing: .04em; text-transform: uppercase; margin-bottom: 10px; }
  .sheet h1 { font-size: 38px; line-height: 1.2; margin: 0 0 28px; color: #111827; max-width: 90%; }
  .sheet .qr-box { padding: 16px; border: 2px solid #111827; border-radius: 16px; display: inline-block; }
  .sheet .qr-box img { display: block; width: 45mm; height: 45mm; image-rendering: pixelated; }
  .sheet .short-code { margin-top: 14px; font-size: 15px; letter-spacing: .08em; color: #374151; }
  .sheet .short-code code { font-weight: 700; color: #111827; }
  .sheet .scan-label { margin-top: 22px; font-size: 15px; color: #4B5563; }
  .sheet .steps { margin-top: 40px; width: 100%; max-width: 480px; text-align: start; display: flex; flex-direction: column; gap: 16px; }
  .sheet .step { display: flex; gap: 14px; align-items: flex-start; }
  .sheet .step .num {
    flex: none; width: 28px; height: 28px; border-radius: 50%; background: #111827; color: #fff;
    display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700;
  }
  .sheet .step p { margin: 0; font-size: 15px; line-height: 1.4; color: #1F2937; padding-top: 3px; }
  .sheet .powered { margin-top: auto; padding-top: 40px; font-size: 12px; color: #9CA3AF; }
  @media print {
    @page { size: A4; margin: 0; }
    .toolbar { display: none; }
    .sheet-wrap { padding: 0; }
    body { background: #fff; }
    .sheet { box-shadow: none; border-radius: 0; width: 210mm; height: 297mm; page-break-after: avoid; }
  }
</style>
</head>
<body>
<div class="toolbar">
  <a href="/cards/${card.id}">&larr; ${escapeHtml(t(lang, 'printBackToCard'))}</a>
  <button type="button" onclick="window.print()">${escapeHtml(t(lang, 'printButton'))}</button>
</div>
<div class="sheet-wrap">
  <div class="sheet">
    <div class="card-name">${escapeHtml(card.name)}</div>
    <h1>${escapeHtml(card.rewardText)}</h1>
    <div class="qr-box">
      <img src="/qr.png?${qrQs.toString()}" alt="QR code for ${escapeHtml(enrolUrl)}" width="450" height="450">
    </div>
    <div class="short-code">${escapeHtml(t(lang, 'printShortCodeLabel'))}: <code>${escapeHtml(card.shortCode)}</code></div>
    <div class="scan-label">${escapeHtml(t(lang, 'printScanToJoin'))}</div>
    <div class="steps">
      ${steps
        .map((step, i) => `<div class="step"><span class="num">${i + 1}</span><p>${escapeHtml(step)}</p></div>`)
        .join('\n      ')}
    </div>
    <div class="powered">Powered by LoyaNexa</div>
  </div>
</div>
</body>
</html>`;
  sendHtml(res, 200, html);
}

// ---------------------------------------------------------------------------
// Card activation and the lock rule — BUILD.md §8.7. GET renders the
// confirmation step listing exactly what is about to freeze; POST performs
// it. Once activated (and, independently, once any Pass exists) the write
// path below (handleUpdateCard / cardEdit.ts's updateCard) is what actually
// enforces the freeze — this confirmation step is a courtesy, not the
// enforcement (BUILD.md §8.7: "enforce server-side, not just in the UI").
// ---------------------------------------------------------------------------
async function handleActivateConfirm(req: http.IncomingMessage, res: http.ServerResponse, id: string, merchant: Merchant): Promise<void> {
  const lang = resolveLang(req);
  const card = await findOwnedCard(id, merchant.id);
  if (!card) {
    sendNotFound(res, `No card with id "${id}".`);
    return;
  }

  if (card.active) {
    const body = `<div class="panel"><p>${escapeHtml(t(lang, 'activateAlreadyActive'))}</p><p><a class="btn" href="/cards/${card.id}">Back to card</a></p></div>`;
    sendHtml(res, 200, layout(card.name, body, 'cards', lang));
    return;
  }

  const body = `
    <h1>${escapeHtml(t(lang, 'activateTitle'))}</h1>
    <div class="panel">
      <p><b>${escapeHtml(t(lang, 'activateWarning'))}</b></p>
      <p class="chips">${lockedFieldChips(lang)}</p>
      <p class="muted">${escapeHtml(t(lang, 'activateReason'))}</p>
      <p style="color:var(--green);">${escapeHtml(t(lang, 'activateAestheticNote'))}</p>
      <form method="POST" action="/cards/${card.id}/activate">
        <button class="btn" type="submit">${escapeHtml(t(lang, 'activateConfirmButton'))}</button>
        <a class="btn secondary" href="/cards/${card.id}">${escapeHtml(t(lang, 'activateCancelButton'))}</a>
      </form>
    </div>
  `;
  sendHtml(res, 200, layout(t(lang, 'activateTitle'), body, 'cards', lang));
}

async function handleActivateCard(req: http.IncomingMessage, res: http.ServerResponse, id: string, merchant: Merchant): Promise<void> {
  const lang = resolveLang(req);
  const result = await activateCard(id, merchant.id);
  if (!result.ok) {
    sendNotFound(res, `No card with id "${id}".`);
    return;
  }

  const card = result.card;
  const enrolUrl = `${PUBLIC_URL}/${card.linkCode}`;
  const body = `
    <div class="panel empty">
      <h1>${escapeHtml(t(lang, 'activateSuccessTitle'))}</h1>
      <p class="muted"><code class="pill">${escapeHtml(enrolUrl)}</code></p>
      <p>
        <a class="btn" href="/cards/${card.id}/print">${escapeHtml(t(lang, 'activatePrintSheetLink'))}</a>
        <a class="btn secondary" href="/app">${escapeHtml(t(lang, 'activateGoToCards'))}</a>
      </p>
    </div>
  `;
  sendHtml(res, 200, layout(card.name, body, 'cards', lang));
}

// ---------------------------------------------------------------------------
// Route: GET/POST /cards/:id/edit — the card designer (BUILD.md §8.5 /
// §8.9): a two-pane layout, controls on the left and a live preview on the
// right that re-renders by pointing its <img> at GET /preview.png, never by
// reimplementing the renderer in the browser. Renders economic fields as
// disabled inputs once any Pass exists (so a browser never even submits a
// locked value), plus the amber banner — images, colours, shape and labels
// stay enabled regardless (BUILD.md §8.7's green line: these are cosmetic
// and never lock). The POST handler is a thin HTTP wrapper around
// cardEdit.ts's updateCard() — the same function apps/demo/test/cardEdit.test.ts
// exercises directly — so the enforcement a merchant hits through this form
// and the enforcement the test proves are the exact same code path.
// ---------------------------------------------------------------------------
/** The i18n key naming each built-in icon (BUILTIN_ICON_IDS order) — the designer's picker uses these as each swatch's accessible label. */
const ICON_LABEL_KEYS: Record<BuiltinIconId, 'iconLabelCoffee' | 'iconLabelCroissant' | 'iconLabelScissors' | 'iconLabelFlower' | 'iconLabelCar' | 'iconLabelDumbbell' | 'iconLabelStar' | 'iconLabelHeart' | 'iconLabelCheck' | 'iconLabelGift'> = {
  coffee: 'iconLabelCoffee',
  croissant: 'iconLabelCroissant',
  scissors: 'iconLabelScissors',
  flower: 'iconLabelFlower',
  car: 'iconLabelCar',
  dumbbell: 'iconLabelDumbbell',
  star: 'iconLabelStar',
  heart: 'iconLabelHeart',
  check: 'iconLabelCheck',
  gift: 'iconLabelGift',
};

/** Neutral colour the icon picker's own swatches render in — deliberately not the card's live active-stamp colour, so the picker never needs to reload all ten swatches every time a merchant nudges a colour slider. The strip *preview* (designerPreviewQs below) always uses the real active colour. */
const ICON_SWATCH_COLOR = '#33415C';

interface EditCardFormValues {
  name: string;
  rewardText: string;
  stampsGoal: number;
  starterStamps: number;
  bgColor: string;
  bgOpacity: number;
  stampActive: string;
  stampInactive: string;
  stampShape: string;
  stampSource: StampSource;
  builtinIcon: BuiltinIconId;
  labelStamps: string;
  labelRewards: string;
  logoHash: string;
  iconHash: string;
  iconFit: string;
  coverHash: string;
}

/** The `/preview.png` query for the designer's *current form values* — distinct from stripPreviewParams() above, which reads a persisted Card row; this reads whatever is in the form right now, including an edit not yet saved. */
function designerPreviewQs(values: EditCardFormValues, filled: number): URLSearchParams {
  const qs = new URLSearchParams({
    goal: String(values.stampsGoal),
    filled: String(filled),
    bg: values.bgColor,
    active: values.stampActive,
    inactive: values.stampInactive,
    shape: values.stampShape,
    opacity: String(values.bgOpacity),
    stampSource: values.stampSource,
    scale: '2',
  });
  if (values.stampSource === 'icon' && values.iconHash) {
    qs.set('icon', values.iconHash);
    qs.set('fit', values.iconFit);
  } else if (values.stampSource === 'builtin') {
    qs.set('builtinIcon', values.builtinIcon);
  }
  if (values.coverHash) qs.set('cover', values.coverHash);
  return qs;
}

/** A saved CardLocation as the all-strings shape the edit form's inputs need — the inverse of parseLocationsFromFields below. Used both for the initial GET render (from Card.locations) and is mirrored by the raw rows a rejected POST redisplays. */
function locationToRawRow(loc: { name: string; latitude: number; longitude: number; relevantText?: string }): RawLocationRow {
  return { name: loc.name, latitude: String(loc.latitude), longitude: String(loc.longitude), relevantText: loc.relevantText ?? '' };
}

/**
 * Groups `locations[i][name|lat|lng|relevantText]` fields (renderLocationRow's
 * own field-name pattern) back into an ordered list of raw rows. node's
 * built-in `querystring.parse` (readUrlencodedBody's own parser) does not
 * do bracket/array parsing itself — it returns these as literal flat keys —
 * so this does the grouping by hand. Index gaps (a row removed client-side
 * before submit) are fine: rows are sorted by their numeric index and
 * returned in that order, never assumed contiguous.
 */
function parseLocationsFromFields(fields: querystring.ParsedUrlQuery): RawLocationRow[] {
  const byIndex = new Map<number, { name: string; lat: string; lng: string; relevantText: string }>();
  for (const key of Object.keys(fields)) {
    const m = key.match(/^locations\[(\d+)\]\[(name|lat|lng|relevantText)\]$/);
    if (!m) continue;
    const idx = Number.parseInt(m[1]!, 10);
    const field = m[2] as 'name' | 'lat' | 'lng' | 'relevantText';
    const raw = fields[key];
    const value = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
    const entry = byIndex.get(idx) ?? { name: '', lat: '', lng: '', relevantText: '' };
    entry[field] = value;
    byIndex.set(idx, entry);
  }
  return [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({ name: v.name, latitude: v.lat, longitude: v.lng, relevantText: v.relevantText }));
}

/** One `<fieldset>`-style row for a saved (or just-submitted, on a validation error) location — shared by the server-rendered initial rows and the client-side "Add location" template (both must stay in sync: `wireLocationRows` below re-derives the field-name pattern `locations[i][...]` this produces). `index` need not be contiguous — server.ts's own parseLocationsFromFields groups by whatever index each field name carries, gaps and all. */
function renderLocationRow(index: number, row: RawLocationRow, lang: Lang): string {
  return `<div class="location-row" data-location-row data-index="${index}">
            <div class="row-head">
              <span class="row-title">${escapeHtml(t(lang, 'designerLocationsRowTitle', { n: arabicDigits(index + 1, lang) }))}</span>
              <button type="button" class="btn remove small" data-remove-location>${escapeHtml(t(lang, 'designerLocationsRemoveButton'))}</button>
            </div>
            <div class="field">
              <label>${escapeHtml(t(lang, 'designerLocationsNameLabel'))}</label>
              <input type="text" name="locations[${index}][name]" maxlength="80" value="${escapeHtml(row.name)}" placeholder="${escapeHtml(t(lang, 'designerLocationsNamePlaceholder'))}">
            </div>
            <div class="geo-row">
              <button type="button" class="btn secondary small" data-use-current-location>${escapeHtml(t(lang, 'designerLocationsUseCurrentButton'))}</button>
              <span class="geo-status" data-geo-status></span>
            </div>
            <div class="location-grid">
              <div class="field">
                <label>${escapeHtml(t(lang, 'designerLocationsLatLabel'))}</label>
                <input type="text" inputmode="decimal" name="locations[${index}][lat]" data-lat value="${escapeHtml(row.latitude)}" placeholder="24.7136">
              </div>
              <div class="field">
                <label>${escapeHtml(t(lang, 'designerLocationsLngLabel'))}</label>
                <input type="text" inputmode="decimal" name="locations[${index}][lng]" data-lng value="${escapeHtml(row.longitude)}" placeholder="46.6753">
              </div>
            </div>
            <div class="field" style="margin-bottom:0;">
              <label>${escapeHtml(t(lang, 'designerLocationsRelevantTextLabel'))}</label>
              <input type="text" name="locations[${index}][relevantText]" maxlength="160" value="${escapeHtml(row.relevantText)}" placeholder="${escapeHtml(t(lang, 'designerLocationsRelevantTextPlaceholder'))}">
            </div>
          </div>`;
}

function renderEditCardForm(
  card: Card,
  passCount: number,
  lang: Lang,
  values: EditCardFormValues,
  wideIcon: boolean,
  locationRows: RawLocationRow[],
  error?: string
): string {
  const locked = passCount > 0;
  const lockBanner = locked
    ? `<div class="banner">
        <b>${escapeHtml(t(lang, 'lockBannerTitle'))}</b><br>
        ${escapeHtml(t(lang, 'lockBannerReason'))}<br>
        <p class="chips" style="margin-top:8px;">${lockedFieldChips(lang)}</p>
        <p style="margin-top:8px;">${escapeHtml(t(lang, 'lockCustomersRegistered', { count: arabicDigits(passCount, lang) }))}</p>
      </div>`
    : '';
  const dis = locked ? 'disabled' : '';
  const lockedClass = locked ? ' class="lock"' : '';
  const filled = defaultFilled(values.stampsGoal);
  const previewSrc = `/preview.png?${designerPreviewQs(values, filled).toString()}`;
  const hasLogo = values.logoHash.length > 0;
  const hasIcon = values.iconHash.length > 0;
  const hasCover = values.coverHash.length > 0;
  const opacityPct = Math.round(values.bgOpacity * 100);
  const showNonSquareIconHint = hasIcon && values.stampSource === 'icon' && wideIcon;
  // BUILD.md §8.7's green line covers every input here (colours, opacity) —
  // this warning is informational only, never a validation error; see
  // packages/image/src/contrast.ts's own doc comment for why the
  // background side of the ratio is a heuristic once a cover photo exists.
  const effectiveBg = effectiveBackgroundHex(values.bgColor, values.bgOpacity);
  const lowContrast =
    contrastRatio(values.stampActive, effectiveBg) < 3 || contrastRatio(values.stampInactive, effectiveBg) < 3;

  const body = `
    <h1>${escapeHtml(t(lang, 'editTitle'))} — ${escapeHtml(card.name)}</h1>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    ${lockBanner}
    <div class="designer">
      <div class="designer-controls panel">
        <form method="POST" action="/cards/${card.id}/edit" id="designerForm">
          <h2>${escapeHtml(t(lang, 'designerDesignHeading'))}</h2>
          <div class="field">
            <label for="name">${escapeHtml(t(lang, 'newCardNameLabel'))}</label>
            <input type="text" id="name" name="name" required maxlength="80" value="${escapeHtml(values.name)}">
          </div>

          <div class="field">
            <label>${escapeHtml(t(lang, 'designerLogoHeading'))}</label>
            <div class="upload-row">
              <img id="logoThumb" class="upload-thumb${hasLogo ? ' shown' : ''}" src="${hasLogo ? escapeHtml(imageUrl(values.logoHash)) : ''}" alt="">
              <div class="upload-actions">
                <label class="btn secondary small" for="logoFile">${escapeHtml(t(lang, 'designerLogoUploadButton'))}</label>
                <input type="file" id="logoFile" accept="image/png,image/jpeg">
                <button type="button" class="btn remove small" id="logoRemoveBtn" ${hasLogo ? '' : 'disabled'}>${escapeHtml(t(lang, 'designerRemoveButton'))}</button>
              </div>
            </div>
            <p class="field-hint">${escapeHtml(t(lang, 'designerLogoHint'))}</p>
            <p class="upload-error" id="logoError" hidden></p>
            <input type="hidden" name="logoHash" id="logoHash" value="${escapeHtml(values.logoHash)}">
          </div>

          <div class="field">
            <label>${escapeHtml(t(lang, 'designerStampSourceHeading'))}</label>
            <div class="shape-toggle">
              <label><input type="radio" name="stampSource" value="builtin" ${values.stampSource === 'builtin' ? 'checked' : ''}> ${escapeHtml(t(lang, 'designerStampSourceBuiltin'))}</label>
              <label><input type="radio" name="stampSource" value="icon" ${values.stampSource === 'icon' ? 'checked' : ''}> ${escapeHtml(t(lang, 'designerStampSourceIcon'))}</label>
              <label><input type="radio" name="stampSource" value="plain" ${values.stampSource === 'plain' ? 'checked' : ''}> ${escapeHtml(t(lang, 'designerStampSourcePlain'))}</label>
            </div>
          </div>

          <div class="field" id="builtinIconField" ${values.stampSource === 'builtin' ? '' : 'hidden'}>
            <p class="field-hint">${escapeHtml(t(lang, 'designerIconPickerHint'))}</p>
            <div class="icon-grid" id="iconGrid">
              ${BUILTIN_ICON_IDS.map(
                (id: BuiltinIconId) => `<label class="icon-swatch${values.builtinIcon === id ? ' selected' : ''}" data-icon-swatch="${id}">
                <input type="radio" name="builtinIcon" value="${id}" ${values.builtinIcon === id ? 'checked' : ''}>
                <img src="/icon-swatch.png?id=${id}&color=${encodeURIComponent(ICON_SWATCH_COLOR)}&size=56" width="28" height="28" alt="${escapeHtml(t(lang, ICON_LABEL_KEYS[id]))}">
              </label>`
              ).join('')}
            </div>
          </div>

          <div class="field" id="ownIconField" ${values.stampSource === 'icon' ? '' : 'hidden'}>
            <label>${escapeHtml(t(lang, 'designerStampSourceIcon'))}</label>
            <div class="upload-row">
              <img id="iconThumb" class="upload-thumb${hasIcon ? ' shown' : ''}" src="${hasIcon ? escapeHtml(imageUrl(values.iconHash)) : ''}" alt="">
              <div class="upload-actions">
                <label class="btn secondary small" for="iconFile">${escapeHtml(t(lang, 'designerIconUploadButton'))}</label>
                <input type="file" id="iconFile" accept="image/png,image/jpeg">
                <button type="button" class="btn remove small" id="iconRemoveBtn" ${hasIcon ? '' : 'disabled'}>${escapeHtml(t(lang, 'designerRemoveButton'))}</button>
              </div>
            </div>
            <p class="field-hint">${escapeHtml(t(lang, 'designerIconHint'))}</p>
            <p class="upload-error" id="iconError" hidden></p>
            <input type="hidden" name="iconHash" id="iconHash" value="${escapeHtml(values.iconHash)}" data-wide="${hasIcon && wideIcon ? '1' : ''}">
            <div class="shape-toggle" style="margin-top:10px;">
              <label><input type="radio" name="iconFit" value="contain" ${values.iconFit === 'cover' ? '' : 'checked'} ${hasIcon ? '' : 'disabled'}> ${escapeHtml(t(lang, 'designerIconFitContain'))}</label>
              <label><input type="radio" name="iconFit" value="cover" ${values.iconFit === 'cover' ? 'checked' : ''} ${hasIcon ? '' : 'disabled'}> ${escapeHtml(t(lang, 'designerIconFitFill'))}</label>
            </div>
            <p class="field-hint">${escapeHtml(t(lang, 'designerIconFitHint'))}</p>
            <p class="field-hint amber" id="nonSquareIconHint" ${showNonSquareIconHint ? '' : 'hidden'}>${escapeHtml(t(lang, 'designerNonSquareIconHint'))}</p>
          </div>

          <div class="field">
            <label>${escapeHtml(t(lang, 'designerCoverHeading'))}</label>
            <div class="upload-row">
              <img id="coverThumb" class="upload-thumb cover-thumb${hasCover ? ' shown' : ''}" src="${hasCover ? escapeHtml(imageUrl(values.coverHash)) : ''}" alt="">
              <div class="upload-actions">
                <label class="btn secondary small" for="coverFile">${escapeHtml(t(lang, 'designerCoverUploadButton'))}</label>
                <input type="file" id="coverFile" accept="image/png,image/jpeg">
                <button type="button" class="btn remove small" id="coverRemoveBtn" ${hasCover ? '' : 'disabled'}>${escapeHtml(t(lang, 'designerRemoveButton'))}</button>
              </div>
            </div>
            <p class="field-hint">${escapeHtml(t(lang, 'designerCoverHint'))}</p>
            <p class="upload-error" id="coverError" hidden></p>
            <input type="hidden" name="coverHash" id="coverHash" value="${escapeHtml(values.coverHash)}">
          </div>
          <div class="field">
            <label for="bgOpacity">${escapeHtml(t(lang, 'designerCoverOpacityLabel'))}</label>
            <div class="range-row">
              <input type="range" id="bgOpacity" name="bgOpacity" min="0" max="100" value="${opacityPct}">
              <span class="range-val" id="bgOpacityVal">${opacityPct}%</span>
            </div>
          </div>

          <div class="field">
            <label>${escapeHtml(t(lang, 'designerShapeHeading'))}</label>
            <div class="shape-toggle">
              <label><input type="radio" name="stampShape" value="circle" ${values.stampShape === 'square' ? '' : 'checked'}> ${escapeHtml(t(lang, 'designerShapeCircle'))}</label>
              <label><input type="radio" name="stampShape" value="square" ${values.stampShape === 'square' ? 'checked' : ''}> ${escapeHtml(t(lang, 'designerShapeSquare'))}</label>
            </div>
          </div>

          <h2>${escapeHtml(t(lang, 'designerColoursHeading'))}</h2>
          <div class="field colors">
            <div class="field">
              <label for="bgColor">${escapeHtml(t(lang, 'newCardBgLabel'))}</label>
              <div class="hex-row">
                <input type="color" id="bgColor" name="bgColor" value="${escapeHtml(values.bgColor)}">
                <input type="text" id="bgColorHex" maxlength="7" value="${escapeHtml(values.bgColor)}">
              </div>
            </div>
            <div class="field">
              <label for="stampActive">${escapeHtml(t(lang, 'newCardActiveLabel'))}</label>
              <div class="hex-row">
                <input type="color" id="stampActive" name="stampActive" value="${escapeHtml(values.stampActive)}">
                <input type="text" id="stampActiveHex" maxlength="7" value="${escapeHtml(values.stampActive)}">
              </div>
            </div>
            <div class="field">
              <label for="stampInactive">${escapeHtml(t(lang, 'newCardInactiveLabel'))}</label>
              <div class="hex-row">
                <input type="color" id="stampInactive" name="stampInactive" value="${escapeHtml(values.stampInactive)}">
                <input type="text" id="stampInactiveHex" maxlength="7" value="${escapeHtml(values.stampInactive)}">
              </div>
            </div>
          </div>
          <p class="field-hint amber" id="contrastWarning" ${lowContrast ? '' : 'hidden'}>${escapeHtml(t(lang, 'designerContrastWarning'))}</p>

          <div class="field">
            <label for="labelStamps">${escapeHtml(t(lang, 'designerLabelStampsLabel'))}</label>
            <input type="text" id="labelStamps" name="labelStamps" maxlength="16" value="${escapeHtml(values.labelStamps)}">
          </div>
          <div class="field">
            <label for="labelRewards">${escapeHtml(t(lang, 'designerLabelRewardsLabel'))}</label>
            <input type="text" id="labelRewards" name="labelRewards" maxlength="16" value="${escapeHtml(values.labelRewards)}">
          </div>

          <div class="locations-heading-row">
            <h2 style="margin:0;">${escapeHtml(t(lang, 'designerLocationsHeading'))}</h2>
            <span class="locations-counter" id="locationsCounter">${escapeHtml(t(lang, 'designerLocationsCounter', { count: arabicDigits(locationRows.length, lang), max: arabicDigits(MAX_CARD_LOCATIONS, lang) }))}</span>
          </div>
          <p class="locations-intro">${escapeHtml(t(lang, 'designerLocationsIntro'))}</p>
          <div id="locationsList">
            <p class="locations-empty" id="locationsEmpty" ${locationRows.length > 0 ? 'hidden' : ''}>${escapeHtml(t(lang, 'designerLocationsEmpty'))}</p>
            ${locationRows.map((row, i) => renderLocationRow(i, row, lang)).join('\n')}
          </div>
          <button type="button" class="btn secondary small" id="addLocationBtn" ${locationRows.length >= MAX_CARD_LOCATIONS ? 'disabled' : ''}>${escapeHtml(t(lang, 'designerLocationsAddButton'))}</button>
          <p class="field-hint amber" id="locationsMaxHint" ${locationRows.length >= MAX_CARD_LOCATIONS ? '' : 'hidden'}>${escapeHtml(t(lang, 'designerLocationsMaxReached', { max: arabicDigits(MAX_CARD_LOCATIONS, lang) }))}</p>

          <h2>${escapeHtml(t(lang, 'designerEconomicsHeading'))}${locked ? escapeHtml(t(lang, 'designerLockedSuffix')) : ''}</h2>
          <div class="field"${lockedClass}>
            <label for="rewardText">${escapeHtml(t(lang, 'newCardRewardLabel'))}</label>
            <input type="text" id="rewardText" name="rewardText" required maxlength="120" value="${escapeHtml(values.rewardText)}" ${dis}>
          </div>
          <div class="field"${lockedClass}>
            <label for="stampsGoal">${escapeHtml(t(lang, 'lockFieldStampsGoal'))} <span id="stampsGoalVal">${values.stampsGoal}</span></label>
            <input type="range" id="stampsGoal" name="stampsGoal" min="${MIN_GOAL}" max="${MAX_GOAL}" value="${values.stampsGoal}" ${dis}>
          </div>
          <div class="field"${lockedClass}>
            <label for="starterStamps">${escapeHtml(t(lang, 'lockFieldStarterStamps'))}</label>
            <input type="number" id="starterStamps" name="starterStamps" min="0" max="${MAX_GOAL}" value="${values.starterStamps}" ${dis}>
          </div>

          <button class="btn" type="submit">${escapeHtml(t(lang, 'editSaveButton'))}</button>
          <a class="btn secondary" href="/cards/${card.id}">${escapeHtml(t(lang, 'editCancelButton'))}</a>
        </form>
      </div>
      <div class="designer-preview">
        <div class="preview-panel">
          <img id="preview" src="${previewSrc}" alt="${escapeHtml(card.name)} stamp strip preview" width="750" height="288">
        </div>
      </div>
    </div>
    <script>
      (function () {
        var uploadUrl = ${JSON.stringify(`/cards/${card.id}/image`)};
        var uploadingLabel = ${JSON.stringify(t(lang, 'designerUploadingLabel'))};
        var genericError = ${JSON.stringify(t(lang, 'designerUploadErrorGeneric'))};

        var form = document.getElementById('designerForm');
        var preview = document.getElementById('preview');
        var stampsGoal = document.getElementById('stampsGoal');
        var stampsGoalVal = document.getElementById('stampsGoalVal');
        var bgOpacity = document.getElementById('bgOpacity');
        var bgOpacityVal = document.getElementById('bgOpacityVal');
        var iconHash = document.getElementById('iconHash');
        var coverHash = document.getElementById('coverHash');
        var iconFitInputs = form.querySelectorAll('input[name="iconFit"]');
        var stampSourceInputs = form.querySelectorAll('input[name="stampSource"]');
        var builtinIconField = document.getElementById('builtinIconField');
        var ownIconField = document.getElementById('ownIconField');
        var nonSquareIconHint = document.getElementById('nonSquareIconHint');
        var contrastWarning = document.getElementById('contrastWarning');

        function currentShape() {
          var checked = form.querySelector('input[name="stampShape"]:checked');
          return checked ? checked.value : 'circle';
        }

        function currentStampSource() {
          var checked = form.querySelector('input[name="stampSource"]:checked');
          return checked ? checked.value : 'builtin';
        }

        function currentBuiltinIcon() {
          var checked = form.querySelector('input[name="builtinIcon"]:checked');
          return checked ? checked.value : ${JSON.stringify(BUILTIN_ICON_IDS[0])};
        }

        function currentIconFit() {
          var checked = form.querySelector('input[name="iconFit"]:checked');
          return checked ? checked.value : 'contain';
        }

        function updateStampSourceFields() {
          var source = currentStampSource();
          builtinIconField.hidden = source !== 'builtin';
          ownIconField.hidden = source !== 'icon';
        }

        function updateNonSquareIconHint() {
          nonSquareIconHint.hidden = !(currentStampSource() === 'icon' && iconHash.dataset.wide === '1');
        }

        // Mirrors packages/image/src/contrast.ts — duplicated, not imported,
        // because this designer script is plain browser JS with no build
        // step (every other live-preview control on this page works the
        // same way: point at GET /preview.png, never reimplement the
        // renderer). Keep the two in sync if the formula ever changes.
        function hexToRgb(hex) {
          var h = hex.replace('#', '');
          return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
        }
        function relativeLuminance(hex) {
          var rgb = hexToRgb(hex);
          var chans = rgb.map(function (c) {
            var s = c / 255;
            return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
          });
          return 0.2126 * chans[0] + 0.7152 * chans[1] + 0.0722 * chans[2];
        }
        function contrastRatioJs(hexA, hexB) {
          var a = relativeLuminance(hexA), b = relativeLuminance(hexB);
          var lighter = Math.max(a, b), darker = Math.min(a, b);
          return (lighter + 0.05) / (darker + 0.05);
        }
        function effectiveBgHex(bgHex, opacity) {
          var rgb = hexToRgb(bgHex);
          var mixed = rgb.map(function (c) { return Math.round(c * opacity + 255 * (1 - opacity)); });
          return '#' + mixed.map(function (c) { return c.toString(16).padStart(2, '0'); }).join('');
        }
        function updateContrastWarning(opacity) {
          var bg = effectiveBgHex(document.getElementById('bgColor').value, opacity);
          var low = contrastRatioJs(document.getElementById('stampActive').value, bg) < 3 ||
                    contrastRatioJs(document.getElementById('stampInactive').value, bg) < 3;
          contrastWarning.hidden = !low;
        }

        function refresh() {
          var goal = parseInt(stampsGoal.value, 10);
          stampsGoalVal.textContent = goal;
          var filled = Math.max(1, Math.floor(goal / 3));
          var opacity = (parseInt(bgOpacity.value, 10) / 100).toFixed(2);
          bgOpacityVal.textContent = bgOpacity.value + '%';
          var source = currentStampSource();
          var qs = new URLSearchParams({
            goal: String(goal),
            filled: String(filled),
            bg: document.getElementById('bgColor').value,
            active: document.getElementById('stampActive').value,
            inactive: document.getElementById('stampInactive').value,
            shape: currentShape(),
            opacity: opacity,
            stampSource: source,
            scale: '2'
          });
          if (source === 'icon' && iconHash.value) {
            qs.set('icon', iconHash.value);
            qs.set('fit', currentIconFit());
          } else if (source === 'builtin') {
            qs.set('builtinIcon', currentBuiltinIcon());
          }
          if (coverHash.value) qs.set('cover', coverHash.value);
          preview.src = '/preview.png?' + qs.toString();
          updateStampSourceFields();
          updateNonSquareIconHint();
          updateContrastWarning(parseFloat(opacity));
        }

        // Colour picker <-> hex text field, both ways, for each of the three colours.
        [['bgColor', 'bgColorHex'], ['stampActive', 'stampActiveHex'], ['stampInactive', 'stampInactiveHex']].forEach(function (pair) {
          var color = document.getElementById(pair[0]);
          var hex = document.getElementById(pair[1]);
          color.addEventListener('input', function () {
            hex.value = color.value;
            refresh();
          });
          hex.addEventListener('input', function () {
            var v = hex.value.trim();
            if (/^#?[0-9a-fA-F]{6}$/.test(v)) {
              color.value = v.startsWith('#') ? v : '#' + v;
              refresh();
            }
          });
        });

        stampsGoal.addEventListener('input', refresh);
        bgOpacity.addEventListener('input', refresh);
        form.querySelectorAll('input[name="stampShape"]').forEach(function (el) {
          el.addEventListener('change', refresh);
        });
        stampSourceInputs.forEach(function (el) {
          el.addEventListener('change', refresh);
        });
        iconFitInputs.forEach(function (el) {
          el.addEventListener('change', refresh);
        });
        form.querySelectorAll('input[name="builtinIcon"]').forEach(function (el) {
          el.addEventListener('change', function () {
            document.querySelectorAll('.icon-swatch').forEach(function (label) {
              label.classList.toggle('selected', label.getAttribute('data-icon-swatch') === el.value);
            });
            refresh();
          });
        });

        function setThumb(imgEl, url) {
          imgEl.src = url;
          imgEl.classList.add('shown');
        }
        function clearThumb(imgEl) {
          imgEl.src = '';
          imgEl.classList.remove('shown');
        }

        function wireUpload(fileInputId, hiddenInputId, thumbId, errorId, removeBtnId, kind) {
          var fileInput = document.getElementById(fileInputId);
          var hidden = document.getElementById(hiddenInputId);
          var thumb = document.getElementById(thumbId);
          var errorEl = document.getElementById(errorId);
          var removeBtn = document.getElementById(removeBtnId);

          fileInput.addEventListener('change', function () {
            var file = fileInput.files && fileInput.files[0];
            if (!file) return;
            errorEl.hidden = true;
            errorEl.textContent = uploadingLabel;
            errorEl.hidden = false;
            var body = new FormData();
            body.append(kind, file);
            fetch(uploadUrl, { method: 'POST', body: body })
              .then(function (res) {
                return res.json().then(function (data) {
                  return { status: res.status, data: data };
                });
              })
              .then(function (result) {
                if (result.status !== 200 || !result.data || !result.data.ok) {
                  errorEl.textContent = (result.data && result.data.error) || genericError;
                  errorEl.hidden = false;
                  return;
                }
                errorEl.hidden = true;
                hidden.value = result.data.hash;
                setThumb(thumb, result.data.url);
                removeBtn.disabled = false;
                if (kind === 'icon') {
                  hidden.dataset.wide = result.data.wideLogo ? '1' : '';
                  iconFitInputs.forEach(function (el) { el.disabled = false; });
                }
                refresh();
              })
              .catch(function () {
                errorEl.textContent = genericError;
                errorEl.hidden = false;
              });
          });

          removeBtn.addEventListener('click', function () {
            hidden.value = '';
            clearThumb(thumb);
            removeBtn.disabled = true;
            errorEl.hidden = true;
            if (kind === 'icon') {
              hidden.dataset.wide = '';
              iconFitInputs.forEach(function (el) { el.disabled = true; });
            }
            refresh();
          });
        }

        wireUpload('logoFile', 'logoHash', 'logoThumb', 'logoError', 'logoRemoveBtn', 'logo');
        wireUpload('iconFile', 'iconHash', 'iconThumb', 'iconError', 'iconRemoveBtn', 'icon');
        wireUpload('coverFile', 'coverHash', 'coverThumb', 'coverError', 'coverRemoveBtn', 'cover');

        // -------------------------------------------------------------------
        // Location reminders (BUILD.md §9.4/§8.13) — add/remove rows entirely
        // client-side, no server round trip, until Save is pressed (the
        // server re-validates everything on submit regardless — see
        // handleUpdateCard's parseLocationsFromFields/validateCardLocations).
        // The row markup here must stay in sync with server.ts's own
        // renderLocationRow: same field-name pattern locations[i][...].
        // -------------------------------------------------------------------
        var MAX_LOCATIONS = ${MAX_CARD_LOCATIONS};
        var locationsList = document.getElementById('locationsList');
        var locationsEmpty = document.getElementById('locationsEmpty');
        var locationsCounter = document.getElementById('locationsCounter');
        var addLocationBtn = document.getElementById('addLocationBtn');
        var locationsMaxHint = document.getElementById('locationsMaxHint');
        var nextLocationIndex = ${locationRows.length};
        var counterTemplate = ${JSON.stringify(t(lang, 'designerLocationsCounter', { count: '__COUNT__', max: '__MAX__' }))};
        var geoUnsupported = ${JSON.stringify(t(lang, 'designerLocationsGeoUnsupported'))};
        var geoRequesting = ${JSON.stringify(t(lang, 'designerLocationsGeoRequesting'))};
        var geoDenied = ${JSON.stringify(t(lang, 'designerLocationsGeoDenied'))};
        var geoSuccess = ${JSON.stringify(t(lang, 'designerLocationsGeoSuccess'))};
        var rowTitleTemplate = ${JSON.stringify(t(lang, 'designerLocationsRowTitle', { n: '__N__' }))};

        // Arabic-Indic digits (docs/COPY.md §3) for every number this
        // script renders after the initial (server-rendered, already
        // arabicDigits()-converted) page load — mirrors
        // packages/i18n/src/index.ts's own arabicDigits(), duplicated here
        // for the same reason the contrast-ratio math above is duplicated:
        // this designer script is plain browser JS with no build step and
        // no access to that module.
        var LNX_LANG = ${JSON.stringify(lang)};
        var ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
        function localizeDigits(n) {
          var s = String(n);
          if (LNX_LANG !== 'ar') return s;
          return s.replace(/[0-9]/g, function (d) { return ARABIC_INDIC_DIGITS[Number(d)]; });
        }

        function rowCount() {
          return locationsList.querySelectorAll('[data-location-row]').length;
        }

        function refreshLocationsChrome() {
          var count = rowCount();
          locationsEmpty.hidden = count > 0;
          locationsCounter.textContent = counterTemplate
            .replace('__COUNT__', localizeDigits(count))
            .replace('__MAX__', localizeDigits(MAX_LOCATIONS));
          var atMax = count >= MAX_LOCATIONS;
          addLocationBtn.disabled = atMax;
          locationsMaxHint.hidden = !atMax;
        }

        function renumberLocationRows() {
          locationsList.querySelectorAll('[data-location-row]').forEach(function (row, i) {
            var title = row.querySelector('.row-title');
            if (title) title.textContent = rowTitleTemplate.replace('__N__', localizeDigits(i + 1));
          });
        }

        function buildLocationRow(index) {
          var row = document.createElement('div');
          row.className = 'location-row';
          row.setAttribute('data-location-row', '');
          row.setAttribute('data-index', String(index));
          row.innerHTML =
            '<div class="row-head">' +
              '<span class="row-title"></span>' +
              '<button type="button" class="btn remove small" data-remove-location>${escapeHtml(t(lang, 'designerLocationsRemoveButton'))}</button>' +
            '</div>' +
            '<div class="field">' +
              '<label>${escapeHtml(t(lang, 'designerLocationsNameLabel'))}</label>' +
              '<input type="text" name="locations[' + index + '][name]" maxlength="80" placeholder="${escapeHtml(t(lang, 'designerLocationsNamePlaceholder'))}">' +
            '</div>' +
            '<div class="geo-row">' +
              '<button type="button" class="btn secondary small" data-use-current-location>${escapeHtml(t(lang, 'designerLocationsUseCurrentButton'))}</button>' +
              '<span class="geo-status" data-geo-status></span>' +
            '</div>' +
            '<div class="location-grid">' +
              '<div class="field">' +
                '<label>${escapeHtml(t(lang, 'designerLocationsLatLabel'))}</label>' +
                '<input type="text" inputmode="decimal" name="locations[' + index + '][lat]" data-lat placeholder="24.7136">' +
              '</div>' +
              '<div class="field">' +
                '<label>${escapeHtml(t(lang, 'designerLocationsLngLabel'))}</label>' +
                '<input type="text" inputmode="decimal" name="locations[' + index + '][lng]" data-lng placeholder="46.6753">' +
              '</div>' +
            '</div>' +
            '<div class="field" style="margin-bottom:0;">' +
              '<label>${escapeHtml(t(lang, 'designerLocationsRelevantTextLabel'))}</label>' +
              '<input type="text" name="locations[' + index + '][relevantText]" maxlength="160" placeholder="${escapeHtml(t(lang, 'designerLocationsRelevantTextPlaceholder'))}">' +
            '</div>';
          return row;
        }

        function wireLocationRow(row) {
          var removeBtn = row.querySelector('[data-remove-location]');
          removeBtn.addEventListener('click', function () {
            row.remove();
            renumberLocationRows();
            refreshLocationsChrome();
          });

          var useCurrentBtn = row.querySelector('[data-use-current-location]');
          var status = row.querySelector('[data-geo-status]');
          var latInput = row.querySelector('[data-lat]');
          var lngInput = row.querySelector('[data-lng]');
          useCurrentBtn.addEventListener('click', function () {
            status.classList.remove('error');
            if (!navigator.geolocation) {
              status.textContent = geoUnsupported;
              status.classList.add('error');
              return;
            }
            status.textContent = geoRequesting;
            navigator.geolocation.getCurrentPosition(
              function (pos) {
                latInput.value = pos.coords.latitude.toFixed(6);
                lngInput.value = pos.coords.longitude.toFixed(6);
                status.textContent = geoSuccess;
              },
              function () {
                status.textContent = geoDenied;
                status.classList.add('error');
              },
              { enableHighAccuracy: false, timeout: 10000 }
            );
          });
        }

        locationsList.querySelectorAll('[data-location-row]').forEach(function (row) {
          wireLocationRow(row);
        });

        addLocationBtn.addEventListener('click', function () {
          if (rowCount() >= MAX_LOCATIONS) return;
          var row = buildLocationRow(nextLocationIndex);
          nextLocationIndex += 1;
          locationsList.appendChild(row);
          wireLocationRow(row);
          renumberLocationRows();
          refreshLocationsChrome();
        });

        refreshLocationsChrome();
      })();
    </script>
  `;
  return layout(t(lang, 'editTitle'), body, 'cards', lang);
}

async function handleEditCardForm(req: http.IncomingMessage, res: http.ServerResponse, id: string, merchant: Merchant): Promise<void> {
  const lang = resolveLang(req);
  const card = await findOwnedCard(id, merchant.id);
  if (!card) {
    sendNotFound(res, `No card with id "${id}".`);
    return;
  }
  const passCount = await passCountForCard(card.id);
  const wideIcon = await isStoredLogoWide(card.iconHash);
  sendHtml(
    res,
    200,
    renderEditCardForm(
      card,
      passCount,
      lang,
      {
        name: card.name,
        rewardText: card.rewardText,
        stampsGoal: card.stampsGoal,
        starterStamps: card.starterStamps,
        bgColor: card.bgColor,
        bgOpacity: card.bgOpacity,
        stampActive: card.stampActive,
        stampInactive: card.stampInactive,
        stampShape: card.stampShape,
        stampSource: parseStampSource(card.stampSource, 'builtin'),
        builtinIcon: isBuiltinIconId(card.builtinIcon) ? card.builtinIcon : 'star',
        labelStamps: card.labelStamps,
        labelRewards: card.labelRewards,
        logoHash: card.logoHash ?? '',
        iconHash: card.iconHash ?? '',
        iconFit: card.iconFit,
        coverHash: card.coverHash ?? '',
      },
      wideIcon,
      parseCardLocations(card.locations).map(locationToRawRow)
    )
  );
}

async function handleUpdateCard(req: http.IncomingMessage, res: http.ServerResponse, id: string, merchant: Merchant): Promise<void> {
  const lang = resolveLang(req);
  let fields: querystring.ParsedUrlQuery;
  try {
    fields = await readUrlencodedBody(req);
  } catch (err) {
    const status = isHttpError(err) ? err.statusCode : 400;
    const message = err instanceof Error ? err.message : String(err);
    sendHtml(res, status, layout('Error', `<div class="panel"><h1>${status}</h1><p>${escapeHtml(message)}</p></div>`, 'cards', lang));
    return;
  }

  const card = await findOwnedCard(id, merchant.id);
  if (!card) {
    sendNotFound(res, `No card with id "${id}".`);
    return;
  }
  const passCount = await passCountForCard(id);
  const locked = passCount > 0;

  // Capped at 80 chars, matching POST /cards' own limit (server.ts's
  // handleCreateCard) — the create form enforces this with a rejecting
  // error message; here it is a silent truncation, consistent with how
  // labelStamps/labelRewards just below are already clamped rather than
  // rejected, since name is otherwise unvalidated on this path.
  const name = String(fields.name ?? '').trim().slice(0, 80);
  const bgColor = validHex(fields.bgColor, card.bgColor);
  const stampActive = validHex(fields.stampActive, card.stampActive);
  const stampInactive = validHex(fields.stampInactive, card.stampInactive);
  const labelStamps = String(fields.labelStamps ?? '').trim().slice(0, 16);
  const labelRewards = String(fields.labelRewards ?? '').trim().slice(0, 16);
  const stampShapeRaw = String(fields.stampShape ?? '').trim();
  const stampShape = stampShapeRaw === 'square' ? 'square' : stampShapeRaw === 'circle' ? 'circle' : card.stampShape;
  const stampSource = parseStampSource(fields.stampSource, parseStampSource(card.stampSource, 'builtin'));
  const builtinIconRaw = String(fields.builtinIcon ?? '').trim();
  const builtinIcon: BuiltinIconId = isBuiltinIconId(builtinIconRaw)
    ? builtinIconRaw
    : isBuiltinIconId(card.builtinIcon)
      ? card.builtinIcon
      : 'star';
  const bgOpacity = clampFloat01(
    fields.bgOpacity !== undefined ? Number.parseInt(String(fields.bgOpacity), 10) / 100 : undefined,
    card.bgOpacity
  );
  const iconFitRaw = String(fields.iconFit ?? '').trim();
  const iconFit = iconFitRaw === 'cover' ? 'cover' : iconFitRaw === 'contain' ? 'contain' : card.iconFit;

  // Location reminders (BUILD.md §9.4/§9.1) — always editable (cardEdit.ts's
  // AESTHETIC_FIELDS), so this runs unconditionally, locked card or not,
  // same as colours/images above. Validated *before* the economic-lock
  // rejection path below can fire, so a merchant fixing their location list
  // on a locked card gets the location-specific error, not a generic one,
  // when both happen to be wrong at once — locations are simply checked
  // first.
  const locationRows = parseLocationsFromFields(fields);
  const locationsResult = validateCardLocations(locationRows);
  if (!locationsResult.ok) {
    const message =
      locationsResult.reason === 'too_many'
        ? t(lang, 'designerLocationsMaxReached', { max: arabicDigits(MAX_CARD_LOCATIONS, lang) })
        : locationsResult.reason === 'name_required'
          ? t(lang, 'designerLocationsNameRequired', { n: arabicDigits(locationsResult.index + 1, lang) })
          : locationsResult.reason === 'invalid_latitude'
            ? t(lang, 'designerLocationsLatInvalid', { n: arabicDigits(locationsResult.index + 1, lang) })
            : t(lang, 'designerLocationsLngInvalid', { n: arabicDigits(locationsResult.index + 1, lang) });
    const wideIconForError = await isStoredLogoWide(card.iconHash);
    sendHtml(
      res,
      400,
      renderEditCardForm(
        card,
        passCount,
        lang,
        {
          name,
          rewardText: card.rewardText,
          stampsGoal: card.stampsGoal,
          starterStamps: card.starterStamps,
          bgColor,
          bgOpacity,
          stampActive,
          stampInactive,
          stampShape,
          stampSource,
          builtinIcon,
          labelStamps,
          labelRewards,
          logoHash: card.logoHash ?? '',
          iconHash: card.iconHash ?? '',
          iconFit,
          coverHash: card.coverHash ?? '',
        },
        wideIconForError,
        locationRows,
        message
      )
    );
    return;
  }

  const patch: CardEditInput = {
    name: name || card.name,
    bgColor,
    bgOpacity,
    stampActive,
    stampInactive,
    stampShape,
    stampSource,
    builtinIcon,
    labelStamps,
    labelRewards,
    iconFit,
    locations: locationsResult.locations,
  };

  // Images: images/colours/shape/labels never lock (BUILD.md §8.7's green
  // line), so these are applied unconditionally, locked card or not. A
  // hidden field carrying '' means "the merchant removed it" — cardEdit.ts
  // treats a present-but-empty patch value the same as any other explicit
  // write, so this clears the column rather than leaving it alone (which is
  // what an *absent* key would do instead).
  // isValidHash() gate matches every other consumer of a card image hash
  // (cardImages.ts's isStoredLogoWide, server.ts's own loadImageRef) — a
  // hidden field's value is only ever supposed to be a sha256 hex hash this
  // same request cycle's own upload handler produced, but nothing stops a
  // tampered request from sending something else. An invalid value is
  // treated exactly like an empty one (the "remove the image" case) rather
  // than stored as-is: the same graceful-degrade-to-"no image" rule
  // loadImageRef's own comment describes, applied at write time instead of
  // read time, so a bad hash never reaches the database in the first place.
  if ('logoHash' in fields) {
    const hash = String(fields.logoHash ?? '').trim();
    const valid = isValidHash(hash);
    patch.logoHash = valid ? hash : null;
    patch.logoUrl = valid ? imageUrl(hash) : null;
  }
  if ('iconHash' in fields) {
    const hash = String(fields.iconHash ?? '').trim();
    const valid = isValidHash(hash);
    patch.iconHash = valid ? hash : null;
    patch.iconUrl = valid ? imageUrl(hash) : null;
  }
  if ('coverHash' in fields) {
    const hash = String(fields.coverHash ?? '').trim();
    const valid = isValidHash(hash);
    patch.coverHash = valid ? hash : null;
    patch.coverUrl = valid ? imageUrl(hash) : null;
  }

  // Economic fields: a locked card's form renders these inputs `disabled`,
  // so a normal browser submission never includes them at all — but the
  // server never trusts that alone (BUILD.md §8.7). When the card is not
  // yet locked, they are read from the submitted form like anything else.
  if (!locked) {
    const rewardText = String(fields.rewardText ?? '').trim();
    const stampsGoal = clampInt(fields.stampsGoal, MIN_GOAL, MAX_GOAL, card.stampsGoal);
    const starterStamps = clampInt(fields.starterStamps, 0, MAX_GOAL, card.starterStamps);
    patch.rewardText = rewardText || card.rewardText;
    patch.stampsGoal = stampsGoal;
    patch.starterStamps = starterStamps;
  } else if ('stampsGoal' in fields || 'rewardText' in fields || 'starterStamps' in fields) {
    // Belt-and-braces: even if a client sends these fields anyway (a
    // tampered request, not the rendered form), feed them through so
    // updateCard() sees the attempt and rejects it with 409 rather than
    // silently ignoring it.
    const rewardText = String(fields.rewardText ?? '').trim();
    if (rewardText) patch.rewardText = rewardText;
    if ('stampsGoal' in fields) patch.stampsGoal = clampInt(fields.stampsGoal, MIN_GOAL, MAX_GOAL, card.stampsGoal);
    if ('starterStamps' in fields) patch.starterStamps = clampInt(fields.starterStamps, 0, MAX_GOAL, card.starterStamps);
  }

  const result = await updateCard(id, merchant.id, patch);
  if (!result.ok) {
    if (result.reason === 'not_found') {
      sendNotFound(res, `No card with id "${id}".`);
      return;
    }
    // BUILD.md §8.7: "enforce server-side, not just in the UI" — HTTP 409,
    // translated (BUILD.md §13: server error messages are translated too).
    // The whole patch was rejected (updateCard's own "wholesale" rule), so
    // the image hashes below reflect the card's unchanged saved state, not
    // any just-submitted (and discarded) upload — there is no safe merged
    // value to show for those without re-uploading. Plain aesthetic fields
    // (stampSource/builtinIcon/iconFit included) still echo back what the
    // merchant just typed, same as bgColor/stampShape below, so a rejected
    // economic edit never throws away an aesthetic one in the same submit.
    const wideIcon = await isStoredLogoWide(card.iconHash);
    sendHtml(
      res,
      409,
      renderEditCardForm(
        card,
        passCount,
        lang,
        {
          name,
          rewardText: card.rewardText,
          stampsGoal: card.stampsGoal,
          starterStamps: card.starterStamps,
          bgColor,
          bgOpacity,
          stampActive,
          stampInactive,
          stampShape,
          stampSource,
          builtinIcon,
          labelStamps,
          labelRewards,
          logoHash: card.logoHash ?? '',
          iconHash: card.iconHash ?? '',
          iconFit,
          coverHash: card.coverHash ?? '',
        },
        wideIcon,
        locationRows,
        t(lang, 'economicFieldLocked')
      )
    );
    return;
  }

  res.writeHead(303, { Location: `/cards/${id}` });
  res.end();

  // Fire the live-update push only *after* the response above, and never
  // awaited by this handler (BUILD.md §18 item 6, same rule POST
  // /api/stamp's own fan-out follows) — an edit can affect many
  // passes/devices at once, and none of that should ever slow down, let
  // alone fail, the merchant's own save. This is also what makes the
  // `.pkpass` cache-key fix above (PKPASS_STORE / pkpassCacheKey) actually
  // visible to a customer promptly instead of only on their device's next
  // unprompted poll.
  setImmediate(() => {
    pushCardUpdate(id).catch((err) => {
      console.error(`[push] card-edit live-update fan-out threw for card ${id}:`, err);
    });
  });
}

// ---------------------------------------------------------------------------
// Route: GET /customers — BUILD.md §8.11. Search by card number, name or
// phone; filter by card; footer "showing N of N customers"; Export CSV.
// `merchant` comes from requireMerchant() at the router (never a
// client-supplied id), and every query below is explicitly scoped by
// merchantId — never "every Pass row in the table" (BUILD.md §17).
// ---------------------------------------------------------------------------
interface CustomerFilters {
  q: string;
  cardId: string; // '' = all cards
}

function parseCustomerFilters(url: URL): CustomerFilters {
  return {
    q: (url.searchParams.get('q') ?? '').trim(),
    cardId: (url.searchParams.get('card') ?? '').trim(),
  };
}

async function fetchCustomerRows(merchantId: string, filters: CustomerFilters) {
  const where: Prisma.PassWhereInput = { merchantId };
  if (filters.cardId) where.cardId = filters.cardId;
  if (filters.q) {
    where.OR = [
      { shortCode: { contains: filters.q, mode: 'insensitive' } },
      { custName: { contains: filters.q, mode: 'insensitive' } },
      { custPhone: { contains: filters.q, mode: 'insensitive' } },
    ];
  }
  return prisma.pass.findMany({ where, include: { card: true }, orderBy: { createdAt: 'desc' } });
}

function formatLastVisit(date: Date | null, lang: Lang): string {
  if (!date) return t(lang, 'customersNeverVisited');
  return arabicDigits(date.toISOString().slice(0, 10), lang);
}

async function handleCustomersList(req: http.IncomingMessage, res: http.ServerResponse, url: URL, merchant: Merchant): Promise<void> {
  const lang = resolveLang(req);
  const filters = parseCustomerFilters(url);

  const [cards, totalCount, rows] = await Promise.all([
    prisma.card.findMany({ where: { merchantId: merchant.id }, orderBy: { createdAt: 'asc' } }),
    prisma.pass.count({ where: { merchantId: merchant.id } }),
    fetchCustomerRows(merchant.id, filters),
  ]);

  const filtersActive = Boolean(filters.q || filters.cardId);
  const exportQs = new URLSearchParams();
  if (filters.q) exportQs.set('q', filters.q);
  if (filters.cardId) exportQs.set('card', filters.cardId);
  const exportHref = `/customers/export.csv${exportQs.toString() ? `?${exportQs.toString()}` : ''}`;

  const tableOrEmpty =
    totalCount === 0
      ? `<div class="panel empty">
          <h1>${escapeHtml(t(lang, 'customersEmptyTitle'))}</h1>
          <p class="muted">${escapeHtml(t(lang, 'customersEmptyBody'))}</p>
        </div>`
      : `<div class="panel" style="overflow-x:auto;">
          ${
            rows.length === 0
              ? `<p class="no-data">${escapeHtml(t(lang, 'customersNoMatches'))}</p>`
              : `<table class="data">
                  <thead><tr>
                    <th>${escapeHtml(t(lang, 'customersColCardNumber'))}</th>
                    <th>${escapeHtml(t(lang, 'customersColCustomer'))}</th>
                    <th>${escapeHtml(t(lang, 'customersColCard'))}</th>
                    <th>${escapeHtml(t(lang, 'customersColProgress'))}</th>
                    <th>${escapeHtml(t(lang, 'customersColVisits'))}</th>
                    <th>${escapeHtml(t(lang, 'customersColRewards'))}</th>
                    <th>${escapeHtml(t(lang, 'customersColLastVisit'))}</th>
                  </tr></thead>
                  <tbody>
                    ${rows
                      .map((p) => {
                        const goal = Math.max(1, p.card.stampsGoal);
                        const pct = Math.max(0, Math.min(100, Math.round((p.stamps / goal) * 100)));
                        return `<tr>
                          <td><code class="mono">${escapeHtml(p.shortCode)}</code></td>
                          <td>${p.custName ? escapeHtml(p.custName) : escapeHtml(t(lang, 'customersUnnamed'))}</td>
                          <td>${escapeHtml(p.card.name)}</td>
                          <td>
                            <div class="progress-bar">
                              <div class="track"><div class="fill" style="width:${pct}%"></div></div>
                              <span class="frac">${arabicDigits(p.stamps, lang)}/${arabicDigits(p.card.stampsGoal, lang)}</span>
                            </div>
                          </td>
                          <td>${arabicDigits(p.totalStamps, lang)}</td>
                          <td>${arabicDigits(p.rewards, lang)}</td>
                          <td>${escapeHtml(formatLastVisit(p.lastStampAt, lang))}</td>
                        </tr>`;
                      })
                      .join('\n')}
                  </tbody>
                </table>`
          }
        </div>`;

  const body = `
    <div class="row" style="margin-bottom:18px;">
      <h1>${escapeHtml(t(lang, 'customersTitle'))}</h1>
      <a class="btn secondary" href="${exportHref}">${escapeHtml(t(lang, 'customersExportButton'))}</a>
    </div>
    <div class="panel">
      <form method="GET" action="/customers" class="row" style="align-items:flex-end;gap:12px;">
        <div class="field" style="flex:2 1 260px;margin-bottom:0;">
          <label for="q">${escapeHtml(t(lang, 'customersSearchPlaceholder'))}</label>
          <input type="text" id="q" name="q" value="${escapeHtml(filters.q)}" placeholder="${escapeHtml(t(lang, 'customersSearchPlaceholder'))}">
        </div>
        <div class="field" style="flex:1 1 200px;margin-bottom:0;">
          <label for="card">${escapeHtml(t(lang, 'customersColCard'))}</label>
          <select id="card" name="card">
            <option value="">${escapeHtml(t(lang, 'customersFilterAllCards'))}</option>
            ${cards
              .map(
                (c) =>
                  `<option value="${c.id}"${filters.cardId === c.id ? ' selected' : ''}>${escapeHtml(c.name)}</option>`
              )
              .join('')}
          </select>
        </div>
        <div class="field" style="margin-bottom:0;">
          <button class="btn" type="submit">${escapeHtml(t(lang, 'customersSearchButton'))}</button>
          ${filtersActive ? `<a class="btn secondary" href="/customers">${escapeHtml(t(lang, 'customersClearButton'))}</a>` : ''}
        </div>
      </form>
    </div>
    ${tableOrEmpty}
    <p class="muted">${escapeHtml(t(lang, 'customersFooter', { shown: arabicDigits(rows.length, lang), total: arabicDigits(totalCount, lang) }))}</p>
  `;
  sendHtml(res, 200, layout(t(lang, 'customersTitle'), body, 'customers', lang));
}

async function handleCustomersExport(req: http.IncomingMessage, res: http.ServerResponse, url: URL, merchant: Merchant): Promise<void> {
  const filters = parseCustomerFilters(url);
  const rows = await fetchCustomerRows(merchant.id, filters);

  const lines = [
    csvRow(['Card number', 'Customer', 'Phone', 'Card', 'Stamps', 'Goal', 'Visits', 'Rewards', 'Last visit']),
    ...rows.map((p) =>
      csvRow([
        p.shortCode,
        p.custName,
        p.custPhone,
        p.card.name,
        String(p.stamps),
        String(p.card.stampsGoal),
        String(p.totalStamps),
        String(p.rewards),
        p.lastStampAt ? p.lastStampAt.toISOString() : '',
      ])
    ),
  ];
  const csv = lines.join('\r\n') + '\r\n';
  const buffer = Buffer.from(csv, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="customers.csv"',
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store',
  });
  res.end(buffer);
}

// ---------------------------------------------------------------------------
// Route: GET /reports — BUILD.md §8.14. Every figure below comes from a
// real Prisma query against Pass/StampEvent — there is no placeholder path;
// an empty database renders "no data" (BUILD.md §8.14's own words) rather
// than invented numbers.
// ---------------------------------------------------------------------------
const REPORT_RANGES = [30, 60, 90] as const;
type ReportRange = (typeof REPORT_RANGES)[number];

function isReportRange(n: number): n is ReportRange {
  return (REPORT_RANGES as readonly number[]).includes(n);
}

function parseReportRange(url: URL): ReportRange {
  const raw = Number.parseInt(url.searchParams.get('range') ?? '30', 10);
  return isReportRange(raw) ? raw : 30;
}

const WEEKDAY_KEYS = [
  'reportsDaySun',
  'reportsDayMon',
  'reportsDayTue',
  'reportsDayWed',
  'reportsDayThu',
  'reportsDayFri',
  'reportsDaySat',
] as const;

async function handleReports(req: http.IncomingMessage, res: http.ServerResponse, url: URL, merchant: Merchant): Promise<void> {
  const lang = resolveLang(req);
  const range = parseReportRange(url);

  const now = new Date();
  const rangeCutoff = new Date(now.getTime() - range * 24 * 60 * 60 * 1000);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // "This week" — a rolling 7-day window ending now, not a calendar week —
  // there is no merchant-configurable week-start yet, and a rolling window
  // needs none.
  const weekCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [totalCustomers, stampsToday, rewardsThisWeek, stampsInRange, registeredInRange, stampEventsInRange, topPasses] =
    await Promise.all([
      prisma.pass.count({ where: { merchantId: merchant.id } }),
      prisma.stampEvent.count({ where: { merchantId: merchant.id, kind: 'STAMP', at: { gte: todayStart } } }),
      prisma.stampEvent.count({ where: { merchantId: merchant.id, kind: 'REWARD', at: { gte: weekCutoff } } }),
      prisma.stampEvent.count({ where: { merchantId: merchant.id, kind: 'STAMP', at: { gte: rangeCutoff } } }),
      prisma.pass.findMany({
        where: { merchantId: merchant.id, createdAt: { gte: rangeCutoff } },
        include: { card: true },
      }),
      prisma.stampEvent.findMany({
        where: { merchantId: merchant.id, kind: 'STAMP', at: { gte: rangeCutoff } },
        select: { at: true },
      }),
      prisma.pass.findMany({
        where: { merchantId: merchant.id },
        orderBy: { totalStamps: 'desc' },
        take: 5,
        include: { card: true },
      }),
    ]);

  // Funnel — scoped to the passes registered within the selected range, the
  // same window the chips control everywhere else on this page. "Reached
  // 50% of the goal" reads lifetime totalStamps (stamps collected to date,
  // including past rewards) against that pass's own card.stampsGoal — the
  // closest available proxy to "ever got halfway there" without a stamp
  // history table.
  const registered = registeredInRange.length;
  const earnedStamp = registeredInRange.filter((p) => p.totalStamps >= 1).length;
  const halfway = registeredInRange.filter((p) => p.totalStamps >= p.card.stampsGoal / 2).length;
  const wonReward = registeredInRange.filter((p) => p.rewards >= 1).length;

  const funnelSteps: Array<{ labelKey: 'reportsFunnelRegistered' | 'reportsFunnelEarnedStamp' | 'reportsFunnelHalfway' | 'reportsFunnelReward'; count: number }> = [
    { labelKey: 'reportsFunnelRegistered', count: registered },
    { labelKey: 'reportsFunnelEarnedStamp', count: earnedStamp },
    { labelKey: 'reportsFunnelHalfway', count: halfway },
    { labelKey: 'reportsFunnelReward', count: wonReward },
  ];
  const funnelBase = Math.max(1, registered);
  const funnelHtml =
    registered === 0
      ? `<p class="no-data">${escapeHtml(t(lang, 'reportsNoData'))}</p>`
      : `<div class="funnel">
          ${funnelSteps
            .map((step) => {
              const pct = Math.round((step.count / funnelBase) * 100);
              return `<div class="step">
                <span class="muted">${escapeHtml(t(lang, step.labelKey))}</span>
                <div class="track"><div class="fill" style="width:${pct}%"></div></div>
                <span>${arabicDigits(step.count, lang)}</span>
              </div>`;
            })
            .join('\n')}
        </div>`;

  // Stamps by weekday — Sunday first, matching Date#getDay()'s own 0-6.
  const weekdayCounts = [0, 0, 0, 0, 0, 0, 0];
  for (const ev of stampEventsInRange) {
    const day = ev.at.getDay();
    weekdayCounts[day] = (weekdayCounts[day] ?? 0) + 1;
  }
  const maxWeekday = Math.max(1, ...weekdayCounts);
  const weekdayHtml =
    stampEventsInRange.length === 0
      ? `<p class="no-data">${escapeHtml(t(lang, 'reportsNoData'))}</p>`
      : `<div class="weekday-chart">
          ${weekdayCounts
            .map((count, i) => {
              const height = Math.max(2, Math.round((count / maxWeekday) * 100));
              const dayKey = WEEKDAY_KEYS[i]!;
              return `<div class="bar-wrap">
                <span class="day-count">${arabicDigits(count, lang)}</span>
                <div class="bar" style="height:${height}%"></div>
                <span class="day-label">${escapeHtml(t(lang, dayKey))}</span>
              </div>`;
            })
            .join('\n')}
        </div>`;

  const topCustomersHtml =
    topPasses.length === 0 || topPasses.every((p) => p.totalStamps === 0)
      ? `<p class="no-data">${escapeHtml(t(lang, 'reportsNoData'))}</p>`
      : `<table class="data">
          <thead><tr>
            <th>${escapeHtml(t(lang, 'customersColCustomer'))}</th>
            <th>${escapeHtml(t(lang, 'customersColCard'))}</th>
            <th>${escapeHtml(t(lang, 'customersColVisits'))}</th>
            <th>${escapeHtml(t(lang, 'customersColRewards'))}</th>
            <th>${escapeHtml(t(lang, 'customersColLastVisit'))}</th>
          </tr></thead>
          <tbody>
            ${topPasses
              .map(
                (p) => `<tr>
                  <td>${p.custName ? escapeHtml(p.custName) : `<code class="mono">${escapeHtml(p.shortCode)}</code>`}</td>
                  <td>${escapeHtml(p.card.name)}</td>
                  <td>${arabicDigits(p.totalStamps, lang)}</td>
                  <td>${arabicDigits(p.rewards, lang)}</td>
                  <td>${escapeHtml(formatLastVisit(p.lastStampAt, lang))}</td>
                </tr>`
              )
              .join('\n')}
          </tbody>
        </table>`;

  const chips = REPORT_RANGES.map(
    (r) =>
      `<a class="chip${r === range ? ' active' : ''}" href="/reports?range=${r}">${escapeHtml(t(lang, r === 30 ? 'reportsRange30' : r === 60 ? 'reportsRange60' : 'reportsRange90'))}</a>`
  ).join(' ');

  const body = `
    <div class="row" style="margin-bottom:18px;">
      <h1>${escapeHtml(t(lang, 'reportsTitle'))}</h1>
      <div class="chips">${chips}</div>
    </div>
    <div class="kpis">
      <div class="kpi"><div class="n">${arabicDigits(totalCustomers, lang)}</div><div class="label">${escapeHtml(t(lang, 'reportsKpiCustomers'))}</div></div>
      <div class="kpi"><div class="n">${arabicDigits(stampsToday, lang)}</div><div class="label">${escapeHtml(t(lang, 'reportsKpiStampsToday'))}</div></div>
      <div class="kpi"><div class="n">${arabicDigits(rewardsThisWeek, lang)}</div><div class="label">${escapeHtml(t(lang, 'reportsKpiRewardsWeek'))}</div></div>
      <div class="kpi"><div class="n">${arabicDigits(stampsInRange, lang)}</div><div class="label">${escapeHtml(t(lang, 'reportsKpiStampsRange'))}</div></div>
    </div>
    <div class="panel">
      <h2>${escapeHtml(t(lang, 'reportsFunnelTitle'))}</h2>
      ${funnelHtml}
    </div>
    <div class="panel">
      <h2>${escapeHtml(t(lang, 'reportsWeekdayTitle'))}</h2>
      ${weekdayHtml}
    </div>
    <div class="panel" style="overflow-x:auto;">
      <h2>${escapeHtml(t(lang, 'reportsTopCustomersTitle'))}</h2>
      ${topCustomersHtml}
    </div>
  `;
  sendHtml(res, 200, layout(t(lang, 'reportsTitle'), body, 'reports', lang));
}

// ---------------------------------------------------------------------------
// Route: GET /settings — BUILD.md §8.13. This build ships the staff-PIN
// section (add/deactivate/remove staff who can open the stamp screen); the
// rest of §8.13 (business profile, billing, products & services) is out of
// scope here. Location reminders — also part of §8.13's design — live on
// each card's own edit page instead (handleEditCardForm/handleUpdateCard
// above), a deliberate choice: Card.locations is a per-card column, so a
// merchant with several cards can give each one its own geofences, and the
// existing card-edit page already carries exactly this "settings for one
// card, always editable, cache-invalidating on save" behaviour — see
// docs/BUILD.md §9.4's own value proposition and this branch's own report
// for the reasoning.
// ---------------------------------------------------------------------------

/** A random-looking but readable label for a just-created staff row when nothing else distinguishes it in a "created" banner — not used anywhere else; kept simple. */
function renderStaffRow(staff: Staff, lang: Lang): string {
  const badgeClass = staff.active ? 'active' : 'inactive';
  const badgeLabel = staff.active ? t(lang, 'settingsStaffActiveBadge') : t(lang, 'settingsStaffInactiveBadge');
  const toggleAction = staff.active ? 'deactivate' : 'activate';
  const toggleLabel = staff.active ? t(lang, 'settingsStaffDeactivateButton') : t(lang, 'settingsStaffActivateButton');
  return `<div class="staff-row">
    <div>
      <div class="name">${escapeHtml(staff.name)}</div>
      <span class="badge ${badgeClass}">${escapeHtml(badgeLabel)}</span>
    </div>
    <div class="actions">
      <form method="POST" action="/staff/${staff.id}/${toggleAction}" style="margin:0;">
        <button type="submit" class="btn secondary small">${escapeHtml(toggleLabel)}</button>
      </form>
      <form method="POST" action="/staff/${staff.id}/delete" style="margin:0;" data-confirm-remove-staff>
        <button type="submit" class="btn remove small">${escapeHtml(t(lang, 'settingsStaffRemoveButton'))}</button>
      </form>
    </div>
  </div>`;
}

function renderSettingsPage(
  staffList: Staff[],
  lang: Lang,
  opts: { newStaffName?: string; newStaffPin?: string; error?: string } = {}
): string {
  const revealBanner = opts.newStaffPin
    ? `<div class="staff-pin-reveal">
        <p style="margin:0 0 6px;">${escapeHtml(t(lang, 'settingsStaffPinShownOnce', { name: opts.newStaffName ?? '' }))}</p>
        <div class="pin">${escapeHtml(arabicDigits(opts.newStaffPin, lang))}</div>
      </div>`
    : '';
  const body = `
    <h1>${escapeHtml(t(lang, 'settingsTitle'))}</h1>
    ${opts.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : ''}
    <div class="panel">
      <h2>${escapeHtml(t(lang, 'settingsStaffHeading'))}</h2>
      <p class="settings-note">${escapeHtml(t(lang, 'settingsStaffIntro'))}</p>
      <p class="settings-note">${escapeHtml(t(lang, 'settingsStaffConvenienceNote'))}</p>
      ${revealBanner}
      ${
        staffList.length === 0
          ? `<p class="locations-empty">${escapeHtml(t(lang, 'settingsStaffEmptyState'))}</p>`
          : staffList.map((s) => renderStaffRow(s, lang)).join('\n')
      }
      <h2 style="margin-top:24px;">${escapeHtml(t(lang, 'settingsStaffAddHeading'))}</h2>
      <form method="POST" action="/staff">
        <div class="field">
          <label for="staffName">${escapeHtml(t(lang, 'settingsStaffNameLabel'))}</label>
          <input type="text" id="staffName" name="name" required maxlength="80" value="${escapeHtml(opts.newStaffName && opts.error ? opts.newStaffName : '')}">
        </div>
        <div class="field">
          <label for="staffPin">${escapeHtml(t(lang, 'settingsStaffPinLabel'))}</label>
          <div class="hex-row">
            <input type="text" id="staffPin" name="pin" inputmode="numeric" pattern="[0-9]{4,6}" minlength="${MIN_PIN_LENGTH}" maxlength="${MAX_PIN_LENGTH}" placeholder="${escapeHtml(t(lang, 'settingsStaffPinPlaceholder'))}">
            <button type="button" class="btn secondary small" id="generatePinBtn">${escapeHtml(t(lang, 'settingsStaffGeneratePinButton'))}</button>
          </div>
          <p class="field-hint">${escapeHtml(t(lang, 'settingsStaffPinHint'))}</p>
        </div>
        <button class="btn" type="submit">${escapeHtml(t(lang, 'settingsStaffAddButton'))}</button>
      </form>
    </div>
    <script>
      (function () {
        var btn = document.getElementById('generatePinBtn');
        var input = document.getElementById('staffPin');
        if (!btn || !input) return;
        btn.addEventListener('click', function () {
          var digits = '';
          var bytes = new Uint8Array(6);
          (window.crypto || window.msCrypto).getRandomValues(bytes);
          for (var i = 0; i < 6; i++) digits += String(bytes[i] % 10);
          input.value = digits;
        });
        document.querySelectorAll('[data-confirm-remove-staff]').forEach(function (form) {
          form.addEventListener('submit', function (e) {
            if (!window.confirm(${JSON.stringify(t(lang, 'settingsStaffRemoveConfirm'))})) e.preventDefault();
          });
        });
      })();
    </script>
  `;
  return layout(t(lang, 'settingsTitle'), body, 'settings', lang);
}

async function handleSettingsPage(req: http.IncomingMessage, res: http.ServerResponse, merchant: Merchant): Promise<void> {
  const lang = resolveLang(req);
  const staffList = await listStaff(merchant.id);
  sendHtml(res, 200, renderSettingsPage(staffList, lang));
}

/** POST /staff — creates a staff PIN account. Shows the plaintext PIN exactly once, inline in this response (never via redirect, so it never lands in a URL, a browser history entry, or a server access log) — it is hashed the moment it is generated/typed and cannot be recovered afterward. */
async function handleCreateStaff(req: http.IncomingMessage, res: http.ServerResponse, merchant: Merchant): Promise<void> {
  const lang = resolveLang(req);
  let fields: querystring.ParsedUrlQuery;
  try {
    fields = await readUrlencodedBody(req);
  } catch (err) {
    const status = isHttpError(err) ? err.statusCode : 400;
    const message = err instanceof Error ? err.message : String(err);
    sendHtml(res, status, layout('Error', `<div class="panel"><h1>${status}</h1><p>${escapeHtml(message)}</p></div>`, 'settings', lang));
    return;
  }

  const name = String(fields.name ?? '').trim().slice(0, 80);
  const pinRaw = String(fields.pin ?? '').trim();
  const pin = pinRaw || generatePin();

  const staffList = await listStaff(merchant.id);

  if (!name) {
    sendHtml(res, 400, renderSettingsPage(staffList, lang, { error: t(lang, 'settingsStaffNameRequired') }));
    return;
  }
  const pinCheck = validatePin(pin);
  if (!pinCheck.ok) {
    sendHtml(res, 400, renderSettingsPage(staffList, lang, { newStaffName: name, error: t(lang, 'settingsStaffPinInvalid') }));
    return;
  }

  await createStaff(merchant.id, name, pin);
  const updatedStaffList = await listStaff(merchant.id);
  sendHtml(res, 200, renderSettingsPage(updatedStaffList, lang, { newStaffName: name, newStaffPin: pin }));
}

/** POST /staff/:id/(activate|deactivate|delete) — scoped to `merchant.id` (setStaffActive/deleteStaff both re-check ownership themselves), same not-found-not-403 shape as every other merchant-owned-resource route in this file. An id belonging to another merchant, or that never existed, just redirects back to Settings with nothing changed — there is no separate "staff not found" state worth its own page for an action triggered from a button on a list this merchant already owns. */
async function handleStaffAction(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  staffId: string,
  action: 'activate' | 'deactivate' | 'delete',
  merchant: Merchant
): Promise<void> {
  if (action === 'delete') {
    await deleteStaff(staffId, merchant.id);
  } else {
    await setStaffActive(staffId, merchant.id, action === 'activate');
  }
  res.writeHead(303, { Location: '/settings' });
  res.end();
}

// ---------------------------------------------------------------------------
// Notifications (BUILD.md §8.12) — Send · Automated tabs. Owner session
// only: every handler below is reached exclusively via requireMerchant()
// at the router, the same guard as /customers, /reports and /settings — a
// staff PIN session (`lnx-staff` cookie) is simply invisible to it and
// 302s to /signin exactly as if there were no session at all (see
// requireMerchant's own doc comment). apps/demo/test/notificationsHttp.test.ts
// proves the refusal.
//
// Enqueuing (POST /notifications/send) only ever inserts rows via
// apps/demo/broadcast.ts's enqueueBroadcast() and returns — no push, no
// APNs client, nothing that could time out the request (BUILD.md §18 item
// 6). The actual fan-out is broadcastWorker's job, started once at boot
// (see the bottom of this file) and running independently of any request.
// ---------------------------------------------------------------------------

/** One broadcast per merchant per BROADCAST_WINDOW_MS at most — BUILD.md: "so a mistake cannot fire fifty in a minute." Keyed by merchant id, not IP: the whole point is limiting *this business's* messages to *its own* customers, regardless of which device/IP the owner is on. */
const broadcastLimiter = new RateLimiter({ limit: 5, windowMs: 10 * 60 * 1000 });

function checkBroadcastRateLimit(merchantId: string): boolean {
  return broadcastLimiter.check(merchantId);
}

type NotifTab = 'send' | 'automated';

function parseNotifTab(url: URL): NotifTab {
  return url.searchParams.get('tab') === 'automated' ? 'automated' : 'send';
}

function broadcastJobStatusLabel(job: Pick<BroadcastJob, 'status'>, lang: Lang): string {
  if (job.status === 'sending') return t(lang, 'notificationsStatusSending');
  if (job.status === 'sent') return t(lang, 'notificationsStatusSent');
  return t(lang, 'notificationsStatusQueued');
}

function broadcastJobProgressText(job: Pick<BroadcastJob, 'sentCount' | 'failedCount' | 'recipientCount'>, lang: Lang): string {
  const vars = {
    sent: arabicDigits(job.sentCount, lang),
    total: arabicDigits(job.recipientCount, lang),
    failed: arabicDigits(job.failedCount, lang),
  };
  return job.failedCount > 0
    ? t(lang, 'notificationsProgressWithFailed', vars)
    : t(lang, 'notificationsProgress', vars);
}

/** One `<div class="notif-job">` row — shared between the initial server-rendered list and the JS template string the Send tab's own `<script>` uses to render newly-submitted/polled jobs, so the two can never visually drift apart. */
function renderBroadcastJobRow(
  job: Pick<BroadcastJob, 'id' | 'status' | 'sentCount' | 'failedCount' | 'recipientCount'> & { cardName: string; message: string },
  lang: Lang
): string {
  return `<div class="notif-job" data-job-id="${escapeHtml(job.id)}" data-status="${escapeHtml(job.status)}">
    <span class="msg">${escapeHtml(job.cardName)} — ${escapeHtml(job.message)}</span>
    <span class="meta">${escapeHtml(broadcastJobProgressText(job, lang))}</span>
    <span class="status-pill ${escapeHtml(job.status)}">${escapeHtml(broadcastJobStatusLabel(job, lang))}</span>
  </div>`;
}

function renderNotificationsPage(
  lang: Lang,
  tab: NotifTab,
  cards: Card[],
  selectedCardId: string | undefined,
  initialRecipientCount: number,
  jobs: Array<BroadcastJob & { card: { name: string } }>
): string {
  const tabsHtml = `<div class="notif-tabs">
    <a href="/notifications?tab=send"${tab === 'send' ? ' class="active"' : ''}>${escapeHtml(t(lang, 'notificationsTabSend'))}</a>
    <a href="/notifications?tab=automated"${tab === 'automated' ? ' class="active"' : ''}>${escapeHtml(t(lang, 'notificationsTabAutomated'))}</a>
  </div>`;

  if (cards.length === 0) {
    return `<h1>${escapeHtml(t(lang, 'navNotifications'))}</h1>${tabsHtml}<div class="panel empty"><p class="muted">${escapeHtml(t(lang, 'notificationsNoCards'))}</p></div>`;
  }

  if (tab === 'automated') {
    const body = `<h1>${escapeHtml(t(lang, 'navNotifications'))}</h1>
    ${tabsHtml}
    <div class="automated-grid">
      <div class="automated-card">
        <h3>${escapeHtml(t(lang, 'notificationsAutomatedWelcomeTitle'))} <span class="status-pill live">${escapeHtml(t(lang, 'notificationsAutomatedWelcomeStatus'))}</span></h3>
        <p>${escapeHtml(t(lang, 'notificationsAutomatedWelcomeDesc'))}</p>
      </div>
      <div class="automated-card">
        <h3>${escapeHtml(t(lang, 'notificationsAutomatedBirthdayTitle'))} <span class="status-pill pending">${escapeHtml(t(lang, 'notificationsAutomatedNotScheduled'))}</span></h3>
        <p>${escapeHtml(t(lang, 'notificationsAutomatedBirthdayDesc'))}</p>
      </div>
      <div class="automated-card">
        <h3>${escapeHtml(t(lang, 'notificationsAutomatedWinbackTitle'))} <span class="status-pill pending">${escapeHtml(t(lang, 'notificationsAutomatedNotScheduled'))}</span></h3>
        <p>${escapeHtml(t(lang, 'notificationsAutomatedWinbackDesc'))}</p>
      </div>
    </div>`;
    return body;
  }

  const selected = selectedCardId ?? cards[0]!.id;
  const cardOptions = cards
    .map((c) => `<option value="${escapeHtml(c.id)}"${c.id === selected ? ' selected' : ''}>${escapeHtml(c.name)}</option>`)
    .join('');

  const historyHtml =
    jobs.length === 0
      ? `<p class="muted">${escapeHtml(t(lang, 'notificationsHistoryEmpty'))}</p>`
      : jobs.map((j) => renderBroadcastJobRow({ ...j, cardName: j.card.name }, lang)).join('\n');

  const body = `<h1>${escapeHtml(t(lang, 'navNotifications'))}</h1>
  ${tabsHtml}
  <div class="notif-advisory"><b>${escapeHtml(t(lang, 'notificationsTabSend'))}:</b> ${escapeHtml(t(lang, 'notificationsAdvisory'))}</div>
  <div class="panel">
    <form id="broadcastForm">
      <div class="field">
        <label for="cardId">${escapeHtml(t(lang, 'notificationsCardLabel'))}</label>
        <select id="cardId" name="cardId">${cardOptions}</select>
        <p class="notif-recipient-count" id="recipientCount">${escapeHtml(t(lang, 'notificationsRecipientCount', { count: arabicDigits(initialRecipientCount, lang) }))}</p>
      </div>
      <div class="field">
        <label for="message">${escapeHtml(t(lang, 'notificationsMessageLabel'))}</label>
        <textarea id="message" name="message" rows="4" maxlength="${BROADCAST_MESSAGE_MAX_LENGTH}" placeholder="${escapeHtml(t(lang, 'notificationsMessagePlaceholder'))}"></textarea>
        <p class="notif-counter" id="messageCounter">${escapeHtml(t(lang, 'notificationsMessageCounter', { count: arabicDigits(0, lang), max: arabicDigits(BROADCAST_MESSAGE_MAX_LENGTH, lang) }))}</p>
      </div>
      <p class="error" id="broadcastError" style="display:none;"></p>
      <button type="submit" class="btn" id="sendButton" disabled>${escapeHtml(t(lang, 'notificationsSendButton'))}</button>
    </form>
  </div>
  <div class="notif-history">
    <h2>${escapeHtml(t(lang, 'notificationsHistoryHeading'))}</h2>
    <div class="panel" id="jobList">${historyHtml}</div>
  </div>
  <script>
    (function () {
      var MAX_LEN = ${BROADCAST_MESSAGE_MAX_LENGTH};
      var LABELS = {
        queued: ${JSON.stringify(t(lang, 'notificationsStatusQueued'))},
        sending: ${JSON.stringify(t(lang, 'notificationsStatusSending'))},
        sent: ${JSON.stringify(t(lang, 'notificationsStatusSent'))}
      };
      var counterTpl = ${JSON.stringify(t(lang, 'notificationsMessageCounter', { count: '__N__', max: String(BROADCAST_MESSAGE_MAX_LENGTH) }))};
      var progressTpl = ${JSON.stringify(t(lang, 'notificationsProgress', { sent: '__S__', total: '__T__' }))};
      var progressFailedTpl = ${JSON.stringify(t(lang, 'notificationsProgressWithFailed', { sent: '__S__', total: '__T__', failed: '__F__' }))};
      var msgEmptyText = ${JSON.stringify(t(lang, 'notificationsMessageEmpty'))};
      var sendErrorText = ${JSON.stringify(t(lang, 'notificationsSendError'))};
      var sendingText = ${JSON.stringify(t(lang, 'notificationsSending'))};
      var sendText = ${JSON.stringify(t(lang, 'notificationsSendButton'))};
      var recipientTpl = ${JSON.stringify(t(lang, 'notificationsRecipientCount', { count: '__N__' }))};

      var cardSelect = document.getElementById('cardId');
      var messageEl = document.getElementById('message');
      var counterEl = document.getElementById('messageCounter');
      var sendBtn = document.getElementById('sendButton');
      var errorEl = document.getElementById('broadcastError');
      var recipientEl = document.getElementById('recipientCount');
      var jobList = document.getElementById('jobList');
      var form = document.getElementById('broadcastForm');

      function updateCounter() {
        var len = Array.from(messageEl.value.trim()).length;
        counterEl.textContent = counterTpl.replace('__N__', String(len));
        counterEl.classList.toggle('over', len > MAX_LEN);
        sendBtn.disabled = len === 0 || len > MAX_LEN;
      }
      messageEl.addEventListener('input', updateCounter);
      updateCounter();

      function refreshRecipientCount() {
        recipientEl.textContent = '…';
        fetch('/notifications/recipient-count?cardId=' + encodeURIComponent(cardSelect.value))
          .then(function (r) { return r.json(); })
          .then(function (data) {
            recipientEl.textContent = recipientTpl.replace('__N__', String(data.count));
          })
          .catch(function () {});
      }
      cardSelect.addEventListener('change', refreshRecipientCount);

      function progressText(job) {
        if (job.failedCount > 0) {
          return progressFailedTpl.replace('__S__', String(job.sentCount)).replace('__T__', String(job.recipientCount)).replace('__F__', String(job.failedCount));
        }
        return progressTpl.replace('__S__', String(job.sentCount)).replace('__T__', String(job.recipientCount));
      }

      function renderRow(job) {
        var row = document.createElement('div');
        row.className = 'notif-job';
        row.setAttribute('data-job-id', job.id);
        row.setAttribute('data-status', job.status);
        var msg = document.createElement('span');
        msg.className = 'msg';
        msg.textContent = job.cardName + ' — ' + job.message;
        var meta = document.createElement('span');
        meta.className = 'meta';
        meta.textContent = progressText(job);
        var pill = document.createElement('span');
        pill.className = 'status-pill ' + job.status;
        pill.textContent = LABELS[job.status] || job.status;
        row.appendChild(msg);
        row.appendChild(meta);
        row.appendChild(pill);
        return row;
      }

      function pollJob(jobId) {
        var attempts = 0;
        var interval = setInterval(function () {
          attempts++;
          fetch('/notifications/jobs/' + encodeURIComponent(jobId))
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
              if (!data || !data.job) { clearInterval(interval); return; }
              var existing = jobList.querySelector('[data-job-id="' + jobId + '"]');
              var fresh = renderRow(data.job);
              if (existing) existing.replaceWith(fresh);
              if (data.job.status === 'sent' || attempts > 120) clearInterval(interval);
            })
            .catch(function () { clearInterval(interval); });
        }, 1500);
      }

      // Any job the page loaded with that isn't finished yet — a merchant
      // who refreshes mid-send should see it keep moving, not look stuck.
      Array.prototype.forEach.call(jobList.querySelectorAll('.notif-job'), function (row) {
        var status = row.getAttribute('data-status');
        if (status !== 'sent') pollJob(row.getAttribute('data-job-id'));
      });

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        errorEl.style.display = 'none';
        var message = messageEl.value.trim();
        if (!message) {
          errorEl.textContent = msgEmptyText;
          errorEl.style.display = 'block';
          return;
        }
        sendBtn.disabled = true;
        sendBtn.textContent = sendingText;
        fetch('/notifications/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cardId: cardSelect.value, message: message })
        })
          .then(function (r) { return r.json().then(function (data) { return { status: r.status, data: data }; }); })
          .then(function (res) {
            if (res.status !== 200 || !res.data.ok) {
              errorEl.textContent = res.data && res.data.message ? res.data.message : sendErrorText;
              errorEl.style.display = 'block';
              return;
            }
            var emptyState = jobList.querySelector('.muted');
            if (emptyState) emptyState.remove();
            jobList.insertBefore(renderRow(res.data.job), jobList.firstChild);
            if (res.data.job.status !== 'sent') pollJob(res.data.job.id);
            messageEl.value = '';
            updateCounter();
          })
          .catch(function () {
            errorEl.textContent = sendErrorText;
            errorEl.style.display = 'block';
          })
          .then(function () {
            sendBtn.textContent = sendText;
            updateCounter();
          });
      });
    })();
  </script>`;
  return body;
}

async function handleNotificationsPage(req: http.IncomingMessage, res: http.ServerResponse, url: URL, merchant: Merchant): Promise<void> {
  const lang = resolveLang(req);
  const tab = parseNotifTab(url);
  const cards = await prisma.card.findMany({ where: { merchantId: merchant.id }, orderBy: { createdAt: 'desc' } });

  const requestedCardId = url.searchParams.get('cardId') ?? undefined;
  const selectedCard = cards.find((c) => c.id === requestedCardId) ?? cards[0];
  const initialRecipientCount = selectedCard ? await recipientCountForCard(selectedCard) : 0;

  const jobs = tab === 'send' ? await listBroadcastJobs(merchant.id) : [];

  sendHtml(res, 200, layout(t(lang, 'navNotifications'), renderNotificationsPage(lang, tab, cards, selectedCard?.id, initialRecipientCount, jobs), 'notifications', lang));
}

async function handleRecipientCount(req: http.IncomingMessage, res: http.ServerResponse, url: URL, merchant: Merchant): Promise<void> {
  const cardId = url.searchParams.get('cardId') ?? '';
  const card = await findOwnedCard(cardId, merchant.id);
  if (!card) {
    sendJson(res, 404, { ok: false, count: 0 });
    return;
  }
  const count = await recipientCountForCard(card);
  sendJson(res, 200, { ok: true, count });
}

function broadcastJobJson(job: BroadcastJob & { card?: { name: string } }) {
  return {
    id: job.id,
    status: job.status,
    message: job.message,
    recipientCount: job.recipientCount,
    sentCount: job.sentCount,
    failedCount: job.failedCount,
    cardName: job.card?.name ?? '',
  };
}

async function handleSendBroadcast(req: http.IncomingMessage, res: http.ServerResponse, merchant: Merchant): Promise<void> {
  const lang = resolveLang(req);

  if (!checkBroadcastRateLimit(merchant.id)) {
    sendJson(res, 429, { ok: false, message: t(lang, 'notificationsRateLimited') });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    const status = isHttpError(err) ? err.statusCode : 400;
    sendJson(res, status, { ok: false, message: t(lang, 'notificationsSendError') });
    return;
  }

  const cardId =
    typeof body === 'object' && body !== null && 'cardId' in body && typeof (body as { cardId: unknown }).cardId === 'string'
      ? (body as { cardId: string }).cardId
      : '';
  const rawMessage =
    typeof body === 'object' && body !== null && 'message' in body && typeof (body as { message: unknown }).message === 'string'
      ? (body as { message: string }).message
      : '';

  const card = await findOwnedCard(cardId, merchant.id);
  if (!card) {
    sendJson(res, 404, { ok: false, message: t(lang, 'cardNotFound') });
    return;
  }

  const message = sanitizeBroadcastMessage(rawMessage);
  if (!message) {
    sendJson(res, 400, { ok: false, message: t(lang, 'notificationsMessageEmpty') });
    return;
  }

  const job = await enqueueBroadcast(card, message, 'manual');
  sendJson(res, 200, { ok: true, job: broadcastJobJson({ ...job, card: { name: card.name } }) });
}

async function handleBroadcastJobStatus(req: http.IncomingMessage, res: http.ServerResponse, jobId: string, merchant: Merchant): Promise<void> {
  const job = await getBroadcastJob(jobId, merchant.id);
  if (!job) {
    sendJson(res, 404, { ok: false });
    return;
  }
  const card = await prisma.card.findUnique({ where: { id: job.cardId }, select: { name: true } });
  sendJson(res, 200, { ok: true, job: broadcastJobJson({ ...job, card: card ?? undefined }) });
}

// ---------------------------------------------------------------------------
// The stamp screen's own sign-in: a staff PIN (BUILD.md §8.13). Reached
// only when resolveStampAuth() finds neither a merchant session nor a
// staff session already (see the router's own GET /stamp handling below).
// There is no per-merchant URL for the stamp screen, so — like the owner's
// own sign-in form — this asks for the business email too, purely to know
// *whose* staff list to check the PIN against (apps/demo/staff.ts's
// findStaffByPin doc comment explains this choice in full).
// ---------------------------------------------------------------------------

function renderStaffPinForm(opts: { email?: string; error?: string }, lang: Lang): string {
  const { email = '', error } = opts;
  const body = `
    <h1>${escapeHtml(t(lang, 'staffPinLoginTitle'))}</h1>
    <p class="muted" style="margin-top:0;">${escapeHtml(t(lang, 'staffPinLoginIntro'))}</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <form method="POST" action="/stamp/pin">
      <div class="field">
        <label for="pinEmail">${escapeHtml(t(lang, 'staffPinLoginEmailLabel'))}</label>
        <input type="text" id="pinEmail" name="email" required autocomplete="email" value="${escapeHtml(email)}">
      </div>
      <div class="field">
        <label for="pinCode">${escapeHtml(t(lang, 'staffPinLoginPinLabel'))}</label>
        <input type="text" id="pinCode" name="pin" required inputmode="numeric" pattern="[0-9]{4,6}" autocomplete="off" maxlength="${MAX_PIN_LENGTH}">
      </div>
      <button class="btn" type="submit" style="width:100%;">${escapeHtml(t(lang, 'staffPinLoginSubmitButton'))}</button>
    </form>
    <p class="muted" style="margin-top:16px;">${escapeHtml(t(lang, 'staffPinLoginOwnerText'))} <a href="/signin">${escapeHtml(t(lang, 'staffPinLoginOwnerLink'))}</a></p>
  `;
  return authPageShell(t(lang, 'staffPinLoginTitle'), body, lang);
}

function handleStaffPinForm(req: http.IncomingMessage, res: http.ServerResponse): void {
  const lang = resolveLang(req);
  sendHtml(res, 200, renderStaffPinForm({}, lang));
}

/** Rate-limited both per business email/id (a shared shop device brute-forcing its own owner's staff PINs) and per IP (a botnet spraying PIN guesses across many businesses) — same two-limiter shape as auth.ts's own sign-in limiters, and for the same reason: either alone lets an attacker route around the other. A 4-6 digit PIN is only 10,000-1,000,000 combinations, so this lockout is the entire reason a leaked/guessed PIN doesn't just work on the first try eventually — BUILD.md job brief: "rate-limit PIN attempts per merchant and lock out after repeated failures". */
const staffPinLimiterByKey = new RateLimiter({ limit: 8, windowMs: 15 * 60 * 1000 });
const staffPinLimiterByIp = new RateLimiter({ limit: 30, windowMs: 15 * 60 * 1000 });

async function handleStaffPinLogin(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const lang = resolveLang(req);
  let fields: querystring.ParsedUrlQuery;
  try {
    fields = await readUrlencodedBody(req);
  } catch (err) {
    const status = isHttpError(err) ? err.statusCode : 400;
    const message = err instanceof Error ? err.message : String(err);
    sendHtml(res, status, layout('Error', `<div class="panel"><h1>${status}</h1><p>${escapeHtml(message)}</p></div>`, undefined, lang));
    return;
  }

  const emailRaw = String(fields.email ?? '').trim();
  const email = normalizeEmail(emailRaw);
  const pin = String(fields.pin ?? '').trim();
  const ip = resolveClientIp(req.headers, req.socket.remoteAddress);

  if (!staffPinLimiterByKey.check(email || `empty:${ip}`) || !staffPinLimiterByIp.check(ip)) {
    sendHtml(res, 429, renderStaffPinForm({ email: emailRaw, error: t(lang, 'staffPinRateLimited') }, lang));
    return;
  }

  const invalid = () => sendHtml(res, 401, renderStaffPinForm({ email: emailRaw, error: t(lang, 'staffPinInvalid') }, lang));
  if (!email || !pin) {
    invalid();
    return;
  }

  const result = await findStaffByPin(email, pin);
  if (!result) {
    invalid();
    return;
  }

  const session = await createStaffSession(result.staff.id, result.merchant.id);
  setStaffSessionCookie(res, session);
  res.writeHead(303, { Location: '/stamp' });
  res.end();
}

/** POST /stamp/signout — the staff-session counterpart to POST /signout, on its own path so it can never be reached without a staff cookie doing anything meaningful (and so it never needs a merchant session, which a staff-only browser doesn't have). */
async function handleStaffSignOut(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const id = staffSessionIdFromRequest(req);
  if (id) await deleteStaffSession(id);
  clearStaffSessionCookie(res);
  res.writeHead(303, { Location: '/stamp' });
  res.end();
}

// ---------------------------------------------------------------------------
// Short-link code parsing — Card.linkCode is an Int, so a valid code is
// digits only. Anything else (favicon.ico, robots.txt, ...) is just "no
// such card", not a crash.
// ---------------------------------------------------------------------------
function parseLinkCode(code: string): number | undefined {
  if (!/^\d+$/.test(code)) return undefined;
  return Number.parseInt(code, 10);
}

// ---------------------------------------------------------------------------
// Route: GET /:code — the customer enrol page. BUILD.md §8.16: the
// highest-value page in the product. Full-bleed in the merchant's own card
// colours (not ours — that is the point), the reward as the headline, two
// supporting lines, an empty-card strip preview, a consent checkbox and
// *both* wallet buttons (BUILD.md §8.16 point 6 — "platform-detected"). One
// consent checkbox and one set of optional name/phone fields serve both
// buttons: each is a `type="submit"` with its own `formaction`, so the same
// `<form>` posts to whichever wallet route the customer actually tapped —
// the checkbox's `required` attribute still blocks either submission until
// it's ticked, no JavaScript needed for that part. The one bit of
// JavaScript on this page is a tiny inline `navigator.userAgent` sniff that
// only *reorders* the two buttons (Android sees Google Wallet listed first,
// everything else sees Apple Wallet first) — detection is a hint, never a
// gate: both buttons are always rendered, always enabled, and work
// regardless of what the sniff guessed, so a customer on a desktop browser
// or one it can't classify can still pick either wallet.
// ---------------------------------------------------------------------------
function renderEnrolPage(card: Card): string {
  // filled: 0 — the enrol page always shows an empty card, not the pass's starter stamps.
  const stripQs = stripPreviewParams(card, 0, 2);
  const fg = card.fgColor || '#FFFFFF';
  // Minted fresh on every render of this page, carried as a hidden field on
  // the enrol form below — server.ts's readEnrolFields()/enrol.ts's
  // createPassForEnrolment() use it to collapse a same-page-load double
  // submit (back-button resubmit, or tapping both wallet buttons) into one
  // Pass row when no phone number was supplied. See enrol.ts's doc comment
  // for why this is deliberately short-lived and in-memory only, not a
  // database column.
  const idempotencyKey = crypto.randomBytes(16).toString('base64url');
  // BUILD.md §8.16 calls this "the highest-value page" and §13 requires the
  // whole platform to follow the card's own language — this page used to
  // hardcode `lang="en"` and every string in it regardless of card.lang, so
  // an Arabic card's own customers landed on an English enrol page. Same
  // `=== 'en' ? 'en' : 'ar'` coercion resolveLang()/passContent.ts use.
  const lang: Lang = card.lang === 'en' ? 'en' : 'ar';
  const dir = lang === 'ar' ? 'rtl' : 'ltr';

  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(card.name)} · ${escapeHtml(t(lang, 'enrolPageTitleSuffix'))}</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body {
    background: ${card.bgColor};
    color: ${fg};
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  main { max-width: 420px; margin: 0 auto; padding: 40px 20px 48px; text-align: center; }
  h1 { font-size: 28px; line-height: 1.25; margin: 0 0 16px; }
  p.lede { font-size: 16px; line-height: 1.5; margin: 0 0 4px; opacity: 0.92; }
  .strip { margin: 24px 0; border-radius: 14px; overflow: hidden; background: rgba(255,255,255,0.08); padding: 10px; }
  .strip img { display: block; width: 100%; height: auto; }
  form { text-align: start; margin-top: 20px; }
  .field { margin-bottom: 14px; }
  label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
  label .opt { font-weight: 400; opacity: 0.7; }
  input[type="text"], input[type="tel"] {
    width: 100%;
    border: 1px solid rgba(255,255,255,0.35);
    border-radius: 10px;
    padding: 12px 14px;
    font-size: 16px;
    background: rgba(255,255,255,0.08);
    color: inherit;
  }
  input::placeholder { color: inherit; opacity: 0.55; }
  .consent { display: flex; align-items: flex-start; gap: 10px; margin: 18px 0 22px; font-size: 13px; line-height: 1.5; opacity: 0.92; }
  .consent input { margin-top: 3px; }
  .wallet-buttons { display: flex; flex-direction: column; gap: 12px; }
  button.cta {
    display: block;
    width: 100%;
    border: none;
    border-radius: 100px;
    padding: 16px 20px;
    font-size: 17px;
    font-weight: 700;
    cursor: pointer;
  }
  button.cta:active { opacity: 0.9; }
  button.cta.apple { order: 1; color: #fff; background: ${card.stampActive}; }
  button.cta.google { order: 2; color: inherit; background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.4); }
  /* Set by the platform-detection script below — reorders, never hides: both buttons stay rendered and clickable either way. */
  body.platform-android button.cta.apple { order: 2; }
  body.platform-android button.cta.google { order: 1; }
  .powered { margin-top: 28px; font-size: 12px; opacity: 0.6; }
  .enrol-logo { max-width: 220px; max-height: 72px; margin: 0 auto 20px; display: block; }
</style>
</head>
<body>
<main>
  ${card.logoUrl ? `<img class="enrol-logo" src="${escapeHtml(card.logoUrl)}" alt="${escapeHtml(card.name)}">` : ''}
  <h1>${escapeHtml(card.rewardText)}</h1>
  <p class="lede">${escapeHtml(t(lang, 'enrolShowPage', { name: card.name }))}</p>
  <p class="lede">${escapeHtml(t(lang, 'printStep4', { goal: arabicDigits(card.stampsGoal, lang) }))}</p>
  <div class="strip">
    <img src="/preview.png?${stripQs.toString()}" alt="${escapeHtml(t(lang, 'enrolStripAlt', { name: card.name }))}" width="375" height="144">
  </div>
  <form method="POST" action="/${card.linkCode}/pass">
    <input type="hidden" name="idem" value="${escapeHtml(idempotencyKey)}">
    <div class="field">
      <label for="name">${escapeHtml(t(lang, 'enrolNameLabel'))} <span class="opt">(${escapeHtml(t(lang, 'enrolOptional'))})</span></label>
      <input type="text" id="name" name="name" maxlength="80" autocomplete="name" placeholder="${escapeHtml(t(lang, 'enrolNamePlaceholder'))}">
    </div>
    <div class="field">
      <label for="phone">${escapeHtml(t(lang, 'enrolPhoneLabel'))} <span class="opt">(${escapeHtml(t(lang, 'enrolOptional'))})</span></label>
      <input type="tel" id="phone" name="phone" maxlength="30" autocomplete="tel" placeholder="${escapeHtml(t(lang, 'enrolPhonePlaceholder'))}">
    </div>
    <label class="consent">
      <input type="checkbox" name="consent" required>
      <span>${escapeHtml(t(lang, 'enrolConsent', { name: card.name }))}</span>
    </label>
    <div class="wallet-buttons">
      <button class="cta apple" type="submit" formaction="/${card.linkCode}/pass">${escapeHtml(t(lang, 'walletAddApple'))}</button>
      <button class="cta google" type="submit" formaction="/${card.linkCode}/google-pass">${escapeHtml(t(lang, 'walletAddGoogle'))}</button>
    </div>
  </form>
  <p class="powered">${escapeHtml(t(lang, 'poweredByLoyaNexa'))}</p>
</main>
<script>
  // Platform detection is a hint only — see the block comment above this
  // function's definition in server.ts. This never disables or removes
  // either button, it only reorders them via the CSS 'order' rules above.
  if (/Android/i.test(navigator.userAgent)) {
    document.body.classList.add('platform-android');
  }
</script>
</body>
</html>`;
}

async function handleEnrolPage(res: http.ServerResponse, code: string): Promise<void> {
  const linkCode = parseLinkCode(code);
  if (linkCode === undefined) {
    sendEnrolNotFound(res, code);
    return;
  }
  const card = await prisma.card.findUnique({ where: { linkCode } });
  if (!card) {
    sendEnrolNotFound(res, code);
    return;
  }
  sendHtml(res, 200, renderEnrolPage(card));
}

// ---------------------------------------------------------------------------
// Shared pass content/image building — used both by POST /:code/pass
// (issuing a brand-new pass) and by the PassKit "get latest pass" web
// service endpoint (rebuilding an existing one after a stamp). One
// implementation so the two can never drift apart.
// ---------------------------------------------------------------------------

/** Loads a stored upload as an `ImageRef` (strip.ts's own image input shape), or undefined for a missing/invalid hash. Shared by the strip renderer (preview + issuance + rebuild) and the pass-header logo below — one read path so a bad hash degrades to "no image" everywhere, never a 500. */
async function loadImageRef(hash: string | null | undefined): Promise<ImageRef | undefined> {
  if (!isValidHash(hash)) return undefined;
  const row = await prisma.cardImage.findUnique({ where: { hash } });
  if (!row) return undefined;
  return { ...decodePNG(row.bytes), hash };
}

/**
 * The strip spec for `card` at `filled` stamps — the one place that turns a
 * Card row's design fields (shape, colours, opacity, and its logo/cover
 * hashes) into a `StripSpec`, so `POST /:code/pass`, the PassKit
 * "get latest pass" rebuild, and nothing else drift out of sync on what a
 * customer's actual pass looks like. `GET /preview.png` deliberately does
 * *not* go through this — it renders whatever the designer's controls say
 * right now, including a card that hasn't been saved yet.
 */
async function stripSpecForCard(card: Card, filled: number): Promise<Omit<StripSpec, 'scale'>> {
  const stampSource = parseStampSource(card.stampSource, 'plain');
  const [icon, cover] = await Promise.all([
    stampSource === 'icon' ? loadImageRef(card.iconHash) : Promise.resolve(undefined),
    loadImageRef(card.coverHash),
  ]);
  return {
    goal: card.stampsGoal,
    filled,
    shape: card.stampShape === 'square' ? 'square' : 'circle',
    bgColor: card.bgColor,
    bgOpacity: card.bgOpacity,
    activeColor: card.stampActive,
    inactiveColor: card.stampInactive,
    stampSource,
    icon,
    iconFit: card.iconFit === 'cover' ? 'cover' : 'contain',
    builtinIcon: isBuiltinIconId(card.builtinIcon) ? card.builtinIcon : undefined,
    cover,
  };
}

async function buildPassImagesFor(
  card: Card,
  stripSet: Pick<PassImages, 'strip.png' | 'strip@2x.png' | 'strip@3x.png'>
): Promise<PassImages> {
  const images: PassImages = {
    'icon.png': makeCardIcon(29, card.bgColor, card.stampActive),
    'icon@2x.png': makeCardIcon(58, card.bgColor, card.stampActive),
    'strip.png': stripSet['strip.png'],
    'strip@2x.png': stripSet['strip@2x.png'],
    'strip@3x.png': stripSet['strip@3x.png'],
  };
  // The merchant's logo in the pass *header* (BUILD.md §8.9, §9), entirely
  // independent of the stamp source (BUILD.md's design fix: the logo is
  // never the stamp any more) — a merchant's wordmark belongs up top
  // regardless of whether their stamps use a built-in icon, their own
  // icon, or a plain disc. Reuses the single normalised upload (in its own
  // aspect ratio, capped to LOGO_MAX_DIMENSION on its longer side — see
  // cardImages.ts) for both logo.png and logo@2x.png rather than
  // generating a distinct 1x/2x pair: Apple scales it to fit the header
  // regardless, and this avoids a second on-the-fly resize on every pass
  // build for a cosmetic sizing gain.
  if (card.logoHash) {
    const row = await prisma.cardImage.findUnique({ where: { hash: card.logoHash } });
    if (row) {
      const bytes = Buffer.from(row.bytes);
      images['logo.png'] = bytes;
      images['logo@2x.png'] = bytes;
    }
  }
  return images;
}

/** Reads and clamps the optional `name`/`phone`/idempotency-token enrolment fields from a POST body — shared by both wallet issuance routes below. A malformed/oversized body must not block enrolment, so any read failure just falls back to "none supplied" rather than a 4xx. */
async function readEnrolFields(
  req: http.IncomingMessage
): Promise<{ custName: string; custPhone: string; idempotencyKey: string }> {
  let fields: querystring.ParsedUrlQuery = {};
  try {
    fields = await readUrlencodedBody(req);
  } catch {
    fields = {};
  }
  return {
    custName: String(fields.name ?? '').trim().slice(0, 80),
    custPhone: String(fields.phone ?? '').trim().slice(0, 30),
    idempotencyKey: String(fields.idem ?? '').trim().slice(0, 64),
  };
}

// ---------------------------------------------------------------------------
// Rate limiting POST /:code/pass and POST /:code/google-pass — both are
// public, unauthenticated and expensive (see rateLimit.ts's own doc
// comment). One shared limiter for both routes, keyed by client IP: 10
// issuances per IP per 10 minutes is generous for a real customer (nobody
// legitimately enrols in the same card ten times in ten minutes) and cheap
// insurance against a script.
// ---------------------------------------------------------------------------
const passIssuanceLimiter = new RateLimiter({ limit: 10, windowMs: 10 * 60 * 1000 });

/** true when `req` is still within the pass-issuance rate limit (and counts this call toward it either way). */
function checkPassIssuanceRateLimit(req: http.IncomingMessage): boolean {
  const ip = resolveClientIp(req.headers, req.socket.remoteAddress);
  return passIssuanceLimiter.check(ip);
}

function sendRateLimited(res: http.ServerResponse, lang: Lang): void {
  sendHtml(res, 429, layout('Too many requests', `<div class="panel"><h1>429</h1><p>${escapeHtml(t(lang, 'rateLimited'))}</p></div>`, undefined, lang));
}

// ---------------------------------------------------------------------------
// Route: POST /:code/pass — issue a real, signed .pkpass for this card and
// hand it back with the exact MIME type iOS uses to decide whether to offer
// it to Wallet. Carries `webServiceURL`/`authenticationToken` only when
// `PUBLIC_BASE_URL` is set (BUILD.md §9.3: `webServiceURL` must be HTTPS or
// Apple fails silently) — see buildPassContentFor() above.
// ---------------------------------------------------------------------------
async function handleIssuePass(req: http.IncomingMessage, res: http.ServerResponse, code: string): Promise<void> {
  const linkCode = parseLinkCode(code);
  if (linkCode === undefined) {
    sendEnrolNotFound(res, code);
    return;
  }
  const card = await prisma.card.findUnique({ where: { linkCode } });
  if (!card) {
    sendEnrolNotFound(res, code);
    return;
  }

  if (!checkPassIssuanceRateLimit(req)) {
    sendRateLimited(res, resolveLang(req));
    return;
  }

  const { custName, custPhone, idempotencyKey } = await readEnrolFields(req);
  const credentials = resolveAppleCredentials();

  const stripSet = await renderAllDensities(PASS_STRIP_STORE, await stripSpecForCard(card, card.starterStamps));
  const images = await buildPassImagesFor(card, stripSet);

  const { pass, created } = await createPassForEnrolment(card, custName, custPhone, idempotencyKey);

  // If signing/building fails below, a freshly-inserted Pass row must not
  // survive it — an orphan row with no corresponding wallet pass would show
  // up on the dashboard as a phantom customer who never actually enrolled
  // (a reused row from an earlier, successful enrolment is never deleted —
  // see EnrolmentResult's doc comment in enrol.ts).
  let pkpass: Buffer;
  try {
    const content = buildPassContentFor(card, pass, { publicBaseUrl: PUBLIC_BASE_URL });
    pkpass = buildPass(credentials, content, images);
  } catch (err) {
    if (created) await deleteOrphanedPass(pass.id);
    throw err;
  }

  await prisma.stampEvent.create({
    data: {
      merchantId: card.merchantId,
      cardId: card.id,
      serial: pass.serial,
      kind: 'ENROLL',
    },
  });
  await enqueueWelcomeBroadcast(card, pass, created);

  res.writeHead(200, {
    'Content-Type': 'application/vnd.apple.pkpass',
    'Content-Length': pkpass.length,
    'Content-Disposition': `attachment; filename="${passFilenameStem(card.name)}.pkpass"`,
    'Cache-Control': 'no-store',
  });
  res.end(pkpass);
}

/**
 * The welcome automation (BUILD.md §8.12's "Automated" tab, built end to
 * end here — unlike birthday/win-back, which the Notifications page shows
 * clearly marked "not yet scheduled" rather than pretending to work).
 * Fires once per genuine new enrolment (`created`, from
 * createPassForEnrolment's EnrolmentResult) — never on a reused Pass, or a
 * returning customer re-scanning the same QR would get "welcomed" again
 * every time. Goes through the exact same queue a manual Send uses
 * (apps/demo/broadcast.ts's enqueueBroadcast(), `kind: 'welcome'`) instead
 * of pushing inline: enqueueBroadcast() only ever inserts rows, so calling
 * it from inside this request handler cannot be the "fan out APNs inside
 * a request handler" mistake BUILD.md §18 item 6 warns about — the actual
 * push happens later, entirely on broadcastWorker's own schedule.
 *
 * Passes `onlySerial: pass.serial` down to enqueueBroadcast() so the
 * welcome job's recipient snapshot is this one newly-enrolled Pass only —
 * without it, enqueueBroadcast's default "every Pass this card has right
 * now" snapshot would welcome-broadcast to every *existing* customer of
 * the card too, each time anyone new enrols.
 */
async function enqueueWelcomeBroadcast(card: Card, pass: Pass, created: boolean): Promise<void> {
  if (!created) return;
  const lang: Lang = card.lang === 'en' ? 'en' : 'ar';
  try {
    await enqueueBroadcast(card, t(lang, 'notifWelcomeMessage'), 'welcome', { onlySerial: pass.serial });
  } catch (err) {
    // The customer's pass has already been created by the time this runs
    // — never let a welcome-automation hiccup fail (or even flag) a real
    // enrolment.
    console.error(`[broadcast] welcome enqueue failed for card ${card.id}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Route: POST /:code/google-pass — the Google Wallet counterpart to
// POST /:code/pass above. BUILD.md §9.5: there is no file to hand back —
// creates the Pass row exactly like the Apple route, makes sure this card's
// LoyaltyClass exists (ensureLoyaltyClass is idempotent: create the first
// time, patch every time after), then 302s the browser straight to the
// signed `https://pay.google.com/gp/v/save/<jwt>` link, which is the entire
// "add to wallet" action for Google — the JWT itself carries the
// LoyaltyObject, so nothing else needs to happen server-side before the
// redirect.
// ---------------------------------------------------------------------------
async function handleIssueGooglePass(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  code: string
): Promise<void> {
  const linkCode = parseLinkCode(code);
  if (linkCode === undefined) {
    sendEnrolNotFound(res, code);
    return;
  }
  const card = await prisma.card.findUnique({ where: { linkCode } });
  if (!card) {
    sendEnrolNotFound(res, code);
    return;
  }

  if (!checkPassIssuanceRateLimit(req)) {
    sendRateLimited(res, resolveLang(req));
    return;
  }

  const client = getGoogleWalletClient();
  if (!client) {
    // getGoogleWalletClient() already logged the underlying reason once.
    // Google Wallet is genuinely unavailable here — degrade to a clear,
    // customer-facing message rather than a bare 500, since Apple Wallet
    // (the other button on this same page) still works.
    sendHtml(
      res,
      503,
      layout(
        'Google Wallet unavailable',
        '<div class="panel"><h1>503</h1><p>Google Wallet isn\'t available on this server right now. Please use the "Add to Apple Wallet" button instead, or try again later.</p></div>'
      )
    );
    return;
  }

  const { custName, custPhone, idempotencyKey } = await readEnrolFields(req);
  const { pass, created } = await createPassForEnrolment(card, custName, custPhone, idempotencyKey);

  // Same reasoning as POST /:code/pass just above: a freshly-inserted row
  // must not survive a failure in the steps that make it actually usable —
  // a reused row (created: false) is left alone either way.
  let saveLink: string;
  try {
    await client.ensureLoyaltyClass({ id: card.id, name: card.name, bgColor: card.bgColor });
    // accountName/balance are customer-facing text inside the actual saved
    // Google Wallet card (BUILD.md §13) — localize to the card's own
    // language here, same as buildPassContentFor() does for Apple Wallet.
    // packages/pass deliberately has no i18n dependency of its own, so
    // these come in pre-localized via saveLink()'s opts (see its doc
    // comment in packages/pass/src/googleWallet.ts).
    const enrolLang: Lang = card.lang === 'en' ? 'en' : 'ar';
    saveLink = client.saveLink(
      { serial: pass.serial, stamps: pass.stamps, custName: pass.custName || undefined },
      { id: card.id, stampsGoal: card.stampsGoal },
      {
        accountNameFallback: t(enrolLang, 'walletAccountNameFallback'),
        balanceText: `${arabicDigits(pass.stamps, enrolLang)} / ${arabicDigits(card.stampsGoal, enrolLang)}`,
      }
    );
  } catch (err) {
    if (created) await deleteOrphanedPass(pass.id);
    throw err;
  }

  await prisma.stampEvent.create({
    data: {
      merchantId: card.merchantId,
      cardId: card.id,
      serial: pass.serial,
      kind: 'ENROLL',
    },
  });
  await enqueueWelcomeBroadcast(card, pass, created);

  res.writeHead(302, { Location: saveLink });
  res.end();
}

// ---------------------------------------------------------------------------
// Route: GET /img/:hash — the content-addressed image store (BUILD.md §18
// item 2 / docs/DEPLOY.md's "known consideration"). `hash` is the sha256 of
// the normalised bytes (cardImages.ts), so a hash can never point at
// different bytes over time — the immutable, year-long cache below is safe
// precisely because of that, not just a performance nicety.
// ---------------------------------------------------------------------------
async function handleGetImage(res: http.ServerResponse, hash: string): Promise<void> {
  const row = await prisma.cardImage.findUnique({ where: { hash } });
  if (!row) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': row.mime,
    'Content-Length': row.bytes.length,
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  res.end(Buffer.from(row.bytes));
}

// ---------------------------------------------------------------------------
// Route: POST /cards/:id/image — the card designer's logo/icon/cover upload
// (BUILD.md §8.5 step 1 / §8.9 step 2). multipart/form-data with exactly
// one file part, named "logo", "icon" or "cover" — that name is what
// decides which Card column gets updated, there is no separate "kind"
// field to trust or distrust. Guarded by requireMerchant() at the router
// and scoped to the calling merchant's own card (findOwnedCard) below, so
// every step past that is a hard reject, never a best-effort clamp: the
// Content-Length precheck rejects an oversized body before
// reading any of it, readMultipart() enforces the same cap while streaming
// (covering a missing/wrong Content-Length), and normalizeUpload() rejects
// anything that isn't a decodable image within the documented size/pixel
// limits. Responds JSON — this is called from the designer's own fetch(),
// never rendered as a full page.
// ---------------------------------------------------------------------------
async function handleUploadCardImage(req: http.IncomingMessage, res: http.ServerResponse, id: string, merchant: Merchant): Promise<void> {
  const card = await findOwnedCard(id, merchant.id);
  if (!card) {
    sendJson(res, 404, { ok: false, error: 'card not found' });
    return;
  }

  // No Content-Length precheck here on purpose — see readMultipart's/
  // readBodyCapped's own doc comments in multipart.ts. A precheck that
  // responds and closes before the body has actually finished arriving
  // reliably breaks a real fetch()-based client's own write with
  // ECONNRESET (reproduced against the exact API this page's upload JS
  // uses); readMultipart already drains the body (discarding, never
  // buffering, past MAX_UPLOAD_REQUEST_BYTES) and only rejects once the
  // request has fully ended, which is what makes it safe to respond here.
  let parsed: Awaited<ReturnType<typeof readMultipart>>;
  try {
    parsed = await readMultipart(req, req.headers['content-type'], MAX_UPLOAD_REQUEST_BYTES);
  } catch (err) {
    const status = isHttpError(err) ? err.statusCode : 400;
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, status, { ok: false, error: message });
    return;
  }

  const file = parsed.files.find((f) => f.name === 'logo' || f.name === 'icon' || f.name === 'cover');
  if (!file) {
    sendJson(res, 400, { ok: false, error: 'expected a file field named "logo", "icon" or "cover"' });
    return;
  }
  const kind = file.name as UploadKind;

  // The Content-Length precheck and readMultipart()'s own streaming cap
  // above both bound the *request*, which has some multipart boundary/header
  // slack over the 2 MB file limit (MAX_UPLOAD_REQUEST_BYTES) — so a file
  // part that is itself over 2 MB can still make it through parsing. Reject
  // that specific case as 413 here, same status as the request-level cap;
  // normalizeUpload()'s own size check below is an inner backstop that
  // should now be unreachable, not a second source of truth for the status
  // code.
  if (file.data.length > MAX_UPLOAD_BYTES) {
    sendJson(res, 413, { ok: false, error: `image is ${file.data.length} bytes, over the ${MAX_UPLOAD_BYTES}-byte (2 MB) limit` });
    return;
  }

  const result = normalizeUpload(kind, file.data);
  if (!result.ok) {
    sendJson(res, 400, { ok: false, error: result.error });
    return;
  }

  await storeCardImage(result);

  // Aesthetic fields (cardEdit.ts's AESTHETIC_FIELDS) are never subject to
  // the lock rule — going through updateCard() here anyway keeps this the
  // one code path that writes a Card's image columns, rather than a second
  // ad hoc `prisma.card.update` that could drift from it.
  const patch: CardEditInput =
    kind === 'logo'
      ? { logoHash: result.hash, logoUrl: imageUrl(result.hash) }
      : kind === 'icon'
        ? { iconHash: result.hash, iconUrl: imageUrl(result.hash) }
        : { coverHash: result.hash, coverUrl: imageUrl(result.hash) };
  const updateResult = await updateCard(id, merchant.id, patch);
  if (!updateResult.ok) {
    // Only reachable if the card was deleted between the lookup above and
    // here — aesthetic fields can't produce a 'locked' result.
    sendJson(res, 404, { ok: false, error: 'card not found' });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    kind,
    hash: result.hash,
    url: imageUrl(result.hash),
    width: result.width,
    height: result.height,
    // Meaningful for kind === 'logo' or 'icon' (always false for a cover) —
    // the designer's upload JS uses this to show the wide-wordmark hint
    // (logo) or the non-square Fit/Fill reminder (icon) right after
    // upload, without a second round trip (BUILD.md §8.5's
    // transparent-logo-detection hint follows the same "inform, don't
    // block" pattern).
    wideLogo: result.wideLogo,
  });
}

function clampFloat01(raw: unknown, fallback: number): number {
  const n = Number.parseFloat(String(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

// ---------------------------------------------------------------------------
// Route: GET /preview.png — on-the-fly strip render, the exact same
// renderer every other strip (issuance, PassKit rebuild) goes through.
// Every input clamped or substituted with a safe default before it reaches
// renderStrip. This is the designer's live preview target (BUILD.md §8.5 /
// §8.9): `icon=<hash>`/`cover=<hash>` let it show the merchant's own
// uploads mid-edit, before a card is even saved — so unlike
// stripSpecForCard() above (which reads a persisted Card row) this reads
// straight off the query string.
//
// `fit` (contain|cover) is the icon Fit/Fill choice — this is the exact
// query parameter a prior bug report found silently ignored end to end
// (`fit=contain` and `fit=cover` rendered byte-identical): the stamp-source
// three-way switch below is what actually threads it through to
// renderStrip's `iconFit`, only when `stampSource === 'icon'`.
// ---------------------------------------------------------------------------
async function handlePreviewPng(res: http.ServerResponse, query: URLSearchParams): Promise<void> {
  const goal = clampInt(query.get('goal'), MIN_GOAL, MAX_GOAL, 8);
  const filled = clampInt(query.get('filled'), 0, goal, defaultFilled(goal));
  const bg = validHex(query.get('bg'), '#203757');
  const active = validHex(query.get('active'), '#F96400');
  const inactive = validHex(query.get('inactive'), '#8794A5');
  const scaleRaw = Number.parseInt(String(query.get('scale') ?? '1'), 10);
  const scale: 1 | 2 | 3 = scaleRaw === 2 || scaleRaw === 3 ? scaleRaw : 1;
  const opacity = clampFloat01(query.get('opacity'), 1);
  const shape: 'circle' | 'square' = query.get('shape') === 'square' ? 'square' : 'circle';
  const stampSource = parseStampSource(query.get('stampSource'), 'plain');
  const iconFit: Fit = query.get('fit') === 'cover' ? 'cover' : 'contain';
  const builtinIconRaw = query.get('builtinIcon');
  const builtinIcon: BuiltinIconId | undefined = isBuiltinIconId(builtinIconRaw) ? builtinIconRaw : undefined;

  const [icon, cover] = await Promise.all([
    stampSource === 'icon' ? loadImageRef(query.get('icon')) : Promise.resolve(undefined),
    loadImageRef(query.get('cover')),
  ]);

  const png = renderStrip({
    goal,
    filled,
    shape,
    bgColor: bg,
    bgOpacity: opacity,
    activeColor: active,
    inactiveColor: inactive,
    stampSource,
    icon,
    iconFit,
    builtinIcon,
    cover,
    scale,
  });
  sendPng(res, png);
}

// ---------------------------------------------------------------------------
// Route: GET /icon-swatch.png — on-the-fly render of one built-in icon
// (BUILD.md §8.5 step 2's icon picker). Drawn directly by
// packages/image/src/raster/icons.ts, never a shipped image file — the
// designer's picker points each swatch's <img> at this, same "render
// endpoint, never a second renderer" discipline as /preview.png.
// ---------------------------------------------------------------------------
function handleIconSwatchPng(res: http.ServerResponse, query: URLSearchParams): void {
  const idRaw = query.get('id');
  if (!isBuiltinIconId(idRaw)) {
    sendHtml(res, 400, layout('Error', '<div class="panel"><h1>400</h1><p>Unknown icon id.</p></div>'));
    return;
  }
  const size = clampInt(query.get('size'), 8, 512, 64);
  const color = validHex(query.get('color'), '#33415C');
  const png = renderIconSwatch(idRaw, size, parseHexColor(color, 1));
  sendPng(res, png);
}

// ---------------------------------------------------------------------------
// Route: GET /qr.png — on-the-fly QR render
// ---------------------------------------------------------------------------
function handleQrPng(res: http.ServerResponse, query: URLSearchParams): void {
  const data = query.get('data');
  if (!data || !data.trim()) {
    sendHtml(res, 400, layout('Error', '<div class="panel"><h1>400</h1><p>Missing "data" query parameter.</p></div>'));
    return;
  }
  // Optional `size` (module size in px, default 6 — same default renderQrPng
  // itself uses). The print sheet (GET /cards/:id/print) asks for a larger
  // module so the code stays crisp once CSS stretches it to 45mm on paper.
  const moduleSize = clampInt(query.get('size'), 1, 20, 6);
  let png: Buffer;
  try {
    png = renderQrPng(data.trim(), moduleSize);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendHtml(res, 400, layout('Error', `<div class="panel"><h1>400</h1><p>${escapeHtml(message)}</p></div>`));
    return;
  }
  sendPng(res, png);
}

// ---------------------------------------------------------------------------
// Route: GET /stamp — the merchant stamp screen (BUILD.md §8.15). Our
// replacement for the competitor's scanner app: a browser page, opened on
// whatever phone or tablet is at the counter, that scans the QR *inside a
// customer's wallet pass* (the "Card QR" in BUILD.md §7.3's table — it
// encodes the pass `serial`, never the printed, static "Join QR" that the
// card detail page shows). Decodes real camera frames with jsQR (vendored
// same-origin at /jsQR.js — see scripts/vendor-jsqr.ts), with
// `BarcodeDetector` as an opt-in fast path only where the browser actually
// has it (§8.15's own warning: it's absent on iOS/iPadOS, every Firefox,
// and Chrome on Windows/Linux — never rely on it alone). Manual entry
// (serial or shortCode) works fully independently of the camera path, and
// both converge on the same POST /api/stamp write below. Dark brand tokens
// per BUILD.md §3 (2026-08-03 revision):
// canvas #0F172A, paper #1C2A42, accent #F28C38, Alexandria typeface.
// ---------------------------------------------------------------------------
/** Who is viewing the stamp screen — mirrors StampAuth above, minus the full Merchant/Staff rows (renderStampScreen only ever needs a name to display). */
type StampScreenViewer = { kind: 'merchant' } | { kind: 'staff'; staffName: string };

/**
 * The header a *staff* session sees on the stamp screen — deliberately not
 * navBar(): every link navBar renders (Cards, Customers, Reports, Settings)
 * 302s a staff session straight to /signin (requireMerchant() never
 * recognises the `lnx-staff` cookie), so showing them here would just be a
 * row of dead ends. Brand plus a sign-out button is everything a staff
 * session can actually do besides stamp.
 */
function staffHeader(lang: Lang): string {
  return `<header class="top">
  <a class="brand" href="/stamp">LoyaNexa</a>
  <form method="POST" action="/stamp/signout" style="margin-inline-start:auto;">
    <button type="submit" class="btn secondary small">${escapeHtml(t(lang, 'stampScreenStaffSignOut'))}</button>
  </form>
</header>`;
}

function renderStampScreen(lang: Lang = 'en', viewer: StampScreenViewer = { kind: 'merchant' }): string {
  return `<!doctype html>
<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(t(lang, 'stampScreenTitle'))} · LoyaNexa</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Alexandria:wght@400;600;700;800&display=swap">
<style>
  :root {
    --canvas: #0F172A;
    --paper: #1C2A42;
    --raise: #22314C;
    --accent: #F28C38;
    --accent-hover: #E67E22;
    --on-accent: #0F172A;
    --ink: #FFFFFF;
    --ink-2: #CBD5E1;
    --ink-3: #94A3B8;
    --line: rgba(255,255,255,.10);
    --green: #22C55E;
    --red: #EF4444;
    --amber: #F7B267;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body {
    background: var(--canvas);
    color: var(--ink);
    font-family: 'Alexandria', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
  }
  header.top {
    display: flex; align-items: center; gap: 28px;
    padding: 14px 20px; border-bottom: 1px solid var(--line); background: var(--sunk);
  }
  header.top a.brand { color: var(--ink); text-decoration: none; font-weight: 800; font-size: 17px; }
  header.top nav.nav { display: flex; gap: 4px; flex-wrap: wrap; margin-inline-start: auto; }
  header.top nav.nav a {
    color: var(--ink-2); text-decoration: none; font-weight: 600; font-size: 14px;
    padding: 8px 14px; border-radius: 100px;
  }
  header.top nav.nav a:hover { color: var(--ink); background: var(--raise); }
  header.top nav.nav a.active { color: var(--on-accent); background: var(--accent); }
  main { max-width: 480px; margin: 0 auto; padding: 20px 20px 56px; }
  h1 { font-size: 22px; margin: 4px 0 6px; }
  p.sub { color: var(--ink-3); font-size: 14px; margin: 0 0 18px; line-height: 1.5; }
  .notice {
    background: rgba(242,140,56,.10); border: 1px solid rgba(242,140,56,.28); color: var(--accent);
    border-radius: 14px; padding: 12px 16px; margin-bottom: 18px; font-size: 13px; line-height: 1.5;
  }
  .panel { background: var(--paper); border: 1px solid var(--line); border-radius: 18px; padding: 20px; margin-bottom: 18px; }
  h2 { font-size: 13px; margin: 0 0 12px; color: var(--ink-2); text-transform: uppercase; letter-spacing: .06em; }
  .camera-wrap { position: relative; border-radius: 14px; overflow: hidden; background: #000; aspect-ratio: 4 / 3; }
  video { width: 100%; height: 100%; object-fit: cover; display: block; }
  .camera-status { margin-top: 10px; font-size: 13px; color: var(--ink-3); text-align: center; min-height: 18px; }
  form.manual .field { margin-bottom: 14px; }
  label { display: block; font-weight: 600; font-size: 13px; margin-bottom: 6px; color: var(--ink-2); }
  input[type="text"] {
    width: 100%; border: 1px solid var(--line); border-radius: 12px; padding: 16px;
    font-size: 18px; background: var(--raise); color: var(--ink); font-family: inherit;
    text-transform: uppercase;
  }
  input[type="text"]::placeholder { color: var(--ink-3); text-transform: none; }
  button.stamp-btn {
    display: block; width: 100%; border: none; border-radius: 100px; padding: 18px 20px;
    font-size: 17px; font-weight: 700; color: var(--on-accent); background: var(--accent);
    cursor: pointer; min-height: 56px; font-family: inherit;
  }
  button.stamp-btn:active { background: var(--accent-hover); }
  button.stamp-btn:disabled { opacity: .6; cursor: default; }
  #result {
    display: none; border-radius: 14px; padding: 18px; margin-bottom: 18px;
    font-size: 18px; font-weight: 700; text-align: center; line-height: 1.4;
  }
  #result.success { display: block; background: rgba(34,197,94,.14); border: 1px solid rgba(34,197,94,.4); color: var(--green); }
  #result.error { display: block; background: rgba(239,68,68,.14); border: 1px solid rgba(247,178,103,.4); color: var(--amber); }
</style>
</head>
<body>
${viewer.kind === 'staff' ? staffHeader(lang) : navBar('stamp', lang)}
<main>
  <h1>${escapeHtml(t(lang, 'stampScreenTitle'))}</h1>
  <p class="sub">${escapeHtml(t(lang, 'stampScreenSub'))}</p>
  <div class="notice">${escapeHtml(
    viewer.kind === 'staff'
      ? t(lang, 'stampScreenStaffBadge', { name: viewer.staffName })
      : t(lang, 'stampScreenNoticeMerchant')
  )}</div>

  <div id="result" role="status" aria-live="polite"></div>

  <div class="panel">
    <h2>${escapeHtml(t(lang, 'stampScreenCameraHeading'))}</h2>
    <div class="camera-wrap">
      <video id="video" playsinline muted></video>
    </div>
    <p class="camera-status" id="cameraStatus">${escapeHtml(t(lang, 'stampScreenCameraStarting'))}</p>
  </div>

  <div class="panel">
    <h2>${escapeHtml(t(lang, 'stampScreenManualHeading'))}</h2>
    <form class="manual" id="manualForm">
      <div class="field">
        <label for="manualCode">${escapeHtml(t(lang, 'stampScreenManualLabel'))}</label>
        <input type="text" id="manualCode" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="${escapeHtml(t(lang, 'stampScreenManualPlaceholder'))}" required>
      </div>
      <button class="stamp-btn" type="submit" id="manualSubmit">${escapeHtml(t(lang, 'stampScreenSubmitButton'))}</button>
    </form>
  </div>
</main>
<canvas id="canvas" style="display:none;"></canvas>
<script src="/jsQR.js"></script>
<script>
(function () {
  'use strict';

  // Translated server-side (this whole page is rendered once per request
  // via resolveLang(req)) rather than in the client, same as every other
  // string on this screen — the two messages the fetch() below can show
  // when the server didn't hand back its own translated message.
  var MSG_UNKNOWN_ERROR = ${JSON.stringify(t(lang, 'serverError'))};
  var MSG_NETWORK_ERROR = ${JSON.stringify(t(lang, 'stampScreenNetworkError'))};

  var resultEl = document.getElementById('result');
  var video = document.getElementById('video');
  var canvas = document.getElementById('canvas');
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  var cameraStatus = document.getElementById('cameraStatus');
  var manualForm = document.getElementById('manualForm');
  var manualCode = document.getElementById('manualCode');
  var manualSubmit = document.getElementById('manualSubmit');

  // -----------------------------------------------------------------------
  // QR decode interface — BUILD.md §8.15. jsQR (vendored same-origin at
  // /jsQR.js — see scripts/vendor-jsqr.ts, loaded via the <script> tag just
  // above this one) is the decoder that must always work: it is pure JS,
  // runs everywhere, and is what BUILD.md names for exactly this screen.
  // BarcodeDetector is used ONLY as an opt-in fast path when the browser
  // actually has a working one — never the other way around, and never
  // relied on alone, because it is absent on iOS/iPadOS Safari, every
  // Firefox, and Chrome on Windows/Linux (the "café stamping on an iPad"
  // case this screen exists to serve). The choice between the two is made
  // once, at startup, from feature detection — not re-decided per frame —
  // so a capable browser never pays for both a BarcodeDetector call and a
  // canvas grab + jsQR pass on the same frame.
  // -----------------------------------------------------------------------
  var hasBarcodeDetector = false;
  var barcodeDetector = null;
  if (typeof window.BarcodeDetector === 'function') {
    try {
      barcodeDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
      hasBarcodeDetector = true;
    } catch (e) {
      hasBarcodeDetector = false;
      barcodeDetector = null;
    }
  }

  function decodeWithJsQR(imageData) {
    if (typeof window.jsQR !== 'function') return null; // /jsQR.js failed to load — camera scanning degrades to manual entry
    var result = window.jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' });
    return result && result.data ? result.data : null;
  }

  var busy = false;
  var lastScanAt = 0;
  var scanBusy = false; // guards overlapping BarcodeDetector.detect() calls, which are async
  var currentStream = null;
  var scanRAF = null;

  // Debounce: a QR code held in front of the lens would otherwise decode
  // and fire submitCode() on every ~150ms tick — dozens of times a second
  // relative to a human moving the pass away. The server's 24h guard would
  // reject every repeat anyway, but hammering /api/stamp is still wrong.
  var SCAN_COOLDOWN_MS = 4000;
  var lastScannedCode = null;
  var lastScannedAt = 0;

  function showResult(ok, message) {
    resultEl.className = ok ? 'success' : 'error';
    resultEl.textContent = (ok ? '\\u2713 ' : '\\u26A0 ') + message;
  }

  function setBusy(next) {
    busy = next;
    manualSubmit.disabled = next;
  }

  function submitCode(code) {
    if (busy) return;
    setBusy(true);
    fetch('/api/stamp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code })
    })
      .then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, data: data }; });
      })
      .then(function (result) {
        var message = result.data && result.data.message ? result.data.message : MSG_UNKNOWN_ERROR;
        showResult(result.ok, message);
      })
      .catch(function () {
        showResult(false, MSG_NETWORK_ERROR);
      })
      .then(function () {
        setBusy(false);
      });
  }

  // Camera decodes reach the exact same submitCode() / POST /api/stamp path
  // manual entry uses — one write path, two ways to reach it — but only
  // camera decodes pass through the repeat-code cooldown above; a member of
  // staff retyping the same code by hand is a deliberate action, not a
  // held-up QR still in frame.
  function handleScannedCode(code, ts) {
    if (!code) return;
    if (code === lastScannedCode && ts - lastScannedAt < SCAN_COOLDOWN_MS) return;
    lastScannedCode = code;
    lastScannedAt = ts;
    submitCode(code);
  }

  manualForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var value = manualCode.value.trim();
    if (!value) return;
    submitCode(value);
    manualForm.reset();
    manualCode.focus();
  });

  function scanLoop(ts) {
    scanRAF = requestAnimationFrame(scanLoop);
    if (scanBusy) return;
    if (video.readyState < video.HAVE_ENOUGH_DATA) return;
    if (ts - lastScanAt <= 150) return;
    lastScanAt = ts;
    var w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return;

    if (hasBarcodeDetector) {
      scanBusy = true;
      barcodeDetector.detect(video)
        .then(function (codes) {
          var value = codes && codes.length && codes[0] && codes[0].rawValue ? codes[0].rawValue : null;
          if (value) handleScannedCode(value, ts);
        })
        .catch(function () { /* transient decode failure — try again next frame */ })
        .then(function () { scanBusy = false; });
      return;
    }

    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);
    var imageData = ctx.getImageData(0, 0, w, h);
    var code = decodeWithJsQR(imageData);
    if (code) handleScannedCode(code, ts);
  }

  // Stops the live camera track (and the scan loop driving it) — called
  // when the tab is hidden/backgrounded and on pagehide. A camera left
  // running on a counter tablet drains the battery and is a privacy risk;
  // there is nothing to see once the page is not the active tab.
  function stopCamera() {
    if (scanRAF !== null) {
      cancelAnimationFrame(scanRAF);
      scanRAF = null;
    }
    if (currentStream) {
      currentStream.getTracks().forEach(function (track) { track.stop(); });
      currentStream = null;
    }
  }

  function startCamera() {
    if (currentStream) return; // already running
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
      cameraStatus.textContent = 'Camera not supported on this browser — use manual entry below.';
      return;
    }
    cameraStatus.textContent = 'Starting camera…';
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(function (stream) {
        currentStream = stream;
        video.srcObject = stream;
        return video.play();
      })
      .then(function () {
        cameraStatus.textContent = 'Camera live — point it at the pass QR code.';
        lastScanAt = 0;
        scanRAF = requestAnimationFrame(scanLoop);
      })
      .catch(function () {
        cameraStatus.textContent = 'Camera unavailable — use manual entry below.';
        currentStream = null;
      });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stopCamera();
    } else {
      startCamera();
    }
  });
  window.addEventListener('pagehide', stopCamera);

  startCamera();
})();
</script>
</body>
</html>`;
}

function handleStampScreen(req: http.IncomingMessage, res: http.ServerResponse, auth: StampAuth): void {
  const viewer: StampScreenViewer = auth.staff ? { kind: 'staff', staffName: auth.staff.name } : { kind: 'merchant' };
  sendHtml(res, 200, renderStampScreen(resolveLang(req), viewer));
}

// ---------------------------------------------------------------------------
// Route: POST /api/stamp — the stamp screen's write path (BUILD.md §8.15,
// §9.6). Accepts { code: string } — either the pass serial encoded in the
// customer's wallet-card QR, or the human shortCode typed at the manual
// fallback. The 24-hour anti-fraud rule is enforced inside applyStamp()
// (apps/demo/stamp.ts), server-side, before any write. Every response
// body — success or error — carries a `message` already translated per the
// `lang` cookie (BUILD.md §13: server error messages translated too).
// ---------------------------------------------------------------------------
async function handleApiStamp(req: http.IncomingMessage, res: http.ServerResponse, merchant: Merchant, staff?: Staff): Promise<void> {
  const lang = resolveLang(req);

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    const status = isHttpError(err) ? err.statusCode : 400;
    sendJson(res, status, { ok: false, message: t(lang, 'stampInputRequired') });
    return;
  }

  const code =
    typeof body === 'object' &&
    body !== null &&
    'code' in body &&
    typeof (body as { code: unknown }).code === 'string'
      ? (body as { code: string }).code.trim()
      : '';

  if (!code) {
    sendJson(res, 400, { ok: false, message: t(lang, 'stampInputRequired') });
    return;
  }

  const outcome = await applyStamp(code, merchant.id, 'browser', staff?.id);

  if (!outcome.ok) {
    if (outcome.reason === 'not_found') {
      sendJson(res, 404, { ok: false, message: t(lang, 'passNotFound') });
      return;
    }
    sendJson(res, 429, { ok: false, message: t(lang, 'stampTooSoon') });
    return;
  }

  const counts = { stamps: arabicDigits(outcome.stamps, lang), goal: arabicDigits(outcome.goal, lang) };
  const message = outcome.rewardEarned
    ? `${t(lang, 'stampSuccess', counts)} · ${t(lang, 'rewardEarned')}`
    : t(lang, 'stampSuccess', counts);

  sendJson(res, 200, {
    ok: true,
    serial: outcome.serial,
    stamps: outcome.stamps,
    goal: outcome.goal,
    totalStamps: outcome.totalStamps,
    rewards: outcome.rewards,
    rewardEarned: outcome.rewardEarned,
    message,
  });

  // Fire the live-update pushes (APNs and Google Wallet both) only *after*
  // the response above has been handed to the socket, and never awaited by
  // this handler — BUILD.md §18 item 6: fanning these out inside a request
  // handler is what times a stamp request out. setImmediate defers this
  // past the current synchronous turn (and past res.end() flushing) so a
  // slow or failed push can never slow down, let alone fail, the stamp
  // itself.
  setImmediate(() => {
    pushPassUpdate(outcome.serial, outcome.stamps, outcome.goal).catch((err) => {
      console.error(`[push] live-update fan-out threw for pass ${outcome.serial}:`, err);
    });
  });
}

// ---------------------------------------------------------------------------
// Apple PassKit web service (BUILD.md §9.3 / §12) — the four endpoints
// Apple's device and Wallet call directly, plus the diagnostics-log
// endpoint. Paths are fixed by Apple; do not alter them. DB logic and the
// `Authorization: ApplePass <token>` check live in apps/demo/passkit.ts
// (testable without HTTP, same split as apps/demo/stamp.ts); these
// handlers only translate HTTP <-> those calls.
// ---------------------------------------------------------------------------

/** The single `Authorization` header value, or undefined — node normalises repeated headers into an array; PassKit never sends more than one. */
function applePassAuthHeader(req: http.IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  return Array.isArray(h) ? h[0] : h;
}

function readStringField(body: unknown, key: string): string {
  if (typeof body !== 'object' || body === null || !(key in body)) return '';
  const v = (body as Record<string, unknown>)[key];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * POST /apple/v1/devices/:deviceId/registrations/:passTypeId/:serial —
 * registers this device for live updates to this pass. 201 the first time,
 * 200 if it was already registered (Apple distinguishes the two).
 */
async function handleRegisterDevice(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deviceId: string,
  serial: string
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    body = {};
  }
  const pushToken = readStringField(body, 'pushToken');
  if (!pushToken) {
    res.writeHead(400);
    res.end();
    return;
  }

  const result = await registerDevice({ deviceId, serial, authHeader: applePassAuthHeader(req), pushToken });
  res.writeHead(result.status);
  res.end();
}

/**
 * GET /apple/v1/devices/:deviceId/registrations/:passTypeId?passesUpdatedSince=
 * — "what's changed for this device since last time?" 204 when nothing
 * has, 200 with the changed serials when something has.
 */
async function handleGetUpdatedSerials(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deviceId: string,
  url: URL
): Promise<void> {
  // No auth header is read here on purpose — Apple does not send one to this
  // endpoint. See the comment on getUpdatedSerials in passkit.ts.
  const result = await getUpdatedSerials({
    deviceId,
    passesUpdatedSince: url.searchParams.get('passesUpdatedSince') ?? undefined,
  });
  if (result.status === 200) {
    sendJson(res, 200, result.body);
    return;
  }
  res.writeHead(result.status);
  res.end();
}

/**
 * GET /apple/v1/passes/:passTypeId/:serial — the freshly rebuilt, signed
 * `.pkpass` for this serial. Honours `If-Modified-Since`: 304 when the
 * pass hasn't changed since the device's cached copy.
 */
async function handleGetLatestPass(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  serial: string
): Promise<void> {
  const ifModifiedSinceHeader = req.headers['if-modified-since'];
  const result = await getPassForDownload({
    serial,
    authHeader: applePassAuthHeader(req),
    ifModifiedSince: typeof ifModifiedSinceHeader === 'string' ? ifModifiedSinceHeader : undefined,
  });
  if (result.status !== 200) {
    res.writeHead(result.status);
    res.end();
    return;
  }

  const { pass } = result;
  const credentials = resolveAppleCredentials();
  const pkpass = await cachedBuildPass(credentials, pass);

  res.writeHead(200, {
    'Content-Type': 'application/vnd.apple.pkpass',
    'Content-Length': pkpass.length,
    'Last-Modified': pass.updatedAt.toUTCString(),
    'Cache-Control': 'no-store',
  });
  res.end(pkpass);
}

/** DELETE /apple/v1/devices/:deviceId/registrations/:passTypeId/:serial — the customer removed the pass from Wallet. */
async function handleUnregisterDevice(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deviceId: string,
  serial: string
): Promise<void> {
  const result = await unregisterDevice({ deviceId, serial, authHeader: applePassAuthHeader(req) });
  res.writeHead(result.status);
  res.end();
}

/**
 * POST /apple/v1/log — no auth (Apple's spec doesn't send one here), no DB.
 * Apple posts real on-device diagnostics to this endpoint, and it is
 * frequently the *only* way to learn why a device refused a pass or a
 * registration — write the body to the server log rather than discarding
 * it.
 */
async function handleApplePassLog(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    body = undefined;
  }
  console.log('[apple-passkit-log]', JSON.stringify(body));
  res.writeHead(200);
  res.end();
}

// ---------------------------------------------------------------------------
// Route: GET /health — for Fly.io's HTTP health checks (and anything else
// probing liveness). No DB round-trip: it should stay cheap and answer even
// if Postgres is momentarily unreachable, so a transient DB hiccup doesn't
// get the machine killed for being "unhealthy".
// ---------------------------------------------------------------------------
function handleHealth(res: http.ServerResponse): void {
  const body = JSON.stringify({ status: 'ok' });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Static assets — apps/demo/public/. GET / serves index.html (the owner's
// marketing landing page); anything else under public/ (fonts, images, ...)
// is served by filename with a real Content-Type. No framework: a handful
// of extensions is all this app needs.
// ---------------------------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, 'public');

const STATIC_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Maps a request pathname to a file under PUBLIC_DIR, or returns undefined
 * if it isn't a safe, in-bounds request. Rejects any path traversal attempt
 * — a decoded pathname containing ".." — before the filesystem is touched;
 * the `startsWith` check below is belt-and-braces on top of that.
 */
function resolveStaticPath(pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined; // malformed percent-encoding
  }
  if (decoded.includes('..')) return undefined;
  const rel = decoded === '/' ? '/index.html' : decoded;
  const filePath = path.join(PUBLIC_DIR, rel);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) return undefined;
  return filePath;
}

/** Serves a file from apps/demo/public/. Returns false (no response sent) when there is no such file, so the caller can fall through to the next route. */
function serveStaticFile(res: http.ServerResponse, pathname: string): boolean {
  const filePath = resolveStaticPath(pathname);
  if (!filePath) return false;

  let data: Buffer;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    data = fs.readFileSync(filePath);
  } catch {
    return false; // no such file — not an error, just "not a static asset"
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = STATIC_CONTENT_TYPES[ext] ?? 'application/octet-stream';
  // HTML is revalidated every time (the landing page can change); every
  // other static asset in apps/demo/public/ (logo.png, logo-dark.png,
  // jsQR.js, fonts) is a stable filename with no content hash, and a new
  // build simply overwrites it — a year-long, immutable cache is safe and
  // saves re-fetching them (the logo alone would otherwise be requested on
  // every page load; see scripts/resize-logo.ts's before/after byte sizes
  // for why that matters).
  const cacheControl = ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': data.length,
    'Cache-Control': cacheControl,
  });
  res.end(data);
  return true;
}

// ---------------------------------------------------------------------------
// Broadcast worker (BUILD.md §8.12 / §18 item 6 / §10) — the consumer side
// of the Postgres-backed queue apps/demo/broadcast.ts's enqueueBroadcast()
// writes into. `sendOne` is wired to the exact same ApnsClient every other
// push path in this file uses (getApnsClient() above): one warm HTTP/2
// session for the whole process, never a client built per push. Started
// once, at boot (see server.listen's callback below); stopped cleanly —
// waiting for any cycle already in flight — on shutdown.
// ---------------------------------------------------------------------------
async function broadcastSendOne(device: Device): Promise<SendPushOutcome> {
  const client = getApnsClient();
  if (!client) return { ok: false, error: 'APNs not configured' }; // getApnsClient() already logged why, once.
  const passTypeId = process.env.APPLE_PASS_TYPE_ID;
  if (!passTypeId) return { ok: false, error: '.env is missing APPLE_PASS_TYPE_ID' };

  const result = await client.sendPush(device.pushToken, passTypeId);
  if (result.ok) return { ok: true };
  if (result.reason === 'gone') return { ok: false, gone: true };
  if (isBadEnvironmentKeyError(result.status, result.body)) {
    // Same actionable shape as pushApnsUpdate's own line — see that
    // function's comment for the full explanation.
    return {
      ok: false,
      error: `BadEnvironmentKeyInToken — APNs key not provisioned for '${APNS_ENV}' (host=${client.host})`,
    };
  }
  return { ok: false, error: `status=${result.status} auth=${client.authMode} host=${client.host} body=${result.body}` };
}

const broadcastWorker = new BroadcastWorker({ sendOne: broadcastSendOne });

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const { pathname } = url;

    if (req.method === 'GET' && pathname === '/health') {
      handleHealth(res);
      return;
    }
    // Landing page (GET / → public/index.html) and any other static asset
    // under apps/demo/public/. Only succeeds when a real file exists at
    // that path, so it can never shadow a route below it (e.g. GET /app,
    // or the /:code catch-all further down) — it just falls through.
    if (req.method === 'GET' && serveStaticFile(res, pathname)) {
      return;
    }
    // Sign-up / sign-in / sign-out — public (a session is what every route
    // below this point exists to require).
    if (req.method === 'GET' && pathname === '/signin') {
      handleSignInForm(req, res, url);
      return;
    }
    if (req.method === 'POST' && pathname === '/signin') {
      await handleSignIn(req, res);
      return;
    }
    if (req.method === 'GET' && pathname === '/signup') {
      handleSignUpForm(req, res, url);
      return;
    }
    if (req.method === 'POST' && pathname === '/signup') {
      await handleSignUp(req, res);
      return;
    }
    if (req.method === 'POST' && pathname === '/signout') {
      await handleSignOut(req, res);
      return;
    }

    // Everything from here down through /api/stamp is a merchant-facing
    // route: requireMerchant() 302s to /signin when there is no valid
    // session, and every handler below is scoped to the merchant it
    // resolves — never a bare client-supplied id (BUILD.md job brief).
    if (req.method === 'GET' && pathname === '/app') {
      const merchant = await requireMerchant(req, res);
      if (!merchant) return;
      await handleCardsList(req, res, merchant);
      return;
    }
    if (req.method === 'GET' && pathname === '/cards/new') {
      const merchant = await requireMerchant(req, res);
      if (!merchant) return;
      await handleNewCardForm(req, res);
      return;
    }
    if (req.method === 'POST' && pathname === '/cards') {
      const merchant = await requireMerchant(req, res);
      if (!merchant) return;
      await handleCreateCard(req, res, merchant);
      return;
    }
    // /preview.png, /qr.png, /icon-swatch.png stay fully public — the
    // customer enrol page and print sheet embed them with no session
    // (BUILD.md job brief's "what stays public" list).
    if (req.method === 'GET' && pathname === '/preview.png') {
      await handlePreviewPng(res, url.searchParams);
      return;
    }
    if (req.method === 'GET' && pathname === '/qr.png') {
      handleQrPng(res, url.searchParams);
      return;
    }
    if (req.method === 'GET' && pathname === '/icon-swatch.png') {
      handleIconSwatchPng(res, url.searchParams);
      return;
    }
    // GET /customers and its CSV export (BUILD.md §8.11), and GET /reports
    // (BUILD.md §8.14) — literal single-segment paths, registered here
    // above the /:code catch-all for the same reason /app and /stamp are.
    if (req.method === 'GET' && pathname === '/customers/export.csv') {
      const merchant = await requireMerchant(req, res);
      if (!merchant) return;
      await handleCustomersExport(req, res, url, merchant);
      return;
    }
    if (req.method === 'GET' && pathname === '/customers') {
      const merchant = await requireMerchant(req, res);
      if (!merchant) return;
      await handleCustomersList(req, res, url, merchant);
      return;
    }
    if (req.method === 'GET' && pathname === '/reports') {
      const merchant = await requireMerchant(req, res);
      if (!merchant) return;
      await handleReports(req, res, url, merchant);
      return;
    }
    // GET /settings and its staff-PIN management actions (BUILD.md §8.13) —
    // literal/regex paths registered here for the same reason /customers and
    // /reports are: above the `GET /:code` catch-all, and never colliding
    // with the /cards/... group below regardless.
    if (req.method === 'GET' && pathname === '/settings') {
      const merchant = await requireMerchant(req, res);
      if (!merchant) return;
      await handleSettingsPage(req, res, merchant);
      return;
    }
    if (req.method === 'POST' && pathname === '/staff') {
      const merchant = await requireMerchant(req, res);
      if (!merchant) return;
      await handleCreateStaff(req, res, merchant);
      return;
    }
    const staffActionMatch = pathname.match(/^\/staff\/([^/]+)\/(activate|deactivate|delete)$/);
    if (req.method === 'POST' && staffActionMatch) {
      const merchant = await requireMerchant(req, res);
      if (!merchant) return;
      await handleStaffAction(req, res, staffActionMatch[1]!, staffActionMatch[2] as 'activate' | 'deactivate' | 'delete', merchant);
      return;
    }
    // GET /notifications and its two AJAX endpoints (BUILD.md §8.12) —
    // literal/regex paths registered here for the same reason /settings
    // and /staff are: above the `GET /:code` catch-all, owner session only
    // (requireMerchant() — see this section's own doc comment above
    // handleNotificationsPage for why a staff session can never reach any
    // of these).
    if (req.method === 'GET' && pathname === '/notifications') {
      const merchant = await requireMerchant(req, res);
      if (!merchant) return;
      await handleNotificationsPage(req, res, url, merchant);
      return;
    }
    if (req.method === 'GET' && pathname === '/notifications/recipient-count') {
      const merchant = await requireMerchant(req, res);
      if (!merchant) return;
      await handleRecipientCount(req, res, url, merchant);
      return;
    }
    if (req.method === 'POST' && pathname === '/notifications/send') {
      const merchant = await requireMerchant(req, res);
      if (!merchant) return;
      await handleSendBroadcast(req, res, merchant);
      return;
    }
    const broadcastJobMatch = pathname.match(/^\/notifications\/jobs\/([^/]+)$/);
    if (req.method === 'GET' && broadcastJobMatch) {
      const merchant = await requireMerchant(req, res);
      if (!merchant) return;
      await handleBroadcastJobStatus(req, res, broadcastJobMatch[1]!, merchant);
      return;
    }
    // /cards/:id/print, /cards/:id/activate, /cards/:id/edit — two-segment
    // paths under /cards/, so the single-segment `/^\/cards\/([^/]+)$/`
    // match just below (anchored with `$`) can never shadow them, and vice
    // versa; order between the two groups does not matter, only that both
    // are above the `GET /:code` catch-all at the bottom of this router.
    const cardPrintMatch = pathname.match(/^\/cards\/([^/]+)\/print$/);
    if (req.method === 'GET' && cardPrintMatch) {
      const merchant = await requireMerchant(req, res);
      if (!merchant) return;
      await handleCardPrint(req, res, cardPrintMatch[1]!, merchant);
      return;
    }
    const cardActivateMatch = pathname.match(/^\/cards\/([^/]+)\/activate$/);
    if (cardActivateMatch) {
      if (req.method === 'GET') {
        const merchant = await requireMerchant(req, res);
        if (!merchant) return;
        await handleActivateConfirm(req, res, cardActivateMatch[1]!, merchant);
        return;
      }
      if (req.method === 'POST') {
        const merchant = await requireMerchant(req, res);
        if (!merchant) return;
        await handleActivateCard(req, res, cardActivateMatch[1]!, merchant);
        return;
      }
    }
    const cardEditMatch = pathname.match(/^\/cards\/([^/]+)\/edit$/);
    if (cardEditMatch) {
      if (req.method === 'GET') {
        const merchant = await requireMerchant(req, res);
        if (!merchant) return;
        await handleEditCardForm(req, res, cardEditMatch[1]!, merchant);
        return;
      }
      if (req.method === 'POST') {
        const merchant = await requireMerchant(req, res);
        if (!merchant) return;
        await handleUpdateCard(req, res, cardEditMatch[1]!, merchant);
        return;
      }
    }
    const cardImageMatch = pathname.match(/^\/cards\/([^/]+)\/image$/);
    if (req.method === 'POST' && cardImageMatch) {
      const merchant = await requireMerchant(req, res);
      if (!merchant) return;
      await handleUploadCardImage(req, res, cardImageMatch[1]!, merchant);
      return;
    }
    // GET /img/:hash stays fully public — content-addressed by a sha256
    // hash, served to the customer enrol page and the print sheet with no
    // session (BUILD.md job brief's "what stays public" list).
    const imgMatch = pathname.match(/^\/img\/([0-9a-f]{64})$/);
    if (req.method === 'GET' && imgMatch) {
      await handleGetImage(res, imgMatch[1]!);
      return;
    }
    const cardMatch = pathname.match(/^\/cards\/([^/]+)$/);
    const cardId = cardMatch?.[1];
    if (req.method === 'GET' && cardId !== undefined) {
      const merchant = await requireMerchant(req, res);
      if (!merchant) return;
      await handleCardDetail(req, res, cardId, merchant);
      return;
    }
    // /stamp and /api/stamp are literal paths and must be registered here —
    // above the `GET /:code` catch-all below — or the catch-all would
    // swallow them (BUILD.md §12 / §18 item 10). The stamp screen is a
    // special case (BUILD.md §8.13): staff need it without being the owner,
    // so these two use resolveStampAuth() — merchant session OR staff
    // session — never requireMerchant(), which would 302 a staff-only
    // browser to /signin (a page it has no credentials for and must never
    // reach). GET /stamp with neither shows the staff PIN entry screen
    // instead of redirecting.
    if (req.method === 'GET' && pathname === '/stamp') {
      const auth = await resolveStampAuth(req);
      if (!auth) {
        handleStaffPinForm(req, res);
        return;
      }
      handleStampScreen(req, res, auth);
      return;
    }
    if (req.method === 'POST' && pathname === '/stamp/pin') {
      await handleStaffPinLogin(req, res);
      return;
    }
    if (req.method === 'POST' && pathname === '/stamp/signout') {
      await handleStaffSignOut(req, res);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/stamp') {
      const auth = await resolveStampAuth(req);
      if (!auth) {
        sendJson(res, 401, { ok: false, message: t(resolveLang(req), 'staffPinRequired') });
        return;
      }
      await handleApiStamp(req, res, auth.merchant, auth.staff);
      return;
    }

    // The Apple PassKit web service (BUILD.md §12). Paths are fixed by
    // Apple and must be registered here — above the `GET /:code` catch-all
    // below — same reasoning as /stamp and /api/stamp just above: `apple`
    // as the first path segment never collides with the single- or
    // two-segment catch-alls below regardless, but literal routes belong
    // above the catch-all on principle (BUILD.md §18 item 10).
    if (pathname === '/apple/v1/log' && req.method === 'POST') {
      await handleApplePassLog(req, res);
      return;
    }
    const registrationMatch = pathname.match(
      /^\/apple\/v1\/devices\/([^/]+)\/registrations\/([^/]+)\/([^/]+)$/
    );
    if (registrationMatch) {
      const [, deviceId, , serial] = registrationMatch;
      if (req.method === 'POST') {
        await handleRegisterDevice(req, res, deviceId!, serial!);
        return;
      }
      if (req.method === 'DELETE') {
        await handleUnregisterDevice(req, res, deviceId!, serial!);
        return;
      }
    }
    const serialsMatch = pathname.match(/^\/apple\/v1\/devices\/([^/]+)\/registrations\/([^/]+)$/);
    if (req.method === 'GET' && serialsMatch) {
      await handleGetUpdatedSerials(req, res, serialsMatch[1]!, url);
      return;
    }
    const getPassMatch = pathname.match(/^\/apple\/v1\/passes\/([^/]+)\/([^/]+)$/);
    if (req.method === 'GET' && getPassMatch) {
      await handleGetLatestPass(req, res, getPassMatch[2]!);
      return;
    }

    // From here down are the public, unauthenticated short-link routes.
    // BUILD.md §12 / §18 item 10: the bare `GET /:code` catch-all must be
    // registered dead last, or it shadows every route above it — every
    // literal path (including this section's own POST /:code/pass and
    // POST /:code/google-pass, both distinct two-segment patterns) is
    // matched first.
    const passIssueMatch = pathname.match(/^\/([^/]+)\/pass$/);
    if (req.method === 'POST' && passIssueMatch) {
      await handleIssuePass(req, res, passIssueMatch[1]!);
      return;
    }
    const googlePassIssueMatch = pathname.match(/^\/([^/]+)\/google-pass$/);
    if (req.method === 'POST' && googlePassIssueMatch) {
      await handleIssueGooglePass(req, res, googlePassIssueMatch[1]!);
      return;
    }
    const enrolMatch = pathname.match(/^\/([^/]+)$/);
    if (req.method === 'GET' && enrolMatch) {
      await handleEnrolPage(res, enrolMatch[1]!);
      return;
    }

    sendNotFound(res, `No route for ${req.method} ${pathname}.`);
  } catch (err) {
    // The exception's own message is logged in full here, server-side only
    // — never sent to the client (see below). It routinely carries things
    // that must never reach a public response: resolveAppleCredentials()
    // throws container filesystem paths when a cert is missing, and a
    // Prisma connection error (P1001) renders the database host and port
    // straight into `Error#message`. `req.method`/`req.url` are logged
    // alongside it so this line is still useful for debugging without
    // having to guess which request failed.
    console.error(`[500] ${req.method} ${req.url}:`, err);
    if (!res.headersSent) {
      const lang = resolveLang(req);
      sendHtml(res, 500, layout('Error', `<div class="panel"><h1>500</h1><p>${escapeHtml(t(lang, 'serverError'))}</p></div>`, undefined, lang));
    } else {
      res.end();
    }
  }
});

// Bind 0.0.0.0, not the loopback-only default: a container's health checks
// and reverse proxy reach the process over its container-internal network
// interface, not localhost.
server.listen(PORT, '0.0.0.0', () => {
  console.log(`LoyaNexa merchant demo running:`);
  console.log(`  Local: http://localhost:${PORT}`);
  console.log(`  LAN:   ${LAN_URL}   (open this on an iPhone on the same network)`);
  if (PUBLIC_BASE_URL) console.log(`  Public: ${PUBLIC_BASE_URL}   (used for enrol links and QR codes)`);
  // DISABLE_BROADCAST_WORKER=1 is test-only: every apps/demo/test/*.test.ts
  // file that spawns this server as a real child process sets it, so that
  // process never runs a live BroadcastWorker against the shared local
  // test Postgres. Without this, a broadcast job/recipient row created by
  // one test file's fixture could be claimed by a *different* spawned
  // server's background worker (claimBatch() is deliberately global, not
  // scoped to one job — see broadcastWorker.ts's own file comment) and
  // pushed through the real ApnsClient this server wires up below —
  // exactly the "contact Apple from a test" outcome the job's own
  // constraints forbid. apps/demo/test/broadcastWorker.test.ts is the only
  // place a BroadcastWorker ever actually runs under test, and it always
  // constructs its own instance directly with an injected stub `sendOne`,
  // never through this server process.
  if (process.env.DISABLE_BROADCAST_WORKER !== '1') broadcastWorker.start();
});

async function shutdown(): Promise<void> {
  await broadcastWorker.stop();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown); // Fly.io/most container platforms send this on deploy/stop, not just Ctrl-C
