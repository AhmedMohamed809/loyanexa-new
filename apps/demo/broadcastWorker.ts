// apps/demo/broadcastWorker.ts — the queue's consumer side (BUILD.md §8.12
// / §18 item 6 / §10). apps/demo/broadcast.ts's enqueueBroadcast() only
// ever inserts rows; everything that actually talks to APNs happens here,
// entirely outside any request handler, in an in-process worker started
// once at boot (server.ts) and never constructed per push.
//
// The queue itself is two Postgres tables (schema.prisma's BroadcastJob /
// BroadcastRecipient — see the 2026-08-04 note in docs/BUILD.md §2 for why
// Postgres instead of the BullMQ-on-Redis §2 specifies). Claiming a batch
// is one atomic statement:
//
//   UPDATE "BroadcastRecipient" AS r
//   SET status = 'sending', "claimedAt" = now(), attempts = r.attempts + 1
//   FROM (
//     SELECT id FROM "BroadcastRecipient"
//     WHERE (status = 'pending' AND "nextAttemptAt" <= now())
//        OR (status = 'sending' AND "claimedAt" < <stale cutoff>)
//     ORDER BY id LIMIT <batchSize>
//     FOR UPDATE SKIP LOCKED
//   ) AS c
//   WHERE r.id = c.id
//   RETURNING …;
//
// `FOR UPDATE SKIP LOCKED` inside the subquery is what makes two worker
// processes (two machines, or two instances in a test) safe to run against
// the same table at once: Postgres itself will never hand the same row's
// lock to two concurrent claimers, and a claimer that would otherwise wait
// on a row someone else already has skips it and takes the next one
// instead, rather than blocking. Nothing in this file needs its own
// distributed lock — Postgres already is one, for exactly this kind of
// "claim work off a shared table" query. See
// apps/demo/test/broadcastWorker.test.ts for a test that runs two
// BroadcastWorker instances concurrently against the real database and
// checks that every recipient was pushed exactly once.
//
// A crashed worker cannot strand a recipient in "sending" forever: the
// `OR (status = 'sending' AND "claimedAt" < <stale cutoff>)` arm above
// re-claims a row nobody has updated in `staleClaimMs`. This is a
// self-healing guarantee (forward progress always resumes), not a
// mathematically perfect exactly-once one — the one gap that cannot be
// closed without an idempotency key on Apple's side (which APNs' contentless
// background push does not offer): if a process is killed in the
// microscopic window between APNs accepting a push and this process
// recording that success in Postgres, the *next* claim will re-send that
// one push. Apple's own gateway is not itself duplicate-safe against that;
// nothing this file can do closes it fully. What *is* guaranteed, and is
// what the job's own verification asks for: two workers running at once
// never both claim the same row (SKIP LOCKED), and a merchant's own
// message text is only ever written to Pass.message once per broadcast
// job (see processRecipient's own comment) — a retried push re-sends the
// same already-stored text, which causes no *new* lock-screen banner on a
// device that already caught up, only a harmless extra wake-up.

import { Prisma } from '@prisma/client';
import type { BroadcastJob, Device } from '@prisma/client';
import { prisma } from '../../packages/db/src/index.ts';
import { resolveBroadcastMessageTtlMinutes } from './broadcast.ts';

export type SendPushOutcome = { ok: true } | { ok: false; gone?: boolean; error?: string };
/** Injected by the caller — server.ts wires this to the real ApnsClient's warm HTTP/2 session (never a new client per push); tests inject a stub that never touches a network, same convention as apps/demo/cardPush.ts's `sendOne`. */
export type SendPushFn = (device: Device) => Promise<SendPushOutcome>;

