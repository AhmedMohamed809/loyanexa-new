// apps/demo/placeSearch.ts — business search for the location reminders
// editor (BUILD.md §9.4/§8.13).
//
// A merchant types their shop's name, picks it off a list, and the geofence
// gets its coordinates. Latitude and longitude never appear in the designer
// again — they are still what ships inside the pass, but nobody should have
// to read them off a map URL to run a coffee shop.
//
// This calls Google. That is a real change from how the editor used to work:
// the old paste-a-map-link box parsed coordinates in the page precisely so
// no third party learned a merchant's address. The trade is deliberate and
// narrow — the search text is sent only while a merchant is *editing* a
// card, never when a customer enrols, taps, or walks past. §9.4's actual
// promise (geofences live inside the pass, cost nothing, and work with this
// backend down) is untouched: nothing here runs at pass runtime.
//
// Every call is proxied through our own server rather than Google's browser
// SDK, for three reasons: the API key stays server-side where it can be
// IP-restricted instead of referrer-restricted, the per-merchant rate limit
// in server.ts can actually see the traffic, and the response shape the
// designer depends on is ours, not Google's to change under us.
//
// The parsing is pure and lives apart from the fetching, so
// apps/demo/test/placeSearch.test.ts can exercise real Google payloads
// without a network or a key — same convention as locations.ts.

/** Places Autocomplete (New). POST, key in a header, never the query string. */
const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
/** Place Details (New). The id is appended; see `detailsUrl` below. */
const DETAILS_URL = 'https://places.googleapis.com/v1/places';
/** Geocoding, used only in reverse — a GPS fix in, a street address out. */
const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

/**
 * The only fields we ask Place Details for. This list is load-bearing for
 * the bill as much as for the code: Google prices Place Details by the most
 * expensive field requested, and `displayName`/`formattedAddress`/`location`
 * all sit in the cheapest (Essentials) tier. Adding `rating`, `photos`, or
 * `openingHours` here would silently move every lookup to a dearer SKU, so
 * do not widen it without meaning to.
 */
const DETAILS_FIELD_MASK = 'id,displayName,formattedAddress,location';

/** Longest search string we will forward. A merchant's shop name is not 500 characters, and an unbounded field is an unbounded upstream bill. */
export const MAX_PLACE_QUERY_LENGTH = 120;

/** Shortest query worth spending a request on. One character matches half of Riyadh and teaches the merchant nothing. */
export const MIN_PLACE_QUERY_LENGTH = 2;

/** How many suggestions reach the merchant. Google returns up to five; more than that is a scroll, not a choice. */
export const MAX_PLACE_SUGGESTIONS = 5;

/** Longest formatted address we store on a location. Google's own are well under this; the cap exists so a hand-forged POST cannot grow Card.locations without bound. */
export const MAX_PLACE_ADDRESS_LENGTH = 200;

/**
 * Upstream timeout. Short on purpose: this sits under a merchant's cursor
 * between keystrokes, and a search that takes six seconds has already
 * failed as far as the person typing is concerned — better to fall back to
 * the paste box than to hang the row.
 */
const UPSTREAM_TIMEOUT_MS = 6_000;

/** One row of the autocomplete dropdown. `secondaryText` is the address line under the name; Google omits it for some results, so it may be empty. */
export interface PlaceSuggestion {
  placeId: string;
  primaryText: string;
  secondaryText: string;
}

/** A resolved place — everything a `CardLocation` needs except the merchant's own label and message. */
export interface PlaceDetail {
  name: string;
  address: string;
  latitude: number;
  longitude: number;
}

/**
 * Why a lookup produced nothing. The designer distinguishes these: `disabled`
 * and `upstream` both mean "fall back to pasting a map link", while
 * `not_found` means the search worked and simply matched nothing, which is
 * the merchant's cue to type more, not a failure to route around.
 */
export type PlaceFailure = 'disabled' | 'upstream' | 'not_found';

