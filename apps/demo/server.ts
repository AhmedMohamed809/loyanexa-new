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
//   GET  /preview.png, GET /qr.png
//   GET  /stamp           the merchant stamp screen (BUILD.md §8.15)
//   POST /api/stamp        its write path — 24h anti-fraud guard (§9.6),
//                          fires an APNs live-update push after responding
//   Apple PassKit web service (BUILD.md §9.3 / §12 — paths fixed by Apple):
//     POST   /apple/v1/devices/:deviceId/registrations/:passTypeId/:serial
//     GET    /apple/v1/devices/:deviceId/registrations/:passTypeId
//     GET    /apple/v1/passes/:passTypeId/:serial
//     DELETE /apple/v1/devices/:deviceId/registrations/:passTypeId/:serial
//     POST   /apple/v1/log
//   GET  /:code           the customer enrol page (registered last — catch-all)
//   POST /:code/pass       issues a real signed Apple Wallet pass
//   GET  /health

import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import querystring from 'node:querystring';
import { fileURLToPath } from 'node:url';
import { Prisma, type Card, type Pass } from '@prisma/client';
import {
  buildPass,
  invisibleChangeMarker,
  type PassCredentials,
  type PassContent,
  type PassImages,
} from '../../packages/pass/src/buildPass.ts';
import {
  resolveAppleCredentials as resolveAppleCredentialPaths,
  resolveApnsKeyPem,
} from '../../packages/pass/src/credentials.ts';
import { ApnsClient } from '../../packages/pass/src/apns.ts';
import { t, arabicDigits, type Lang } from '../../packages/i18n/src/index.ts';
import { loadEnvFile } from './env.ts';
import {
  registerDevice,
  getUpdatedSerials,
  unregisterDevice,
  getPassForDownload,
} from './passkit.ts';

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

/** Reads the `lang` cookie (BUILD.md §13 — language persists in cookies, never localStorage, so the server can read it). Defaults to `ar`, matching Card/Merchant's own default locale. */
function resolveLang(req: http.IncomingMessage): Lang {
  const header = req.headers.cookie;
  if (!header) return 'ar';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== 'lang') continue;
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
function resolveAppleCredentials(): PassCredentials {
  const need = (key: string): string => {
    const v = process.env[key];
    if (!v) throw new Error(`.env is missing ${key}`);
    return v;
  };
  const { signerCertPath, signerKeyPath, wwdrPath } = resolveAppleCredentialPaths(ROOT);
  return {
    teamId: need('APPLE_TEAM_ID'),
    passTypeId: need('APPLE_PASS_TYPE_ID'),
    certPath: signerCertPath,
    keyPath: signerKeyPath,
    wwdrPath,
  };
}

