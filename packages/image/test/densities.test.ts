import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderAllDensities } from '../src/densities.ts';
import { MemoryStore } from '../src/stripCache.ts';
import { decodePNG } from '../src/png/decode.ts';
import type { StripSpec } from '../src/strip.ts';

const spec: Omit<StripSpec, 'scale'> = {
  goal: 8, filled: 3, shape: 'circle',
  bgColor: '#203757', bgOpacity: 1,
  activeColor: '#F96400', inactiveColor: '#8794A5',
};

test('produces the three PassKit filenames at the right sizes', async () => {
  const set = await renderAllDensities(new MemoryStore(), spec);
  assert.deepEqual(Object.keys(set).sort(), ['strip.png', 'strip@2x.png', 'strip@3x.png']);
  assert.equal(decodePNG(set['strip.png']).width, 375);
  assert.equal(decodePNG(set['strip@2x.png']).width, 750);
  assert.equal(decodePNG(set['strip@3x.png']).width, 1125);
});

test('a second call is served entirely from cache and is byte-identical', async () => {
  const store = new MemoryStore();
  const a = await renderAllDensities(store, spec);
  const b = await renderAllDensities(store, spec);
  assert.deepEqual(a['strip.png'], b['strip.png']);
  assert.deepEqual(a['strip@3x.png'], b['strip@3x.png']);
  assert.equal(store.size, 3, 'exactly one entry per density');
});

test('the public entry point re-exports the API', async () => {
  const api = await import('../src/index.ts');
  for (const name of ['renderStrip', 'cachedStrip', 'MemoryStore', 'stripCacheKey', 'slotRows', 'renderAllDensities']) {
    assert.equal(typeof (api as Record<string, unknown>)[name], 'function', `missing export: ${name}`);
  }
});
