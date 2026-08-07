// apps/demo/test/placeSearch.test.ts — the pure half of business search:
// reading Google's payloads and sanitising what a browser sends us. No
// network and no API key, so this runs everywhere the rest of the suite
// does — apps/demo/test/locationsUi.test.ts covers the rendered designer,
// and apps/demo/test/locations.test.ts covers what gets stored.
//
// The payload shapes below are copied from Places API (New) responses, not
// invented: the whole point of parsing defensively is that the real thing
// omits fields, and a fixture that always includes them would prove nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAutocompleteResponse,
  parsePlaceDetailsResponse,
  parseReverseGeocodeResponse,
  normaliseQuery,
  normaliseSessionToken,
  parseRegionCodes,
  isValidPlaceId,
  isPlaceSearchEnabled,
  MAX_PLACE_SUGGESTIONS,
  MAX_PLACE_QUERY_LENGTH,
  MIN_PLACE_QUERY_LENGTH,
  MAX_PLACE_ADDRESS_LENGTH,
  MAX_INCLUDED_REGIONS,
} from '../placeSearch.ts';

// ---------------------------------------------------------------------------
// parseAutocompleteResponse
// ---------------------------------------------------------------------------

test('parseAutocompleteResponse reads the name and address lines Google splits for us', () => {
  const raw = {
    suggestions: [
      {
        placePrediction: {
          placeId: 'ChIJ_place_one',
          text: { text: 'Loyanexa Cafe, King Fahd Rd, Riyadh' },
          structuredFormat: {
            mainText: { text: 'Loyanexa Cafe' },
            secondaryText: { text: 'King Fahd Rd, Al Olaya, Riyadh' },
          },
        },
      },
    ],
  };
  assert.deepEqual(parseAutocompleteResponse(raw), [
    {
      placeId: 'ChIJ_place_one',
      primaryText: 'Loyanexa Cafe',
      secondaryText: 'King Fahd Rd, Al Olaya, Riyadh',
    },
  ]);
});

test('parseAutocompleteResponse falls back to the flat text when Google omits structuredFormat', () => {
  // Real geocoded (as opposed to establishment) predictions come back like
  // this. Dropping them would leave a merchant searching an address with an
  // empty list and no explanation.
  const raw = {
    suggestions: [{ placePrediction: { placeId: 'ChIJ_flat', text: { text: 'Riyadh, Saudi Arabia' } } }],
  };
  assert.deepEqual(parseAutocompleteResponse(raw), [
    { placeId: 'ChIJ_flat', primaryText: 'Riyadh, Saudi Arabia', secondaryText: '' },
  ]);
});

test('parseAutocompleteResponse drops entries with no id or no label rather than rendering blanks', () => {
  const raw = {
    suggestions: [
      { placePrediction: { text: { text: 'No id here' } } },
      { placePrediction: { placeId: 'ChIJ_no_label' } },
      { placePrediction: { placeId: 'ChIJ_ok', text: { text: 'Keeper' } } },
      { queryPrediction: { text: { text: 'not a place' } } },
      null,
    ],
  };
  const out = parseAutocompleteResponse(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.placeId, 'ChIJ_ok');
});

test('parseAutocompleteResponse caps the list — a dropdown is a choice, not a scroll', () => {
  const raw = {
    suggestions: Array.from({ length: MAX_PLACE_SUGGESTIONS + 4 }, (_, i) => ({
      placePrediction: { placeId: `ChIJ_${i}`, text: { text: `Place ${i}` } },
    })),
  };
  assert.equal(parseAutocompleteResponse(raw).length, MAX_PLACE_SUGGESTIONS);
});

test('parseAutocompleteResponse returns [] for anything that is not a suggestions array', () => {
  // A Google error body reaches here as a plain object. It must read as "no
  // results", never as a throw that 500s the designer.
  assert.deepEqual(parseAutocompleteResponse({ error: { code: 403, message: 'denied' } }), []);
  assert.deepEqual(parseAutocompleteResponse(null), []);
  assert.deepEqual(parseAutocompleteResponse('nope'), []);
  assert.deepEqual(parseAutocompleteResponse({ suggestions: 'nope' }), []);
});

// ---------------------------------------------------------------------------
// parsePlaceDetailsResponse
// ---------------------------------------------------------------------------