// ---------------------------------------------------------------------------
// APNs — one ApnsClient for the whole process (BUILD.md §18 item 3: it
// caches its JWT and reuses one HTTP/2 session across every push; building
// a fresh client per push would defeat both). Built lazily on first use,
// not at module load, so a machine without the .p8 configured (e.g. a
// contributor's laptop that never set APNS_KEY_PATH) still runs the rest of
// the demo — it just never sends live-update pushes, which is logged once,
// clearly, rather than crashing the whole server.
// ---------------------------------------------------------------------------
let apnsClient: ApnsClient | null | undefined; // undefined = not yet attempted; null = attempted, unavailable
function getApnsClient(): ApnsClient | undefined {
  if (apnsClient !== undefined) return apnsClient ?? undefined;
  try {
    const keyId = process.env.APNS_KEY_ID;
    const teamId = process.env.APPLE_TEAM_ID;
    if (!keyId) throw new Error('.env is missing APNS_KEY_ID');
    if (!teamId) throw new Error('.env is missing APPLE_TEAM_ID');
    const privateKeyPem = resolveApnsKeyPem(ROOT);
    apnsClient = new ApnsClient({ keyId, teamId, privateKeyPem });
    return apnsClient;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[apns] not configured — live-update pushes are disabled (${message})`);
    apnsClient = null;
    return undefined;
  }
}

/**
 * Pushes the content-free wake-up notification (BUILD.md §9.3) to every
 * device registered for `serial`, and prunes any Device row APNs reports
 * as 410 Gone (the pass was removed from that phone). Callers must invoke
 * this *after* responding to the triggering request (BUILD.md §18 item 6)
 * — it is never awaited by a request handler, only fired from one.
 */
async function pushPassUpdate(serial: string): Promise<void> {
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
      } else {
        console.error(
          `[apns] pass ${serial}: push to device ${device.deviceId} failed — status=${result.status} body=${result.body}`
        );
      }
    })
  );
}

/** A shared strip-render cache, reused across every pass issuance (BUILD.md §10 — the strip cache is a 455x measured win; do not re-render per request). */
const PASS_STRIP_STORE = new MemoryStore();

/** icon.png / icon@2x.png — the merchant's own card colours, not ours (same principle as the enrol page). */
function makeCardIcon(size: number, bgColor: string, accentColor: string): Buffer {
  const surface = new Surface(size, size);
  surface.fill(parseHexColor(bgColor, 1));
  fillDisc(surface, size / 2, size / 2, size * 0.36, parseHexColor(accentColor, 1));
  return encodePNG(surface.toRGBA(), size, size);
}

/** Auto-generated terms per BUILD.md §8.6 — built from the card's own settings, the merchant writes nothing. */
function buildTermsText(card: Card): string {
  const expiry =
    card.expiryType === 'duration'
      ? `${card.expiryDays ?? 0} days`
      : card.expiryType === 'fixed'
        ? (card.expiryDate?.toISOString().slice(0, 10) ?? 'unlimited')
        : 'unlimited';
  return [
    '1 stamp per visit.',
    `Collect ${card.stampsGoal} stamps to get a reward.`,
    `Card, stamps and rewards expiry: ${expiry}.`,
    'Stamps and rewards cannot be exchanged, returned or bought for cash.',
    'Cards cannot be transferred or combined with other cards.',
    'The company reserves the right to amend these terms.',
  ].join(' ');
}

/** A filesystem/header-safe filename stem from the card's own name. */
function passFilenameStem(name: string): string {
  const slug = name.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'card';
}

// ---------------------------------------------------------------------------
// Merchant resolution — no auth in this slice (Firebase lands in
// sub-project 4). There is exactly one merchant on this machine: the owner
// sitting at the laptop. We find-or-create it on first use.
// ---------------------------------------------------------------------------
async function getOrCreateMerchant() {
  // TODO(sub-project 4): real auth — resolve the merchant from the signed-in
  // Firebase user instead of "the only merchant row that exists locally".
  const existing = await prisma.merchant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (existing) return existing;
  return prisma.merchant.create({
    data: {
      firebaseUid: 'local-demo-merchant',
      email: 'ahmedabdulalgane@gmail.com',
      name: 'Demo Merchant',
    },
  });
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
// HTML shell — brand tokens: navy #203757, accent orange #F96400, canvas
// #F4F6FA, white panels, radius 18px, borders doing the separating.
// ---------------------------------------------------------------------------
function layout(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · LoyaNexa</title>
<style>
  :root {
    --navy: #203757;
    --accent: #F96400;
    --canvas: #F4F6FA;
    --border: #DCE2EA;
    --muted: #6B7A90;
    --radius: 18px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--canvas);
    color: var(--navy);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  header.top {
    background: var(--navy);
    color: #fff;
    padding: 20px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  header.top a { color: #fff; text-decoration: none; font-weight: 700; font-size: 18px; letter-spacing: 0.2px; }
  main {
    max-width: 880px;
    margin: 0 auto;
    padding: 24px 20px 64px;
  }
  .banner {
    background: #FFF4E8;
    border: 1px solid #F6C99A;
    color: #7A3E00;
    border-radius: var(--radius);
    padding: 14px 18px;
    margin-bottom: 20px;
    font-size: 14px;
    line-height: 1.5;
  }
  .banner b { color: #5C2E00; }
  .panel {
    background: #fff;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 24px;
    margin-bottom: 20px;
  }
  h1 { font-size: 24px; margin: 0 0 6px; }
  h2 { font-size: 18px; margin: 0 0 14px; }
  p { line-height: 1.5; }
  .muted { color: var(--muted); }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .btn {
    display: inline-block;
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: 100px;
    padding: 12px 22px;
    font-weight: 600;
    font-size: 15px;
    text-decoration: none;
    cursor: pointer;
  }
  .btn:hover { opacity: 0.92; }
  .btn.secondary {
    background: #fff;
    color: var(--navy);
    border: 1px solid var(--border);
  }
  .cards-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 16px;
  }
  .card-tile {
    display: block;
    background: #fff;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    text-decoration: none;
    color: inherit;
  }
  .card-tile img { display: block; width: 100%; height: auto; background: var(--canvas); }
  .card-tile .meta { padding: 14px 16px; border-top: 1px solid var(--border); }
  .card-tile .meta h3 { margin: 0 0 4px; font-size: 15px; }
  .card-tile .meta p { margin: 0; font-size: 13px; color: var(--muted); }
  .empty {
    text-align: center;
    padding: 48px 24px;
  }
  form .field { margin-bottom: 18px; }
  label { display: block; font-weight: 600; font-size: 13px; margin-bottom: 6px; color: var(--navy); }
  input[type="text"], input[type="number"] {
    width: 100%;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px 14px;
    font-size: 15px;
    background: var(--canvas);
  }
  input[type="range"] { width: 100%; }
  input[type="color"] {
    width: 56px;
    height: 40px;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 2px;
    background: #fff;
  }
  .colors { display: flex; gap: 24px; flex-wrap: wrap; }
  .colors .field { margin-bottom: 0; }
  .preview-panel { text-align: center; background: var(--canvas); border: 1px dashed var(--border); border-radius: var(--radius); padding: 20px; }
  .preview-panel img { max-width: 100%; }
  .error { background: #FDEAEA; border: 1px solid #F3B4B4; color: #8A1F1F; border-radius: 12px; padding: 12px 16px; margin-bottom: 18px; font-size: 14px; }
  code.pill { background: var(--canvas); border: 1px solid var(--border); border-radius: 8px; padding: 4px 10px; font-size: 13px; }
  .kv { display: grid; grid-template-columns: 140px 1fr; gap: 10px 16px; font-size: 15px; }
  .kv dt { color: var(--muted); }
  .kv dd { margin: 0; }
  .qr-wrap { text-align: center; padding: 20px; background: var(--canvas); border-radius: var(--radius); border: 1px solid var(--border); }
  .qr-wrap img { image-rendering: pixelated; border-radius: 8px; background: #fff; padding: 12px; }
</style>
</head>
<body>
<header class="top">
  <a href="/app">LoyaNexa · Merchant</a>
  <a class="btn" href="/stamp" style="padding:8px 18px;font-size:13px;">Stamp a card</a>
</header>
<main>
${bodyHtml}
</main>
</body>
</html>`;
}

const AUTH_BANNER = `<div class="banner"><b>Local demo — no authentication.</b> Anyone who can reach this machine on the network can view and create cards. Firebase sign-in arrives in a later sub-project.</div>`;

// ---------------------------------------------------------------------------
// Route: GET /app — list cards. GET / itself now serves the owner's static
// marketing landing page (apps/demo/public/index.html) — see serveStaticFile.
// ---------------------------------------------------------------------------
function cardThumbSrc(card: Card): string {
  const qs = new URLSearchParams({
    goal: String(card.stampsGoal),
    filled: String(defaultFilled(card.stampsGoal)),
    bg: card.bgColor,
    active: card.stampActive,
    inactive: card.stampInactive,
  });
  return `/preview.png?${qs.toString()}`;
}

async function handleCardsList(res: http.ServerResponse): Promise<void> {
  const cards = await prisma.card.findMany({ orderBy: { createdAt: 'desc' } });

  const body = cards.length
    ? `<div class="row" style="margin-bottom:18px;">
         <div>
           <h1>Your cards</h1>
           <p class="muted">${cards.length} card${cards.length === 1 ? '' : 's'}</p>
         </div>
         <a class="btn" href="/cards/new">Create card</a>
       </div>
       <div class="cards-grid">
         ${cards
           .map(
             (c) => `<a class="card-tile" href="/cards/${c.id}">
               <img src="${cardThumbSrc(c)}" alt="${escapeHtml(c.name)} stamp strip" width="375" height="144">
               <div class="meta">
                 <h3>${escapeHtml(c.name)}</h3>
                 <p>${escapeHtml(c.rewardText)} · ${c.stampsGoal} stamps</p>
               </div>
             </a>`
           )
           .join('\n')}
       </div>`
    : `<div class="panel empty">
         <h1>No loyalty cards yet</h1>
         <p class="muted">Create your first card to start giving out stamps.</p>
         <p><a class="btn" href="/cards/new">Create card</a></p>
       </div>`;

  sendHtml(res, 200, layout('Cards', AUTH_BANNER + body));
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
  error?: string
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
    <h1>Create a loyalty card</h1>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <div class="panel">
      <form method="POST" action="/cards">
        <div class="field">
          <label for="name">Card name</label>
          <input type="text" id="name" name="name" required maxlength="80" value="${escapeHtml(name)}" placeholder="e.g. Shami Bakery">
        </div>
        <div class="field">
          <label for="rewardText">Reward text</label>
          <input type="text" id="rewardText" name="rewardText" required maxlength="120" value="${escapeHtml(rewardText)}" placeholder="e.g. Free coffee">
        </div>
        <div class="field">
          <label for="goal">Stamps goal — <span id="goalVal">${goalNum}</span></label>
          <input type="range" id="goal" name="goal" min="${MIN_GOAL}" max="${MAX_GOAL}" value="${goalNum}">
        </div>
        <div class="field colors">
          <div class="field">
            <label for="bg">Card background</label>
            <input type="color" id="bg" name="bg" value="${bg}">
          </div>
          <div class="field">
            <label for="active">Active stamp</label>
            <input type="color" id="active" name="active" value="${active}">
          </div>
          <div class="field">
            <label for="inactive">Inactive stamp</label>
            <input type="color" id="inactive" name="inactive" value="${inactive}">
          </div>
        </div>
        <div class="field preview-panel">
          <img id="preview" src="/preview.png?${previewQs.toString()}" alt="Live stamp strip preview" width="375" height="144">
        </div>
        <button class="btn" type="submit">Create card</button>
        <a class="btn secondary" href="/app">Cancel</a>
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
  return layout('Create card', AUTH_BANNER + body);
}

async function handleNewCardForm(res: http.ServerResponse): Promise<void> {
  sendHtml(res, 200, renderNewCardForm());
}

// ---------------------------------------------------------------------------
// Route: POST /cards — validate, persist, redirect
// ---------------------------------------------------------------------------
async function handleCreateCard(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let fields: querystring.ParsedUrlQuery;
  try {
    fields = await readUrlencodedBody(req);
  } catch (err) {
    const status = isHttpError(err) ? err.statusCode : 400;
    const message = err instanceof Error ? err.message : String(err);
    sendHtml(res, status, layout('Error', `<div class="panel"><h1>${status}</h1><p>${escapeHtml(message)}</p></div>`));
    return;
  }

  const name = String(fields.name ?? '').trim();
  const rewardText = String(fields.rewardText ?? '').trim();
  const goalRaw = fields.goal;
  const bg = String(fields.bg ?? '').trim();
  const active = String(fields.active ?? '').trim();
  const inactive = String(fields.inactive ?? '').trim();

  const errors: string[] = [];
  if (!name) errors.push('Card name is required.');
  if (name.length > 80) errors.push('Card name is too long (max 80 characters).');
  if (!rewardText) errors.push('Reward text is required.');
  if (rewardText.length > 120) errors.push('Reward text is too long (max 120 characters).');

  const goalNum = Number.parseInt(String(goalRaw), 10);
  if (!Number.isInteger(goalNum) || goalNum < MIN_GOAL || goalNum > MAX_GOAL) {
    errors.push(`Stamps goal must be a whole number between ${MIN_GOAL} and ${MAX_GOAL}.`);
  }
  if (!HEX_RE.test(bg)) errors.push('Card background must be a valid colour.');
  if (!HEX_RE.test(active)) errors.push('Active stamp colour must be a valid colour.');
  if (!HEX_RE.test(inactive)) errors.push('Inactive stamp colour must be a valid colour.');

  if (errors.length) {
    sendHtml(
      res,
      400,
      renderNewCardForm({ name, rewardText, goal: Number.isFinite(goalNum) ? goalNum : 8, bg: bg || '#203757', active: active || '#F96400', inactive: inactive || '#8794A5' }, errors.join(' '))
    );
    return;
  }

  const bgColor = bg.startsWith('#') ? bg : `#${bg}`;
  const stampActive = active.startsWith('#') ? active : `#${active}`;
  const stampInactive = inactive.startsWith('#') ? inactive : `#${inactive}`;

  const merchant = await getOrCreateMerchant();
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

  res.writeHead(303, { Location: `/cards/${card.id}` });
  res.end();
}

// ---------------------------------------------------------------------------
// Route: GET /cards/:id — card detail with enrol URL + QR
// ---------------------------------------------------------------------------
async function handleCardDetail(res: http.ServerResponse, id: string): Promise<void> {
  const card = await prisma.card.findUnique({ where: { id } });
  if (!card) {
    sendNotFound(res, `No card with id "${id}".`);
    return;
  }

  const enrolUrl = `${PUBLIC_URL}/${card.linkCode}`;
  const stripQs = new URLSearchParams({
    goal: String(card.stampsGoal),
    filled: String(defaultFilled(card.stampsGoal)),
    bg: card.bgColor,
    active: card.stampActive,
    inactive: card.stampInactive,
    scale: '2',
  });
  const qrQs = new URLSearchParams({ data: enrolUrl });

  const body = `
    <div class="row" style="margin-bottom:18px;">
      <h1>${escapeHtml(card.name)}</h1>
      <div>
        <a class="btn" href="/stamp">Stamp a card</a>
        <a class="btn secondary" href="/app">All cards</a>
      </div>
    </div>
    <div class="panel">
      <div class="preview-panel" style="margin-bottom:20px;">
        <img src="/preview.png?${stripQs.toString()}" alt="${escapeHtml(card.name)} stamp strip" width="375" height="144" style="max-width:375px;">
      </div>
      <dl class="kv">
        <dt>Reward</dt><dd>${escapeHtml(card.rewardText)}</dd>
        <dt>Stamps goal</dt><dd>${card.stampsGoal}</dd>
        <dt>Short code</dt><dd><code class="pill">${escapeHtml(card.shortCode)}</code></dd>
        <dt>Enrol URL</dt><dd><code class="pill">${escapeHtml(enrolUrl)}</code></dd>
      </dl>
    </div>
    <div class="panel">
      <h2>Scan to enrol</h2>
      <div class="qr-wrap">
        <img src="/qr.png?${qrQs.toString()}" alt="QR code for ${escapeHtml(enrolUrl)}">
      </div>
      <p class="muted" style="margin-top:14px;">${
        PUBLIC_BASE_URL
          ? `The QR points at ${escapeHtml(PUBLIC_URL)}.`
          : `Open this page from an iPhone on the same network — the QR points at ${escapeHtml(PUBLIC_URL)}.`
      }</p>
    </div>
  `;
  sendHtml(res, 200, layout(card.name, AUTH_BANNER + body));
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
// supporting lines, an empty-card strip preview, a consent checkbox and one
// primary "Add to Apple Wallet" button. Plain HTML/CSS, no framework, no
// external assets, no JavaScript — the checkbox uses the `required`
// attribute so the browser itself blocks submission until it is ticked.
// Name and phone are both optional, marked as such, never required.
// ---------------------------------------------------------------------------
function renderEnrolPage(card: Card): string {
  const stripQs = new URLSearchParams({
    goal: String(card.stampsGoal),
    filled: '0', // the enrol page always shows an empty card, not the pass's starter stamps
    bg: card.bgColor,
    active: card.stampActive,
    inactive: card.stampInactive,
    scale: '2',
  });
  const fg = card.fgColor || '#FFFFFF';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(card.name)} · Join the loyalty card</title>
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
  button.cta {
    display: block;
    width: 100%;
    border: none;
    border-radius: 100px;
    padding: 16px 20px;
    font-size: 17px;
    font-weight: 700;
    color: #fff;
    background: ${card.stampActive};
    cursor: pointer;
  }
  button.cta:active { opacity: 0.9; }
  .powered { margin-top: 28px; font-size: 12px; opacity: 0.6; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(card.rewardText)}</h1>
  <p class="lede">Show this page at ${escapeHtml(card.name)} every visit to collect a stamp.</p>
  <p class="lede">Collect ${card.stampsGoal} stamps to get your reward.</p>
  <div class="strip">
    <img src="/preview.png?${stripQs.toString()}" alt="${escapeHtml(card.name)} empty stamp card" width="375" height="144">
  </div>
  <form method="POST" action="/${card.linkCode}/pass">
    <div class="field">
      <label for="name">Name <span class="opt">(optional)</span></label>
      <input type="text" id="name" name="name" maxlength="80" autocomplete="name" placeholder="Your name">
    </div>
    <div class="field">
      <label for="phone">Phone <span class="opt">(optional)</span></label>
      <input type="tel" id="phone" name="phone" maxlength="30" autocomplete="tel" placeholder="Your phone number">
    </div>
    <label class="consent">
      <input type="checkbox" name="consent" required>
      <span>I agree to join ${escapeHtml(card.name)}'s loyalty card and receive updates about my rewards.</span>
    </label>
    <button class="cta" type="submit">Add to Apple Wallet</button>
  </form>
  <p class="powered">Powered by LoyaNexa</p>
</main>
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

function buildPassImagesFor(
  card: Card,
  stripSet: Pick<PassImages, 'strip.png' | 'strip@2x.png' | 'strip@3x.png'>
): PassImages {
  return {
    'icon.png': makeCardIcon(29, card.bgColor, card.stampActive),
    'icon@2x.png': makeCardIcon(58, card.bgColor, card.stampActive),
    'strip.png': stripSet['strip.png'],
    'strip@2x.png': stripSet['strip@2x.png'],
    'strip@3x.png': stripSet['strip@3x.png'],
  };
}

/**
 * pass.json content for `pass` on `card`. Includes `webServiceURL` /
 * `authenticationToken` only when `PUBLIC_BASE_URL` is configured — see
 * `PassContent`'s doc comment in buildPass.ts for why both-or-neither
 * matters. `webServiceURL` is the app's public origin plus `/apple`; Apple
 * appends `/v1/...` itself, matching this file's own `/apple/v1/...`
 * routes below.
 */
function buildPassContentFor(card: Card, pass: Pass): PassContent {
  const stampsRemaining = Math.max(card.stampsGoal - pass.stamps, 0);
  return {
    serialNumber: pass.serial,
    organizationName: card.name,
    description: `${card.name} loyalty card`,
    logoText: card.name,
    backgroundColor: card.bgColor,
    foregroundColor: card.fgColor,
    primaryFields: [{ key: 'reward', label: 'REWARD', value: card.rewardText }],
    secondaryFields: [
      { key: 'rewards', label: 'REWARDS', value: `${pass.rewards} rewards` },
      {
        key: 'stampsRemaining',
        label: 'STAMPS REMAINING',
        // The visible count already changes whenever a stamp lands, which
        // is normally enough to make iOS show the lock-screen banner
        // (BUILD.md §9.3) — but "normally" isn't "always" (a reward can
        // reset the count back to a value it held before, or this pass can
        // get rebuilt with nothing to say). invisibleChangeMarker() makes
        // the field's *text* unique on every single rebuild without ever
        // changing what the customer sees — see its doc comment in
        // buildPass.ts before deleting this thinking it's noise.
        value: `${stampsRemaining} stamps${invisibleChangeMarker()}`,
        changeMessage: '%@',
      },
    ],
    backFields: [{ key: 'terms', label: 'Terms', value: buildTermsText(card) }],
    barcodeMessage: pass.serial,
    ...(PUBLIC_BASE_URL
      ? { webServiceURL: `${PUBLIC_BASE_URL}/apple`, authenticationToken: pass.authToken }
      : {}),
  };
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

  let fields: querystring.ParsedUrlQuery = {};
  try {
    fields = await readUrlencodedBody(req);
  } catch {
    // A malformed/oversized body should not block enrolment — name and
    // phone are optional, so fall back to "none supplied" rather than 4xx.
    fields = {};
  }
  const custName = String(fields.name ?? '').trim().slice(0, 80);
  const custPhone = String(fields.phone ?? '').trim().slice(0, 30);

  const credentials = resolveAppleCredentials();

  const stamps = card.starterStamps;
  const stripSet = await renderAllDensities(PASS_STRIP_STORE, {
    goal: card.stampsGoal,
    filled: stamps,
    shape: 'circle',
    bgColor: card.bgColor,
    bgOpacity: 1,
    activeColor: card.stampActive,
    inactiveColor: card.stampInactive,
  });
  const images = buildPassImagesFor(card, stripSet);

  let pass: Pass | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    const serial = crypto.randomBytes(14).toString('base64url').slice(0, 18); // 18 random base64url chars
    const shortCode = generateShortCode(); // 8 uppercase hex chars
    const authToken = crypto.randomBytes(24).toString('base64url'); // 32 random chars
    try {
      pass = await prisma.pass.create({
        data: {
          serial,
          shortCode,
          cardId: card.id,
          merchantId: card.merchantId,
          authToken,
          stamps,
          custName,
          custPhone,
        },
      });
      break;
    } catch (err) {
      // P2002: unique constraint failed (serial or shortCode collision) — retry with fresh values.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && attempt < 4) continue;
      throw err;
    }
  }
  if (!pass) {
    // Unreachable in practice, same shape as the card-creation loop above.
    throw new Error('pass creation loop exited without creating a pass or throwing');
  }

  const content = buildPassContentFor(card, pass);

  const pkpass = buildPass(credentials, content, images);

  await prisma.stampEvent.create({
    data: {
      merchantId: card.merchantId,
      cardId: card.id,
      serial: pass.serial,
      kind: 'ENROLL',
    },
  });

  res.writeHead(200, {
    'Content-Type': 'application/vnd.apple.pkpass',
    'Content-Length': pkpass.length,
    'Content-Disposition': `attachment; filename="${passFilenameStem(card.name)}.pkpass"`,
    'Cache-Control': 'no-store',
  });
  res.end(pkpass);
}

// ---------------------------------------------------------------------------
// Route: GET /preview.png — on-the-fly strip render. Every input clamped or
// substituted with a safe default before it reaches renderStrip.
// ---------------------------------------------------------------------------
function handlePreviewPng(res: http.ServerResponse, query: URLSearchParams): void {
  const goal = clampInt(query.get('goal'), MIN_GOAL, MAX_GOAL, 8);
  const filled = clampInt(query.get('filled'), 0, goal, defaultFilled(goal));
  const bg = validHex(query.get('bg'), '#203757');
  const active = validHex(query.get('active'), '#F96400');
  const inactive = validHex(query.get('inactive'), '#8794A5');
  const scaleRaw = Number.parseInt(String(query.get('scale') ?? '1'), 10);
  const scale: 1 | 2 | 3 = scaleRaw === 2 || scaleRaw === 3 ? scaleRaw : 1;

  const png = renderStrip({
    goal,
    filled,
    shape: 'circle',
    bgColor: bg,
    bgOpacity: 1,
    activeColor: active,
    inactiveColor: inactive,
    scale,
  });
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
  let png: Buffer;
  try {
    png = renderQrPng(data.trim());
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
function renderStampScreen(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stamp a card · LoyaNexa</title>
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
    display: flex; align-items: center; justify-content: space-between;
    padding: 18px 20px; border-bottom: 1px solid var(--line);
  }
  header.top a.back { color: var(--ink-2); text-decoration: none; font-weight: 600; font-size: 15px; }
  header.top span.brand { font-weight: 700; }
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
<header class="top">
  <a class="back" href="/app">&larr; All cards</a>
  <span class="brand">LoyaNexa · Stamp</span>
</header>
<main>
  <h1>Stamp a card</h1>
  <p class="sub">Scan the QR inside the customer's wallet pass, or type their code below.</p>
  <div class="notice">No staff PIN yet in this local demo — anyone who can reach this screen can stamp a card. PIN lock arrives with Firebase auth (sub-project 4).</div>

  <div id="result" role="status" aria-live="polite"></div>

  <div class="panel">
    <h2>Camera</h2>
    <div class="camera-wrap">
      <video id="video" playsinline muted></video>
    </div>
    <p class="camera-status" id="cameraStatus">Starting camera…</p>
  </div>

  <div class="panel">
    <h2>Manual entry</h2>
    <form class="manual" id="manualForm">
      <div class="field">
        <label for="manualCode">Serial or short code</label>
        <input type="text" id="manualCode" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="e.g. AB12CD34" required>
      </div>
      <button class="stamp-btn" type="submit" id="manualSubmit">Stamp</button>
    </form>
  </div>
</main>
<canvas id="canvas" style="display:none;"></canvas>
<script src="/jsQR.js"></script>
<script>
(function () {
  'use strict';

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
        var message = result.data && result.data.message ? result.data.message : 'Something went wrong.';
        showResult(result.ok, message);
      })
      .catch(function () {
        showResult(false, 'Network error — check the connection and try again.');
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

function handleStampScreen(res: http.ServerResponse): void {
  sendHtml(res, 200, renderStampScreen());
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
async function handleApiStamp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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

  const outcome = await applyStamp(code);

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

  // Fire the live-update push only *after* the response above has been
  // handed to the socket, and never awaited by this handler — BUILD.md §18
  // item 6: fanning APNs out inside a request handler is what times a
  // stamp request out. setImmediate defers this past the current
  // synchronous turn (and past res.end() flushing) so a slow or failed
  // push can never slow down, let alone fail, the stamp itself.
  setImmediate(() => {
    pushPassUpdate(outcome.serial).catch((err) => {
      console.error(`[apns] push fan-out threw for pass ${outcome.serial}:`, err);
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
  const result = await getUpdatedSerials({
    deviceId,
    authHeader: applePassAuthHeader(req),
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
  const stripSet = await renderAllDensities(PASS_STRIP_STORE, {
    goal: pass.card.stampsGoal,
    filled: pass.stamps,
    shape: 'circle',
    bgColor: pass.card.bgColor,
    bgOpacity: 1,
    activeColor: pass.card.stampActive,
    inactiveColor: pass.card.stampInactive,
  });
  const images = buildPassImagesFor(pass.card, stripSet);
  const content = buildPassContentFor(pass.card, pass);
  const pkpass = buildPass(credentials, content, images);

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
    if (req.method === 'GET' && pathname === '/app') {
      await handleCardsList(res);
      return;
    }
    if (req.method === 'GET' && pathname === '/cards/new') {
      await handleNewCardForm(res);
      return;
    }
    if (req.method === 'POST' && pathname === '/cards') {
      await handleCreateCard(req, res);
      return;
    }
    if (req.method === 'GET' && pathname === '/preview.png') {
      handlePreviewPng(res, url.searchParams);
      return;
    }
    if (req.method === 'GET' && pathname === '/qr.png') {
      handleQrPng(res, url.searchParams);
      return;
    }
    const cardMatch = pathname.match(/^\/cards\/([^/]+)$/);
    const cardId = cardMatch?.[1];
    if (req.method === 'GET' && cardId !== undefined) {
      await handleCardDetail(res, cardId);
      return;
    }
    // /stamp and /api/stamp are literal paths and must be registered here —
    // above the `GET /:code` catch-all below — or the catch-all would
    // swallow them (BUILD.md §12 / §18 item 10).
    if (req.method === 'GET' && pathname === '/stamp') {
      handleStampScreen(res);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/stamp') {
      await handleApiStamp(req, res);
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
    // literal path (including this section's own POST /:code/pass, which
    // is a distinct two-segment pattern) is matched first.
    const passIssueMatch = pathname.match(/^\/([^/]+)\/pass$/);
    if (req.method === 'POST' && passIssueMatch) {
      await handleIssuePass(req, res, passIssueMatch[1]!);
      return;
    }
    const enrolMatch = pathname.match(/^\/([^/]+)$/);
    if (req.method === 'GET' && enrolMatch) {
      await handleEnrolPage(res, enrolMatch[1]!);
      return;
    }

    sendNotFound(res, `No route for ${req.method} ${pathname}.`);
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      sendHtml(res, 500, layout('Error', `<div class="panel"><h1>500</h1><p>${escapeHtml(message)}</p></div>`));
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
});

process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