export type PlaceResult<T> = { ok: true; value: T } | { ok: false; reason: PlaceFailure };

/**
 * Read at call time, not at module load: apps/demo/env.ts populates
 * process.env from .env *after* some modules are imported, and a key
 * captured in a const at import time would be permanently empty depending
 * on import order.
 */
function apiKey(): string {
  return (process.env.GOOGLE_MAPS_API_KEY ?? '').trim();
}

/**
 * Whether the designer should offer search at all. With no key the whole
 * feature degrades to "use my current location" plus the paste-a-map-link
 * box that predates it — a local dev checkout and a self-hosted install both
 * keep working with no Google account, and a merchant is never stranded
 * mid-edit by an outage.
 */
export function isPlaceSearchEnabled(): boolean {
  return apiKey().length > 0;
}

/** Google wants a BCP-47 tag; our `Lang` is already one for both values we support. */
function languageCode(lang: string): string {
  return lang === 'ar' ? 'ar' : 'en';
}

/** Google accepts at most 15 entries in `includedRegionCodes`. */
export const MAX_INCLUDED_REGIONS = 15;

/**
 * Everyday names for countries that are not that country's ISO code,
 * corrected rather than rejected.
 *
 * `UK` is the one that matters and the reason this exists: the United
 * Kingdom's ISO-3166-1 code is **GB**, but nobody outside a standards
 * committee writes that, and `PLACES_REGION_CODE=UK` is a restriction to a
 * country that does not exist — every search returns nothing, in the market
 * you just launched in, with no error anywhere to explain it. It is exactly
 * two letters, so no amount of shape-checking catches it.
 */
const REGION_ALIASES: Record<string, string> = { UK: 'GB' };

/**
 * Reads `PLACES_REGION_CODE` into the country list search is confined to.
 *
 * A comma-separated list rather than one value, because the rollout is
 * country by country — "GB" today, "GB,SA" when Saudi opens, and so on —
 * and adding a market should be an env var edit and a restart, never a
 * code change. Order is preserved; Google treats the list as a set.
 *
 * Anything that is not two letters is dropped rather than forwarded, and
 * the aliases above are corrected, so `UK` quietly becomes `GB`. Beyond
 * that this validates shape, not membership: a well-formed code for a
 * country Google has never heard of still goes upstream, where it restricts
 * the search to nothing. Carrying all ~250 ISO codes to catch that seemed a
 * poor trade against one alias table that catches the mistake anyone
 * launching in Britain will actually make.
 *
 * Returns [] for an unset or entirely unusable value, which means worldwide
 * search.
 */
export function parseRegionCodes(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(trimmed)) continue;
    const code = REGION_ALIASES[trimmed] ?? trimmed;
    if (!out.includes(code)) out.push(code);
    if (out.length >= MAX_INCLUDED_REGIONS) break;
  }
  return out;
}

/** Trims and caps a merchant's raw search text. Returns '' for anything too short to be worth a request. */
export function normaliseQuery(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim().slice(0, MAX_PLACE_QUERY_LENGTH);
  return trimmed.length >= MIN_PLACE_QUERY_LENGTH ? trimmed : '';
}

/**
 * A Google session token groups the keystroke-by-keystroke autocomplete
 * requests and the single Place Details call that ends them into one billed
 * session. The client mints one per location row and a fresh one after each
 * pick. We validate rather than trust it: it goes into an upstream request,
 * so it gets the same treatment as any other field a browser hands us.
 * Google's own tokens are UUIDs; anything else is dropped rather than
 * forwarded, which costs a little more money and never a request failure.
 */
export function normaliseSessionToken(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)
    ? trimmed
    : undefined;
}

/** A Google place id, as it comes back from autocomplete. Opaque, but it is interpolated into a URL, so it is checked against Google's own character set rather than pasted in blind. */
export function isValidPlaceId(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 512 && /^[A-Za-z0-9_-]+$/.test(raw);
}

