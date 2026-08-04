// apps/demo/test/passContent.test.ts — pass.json field placement (BUILD.md
// §9.1). Pure data shaping, no HTTP, no database, no signing — this only
// checks the shape buildPassContentFor() produces; packages/pass/test's own
// suite (plus scripts/make-demo-pass.ts, run by hand against the real Apple
// certs) checks that a pass built from a shape like this one signs and
// verifies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Card, Pass } from '@prisma/client';
import { buildPassContentFor, buildTermsText } from '../passContent.ts';

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 'card1',
    merchantId: 'merchant1',
    slot: 1,
    linkCode: 10001,
    linkAlias: null,
    shortCode: 'CARD0001',
    name: 'Shami Bakery',
    logoUrl: null,
    logoHash: null,
    iconUrl: null,
    iconHash: null,
    iconFit: 'contain',
    coverUrl: null,
    coverHash: null,
    stampsGoal: 8,
    starterStamps: 0,
    stampShape: 'circle',
    stampSource: 'plain',
    builtinIcon: 'star',
    bgColor: '#203757',
    fgColor: '#FFFFFF',
    stampActive: '#F96400',
    stampInactive: '#8794A5',
    labelStamps: '',
    labelRewards: '',
    lang: 'ar',
    expiryType: 'unlimited',
    expiryDays: null,
    expiryDate: null,
    rewardText: 'Free coffee',
    formFields: ['name', 'phone'],
    locations: [],
    active: true,
    createdAt: new Date(),
    ...overrides,
  } as Card;
}

/** Far enough ahead that these fixtures always read as a live, unexpired message. */
const FUTURE = new Date('2099-01-01T00:00:00.000Z');

