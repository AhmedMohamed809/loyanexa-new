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

/** Auto-generated terms per BUILD.md §8.6 — built from the card's own settings, the merchant writes nothing. */
export function buildTermsText(card: Card): string {
  const expiry =
    card.expiryType === 'duration'
      ? `${card.expiryDays ?? 0} days`
      : card.expiryType === 'fixed'
        ? (card.expiryDate?.toISOString().slice(0, 10) ?? 'unlimited')
        : 'unlimited';
  return [
    '1 stamp per visit.',
    `Collect ${card.stampsGoal} stamps to get a reward.`,
    `Card, stamps and rewards expiry: ${expiry}.`,
    'Stamps and rewards cannot be exchanged, returned or bought for cash.',
    'Cards cannot be transferred or combined with other cards.',
    'The company reserves the right to amend these terms.',
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
  const stampsRemaining = Math.max(card.stampsGoal - pass.stamps, 0);
  return {
    serialNumber: pass.serial,
    organizationName: card.name,
    description: `${card.name} loyalty card`,
    logoText: card.name,
    backgroundColor: card.bgColor,
    foregroundColor: card.fgColor,
    headerFields: [{ key: 'stamps', label: 'STAMPS', value: `${pass.stamps} of ${card.stampsGoal}` }],
    primaryFields: [],
    secondaryFields: [
      { key: 'reward', label: 'REWARD', value: card.rewardText },
      {
        key: 'stampsRemaining',
        label: 'STAMPS REMAINING',
        // The visible count already changes whenever a stamp lands, which
        // is normally enough to make iOS show the lock-screen banner
        // (BUILD.md §9.3) — but "normally" isn't "always" (a reward can
        // reset the count back to a value it held before, or this pass can
        // get rebuilt with nothing to say). invisibleChangeMarker() makes
        // the field's *text* unique on every single rebuild without ever
        // changing what the customer sees — see its doc comment in
        // buildPass.ts before deleting this thinking it's noise.
        value: `${stampsRemaining} stamps${invisibleChangeMarker()}`,
        changeMessage: '%@',
      },
    ],
    backFields: [{ key: 'terms', label: 'Terms', value: buildTermsText(card) }],
    barcodeMessage: pass.serial,
    ...(options.publicBaseUrl
      ? { webServiceURL: `${options.publicBaseUrl}/apple`, authenticationToken: pass.authToken }
      : {}),
  };
}
