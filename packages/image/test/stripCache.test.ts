import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripCacheKey, MemoryStore, cachedStrip, type StripStore } from '../src/stripCache.ts';
import { renderStrip, type StripSpec } from '../src/strip.ts';

const base: StripSpec = {
  goal: 8, filled: 3, shape: 'circle',
  bgColor: '#203757', bgOpacity: 1,
  activeColor: '#F96400', inactiveColor: '#8794A5',
  stampSource: 'plain',
  scale: 1,
};

const iconA = { rgba: new Uint8Array(16 * 16 * 4).fill(255), width: 16, height: 16, hash: 'icon-a' };
const iconB = { rgba: new Uint8Array(16 * 16 * 4).fill(255), width: 16, height: 16, hash: 'icon-b' };
const coverA = { rgba: new Uint8Array(16 * 16 * 4).fill(255), width: 16, height: 16, hash: 'cover-a' };

test('the key is a stable hex SHA-256', () => {
  const k = stripCacheKey(base);
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.equal(k, stripCacheKey({ ...base }));
});

test('key order in the object literal does not matter', () => {
  const reordered: StripSpec = {
    scale: 1, inactiveColor: '#8794A5', activeColor: '#F96400',
    bgOpacity: 1, bgColor: '#203757', shape: 'circle', filled: 3, goal: 8,
    stampSource: 'plain',
  };
  assert.equal(stripCacheKey(base), stripCacheKey(reordered));
});

test('every visual field changes the key', () => {
  const variants: StripSpec[] = [
    { ...base, goal: 9 }, { ...base, filled: 4 }, { ...base, shape: 'square' },
    { ...base, bgColor: '#000000' }, { ...base, bgOpacity: 0.5 },
    { ...base, activeColor: '#000000' }, { ...base, inactiveColor: '#000000' },
    { ...base, scale: 2 },
    { ...base, stampSource: 'icon', icon: iconA },
    { ...base, stampSource: 'builtin', builtinIcon: 'coffee' },
    { ...base, stampSource: 'icon', icon: iconA, iconFit: 'cover' },
    { ...base, cover: coverA },
  ];
  const keys = new Set(variants.map(stripCacheKey));
  keys.add(stripCacheKey(base));
  assert.equal(keys.size, variants.length + 1, 'each variant must hash differently');
});

test('different icons never collide', () => {
  assert.notEqual(
    stripCacheKey({ ...base, stampSource: 'icon', icon: iconA }),
    stripCacheKey({ ...base, stampSource: 'icon', icon: iconB })
  );
});

test('the icon hash, not its bytes, drives the key', () => {
  const sameHashDifferentPixels = { ...iconA, rgba: new Uint8Array(16 * 16 * 4).fill(7) };
  assert.equal(
    stripCacheKey({ ...base, stampSource: 'icon', icon: iconA }),
    stripCacheKey({ ...base, stampSource: 'icon', icon: sameHashDifferentPixels })
  );
});

test('two different built-in icons never collide — the icon choice is part of the cache key', () => {
  assert.notEqual(
    stripCacheKey({ ...base, stampSource: 'builtin', builtinIcon: 'coffee' }),
    stripCacheKey({ ...base, stampSource: 'builtin', builtinIcon: 'star' })
  );
});

test('an 8-stamp card has exactly 9 distinct strips', () => {
  const keys = new Set<string>();
  for (let filled = 0; filled <= 8; filled++) keys.add(stripCacheKey({ ...base, filled }));
  assert.equal(keys.size, 9);
});

test('cached bytes are byte-identical to a fresh render', async () => {
  const store = new MemoryStore();
  const fresh = renderStrip(base);
  const first = await cachedStrip(store, base);
  const second = await cachedStrip(store, base);
  assert.deepEqual(first, fresh);
  assert.deepEqual(second, fresh);
});

test('a repeat request does not re-render', async () => {
  const inner = new MemoryStore();
  let writes = 0;
  // Typed as the interface, not the class, so no cast is needed.
  const counting: StripStore = {
    get: (k) => inner.get(k),
    set: (k, v) => { writes++; return inner.set(k, v); },
  };
  await cachedStrip(counting, base);
  await cachedStrip(counting, base);
  assert.equal(writes, 1, 'the second call must be served from the store');
});

test('two concurrent requests for the same uncached spec render only once', async () => {
  const inner = new MemoryStore();
  let writes = 0;
  const counting: StripStore = {
    get: (k) => inner.get(k),
    set: (k, v) => { writes++; return inner.set(k, v); },
  };
  const [a, b] = await Promise.all([
    cachedStrip(counting, base),
    cachedStrip(counting, base),
  ]);
  assert.equal(writes, 1, 'concurrent misses on the same key must render only once');
  assert.deepEqual(a, b);
});

test('the store is bounded and evicts least-recently-used', async () => {
  const store = new MemoryStore(2);
  await store.set('a', Buffer.from('1'));
  await store.set('b', Buffer.from('2'));
  await store.get('a');            // 'a' is now the most recent
  await store.set('c', Buffer.from('3')); // evicts 'b'
  assert.equal(store.size, 2);
  assert.ok(await store.get('a'));
  assert.equal(await store.get('b'), undefined);
  assert.ok(await store.get('c'));
});
