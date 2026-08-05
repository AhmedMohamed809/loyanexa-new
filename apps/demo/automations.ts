// apps/demo/automations.ts — the birthday and win-back schedulers
// (BUILD.md §8.12's "Automated types: welcome · birthday · win-back").
//
// Welcome already fires from the enrolment path. These two are the ones
// BUILD.md marked "not yet scheduled": `BroadcastJob.kind` reserved the
// values but nothing ever created a job with them. This module is that
// trigger.
//
// Both funnel into the exact same `enqueueBroadcast()` a manual Send uses,
// with `onlySerial` so one customer is targeted rather than the card's whole
// list. That matters more than it looks: it means automated messages inherit
// the queue's retry and backoff, the 15-minute expiry, the sweeper, and the
// `messageJobCreatedAt` out-of-order guard, instead of being a second,
// less-tested delivery path alongside the real one.
//
// ---------------------------------------------------------------------------
// Sending twice is the failure that matters
// ---------------------------------------------------------------------------
//
// A customer greeted twice on their birthday, or nagged every hour for a
// month, is worse than one never greeted: §8.12's own advisory is that
// over-notifying is what makes people delete the card. So the rule here is
// that **selecting a pass and marking it as done are the same statement** —
// an UPDATE ... WHERE ... RETURNING, exactly like broadcastWorker's claim and
// messageSweeper's clear. Read-then-write would leave a window in which a
// second tick (or a second machine) selects the same rows again.
//
// Everything downstream is therefore allowed to fail safely: if
// enqueueBroadcast throws after the claim, that customer simply misses this
// year's greeting rather than getting two.

import { Prisma } from '@prisma/client';
import type { Card } from '@prisma/client';

import { prisma } from '../../packages/db/src/index.ts';
import { enqueueBroadcast } from './broadcast.ts';
import { log, errorFields } from './log.ts';

/**
 * The zone "today" is measured in.
 *
 * A birthday is a calendar date, not an instant, so it needs a zone before
 * the question "is it their birthday?" even has an answer. UTC would greet a
 * Riyadh customer three hours into the previous day.
 *
 * One configured zone for the whole install, not per merchant: every current
 * merchant is in one place, and inventing a per-merchant timezone setting
 * (with the settings UI, the migration and the validation it implies) to
 * serve one timezone would be building for a problem nobody has yet. When a
 * second region appears this becomes a Merchant column and this constant
 * becomes its default — that is the migration path, and it is a small one.
 */
export function resolveAutomationTimezone(): string {
  const raw = (process.env.AUTOMATION_TIMEZONE ?? '').trim();
  if (!raw) return 'Asia/Riyadh';
  // A bad zone would throw inside Intl on every tick, silently killing both
  // automations. Verify once, here, and fall back loudly instead.
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: raw }).format(new Date());
    return raw;
  } catch {
    console.error(`[automations] AUTOMATION_TIMEZONE="${raw}" is not a valid IANA zone — falling back to Asia/Riyadh`);
    return 'Asia/Riyadh';
  }
}

export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

/** `at` as a calendar date in `timeZone`, via Intl rather than manual offset arithmetic (which gets DST wrong). */
export function localDateIn(timeZone: string, at: Date): LocalDate {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return { year: get('year'), month: get('month'), day: get('day') };
}

/**
 * The month/day a birthday should be greeted on this year.
 *
 * Exists for one date: **29 February**. A customer born on the 29th has no
 * birthday at all in three years out of four, and would silently never be
 * greeted. Non-leap years fold them onto 28 February, which is the common
 * convention and, more to the point, is not "never".
 */