test('parsePlaceDetailsResponse pulls out the name, address and coordinates', () => {
  const raw = {
    id: 'ChIJ_place_one',
    displayName: { text: 'Loyanexa Cafe', languageCode: 'en' },
    formattedAddress: 'King Fahd Rd, Al Olaya, Riyadh 12214, Saudi Arabia',
    location: { latitude: 24.7136, longitude: 46.6753 },
  };
  assert.deepEqual(parsePlaceDetailsResponse(raw), {
    name: 'Loyanexa Cafe',
    address: 'King Fahd Rd, Al Olaya, Riyadh 12214, Saudi Arabia',
    latitude: 24.7136,
    longitude: 46.6753,
  });
});

test('parsePlaceDetailsResponse refuses a place with no usable coordinates', () => {
  // Without a coordinate pair there is no geofence to build, so this is the
  // one field whose absence is fatal rather than cosmetic.
  assert.equal(parsePlaceDetailsResponse({ displayName: { text: 'X' } }), null);
  assert.equal(parsePlaceDetailsResponse({ location: {} }), null);
  assert.equal(parsePlaceDetailsResponse({ location: { latitude: '24.7', longitude: '46.6' } }), null);
  assert.equal(parsePlaceDetailsResponse({ location: { latitude: Number.NaN, longitude: 46.6 } }), null);
  assert.equal(parsePlaceDetailsResponse(null), null);
});

test('parsePlaceDetailsResponse rejects out-of-range coordinates rather than clamping them', () => {
  // A clamped coordinate is a geofence silently pointing at the wrong place —
  // the same rule the pasted-link parser has always followed.
  assert.equal(parsePlaceDetailsResponse({ location: { latitude: 91, longitude: 46.6 } }), null);
  assert.equal(parsePlaceDetailsResponse({ location: { latitude: 24.7, longitude: 181 } }), null);
});

test('parsePlaceDetailsResponse survives a place with no name or address', () => {
  const out = parsePlaceDetailsResponse({ location: { latitude: 0, longitude: 0 } });
  assert.deepEqual(out, { name: '', address: '', latitude: 0, longitude: 0 });
});

test('parsePlaceDetailsResponse caps a pathologically long address', () => {
  const out = parsePlaceDetailsResponse({
    formattedAddress: 'x'.repeat(MAX_PLACE_ADDRESS_LENGTH + 50),
    location: { latitude: 1, longitude: 1 },
  });
  assert.equal(out?.address.length, MAX_PLACE_ADDRESS_LENGTH);
});

// ---------------------------------------------------------------------------
// parseReverseGeocodeResponse
// ---------------------------------------------------------------------------

test('parseReverseGeocodeResponse takes the first formatted address', () => {
  const raw = {
    status: 'OK',
    results: [
      { formatted_address: 'King Fahd Rd, Al Olaya, Riyadh 12214, Saudi Arabia' },
      { formatted_address: 'Al Olaya, Riyadh, Saudi Arabia' },
    ],
  };
  assert.equal(
    parseReverseGeocodeResponse(raw),
    'King Fahd Rd, Al Olaya, Riyadh 12214, Saudi Arabia'
  );
});

test('parseReverseGeocodeResponse checks status, because Geocoding says 200 OK when it found nothing', () => {
  // This is the whole reason the body is inspected rather than the HTTP
  // status: trusting the 200 would hand the merchant a blank confirmation
  // line and call it a success.
  assert.equal(parseReverseGeocodeResponse({ status: 'ZERO_RESULTS', results: [] }), null);
  assert.equal(parseReverseGeocodeResponse({ status: 'REQUEST_DENIED', error_message: 'bad key' }), null);
  assert.equal(parseReverseGeocodeResponse({ status: 'OK', results: [{}] }), null);
  assert.equal(parseReverseGeocodeResponse({ status: 'OK' }), null);
});

// ---------------------------------------------------------------------------
// Input sanitising — everything below guards a request we pay for.
// ---------------------------------------------------------------------------

test('normaliseQuery trims, and refuses anything too short to be worth a paid request', () => {
  assert.equal(normaliseQuery('  Loyanexa  '), 'Loyanexa');
  assert.equal(normaliseQuery('a'.repeat(MIN_PLACE_QUERY_LENGTH - 1)), '');
  assert.equal(normaliseQuery('   '), '');
  assert.equal(normaliseQuery(''), '');
  assert.equal(normaliseQuery(null), '');
  assert.equal(normaliseQuery(42), '');
});

test('normaliseQuery caps length — an unbounded field is an unbounded upstream bill', () => {
  assert.equal(normaliseQuery('x'.repeat(500)).length, MAX_PLACE_QUERY_LENGTH);
});

