// apps/demo/test/plans.test.ts — the pricing matrix and its limits
// (BUILD.md §14).
//
// The interesting cases here are not "does Growth allow three cards". They
// are what happens at the edges: a trial that has run out, a plan value that
// is not a plan, and — most importantly — what a lapsed subscription does to
// cards that customers are already carrying.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  PLANS,
  TRIAL_PLAN,
  PAID_PLAN_IDS,
  effectivePlan,
  checkLimit,
  formatPrice,
  isPlanId,
  isQuoteOnly,
  annualFromMonthly,
  UPCOMING_FEATURE_IDS,
} = await import('../plans.ts');

const DAY = 24 * 60 * 60 * 1000;

test('the matrix matches BUILD.md §14 exactly', () => {
  // §14 is the contract with the customer. If these numbers drift from the
  // published table, the published table is what a court would read.
  assert.deepEqual(
    PAID_PLAN_IDS.map((id) => [id, PLANS[id].monthlyPence, PLANS[id].annualPence]),
    [
      ['STARTER', 1900, 18200],
      ['GROWTH', 2300, 22100],
      ['PRO', null, null], // quoted per customer
    ]
  );
  assert.deepEqual(PAID_PLAN_IDS.map((id) => PLANS[id].cards), [1, 3, 10]);
  assert.deepEqual(PAID_PLAN_IDS.map((id) => PLANS[id].locations), [1, 2, 10]);
  assert.deepEqual(PAID_PLAN_IDS.map((id) => PLANS[id].staff), [0, 10, 50]);
  assert.deepEqual(PAID_PLAN_IDS.map((id) => PLANS[id].customers), [500, Infinity, Infinity]);

  // The feature rows, which vary by plan rather than by capacity.
  assert.deepEqual(PAID_PLAN_IDS.map((id) => PLANS[id].targetedMessages), [false, true, true]);
  assert.deepEqual(PAID_PLAN_IDS.map((id) => PLANS[id].dataExport), [false, true, true]);
  assert.deepEqual(PAID_PLAN_IDS.map((id) => PLANS[id].automatedMessages), [false, false, true]);
  assert.deepEqual(PAID_PLAN_IDS.map((id) => PLANS[id].api), [false, false, true]);
});

test('annual prices are derived from the same 20% rule the pricing page shows', () => {
  // The bug this replaces: annualPence was hardcoded 19000 (£190/year) while
  // the pricing page advertised £182 for the same plan. Nothing compared
  // them, so both were "correct" in their own file.
  assert.equal(annualFromMonthly(1900), 18200);
  assert.equal(annualFromMonthly(2300), 22100);
  for (const id of PAID_PLAN_IDS) {
    const { monthlyPence, annualPence } = PLANS[id];
    if (monthlyPence === null) {
      assert.equal(annualPence, null, `${id} is quote-only, so it cannot carry an annual price`);
      continue;
    }
    assert.equal(annualPence, annualFromMonthly(monthlyPence), `${id} annual must follow the rule`);
    assert.ok(annualPence < monthlyPence * 12, `${id} annual must actually be a discount`);
  }
});

test('a quote-only plan formats as null, never as "£0"', () => {
  // The failure this guards: a sentinel price of 0 renders as a confident
  // "£0/month" on the pricing page the first time a caller forgets the
  // special case. null cannot be formatted by accident.
  assert.equal(formatPrice(null), null);
  assert.equal(isQuoteOnly(PLANS.PRO), true);
  assert.equal(isQuoteOnly(PLANS.STARTER), false);
  assert.equal(isQuoteOnly(PLANS.GROWTH), false);
});

test('prices are held in pence, so money is never a float', () => {
  assert.equal(formatPrice(1900), '£19');
  assert.equal(formatPrice(19000), '£190');
  assert.equal(formatPrice(1999), '£19.99');
  // The classic float bug this avoids: 0.1 + 0.2 !== 0.3.
  assert.equal(PLANS.STARTER.monthlyPence! + PLANS.GROWTH.monthlyPence!, 4200);
});

