import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');

test('every model BUILD.md §11 names is present', () => {
  for (const m of ['Merchant', 'Card', 'Pass', 'Device', 'StampEvent', 'LinkCounter']) {
    assert.match(schema, new RegExp(`model ${m}\\b`), `missing model ${m}`);
  }
});

test('the indexes BUILD.md §11 says must never be removed are present', () => {
  assert.match(schema, /@@index\(\[merchantId, lastStampAt\]\)/, 'the "gone quiet" query index');
  assert.match(schema, /@@index\(\[updatedAt\]\)/, 'the PassKit device-poll index');
  assert.match(schema, /@@index\(\[linkCode\]\)/, 'the short-link resolution index');
});

test('Card carries the image content hashes the strip cache needs', () => {
  assert.match(schema, /logoHash\s+String\?/);
  assert.match(schema, /iconHash\s+String\?/);
  assert.match(schema, /coverHash\s+String\?/);
});

test('LinkCounter declares one field per line so Prisma can parse it', () => {
  const block = schema.match(/model LinkCounter \{[^}]*\}/)?.[0] ?? '';
  assert.match(block, /\bid\s+Int\b/);
  assert.match(block, /\bvalue\s+Int\b/);
  assert.equal(block.split('\n').filter((l) => /Int/.test(l)).length, 2, 'id and value on separate lines');
});

test('serials and short codes are unique', () => {
  assert.match(schema, /serial\s+String\s+@unique/);
  assert.match(schema, /shortCode\s+String\s+@unique/);
});
