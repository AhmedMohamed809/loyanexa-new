// apps/demo/plans.ts — the pricing matrix (BUILD.md §14).
//
// "Build the matrix data-driven so prices are one constant" — §14's own
// instruction, and the reason this file exists rather than the numbers being
// scattered across a pricing page, a limit check and a settings screen. A
// price that appears in three places will eventually disagree with itself,
// and the version the customer saw is the one that is legally binding.
//
// Nothing here talks to Stripe. Plans and their limits are a property of the
// product; taking money for them is a separate concern, and keeping the two
// apart is what lets the limits be enforced and tested today, with no Stripe
// account involved.

// Matches the Plan enum already in the Prisma schema. The schema had these
// columns from the start — plan, subStatus, trialEndsAt, stripeCustId — and
// nothing had ever read them. This file is what gives them meaning.
export type PlanId = 'STARTER' | 'GROWTH' | 'PRO';

export interface Plan {
  id: PlanId;
  /**
   * Monthly and annual price in pence, so no money is ever a float.
   *
   * `null` means the plan is not self-serve — the price is quoted per
   * customer. PRO is sold that way (chains and franchises differ too much
   * for one number to be honest), so the pricing page shows a contact
   * button where the other two show a figure. A sentinel like 0 or -1 would
   * have formatted as "£0" the first time somebody forgot to special-case
   * it; null cannot survive `formatPrice` unnoticed.
   */
  monthlyPence: number | null;
  annualPence: number | null;
  cards: number;
  locations: number;
  staff: number;
  /**
   * Customers who may hold a live pass. `Infinity` is "unlimited" — it
   * compares correctly in checkLimit() without a magic number, and reads as
   * unlimited at a glance.
   */
  customers: number;
  /** §14's feature rows, which differ by plan rather than by capacity. */
  targetedMessages: boolean;
  dataExport: boolean;
  automatedMessages: boolean;
  api: boolean;
}

/**
 * Features named on the pricing page that are NOT built yet.
 *
 * Deliberately kept out of `Plan`. If these were plan fields, the first
 * thing anyone would do is gate on them — and gating on a capability that
 * does not exist yet either dead-codes the branch or, worse, half-enables
 * something. They live here as presentation only: the pricing page marks
 * these rows "Coming soon", and nothing in the product reads this map.
 *
 * When one ships, delete it from here and add a real field to Plan. The
 * test suite asserts every id listed here is absent from Plan, so the two
 * cannot quietly overlap.
 */
export const UPCOMING_FEATURE_IDS = ['collectReviews', 'customFields', 'dataDrivenReviews'] as const;
export type UpcomingFeatureId = (typeof UPCOMING_FEATURE_IDS)[number];

/**
 * The trial (§14: "Seven-day free trial, no card details").
 *
 * Deliberately given Growth's capacity rather than Starter's. A trial that is
 * more restrictive than the cheapest paid plan cannot demonstrate what the
 * paid plans do, and the point of a trial is to find out whether the product
 * is worth paying for.
 */
export const TRIAL_DAYS = 7;

/**
 * The annual discount the pricing page advertises, as a fraction.
 *
 * The page computes its own annual figures from this same rule. Keeping the
 * rule here and deriving `annualPence` from it means the two cannot drift:
 * the previous hardcoded 19000 claimed £190/year for a plan the page was
 * selling at £182, and nothing caught it because neither file knew about
 * the other.
 */
export const ANNUAL_DISCOUNT = 0.2;

/** Twelve months less the annual discount, rounded to whole pounds as the page rounds. */
export function annualFromMonthly(monthlyPence: number): number {
  return Math.round((monthlyPence / 100) * 12 * (1 - ANNUAL_DISCOUNT)) * 100;
}