export function birthdayMatchesToday(
  birthdayMonth: number,
  birthdayDay: number,
  today: LocalDate
): boolean {
  if (birthdayMonth === today.month && birthdayDay === today.day) return true;
  if (birthdayMonth === 2 && birthdayDay === 29 && today.month === 2 && today.day === 28) {
    return !isLeapYear(today.year);
  }
  return false;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

interface ClaimedPass {
  serial: string;
}

export interface AutomationRunResult {
  birthdaysSent: number;
  winbacksSent: number;
}

export interface AutomationRunnerOptions {
  /** Injectable for tests; production leaves it alone. */
  now?: () => Date;
  timeZone?: string;
  /** Ceiling per card per tick, so one card with a huge list cannot monopolise a run. */
  batchSize?: number;
  /** Restricts the run to these merchants. **Test-isolation seam only** — see BroadcastWorker.onlyJobIds. */
  onlyMerchantIds?: string[];
}

export class AutomationRunner {
  private readonly now: () => Date;
  private readonly timeZone: string;
  private readonly batchSize: number;
  private readonly onlyMerchantIds: string[] | undefined;

  constructor(options: AutomationRunnerOptions = {}) {
    this.now = options.now ?? ((): Date => new Date());
    this.timeZone = options.timeZone ?? resolveAutomationTimezone();
    this.batchSize = options.batchSize ?? 500;
    this.onlyMerchantIds =
      options.onlyMerchantIds && options.onlyMerchantIds.length > 0 ? options.onlyMerchantIds : undefined;
  }

  private merchantScope(): Prisma.Sql {
    return this.onlyMerchantIds
      ? Prisma.sql`AND p."merchantId" IN (${Prisma.join(this.onlyMerchantIds)})`
      : Prisma.empty;
  }

  /** Cards with at least one automation switched on, and a non-empty message for it. */
  private async cardsWithAutomations(): Promise<Card[]> {
    return prisma.card.findMany({
      where: {
        ...(this.onlyMerchantIds ? { merchantId: { in: this.onlyMerchantIds } } : {}),
        OR: [
          { birthdayEnabled: true, birthdayMessage: { not: '' } },
          { winbackEnabled: true, winbackMessage: { not: '' } },
        ],
      },
    });
  }

  /**
   * Claims today's birthday passes for `card` — selecting and marking done in
   * one statement (see this file's header).
   *
   * The year comparison is what makes it annual rather than daily: a pass
   * greeted this year is skipped, a pass greeted last year is eligible again.
   */
  private async claimBirthdays(card: Card, today: LocalDate): Promise<ClaimedPass[]> {
    const stamp = this.now();
    const startOfYear = new Date(Date.UTC(today.year, 0, 1));
    // 29 Feb folded onto 28 Feb in non-leap years — the same rule as
    // birthdayMatchesToday, expressed in SQL.
    const foldsLeapDay = today.month === 2 && today.day === 28 && !isLeapYear(today.year);
    const dayMatch = foldsLeapDay
      ? Prisma.sql`(p."birthdayMonth" = 2 AND p."birthdayDay" IN (28, 29))`
      : Prisma.sql`(p."birthdayMonth" = ${today.month} AND p."birthdayDay" = ${today.day})`;

    return prisma.$queryRaw<ClaimedPass[]>`
      UPDATE "Pass" AS p
      SET "lastBirthdayAt" = ${stamp}
      FROM (
        SELECT id FROM "Pass" AS p
        WHERE p."cardId" = ${card.id}
          AND ${dayMatch}
          AND (p."lastBirthdayAt" IS NULL OR p."lastBirthdayAt" < ${startOfYear})
          ${this.merchantScope()}
        ORDER BY id
        LIMIT ${this.batchSize}
        FOR UPDATE SKIP LOCKED
      ) AS c
      WHERE p.id = c.id
      RETURNING p.serial;
    `;
  }

  /**
   * Claims win-back passes for `card`: not stamped in `winbackDays`, and not
   * already chased within the same window.
   *
   * Re-using `winbackDays` as the cooldown is deliberate. A lapsed customer
   * who ignores the nudge stays lapsed forever, so a cooldown of "never
   * again" abandons them and a cooldown of "daily" harasses them; chasing at
   * most once per window is the middle. A pass never stamped at all is
   * excluded — `lastStampAt IS NULL` means they joined and never came back,
   * which is a job for the welcome message, not a win-back.
   */
  private async claimWinbacks(card: Card): Promise<ClaimedPass[]> {
    const stamp = this.now();
    const cutoff = new Date(stamp.getTime() - card.winbackDays * 24 * 60 * 60 * 1000);

    return prisma.$queryRaw<ClaimedPass[]>`
      UPDATE "Pass" AS p
      SET "lastWinbackAt" = ${stamp}
      FROM (
        SELECT id FROM "Pass" AS p
        WHERE p."cardId" = ${card.id}
          AND p."lastStampAt" IS NOT NULL
          AND p."lastStampAt" < ${cutoff}
          AND (p."lastWinbackAt" IS NULL OR p."lastWinbackAt" < ${cutoff})
          ${this.merchantScope()}
        ORDER BY id
        LIMIT ${this.batchSize}
        FOR UPDATE SKIP LOCKED
      ) AS c
      WHERE p.id = c.id
      RETURNING p.serial;
    `;
  }

  /**
   * One pass over every card with an automation enabled. Safe to call more
   * often than daily — the claims above are what prevent a second run in the
   * same day from sending anything twice.
   */
  async runOnce(): Promise<AutomationRunResult> {
    const today = localDateIn(this.timeZone, this.now());
    const cards = await this.cardsWithAutomations();
    let birthdaysSent = 0;
    let winbacksSent = 0;

    for (const card of cards) {
      if (card.birthdayEnabled && card.birthdayMessage) {
        for (const { serial } of await this.claimBirthdays(card, today)) {
          // One enqueue per customer, each failing independently: a single
          // bad message must not abort the whole run for every other card.
          try {
            await enqueueBroadcast(card, card.birthdayMessage, 'birthday', { onlySerial: serial });
            birthdaysSent++;
          } catch (err) {
            log.error('automations.birthday_failed', { serial, ...errorFields(err) });
          }
        }
      }
      if (card.winbackEnabled && card.winbackMessage) {
        for (const { serial } of await this.claimWinbacks(card)) {
          try {
            await enqueueBroadcast(card, card.winbackMessage, 'winback', { onlySerial: serial });
            winbacksSent++;
          } catch (err) {
            log.error('automations.winback_failed', { serial, ...errorFields(err) });
          }
        }
      }
    }

    if (birthdaysSent || winbacksSent) {
      log.info('automations.sent', { birthdays: birthdaysSent, winbacks: winbacksSent });
    }
    return { birthdaysSent, winbacksSent };
  }
}

/**
 * Runs `runOnce()` on a timer.
 *
 * Hourly rather than daily-at-a-fixed-hour, on purpose. A once-a-day cron
 * that happens to be asleep, mid-deploy, or crashed at its one appointed
 * minute silently skips a whole day — and nobody notices a birthday that did
 * not arrive. Hourly means a missed tick costs an hour, not a day, and the
 * claim logic makes the extra 23 runs no-ops.
 */
export class AutomationScheduler {
  private readonly runner: AutomationRunner;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<unknown> | undefined;
  private stopped = true;

  constructor(options: AutomationRunnerOptions & { intervalMs?: number } = {}) {
    this.runner = new AutomationRunner(options);
    this.intervalMs = options.intervalMs ?? 60 * 60 * 1000;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = async (): Promise<void> => {
      if (this.stopped) return;
      try {
        this.inFlight = this.runner.runOnce();
        await this.inFlight;
      } catch (err) {
        // Never let a bad tick kill the timer — the next hour should still run.
        console.error('[automations] tick failed:', err);
      } finally {
        this.inFlight = undefined;
      }
    };
    void tick();
    this.timer = setInterval(() => void tick(), this.intervalMs);
    // Never hold the process open on shutdown.
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight?.catch(() => {});
  }
}
