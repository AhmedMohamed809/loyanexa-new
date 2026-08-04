// apps/demo/passContent.ts — builds the pass.json content for a Card/Pass
// pair. Split out of server.ts (same reasoning as cardEdit.ts / stamp.ts) so
// apps/demo/test/passContent.test.ts can assert on its shape directly, no
// HTTP, no database, no signing involved — this is pure data shaping.
//
// Used both by POST /:code/pass (issuing a brand-new pass) and by the
// PassKit "get latest pass" web service endpoint (rebuilding an existing
// one after a stamp). One implementation so the two can never drift apart.

import type { Card, Pass } from '@prisma/client';
import { invisibleChangeMarker, type PassContent } from '../../packages/pass/src/buildPass.ts';
import { t, arabicDigits, type Lang } from '../../packages/i18n/src/index.ts';
import { parseCardLocations, defaultRelevantText, DEFAULT_MAX_DISTANCE_METERS } from './locations.ts';

/** Card.lang is a plain `string` column (Prisma has no enum for it) — this is the one coercion point, same pattern as server.ts's resolveLang(). */
function cardLang(card: Pick<Card, 'lang'>): Lang {
  return card.lang === 'en' ? 'en' : 'ar';
}

/**
 * Auto-generated terms per BUILD.md §8.6 — built from the card's own
 * settings, the merchant writes nothing. Customer-facing copy, so it reads
 * in the card's own language (BUILD.md §13) rather than always English —
 * previously this ignored card.lang entirely.
 */
export function buildTermsText(card: Card): string {
  const lang = cardLang(card);
  const expiry =
    card.expiryType === 'duration'
      ? t(lang, 'passExpiryDays', { days: arabicDigits(card.expiryDays ?? 0, lang) })
      : card.expiryType === 'fixed'
        ? arabicDigits(card.expiryDate?.toISOString().slice(0, 10) ?? '', lang) || t(lang, 'passExpiryUnlimited')
        : t(lang, 'passExpiryUnlimited');
  return [
    t(lang, 'passTermsStampPerVisit'),
    t(lang, 'passTermsCollectReward', { goal: arabicDigits(card.stampsGoal, lang) }),
    t(lang, 'passTermsExpiry', { expiry }),
    t(lang, 'passTermsNoExchange'),
    t(lang, 'passTermsNoTransfer'),
    t(lang, 'passTermsAmend'),
  ].join(' ');
}

/**
 * pass.json content for `pass` on `card`. Includes `webServiceURL` /
 * `authenticationToken` only when `publicBaseUrl` is supplied — see
 * `PassContent`'s doc comment in buildPass.ts for why both-or-neither
 * matters. `webServiceURL` is the app's public origin plus `/apple`; Apple
 * appends `/v1/...` itself, matching server.ts's own `/apple/v1/...` routes.
 *
 * Field placement matches BUILD.md §9.1 exactly: `primaryFields` is empty,
 * the stamp count lives in `headerFields`, and the reward/stamps-remaining
 * live in `secondaryFields`. This is not a style choice — a storeCard pass
 * renders its strip image *behind* primaryFields (Apple's own layout, not
 * ours to change), so putting the reward text in primaryFields sits it on
 * top of the stamp-strip artwork instead of beside it. Do not move fields
 * between these three arrays without re-reading BUILD.md §9.1 first.
 *
 * **Revised, 2026-08-04.** The merchant-broadcast "msg" field used to sit in
 * `auxiliaryFields`, which Apple renders as a third row on the card *face*,
 * right under reward/stamps-remaining — permanent clutter once the message
 * stopped being new. It now lives in `backFields` instead (first entry,
 * ahead of the terms text — BUILD.md §9.1's own dated note has the reasoning
 * and the owner's original complaint). This is safe for the lock-screen
 * banner specifically because `changeMessage` fires on a **back** field's
 * value change exactly the same as a front one (BUILD.md §9.3/§18 item 5) —
 * moving the field does not touch what makes the banner appear, only where
 * the text lives once the customer taps in to read it. Do not put this back
 * in `auxiliaryFields`/`secondaryFields` without re-reading that note first.
 *
 * **Revised, 2026-08-04 (sub-project 9, "ephemeral notifications").** The
 * "msg" back field is now **omitted entirely** — not rendered with an
 * empty value — whenever `pass.message` is `""` or `pass.messageExpiresAt`
 * has passed. This is what fixes the owner's report: a brand-new `Pass`
 * (freshly enrolled, or a genuinely new customer's own fresh row) has never
 * had a message, so its very first pass.json carries no "msg" field at all,
 * rather than one sitting there blank forever — "a back field with a blank
 * value looks broken." `messageExpiresAt` is stamped by
 * apps/demo/broadcastWorker.ts alongside `message` (default 15 minutes,
 * `BROADCAST_MESSAGE_TTL_MINUTES`), and apps/demo/messageSweeper.ts clears
 * both columns once it passes so an already-issued pass stops carrying the
 * field on its next rebuild too — not only a brand-new one.
 *
 * This *reverses* the previous "always present, even blank" design (see the
 * now-superseded reasoning this replaces: the field existing from the very
 * first pass.json so its first real value has an "old value" already on the
 * device to diff against). That reasoning was about `changeMessage`
 * reliably banking a banner the first time a field's value changes; opting
 * a brand-new field *in* for the very first broadcast a given customer ever
 * receives is an inherent, accepted trade-off of fixing the reported bug —
 * Apple does not document its own diffing algorithm precisely enough to
 * rule out "a wholly new field key never bankable's a banner on its first
 * appearance" with certainty either way, and it could not be verified
 * against a real device in this change. Worst case, a customer's first-ever
 * broadcast shows without a lock-screen banner and is still visible the
 * next time they open Wallet — better than the bug being fixed (a stranger
 * seeing a merchant's old messages the moment they enrol).
 */