export interface BroadcastWorkerOptions {
  sendOne: SendPushFn;
  /** How many BroadcastRecipient rows one runOnce() cycle claims at most. */
  batchSize?: number;
  /** Bounded retry — a recipient stuck failing forever is marked `failed` with a reason instead of retried indefinitely. */
  maxAttempts?: number;
  /** Base of the exponential backoff applied between retries (BUILD.md: "Apple will throttle a burst … back off on failure"). */
  backoffBaseMs?: number;
  /** Upper bound on the backoff delay, however many attempts have been made. */
  backoffMaxMs?: number;
  /** How long a `"sending"` row can sit unclaimed-by-anyone-finishing before a future claim treats it as abandoned and re-claims it (the crash-recovery path described in this file's own header comment). */
  staleClaimMs?: number;
  /** Delay between runOnce() cycles when running via start()/stop(). */
  pollIntervalMs?: number;
  /** How long a written `Pass.message` stays live before apps/demo/messageSweeper.ts clears it (sub-project 9). Defaults to `resolveBroadcastMessageTtlMinutes()` — `BROADCAST_MESSAGE_TTL_MINUTES`, or 15. Read once, at construction, same as every other env-derived default in this file's caller (server.ts). */
  ttlMinutes?: number;
  /** Minimum delay between individual pushes within one batch — the actual burst throttle: pacing requests out instead of firing a whole batch at once. 0 in tests. */
  pushIntervalMs?: number;
  /** Injectable clock, so tests can control `now`/backoff/staleness without waiting on real wall-clock time. */
  now?: () => Date;
  /** Injectable sleep, so tests never actually wait out pushIntervalMs. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Restricts claiming to these job ids. **A test-isolation seam, not a
   * production feature** — leave it unset in production, where claiming
   * queue-wide is the whole point and every worker is a real sender.
   *
   * It exists because `node --test` runs test *files* in parallel against
   * one shared local Postgres, and the queue-wide claim below is doing
   * exactly its job when it claims another file's recipients: they are
   * pending rows in the same table. The victim file then observes zero
   * pushes, because the thief pushed them through *its* recorder. That is
   * the same property `broadcastWorker.test.ts`'s "two workers never claim
   * the same recipient" test asserts on purpose — correct in production,
   * ruinous across test files. Scoping each test's worker to its own job
   * ids makes the suite deterministic without weakening that guarantee.
   */
  onlyJobIds?: string[];
}

interface ClaimedRow {
  id: string;
  jobId: string;
  passSerial: string;
  attempts: number;
}

const DEFAULTS = {
  batchSize: 25,
  maxAttempts: 5,
  backoffBaseMs: 2_000,
  backoffMaxMs: 5 * 60_000,
  staleClaimMs: 2 * 60_000,
  pollIntervalMs: 1_000,
  pushIntervalMs: 25,
};

function defaultSleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/**
 * Claims batches of BroadcastRecipient rows and pushes to each — the
 * consumer half of the Postgres-backed broadcast queue. One instance is
 * built and started once, in server.ts, at boot; `sendOne` is the only
 * thing that ever touches a network, and it is always injected, never
 * constructed here — this class never imports an APNs client.
 */
export class BroadcastWorker {
  private readonly sendOne: SendPushFn;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly staleClaimMs: number;
  private readonly pollIntervalMs: number;
  private readonly pushIntervalMs: number;
  private readonly ttlMinutes: number;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onlyJobIds: string[] | undefined;

  private timer: NodeJS.Timeout | undefined;
  private stopped = true;
  private inFlight: Promise<void> | undefined;

  constructor(options: BroadcastWorkerOptions) {
    this.sendOne = options.sendOne;
    this.batchSize = options.batchSize ?? DEFAULTS.batchSize;
    this.maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULTS.backoffBaseMs;
    this.backoffMaxMs = options.backoffMaxMs ?? DEFAULTS.backoffMaxMs;
    this.staleClaimMs = options.staleClaimMs ?? DEFAULTS.staleClaimMs;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
    this.pushIntervalMs = options.pushIntervalMs ?? DEFAULTS.pushIntervalMs;
    this.ttlMinutes = options.ttlMinutes ?? resolveBroadcastMessageTtlMinutes();
    this.now = options.now ?? ((): Date => new Date());
    this.sleep = options.sleep ?? defaultSleep;
    this.onlyJobIds =
      options.onlyJobIds && options.onlyJobIds.length > 0 ? options.onlyJobIds : undefined;
  }

  private backoffFor(attempts: number): number {
    const ms = this.backoffBaseMs * 2 ** Math.max(0, attempts - 1);
    return Math.min(ms, this.backoffMaxMs);
  }

