// apps/demo/test/cardTemplates.test.ts — BUILD.md §8.4's template gallery.
//
// Two halves: the pure catalogue functions (search, code lookup, grouping),
// and the HTTP flow that turns a picked template into a real card. The
// second half is what matters — the failure mode is a template that previews
// with a coffee-cup stamp and then creates a card with plain circles,
// because the icon was lost somewhere between the gallery and the insert.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import { loadEnvFile } from '../env.ts';
import {
  CARD_TEMPLATES,
  findTemplate,
  findTemplateByCode,
  searchTemplates,
  groupByCategory,
} from '../cardTemplates.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
loadEnvFile(path.join(ROOT, '.env'));

const { prisma } = await import('../../../packages/db/src/index.ts');
const { BUILTIN_ICON_IDS } = await import('../../../packages/image/src/index.ts');

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

// ---------------------------------------------------------------------------
// The catalogue itself
// ---------------------------------------------------------------------------

test('every template is internally consistent: unique id and code, a real icon, a goal in range', () => {
  const ids = new Set<string>();
  const codes = new Set<string>();
  for (const tpl of CARD_TEMPLATES) {
    assert.ok(!ids.has(tpl.id), `duplicate template id: ${tpl.id}`);
    assert.ok(!codes.has(tpl.code), `duplicate template code: ${tpl.code}`);
    ids.add(tpl.id);
    codes.add(tpl.code);

    assert.ok(
      (BUILTIN_ICON_IDS as readonly string[]).includes(tpl.builtinIcon),
      `${tpl.id} names an icon the renderer does not have: ${tpl.builtinIcon}`
    );
    // MIN_GOAL 3 / MAX_GOAL 12 — a template outside that would be rejected
    // by the create form it feeds, which is a confusing way to fail.
    assert.ok(tpl.stampsGoal >= 3 && tpl.stampsGoal <= 12, `${tpl.id} goal out of range`);
    assert.match(tpl.code, /^TMP-[A-Z0-9]{5,6}$/, `${tpl.id} code is not in the documented shape`);
  }
});

test('every template ships both languages — an Arabic card must never be seeded with English reward text', () => {
  for (const tpl of CARD_TEMPLATES) {
    for (const [field, value] of Object.entries({
      labelEn: tpl.labelEn,
      labelAr: tpl.labelAr,
      rewardEn: tpl.rewardEn,
      rewardAr: tpl.rewardAr,
    })) {
      assert.ok(value.trim().length > 0, `${tpl.id}.${field} is empty`);
    }
    // The Arabic copy must actually be Arabic, not an untranslated stub.
    assert.match(tpl.rewardAr, /[؀-ۿ]/, `${tpl.id}.rewardAr is not Arabic`);
    assert.match(tpl.labelAr, /[؀-ۿ]/, `${tpl.id}.labelAr is not Arabic`);
  }
});

test('search matches across both languages, and by code', () => {
  // A merchant on an Arabic dashboard may still think "gym".
  assert.ok(searchTemplates('gym').some((t) => t.id === 'gym'));
  assert.ok(searchTemplates('نادي').some((t) => t.id === 'gym'));
  // Keywords, not just the label.
  assert.ok(searchTemplates('espresso').some((t) => t.id === 'cafe'));
  assert.ok(searchTemplates('قهوة').some((t) => t.id === 'cafe'));
  assert.ok(searchTemplates('TMP-CAFE01').some((t) => t.id === 'cafe'));

  assert.equal(searchTemplates('   ').length, CARD_TEMPLATES.length, 'a blank query returns everything');
  assert.equal(searchTemplates('zzzznope').length, 0);
});

test('import by code is forgiving about case and whitespace, but not about being wrong', () => {
  assert.equal(findTemplateByCode('TMP-CAFE01')?.id, 'cafe');
  assert.equal(findTemplateByCode('  tmp-cafe01  ')?.id, 'cafe', 'typed by hand from a printed gallery');
  assert.equal(findTemplateByCode('TMPCAFE01'), undefined, 'a missing dash must not fuzzy-match');
  assert.equal(findTemplateByCode(''), undefined);
  assert.equal(findTemplateByCode('TMP-NOPE99'), undefined);
});

test('grouping keeps catalogue order and drops empty categories', () => {
  const groups = groupByCategory(CARD_TEMPLATES);
  assert.deepEqual(
    groups.map((g) => g.category),
    ['food', 'beauty', 'fitness', 'services']
  );
  assert.ok(groups.every((g) => g.templates.length > 0));

  const oneCategory = groupByCategory(CARD_TEMPLATES.filter((t) => t.category === 'fitness'));
  assert.equal(oneCategory.length, 1, 'categories with no matches must not render as empty headings');
});

// ---------------------------------------------------------------------------
// The HTTP flow
// ---------------------------------------------------------------------------

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
  const port = 48500 + Math.floor(Math.random() * 900);
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
    data: { email: `templates-${randomHex(8)}@example.test`, name: 'Template Test Cafe' },
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

