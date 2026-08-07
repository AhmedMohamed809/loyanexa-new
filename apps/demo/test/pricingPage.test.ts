// apps/demo/test/pricingPage.test.ts — the marketing pricing table against
// the plan matrix that actually enforces it (BUILD.md §14).
//
// This file exists because of a specific bug. `plans.ts` claimed £190/year
// for Starter while the pricing page advertised £182 for the same plan, and
// both were "correct" in their own file because nothing ever compared them.
// The published number is the one a customer read and the one that binds, so
// the marketing page is treated here as a claim to be checked against the
// code that grants capacity — not the other way round.
//
// The page is a standalone HTML file with its own dictionary, so these tests
// read the shipped file rather than importing anything from it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { PLANS, annualFromMonthly, UPCOMING_FEATURE_IDS } = await import('../plans.ts');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = fs.readFileSync(path.join(HERE, '../public/index.html'), 'utf8');

/**
 * Lifts one `key:[...]` feature array out of the page's English dictionary
 * and evaluates it, so the test reads exactly what ships rather than a copy
 * of it kept in sync by hand.
 */
function featureList(key: string): [string, number][] {
  const at = PAGE.indexOf(`${key}:[`);
  assert.notEqual(at, -1, `${key} must exist in the landing page dictionary`);
  const open = PAGE.indexOf('[', at);
  let depth = 0;
  let end = -1;
  for (let i = open; i < PAGE.length; i++) {
    if (PAGE[i] === '[') depth++;
    else if (PAGE[i] === ']') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert.notEqual(end, -1, `${key} array must be balanced`);
  return JSON.parse(PAGE.slice(open, end + 1).replace(/'/g, '"')) as [string, number][];
}

/** The English list for each plan, in the order the page renders them. */
const LISTS = {
  STARTER: featureList('p1f'),
  GROWTH: featureList('p2f'),
  PRO: featureList('p3f'),
} as const;

const INCLUDED = 1;
const SOON = 2;

test('every plan on the page advertises the capacity the code actually grants', () => {
  // The numbers a customer reads have to be the numbers checkLimit() uses.
  const expectations: [keyof typeof LISTS, RegExp][] = [
    ['STARTER', /^1 loyalty card$/],
    ['GROWTH', /^3 loyalty cards$/],
    ['PRO', /^10 loyalty cards$/],
  ];
  for (const [id, pattern] of expectations) {
    const row = LISTS[id].find(([label]) => pattern.test(label));
    assert.ok(row, `${id} must advertise its card allowance, matching ${pattern}`);
    const advertised = Number(row![0].match(/\d+/)![0]);
    assert.equal(advertised, PLANS[id].cards, `${id} card count must match plans.ts`);
    assert.equal(row![1], INCLUDED, `${id} card allowance is included, not a roadmap row`);
  }
});

test('advertised location and staff counts match the matrix', () => {
  for (const id of ['STARTER', 'GROWTH', 'PRO'] as const) {
    const loc = LISTS[id].find(([l]) => /locations?$/.test(l));
    assert.ok(loc, `${id} must advertise a location allowance`);
    assert.equal(Number(loc![0].match(/\d+/)![0]), PLANS[id].locations, `${id} locations`);

    const staff = LISTS[id].find(([l]) => /staff accounts?$/i.test(l));
    assert.ok(staff, `${id} must list staff accounts (as included or not)`);
    if (PLANS[id].staff === 0) {
      assert.equal(staff![1], 0, 'Starter includes no staff accounts, so the row must be off');
    } else {
      assert.equal(Number(staff![0].match(/\d+/)![0]), PLANS[id].staff, `${id} staff count`);
      assert.equal(staff![1], INCLUDED);
    }
  }
});

test('the 500-customer cap is advertised on Starter and nowhere else', () => {
  // If the page said "unlimited" while enrolment cut off at 500, the first
  // merchant to hit it would have been sold something they did not get.
  const starter = LISTS.STARTER.find(([l]) => /customers/.test(l));
  assert.match(starter![0], /500/, 'Starter must state its cap in the number the code enforces');
  assert.equal(PLANS.STARTER.customers, 500);

  for (const id of ['GROWTH', 'PRO'] as const) {
    const row = LISTS[id].find(([l]) => /customers/.test(l));
    assert.match(row![0], /^Unlimited/, `${id} advertises unlimited customers`);
    assert.equal(PLANS[id].customers, Infinity, `${id} must actually be uncapped`);
  }
});

test('push notifications are sold exactly where targetedMessages is granted', () => {
  for (const id of ['STARTER', 'GROWTH', 'PRO'] as const) {
    const row = LISTS[id].find(([l]) => /push notifications/i.test(l));
    assert.ok(row, `${id} must state its push-notification position`);
    assert.equal(
      row![1] === INCLUDED,
      PLANS[id].targetedMessages,
      `${id}: the page and the plan must agree on push`
    );
  }
});

test('the prices on the page are the prices in the matrix', () => {
  // The page hardcodes its monthly figures as bare numbers in the markup.
  for (const [id, monthly] of [
    ['STARTER', 19],
    ['GROWTH', 23],
  ] as const) {
    assert.equal(
      PLANS[id].monthlyPence,
      monthly * 100,
      `${id} monthly price must match what the page renders`
    );
    assert.ok(
      PAGE.includes(`annualTotal(${monthly})`),
      `the page must compute ${id}'s annual price from ${monthly}`
    );
  }
  // Enterprise is quoted, so it must not carry a price on either side.
  assert.equal(PLANS.PRO.monthlyPence, null);
  assert.ok(!PAGE.includes('annualTotal(69)'), 'Enterprise must not advertise a monthly figure');
});

test('the page and the matrix agree on the annual discount', () => {
  // Both sides derive annual from monthly; this pins them to the same rule.
  assert.ok(PAGE.includes('ANNUAL_DISCOUNT = 0.2'), 'the page advertises 20% off');
  assert.equal(annualFromMonthly(1900), 18200);
  assert.equal(PLANS.STARTER.annualPence, annualFromMonthly(PLANS.STARTER.monthlyPence!));
  assert.equal(PLANS.GROWTH.annualPence, annualFromMonthly(PLANS.GROWTH.monthlyPence!));
});

test('unbuilt features appear only as "coming soon", never as included', () => {
  // The three roadmap rows must never render with a tick. A customer paying
  // for a plan is entitled to everything ticked on it.
  const ROADMAP = /collect reviews|custom fields|data-driven review collecting/i;
  for (const id of ['STARTER', 'GROWTH', 'PRO'] as const) {
    for (const [label, state] of LISTS[id]) {
      if (!ROADMAP.test(label)) continue;
      assert.notEqual(
        state,
        INCLUDED,
        `"${label}" is not built — it must not be ticked on ${id}`
      );
    }
  }
  // And the page must actually carry the label, or state 2 renders blank.
  assert.ok(PAGE.includes("pr_soon:'Coming soon'"), 'the English "Coming soon" label must exist');
  assert.equal(UPCOMING_FEATURE_IDS.length, 3);
});

test('both dictionaries carry every pricing key the page renders', () => {
  // The Arabic table is not a nice-to-have — half this product's customers
  // read it, and a missing key renders as a blank row rather than an error.
  for (const key of ['p1f', 'p2f', 'p3f', 'pr_soon']) {
    const occurrences = PAGE.split(`${key}:`).length - 1;
    assert.equal(occurrences, 2, `${key} must appear in both the en and ar dictionaries`);
  }
});

test('the Arabic feature lists are the same length as the English ones', () => {
  // A shorter Arabic list means a plan quietly sells less in Arabic.
  for (const [en, ar] of [
    ['p1f', 1],
    ['p2f', 1],
    ['p3f', 1],
  ] as const) {
    void ar;
    const first = featureList(en);
    // The second occurrence is the Arabic dictionary's copy of the same key.
    const secondAt = PAGE.indexOf(`${en}:[`, PAGE.indexOf(`${en}:[`) + 1);
    assert.notEqual(secondAt, -1, `${en} must exist in the Arabic dictionary too`);
    const open = PAGE.indexOf('[', secondAt);
    let depth = 0;
    let end = -1;
    for (let i = open; i < PAGE.length; i++) {
      if (PAGE[i] === '[') depth++;
      else if (PAGE[i] === ']') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const arabic = JSON.parse(PAGE.slice(open, end + 1).replace(/'/g, '"')) as [string, number][];
    assert.equal(arabic.length, first.length, `${en}: Arabic and English must list the same rows`);
    assert.deepEqual(
      arabic.map((r) => r[1]),
      first.map((r) => r[1]),
      `${en}: a row included in one language must be included in the other`
    );
  }
});

test('the roadmap rows carry the SOON state, not a silent tick', () => {
  const soonRows = LISTS.PRO.filter(([, state]) => state === SOON);
  assert.equal(soonRows.length, 3, 'Enterprise lists all three roadmap features');
});
