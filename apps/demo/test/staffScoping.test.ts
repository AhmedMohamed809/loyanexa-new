// apps/demo/test/staffScoping.test.ts — the staff-PIN counterpart to
// scoping.test.ts: proves a staff session can open the stamp screen and
// stamp, and is refused everywhere else — this is the entire point of the
// feature (BUILD.md §8.13's job brief: "write a test per protected route
// proving a staff session is refused"). Spawns the real server as a child
// process against the real local Postgres, no mocks.

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
const { createStaffSession, STAFF_SESSION_COOKIE_NAME } = await import('../staffAuth.ts');
const { createStaff } = await import('../staff.ts');

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}
function randomLinkCode(): number {
  return 500_000_000 + Math.floor(Math.random() * 500_000_000);
}
function randomPort(): number {
  return 41000 + Math.floor(Math.random() * 3000);
}

interface SpawnedServer {
  baseUrl: string;
  proc: ChildProcessByStdio<null, Readable, Readable>;
  close(): Promise<void>;
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

interface Fixture {
  merchantId: string;
  merchantEmail: string;
  cardId: string;
  passSerial: string;
  passShortCode: string;
  staffId: string;
  staffCookie: string;
}

/** A merchant with one active card, one enrolled customer (Pass, stampable), and one active staff member with a known PIN — plus a real StaffSession cookie for that staff member, minted directly (bypassing the PIN-login HTTP flow, which is covered separately below). */
async function makeFixture(pin = '4821'): Promise<Fixture> {
  const email = `staffscope-${randomHex(8)}@example.test`;
  const merchant = await prisma.merchant.create({ data: { subStatus: 'trialing', trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), email, name: 'Staff Scoping Test' } });
  const card = await prisma.card.create({
    data: {
      merchantId: merchant.id,
      slot: 1,
      linkCode: randomLinkCode(),
      shortCode: `C${randomHex(4)}`.toUpperCase(),
      name: 'Staff Scoping Card',
      stampsGoal: 8,
      bgColor: '#203757',
      fgColor: '#FFFFFF',
      stampActive: '#F96400',
      stampInactive: '#8794A5',
      rewardText: 'Free coffee',
      active: true,
    },
  });
  const pass = await prisma.pass.create({
    data: {
      serial: `STAFFSER${randomHex(8)}`.toUpperCase(),
      shortCode: `P${randomHex(4)}`.toUpperCase(),
      cardId: card.id,
      merchantId: merchant.id,
      authToken: randomHex(12),
      custName: 'Staff Scoping Customer',
    },
  });
  const staff = await createStaff(merchant.id, 'Test Barista', pin);
  const session = await createStaffSession(staff.id, merchant.id);
  return {
    merchantId: merchant.id,
    merchantEmail: email,
    cardId: card.id,
    passSerial: pass.serial,
    passShortCode: pass.shortCode,
    staffId: staff.id,
    staffCookie: `${STAFF_SESSION_COOKIE_NAME}=${session.id}`,
  };
}

async function cleanupMerchant(merchantId: string): Promise<void> {
  await prisma.stampEvent.deleteMany({ where: { merchantId } });
  await prisma.merchant.delete({ where: { id: merchantId } }).catch(() => {});
}

let server: SpawnedServer;

before(async () => {
  server = await spawnServer();
});

after(async () => {
  await server.close();
});

// ---------------------------------------------------------------------------
// A staff session opens the stamp screen and can stamp.
// ---------------------------------------------------------------------------

