// apps/demo/broadcast.ts — the data layer for merchant broadcasts (BUILD.md
// §8.12 / §18 item 6 / §10). Split out of server.ts, same convention as
// cardEdit.ts / stamp.ts / staff.ts: apps/demo/test/broadcast.test.ts
// exercises this directly against the real local Postgres, no HTTP.
//
// This module only ever *enqueues* — a plain INSERT (BroadcastJob plus one
// BroadcastRecipient row per Pass the card currently has), which is what
// lets the request handler that calls it return immediately. It never
// pushes anything and never imports an APNs client; the actual fan-out is
// apps/demo/broadcastWorker.ts's job, running entirely outside any request
// handler (BUILD.md §18 item 6: "fanning out APNs inside a request handler
// … one broadcast times out the request").
//
// docs/BUILD.md §2's stack table specifies BullMQ on Redis for this queue.
// See that section's 2026-08-04 note for why this ships as a
// Postgres-backed queue instead (no Redis provisioned, and standing one up
// for this alone was judged more moving parts than the feature warrants
// tonight) — BroadcastJob/BroadcastRecipient below, claimed with
// `SELECT … FOR UPDATE SKIP LOCKED` by broadcastWorker.ts, is that queue.

import type { Card, BroadcastJob } from '@prisma/client';
import { prisma } from '../../packages/db/src/index.ts';
import { invisibleChangeMarker } from '../../packages/pass/src/buildPass.ts';

/**
 * The hard cap on a broadcast message — BUILD.md §8.12's own number.
 * Enforced here (server-side, unconditionally, by truncation) as well as
 * by the textarea's own `maxlength` in the UI: the UI attribute is a
 * courtesy, this is the actual limit — a client that skips the textarea
 * entirely (a raw POST) gets truncated exactly the same as one that
 * doesn't.
 */
export const BROADCAST_MESSAGE_MAX_LENGTH = 150;

/**
 * Default `BROADCAST_MESSAGE_TTL_MINUTES` (sub-project 9, "ephemeral
 * notifications") — how long a broadcast's text stays on a `Pass` before
 * `apps/demo/messageSweeper.ts` clears it. The owner's own ask: "it should
 * disappear after ten or twenty minutes." 15 splits that range.
 */
export const DEFAULT_BROADCAST_MESSAGE_TTL_MINUTES = 15;

/**
 * `BROADCAST_MESSAGE_TTL_MINUTES` from the environment, falling back to
 * {@link DEFAULT_BROADCAST_MESSAGE_TTL_MINUTES} for anything missing,
 * non-numeric or non-positive — same "parse once, fail soft to a sane
 * default" convention as apps/demo/server.ts's `resolvePort()`. Read by
 * apps/demo/broadcastWorker.ts (to stamp `Pass.messageExpiresAt` when it
 * writes a message) and apps/demo/messageSweeper.ts's own default batch
 * cadence is independent of this value, but both live in the same process
 * and are meant to be tuned together without a deploy.
 */
export function resolveBroadcastMessageTtlMinutes(): number {
  const raw = process.env.BROADCAST_MESSAGE_TTL_MINUTES;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_BROADCAST_MESSAGE_TTL_MINUTES;
}

/**
 * Cleans and caps a merchant- or system-authored broadcast message before
 * it is ever stored: strips control characters (defence for the "escape
 * for every context" requirement — HTML via escapeHtml() at render time,
 * pass.json via JSON.stringify(), but neither of those saves you from a
 * raw control byte sitting in the middle of otherwise-normal text),
 * collapses embedded newlines/tabs to a single space (a PassKit field
 * value is one line), and caps length by *code point*, not UTF-16 code
 * unit — `String#slice` would cut an Arabic combining sequence or a
 * surrogate pair in half.
 */
export function sanitizeBroadcastMessage(raw: string): string {
  const collapsed = raw
    .replace(/[\r\n\t]+/g, ' ')
    // eslint-disable-next-line no-control-regex -- deliberately stripping control bytes
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const codePoints = Array.from(collapsed);
  return codePoints.length > BROADCAST_MESSAGE_MAX_LENGTH
    ? codePoints.slice(0, BROADCAST_MESSAGE_MAX_LENGTH).join('')
    : collapsed;
}

