// apps/demo/pkpassCache.ts — the `.pkpass` cache-key regression fix
// (2026-08-03): a built pass depends on its Card's design as well as its
// own (serial, stamps, updatedAt), so the cache key must change when
// either does. Pure function, no DB, no server.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pkpassCacheKey } from '../pkpassCache.ts';

test("editing a card's colours (cardUpdatedAt changes) changes the cache key even though the pass itself did not change", () => {
  const serial = 'TESTSERIAL1';
  const stamps = 3;
  const passUpdatedAt = new Date('2026-08-03T10:00:00.000Z'); // unchanged by a card edit

  const beforeEdit = new Date('2026-08-03T09:00:00.000Z');
  const afterEdit = new Date('2026-08-03T09:05:00.000Z'); // the merchant just saved a design change

  const keyBefore = pkpassCacheKey(serial, stamps, passUpdatedAt, beforeEdit);
  const keyAfter = pkpassCacheKey(serial, stamps, passUpdatedAt, afterEdit);

  assert.notEqual(
    keyBefore,
    keyAfter,
    'a card design edit must invalidate every cached .pkpass built from that card, so the next fetch rebuilds'
  );
});

test('a stamp (pass.updatedAt changes) changes the cache key even when the card is untouched', () => {
  const serial = 'TESTSERIAL2';
  const cardUpdatedAt = new Date('2026-08-03T09:00:00.000Z');

  const beforeStamp = pkpassCacheKey(serial, 3, new Date('2026-08-03T10:00:00.000Z'), cardUpdatedAt);
  const afterStamp = pkpassCacheKey(serial, 4, new Date('2026-08-03T10:00:05.000Z'), cardUpdatedAt);

  assert.notEqual(beforeStamp, afterStamp);
});

test('the same (serial, stamps, passUpdatedAt, cardUpdatedAt) always produces the same key', () => {
  const serial = 'TESTSERIAL3';
  const passUpdatedAt = new Date('2026-08-03T10:00:00.000Z');
  const cardUpdatedAt = new Date('2026-08-03T09:00:00.000Z');

  assert.equal(
    pkpassCacheKey(serial, 5, passUpdatedAt, cardUpdatedAt),
    pkpassCacheKey(serial, 5, passUpdatedAt, cardUpdatedAt)
  );
});

test('a different serial produces a different key even with identical stamps/timestamps', () => {
  const passUpdatedAt = new Date('2026-08-03T10:00:00.000Z');
  const cardUpdatedAt = new Date('2026-08-03T09:00:00.000Z');
  assert.notEqual(
    pkpassCacheKey('SERIAL-A', 5, passUpdatedAt, cardUpdatedAt),
    pkpassCacheKey('SERIAL-B', 5, passUpdatedAt, cardUpdatedAt)
  );
});