// ---------------------------------------------------------------------------
// Pure parsing. Google's payloads are deeply optional — `structuredFormat`,
// `secondaryText`, and even `placeId` can each be absent on a given
// suggestion — so every reader below treats a missing field as "drop this
// entry", never as a throw. A malformed upstream response must degrade to
// "no results", not to a 500 on the designer.
// ---------------------------------------------------------------------------

/** Reads Places Autocomplete (New)'s `suggestions[]` into our own shape, dropping anything without a usable id and label. */
export function parseAutocompleteResponse(raw: unknown): PlaceSuggestion[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const suggestions = (raw as { suggestions?: unknown }).suggestions;
  if (!Array.isArray(suggestions)) return [];

  const out: PlaceSuggestion[] = [];
  for (const entry of suggestions) {
    if (typeof entry !== 'object' || entry === null) continue;
    const prediction = (entry as { placePrediction?: unknown }).placePrediction;
    if (typeof prediction !== 'object' || prediction === null) continue;
    const p = prediction as Record<string, unknown>;

    const placeId = typeof p.placeId === 'string' ? p.placeId : '';
    if (!placeId) continue;

    const structured = (typeof p.structuredFormat === 'object' && p.structuredFormat !== null
      ? p.structuredFormat
      : {}) as Record<string, unknown>;

    // `structuredFormat` splits "Loyanexa Cafe" from "King Fahd Rd, Riyadh",
    // which is what makes the dropdown readable. When Google omits it —
    // it does, for some geocoded results — fall back to the flat `text`
    // so the row still says something rather than rendering blank.
    const primaryText = readText(structured.mainText) || readText(p.text);
    if (!primaryText) continue;

    out.push({
      placeId,
      primaryText,
      secondaryText: readText(structured.secondaryText),
    });
    if (out.length >= MAX_PLACE_SUGGESTIONS) break;
  }
  return out;
}

/** Google wraps display strings as `{ text, matches[] }`. Pulls the string out, '' if it is not there. */
function readText(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  const text = (value as { text?: unknown }).text;
  return typeof text === 'string' ? text.trim() : '';
}

/** Reads a Place Details (New) response. Returns null unless it carries a real coordinate pair — a place with no location cannot become a geofence. */
export function parsePlaceDetailsResponse(raw: unknown): PlaceDetail | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const location = obj.location;
  if (typeof location !== 'object' || location === null) return null;
  const { latitude, longitude } = location as { latitude?: unknown; longitude?: unknown };
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;

  const name = readText(obj.displayName);
  const address = typeof obj.formattedAddress === 'string'
    ? obj.formattedAddress.trim().slice(0, MAX_PLACE_ADDRESS_LENGTH)
    : '';

  return { name, address, latitude, longitude };
}

/**
 * Reads the Geocoding API's reverse response down to one formatted address.
 * `status` is checked explicitly because Geocoding answers `200 OK` with a
 * body of `{"status":"ZERO_RESULTS"}` — trusting the HTTP status alone here
 * would hand the merchant an empty confirmation line and call it success.
 */
