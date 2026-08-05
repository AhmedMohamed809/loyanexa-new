// apps/demo/test/printSheet.test.ts — GET /cards/:id/print (BUILD.md §8.8).
//
// The sheet was redesigned on 2026-08-04 to wear the card's own design
// (owner: *"apply the same images and colour of the card"*). These tests
// exist mostly to protect the parts of that which are easy to break without
// noticing:
//
//   - a merchant-authored colour reaching a CSS rule unescaped
//   - the QR losing its white backing, which stops it scanning
//   - the background silently not printing
//
// Spawns the real server against the real local Postgres, and creates a
// session row directly rather than going through POST /signup, which is
// rate-limited per IP.

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
  const port = 47600 + Math.floor(Math.random() * 900);
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

let server: SpawnedServer;
let merchantId: string;
let cookie: string;

before(async () => {
  server = await spawnServer();
  const merchant = await prisma.merchant.create({
    data: { email: `printsheet-${randomHex(8)}@example.test`, name: 'Print Sheet Test Cafe' },
  });
  merchantId = merchant.id;
  const sessionId = randomHex(24);
  await prisma.session.create({
    data: { id: sessionId, merchantId, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookie = `lnx-session=${sessionId}`;
});

after(async () => {
  await prisma.stampEvent.deleteMany({ where: { merchantId } });
  await prisma.merchant.delete({ where: { id: merchantId } }).catch(() => {});
  await server.close();
});

async function makeCard(overrides: Record<string, unknown> = {}): Promise<string> {
  const maxSlot = await prisma.card.aggregate({ where: { merchantId }, _max: { slot: true } });
  const card = await prisma.card.create({
    data: {
      merchantId,
      slot: (maxSlot._max.slot ?? 0) + 1,
      linkCode: randomLinkCode(),
      shortCode: `C${randomHex(4)}`.toUpperCase(),
      name: 'Basak Bakery',
      stampsGoal: 5,
      bgColor: '#1E1E1E',
      fgColor: '#FFFFFF',
      stampActive: '#F2D9A6',
      stampInactive: '#555555',
      rewardText: 'Free cake',
      ...overrides,
    },
  });
  return card.id;
}

async function fetchSheet(cardId: string): Promise<string> {
  const res = await fetch(`${server.baseUrl}/cards/${cardId}/print`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  return res.text();
}

test("the sheet is dressed in the card's own colours, passed as custom properties rather than into a rule", async () => {
  const cardId = await makeCard();
  const html = await fetchSheet(cardId);

  assert.match(
    html,
    /--sheet-bg:#1E1E1E;--sheet-ink:#FFFFFF;--sheet-accent:#F2D9A6;/,
    "the card's palette must reach the sheet"
  );
});

test('a malicious colour cannot break out of the style attribute and inject CSS', async () => {
  // Colour columns are free text as far as Postgres is concerned — a card
  // could be given this value by any future code path that skips validation.
  // validHex() must reject it and fall back rather than emit it verbatim.
  const cardId = await makeCard({ bgColor: 'red; } body { display:none } .x {' });
  const html = await fetchSheet(cardId);

  assert.ok(!html.includes('body { display:none }'), 'a colour must never reach the document as CSS');
  assert.match(html, /--sheet-bg:#111827;/, 'an invalid colour must fall back to the safe default');
});

test("the cover photo and logo are used when the card has them", async () => {
  const coverHash = 'a'.repeat(64);
  const logoHash = 'b'.repeat(64);
  const cardId = await makeCard({ coverHash, logoHash });
  const html = await fetchSheet(cardId);

  assert.ok(html.includes(`/img/${coverHash}`), 'the cover image must be on the poster');
  assert.ok(html.includes(`/img/${logoHash}`), 'the logo must be on the poster');
  assert.match(html, /class="hero"/, 'with a cover, the hero must not fall back to the gradient');
});

test('with no cover or logo the sheet still looks designed: a colour gradient and the card name as a wordmark', async () => {
  const cardId = await makeCard({ coverHash: null, logoHash: null, name: 'Nameless Cafe' });
  const html = await fetchSheet(cardId);

  assert.match(html, /class="hero no-cover"/, 'no cover must fall back to the gradient band');
  assert.match(html, /class="wordmark">Nameless Cafe</, 'no logo must fall back to the card name');
});

test('the QR keeps a white backing whatever the card colours are — a dark-on-dark code does not scan', async () => {
  const cardId = await makeCard({ bgColor: '#000000', stampActive: '#000000' });
  const html = await fetchSheet(cardId);

  // The rule is fixed, never derived from --sheet-bg.
  assert.match(
    html,
    /\.sheet \.qr-box \{\s*background: #fff;/,
    'the QR backing must be hardcoded white, not the card background'
  );
});

test('the background is set to actually print, not be dropped as a "background graphic"', async () => {
  const cardId = await makeCard();
  const html = await fetchSheet(cardId);

  assert.match(html, /print-color-adjust: exact/, 'without this the poster prints as plain text on white');
  assert.match(html, /-webkit-print-color-adjust: exact/, 'Safari and Chrome still need the prefixed form');
});

test('the poster follows the CARD language, not the merchant dashboard cookie', async () => {
  const cardId = await makeCard({ lang: 'ar', rewardText: 'كيكة مجانية' });
  // A merchant reading their dashboard in English must still hand their
  // Arabic-speaking customers an Arabic poster.
  const res = await fetch(`${server.baseUrl}/cards/${cardId}/print`, {
    headers: { Cookie: `${cookie}; lnx-lang=en` },
  });
  assert.equal(res.status, 200);
  const html = await res.text();

  assert.match(html, /<html lang="ar" dir="rtl">/, 'the document language must come from the card');
  assert.ok(html.includes('كيكة مجانية'), 'merchant-authored reward text is never translated');
});

test('the strip image scales instead of overflowing its panel on a phone', async () => {
  // Reported from a 430px screenshot: the strip burst out of its dashed panel
  // on both sides. The <img> carried an inline max-width:375px, which beats
  // the stylesheet's max-width:100% on specificity, so it stayed 375px wide
  // inside a padded panel roughly 335px across.
  const cardId = await makeCard();
  const html = await (await fetch(`${server.baseUrl}/cards/${cardId}`, { headers: { Cookie: cookie } })).text();

  assert.ok(
    !/<img[^>]*style="[^"]*max-width:\s*375px/.test(html),
    'no inline max-width may override the responsive rule'
  );
  // width/height attributes stay — they reserve space and prevent a layout
  // jump — which is exactly why the CSS must set height:auto alongside them.
  assert.match(html, /<img src="\/preview\.png\?[^"]*"[^>]*width="375" height="144">/);
  assert.match(
    html,
    /\.preview-panel img \{ max-width: 100%; height: auto; \}/,
    'without height:auto a shrinking width leaves the fixed height and stretches the strip'
  );
});

test('the setup checklist counts real progress and disappears when finished', async () => {
  // Derived from data, never from a "completed_step" flag: a flag drifts the
  // moment a merchant deletes their only card, and a checklist claiming a
  // step is done when it is not is worse than none, because it stops them
  // looking.
  const own = await prisma.merchant.create({
    data: { email: `checklist-${randomHex(8)}@example.test`, name: 'Checklist Cafe' },
  });
  const sessionId = randomHex(24);
  await prisma.session.create({
    data: { id: sessionId, merchantId: own.id, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  const jar = { Cookie: `lnx-session=${sessionId}; lnx-lang=en` };
  const count = async (): Promise<string | null> => {
    const html = await (await fetch(`${server.baseUrl}/app`, { headers: jar })).text();
    return (/setup-count">([^<]*)</.exec(html) ?? [])[1] ?? null;
  };

  try {
    // Signing up is itself step one, so it opens at 1/5 rather than 0/5 —
    // a checklist that says you have done nothing when you have reads broken.
    assert.equal(await count(), '1/5 complete');

    const card = await prisma.card.create({
      data: {
        merchantId: own.id, slot: 1, linkCode: randomLinkCode(),
        shortCode: `C${randomHex(4)}`.toUpperCase(), name: 'Checklist Card',
        stampsGoal: 8, bgColor: '#203757', fgColor: '#FFFFFF',
        stampActive: '#F96400', stampInactive: '#8794A5', rewardText: 'Free coffee',
      },
    });
    assert.equal(await count(), '2/5 complete');

    await prisma.card.update({ where: { id: card.id }, data: { active: true } });
    assert.equal(await count(), '3/5 complete');

    await prisma.card.update({
      where: { id: card.id },
      data: { locations: [{ name: 'Shop', lat: 51.5, lng: -0.1 }] },
    });
    assert.equal(await count(), '4/5 complete');

    await prisma.staff.create({ data: { merchantId: own.id, name: 'Sam', pinHash: 'x' } });
    // Finished: the band goes for good. A permanent nag on the dashboard of a
    // merchant who set up months ago is clutter, not guidance.
    const html = await (await fetch(`${server.baseUrl}/app`, { headers: jar })).text();
    assert.ok(!/class="setup"/.test(html), 'a completed checklist must not keep showing');
  } finally {
    await prisma.stampEvent.deleteMany({ where: { merchantId: own.id } });
    await prisma.merchant.delete({ where: { id: own.id } }).catch(() => {});
  }
});

test('the wallet chips are our own mark, not a reproduction of Apple or Google badge artwork', async () => {
  const cardId = await makeCard();
  const html = await fetchSheet(cardId);

  assert.match(html, /class="wallet-chip"/);
  // If this ever starts pulling in official badge images, that is a
  // trademark decision and should be a deliberate one, not a silent commit.
  // Scoped to badge *artwork* specifically. An earlier version of this
  // matched a bare "gstatic", which the Alexandria font preconnect
  // legitimately trips — a false positive that would have made the rule
  // look wrong rather than the code.
  assert.ok(
    !/(add[-_]?to[-_]?(apple|google)[-_]?wallet|wallet[-_]?badge)[^"']*\.(png|svg|jpe?g)/i.test(html),
    'no official Apple/Google badge artwork should be embedded'
  );
  assert.ok(
    !/<img[^>]+(apple|google)[^>]*wallet/i.test(html),
    'the wallet chips must stay inline SVG of our own, not an imported badge image'
  );
});