export function buildPassContentFor(
  card: Card,
  pass: Pass,
  options: { publicBaseUrl?: string; now?: Date } = {}
): PassContent {
  const lang = cardLang(card);
  const now = options.now ?? new Date();
  // A NULL `messageExpiresAt` means EXPIRED, not "never expires".
  //
  // `Pass.message` has exactly one writer — apps/demo/broadcastWorker.ts —
  // and it has stamped an expiry alongside every write since this migration
  // landed. (The welcome message is no exception: it goes through
  // enqueueBroadcast with `onlySerial`.) So a non-empty message with no
  // expiry can only be a row written *before* the migration — stale by
  // definition, and exactly the rows the owner was complaining about.
  //
  // Reading NULL as "never expires" was the original spelling here and it
  // silently exempted every pre-existing pass from the whole feature: on the
  // live database that was 9 of the 12 passes carrying a message, each one
  // set to display a months-old broadcast permanently. Those rows are
  // backfilled to '' by the same migration, and the sweeper now clears any
  // that reappear, but the predicate is the real guarantee: it means a
  // half-written row (a rolled-back deploy, a manual DB edit) fails closed.
  const messageActive =
    pass.message !== '' &&
    pass.messageExpiresAt !== null &&
    pass.messageExpiresAt.getTime() > now.getTime();
  const stampsRemaining = Math.max(card.stampsGoal - pass.stamps, 0);
  // Location reminders (BUILD.md §9.4/§9.1) — geofences live inside the
  // pass itself, so this is the only place they're ever written; there is
  // no server call involved in surfacing them later. parseCardLocations
  // already caps at MAX_CARD_LOCATIONS (10, Apple's own per-pass limit) and
  // drops anything malformed, and buildPassJson caps again defensively — see
  // that function's own comment for why the same cap is enforced twice.
  // relevantText falls back to a localised default (never English on an
  // Arabic card) when the merchant didn't type an override.
  const locations = parseCardLocations(card.locations).map((loc) => ({
    latitude: loc.latitude,
    longitude: loc.longitude,
    relevantText: loc.relevantText ?? defaultRelevantText(card.name, lang),
  }));
  return {
    serialNumber: pass.serial,
    organizationName: card.name,
    description: t(lang, 'passDescription', { name: card.name }),
    logoText: card.name,
    backgroundColor: card.bgColor,
    foregroundColor: card.fgColor,
    headerFields: [
      {
        key: 'stamps',
        label: t(lang, 'passStampsFieldLabel'),
        value: t(lang, 'passStampsFieldValue', {
          stamps: arabicDigits(pass.stamps, lang),
          goal: arabicDigits(card.stampsGoal, lang),
        }),
      },
    ],
    primaryFields: [],
    secondaryFields: [
      { key: 'reward', label: t(lang, 'passRewardFieldLabel'), value: card.rewardText },
      {
        key: 'stampsRemaining',
        label: t(lang, 'passStampsRemainingFieldLabel'),
        // The visible count already changes whenever a stamp lands, which
        // is normally enough to make iOS show the lock-screen banner
        // (BUILD.md §9.3) — but "normally" isn't "always" (a reward can
        // reset the count back to a value it held before, or this pass can
        // get rebuilt with nothing to say). invisibleChangeMarker() makes
        // the field's *text* unique on every single rebuild without ever
        // changing what the customer sees — see its doc comment in
        // buildPass.ts before deleting this thinking it's noise.
        value: `${t(lang, 'passStampsRemainingValue', { count: arabicDigits(stampsRemaining, lang) })}${invisibleChangeMarker()}`,
        changeMessage: '%@',
      },
    ],
    // backFields, in order (BUILD.md §9.1's dated note): the merchant
    // broadcast message first (only when `messageActive`, per this
    // function's own 2026-08-04 doc comment above), then the auto-generated
    // terms (§8.6). `value` is pass.message verbatim, never re-marked here —
    // apps/demo/broadcastWorker.ts computes and stores the invisible change
    // marker exactly once per broadcast job, at the point it writes
    // Pass.message, so every subsequent pass.json rebuild (a stamp landing,
    // a card edit) reads the same already-marked text and causes no
    // spurious repeat of the news banner. It was moved here from
    // `auxiliaryFields` (which Apple renders on the card *face*)
    // specifically so a stale broadcast stops being permanent clutter once
    // it stops being new — `changeMessage` still fires from a back field
    // exactly as it did from a front one, so the lock-screen banner is
    // unaffected; only where the text lives once read is different.
    backFields: [
      ...(messageActive
        ? [{ key: 'msg', label: t(lang, 'passMessageFieldLabel'), value: pass.message, changeMessage: '%@' }]
        : []),
      { key: 'terms', label: t(lang, 'passTermsFieldLabel'), value: buildTermsText(card) },
    ],
    barcodeMessage: pass.serial,
    ...(locations.length > 0 ? { locations, maxDistance: DEFAULT_MAX_DISTANCE_METERS } : {}),
    ...(options.publicBaseUrl
      ? { webServiceURL: `${options.publicBaseUrl}/apple`, authenticationToken: pass.authToken }
      : {}),
  };
}
