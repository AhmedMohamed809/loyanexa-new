import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from '../src/png/crc.ts';

test('matches the standard CRC-32 check vector', () => {
  // The canonical check value for "123456789" under the PNG/zlib polynomial.
  assert.equal(crc32(Buffer.from('123456789', 'latin1')), 0xcbf43926);
});

test('empty input is zero', () => {
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('IEND chunk body has the well-known CRC', () => {
  // Every PNG ends with this exact chunk, so its CRC is a fixed constant.
  assert.equal(crc32(Buffer.from('IEND', 'latin1')), 0xae426082);
});
