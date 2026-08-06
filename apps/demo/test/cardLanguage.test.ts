// apps/demo/test/cardLanguage.test.ts — sub-project 7: letting a merchant
// choose a card's own language at creation and change it later (Card.lang,
// BUILD.md §8.5 step 3 / §8.9). Card.lang already existed and every
// customer-facing surface already read it correctly (passContent.ts,
// renderEnrolPage, enqueueWelcomeBroadcast, handleIssueGooglePass) — the
// actual gap was that no form ever let a merchant set it, so every card
// was silently 'ar' (Card.lang's own schema default). This file proves the
// new control end to end: POST /cards persists the choice (defaulting to
// 'ar' when omitted), POST /cards/:id/edit can change it even once the
// card has passes (it is a presentation field, cardEdit.ts's
// AESTHETIC_FIELDS, not an economic one), the change bumps Card.updatedAt
// (which is what invalidates the .pkpass cache, apps/demo/pkpassCache.ts),
// and the customer-facing enrol page / print sheet follow the *card's* own
// language regardless of what the signed-in merchant's own dashboard
// (`lnx-lang`) cookie says. Same spawn-a-real-server pattern as
// apps/demo/test/httpIntegration.test.ts / welcomeAutomation.test.ts.

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

async function sessionCookieFor(merchantId: string): Promise<string> {
  const session = await createSession(merchantId);
  return `${SESSION_COOKIE_NAME}=${session.id}`;
}

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

async function makeMerchant(): Promise<{ merchantId: string; cookie: string }> {
  const merchant = await prisma.merchant.create({
    data: { subStatus: 'trialing', trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), email: `cardlang-test-${randomHex(8)}@example.test`, name: 'Card Language Test Merchant' },
  });
  const cookie = await sessionCookieFor(merchant.id);
  return { merchantId: merchant.id, cookie };
}

let nextSlot = 1;

