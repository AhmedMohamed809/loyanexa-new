// The stamp screen's write path — BUILD.md §8.15 (the stamp screen) and
// §9.6 (anti-fraud). Split out of server.ts so apps/demo/test/stamp.test.ts
// can exercise it directly against the real local Postgres, without going
// through HTTP.
//
// Resolves a Pass by its `serial` (encoded in the QR inside the customer's
// wallet pass — BUILD.md §7.3's "Card QR", never the printed "Join QR") or
// by its human-typed `shortCode` (the manual-entry fallback), enforces the
// 24-hour anti-fraud rule server-side before any write, and — if it
// passes — records the stamp, and the reward if the goal is reached, in one
// transaction so a crash between the counter update and the StampEvent
// write can never leave them disagreeing.

import { prisma } from '../../packages/db/src/index.ts';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export type StampOutcome =
  | {
      ok: true;
      serial: string;
      stamps: number;
      goal: number;
      totalStamps: number;
      rewards: number;
      rewardEarned: boolean;
    }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'too_soon'; lastStampAt: Date; retryAt: Date };

/**
 * Applies one stamp for the pass identified by `codeOrSerial`, scoped to
 * `merchantId` — the stamp screen is opened by a signed-in merchant's own
 * staff (BUILD.md §8.15), and a pass belonging to a different merchant must
 * be exactly as unstampable as one that doesn't exist: `reason: 'not_found'`
 * either way, never a distinguishable "found, but not yours" response that
 * would let one merchant probe another's serials/short codes. Callers are
 * expected to have already trimmed/validated that `codeOrSerial` is
 * non-empty — an empty or garbage code simply resolves to `not_found`,
 * since neither `serial` nor `shortCode` can ever be blank in the database.
 */
export async function applyStamp(codeOrSerial: string, merchantId: string, source = 'browser'): Promise<StampOutcome> {
  const trimmed = codeOrSerial.trim();

  return prisma.$transaction(async (tx): Promise<StampOutcome> => {
    const pass = await tx.pass.findFirst({
      where: { merchantId, OR: [{ serial: trimmed }, { shortCode: trimmed }] },
      include: { card: true },
    });
    if (!pass) return { ok: false, reason: 'not_found' };

    const now = new Date();
    const cutoff = new Date(now.getTime() - TWENTY_FOUR_HOURS_MS);

    // Atomic, guarded increment: the WHERE clause re-checks the 24h rule at
    // write time, in the same statement as the write, not just at the read
    // above — so two overlapping requests for the same pass cannot both
    // succeed. Postgres serialises the two UPDATEs on the row lock; the one
    // that has to wait re-evaluates its WHERE clause against the first's
    // committed result once the lock is released, and loses the guard.
    const guarded = await tx.pass.updateMany({
      where: {
        id: pass.id,
        OR: [{ lastStampAt: null }, { lastStampAt: { lt: cutoff } }],
      },
      data: {
        stamps: { increment: 1 },
        totalStamps: { increment: 1 },
        lastStampAt: now,
      },
    });

    if (guarded.count === 0) {
      const base = pass.lastStampAt ?? now;
      return {
        ok: false,
        reason: 'too_soon',
        lastStampAt: base,
        retryAt: new Date(base.getTime() + TWENTY_FOUR_HOURS_MS),
      };
    }

    const after = await tx.pass.findUniqueOrThrow({ where: { id: pass.id } });

    let stamps = after.stamps;
    let rewards = after.rewards;
    let rewardEarned = false;
    if (stamps >= pass.card.stampsGoal) {
      rewardEarned = true;
      stamps = 0;
      rewards += 1;
      await tx.pass.update({
        where: { id: pass.id },
        data: { stamps: 0, rewards: { increment: 1 } },
      });
    }

    await tx.stampEvent.create({
      data: { merchantId: pass.merchantId, cardId: pass.cardId, serial: pass.serial, kind: 'STAMP', source },
    });
    if (rewardEarned) {
      await tx.stampEvent.create({
        data: { merchantId: pass.merchantId, cardId: pass.cardId, serial: pass.serial, kind: 'REWARD', source },
      });
    }

    return {
      ok: true,
      serial: pass.serial,
      stamps,
      goal: pass.card.stampsGoal,
      totalStamps: after.totalStamps,
      rewards,
      rewardEarned,
    };
  });
}
