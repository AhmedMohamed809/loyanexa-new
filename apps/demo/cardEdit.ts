// Card edit + activation write paths — BUILD.md §8.7 (activation / "the
// lock rule") and §8.9 (card edit). Split out of server.ts, same reasoning
// as apps/demo/stamp.ts: apps/demo/test/cardEdit.test.ts exercises this
// directly against the real local Postgres, without going through HTTP.
//
// The lock rule, in BUILD.md's own words: "after the first customer joins,
// these cannot be changed" — stamps required, starter stamps, how stamps
// are earned, reward details, expiry type — "to keep every customer's
// progress fair." Aesthetics (name, colours, images, text) stay editable
// forever. BUILD.md is explicit that this must be enforced server-side,
// not just hidden in the UI — this module is that enforcement. A merchant
// could otherwise raise the goal after a customer is nine stamps into a
// ten-stamp card, or shrink the reward after the fact; the whole fairness
// promise to customers rests on this file, not on a disabled form field.

import { prisma } from '../../packages/db/src/index.ts';
import type { Card, Prisma } from '@prisma/client';

/**
 * The database fields the lock rule protects once any Pass exists for a
 * card. `expiryDays` and `expiryDate` are locked alongside `expiryType`
 * because they are that same rule's parameters — changing the number of
 * days without changing `expiryType` is exactly the kind of edit the rule
 * exists to block. "How stamps are earned" (BUILD.md §8.7) describes the
 * fixed one-stamp-per-visit model itself, which has no separate column to
 * lock; it is covered here by locking the fields that would otherwise let
 * a merchant change the economics of collecting one (goal and starter
 * stamps).
 */
export const ECONOMIC_FIELDS = [
  'stampsGoal',
  'starterStamps',
  'rewardText',
  'expiryType',
  'expiryDays',
  'expiryDate',
] as const;
export type EconomicField = (typeof ECONOMIC_FIELDS)[number];

/** Aesthetic fields stay editable forever (BUILD.md §8.7's green line). This
 * includes every card-designer field (BUILD.md §8.5/§8.9): images, shape,
 * "use the logo as the stamp", how the logo fits the stamp circle
 * (`logoFit`: 'contain' | 'cover'), background opacity and colours are all
 * cosmetic — none of them touch how many stamps a customer needs or what
 * they earn, so none of them are subject to the lock rule below. */
export const AESTHETIC_FIELDS = [
  'name',
  'bgColor',
  'bgOpacity',
  'fgColor',
  'stampActive',
  'stampInactive',
  'stampShape',
  'customStamps',
  'labelStamps',
  'labelRewards',
  'logoIconUrl',
  'logoStampHash',
  'logoFit',
  'coverUrl',
  'coverHash',
] as const;
export type AestheticField = (typeof AESTHETIC_FIELDS)[number];

/**
 * A patch to a card. Every property is optional — only the ones present
 * (not `undefined`) are treated as "this edit wants to change this field".
 * `undefined` always means "leave alone", including for the nullable
 * expiry fields; use `null` to explicitly clear one.
 */
export interface CardEditInput {
  name?: string;
  bgColor?: string;
  bgOpacity?: number;
  fgColor?: string;
  stampActive?: string;
  stampInactive?: string;
  stampShape?: string;
  customStamps?: boolean;
  labelStamps?: string;
  labelRewards?: string;
  logoIconUrl?: string | null;
  logoStampHash?: string | null;
  logoFit?: string;
  coverUrl?: string | null;
  coverHash?: string | null;
  stampsGoal?: number;
  starterStamps?: number;
  rewardText?: string;
  expiryType?: string;
  expiryDays?: number | null;
  expiryDate?: Date | null;
}

export type UpdateCardResult =
  | { ok: true; card: Card }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'locked'; lockedFields: EconomicField[]; passCount: number };

export type ActivateCardResult =
  | { ok: true; card: Card }
  | { ok: false; reason: 'not_found' };

/** How many customers (Pass rows) have joined this card. Freezing kicks in the moment this is > 0. */
export async function passCountForCard(cardId: string): Promise<number> {
  return prisma.pass.count({ where: { cardId } });
}

function valuesDiffer(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    const at = a instanceof Date ? a.getTime() : a === null || a === undefined ? null : NaN;
    const bt = b instanceof Date ? b.getTime() : b === null || b === undefined ? null : NaN;
    return at !== bt;
  }
  return a !== b;
}

/** Which economic fields `patch` actually attempts to change, relative to `current`. Fields absent from `patch` (`undefined`) are never "attempted". */
export function economicFieldsAttempted(current: Card, patch: CardEditInput): EconomicField[] {
  const attempted: EconomicField[] = [];
  for (const field of ECONOMIC_FIELDS) {
    if (!(field in patch)) continue;
    const next = patch[field];
    if (next === undefined) continue;
    if (valuesDiffer(current[field], next)) attempted.push(field);
  }
  return attempted;
}

/**
 * Applies `patch` to card `cardId`. Once any Pass exists for the card, any
 * attempt to change an ECONOMIC_FIELDS value is rejected wholesale — the
 * caller (server.ts) turns `reason: 'locked'` into HTTP 409 with a
 * translated message (BUILD.md §8.7: "enforce server-side, not just in the
 * UI"). Aesthetic fields in the same patch are still ignored on a locked
 * rejection — the caller can re-request with only the aesthetic subset, or
 * (as the HTML form does) simply never submit disabled fields in the first
 * place. Nothing is written to the database on a 'locked' result.
 */
export async function updateCard(cardId: string, patch: CardEditInput): Promise<UpdateCardResult> {
  const card = await prisma.card.findUnique({ where: { id: cardId } });
  if (!card) return { ok: false, reason: 'not_found' };

  const passCount = await passCountForCard(cardId);
  if (passCount > 0) {
    const attempted = economicFieldsAttempted(card, patch);
    if (attempted.length > 0) {
      return { ok: false, reason: 'locked', lockedFields: attempted, passCount };
    }
  }

  const data: Record<string, unknown> = {};
  const allFields = [...AESTHETIC_FIELDS, ...ECONOMIC_FIELDS] as const;
  for (const field of allFields) {
    if (!(field in patch)) continue;
    const value = patch[field];
    if (value === undefined) continue;
    data[field] = value;
  }

  const updated = await prisma.card.update({ where: { id: cardId }, data: data as Prisma.CardUpdateInput });
  return { ok: true, card: updated };
}

/**
 * Sets `active = true` (BUILD.md §8.7's activation step, §8.8's
 * post-activation screen). Activation itself does not touch any economic
 * field — it only flips the flag that starts enforcing the lock rule above
 * once the first Pass is created.
 */
export async function activateCard(cardId: string): Promise<ActivateCardResult> {
  const card = await prisma.card.findUnique({ where: { id: cardId } });
  if (!card) return { ok: false, reason: 'not_found' };
  const updated = await prisma.card.update({ where: { id: cardId }, data: { active: true } });
  return { ok: true, card: updated };
}