test('normaliseSessionToken passes a UUID and drops everything else', () => {
  const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  assert.equal(normaliseSessionToken(uuid), uuid);
  assert.equal(normaliseSessionToken(uuid.toUpperCase()), uuid.toUpperCase());
  // Dropping a bad token costs a little money and never a failed request,
  // which is why these return undefined rather than throwing.
  assert.equal(normaliseSessionToken('not-a-uuid'), undefined);
  assert.equal(normaliseSessionToken(''), undefined);
  assert.equal(normaliseSessionToken(undefined), undefined);
  assert.equal(normaliseSessionToken({ toString: () => uuid }), undefined);
});

test('parseRegionCodes reads the market list the rollout is currently open in', () => {
  // One market today, more as they launch — adding a country must be an env
  // var edit, never a code change.
  assert.deepEqual(parseRegionCodes('GB'), ['GB']);
  assert.deepEqual(parseRegionCodes('GB,SA'), ['GB', 'SA']);
  assert.deepEqual(parseRegionCodes(' gb , sa , ae '), ['GB', 'SA', 'AE']);
  assert.deepEqual(parseRegionCodes('GB,GB,SA'), ['GB', 'SA'], 'duplicates collapse');
});

test('parseRegionCodes corrects UK to GB — the mistake anyone launching in Britain will make', () => {
  // "UK" is not an ISO-3166-1 code; the United Kingdom is GB. It is exactly
  // two letters, so shape-checking never catches it, and forwarding it
  // restricts every search to a country that does not exist — zero results
  // for every merchant in the market you just launched in, with no error to
  // explain why.
  assert.deepEqual(parseRegionCodes('UK'), ['GB']);
  assert.deepEqual(parseRegionCodes('uk'), ['GB']);
  assert.deepEqual(parseRegionCodes('UK,SA'), ['GB', 'SA']);
  assert.deepEqual(parseRegionCodes('GB,UK'), ['GB'], 'the alias must not double up');
});

test('parseRegionCodes drops anything that is not shaped like a country code', () => {
  assert.deepEqual(parseRegionCodes('GBR'), []);
  assert.deepEqual(parseRegionCodes('united kingdom'), []);
  assert.deepEqual(parseRegionCodes('G1'), []);
  assert.deepEqual(parseRegionCodes('GB,,SA'), ['GB', 'SA'], 'an empty entry is skipped, not fatal');
  assert.deepEqual(parseRegionCodes(''), [], 'unset means worldwide');
  assert.deepEqual(parseRegionCodes('   '), []);
  assert.deepEqual(parseRegionCodes(undefined), []);
});

test('parseRegionCodes stops at Google\'s own limit of 15 regions', () => {
  const many = Array.from({ length: 20 }, (_, i) => `A${String.fromCharCode(65 + i)}`).join(',');
  assert.equal(parseRegionCodes(many).length, MAX_INCLUDED_REGIONS);
});

test('isValidPlaceId accepts Google ids and rejects anything that could escape the URL', () => {
  assert.equal(isValidPlaceId('ChIJN1t_tDeuEmsRUsoyG83frY4'), true);
  assert.equal(isValidPlaceId('with-dash_and_underscore'), true);
  assert.equal(isValidPlaceId('../../secrets'), false);
  assert.equal(isValidPlaceId('has space'), false);
  assert.equal(isValidPlaceId('?query=1'), false);
  assert.equal(isValidPlaceId(''), false);
  assert.equal(isValidPlaceId('x'.repeat(513)), false);
  assert.equal(isValidPlaceId(null), false);
});

test('isPlaceSearchEnabled follows the key at call time, not at import time', () => {
  // Read live rather than captured in a const: env.ts populates process.env
  // from .env after some modules are already imported, and a key captured at
  // import time would be permanently empty depending on import order.
  const original = process.env.GOOGLE_MAPS_API_KEY;
  try {
    delete process.env.GOOGLE_MAPS_API_KEY;
    assert.equal(isPlaceSearchEnabled(), false);
    process.env.GOOGLE_MAPS_API_KEY = '   ';
    assert.equal(isPlaceSearchEnabled(), false, 'whitespace is not a key');
    process.env.GOOGLE_MAPS_API_KEY = 'AIza-test';
    assert.equal(isPlaceSearchEnabled(), true);
  } finally {
    if (original === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = original;
  }
});
