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
  /** Monthly and annual price in pence, so no money is ever a float. */
  monthlyPence: number;
  annualPence: number;
  cards: number;
  locations: number;
  staff: number;
  /** §14's feature rows, which differ by plan rather than by capacity. */
  targetedMessages: boolean;
  dataExport: boolean;
  automatedMessages: boolean;
  api: boolean;
}

/**
 * The trial (§14: "Seven-day free trial, no card details").
 *
 * Deliberately given Growth's capacity rather than Starter's. A trial that is
 * more restrictive than the cheapest paid plan cannot demonstrate what the
 * paid plans do, and the point of a trial is to find out whether the product
 * is worth paying for.
 */
export const TRIAL_DAYS = 7;

export const PLANS: Record<PlanId, Plan> = {
  STARTER: {
    id: 'STARTER',
    monthlyPence: 1900,
    annualPence: 19000,
    cards: 1,
    locations: 1,
    staff: 0,
    targetedMessages: false,
    dataExport: false,
    automatedMessages: false,
    api: false,
  },
  GROWTH: {
    id: 'GROWTH',
    monthlyPence: 3900,
    annualPence: 39000,
    cards: 3,
    locations: 3,
    staff: 10,
    targetedMessages: true,
    dataExport: true,
    automatedMessages: false,
    api: false,
  },
  PRO: {
    id: 'PRO',
    monthlyPence: 6900,
    annualPence: 69000,
    cards: 10,
    locations: 10,
    staff: 50,
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

/** Formats pence as a price string. Kept here so the pricing page and the billing screen cannot disagree. */
export function formatPrice(pence: number): string {
  return pence % 100 === 0 ? `£${pence / 100}` : `£${(pence / 100).toFixed(2)}`;
}

export type LimitKind = 'cards' | 'locations' | 'staff';

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
