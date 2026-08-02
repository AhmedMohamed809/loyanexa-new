import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageHash } from '../src/imageHash.ts';

test('the same bytes give the same hash', () => {
  const bytes = Uint8Array.from([1, 2, 3, 4, 5, 250, 251]);
  assert.equal(imageHash(bytes), imageHash(Uint8Array.from(bytes)));
});

test('one flipped byte gives a different hash', () => {
  const a = Uint8Array.from([1, 2, 3, 4, 5]);
  const b = Uint8Array.from([1, 2, 3, 4, 6]);
  assert.notEqual(imageHash(a), imageHash(b));
});

test('the output is a hex SHA-256 digest', () => {
  assert.match(imageHash(Uint8Array.from([9, 9, 9])), /^[0-9a-f]{64}$/);
});