export function parseReverseGeocodeResponse(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.status !== 'OK') return null;
  if (!Array.isArray(obj.results)) return null;
  for (const result of obj.results) {
    if (typeof result !== 'object' || result === null) continue;
    const formatted = (result as { formatted_address?: unknown }).formatted_address;
    if (typeof formatted === 'string' && formatted.trim()) {
      return formatted.trim().slice(0, MAX_PLACE_ADDRESS_LENGTH);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The I/O edge. Everything below talks to Google; everything above is pure.
// ---------------------------------------------------------------------------

/**
 * One upstream JSON call with a timeout, returning `null` for every failure
 * mode — a non-2xx, a network error, a timeout, an unparseable body. The
 * caller turns that into `{ ok: false, reason: 'upstream' }`, and the
 * designer turns *that* into the paste-a-link fallback. Google's error body
 * is deliberately not surfaced to the merchant: it can name the project and
 * the key, and "search is unavailable, paste a link instead" is the only
 * part of it they can act on anyway.
 */
async function fetchJson(url: string, init: RequestInit): Promise<unknown | null> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

/**
 * Suggests places for a merchant's partial input.
 *
 * `regionCodes` becomes `includedRegionCodes` — which *restricts* results to
 * those countries rather than merely preferring them. That is a stronger
 * setting than it first looks, and it is deliberate: measured against the
 * live API, Google's own `regionCode` field barely moves the ranking.
 * Searching "Kudu" — a Saudi fast-food chain with branches on most high
 * streets — returned Kudus, Indonesia as the top three hits with
 * `regionCode: "SA"` set, and the actual Riyadh and Jeddah branches only
 * once the region was an inclusion filter.
 *
 * A merchant who cannot find their own shop has no use for the fact that
 * the search was technically worldwide, so this trades reach for results
 * that exist. It follows the rollout: set `PLACES_REGION_CODE` to the
 * markets that are actually open, add to the list as more launch, and leave
 * it unset for a worldwide search — the right default for a self-host that
 * does not know where its merchants are.
 */
export async function searchPlaces(
  query: string,
  opts: { lang: string; sessionToken?: string; regionCodes?: string[] }
): Promise<PlaceResult<PlaceSuggestion[]>> {
  const key = apiKey();
  if (!key) return { ok: false, reason: 'disabled' };

  const body = await fetchJson(AUTOCOMPLETE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
    },
    body: JSON.stringify({
      input: query,
      languageCode: languageCode(opts.lang),
      ...(opts.regionCodes && opts.regionCodes.length > 0
        ? { includedRegionCodes: opts.regionCodes }
        : {}),
      ...(opts.sessionToken ? { sessionToken: opts.sessionToken } : {}),
    }),
  });
  if (body === null) return { ok: false, reason: 'upstream' };
  return { ok: true, value: parseAutocompleteResponse(body) };
}

/** Resolves one chosen suggestion into a name, an address, and the coordinates the pass actually needs. */
export async function placeDetails(
  placeId: string,
  opts: { lang: string; sessionToken?: string }
): Promise<PlaceResult<PlaceDetail>> {
  const key = apiKey();
  if (!key) return { ok: false, reason: 'disabled' };

  const params = new URLSearchParams({ languageCode: languageCode(opts.lang) });
  if (opts.sessionToken) params.set('sessionToken', opts.sessionToken);
  const url = `${DETAILS_URL}/${encodeURIComponent(placeId)}?${params.toString()}`;

  const body = await fetchJson(url, {
    method: 'GET',
    headers: {
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': DETAILS_FIELD_MASK,
    },
  });
  if (body === null) return { ok: false, reason: 'upstream' };
  const detail = parsePlaceDetailsResponse(body);
  return detail ? { ok: true, value: detail } : { ok: false, reason: 'not_found' };
}

/**
 * Turns a GPS fix into a street address, so "Use my current location" can
 * confirm itself the same way a search result does. Without this the button
 * would have nothing to show for itself once the latitude and longitude
 * fields are gone — and "it worked, trust me" is not a confirmation.
 *
 * A failure here is not fatal: the caller still has the coordinates, and the
 * designer falls back to showing those.
 */
export async function reverseGeocode(
  latitude: number,
  longitude: number,
  lang: string
): Promise<PlaceResult<string>> {
  const key = apiKey();
  if (!key) return { ok: false, reason: 'disabled' };

  const params = new URLSearchParams({
    latlng: `${latitude},${longitude}`,
    language: languageCode(lang),
    key,
  });
  const body = await fetchJson(`${GEOCODE_URL}?${params.toString()}`, { method: 'GET' });
  if (body === null) return { ok: false, reason: 'upstream' };
  const address = parseReverseGeocodeResponse(body);
  return address ? { ok: true, value: address } : { ok: false, reason: 'not_found' };
}
