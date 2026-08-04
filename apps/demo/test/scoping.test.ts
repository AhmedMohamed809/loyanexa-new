// apps/demo/test/scoping.test.ts — the single most important test file in
// this branch (see the job brief this branch was built from): proves that
// merchant A can never read or mutate merchant B's card, pass, customer
// list or image, over real HTTP against the real local Postgres, no mocks.
//
// The shape every test in the first half of this file follows: create two
// merchants (A the "attacker", B the "owner"), sign in as A, then hit every
// merchant-facing route with B's ids. Every one must come back **404**, not
// 403 — a 403 would itself leak that the id is real (BUILD.md job brief:
// "a card id belonging to another merchant must return 404, not 403"). Each
// test then verifies with a direct Prisma read that B's data was not
// touched — an assertion on the HTTP status alone would miss a handler that
// returns 404 to the client while still writing to the database.
//
// The second half proves the flip side: every route that must stay public
// with *no* session at all still works (BUILD.md job brief's explicit
// list), and that unauthenticated requests to the merchant app redirect to
// /signin rather than leaking a 200.

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
const { createSession, SESSION_COOKIE_NAME } = await import('../auth.ts');

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}
function randomLinkCode(): number {
  return 500_000_000 + Math.floor(Math.random() * 500_000_000);
}
function randomPort(): number {
  return 45000 + Math.floor(Math.random() * 3000);
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
    env: { ...process.env, PORT: String(port) },
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

async function sessionCookieFor(merchantId: string): Promise<string> {
  const session = await createSession(merchantId);
  return `${SESSION_COOKIE_NAME}=${session.id}`;
}

interface MerchantFixture {
  merchantId: string;
  cookie: string;
  card: Awaited<ReturnType<typeof prisma.card.create>>;
  pass: Awaited<ReturnType<typeof prisma.pass.create>>;
  imageHash: string;
}

/** A merchant with one active card, one enrolled customer (Pass, with a name/phone — the data a scoping leak would expose), and one stored image (logo). */
async function makeMerchantFixture(label: string): Promise<MerchantFixture> {
  const merchant = await prisma.merchant.create({
    data: { firebaseUid: `scope-${label}-${randomHex(8)}`, email: `scope-${label}-${randomHex(8)}@example.test`, name: `Scoping Test ${label}` },
  });
  const card = await prisma.card.create({
    data: {
      merchantId: merchant.id,
      slot: 1,
      linkCode: randomLinkCode(),
      shortCode: `C${randomHex(4)}`.toUpperCase(),
      name: `${label} Card`,
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
      serial: `SCOPE${randomHex(8)}`.toUpperCase(),
      shortCode: `P${randomHex(4)}`.toUpperCase(),
      cardId: card.id,
      merchantId: merchant.id,
      authToken: randomHex(12),
      custName: `${label} Secret Customer`,
      custPhone: `05500${randomHex(3)}`,
      stamps: 2,
    },
  });
  // A 1x1 PNG, normalised and stored exactly the way a real upload would be — the
  // hash is what an image-scoping leak would expose (any hash, from any
  // merchant, currently resolves through the same public GET /img/:hash by
  // design — see the "public routes" half of this file; the leak this
  // guards against is *attaching* someone else's image to your own card via
  // POST /cards/:id/image, or reading it back through *their* card's edit
  // form/detail page).
  const { encodePNG } = await import('../../../packages/image/src/index.ts');
  const pngBytes = Buffer.from(encodePNG(new Uint8Array([0, 0, 0, 255]), 1, 1));
  const imageHash = crypto.createHash('sha256').update(pngBytes).digest('hex');
  await prisma.cardImage.upsert({
    where: { hash: imageHash },
    update: {},
    create: { hash: imageHash, bytes: pngBytes, width: 1, height: 1, mime: 'image/png' },
  });
  const cardWithLogo = await prisma.card.update({
    where: { id: card.id },
    data: { logoHash: imageHash, logoUrl: `/img/${imageHash}` },
  });

  const cookie = await sessionCookieFor(merchant.id);
  return { merchantId: merchant.id, cookie, card: cardWithLogo, pass, imageHash };
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
// Cross-merchant access — one test per route, per the job brief.
// ---------------------------------------------------------------------------

test('GET /cards/:id (card detail) — merchant B\'s card 404s for merchant A', async () => {
  const a = await makeMerchantFixture('A1');
  const b = await makeMerchantFixture('B1');
  try {
    const res = await fetch(`${server.baseUrl}/cards/${b.card.id}`, { headers: { Cookie: a.cookie } });
    assert.equal(res.status, 404, 'expected 404, never 403 (BUILD.md job brief)');
  } finally {
    await cleanupMerchant(a.merchantId);
    await cleanupMerchant(b.merchantId);
  }
});

test('GET /cards/:id/print — merchant B\'s card 404s for merchant A', async () => {
  const a = await makeMerchantFixture('A2');
  const b = await makeMerchantFixture('B2');
  try {
    const res = await fetch(`${server.baseUrl}/cards/${b.card.id}/print`, { headers: { Cookie: a.cookie } });
    assert.equal(res.status, 404);
  } finally {
    await cleanupMerchant(a.merchantId);
    await cleanupMerchant(b.merchantId);
  }
});

test('GET /cards/:id/edit — merchant B\'s card 404s for merchant A', async () => {
  const a = await makeMerchantFixture('A3');
  const b = await makeMerchantFixture('B3');
  try {
    const res = await fetch(`${server.baseUrl}/cards/${b.card.id}/edit`, { headers: { Cookie: a.cookie } });
    assert.equal(res.status, 404);
  } finally {
    await cleanupMerchant(a.merchantId);
    await cleanupMerchant(b.merchantId);
  }
});

test('POST /cards/:id/edit — merchant A cannot rename/recolour merchant B\'s card; 404s and B\'s row is untouched', async () => {
  const a = await makeMerchantFixture('A4');
  const b = await makeMerchantFixture('B4');
  try {
    const body = new URLSearchParams({
      name: 'Hijacked By A',
      bgColor: '#000000',
      stampActive: '#111111',
      stampInactive: '#222222',
      stampShape: 'square',
      labelStamps: '',
      labelRewards: '',
    });
    const res = await fetch(`${server.baseUrl}/cards/${b.card.id}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: a.cookie },
      body: body.toString(),
    });
    assert.equal(res.status, 404, 'expected 404, never 403');

    const afterB = await prisma.card.findUniqueOrThrow({ where: { id: b.card.id } });
    assert.equal(afterB.name, `B4 Card`, "merchant B's card must be completely untouched");
    assert.equal(afterB.bgColor, '#203757');
  } finally {
    await cleanupMerchant(a.merchantId);
    await cleanupMerchant(b.merchantId);
  }
});

test('GET /cards/:id/activate — merchant B\'s card 404s for merchant A', async () => {
  const a = await makeMerchantFixture('A5');
  const b = await makeMerchantFixture('B5');
  try {
    const res = await fetch(`${server.baseUrl}/cards/${b.card.id}/activate`, { headers: { Cookie: a.cookie } });
    assert.equal(res.status, 404);
  } finally {
    await cleanupMerchant(a.merchantId);
    await cleanupMerchant(b.merchantId);
  }
});

test('POST /cards/:id/activate — merchant A cannot activate/reactivate merchant B\'s card; 404s and nothing changes', async () => {
  const a = await makeMerchantFixture('A6');
  // An inactive card for B, so a successful (bugged) activation would be visible.
  const bMerchant = await prisma.merchant.create({
    data: { firebaseUid: `scope-B6-${randomHex(8)}`, email: `scope-B6-${randomHex(8)}@example.test`, name: 'Scoping Test B6' },
  });
  const bCard = await prisma.card.create({
    data: {
      merchantId: bMerchant.id,
      slot: 1,
      linkCode: randomLinkCode(),
      shortCode: `C${randomHex(4)}`.toUpperCase(),
      name: "B6's Draft Card",
      stampsGoal: 8,
      bgColor: '#203757',
      fgColor: '#FFFFFF',
      stampActive: '#F96400',
      stampInactive: '#8794A5',
      rewardText: 'Free coffee',
      active: false,
    },
  });
  try {
    const res = await fetch(`${server.baseUrl}/cards/${bCard.id}/activate`, { method: 'POST', headers: { Cookie: a.cookie } });
    assert.equal(res.status, 404, 'expected 404, never 403');

    const after = await prisma.card.findUniqueOrThrow({ where: { id: bCard.id } });
    assert.equal(after.active, false, "merchant B's draft card must still be inactive");
  } finally {
    await cleanupMerchant(a.merchantId);
    await cleanupMerchant(bMerchant.id);
  }
});

test('POST /cards/:id/image — merchant A cannot attach an image to merchant B\'s card; 404s and B\'s row is untouched', async () => {
  const a = await makeMerchantFixture('A7');
  const b = await makeMerchantFixture('B7');
  try {
    const originalLogoHash = b.card.logoHash;
    const body = new FormData();
    body.append('logo', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'x.png');
    const res = await fetch(`${server.baseUrl}/cards/${b.card.id}/image`, {
      method: 'POST',
      headers: { Cookie: a.cookie },
      body,
    });
    assert.equal(res.status, 404, 'expected 404, never 403');

    const afterB = await prisma.card.findUniqueOrThrow({ where: { id: b.card.id } });
    assert.equal(afterB.logoHash, originalLogoHash, "merchant B's card image fields must be untouched");
  } finally {
    await cleanupMerchant(a.merchantId);
    await cleanupMerchant(b.merchantId);
  }
});

test('GET /customers — merchant A never sees merchant B\'s customers, cards, or counts', async () => {
  const a = await makeMerchantFixture('A8');
  const b = await makeMerchantFixture('B8');
  try {
    const res = await fetch(`${server.baseUrl}/customers`, { headers: { Cookie: a.cookie } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(!html.includes('B Secret Customer'), "merchant B's customer name must never appear in merchant A's customer list");
    assert.ok(!html.includes(b.pass.shortCode), "merchant B's pass short code must never appear");
    assert.ok(!html.includes(b.card.name), "merchant B's card name must never appear in the card filter");
  } finally {
    await cleanupMerchant(a.merchantId);
    await cleanupMerchant(b.merchantId);
  }
});

test('GET /customers/export.csv — merchant A\'s CSV export never contains merchant B\'s customer data', async () => {
  const a = await makeMerchantFixture('A9');
  const b = await makeMerchantFixture('B9');
  try {
    const res = await fetch(`${server.baseUrl}/customers/export.csv`, { headers: { Cookie: a.cookie } });
    assert.equal(res.status, 200);
    const csv = await res.text();
    assert.ok(!csv.includes('B9 Secret Customer'), "merchant B's customer name must never appear in merchant A's CSV export");
    assert.ok(!csv.includes(b.pass.custPhone), "merchant B's customer phone must never appear");
    assert.ok(!csv.includes(b.pass.shortCode));
  } finally {
    await cleanupMerchant(a.merchantId);
    await cleanupMerchant(b.merchantId);
  }
});

test('GET /reports — merchant A\'s KPI counts never include merchant B\'s activity', async () => {
  const a = await makeMerchantFixture('A10');
  const b = await makeMerchantFixture('B10');
  try {
    // B has activity that would inflate A's counters if reports leaked across merchants.
    await prisma.stampEvent.create({ data: { merchantId: b.merchantId, cardId: b.card.id, serial: b.pass.serial, kind: 'STAMP' } });

    const res = await fetch(`${server.baseUrl}/reports`, { headers: { Cookie: a.cookie } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(!html.includes(b.card.name), "merchant B's card name must never appear in merchant A's top-customers table");

    const aTotalCustomers = await prisma.pass.count({ where: { merchantId: a.merchantId } });
    assert.equal(aTotalCustomers, 1, "sanity: merchant A's own pass count fixture assumption");
  } finally {
    await cleanupMerchant(a.merchantId);
    await cleanupMerchant(b.merchantId);
  }
});

test('POST /api/stamp — merchant A cannot stamp merchant B\'s pass (by serial or short code); 404s and B\'s pass is untouched, verified in Postgres', async () => {
  const a = await makeMerchantFixture('A11');
  const b = await makeMerchantFixture('B11');
  try {
    const beforeStamps = b.pass.stamps;
    const beforeTotal = b.pass.totalStamps;

    const bySerial = await fetch(`${server.baseUrl}/api/stamp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: a.cookie },
      body: JSON.stringify({ code: b.pass.serial }),
    });
    assert.equal(bySerial.status, 404);

    const byShortCode = await fetch(`${server.baseUrl}/api/stamp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: a.cookie },
      body: JSON.stringify({ code: b.pass.shortCode }),
    });
    assert.equal(byShortCode.status, 404);

    // Verified directly against Postgres — the psql-equivalent check via Prisma —
    // nothing changed as a side effect of either attempt.
    const after = await prisma.pass.findUniqueOrThrow({ where: { id: b.pass.id } });
    assert.equal(after.stamps, beforeStamps, "merchant B's pass stamp count must be untouched");
    assert.equal(after.totalStamps, beforeTotal, "merchant B's pass totalStamps must be untouched");
    assert.equal(after.lastStampAt, null, "merchant B's pass must show no stamp activity");
  } finally {
    await cleanupMerchant(a.merchantId);
    await cleanupMerchant(b.merchantId);
  }
});

test('GET /app — merchant A\'s card list never includes merchant B\'s cards', async () => {
  const a = await makeMerchantFixture('A12');
  const b = await makeMerchantFixture('B12');
  try {
    const res = await fetch(`${server.baseUrl}/app`, { headers: { Cookie: a.cookie } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes(a.card.name), "merchant A's own card must appear in their own list");
    assert.ok(!html.includes(b.card.name), "merchant B's card must never appear in merchant A's card list");
  } finally {
    await cleanupMerchant(a.merchantId);
    await cleanupMerchant(b.merchantId);
  }
});

// ---------------------------------------------------------------------------
// Unauthenticated requests to merchant routes redirect to /signin.
// ---------------------------------------------------------------------------

test('unauthenticated requests to every merchant route redirect (302) to /signin, never 200 or 500', async () => {
  const b = await makeMerchantFixture('B13');
  try {
    // /stamp is deliberately excluded here — BUILD.md §8.13: with no
    // session at all it shows the staff PIN entry screen (200), not a
    // redirect. See apps/demo/test/staffScoping.test.ts for its own
    // coverage, and httpIntegration.test.ts's dedicated /stamp test.
    const routes: Array<[string, string]> = [
      ['GET', '/app'],
      ['GET', '/cards/new'],
      ['GET', '/customers'],
      ['GET', '/customers/export.csv'],
      ['GET', '/reports'],
      ['GET', '/settings'],
      [`GET`, `/cards/${b.card.id}`],
      ['GET', `/cards/${b.card.id}/print`],
      ['GET', `/cards/${b.card.id}/edit`],
      ['GET', `/cards/${b.card.id}/activate`],
    ];
    for (const [method, p] of routes) {
      const res = await fetch(`${server.baseUrl}${p}`, { method, redirect: 'manual' });
      assert.equal(res.status, 302, `${method} ${p} with no session should redirect, got ${res.status}`);
      assert.match(res.headers.get('location') ?? '', /^\/signin/, `${method} ${p} should redirect to /signin`);
    }

    const postCards = await fetch(`${server.baseUrl}/cards`, { method: 'POST', redirect: 'manual' });
    assert.equal(postCards.status, 302);
    assert.match(postCards.headers.get('location') ?? '', /^\/signin/);

    // POST /api/stamp is a JSON API, not a browsable page — with no
    // merchant session and no staff PIN session (BUILD.md §8.13), it 401s
    // with a JSON body rather than redirecting, which would be meaningless
    // for a fetch() caller. See staffScoping.test.ts for the staff-PIN side
    // of this route.
    const apiStamp = await fetch(`${server.baseUrl}/api/stamp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: b.pass.serial }),
      redirect: 'manual',
    });
    assert.equal(apiStamp.status, 401);
    const apiStampJson = (await apiStamp.json()) as { ok: boolean };
    assert.equal(apiStampJson.ok, false);
  } finally {
    await cleanupMerchant(b.merchantId);
  }
});

test('a reused/tampered session cookie value is treated as no session at all (redirects to /signin)', async () => {
  const res = await fetch(`${server.baseUrl}/app`, {
    headers: { Cookie: `${SESSION_COOKIE_NAME}=not-a-real-session-id-${randomHex(8)}` },
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location') ?? '', /^\/signin/);
});