async function makeActiveCard(
  merchantId: string,
  lang: 'en' | 'ar',
  overrides: { name?: string; rewardText?: string } = {}
): Promise<Awaited<ReturnType<typeof prisma.card.create>>> {
  return prisma.card.create({
    data: {
      merchantId,
      slot: nextSlot++,
      linkCode: randomLinkCode(),
      shortCode: `C${randomHex(4)}`.toUpperCase(),
      name: overrides.name ?? 'Card Language Test Card',
      stampsGoal: 8,
      bgColor: '#203757',
      fgColor: '#FFFFFF',
      stampActive: '#F96400',
      stampInactive: '#8794A5',
      rewardText: overrides.rewardText ?? 'Free coffee',
      lang,
      active: true,
    },
  });
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
// 1. POST /cards — the new-card language choice
// ---------------------------------------------------------------------------

test('POST /cards with lang=en stores lang "en"', async () => {
  const fx = await makeMerchant();
  try {
    const res = await fetch(`${server.baseUrl}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: fx.cookie },
      body: new URLSearchParams({
        name: 'English Bakery',
        rewardText: 'Free croissant',
        goal: '8',
        bg: '#203757',
        active: '#F96400',
        inactive: '#8794A5',
        lang: 'en',
      }).toString(),
      redirect: 'manual',
    });
    assert.equal(res.status, 303, 'a valid submission redirects into the designer');
    const card = await prisma.card.findFirstOrThrow({ where: { merchantId: fx.merchantId, name: 'English Bakery' } });
    assert.equal(card.lang, 'en');
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('POST /cards with no lang field stores the default, "ar" — never silently something else', async () => {
  const fx = await makeMerchant();
  try {
    const res = await fetch(`${server.baseUrl}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: fx.cookie },
      body: new URLSearchParams({
        name: 'No Lang Field Bakery',
        rewardText: 'Free coffee',
        goal: '8',
        bg: '#203757',
        active: '#F96400',
        inactive: '#8794A5',
        // deliberately no `lang` field — a tampered or ancient client
      }).toString(),
      redirect: 'manual',
    });
    assert.equal(res.status, 303);
    const card = await prisma.card.findFirstOrThrow({ where: { merchantId: fx.merchantId, name: 'No Lang Field Bakery' } });
    assert.equal(card.lang, 'ar', 'the default when nothing is chosen must still be ar');
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('POST /cards with lang=ar (an explicit choice, matching the default) stores lang "ar"', async () => {
  const fx = await makeMerchant();
  try {
    const res = await fetch(`${server.baseUrl}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: fx.cookie },
      body: new URLSearchParams({
        name: 'Arabic Bakery',
        rewardText: 'قهوة مجانية',
        goal: '8',
        bg: '#203757',
        active: '#F96400',
        inactive: '#8794A5',
        lang: 'ar',
      }).toString(),
      redirect: 'manual',
    });
    assert.equal(res.status, 303);
    const card = await prisma.card.findFirstOrThrow({ where: { merchantId: fx.merchantId, name: 'Arabic Bakery' } });
    assert.equal(card.lang, 'ar');
    assert.equal(card.rewardText, 'قهوة مجانية', 'merchant-authored reward text must round-trip exactly as typed');
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

// ---------------------------------------------------------------------------
// 2. The lock rule — language is a presentation field, never locked
// ---------------------------------------------------------------------------

test('changing a card\'s language via POST /cards/:id/edit succeeds even once the card has passes, while stampsGoal on the very same request still 409s', async () => {
  const fx = await makeMerchant();
  try {
    const card = await makeActiveCard(fx.merchantId, 'ar');
    await prisma.pass.create({
      data: { serial: `TESTSER${randomHex(6)}`.toUpperCase(), shortCode: `P${randomHex(4)}`.toUpperCase(), cardId: card.id, merchantId: fx.merchantId, authToken: randomHex(12) },
    });

    // First: language alone must succeed (303, not 409) on a locked card.
    const langOnly = await fetch(`${server.baseUrl}/cards/${card.id}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: fx.cookie },
      body: new URLSearchParams({
        name: card.name,
        lang: 'en',
        bgColor: card.bgColor,
        stampActive: card.stampActive,
        stampInactive: card.stampInactive,
        stampShape: card.stampShape,
        stampSource: 'plain',
        bgOpacity: '100',
        iconFit: card.iconFit,
      }).toString(),
      redirect: 'manual',
    });
    assert.equal(langOnly.status, 303, 'a language-only edit must succeed on a card that already has passes');
    const afterLangChange = await prisma.card.findUniqueOrThrow({ where: { id: card.id } });
    assert.equal(afterLangChange.lang, 'en');

    // Then: an attempt to change stampsGoal on the same (now-locked) card
    // must still be rejected with 409 — proving language being editable
    // didn't accidentally loosen the economic lock rule.
    const goalAttempt = await fetch(`${server.baseUrl}/cards/${card.id}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: fx.cookie },
      body: new URLSearchParams({
        name: card.name,
        lang: 'en',
        bgColor: card.bgColor,
        stampActive: card.stampActive,
        stampInactive: card.stampInactive,
        stampShape: card.stampShape,
        stampSource: 'plain',
        bgOpacity: '100',
        iconFit: card.iconFit,
        stampsGoal: '20',
      }).toString(),
      redirect: 'manual',
    });
    assert.equal(goalAttempt.status, 409, 'stampsGoal must still be locked once the card has passes');

    const afterGoalAttempt = await prisma.card.findUniqueOrThrow({ where: { id: card.id } });
    assert.equal(afterGoalAttempt.stampsGoal, 8, 'the rejected stampsGoal edit must leave the database untouched');
    assert.equal(afterGoalAttempt.lang, 'en', 'the earlier, successful language change must still be in effect');
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('changing only the language bumps Card.updatedAt — the same mechanism that invalidates the .pkpass cache and pushes the change to already-issued passes for any other design edit', async () => {
  const fx = await makeMerchant();
  try {
    const card = await makeActiveCard(fx.merchantId, 'ar');
    await new Promise((r) => setTimeout(r, 5)); // Prisma's @updatedAt has millisecond resolution

    const res = await fetch(`${server.baseUrl}/cards/${card.id}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: fx.cookie },
      body: new URLSearchParams({
        name: card.name,
        lang: 'en',
        bgColor: card.bgColor,
        stampActive: card.stampActive,
        stampInactive: card.stampInactive,
        stampShape: card.stampShape,
        stampSource: 'plain',
        bgOpacity: '100',
        iconFit: card.iconFit,
      }).toString(),
      redirect: 'manual',
    });
    assert.equal(res.status, 303);

    const after = await prisma.card.findUniqueOrThrow({ where: { id: card.id } });
    assert.equal(after.lang, 'en');
    assert.ok(after.updatedAt.getTime() > card.updatedAt.getTime(), 'a language-only edit must still bump Card.updatedAt');
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

// ---------------------------------------------------------------------------
// 3. The enrol page follows the card's own language, never the merchant's
//    dashboard cookie
// ---------------------------------------------------------------------------

test('GET /:code for an English card renders <html lang="en" dir="ltr">, regardless of the merchant\'s own lnx-lang cookie', async () => {
  const fx = await makeMerchant();
  try {
    const card = await makeActiveCard(fx.merchantId, 'en', { rewardText: 'Free Croissant Combo' });
    // No cookie at all, and the opposite dashboard cookie both must give the same result.
    const noCookie = await fetch(`${server.baseUrl}/${card.linkCode}`);
    const noCookieHtml = await noCookie.text();
    assert.match(noCookieHtml, /<html lang="en" dir="ltr"/);

    const wrongCookie = await fetch(`${server.baseUrl}/${card.linkCode}`, { headers: { Cookie: 'lnx-lang=ar' } });
    const wrongCookieHtml = await wrongCookie.text();
    assert.match(wrongCookieHtml, /<html lang="en" dir="ltr"/, 'the enrol page must ignore the merchant dashboard cookie entirely');
    assert.ok(wrongCookieHtml.includes('Free Croissant Combo'), 'the merchant-authored reward text must appear verbatim, unescaped-but-HTML-escaped');
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('GET /:code for an Arabic card renders <html lang="ar" dir="rtl">, regardless of the merchant\'s own lnx-lang cookie', async () => {
  const fx = await makeMerchant();
  try {
    const card = await makeActiveCard(fx.merchantId, 'ar', { rewardText: 'قهوة مجانية' });
    const wrongCookie = await fetch(`${server.baseUrl}/${card.linkCode}`, { headers: { Cookie: 'lnx-lang=en' } });
    const html = await wrongCookie.text();
    assert.match(html, /<html lang="ar" dir="rtl"/, 'the enrol page must ignore the merchant dashboard cookie entirely');
    assert.ok(html.includes('قهوة مجانية'), 'the merchant-authored reward text must appear verbatim');
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

// ---------------------------------------------------------------------------
// 4. The print sheet (GET /cards/:id/print) — a real bug found while
//    tracing every customer-facing surface: this page is a poster printed
//    for *customers* to scan and read at the counter, but it used to
//    render entirely in the signed-in merchant's own dashboard-language
//    cookie. Fixed to follow card.lang, same as the enrol page.
// ---------------------------------------------------------------------------

test('GET /cards/:id/print follows the card\'s own language, not the merchant\'s dashboard cookie', async () => {
  const fx = await makeMerchant();
  try {
    const arCard = await makeActiveCard(fx.merchantId, 'ar');
    const enDashboard = await fetch(`${server.baseUrl}/cards/${arCard.id}/print`, {
      headers: { Cookie: `lnx-lang=en; ${fx.cookie}` },
    });
    const enDashboardHtml = await enDashboard.text();
    assert.match(
      enDashboardHtml,
      /<html lang="ar" dir="rtl"/,
      'an Arabic card\'s print sheet must render in Arabic even when the signed-in merchant\'s own dashboard is set to English'
    );

    const enCard = await makeActiveCard(fx.merchantId, 'en');
    const arDashboard = await fetch(`${server.baseUrl}/cards/${enCard.id}/print`, {
      headers: { Cookie: `lnx-lang=ar; ${fx.cookie}` },
    });
    const arDashboardHtml = await arDashboard.text();
    assert.match(
      arDashboardHtml,
      /<html lang="en" dir="ltr"/,
      'an English card\'s print sheet must render in English even when the signed-in merchant\'s own dashboard is set to Arabic'
    );
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

// ---------------------------------------------------------------------------
// 5. GET /cards/new and GET /cards/:id/edit — the picker itself is present
//    and offers both scripts, each in its own name (never "Arabic" written
//    out in English on the button).
// ---------------------------------------------------------------------------

test('GET /cards/new offers both "English" and "العربية" as the two language options', async () => {
  const fx = await makeMerchant();
  try {
    const res = await fetch(`${server.baseUrl}/cards/new`, { headers: { Cookie: fx.cookie } });
    const html = await res.text();
    assert.ok(html.includes('name="lang" value="en"'), 'an English radio option must be present');
    assert.ok(html.includes('name="lang" value="ar"'), 'an Arabic radio option must be present');
    assert.ok(html.includes('>English<'), 'the English option must be labelled in English, not translated');
    assert.ok(html.includes('>العربية<'), 'the Arabic option must be labelled العربية, in its own script — never "Arabic" spelled out in English');
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

// ---------------------------------------------------------------------------
// 6. The pass-issuance rate-limit page (429) — another real bug found while
//    tracing every customer-facing surface: this page is shown to the
//    *customer* whose own IP tripped the limiter on POST /:code/pass, but
//    it used to render via resolveLang(req) — the merchant's own dashboard
//    cookie, which the customer's browser never carries, so it always
//    silently fell back to resolveLang()'s 'ar' default regardless of the
//    card the customer was actually trying to add. Fixed to read card.lang,
//    which handleIssuePass/handleIssueGooglePass already have in hand.
// ---------------------------------------------------------------------------

test('the pass-issuance rate-limit (429) page follows the card\'s own language', async () => {
  const fx = await makeMerchant();
  try {
    const card = await makeActiveCard(fx.merchantId, 'en');
    // A unique X-Forwarded-For isolates this test's rate-limit bucket
    // (apps/demo/rateLimit.ts's RateLimiter is keyed by IP) from every
    // other test in this file that also calls POST /:code/pass indirectly.
    const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.1`;
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': ip };

    let last: Response | undefined;
    for (let i = 0; i < 11; i++) {
      last = await fetch(`${server.baseUrl}/${card.linkCode}/pass`, { method: 'POST', headers, body: '' });
      if (last.status === 429) break;
      await last.arrayBuffer(); // drain the .pkpass body so the connection can be reused
    }
    assert.ok(last, 'at least one request must have been made');
    assert.equal(last!.status, 429, 'the 11th request within the window must be rate-limited');
    const html = await last!.text();
    assert.match(html, /<html lang="en" dir="ltr"/, 'the rate-limit page for an English card must render in English, not the (cookie-less) resolveLang default of Arabic');
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});

test('GET /cards/:id/edit pre-selects the card\'s own current language, not the merchant\'s dashboard language', async () => {
  const fx = await makeMerchant();
  try {
    const card = await makeActiveCard(fx.merchantId, 'en');
    // Dashboard cookie deliberately set to the opposite of the card's own
    // language — the pre-checked tile must still follow the card, not the
    // cookie, or a merchant editing an English card from an Arabic
    // dashboard would see it wrongly appear set to Arabic.
    const res = await fetch(`${server.baseUrl}/cards/${card.id}/edit`, {
      headers: { Cookie: `lnx-lang=ar; ${fx.cookie}` },
    });
    const html = await res.text();
    assert.match(html, /name="lang" value="en" checked/, 'the English tile must be the one pre-checked for an English card');
    assert.doesNotMatch(html, /name="lang" value="ar" checked/, 'the Arabic tile must not be pre-checked for an English card');
  } finally {
    await cleanupMerchant(fx.merchantId);
  }
});