test('the gallery renders every template as a real /preview.png, not a mock-up', async () => {
  const res = await fetch(`${server.baseUrl}/cards/new/templates`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();

  for (const tpl of CARD_TEMPLATES) {
    assert.ok(html.includes(`/cards/new?template=${tpl.id}`), `no tile links to ${tpl.id}`);
    assert.ok(html.includes(`builtinIcon=${tpl.builtinIcon}`), `${tpl.id}'s preview does not request its icon`);
  }
  // The previews must come from the real renderer, so what is browsed is
  // what gets drawn on the pass.
  assert.match(html, /src="\/preview\.png\?/, 'tiles must point at the real render endpoint');
});

test('the gallery filters by search and says so when nothing matches', async () => {
  const hit = await fetch(`${server.baseUrl}/cards/new/templates?q=barber`, { headers: { Cookie: cookie } });
  const hitHtml = await hit.text();
  assert.ok(hitHtml.includes('/cards/new?template=barber'));
  assert.ok(!hitHtml.includes('/cards/new?template=gym'), 'a search must actually narrow the gallery');

  const miss = await fetch(`${server.baseUrl}/cards/new/templates?q=zzzznope`, { headers: { Cookie: cookie } });
  const missHtml = await miss.text();
  assert.ok(!missHtml.includes('/cards/new?template='), 'no tiles should render for a miss');
  assert.match(missHtml, /templatesNoMatches|No templates match|لا توجد قوالب/);
});

test('a valid import code redirects straight to the prefilled form; a bad one explains itself', async () => {
  const good = await fetch(`${server.baseUrl}/cards/new/templates?code=tmp-cafe01`, {
    headers: { Cookie: cookie },
    redirect: 'manual',
  });
  assert.equal(good.status, 303);
  assert.equal(good.headers.get('location'), '/cards/new?template=cafe');

  const bad = await fetch(`${server.baseUrl}/cards/new/templates?code=TMP-NOPE99`, {
    headers: { Cookie: cookie },
  });
  assert.equal(bad.status, 200, 'a wrong code must not 404 — it re-renders the gallery with a message');
  const badHtml = await bad.text();
  assert.ok(/No template with that code|لا يوجد قالب/.test(badHtml));
});

test('picking a template prefills the create form, icon included', async () => {
  const res = await fetch(`${server.baseUrl}/cards/new?template=barber`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const html = await res.text();

  const barber = findTemplate('barber')!;
  assert.ok(html.includes(`value="${barber.bgColor}"`), 'the background colour must be prefilled');
  assert.ok(html.includes(barber.rewardAr), 'the Arabic reward seed must be prefilled (cards default to ar)');
  assert.ok(
    html.includes(`name="builtinIcon" value="${barber.builtinIcon}"`),
    'the stamp icon must travel with the template, or the created card will not match its preview'
  );
  // Both seeds are carried so the language toggle can swap an untouched one.
  assert.ok(html.includes(`data-seed-en="${barber.rewardEn}"`));
});

test('an unknown template id opens an ordinary blank form rather than an error', async () => {
  const res = await fetch(`${server.baseUrl}/cards/new?template=not-a-real-template`, {
    headers: { Cookie: cookie },
  });
  assert.equal(res.status, 200, 'a stale bookmark must not produce an error page');
  const html = await res.text();
  // Checks for the hidden INPUT specifically. A bare `name="builtinIcon"`
  // also appears inside the preview script's querySelector, which is present
  // on every form and is not a prefill.
  assert.ok(
    !/<input type="hidden" name="builtinIcon"/.test(html),
    'nothing should be prefilled from a bogus id'
  );
  assert.ok(!/<input type="hidden" name="stampSource"/.test(html));
});

test('creating from a template stores the icon on the card — the preview and the real card agree', async () => {
  const res = await fetch(`${server.baseUrl}/cards`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      name: 'Template Coffee Co',
      rewardText: 'A free coffee',
      goal: '8',
      bg: '#2B1B12',
      active: '#E8A85C',
      inactive: '#6B554A',
      lang: 'en',
      stampSource: 'builtin',
      builtinIcon: 'coffee',
    }).toString(),
    redirect: 'manual',
  });
  assert.equal(res.status, 303);

  const card = await prisma.card.findFirstOrThrow({
    where: { merchantId, name: 'Template Coffee Co' },
  });
  assert.equal(card.stampSource, 'builtin');
  assert.equal(card.builtinIcon, 'coffee');
  assert.equal(card.stampsGoal, 8);
  assert.equal(card.bgColor, '#2B1B12');
});

test('a crafted icon value cannot reach the renderer — the hidden field is whitelisted, not trusted', async () => {
  const res = await fetch(`${server.baseUrl}/cards`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      name: 'Crafted Icon Card',
      rewardText: 'Nothing',
      goal: '5',
      bg: '#203757',
      active: '#F96400',
      inactive: '#8794A5',
      lang: 'en',
      stampSource: 'builtin',
      builtinIcon: '../../etc/passwd',
    }).toString(),
    redirect: 'manual',
  });
  assert.equal(res.status, 303, 'a bad icon is ignored, not a validation error');

  const card = await prisma.card.findFirstOrThrow({ where: { merchantId, name: 'Crafted Icon Card' } });
  assert.notEqual(card.builtinIcon, '../../etc/passwd', 'an unwhitelisted icon id must never be stored');
});

test('the gallery needs a session', async () => {
  const res = await fetch(`${server.baseUrl}/cards/new/templates`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location') ?? '', /\/signin/);
});