  private async claimBatch(): Promise<ClaimedRow[]> {
    const now = this.now();
    const staleBefore = new Date(now.getTime() - this.staleClaimMs);
    const jobScope = this.onlyJobIds
      ? Prisma.sql`AND "jobId" IN (${Prisma.join(this.onlyJobIds)})`
      : Prisma.empty;
    return prisma.$queryRaw<ClaimedRow[]>`
      UPDATE "BroadcastRecipient" AS r
      SET status = 'sending', "claimedAt" = ${now}, attempts = r.attempts + 1
      FROM (
        SELECT id FROM "BroadcastRecipient"
        WHERE ((status = 'pending' AND "nextAttemptAt" <= ${now})
           OR (status = 'sending' AND "claimedAt" < ${staleBefore}))
        ${jobScope}
        ORDER BY id
        LIMIT ${this.batchSize}
        FOR UPDATE SKIP LOCKED
      ) AS c
      WHERE r.id = c.id
      RETURNING r.id, r."jobId", r."passSerial", r.attempts;
    `;
  }

  /**
   * One claim-and-process cycle: claims up to `batchSize` recipient rows
   * (across any job, any merchant — the worker itself is not scoped to
   * one) and pushes to each, sequentially, pacing them `pushIntervalMs`
   * apart. Returns how many rows were claimed (0 means the queue was
   * empty). Exposed directly — not only reachable via start()/stop() — so
   * tests can drive exactly one cycle deterministically instead of racing
   * a real interval timer.
   */
  async runOnce(): Promise<number> {
    const rows = await this.claimBatch();
    if (rows.length === 0) return 0;

    const jobIds = [...new Set(rows.map((r) => r.jobId))];
    const jobs = await prisma.broadcastJob.findMany({ where: { id: { in: jobIds } } });
    const jobById = new Map(jobs.map((j) => [j.id, j]));

    const toMarkSending = jobs.filter((j) => j.status === 'queued').map((j) => j.id);
    if (toMarkSending.length > 0) {
      await prisma.broadcastJob.updateMany({ where: { id: { in: toMarkSending } }, data: { status: 'sending' } });
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const job = jobById.get(row.jobId);
      // The job row is gone (e.g. its Card/Merchant was deleted, cascading
      // through BroadcastJob → BroadcastRecipient — this row shouldn't
      // exist either, but the claim already happened this cycle). Nothing
      // sane to do; leave it claimed and move on rather than throw.
      if (job) await this.processRecipient(row, job);
      if (this.pushIntervalMs > 0 && i < rows.length - 1) await this.sleep(this.pushIntervalMs);
    }

    await this.finalizeJobs(jobIds);
    return rows.length;
  }

