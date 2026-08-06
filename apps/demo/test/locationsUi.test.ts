// apps/demo/test/locationsUi.test.ts — the locations editor's client-side
// helpers, tested by extracting them from the page the server actually
// renders and running them.
//
// These live inside a template literal as browser JavaScript, so they cannot
// be imported. Pulling the function out of the rendered HTML and evaluating
// it is the only way to test the code that genuinely ships — a copy of the
// logic in a test file would prove nothing about the page.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import { loadEnvFile } from '../env.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
loadEnvFile(path.join(ROOT, '.env'));

const { prisma } = await import('../../../packages/db/src/index.ts');

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

let proc: ChildProcessByStdio<null, Readable, Readable>;
let baseUrl: string;
let merchantId: string;
let cardId: string;
let cookie: string;

before(async () => {
  const port = 47700 + Math.floor(Math.random() * 500);
  proc = spawn(process.execPath, ['apps/demo/server.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DISABLE_BROADCAST_WORKER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  const merchant = await prisma.merchant.create({
    data: {
      email: `locui-${randomHex(8)}@example.test`,
      name: 'Loc UI',
      subStatus: 'trialing',
      trialEndsAt: new Date(Date.now() + 7 * 86_400_000),
    },
  });
  merchantId = merchant.id;
  const sessionId = randomHex(24);
  await prisma.session.create({
    data: { id: sessionId, merchantId, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookie = `lnx-session=${sessionId}`;
  const card = await prisma.card.create({
    data: {
      merchantId, slot: 1, linkCode: 640_000_000 + Math.floor(Math.random() * 50_000_000),
      shortCode: `C${randomHex(4)}`.toUpperCase(), name: 'Loc UI Card', stampsGoal: 8,
      bgColor: '#203757', fgColor: '#FFFFFF', stampActive: '#F96400',
      stampInactive: '#8794A5', rewardText: 'Free coffee',
    },
  });
  cardId = card.id;
});

after(async () => {
  await prisma.stampEvent.deleteMany({ where: { merchantId } });
  await prisma.merchant.delete({ where: { id: merchantId } }).catch(() => {});
  proc.kill('SIGTERM');
});

/** Lifts `parseCoords` out of the rendered designer and makes it callable. */
async function shippedParseCoords(): Promise<(t: string) => { lat: number; lng: number } | null> {
  const html = await (await fetch(`${baseUrl}/cards/${cardId}/edit`, { headers: { Cookie: cookie } })).text();
  const start = html.indexOf('function parseCoords(');
  assert.ok(start > 0, 'parseCoords must be present in the rendered page');
  // Balance braces from the function's opening brace to its close.
  let depth = 0;
  let end = start;
  for (let i = html.indexOf('{', start); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  const source = html.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(`${source}; return parseCoords;`)() as (t: string) => { lat: number; lng: number } | null;
}

test('the shipped coordinate parser reads every shape a merchant is likely to paste', async () => {
  const parseCoords = await shippedParseCoords();

  // What "Share" gives you from the Google Maps app.
  assert.deepEqual(parseCoords('https://www.google.com/maps/@24.7136,46.6753,15z'), { lat: 24.7136, lng: 46.6753 });
  // What the desktop URL bar looks like on a dropped pin.
  assert.deepEqual(
    parseCoords('https://www.google.com/maps/place/Riyadh/@24.7136,46.6753,12z/data=!3m1!4b1'),
    { lat: 24.7136, lng: 46.6753 }
  );
  assert.deepEqual(parseCoords('https://maps.google.com/?q=51.5074,-0.1278'), { lat: 51.5074, lng: -0.1278 });
  // The place-detail form, where the real coordinates come after !3d!4d.
  assert.deepEqual(
    parseCoords('https://www.google.com/maps/place/X/data=!4m2!3m1!1s0x0!3d53.4808!4d-2.2426'),
    { lat: 53.4808, lng: -2.2426 }
  );
  // And someone simply typing two numbers.
  assert.deepEqual(parseCoords('24.7136, 46.6753'), { lat: 24.7136, lng: 46.6753 });
  assert.deepEqual(parseCoords('-33.8688,151.2093'), { lat: -33.8688, lng: 151.2093 });
});

test('the parser rejects rather than guesses', async () => {
  const parseCoords = await shippedParseCoords();
  assert.equal(parseCoords(''), null);
  assert.equal(parseCoords('Manchester Great Western Street'), null, 'an address is not coordinates');
  // Out of range must fail, not clamp: a clamped coordinate is a geofence
  // silently pointing at the wrong place.
  assert.equal(parseCoords('91.0, 20.0'), null);
  assert.equal(parseCoords('20.0, 181.0'), null);
});

test('an address is never sent anywhere — the parser is the whole mechanism', async () => {
  // BUILD.md §9.4 avoids geocoding precisely so no third party learns a
  // merchant's shop address. If a geocoding call ever appears, this fails.
  const html = await (await fetch(`${baseUrl}/cards/${cardId}/edit`, { headers: { Cookie: cookie } })).text();
  // Matches a CALL, not the word: the code comments legitimately explain why
  // geocoding is avoided, and fonts.googleapis.com is unrelated.
  assert.ok(
    !/https?:\/\/[^"']*(nominatim|geocode|mapbox|maps\.googleapis)/i.test(html),
    'no geocoding service may be called'
  );
});

test('geolocation failures are told apart, and an in-app browser is named', async () => {
  const html = await (await fetch(`${baseUrl}/cards/${cardId}/edit`, { headers: { Cookie: cookie } })).text();
  // One message per cause: a permission denial needs a settings change, no
  // fix needs a window, a timeout just needs another go.
  assert.match(html, /code === 1/);
  assert.match(html, /code === 3/);
  assert.match(html, /function inAppBrowser/);
  // A cached fix is accepted: a shop does not move, so a slightly stale
  // position is exactly as good and arrives instantly.
  assert.match(html, /maximumAge: 300000/);
  assert.match(html, /timeout: 20000/);
});