/** How many customers a broadcast to `card` would currently reach — one Pass row is one recipient (a customer holding the same pass on two devices is still one), matching the "live recipient count" BUILD.md §8.12 asks the Send tab to show. */
export async function recipientCountForCard(card: Pick<Card, 'id'>): Promise<number> {
  return prisma.pass.count({ where: { cardId: card.id } });
}

export type BroadcastKind = 'manual' | 'welcome' | 'birthday' | 'winback';

/**
 * Enqueues a broadcast against `card` — one BroadcastJob row plus one
 * BroadcastRecipient row per Pass the card has *right now* (a customer who
 * enrols after this call is simply not part of this broadcast, the same
 * "snapshot at send time" semantics any broadcast tool has). Takes an
 * already-loaded `Card`, not a bare `cardId` + `merchantId` pair — every
 * caller is expected to have resolved it via the same
 * merchant-scoped lookup every other card route uses (server.ts's
 * `findOwnedCard`), so a card belonging to a different merchant can never
 * reach this function at all; there is no `merchantId` parameter for a
 * caller to get wrong.
 *
 * Returns as soon as the row(s) are written — no push, no APNs client, no
 * network call of any kind happens here. `pushMessage` (the exact text
 * every recipient's `Pass.message` will be set to) is computed once, right
 * here, as the sanitised text plus one `invisibleChangeMarker()` call —
 * see the BroadcastJob model's own doc comment in schema.prisma for why
 * that "compute once, at enqueue time" placement is what makes a repeated
 * identical broadcast still bank a second lock-screen banner without ever
 * re-banging the same banner on a retry.
 *
 * `options.onlySerial` narrows the recipient snapshot to one specific Pass
 * instead of every Pass the card currently has. The welcome automation
 * (server.ts's enqueueWelcomeBroadcast) relies on this: without it, a
 * `kind: 'welcome'` broadcast enqueued for the customer who just enrolled
 * would fan out to *every* existing customer of that card too (they'd all
 * get a fresh "Welcome!" lock-screen banner, and their `Pass.message` would
 * be overwritten with that welcome text, clobbering whatever real broadcast
 * they'd last received) — one stranger's own enrolment is not an event any
 * other customer should see on their pass.
 */
export async function enqueueBroadcast(
  card: Card,
  rawMessage: string,
  kind: BroadcastKind = 'manual',
  options: { onlySerial?: string } = {}
): Promise<BroadcastJob> {
  const message = sanitizeBroadcastMessage(rawMessage);
  if (!message) throw new Error('broadcast message must not be empty after sanitisation');
  const pushMessage = `${message}${invisibleChangeMarker()}`;

  const passes = await prisma.pass.findMany({
    where: options.onlySerial ? { cardId: card.id, serial: options.onlySerial } : { cardId: card.id },
    select: { serial: true },
  });

  if (passes.length === 0) {
    // Nothing to send to — still a real, visible job (BUILD.md verify:
    // "enqueuing … creates one job with the right recipient count", and 0
    // is a right count too), just one that's already done.
    return prisma.broadcastJob.create({
      data: {
        merchantId: card.merchantId,
        cardId: card.id,
        kind,
        message,
        pushMessage,
        status: 'sent',
        recipientCount: 0,
        completedAt: new Date(),
      },
    });
  }

  return prisma.$transaction(async (tx) => {
    const job = await tx.broadcastJob.create({
      data: {
        merchantId: card.merchantId,
        cardId: card.id,
        kind,
        message,
        pushMessage,
        status: 'queued',
        recipientCount: passes.length,
      },
    });
    await tx.broadcastRecipient.createMany({
      data: passes.map((p) => ({ jobId: job.id, passSerial: p.serial })),
    });
    return job;
  });
}

/** Recent broadcasts for the Send tab's history list, newest first, each carrying its card's name (the UI never shows a bare cardId). */
export async function listBroadcastJobs(merchantId: string, limit = 20) {
  return prisma.broadcastJob.findMany({
    where: { merchantId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { card: { select: { name: true } } },
  });
}

/** One job, scoped to `merchantId` — the JSON status-polling endpoint uses this so a guessed/leaked job id from another merchant's broadcast 404s exactly like an unknown one, never confirming it exists (same "404, not 403" convention as findOwnedCard). */
export async function getBroadcastJob(jobId: string, merchantId: string): Promise<BroadcastJob | null> {
  return prisma.broadcastJob.findFirst({ where: { id: jobId, merchantId } });
}
