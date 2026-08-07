// apps/demo/test/locationsUi.test.ts — the locations editor as it actually
// ships: the client-side helpers, extracted from the rendered page and run,
// and the /api/places/* routes that back the business search box.
//
// The route tests deliberately run with no GOOGLE_MAPS_API_KEY, which is the
// configuration a fresh checkout has. They cover the guards — who may call,
// what a malformed body does, how a missing key is reported — none of which
// need a Google account. apps/demo/test/placeSearch.test.ts covers the
// parsing of real upstream payloads.
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
      // One saved location, so the page renders a real row rather than only
      // the client-side template — the hidden coordinate inputs below exist
      // only on rendered rows.
      locations: [
        {
          name: 'Downtown',
          latitude: 24.7136,
          longitude: 46.6753,
          address: 'King Fahd Rd, Al Olaya, Riyadh',
        },
      ],
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

test('the browser never talks to Google directly, and the API key never reaches the page', async () => {
  // Business search replaced the "no geocoding at all" rule with a narrower
  // one: search text leaves the browser, but only ever to *us*. Everything
  // upstream happens server-side (apps/demo/placeSearch.ts), which is what
  // lets the key be IP-restricted rather than referrer-restricted — a
  // restriction anyone can forge.
  const html = await (await fetch(`${baseUrl}/cards/${cardId}/edit`, { headers: { Cookie: cookie } })).text();

  // Matches a CALL, not the word: the code comments legitimately name these
  // services, and fonts.googleapis.com is unrelated.
  assert.ok(
    !/(fetch|XMLHttpRequest|src\s*=)[^\n]{0,120}https?:\/\/[^"'\s]*(places\.googleapis|maps\.googleapis|nominatim|mapbox)/i.test(html),
    'the page must reach Google only through our own /api/places/* proxy'
  );
  assert.match(html, /'\/api\/places\/search'/, 'search goes through the proxy');
  assert.match(html, /'\/api\/places\/details'/, 'details goes through the proxy');

  // The key is server-only. If it ever renders into the page, an IP
  // restriction protects nothing and the free tier belongs to whoever reads
  // the HTML.
  const key = (process.env.GOOGLE_MAPS_API_KEY ?? '').trim();
  if (key) assert.ok(!html.includes(key), 'GOOGLE_MAPS_API_KEY must never be rendered');
  assert.ok(!/X-Goog-Api-Key/i.test(html), 'the upstream key header belongs on the server');
});

test('the designer submits coordinates without ever showing them', async () => {
  // The whole point of the change: a merchant picks a business by name and
  // never sees a latitude. The coordinates still ship inside the pass, so
  // they must still be submitted — as hidden inputs the search fills in.
  const html = await (await fetch(`${baseUrl}/cards/${cardId}/edit`, { headers: { Cookie: cookie } })).text();

  assert.match(html, /<input type="hidden" name="locations\[0\]\[lat\]"/, 'latitude is submitted, not typed');
  assert.match(html, /<input type="hidden" name="locations\[0\]\[lng\]"/, 'longitude is submitted, not typed');
  assert.match(html, /<input type="hidden" name="locations\[0\]\[address\]"/, 'the chosen address round-trips');

  // No visible coordinate control of any kind may survive.
  assert.ok(!/inputmode="decimal"[^>]*data-(lat|lng)/.test(html), 'no typed coordinate field may remain');
  assert.ok(!/>\s*Latitude\s*</.test(html), 'the Latitude label is gone');
  assert.ok(!/>\s*Longitude\s*</.test(html), 'the Longitude label is gone');
});

test('search and "use my current location" are both offered, and neither is the only way through', async () => {
  const html = await (await fetch(`${baseUrl}/cards/${cardId}/edit`, { headers: { Cookie: cookie } })).text();

  assert.match(html, /data-place-search/, 'the business search box is rendered');
  assert.match(html, /data-use-current-location/, 'GPS remains an option, not a replacement');
  // The paste box still ships, hidden, as the fallback for a missing key or
  // an unreachable Google — a merchant must never be stranded mid-edit by
  // someone else's outage.
  assert.match(html, /data-paste-fallback/, 'the paste fallback still exists');
  assert.match(html, /function parseCoords\(/, 'and its parser is still wired up');
});

// ---------------------------------------------------------------------------
// POST /api/places/* — the proxy in front of Google. These are the only
// routes on this server that cost money per call, so the guards matter more
// than usual.
// ---------------------------------------------------------------------------

/** The `error` slug from a places route's JSON body. */
async function errorOf(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { error?: string }).error;
}

function postPlaces(path: string, body: unknown, withSession = true): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(withSession ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

test('the places routes refuse an anonymous caller with a JSON 401, not a redirect to /signin', async () => {
  // A 302 would hand a fetch() the sign-in page's HTML with a 200 on it,
  // which a JSON client reads as success — and would make our Places quota
  // free for anyone who found the URL.
  for (const path of ['/api/places/search', '/api/places/details', '/api/places/reverse']) {
    const res = await postPlaces(path, { query: 'coffee' }, false);
    assert.equal(res.status, 401, `${path} must require a merchant session`);
    assert.equal(await errorOf(res), 'unauthenticated');
  }
});

test('a query too short to be worth paying for answers empty, not an error', async () => {
  // The merchant is still typing. A 400 here would be a red error message
  // flashing on every first keystroke.
  const res = await postPlaces('/api/places/search', { query: 'a' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { suggestions: [] });
});

test('a malformed place id is rejected before it can reach a URL', async () => {
  for (const placeId of ['../../secrets', 'has space', '', null]) {
    const res = await postPlaces('/api/places/details', { placeId });
    assert.equal(res.status, 400, `place id ${JSON.stringify(placeId)} must be refused`);
    assert.equal(await errorOf(res), 'invalid_place_id');
  }
});

test('reverse geocoding refuses coordinates that are not coordinates', async () => {
  for (const body of [
    { latitude: 91, longitude: 0 },
    { latitude: 0, longitude: 181 },
    { latitude: '24.7', longitude: '46.6' },
    {},
  ]) {
    const res = await postPlaces('/api/places/reverse', body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} must be refused`);
    assert.equal(await errorOf(res), 'invalid_coordinates');
  }
});

test('with no API key configured, a real search reports 503 rather than pretending', async () => {
  // 503, not 500: nothing here is broken, the upstream is simply not
  // configured. The designer reads any failure as "reveal the paste box",
  // which is exactly the right response to this one.
  if ((process.env.GOOGLE_MAPS_API_KEY ?? '').trim()) return; // a key is configured; nothing to assert
  const res = await postPlaces('/api/places/search', { query: 'Loyanexa Cafe' });
  assert.equal(res.status, 503);
  assert.equal(await errorOf(res), 'disabled');
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
