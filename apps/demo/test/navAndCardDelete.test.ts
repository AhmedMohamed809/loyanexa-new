// apps/demo/test/navAndCardDelete.test.ts — the two features the owner asked
// for on 2026-08-04: a language switch reachable from the nav, and card
// deletion.
//
// Spawns the real server as a child process against the real local Postgres,
// same convention as authHttp.test.ts / httpIntegration.test.ts.
//
// The deletion tests matter more than most: it is the only irreversible
// action in the product, and the two ways it could go wrong — deleting
// someone else's card, or deleting on a mis-tap — are both silent.

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
function randomLinkCode(): number {
  return 500_000_000 + Math.floor(Math.random() * 500_000_000);
}
function randomPort(): number {
  return 49200 + Math.floor(Math.random() * 2000);
}

interface SpawnedServer {
  baseUrl: string;
  proc: ChildProcessByStdio<null, Readable, Readable>;
  close(): Promise<void>;
}

function closeProc(proc: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    proc.once('exit', () => resolve());
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    }, 3000);
  });
}

async function spawnServer(): Promise<SpawnedServer> {
  const port = randomPort();
  const proc = spawn(process.execPath, ['apps/demo/server.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DISABLE_BROADCAST_WORKER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return { baseUrl, proc, close: () => closeProc(proc) };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await closeProc(proc);
  throw new Error('server did not become healthy in time');
}

function cookieValueFrom(setCookieHeader: string | null): string | undefined {
  return setCookieHeader?.split(';')[0];
}

interface Owner {
  merchantId: string;
  cookie: string;
}

/** Signs up a fresh merchant and returns a usable session cookie. */
async function makeOwner(): Promise<Owner> {
  const email = `navdelete-${randomHex(8)}@example.test`;
  const res = await fetch(`${server.baseUrl}/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      businessName: 'Nav Delete Test Cafe',
      email,
      password: 'a genuinely strong passphrase',
    }).toString(),
    redirect: 'manual',
  });
  assert.equal(res.status, 303, 'sign-up should have succeeded');
  const cookie = cookieValueFrom(res.headers.get('set-cookie'));
  assert.ok(cookie);
  const merchant = await prisma.merchant.findUniqueOrThrow({ where: { email } });
  return { merchantId: merchant.id, cookie: cookie! };
}

async function makeCard(merchantId: string, name = 'Delete Me Card'): Promise<string> {
  // Cards are (merchantId, slot)-unique, and the owners here are shared
  // across the whole file — one test deliberately leaves its card alive, so
  // a hardcoded slot collides. Take the next free one, as the app itself does.
  const maxSlot = await prisma.card.aggregate({ where: { merchantId }, _max: { slot: true } });
  const card = await prisma.card.create({
    data: {
      merchantId,
      slot: (maxSlot._max.slot ?? 0) + 1,
      linkCode: randomLinkCode(),
      shortCode: `C${randomHex(4)}`.toUpperCase(),
      name,
      stampsGoal: 8,
      bgColor: '#203757',
      fgColor: '#FFFFFF',
      stampActive: '#F96400',
      stampInactive: '#8794A5',
      rewardText: 'Free coffee',
    },
  });
  return card.id;
}

async function cleanupMerchant(merchantId: string): Promise<void> {
  await prisma.stampEvent.deleteMany({ where: { merchantId } });
  await prisma.merchant.delete({ where: { id: merchantId } }).catch(() => {});
}

let server: SpawnedServer;

// Two owners, created ONCE for the whole file.
//
// Not one per test: POST /signup is rate-limited to 5 per IP per window
// (added deliberately — an unauthenticated scryptSync loop would otherwise
// pin the single 512MB machine), and every test here runs from 127.0.0.1.
// Signing up per test tripped that limit and failed with 429, which reads
// like a broken feature rather than a working defence. Cards are still
// created fresh per test, so nothing leaks between them.
let ownerA: Owner;
let ownerB: Owner;

before(async () => {
  server = await spawnServer();
  ownerA = await makeOwner();
  ownerB = await makeOwner();
});

after(async () => {
  await cleanupMerchant(ownerA.merchantId);
  await cleanupMerchant(ownerB.merchantId);
  await server.close();
});

// ---------------------------------------------------------------------------
// Language switch
// ---------------------------------------------------------------------------

test('GET /lang/ar sets the shared lnx-lang cookie and returns the user to the page they came from', async () => {
  const res = await fetch(`${server.baseUrl}/lang/ar`, {
    headers: { Referer: `${server.baseUrl}/reports?range=60` },
    redirect: 'manual',
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/reports?range=60', 'must come back to the same page, query intact');
  const setCookie = res.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /lnx-lang=ar/, 'must write the cookie name the landing page also uses');
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /SameSite=Lax/);
  // Deliberately NOT HttpOnly: the landing page's own toggle is client-side
  // JS and has to read this same cookie. It holds a display preference only.
  assert.doesNotMatch(setCookie, /HttpOnly/);
});

test('GET /lang/:lang refuses to become an open redirect', async () => {
  // A protocol-relative Referer is the classic open-redirect: a browser reads
  // //evil.example as "another host", not "a path on this one".
  for (const referer of [
    'https://evil.example/phish',
    '//evil.example/phish',
  ]) {
    const res = await fetch(`${server.baseUrl}/lang/en`, {
      headers: { Referer: referer },
      redirect: 'manual',
    });
    assert.equal(res.status, 303);
    assert.equal(
      res.headers.get('location'),
      '/app',
      `a cross-origin Referer (${referer}) must fall back to /app, never bounce off-site`
    );
  }
});

test('GET /lang/:lang falls back to English for an unknown language, and to /app with no Referer', async () => {
  const res = await fetch(`${server.baseUrl}/lang/klingon`, { redirect: 'manual' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/app');
  assert.match(res.headers.get('set-cookie') ?? '', /lnx-lang=en/);
});

// ---------------------------------------------------------------------------
// Transport and method hygiene (BUILD.md §15 Phase 7)
// ---------------------------------------------------------------------------

test('every shell emits the WHOLE stylesheet, not half of it', async () => {
  // The stylesheet was split into CHROME_CSS (tokens, header, tab bar) and a
  // block living inline inside layout(). Any shell that was not layout()
  // emitted only the first half — and three of them are not: the stamp
  // screen, the legal pages, and sign-in.
  //
  // The visible symptom was two browser-default white boxes on the sign-in
  // page, because the rule giving an input its background and border was in
  // the half those shells never saw. Nothing in the markup was wrong and
  // nothing failed a typecheck, which is why it survived a redesign.
  for (const path of ['/signin', '/signup', '/privacy', '/terms', '/stamp']) {
    const html = await (await fetch(`${server.baseUrl}${path}`)).text();

    // From CHROME_CSS.
    assert.match(html, /--sunk: #162338/, `${path} is missing the design tokens`);
    // From PAGE_CSS — this is the half that used to go missing.
    assert.ok(
      html.includes('input[type="email"]'),
      `${path} is missing the input styling, so its fields render as browser defaults`
    );
    assert.match(html, /\.panel \{/, `${path} is missing the panel styling`);
  }
});

test('HEAD is treated as GET, not as a 404', async () => {
  // Every HEAD in the application used to 404, including HEAD / on the
  // landing page, because the router only ever matched req.method === 'GET'.
  // Uptime monitors, link checkers and some crawlers use HEAD by default and
  // were all being told the site did not exist.
  for (const path of ['/', '/signin', '/health']) {
    const head = await fetch(`${server.baseUrl}${path}`, { method: 'HEAD' });
    const get = await fetch(`${server.baseUrl}${path}`);
    assert.equal(head.status, get.status, `HEAD ${path} must match GET ${path}`);
    assert.equal(head.headers.get('content-type'), get.headers.get('content-type'));
  }
});

test('HSTS is sent, and only when the public origin is actually HTTPS', async () => {
  // The header is conditional on PUBLIC_URL being https. That condition is
  // not decoration: max-age is a promise browsers keep even after the header
  // stops being sent, so announcing it from a host that cannot serve HTTPS
  // makes that host unreachable until the age expires. The test reads the
  // same env the server does rather than assuming either way.
  const res = await fetch(`${server.baseUrl}/signin`);
  const hsts = res.headers.get('strict-transport-security');
  const httpsOrigin = (process.env.PUBLIC_BASE_URL ?? '').startsWith('https://');

  if (httpsOrigin) {
    assert.ok(hsts, 'an https origin must send HSTS');
    assert.match(hsts!, /max-age=\d+/);
    assert.match(hsts!, /includeSubDomains/);
  } else {
    assert.equal(hsts, null, 'a plain-http origin must not announce HSTS');
  }
});

// ---------------------------------------------------------------------------
// Legal pages (BUILD.md §15 Phase 7)
// ---------------------------------------------------------------------------

test('the privacy policy and terms are public — no account needed to read them', async () => {
  // The people most likely to want the privacy policy are customers who will
  // never have an account. Putting it behind requireMerchant would make it
  // unreadable by exactly its audience.
  for (const path of ['/privacy', '/terms']) {
    const res = await fetch(`${server.baseUrl}${path}`);
    assert.equal(res.status, 200, `${path} must be readable without a session`);
    const html = await res.text();
    assert.match(html, /<html lang="(en|ar)"/);
    assert.ok(html.length > 2000, `${path} looks empty`);
  }
});

test('the legal pages follow the reader\'s language, in both directions', async () => {
  const ar = await (await fetch(`${server.baseUrl}/privacy`, { headers: { Cookie: 'lnx-lang=ar' } })).text();
  assert.match(ar, /<html lang="ar" dir="rtl"/);
  assert.ok(/[؀-ۿ]/.test(ar), 'the Arabic policy must actually be in Arabic');

  const en = await (await fetch(`${server.baseUrl}/privacy`, { headers: { Cookie: 'lnx-lang=en' } })).text();
  assert.match(en, /<html lang="en" dir="ltr"/);
  assert.ok(en.includes('Privacy policy'));
});

test('the privacy policy states the specific things this system actually does', async () => {
  // A policy that does not match the code is worse than none: it is a written
  // claim that happens to be false. These are the four the code makes true.
  const html = await (await fetch(`${server.baseUrl}/privacy`, { headers: { Cookie: 'lnx-lang=en' } })).text();

  assert.ok(/only the day and month/i.test(html), 'the discarded birth year is a real, checkable promise');
  assert.ok(/scrypt/i.test(html), 'password storage is stated');
  assert.ok(/fifteen minutes/i.test(html), 'the notification TTL is stated and is real');
  assert.ok(/We do not collect your location/i.test(html), 'geofencing happens on-device and the policy says so');
  // And the processors that genuinely receive data.
  for (const who of ['Apple', 'Google', 'Fly.io']) {
    assert.ok(html.includes(who), `${who} processes data and must be named`);
  }
});

test('the join page links to the privacy policy from the consent line itself', async () => {
  // Consent that cannot be informed is not consent. The link has to be where
  // the customer is asked to agree, not only in a footer somewhere else.
  // Made here rather than reused: the deletion tests in this file remove
  // ownerA's cards, so anything relying on one already existing is racing them.
  const cardId = await makeCard(ownerA.merchantId, 'Consent Link Card');
  const card = await prisma.card.findUniqueOrThrow({ where: { id: cardId } });
  const html = await (await fetch(`${server.baseUrl}/${card.linkCode}`)).text();
  assert.match(html, /class="consent"[\s\S]{0,400}href="\/privacy"/, 'the consent line must carry the link');
});

// ---------------------------------------------------------------------------
// Landing page -> real product
// ---------------------------------------------------------------------------

test('the landing page sends visitors to the REAL sign-up, not to a mock-up of the app', async () => {
  // The landing page shipped as a self-contained prototype: #/app/dashboard
  // and #/login rendered convincing screens that were not the product, so a
  // visitor could click "start free trial", browse a fake dashboard, and
  // never actually have an account.
  const res = await fetch(`${server.baseUrl}/`);
  assert.equal(res.status, 200);
  const html = await res.text();

  assert.ok(html.includes('href="/signup"'), 'CTAs must point at the real sign-up');
  assert.ok(html.includes('href="/signin"'), 'the header must point at the real sign-in');
  assert.ok(
    !/href="#\/(app|login)/.test(html),
    'no link may still aim at the prototype routes'
  );
  assert.ok(
    !html.includes('view=appShell(page,'),
    'the router must hand /app over to the server, not render a fake screen'
  );
});

test('an anonymous visitor is not told they are signed in', async () => {
  const html = await (await fetch(`${server.baseUrl}/`)).text();
  assert.ok(!html.includes('__LNX_SIGNED_IN__=true'), 'the flag must only appear for a real session');
});

test('a merchant who is already signed in is offered their dashboard, not a free trial', async () => {
  // The session cookie is HttpOnly, so the page cannot work this out for
  // itself — the server injects a single boolean, and nothing else.
  const html = await (await fetch(`${server.baseUrl}/`, { headers: { Cookie: ownerA.cookie } })).text();
  assert.ok(html.includes('__LNX_SIGNED_IN__=true'), 'the server must mark a signed-in visit');
  assert.ok(!html.includes('window.__LNX_SIGNED_IN__=true;</script>\n<script>'), 'injected exactly once');
  // And it must leak nothing beyond that yes/no.
  assert.ok(!html.includes(ownerA.merchantId), 'no merchant id may reach the landing page');
  assert.ok(!html.includes(ownerA.cookie.split('=')[1] ?? 'nope'), 'no session id may reach the landing page');
});

// ---------------------------------------------------------------------------
// The mobile bottom tab bar
// ---------------------------------------------------------------------------

test('every merchant page renders the bottom tab bar, and the top nav carries a language toggle', async () => {
  {
    const res = await fetch(`${server.baseUrl}/app`, { headers: { Cookie: ownerA.cookie } });
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.match(html, /class="tabbar"/, 'the bottom tab bar must be present');
    // Which language it offers depends on the current one (the dashboard
    // defaults to Arabic, matching Card/Merchant's own default locale), so
    // assert on the route rather than on a specific direction.
    assert.match(html, /href="\/lang\/(en|ar)"/, 'a language toggle must be reachable');
    // The five tabs, plus More.
    for (const href of ['/app', '/customers', '/stamp', '/notifications']) {
      assert.ok(html.includes(`href="${href}" class="tab`), `missing a tab for ${href}`);
    }
    assert.match(html, /class="tab-more"/, 'Reports and Settings must live behind More');
    // Both navs exist in the markup; CSS decides which is visible, so exactly
    // one must be shown at a time or a screen reader announces duplicates.
    assert.match(html, /\.tabbar \{ display: none; \}/, 'the tab bar must be hidden on desktop by default');
  }
});

