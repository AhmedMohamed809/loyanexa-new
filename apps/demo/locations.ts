// apps/demo/locations.ts — Location reminders (BUILD.md §8.13/§9.4/§9.1).
//
// Geofences live *inside* the pass — the OS surfaces the card on the
// customer's lock screen when they walk near, with no server call and no
// cost, and it keeps working even if this backend is down. That is the
// entire value proposition (BUILD.md §9.4 calls it "one of the strongest
// selling points"), and it rests entirely on Card.locations (a Json column,
// `@default("[]")`) being shaped correctly and capped at Apple's own
// per-pass maximum of 10.
//
// Split out of server.ts, same convention as cardEdit.ts / stamp.ts:
// apps/demo/test/locations.test.ts exercises the pure parsing/validation
// logic directly, no HTTP, no database.

import { t, type Lang } from '../../packages/i18n/src/index.ts';

/** Apple's own hard limit on `locations` entries per pass — see docs/BUILD.md §9.4/§9.1 and packages/pass/src/buildPass.ts's MAX_PASS_LOCATIONS (the same number, enforced again there as defense in depth). */
export const MAX_CARD_LOCATIONS = 10;

/** BUILD.md §9.1's own sample value — metres from a location within which iOS considers the pass "relevant" enough to surface. Not merchant-configurable; a single sane default for every card. */
export const DEFAULT_MAX_DISTANCE_METERS = 100;

export const MAX_LOCATION_NAME_LENGTH = 80;
export const MAX_RELEVANT_TEXT_LENGTH = 160;

/** Longest stored `address`. Mirrors placeSearch.ts's MAX_PLACE_ADDRESS_LENGTH — the same cap, enforced again on the write path, since a hand-forged POST never went through placeSearch.ts at all. */
export const MAX_LOCATION_ADDRESS_LENGTH = 200;

/** One saved location reminder, as stored inside Card.locations (a JSON array) and as emitted into pass.json's own `locations[]` (BUILD.md §9.1). `relevantText` is the merchant's own override; when absent, the pass builder fills in a localised default (see `defaultRelevantText` below) — the column itself never stores the computed default, only an explicit override, so a later change to the default phrasing or the card's own name/language is picked up automatically by every card that never set one. */
export interface CardLocation {
  name: string;
  latitude: number;
  longitude: number;
  relevantText?: string;
  /**
   * The human-readable address the merchant picked in the designer — "King
   * Fahd Rd, Al Olaya, Riyadh". Display only, and deliberately not part of
   * the pass: packages/pass/src/buildPass.ts names the three keys Apple
   * accepts and this is not one of them, so it can never leak into
   * pass.json. It is stored because the designer no longer shows latitude
   * and longitude — without it, reopening a card would confirm the geofence
   * with a pair of numbers the merchant cannot check, or cost a geocoding
   * call on every page load. Optional: every location saved before search
   * existed has none, and none is a rendering fallback, not an error.
   */
  address?: string;
}

/**
 * Reads Card.locations (a Prisma `Json` column — typed `JsonValue` at
 * runtime, not `CardLocation[]`) back into a defensively-parsed array.
 * Never throws: a malformed, foreign-shaped, or hand-edited value just has
 * its bad entries dropped rather than blowing up every page that renders a
 * card. Not merchant input — this is the read side; see
 * `validateCardLocations` below for the write side, which is stricter and
 * does report errors.
 */
export function parseCardLocations(raw: unknown): CardLocation[] {
  if (!Array.isArray(raw)) return [];
  const out: CardLocation[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    const latitude = typeof obj.latitude === 'number' ? obj.latitude : Number.NaN;
    const longitude = typeof obj.longitude === 'number' ? obj.longitude : Number.NaN;
    if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) continue;
    const relevantTextRaw = typeof obj.relevantText === 'string' ? obj.relevantText.trim() : '';
    const addressRaw = typeof obj.address === 'string' ? obj.address.trim() : '';
    out.push({
      name,
      latitude,
      longitude,
      ...(relevantTextRaw ? { relevantText: relevantTextRaw } : {}),
      ...(addressRaw ? { address: addressRaw.slice(0, MAX_LOCATION_ADDRESS_LENGTH) } : {}),
    });
  }
  return out.slice(0, MAX_CARD_LOCATIONS);
}

