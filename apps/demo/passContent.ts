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
 */
export function buildPassContentFor(
  card: Card,
  pass: Pass,
  options: { publicBaseUrl?: string } = {}
): PassContent {
  const lang = cardLang(card);
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
    // The merchant-broadcast field (BUILD.md §9.1's "msg"/"NEWS" sample,
    // §8.12) — always present, even before any broadcast has ever been
    // sent (pass.message defaults to ""), so the field already exists in
    // the very first pass.json a device downloads; see PassContent's own
    // auxiliaryFields doc comment in buildPass.ts for why a field's first
    // real value needs an "old value" already on the device to diff
    // against. `value` is pass.message verbatim, never re-marked here —
    // apps/demo/broadcastWorker.ts computes and stores the invisible
    // change marker exactly once per broadcast job, at the point it writes
    // Pass.message, so every subsequent pass.json rebuild (a stamp landing,
    // a card edit) reads the same already-marked text and causes no
    // spurious repeat of the news banner.
    auxiliaryFields: [
      { key: 'msg', label: t(lang, 'passMessageFieldLabel'), value: pass.message, changeMessage: '%@' },
    ],
    backFields: [{ key: 'terms', label: t(lang, 'passTermsFieldLabel'), value: buildTermsText(card) }],
    barcodeMessage: pass.serial,
    ...(locations.length > 0 ? { locations, maxDistance: DEFAULT_MAX_DISTANCE_METERS } : {}),
    ...(options.publicBaseUrl
      ? { webServiceURL: `${options.publicBaseUrl}/apple`, authenticationToken: pass.authToken }
      : {}),
  };
}