function makePass(overrides: Partial<Pass> = {}): Pass {
  return {
    id: 'pass1',
    serial: 'SERIAL0000000001',
    shortCode: 'PASS0001',
    cardId: 'card1',
    merchantId: 'merchant1',
    authToken: 'tok',
    custName: '',
    custEmail: '',
    custPhone: '',
    custBirthday: null,
    stamps: 3,
    totalStamps: 3,
    rewards: 0,
    message: '',
    messageExpiresAt: null,
    platform: '',
    lastStampAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Pass;
}

test('primaryFields is empty, matching BUILD.md §9.1', () => {
  const content = buildPassContentFor(makeCard({ lang: 'en' }), makePass());
  assert.deepEqual(content.primaryFields, []);
});

test('headerFields carries the stamp count as "N of GOAL" in English', () => {
  const content = buildPassContentFor(makeCard({ lang: 'en', stampsGoal: 8 }), makePass({ stamps: 3 }));
  assert.equal(content.headerFields?.length, 1);
  assert.equal(content.headerFields?.[0]?.key, 'stamps');
  assert.equal(content.headerFields?.[0]?.label, 'STAMPS');
  assert.equal(content.headerFields?.[0]?.value, '3 of 8');
});

test('secondaryFields carries the reward and stamps-remaining, in that order, in English', () => {
  const content = buildPassContentFor(makeCard({ lang: 'en', stampsGoal: 8, rewardText: 'Free coffee' }), makePass({ stamps: 3 }));
  assert.equal(content.secondaryFields?.length, 2);
  assert.equal(content.secondaryFields?.[0]?.key, 'reward');
  assert.equal(content.secondaryFields?.[0]?.label, 'REWARD');
  assert.equal(content.secondaryFields?.[0]?.value, 'Free coffee');
  assert.equal(content.secondaryFields?.[1]?.key, 'stampsRemaining');
  assert.equal(content.secondaryFields?.[1]?.label, 'STAMPS REMAINING');
  assert.ok(content.secondaryFields?.[1]?.value.startsWith('5 stamps'), 'stampsRemaining should read 8 - 3 = 5');
});

// ---------------------------------------------------------------------------
// Revised 2026-08-04 (sub-project 8, "clean the card face"): the merchant
// broadcast message moved from `auxiliaryFields` (a face row, permanent
// clutter once the message stops being new) to `backFields` — first entry,
// ahead of the terms text. `changeMessage` fires on a back field's value
// change exactly the same as a front one, so the lock-screen banner is
// unaffected; see docs/BUILD.md §9.1's dated note and
// apps/demo/passContent.ts's own doc comment.
// ---------------------------------------------------------------------------

test('the pass no longer has any auxiliaryFields — the card face carries only headerFields/secondaryFields', () => {
  const content = buildPassContentFor(makeCard({ lang: 'en' }), makePass({ message: 'Half price today!', messageExpiresAt: FUTURE }));
  assert.equal(content.auxiliaryFields, undefined);
});

test('backFields\' first entry is the "msg" field, sourced verbatim from pass.message, with changeMessage set for the broadcast banner (BUILD.md §9.1/§8.12/§9.3)', () => {
  const withMessage = buildPassContentFor(makeCard({ lang: 'en' }), makePass({ message: 'Half price today!​‌', messageExpiresAt: FUTURE }));
  assert.equal(withMessage.backFields?.[0]?.key, 'msg');
  assert.equal(withMessage.backFields?.[0]?.label, 'NEWS');
  assert.equal(withMessage.backFields?.[0]?.value, 'Half price today!​‌', 'must be pass.message verbatim — the marker was already baked in by whoever wrote it, never re-added here');
  assert.equal(withMessage.backFields?.[0]?.changeMessage, '%@');
});

// ---------------------------------------------------------------------------
// Revised 2026-08-04 (sub-project 9, "ephemeral notifications"): the owner's
// report — a brand-new customer's freshly issued pass showed old broadcast
// text. buildPassContentFor now omits the "msg" back field entirely
// (rather than rendering it with an empty value) whenever pass.message is
// "" or pass.messageExpiresAt has passed. See this file's own doc comment
// for the accepted trade-off this supersedes.
// ---------------------------------------------------------------------------

test('the "msg" back field is omitted entirely — not rendered blank — on a brand-new pass (pass.message === "")', () => {
  const content = buildPassContentFor(makeCard({ lang: 'en' }), makePass({ message: '' }));
  assert.equal(content.backFields?.some((f) => f.key === 'msg'), false, 'no "msg" entry at all');
  assert.equal(content.backFields?.length, 1, 'only the terms field remains');
  assert.equal(content.backFields?.[0]?.key, 'terms');
});

// Reversed 2026-08-04. This test previously asserted the opposite — that a
// NULL expiry meant "never expires", so the field stayed. That is the bug,
// written down: `message` has exactly one writer (broadcastWorker.ts) and it
// stamps an expiry alongside every write, so a non-empty message with a NULL
// expiry can only be a row written before the migration. Reading it as
// "never expires" exempted every pre-existing pass from the whole feature —
// 9 of the 12 messages on the live database, each pinned to display a
// months-old broadcast permanently, which is the owner's original report.
test('the "msg" back field is OMITTED when a message has no expiry set (messageExpiresAt === null) — a NULL expiry means expired, not eternal', () => {
  const content = buildPassContentFor(makeCard({ lang: 'en' }), makePass({ message: 'Sale!', messageExpiresAt: null }));
  assert.equal(content.backFields?.some((f) => f.key === 'msg'), false);
});

test('the "msg" back field is present while messageExpiresAt is still in the future', () => {
  const now = new Date('2026-08-04T12:00:00.000Z');
  const content = buildPassContentFor(
    makeCard({ lang: 'en' }),
    makePass({ message: 'Sale!', messageExpiresAt: new Date('2026-08-04T12:10:00.000Z') }),
    { now }
  );
  assert.equal(content.backFields?.[0]?.key, 'msg');
});

test('the "msg" back field is omitted once messageExpiresAt has passed, even though pass.message is still non-empty in the row', () => {
  const now = new Date('2026-08-04T12:20:00.000Z');
  const content = buildPassContentFor(
    makeCard({ lang: 'en' }),
    makePass({ message: 'Sale!', messageExpiresAt: new Date('2026-08-04T12:10:00.000Z') }),
    { now }
  );
  assert.equal(content.backFields?.some((f) => f.key === 'msg'), false);
  assert.equal(content.backFields?.length, 1);
});

test('the "msg" field label is localised (NEWS in English, translated in Arabic)', () => {
  const en = buildPassContentFor(makeCard({ lang: 'en' }), makePass({ message: 'Sale!', messageExpiresAt: FUTURE }));
  const ar = buildPassContentFor(makeCard({ lang: 'ar' }), makePass({ message: 'Sale!', messageExpiresAt: FUTURE }));
  assert.equal(en.backFields?.[0]?.label, 'NEWS');
  assert.notEqual(ar.backFields?.[0]?.label, 'NEWS');
  assert.ok((ar.backFields?.[0]?.label.length ?? 0) > 0);
  // Merchant-authored broadcast text is never translated (docs/COPY.md §4) — only the field's own label is localised.
  assert.equal(ar.backFields?.[0]?.value, 'Sale!');
});

test('backFields carries the message before the terms text, in that order', () => {
  const content = buildPassContentFor(makeCard({ lang: 'en' }), makePass({ message: 'Sale!', messageExpiresAt: FUTURE }));
  assert.equal(content.backFields?.length, 2);
  assert.equal(content.backFields?.[0]?.key, 'msg');
  assert.equal(content.backFields?.[1]?.key, 'terms');
});

test('the invisible change marker is still appended to stampsRemaining, and changeMessage is set for the live-update banner', () => {
  const content = buildPassContentFor(makeCard({ lang: 'en' }), makePass({ stamps: 3 }));
  const field = content.secondaryFields?.[1];
  assert.ok(field?.value.startsWith('5 stamps'), 'visible text must still read "5 stamps"');
  assert.ok(field && field.value.length > '5 stamps'.length, 'invisible marker characters must be appended');
  assert.equal(field?.changeMessage, '%@');
});

test('webServiceURL/authenticationToken are included together only when publicBaseUrl is given', () => {
  const withUrl = buildPassContentFor(makeCard(), makePass({ authToken: 'abc' }), { publicBaseUrl: 'https://example.fly.dev' });
  assert.equal(withUrl.webServiceURL, 'https://example.fly.dev/apple');
  assert.equal(withUrl.authenticationToken, 'abc');

  const withoutUrl = buildPassContentFor(makeCard(), makePass());
  assert.equal(withoutUrl.webServiceURL, undefined);
  assert.equal(withoutUrl.authenticationToken, undefined);
});

test('buildTermsText describes the card\'s own expiry rule, in English', () => {
  assert.match(buildTermsText(makeCard({ lang: 'en', expiryType: 'unlimited' })), /expiry: unlimited/);
  assert.match(buildTermsText(makeCard({ lang: 'en', expiryType: 'duration', expiryDays: 30 })), /expiry: 30 days/);
});

// ---------------------------------------------------------------------------
// BUILD.md §13/§9.1 — the pass is customer-facing copy too, and it must
// follow the card's own language, not always English. Fixed alongside the
// rest of this branch's bilingual copy pass; these tests would have caught
// it rendering "STAMPS"/"REWARD" on an Arabic card, which it did before.
// ---------------------------------------------------------------------------

test('headerFields, secondaryFields and backFields labels are Arabic on an Arabic card (the Card/Prisma default)', () => {
  const content = buildPassContentFor(makeCard({ lang: 'ar', stampsGoal: 8 }), makePass({ stamps: 3, message: 'تخفيض!', messageExpiresAt: FUTURE }));
  assert.equal(content.headerFields?.[0]?.label, 'الأختام');
  assert.equal(content.headerFields?.[0]?.value, '٣ من ٨', 'stamp counts render in Arabic-Indic digits (BUILD.md §13)');
  assert.equal(content.secondaryFields?.[0]?.label, 'المكافأة');
  assert.equal(content.secondaryFields?.[1]?.label, 'الأختام المتبقية');
  assert.ok(content.secondaryFields?.[1]?.value.startsWith('٥ أختام'), 'stampsRemaining should read 8 - 3 = 5, in Arabic-Indic digits');
  assert.equal(content.backFields?.[0]?.label, 'أخبار', 'the message field is now backFields[0]');
  assert.equal(content.backFields?.[1]?.label, 'الشروط', 'terms come after the message in backFields');
});

test('backFields carries only the terms field, in Arabic, when there is no active message (pass.message === "")', () => {
  const content = buildPassContentFor(makeCard({ lang: 'ar', stampsGoal: 8 }), makePass({ stamps: 3 }));
  assert.equal(content.backFields?.length, 1);
  assert.equal(content.backFields?.[0]?.key, 'terms');
  assert.equal(content.backFields?.[0]?.label, 'الشروط');
});

test('merchant-authored rewardText is never translated, in either language (BUILD.md §13)', () => {
  const en = buildPassContentFor(makeCard({ lang: 'en', rewardText: 'Free coffee' }), makePass());
  const ar = buildPassContentFor(makeCard({ lang: 'ar', rewardText: 'Free coffee' }), makePass());
  assert.equal(en.secondaryFields?.[0]?.value, 'Free coffee');
  assert.equal(ar.secondaryFields?.[0]?.value, 'Free coffee', 'the merchant typed this in English — it must not be machine-translated');
});

test('buildTermsText describes the card\'s own expiry rule, in Arabic, with Arabic-Indic digits and no stray Western digits', () => {
  const unlimited = buildTermsText(makeCard({ lang: 'ar', expiryType: 'unlimited' }));
  assert.match(unlimited, /غير محدود/);
  const duration = buildTermsText(makeCard({ lang: 'ar', expiryType: 'duration', expiryDays: 30 }));
  assert.match(duration, /٣٠ يومًا/);
  assert.doesNotMatch(duration, /[0-9]/, 'no Western digits should leak into the Arabic terms text');
});

// ---------------------------------------------------------------------------
// Location reminders (BUILD.md §9.4/§9.1) — locations[]/maxDistance
// emission into pass.json. §9.1's own sample shape:
// `"locations":[{"latitude":…,"longitude":…,"relevantText":"You're near <shop>!"}],"maxDistance":100`.
// ---------------------------------------------------------------------------

test('a card with no locations omits locations/maxDistance from pass.json entirely (not an empty array)', () => {
  const content = buildPassContentFor(makeCard({ locations: [] }), makePass());
  assert.equal(content.locations, undefined);
  assert.equal(content.maxDistance, undefined);
});

test('a card with locations emits latitude/longitude/relevantText and maxDistance: 100 (BUILD.md §9.1\'s own sample)', () => {
  const locations = [{ name: 'Downtown', latitude: 24.7136, longitude: 46.6753, relevantText: 'Custom banner text' }];
  const content = buildPassContentFor(makeCard({ lang: 'en', locations }), makePass());
  assert.equal(content.locations?.length, 1);
  assert.equal(content.locations?.[0]?.latitude, 24.7136);
  assert.equal(content.locations?.[0]?.longitude, 46.6753);
  assert.equal(content.locations?.[0]?.relevantText, 'Custom banner text');
  assert.equal(content.maxDistance, 100);
});

test('a location with no merchant-typed relevantText falls back to the localised default, using the card\'s own name', () => {
  const locations = [{ name: 'Downtown', latitude: 24.7136, longitude: 46.6753 }];
  const en = buildPassContentFor(makeCard({ lang: 'en', name: 'Shami Bakery', locations }), makePass());
  assert.equal(en.locations?.[0]?.relevantText, "You're near Shami Bakery!");

  const ar = buildPassContentFor(makeCard({ lang: 'ar', name: 'Shami Bakery', locations }), makePass());
  assert.equal(ar.locations?.[0]?.relevantText, 'أنت بالقرب من Shami Bakery!', 'the default relevantText must be properly localised Arabic on an Arabic card, not English');
});

test('locations is capped at 10 even if Card.locations somehow holds more', () => {
  const locations = Array.from({ length: 14 }, (_, i) => ({ name: `Loc ${i}`, latitude: 1, longitude: 1 }));
  const content = buildPassContentFor(makeCard({ locations }), makePass());
  assert.equal(content.locations?.length, 10);
});

test('a malformed Card.locations value (not an array, or bad entries) never throws — it just yields no locations', () => {
  assert.doesNotThrow(() => buildPassContentFor(makeCard({ locations: 'not an array' as unknown as [] }), makePass()));
  const content = buildPassContentFor(makeCard({ locations: 'not an array' as unknown as [] }), makePass());
  assert.equal(content.locations, undefined);
});