test('EVERY merchant page shares one chrome — including /stamp, which renders its own shell', async () => {
  // /stamp does not go through layout(): it needs camera CSS no other page
  // wants, and a staff session gets a different header. That standalone shell
  // had drifted from layout()'s copy in three visible ways — its :root never
  // declared --sunk so the top bar rendered flat against the canvas, it never
  // declared .btn at all so its sign-out came out as a raw browser button,
  // and it never got the bottom tab bar. Both shells now emit CHROME_CSS.
  //
  // This walks every merchant page rather than spot-checking one, because the
  // failure was a page being *left out*, which a single-page test cannot see.
  for (const path of [
    '/app',
    '/customers',
    '/reports',
    '/stamp',
    '/notifications',
    '/settings',
    '/cards/new',
    '/cards/new/templates',
  ]) {
    const res = await fetch(`${server.baseUrl}${path}`, { headers: { Cookie: ownerA.cookie } });
    assert.equal(res.status, 200, `${path} should render`);
    const html = await res.text();

    assert.match(html, /class="tabbar"/, `${path} is missing the bottom tab bar`);
    assert.match(html, /--sunk: #162338/, `${path} is missing the --sunk token its header background uses`);
    assert.match(html, /\.btn \{/, `${path} renders .btn markup but never defines the rules`);
    assert.match(html, /\.tabbar \{ display: none; \}/, `${path} must hide the tab bar on desktop`);
    // One shared block, not two copies fighting each other.
    assert.equal(
      (html.match(/:root \{/g) ?? []).length,
      1,
      `${path} has more than one :root block — the chrome has been copied again`
    );
  }
});

// ---------------------------------------------------------------------------
// Card deletion
// ---------------------------------------------------------------------------

test('deleting a card removes it, its passes, its devices and its stamp history, and frees the slot', async () => {
  const owner = ownerA;
  {
    const cardId = await makeCard(owner.merchantId, 'Delete Me Card');
    const pass = await prisma.pass.create({
      data: {
        serial: `TESTSER${randomHex(6)}`.toUpperCase(),
        shortCode: `P${randomHex(4)}`.toUpperCase(),
        cardId,
        merchantId: owner.merchantId,
        authToken: randomHex(12),
      },
    });
    await prisma.device.create({
      data: { deviceId: `dev-${randomHex(8)}`, passSerial: pass.serial, pushToken: `tok-${randomHex(12)}` },
    });
    await prisma.stampEvent.create({
      data: { merchantId: owner.merchantId, cardId, serial: pass.serial, kind: 'STAMP' },
    });

    const res = await fetch(`${server.baseUrl}/cards/${cardId}/delete`, {
      method: 'POST',
      headers: { Cookie: owner.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ confirmName: 'Delete Me Card' }).toString(),
      redirect: 'manual',
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/app');

    assert.equal(await prisma.card.findUnique({ where: { id: cardId } }), null, 'the card must be gone');
    assert.equal(await prisma.pass.findUnique({ where: { serial: pass.serial } }), null, 'its passes must cascade');
    assert.equal(
      await prisma.device.count({ where: { passSerial: pass.serial } }),
      0,
      'its devices must cascade with the pass'
    );
    // StampEvent has no FK to Card, so nothing in Postgres cascades it — the
    // handler must delete it explicitly or it is orphaned forever.
    assert.equal(
      await prisma.stampEvent.count({ where: { cardId } }),
      0,
      'stamp history has no FK to Card and must be deleted explicitly, not orphaned'
    );
  }
});

test('deletion requires the card name typed back — a mis-tap deletes nothing', async () => {
  const owner = ownerA;
  {
    const cardId = await makeCard(owner.merchantId, 'Precious Card');

    const wrong = await fetch(`${server.baseUrl}/cards/${cardId}/delete`, {
      method: 'POST',
      headers: { Cookie: owner.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ confirmName: 'something else' }).toString(),
      redirect: 'manual',
    });
    assert.equal(wrong.status, 200, 're-renders the confirmation rather than redirecting');
    assert.ok(await prisma.card.findUnique({ where: { id: cardId } }), 'the card must survive a wrong confirmation');

    // Case and surrounding whitespace are forgiven: a phone keyboard
    // capitalising the first letter is not a signal to cancel.
    const casing = await fetch(`${server.baseUrl}/cards/${cardId}/delete`, {
      method: 'POST',
      headers: { Cookie: owner.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ confirmName: '  precious card  ' }).toString(),
      redirect: 'manual',
    });
    assert.equal(casing.status, 303);
    assert.equal(await prisma.card.findUnique({ where: { id: cardId } }), null);
  }
});

test('one merchant cannot delete another merchant\'s card, and gets 404 rather than 403 so the id is not even confirmable', async () => {
  const victim = ownerA;
  const attacker = ownerB;
  {
    const cardId = await makeCard(victim.merchantId, 'Victim Card');

    const confirmPage = await fetch(`${server.baseUrl}/cards/${cardId}/delete`, {
      headers: { Cookie: attacker.cookie },
    });
    assert.equal(confirmPage.status, 404, 'must be 404, never 403 — 403 would confirm the id exists');

    const attempt = await fetch(`${server.baseUrl}/cards/${cardId}/delete`, {
      method: 'POST',
      headers: { Cookie: attacker.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ confirmName: 'Victim Card' }).toString(),
      redirect: 'manual',
    });
    assert.equal(attempt.status, 404);
    assert.ok(
      await prisma.card.findUnique({ where: { id: cardId } }),
      "the victim's card must still exist — knowing its exact name must not be enough"
    );
  }
});

test('the delete route requires a session at all', async () => {
  const owner = ownerA;
  {
    const cardId = await makeCard(owner.merchantId, 'Signed Out Card');
    const res = await fetch(`${server.baseUrl}/cards/${cardId}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ confirmName: 'Signed Out Card' }).toString(),
      redirect: 'manual',
    });
    assert.equal(res.status, 302, 'no session must redirect to sign-in');
    assert.match(res.headers.get('location') ?? '', /\/signin/);
    assert.ok(await prisma.card.findUnique({ where: { id: cardId } }), 'nothing may be deleted without a session');
  }
});

test('the confirmation page states the real cost: how many customers hold this card', async () => {
  const owner = ownerA;
  {
    const cardId = await makeCard(owner.merchantId, 'Busy Card');
    for (let i = 0; i < 3; i++) {
      await prisma.pass.create({
        data: {
          serial: `TESTSER${randomHex(6)}`.toUpperCase(),
          shortCode: `P${randomHex(4)}`.toUpperCase(),
          cardId,
          merchantId: owner.merchantId,
          authToken: randomHex(12),
        },
      });
    }

    const res = await fetch(`${server.baseUrl}/cards/${cardId}/delete`, {
      headers: { Cookie: owner.cookie },
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('Busy Card'), 'must name the card being deleted');
    assert.match(html, /\b3\b|٣/, 'must show how many customers already hold this card');
    assert.ok(
      html.includes('stop working') || html.includes('تتوقف'),
      'must say plainly that customers\' wallet cards stop working'
    );
  }
});