  private async processRecipient(row: ClaimedRow, job: BroadcastJob): Promise<void> {
    const devices = await prisma.device.findMany({ where: { passSerial: row.passSerial } });

    // Written on *every* attempt, deliberately — including a stale reclaim
    // after a crash between "claimed" and "wrote the message", which is
    // exactly why this isn't guarded by `attempts === 1`. What it *is*
    // guarded on is `messageJobCreatedAt`: a job only gets to write
    // `message` when its own `createdAt` is >= whatever job last wrote it.
    // Without that guard, two jobs against the same pass can complete out
    // of order — job 1's push fails and backs off (up to 5 minutes,
    // BroadcastWorker's own backoffMaxMs), job 2 lands and writes first,
    // then job 1's retry fires later and, with no ordering check, would
    // unconditionally clobber `message` back to job 1's *older* text,
    // re-banging a stale banner on a customer's lock screen over a message
    // they've already moved past. The `OR messageJobCreatedAt IS NULL` arm
    // is just "first broadcast ever reaches this pass"; `lte` (not `lt`)
    // deliberately lets a job rewrite its own already-stored value on a
    // later retry of *itself* — a no-op in content, since job.pushMessage
    // is fixed at enqueue time (enqueueBroadcast's own comment) — while
    // still refusing to move backwards for a strictly older job.
    // messageExpiresAt (sub-project 9, "ephemeral notifications"): stamped
    // at write time, not at enqueue time, alongside message/
    // messageJobCreatedAt above and under the exact same out-of-order
    // guard — a stale retry that loses the ordering race must not push the
    // expiry backwards any more than it should push the text backwards.
    // apps/demo/messageSweeper.ts is what actually clears it once it
    // passes; apps/demo/passContent.ts is what stops rendering the "msg"
    // field once it has (whichever happens first — the sweeper's own push
    // is what makes an already-issued pass catch up before its next
    // incidental rebuild).
    await prisma.pass.updateMany({
      where: {
        serial: row.passSerial,
        OR: [{ messageJobCreatedAt: null }, { messageJobCreatedAt: { lte: job.createdAt } }],
      },
      data: {
        message: job.pushMessage,
        messageJobCreatedAt: job.createdAt,
        messageExpiresAt: new Date(this.now().getTime() + this.ttlMinutes * 60_000),
      },
    });

    let failed = false;
    let lastError: string | undefined;
    for (const device of devices) {
      const result = await this.sendOne(device);
      if (result.ok) continue;
      if (result.gone) {
        // BUILD.md: 410 Gone deletes the Device row, same as the existing push path.
        await prisma.device
          .delete({ where: { deviceId_passSerial: { deviceId: device.deviceId, passSerial: device.passSerial } } })
          .catch(() => {}); // already gone / raced with an unregister — fine either way
        continue;
      }
      failed = true;
      lastError = result.error ?? 'push failed';
    }

    // updateMany, not update, on every write below — deliberately: a Card
    // or Merchant can be deleted (cascading through BroadcastJob →
    // BroadcastRecipient) while this recipient is mid-flight between the
    // claim above and here, e.g. a merchant closing their account during
    // an in-progress broadcast. `update()` throws (Prisma P2025) when its
    // target row is already gone, which would crash this whole batch
    // cycle over one vanished row; `updateMany()` with the same `where`
    // simply matches zero rows and moves on. The job row can vanish the
    // same way, so its own count increments use updateMany too.
    if (!failed) {
      await prisma.broadcastRecipient.updateMany({ where: { id: row.id }, data: { status: 'sent', lastError: null } });
      await prisma.broadcastJob.updateMany({ where: { id: job.id }, data: { sentCount: { increment: 1 } } });
      return;
    }

    if (row.attempts >= this.maxAttempts) {
      await prisma.broadcastRecipient.updateMany({
        where: { id: row.id },
        data: { status: 'failed', lastError: lastError ?? 'unknown error' },
      });
      await prisma.broadcastJob.updateMany({ where: { id: job.id }, data: { failedCount: { increment: 1 } } });
      return;
    }

    await prisma.broadcastRecipient.updateMany({
      where: { id: row.id },
      data: {
        status: 'pending',
        lastError: lastError ?? 'unknown error',
        nextAttemptAt: new Date(this.now().getTime() + this.backoffFor(row.attempts)),
      },
    });
  }

  /** For every job this cycle touched, flips it to `sent` once none of its recipients are still pending/sending — i.e. every one has reached a terminal state (sent or failed). */
  private async finalizeJobs(jobIds: string[]): Promise<void> {
    for (const jobId of jobIds) {
      const remaining = await prisma.broadcastRecipient.count({
        where: { jobId, status: { in: ['pending', 'sending'] } },
      });
      if (remaining === 0) {
        await prisma.broadcastJob.updateMany({
          where: { id: jobId, status: { not: 'sent' } },
          data: { status: 'sent', completedAt: new Date() },
        });
      }
    }
  }

  /**
   * Starts the interval loop — production use only (server.ts calls this
   * once, at boot). Tests call runOnce() directly instead, deterministically.
   * Never overlaps two cycles: a slow cycle simply delays the next tick
   * rather than a second one starting concurrently with it (which would
   * still be *safe* — claimBatch() is what actually prevents double-claims
   * — but would make the interval meaningless as a pacing knob).
   */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = (): void => {
      if (this.stopped) return;
      this.inFlight = this.runOnce()
        .catch((err: unknown) => {
          console.error('[broadcast worker] cycle failed:', err);
        })
        .then(() => {
          this.inFlight = undefined;
          if (!this.stopped) this.timer = setTimeout(tick, this.pollIntervalMs);
        });
    };
    tick();
  }

  /** Stops the interval loop and waits for any cycle already in flight to finish — "stop it cleanly on shutdown", not mid-push. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.inFlight) await this.inFlight.catch(() => {});
  }
}