/** One row of raw, as-submitted form input — every field still a string (or absent), before validation. `latitude`/`longitude`/`address` reach the server from hidden inputs the merchant never types into (the search dropdown and the geolocation button fill them), which changes who writes them but not how far they are trusted: they are still browser input and still fully validated below. */
export interface RawLocationRow {
  name: string;
  latitude: string;
  longitude: string;
  relevantText: string;
  address: string;
}

export type LocationValidationResult =
  | { ok: true; locations: CardLocation[] }
  | { ok: false; reason: 'too_many'; count: number }
  | { ok: false; reason: 'name_required'; index: number }
  | { ok: false; reason: 'invalid_latitude'; index: number }
  | { ok: false; reason: 'invalid_longitude'; index: number };

/**
 * Validates a merchant's submitted location list (the write side —
 * `parseCardLocations` above is the read side, and is deliberately lenient
 * instead). Checked, in order, per the job brief: at most
 * {@link MAX_CARD_LOCATIONS} (checked first, before looking at any single
 * row, so a merchant seeing "you can have at most 10" doesn't also have to
 * fix a typo in the 11th row it will never accept anyway), then latitude
 * -90..90, longitude -180..180, and a non-empty name for every row. Returns
 * the first problem found — the caller re-renders the form with that one
 * error and the merchant's own submitted values, same pattern as
 * cardEdit.ts's updateCard.
 *
 * The coordinate checks read the same as they always did, but they now guard
 * hidden fields rather than ones the merchant types into, so what they
 * actually catch has changed: not a typo in a latitude, but a row where no
 * place was ever chosen (both fields blank) or where a forged POST supplied
 * nonsense. The `reason` names stay `invalid_latitude`/`invalid_longitude`
 * because that is still precisely what is wrong; server.ts renders both as
 * "choose a place from search", which is the only advice that helps when
 * there is no coordinate field on screen to correct.
 */
export function validateCardLocations(rows: RawLocationRow[]): LocationValidationResult {
  if (rows.length > MAX_CARD_LOCATIONS) {
    return { ok: false, reason: 'too_many', count: rows.length };
  }
  const out: CardLocation[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const name = row.name.trim().slice(0, MAX_LOCATION_NAME_LENGTH);
    if (!name) return { ok: false, reason: 'name_required', index: i };

    const latitude = Number.parseFloat(row.latitude);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      return { ok: false, reason: 'invalid_latitude', index: i };
    }
    const longitude = Number.parseFloat(row.longitude);
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return { ok: false, reason: 'invalid_longitude', index: i };
    }
    const relevantText = row.relevantText.trim().slice(0, MAX_RELEVANT_TEXT_LENGTH);
    const address = row.address.trim().slice(0, MAX_LOCATION_ADDRESS_LENGTH);
    out.push({
      name,
      latitude,
      longitude,
      ...(relevantText ? { relevantText } : {}),
      ...(address ? { address } : {}),
    });
  }
  return { ok: true, locations: out };
}

/** The default lock-screen banner text (BUILD.md §9.1's own sample: "You're near <shop>!") when the merchant didn't type an override — localised to the card's own language (BUILD.md §13), never English on an Arabic card. `shopName` is merchant-authored text and is interpolated verbatim, never translated (docs/COPY.md §1), same as passDescription's `{name}`. */
export function defaultRelevantText(shopName: string, lang: Lang): string {
  return t(lang, 'passLocationRelevantTextDefault', { name: shopName });
}
