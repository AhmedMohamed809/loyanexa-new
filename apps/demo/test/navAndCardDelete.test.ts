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