export const PLANS: Record<PlanId, Plan> = {
  STARTER: {
    id: 'STARTER',
    monthlyPence: 1900,
    annualPence: annualFromMonthly(1900), // £182 — was hardcoded 19000 (£190)
    cards: 1,
    locations: 1,
    staff: 0,
    // One shop's worth of regulars. The cap is what separates this from
    // GROWTH, so it has to be a real number rather than a courtesy limit.
    customers: 500,
    // Push is the headline reason to move up a plan, so it is off here.
    targetedMessages: false,
    dataExport: false,
    automatedMessages: false,
    api: false,
  },
  GROWTH: {
    id: 'GROWTH',
    // £23. Was £39 here while the pricing page said £23 — two files, two
    // prices, and the one the customer read is the one that binds.
    monthlyPence: 2300,
    annualPence: annualFromMonthly(2300), // £221
    cards: 3,
    locations: 2,
    staff: 10,
    customers: Infinity,
    targetedMessages: true,
    dataExport: true,
    automatedMessages: false,
    api: false,
  },
  PRO: {
    id: 'PRO',
    // Quoted per customer — see the note on Plan.monthlyPence.
    monthlyPence: null,
    annualPence: null,
    cards: 10,
    locations: 10,
    staff: 50,
    customers: Infinity,
    targetedMessages: true,
    dataExport: true,
    automatedMessages: true,
    api: true,
  },
};

/**
 * What a merchant gets while trialing (§14: "Seven-day free trial, no card
 * details"). Growth's capacity, not Starter's: a trial more restrictive than
 * the cheapest paid plan cannot show what the paid plans do, and finding that
 * out is the entire point of a trial.
 */
export const TRIAL_PLAN: Plan = { ...PLANS.GROWTH, id: 'GROWTH', monthlyPence: 0, annualPence: 0 };

/** The paid plans, in the order §14 lists them. */
export const PAID_PLAN_IDS: readonly PlanId[] = ['STARTER', 'GROWTH', 'PRO'];

export function isPlanId(value: string | null | undefined): value is PlanId {
  return typeof value === 'string' && value in PLANS;
}

/**
 * The plan a merchant is actually entitled to right now.
 *
 * An expired trial falls back to `starter`'s limits rather than to nothing.
 * Locking a merchant out of a product that already holds their customers'
 * loyalty cards would take those cards down with it — the customers did
 * nothing wrong, and a lapsed subscription is not a reason to break a card
 * somebody is carrying in their wallet. The right pressure to apply is "you
 * cannot create more", never "what you have stops working".
 */
export function effectivePlan(
  merchant: { plan: string; subStatus: string; trialEndsAt: Date | null },
  now: Date = new Date()
): Plan {
  const trialing =
    merchant.subStatus === 'trialing' &&
    merchant.trialEndsAt !== null &&
    merchant.trialEndsAt.getTime() > now.getTime();
  if (trialing) return TRIAL_PLAN;
  return isPlanId(merchant.plan) ? PLANS[merchant.plan] : PLANS.STARTER;
}

/**
 * Formats pence as a price string. Kept here so the pricing page and the
 * billing screen cannot disagree.
 *
 * Returns null for a quote-only plan rather than a string, so a caller that
 * forgets to handle PRO renders nothing visible and gets caught, instead of
 * confidently printing "£0" at a customer.
 */
export function formatPrice(pence: number | null): string | null {
  if (pence === null) return null;
  return pence % 100 === 0 ? `£${pence / 100}` : `£${(pence / 100).toFixed(2)}`;
}

/** True when the plan is quoted per customer rather than sold self-serve. */
export function isQuoteOnly(plan: Plan): boolean {
  return plan.monthlyPence === null;
}

export type LimitKind = 'cards' | 'locations' | 'staff' | 'customers';

export interface LimitCheck {
  allowed: boolean;
  limit: number;
  used: number;
}

/** Whether one more of `kind` may be created. */
export function checkLimit(plan: Plan, kind: LimitKind, used: number): LimitCheck {
  const limit = plan[kind];
  return { allowed: used < limit, limit, used };
}