test('unbuilt features are not plan fields, so nothing can gate on them', () => {
  // Collect reviews, custom fields and data-driven review collecting are
  // advertised as "Coming soon". If they were Plan fields somebody would
  // eventually branch on one, and a branch on a capability that does not
  // exist is either dead code or a half-enabled feature.
  for (const id of UPCOMING_FEATURE_IDS) {
    for (const planId of PAID_PLAN_IDS) {
      assert.ok(
        !(id in PLANS[planId]),
        `${id} is not built yet — it must not be a field on the ${planId} plan`
      );
    }
  }
});

test('an unlimited customer allowance never blocks, at any count', () => {
  // Infinity rather than a large sentinel: a merchant who genuinely reaches
  // 1,000,000 customers must not hit a wall that was only ever meant to mean
  // "no limit".
  assert.equal(checkLimit(PLANS.GROWTH, 'customers', 1_000_000).allowed, true);
  assert.equal(checkLimit(PLANS.PRO, 'customers', Number.MAX_SAFE_INTEGER).allowed, true);
});

test('Starter caps customers at 500 — the cap that separates it from Growth', () => {
  assert.deepEqual(checkLimit(PLANS.STARTER, 'customers', 499), {
    allowed: true,
    limit: 500,
    used: 499,
  });
  assert.equal(checkLimit(PLANS.STARTER, 'customers', 500).allowed, false, 'the 501st is blocked');
});

test('a live trial gets Growth capacity, not Starter', () => {
  // A trial more restrictive than the cheapest paid plan cannot demonstrate
  // what the paid plans do, which is the entire point of a trial.
  const merchant = { plan: 'STARTER', subStatus: 'trialing', trialEndsAt: new Date(Date.now() + 3 * DAY) };
  assert.equal(effectivePlan(merchant).cards, 3);
  assert.equal(effectivePlan(merchant).staff, 10);
  assert.equal(TRIAL_PLAN.monthlyPence, 0, 'a trial costs nothing');
});

test('an expired trial falls back to Starter — it does not lock the merchant out', () => {
  // This is the important one. Their customers are carrying these cards and
  // did nothing wrong; a lapsed subscription is not a reason to break a card
  // in somebody's wallet. The pressure applied is "you cannot create more",
  // never "what you have stops working".
  const expired = { plan: 'STARTER', subStatus: 'trialing', trialEndsAt: new Date(Date.now() - DAY) };
  const plan = effectivePlan(expired);
  assert.equal(plan.id, 'STARTER');
  assert.ok(plan.cards >= 1, 'an expired trial must still allow the cards they already run');

  // A merchant already over the fallback limit keeps what they have — the
  // limit only ever blocks creating another.
  assert.equal(checkLimit(plan, 'cards', 3).allowed, false, 'cannot create a fourth');
  assert.equal(checkLimit(plan, 'cards', 0).allowed, true);
});

test('a trialing merchant with no trial end date is treated as expired, not as unlimited', () => {
  // Every Merchant row predating this feature looks like this. Failing open
  // would have silently given every existing account Pro capacity.
  assert.equal(effectivePlan({ plan: 'STARTER', subStatus: 'trialing', trialEndsAt: null }).id, 'STARTER');
});

test('an unrecognised plan value falls back to the cheapest, never to unlimited', () => {
  assert.equal(effectivePlan({ plan: 'ENTERPRISE_XL', subStatus: 'active', trialEndsAt: null }).id, 'STARTER');
  assert.equal(effectivePlan({ plan: '', subStatus: 'active', trialEndsAt: null }).id, 'STARTER');
  assert.equal(isPlanId('PRO'), true);
  assert.equal(isPlanId('pro'), false, 'the enum is upper-case and matching must be exact');
  assert.equal(isPlanId(null), false);
});

test('checkLimit is a strict less-than, so a full plan blocks the next one', () => {
  const growth = PLANS.GROWTH;
  assert.deepEqual(checkLimit(growth, 'cards', 2), { allowed: true, limit: 3, used: 2 });
  assert.deepEqual(checkLimit(growth, 'cards', 3), { allowed: false, limit: 3, used: 3 });
  // Starter includes no staff at all — the zero case must block, not divide.
  assert.equal(checkLimit(PLANS.STARTER, 'staff', 0).allowed, false);
});