test('a staff session opens GET /stamp (200, shows the stamp screen, not the PIN form)', async () => {
  const fx = await makeFixture();
  try {
    const res = await fetch(`${server.baseUrl}/stamp`, { headers: { Cookie: fx.staffCookie } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('id="video"'), 'the real stamp screen (camera scanner) must render for a valid staff session');
    assert.ok(!html.includes('name="pin"'), 'the PIN entry form must not render for an already-authenticated staff session');
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('a staff session can stamp via POST /api/stamp, and StampEvent.staffId records who did it', async () => {
  const fx = await makeFixture();
  try {
    const res = await fetch(`${server.baseUrl}/api/stamp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: fx.staffCookie },
      body: JSON.stringify({ code: fx.passSerial }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { ok: boolean; stamps: number };
    assert.equal(json.ok, true);
    assert.equal(json.stamps, 1);

    const event = await prisma.stampEvent.findFirstOrThrow({ where: { serial: fx.passSerial, kind: 'STAMP' } });
    assert.equal(event.staffId, fx.staffId, "StampEvent.staffId must record which staff member stamped");
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('a staff session can also stamp by the manual-entry short code', async () => {
  const fx = await makeFixture();
  try {
    const res = await fetch(`${server.baseUrl}/api/stamp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: fx.staffCookie },
      body: JSON.stringify({ code: fx.passShortCode }),
    });
    assert.equal(res.status, 200);
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

// ---------------------------------------------------------------------------
// The whole point of the feature: one test per protected route proving a
// staff session is refused. Every one of these 302s to /signin exactly as
// if there were no session at all — requireMerchant() never recognises the
// `lnx-staff` cookie (it only ever reads `lnx-session`), so a staff session
// is simply invisible to it.
// ---------------------------------------------------------------------------

test('a staff session is refused (302 -> /signin) on GET /app', async () => {
  const fx = await makeFixture();
  try {
    const res = await fetch(`${server.baseUrl}/app`, { headers: { Cookie: fx.staffCookie }, redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') ?? '', /^\/signin/);
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('a staff session is refused (302 -> /signin) on GET /customers', async () => {
  const fx = await makeFixture();
  try {
    const res = await fetch(`${server.baseUrl}/customers`, { headers: { Cookie: fx.staffCookie }, redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') ?? '', /^\/signin/);
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('a staff session is refused (302 -> /signin) on GET /customers/export.csv', async () => {
  const fx = await makeFixture();
  try {
    const res = await fetch(`${server.baseUrl}/customers/export.csv`, { headers: { Cookie: fx.staffCookie }, redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') ?? '', /^\/signin/);
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('a staff session is refused (302 -> /signin) on GET /reports', async () => {
  const fx = await makeFixture();
  try {
    const res = await fetch(`${server.baseUrl}/reports`, { headers: { Cookie: fx.staffCookie }, redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') ?? '', /^\/signin/);
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('a staff session is refused (302 -> /signin) on GET /settings', async () => {
  const fx = await makeFixture();
  try {
    const res = await fetch(`${server.baseUrl}/settings`, { headers: { Cookie: fx.staffCookie }, redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') ?? '', /^\/signin/);
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('a staff session is refused (302 -> /signin) on POST /staff (adding another staff member)', async () => {
  const fx = await makeFixture();
  try {
    const res = await fetch(`${server.baseUrl}/staff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: fx.staffCookie },
      body: new URLSearchParams({ name: 'Sneaky New Staff', pin: '9999' }).toString(),
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') ?? '', /^\/signin/);

    const staffCount = await prisma.staff.count({ where: { merchantId: fx.merchantId } });
    assert.equal(staffCount, 1, 'no new staff row must have been created — only the fixture\'s own');
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('a staff session is refused (302 -> /signin) on card editing — GET and POST /cards/:id/edit', async () => {
  const fx = await makeFixture();
  try {
    const getRes = await fetch(`${server.baseUrl}/cards/${fx.cardId}/edit`, { headers: { Cookie: fx.staffCookie }, redirect: 'manual' });
    assert.equal(getRes.status, 302);
    assert.match(getRes.headers.get('location') ?? '', /^\/signin/);

    const postRes = await fetch(`${server.baseUrl}/cards/${fx.cardId}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: fx.staffCookie },
      body: new URLSearchParams({ name: 'Hijacked By Staff' }).toString(),
      redirect: 'manual',
    });
    assert.equal(postRes.status, 302);
    assert.match(postRes.headers.get('location') ?? '', /^\/signin/);

    const card = await prisma.card.findUniqueOrThrow({ where: { id: fx.cardId } });
    assert.equal(card.name, 'Staff Scoping Card', "the card must be untouched by a staff session's attempted edit");
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('a staff session is refused (302 -> /signin) on GET /cards/:id (card detail), /cards/:id/print, /cards/:id/activate, /cards/new, and POST /cards', async () => {
  const fx = await makeFixture();
  try {
    const routes: Array<[string, string]> = [
      ['GET', `/cards/${fx.cardId}`],
      ['GET', `/cards/${fx.cardId}/print`],
      ['GET', `/cards/${fx.cardId}/activate`],
      ['GET', '/cards/new'],
    ];
    for (const [method, p] of routes) {
      const res = await fetch(`${server.baseUrl}${p}`, { method, headers: { Cookie: fx.staffCookie }, redirect: 'manual' });
      assert.equal(res.status, 302, `${method} ${p} with a staff session should redirect, got ${res.status}`);
      assert.match(res.headers.get('location') ?? '', /^\/signin/, `${method} ${p} should redirect to /signin`);
    }

    const postCards = await fetch(`${server.baseUrl}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: fx.staffCookie },
      body: new URLSearchParams({ name: 'New Card By Staff', rewardText: 'Free thing', stampsGoal: '8' }).toString(),
      redirect: 'manual',
    });
    assert.equal(postCards.status, 302);
    assert.match(postCards.headers.get('location') ?? '', /^\/signin/);
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('a tampered/unknown staff cookie value is treated as no staff session at all — falls through to the PIN form, never grants access', async () => {
  const res = await fetch(`${server.baseUrl}/stamp`, {
    headers: { Cookie: `${STAFF_SESSION_COOKIE_NAME}=not-a-real-staff-session-${randomHex(8)}` },
  });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('name="pin"'), 'an invalid staff cookie must fall back to the PIN entry screen');
});

// ---------------------------------------------------------------------------
// The full PIN login HTTP flow, and lockout on repeated wrong PINs.
// ---------------------------------------------------------------------------

test('POST /stamp/pin with a correct email + PIN sets the lnx-staff cookie and redirects to /stamp; that cookie then opens the stamp screen', async () => {
  const fx = await makeFixture('7391');
  try {
    const res = await fetch(`${server.baseUrl}/stamp/pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: fx.merchantEmail, pin: '7391' }).toString(),
      redirect: 'manual',
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/stamp');
    const setCookie = res.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /lnx-staff=/);
    assert.match(setCookie, /HttpOnly/);

    const cookieValue = setCookie.split(';')[0]!;
    const stampRes = await fetch(`${server.baseUrl}/stamp`, { headers: { Cookie: cookieValue } });
    assert.equal(stampRes.status, 200);
    const html = await stampRes.text();
    assert.ok(html.includes('id="video"'));
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('POST /stamp/pin with a wrong PIN is refused (401) and never sets a staff cookie', async () => {
  const fx = await makeFixture('1122');
  try {
    const res = await fetch(`${server.baseUrl}/stamp/pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: fx.merchantEmail, pin: '0000' }).toString(),
      redirect: 'manual',
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('set-cookie'), null);
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('repeated wrong PINs lock out further attempts for that business email (429), even with the correct PIN', async () => {
  const fx = await makeFixture('6655');
  try {
    let sawLockout = false;
    for (let i = 0; i < 15; i++) {
      const res = await fetch(`${server.baseUrl}/stamp/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: fx.merchantEmail, pin: '0000' }).toString(),
        redirect: 'manual',
      });
      if (res.status === 429) {
        sawLockout = true;
        break;
      }
      assert.equal(res.status, 401, `attempt ${i} should be a plain wrong-PIN rejection until the lockout kicks in`);
    }
    assert.ok(sawLockout, 'enough wrong PINs in a row must eventually be rate-limited (429), not accepted forever');

    // Even the *correct* PIN is refused once locked out — this is the
    // actual lockout, not just a slower-but-still-working retry loop.
    const stillLocked = await fetch(`${server.baseUrl}/stamp/pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: fx.merchantEmail, pin: '6655' }).toString(),
      redirect: 'manual',
    });
    assert.equal(stillLocked.status, 429, 'the correct PIN must also be refused while locked out');
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('POST /api/stamp with no session at all (no merchant, no staff) is refused with 401, not a redirect', async () => {
  const fx = await makeFixture();
  try {
    const res = await fetch(`${server.baseUrl}/api/stamp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: fx.passSerial }),
      redirect: 'manual',
    });
    assert.equal(res.status, 401);
    const json = (await res.json()) as { ok: boolean };
    assert.equal(json.ok, false);
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('a deactivated staff member\'s PIN is refused, and their already-open session is cut off immediately', async () => {
  const fx = await makeFixture('3344');
  try {
    // The existing session (minted before deactivation) must stop working.
    await prisma.staff.update({ where: { id: fx.staffId }, data: { active: false } });

    const stampRes = await fetch(`${server.baseUrl}/stamp`, { headers: { Cookie: fx.staffCookie } });
    assert.equal(stampRes.status, 200);
    const html = await stampRes.text();
    assert.ok(html.includes('name="pin"'), 'a deactivated staff member\'s existing session must fall back to the PIN form, not the real stamp screen');

    // And a fresh PIN-login attempt with the same (still technically
    // correct) PIN must also fail.
    const loginRes = await fetch(`${server.baseUrl}/stamp/pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: fx.merchantEmail, pin: '3344' }).toString(),
      redirect: 'manual',
    });
    assert.equal(loginRes.status, 401);
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});
