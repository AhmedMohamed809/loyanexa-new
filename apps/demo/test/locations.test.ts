// apps/demo/test/locations.test.ts — pure logic for location reminders
// (BUILD.md §9.4/§9.1/§8.13): parsing Card.locations back out, validating a
// merchant's submitted list, and the localised default relevantText. No
// HTTP, no database — apps/demo/test/cardEdit.test.ts covers the
// database-backed round trip, and apps/demo/test/passContent.test.ts covers
// pass.json emission.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCardLocations,
  validateCardLocations,
  defaultRelevantText,
  MAX_CARD_LOCATIONS,
  type RawLocationRow,
} from '../locations.ts';

test('MAX_CARD_LOCATIONS is Apple\'s own per-pass limit: 10', () => {
  assert.equal(MAX_CARD_LOCATIONS, 10);
});

// ---------------------------------------------------------------------------
// parseCardLocations — the read side (Card.locations, a Prisma Json column,
// back into a typed array). Lenient: drops anything malformed rather than
// throwing, since a hand-edited or legacy row must never crash a page render.
// ---------------------------------------------------------------------------

test('parseCardLocations returns [] for non-array input', () => {
  assert.deepEqual(parseCardLocations(null), []);
  assert.deepEqual(parseCardLocations(undefined), []);
  assert.deepEqual(parseCardLocations('not an array'), []);
  assert.deepEqual(parseCardLocations({ not: 'an array' }), []);
  assert.deepEqual(parseCardLocations(42), []);
});

test('parseCardLocations reads a well-formed array through unchanged', () => {
  const raw = [
    { name: 'Downtown', latitude: 24.7136, longitude: 46.6753 },
    { name: 'Mall', latitude: 21.5433, longitude: 39.1728, relevantText: 'Custom text' },
  ];
  assert.deepEqual(parseCardLocations(raw), raw);
});

test('parseCardLocations drops entries missing a name, or with a non-finite/out-of-range latitude or longitude', () => {
  const raw = [
    { name: '', latitude: 24.7136, longitude: 46.6753 }, // empty name
    { latitude: 24.7136, longitude: 46.6753 }, // no name at all
    { name: 'Bad lat', latitude: 91, longitude: 46.6753 },
    { name: 'Bad lat 2', latitude: -91, longitude: 46.6753 },
    { name: 'Bad lng', latitude: 24.7136, longitude: 181 },
    { name: 'Bad lng 2', latitude: 24.7136, longitude: -181 },
    { name: 'NaN lat', latitude: Number.NaN, longitude: 46.6753 },
    { name: 'Not a number', latitude: '24.7136', longitude: 46.6753 },
    { name: 'Valid', latitude: 24.7136, longitude: 46.6753 },
  ];
  const result = parseCardLocations(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.name, 'Valid');
});

test('parseCardLocations caps at MAX_CARD_LOCATIONS even if the stored JSON somehow holds more', () => {
  const raw = Array.from({ length: 15 }, (_, i) => ({ name: `Loc ${i}`, latitude: 1, longitude: 1 }));
  const result = parseCardLocations(raw);
  assert.equal(result.length, MAX_CARD_LOCATIONS);
});

test('parseCardLocations drops a blank relevantText but keeps a real one, trimmed', () => {
  const raw = [
    { name: 'A', latitude: 1, longitude: 1, relevantText: '   ' },
    { name: 'B', latitude: 1, longitude: 1, relevantText: '  Hello  ' },
  ];
  const result = parseCardLocations(raw);
  assert.equal(result[0]?.relevantText, undefined);
  assert.equal(result[1]?.relevantText, 'Hello');
});

// ---------------------------------------------------------------------------
// validateCardLocations — the write side. Stricter than the read side, and
// reports *why* it failed (the caller turns this into a specific,
// translated, per-row error message).
// ---------------------------------------------------------------------------

function row(name: string, lat: string, lng: string, relevantText = ''): RawLocationRow {
  return { name, latitude: lat, longitude: lng, relevantText };
}

test('validateCardLocations accepts an empty list', () => {
  const result = validateCardLocations([]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.locations, []);
});

test('validateCardLocations accepts a full, valid list of exactly MAX_CARD_LOCATIONS', () => {
  const rows = Array.from({ length: MAX_CARD_LOCATIONS }, (_, i) => row(`Loc ${i}`, '24.7', '46.6'));
  const result = validateCardLocations(rows);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.locations.length, MAX_CARD_LOCATIONS);
});

test('validateCardLocations refuses an 11th location, naming the count', () => {
  const rows = Array.from({ length: MAX_CARD_LOCATIONS + 1 }, (_, i) => row(`Loc ${i}`, '24.7', '46.6'));
  const result = validateCardLocations(rows);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'too_many');
  assert.equal(result.count, MAX_CARD_LOCATIONS + 1);
});

test('validateCardLocations rejects a blank name and reports the row index', () => {
  const result = validateCardLocations([row('Good', '24.7', '46.6'), row('  ', '24.7', '46.6')]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'name_required');
  assert.equal(result.index, 1);
});

test('validateCardLocations rejects latitude outside -90..90', () => {
  for (const bad of ['91', '-91', '9999', 'abc', '']) {
    const result = validateCardLocations([row('X', bad, '46.6')]);
    assert.equal(result.ok, false, `latitude "${bad}" should be rejected`);
    if (result.ok) continue;
    assert.equal(result.reason, 'invalid_latitude');
    assert.equal(result.index, 0);
  }
  // Boundary values are valid.
  assert.equal(validateCardLocations([row('X', '90', '0')]).ok, true);
  assert.equal(validateCardLocations([row('X', '-90', '0')]).ok, true);
});

test('validateCardLocations rejects longitude outside -180..180', () => {
  for (const bad of ['181', '-181', '9999', 'xyz', '']) {
    const result = validateCardLocations([row('X', '10', bad)]);
    assert.equal(result.ok, false, `longitude "${bad}" should be rejected`);
    if (result.ok) continue;
    assert.equal(result.reason, 'invalid_longitude');
    assert.equal(result.index, 0);
  }
  assert.equal(validateCardLocations([row('X', '0', '180')]).ok, true);
  assert.equal(validateCardLocations([row('X', '0', '-180')]).ok, true);
});

test('validateCardLocations trims/caps the name and relevantText, and omits an empty relevantText', () => {
  const result = validateCardLocations([row('  Padded  ', '24.7', '46.6', '   ')]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.locations[0]?.name, 'Padded');
  assert.equal(result.locations[0]?.relevantText, undefined);
});

test('validateCardLocations keeps a real relevantText, trimmed', () => {
  const result = validateCardLocations([row('A', '24.7', '46.6', '  Come visit!  ')]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.locations[0]?.relevantText, 'Come visit!');
});

// ---------------------------------------------------------------------------
// defaultRelevantText — localised, per BUILD.md §13/§9.1's own sample text.
// ---------------------------------------------------------------------------

test('defaultRelevantText reads "You\'re near <shop>!" in English', () => {
  assert.equal(defaultRelevantText('Shami Bakery', 'en'), "You're near Shami Bakery!");
});

test('defaultRelevantText is properly localised Arabic, not a translated-English string, and carries the shop name verbatim', () => {
  const text = defaultRelevantText('Shami Bakery', 'ar');
  assert.equal(text, 'أنت بالقرب من Shami Bakery!');
});
