// apps/demo/messageSweeper.ts — sub-project 9 ("ephemeral notifications").
// A broadcast is a moment-in-time message, not permanent card content (the
// owner's own words: "it should disappear after ten or twenty minutes").
// apps/demo/passContent.ts already stops *rendering* the "msg" back field
// once `Pass.messageExpiresAt` has passed, but that alone only takes effect
// the next time the pass happens to be rebuilt (a stamp landing, a card
// edit) — potentially hours later. This module is what makes an
// already-issued pass catch up immediately: a periodic sweep, running in
// the same process as apps/demo/broadcastWorker.ts (started once at boot,
// server.ts), that clears `message`/`messageExpiresAt` on every Pass whose
// expiry has passed and pushes a content-free wake-up (BUILD.md §9.3) to
// each of its devices so the field disappears right away.
//
// Batched and paced the same way BroadcastWorker is (BUILD.md §18 item 6's
// reasoning applies just as much here: do not push thousands of devices in
// one tick), and claimed with the same `SELECT … FOR UPDATE SKIP LOCKED`
// idiom broadcastWorker.ts's claimBatch() uses, so two sweeper instances (or
// a sweeper racing a broadcast worker's own write to the same row) can never
// double-clear or double-push the same Pass. Unlike a BroadcastRecipient,
// there is no "pending/sent/failed" lifecycle here — the clear itself *is*
// the whole unit of work; the push that follows is a best-effort wake-up
// that a customer's device catching up on its own next natural poll would
// eventually achieve anyway.
//
// `sendOne` is always injected — server.ts wires it to the exact same warm
// ApnsClient session every other push path in this process shares
// (broadcastWorker.ts's own `sendOne`, in fact — see server.ts's wiring);
// this module never constructs a client or opens a new connection, and
// tests never touch a network.

import { prisma } from '../../packages/db/src/index.ts';
import type { SendPushFn } from './broadcastWorker.ts';

interface ExpiredRow {
  id: string;
  serial: string;
}

export interface MessageSweeperOptions {
  sendOne: SendPushFn;
  /** How many expired Pass rows one runOnce() cycle clears and pushes for, at most — same "batch it, don't push thousands in one tick" rule as apps/demo/broadcastWorker.ts's own batchSize. */
  batchSize?: number;
  /** Minimum delay between individual device pushes within one batch — 0 in tests. */
  pushIntervalMs?: number;
  /** Delay between runOnce() cycles when running via start()/stop(). */
  pollIntervalMs?: number;
  /** Injectable clock, so tests can control `now` without waiting on real wall-clock time. */
  now?: () => Date;
  /** Injectable sleep, so tests never actually wait out pushIntervalMs. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS = {
  batchSize: 50,
  pushIntervalMs: 25,
  // A 15-minute default TTL (apps/demo/broadcast.ts's
  // DEFAULT_BROADCAST_MESSAGE_TTL_MINUTES) does not need sub-minute
  // sweeping to feel immediate to a customer — a cleared message vanishing
  // up to a minute after its expiry is well within "it should disappear
  // after ten or twenty minutes."
  pollIntervalMs: 60_000,
};

function defaultSleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/**
 * Clears `message`/`messageExpiresAt` on every Pass whose expiry has
 * passed, in bounded batches, and pushes a wake-up to each affected Pass's
 * devices. One instance is built and started once, in server.ts, at boot,
 * alongside BroadcastWorker.
 */
export class MessageSweeper {
  private readonly sendOne: SendPushFn;
  private readonly batchSize: number;
  private readonly pushIntervalMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  private timer: NodeJS.Timeout | undefined;
  private stopped = true;
  private inFlight: Promise<void> | undefined;

  constructor(options: MessageSweeperOptions) {
    this.sendOne = options.sendOne;
    this.batchSize = options.batchSize ?? DEFAULTS.batchSize;
    this.pushIntervalMs = options.pushIntervalMs ?? DEFAULTS.pushIntervalMs;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
    this.now = options.now ?? ((): Date => new Date());
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Atomically clears up to `batchSize` expired rows and returns which ones
   * it cleared. `FOR UPDATE SKIP LOCKED` inside the subquery — the same
   * idiom apps/demo/broadcastWorker.ts's claimBatch() uses — is what makes
   * two sweeper instances running at once safe against the same table:
   * Postgres itself arbitrates which one gets each row, and a claimer that
   * would otherwise block on a row someone else has skips it instead. There
   * is no separate "claim, then later finish" step the way
   * BroadcastRecipient needs (a row that fails to push is not retried —
   * see this file's own header comment for why that is an accepted,
   * intentional gap, not an oversight): clearing the columns is itself the
   * complete, durable unit of work.
   */
  private async clearExpiredBatch(): Promise<ExpiredRow[]> {
    const now = this.now();
    return prisma.$queryRaw<ExpiredRow[]>`
      UPDATE "Pass" AS p
      SET message = '', "messageExpiresAt" = NULL
      FROM (
        SELECT id FROM "Pass"
        WHERE "messageExpiresAt" IS NOT NULL AND "messageExpiresAt" <= ${now}
        ORDER BY "messageExpiresAt"
        LIMIT ${this.batchSize}
        FOR UPDATE SKIP LOCKED
      ) AS c
      WHERE p.id = c.id
      RETURNING p.id, p.serial;
    `;
  }

  /**
   * One clear-and-push cycle: clears up to `batchSize` expired Pass rows
   * (across any card, any merchant — like BroadcastWorker, this class is
   * not scoped to one) and pushes a wake-up to every device registered for
   * each, pacing them `pushIntervalMs` apart. Returns how many Pass rows
   * were cleared (0 means nothing had expired this cycle). Exposed
   * directly — not only reachable via start()/stop() — so tests can drive
   * exactly one cycle deterministically instead of racing a real interval
   * timer.
   */
  async runOnce(): Promise<number> {
    const rows = await this.clearExpiredBatch();
    if (rows.length === 0) return 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const devices = await prisma.device.findMany({ where: { passSerial: row.serial } });
      for (const device of devices) {
        const result = await this.sendOne(device);
        if (!result.ok && result.gone) {
          // BUILD.md: 410 Gone deletes the Device row, same as every other push path.
          await prisma.device
            .delete({ where: { deviceId_passSerial: { deviceId: device.deviceId, passSerial: row.serial } } })
            .catch(() => {}); // already gone / raced with an unregister — fine either way
        }
      }
      if (this.pushIntervalMs > 0 && i < rows.length - 1) await this.sleep(this.pushIntervalMs);
    }

    return rows.length;
  }

  /**
   * Starts the interval loop — production use only (server.ts calls this
   * once, at boot). Tests call runOnce() directly instead, deterministically.
   */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = (): void => {
      if (this.stopped) return;
      this.inFlight = this.runOnce()
        .catch((err: unknown) => {
          console.error('[message sweeper] cycle failed:', err);
        })
        .then(() => {
          this.inFlight = undefined;
          if (!this.stopped) this.timer = setTimeout(tick, this.pollIntervalMs);
        });
    };
    tick();
  }

  /** Stops the interval loop and waits for any cycle already in flight to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.inFlight) await this.inFlight.catch(() => {});
  }
}
