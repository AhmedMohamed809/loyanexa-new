import { cachedStrip, type StripStore } from './stripCache.ts';
import type { StripSpec } from './strip.ts';

export interface StripSet {
  'strip.png': Buffer;
  'strip@2x.png': Buffer;
  'strip@3x.png': Buffer;
}

/** Every density a .pkpass needs, each cached independently. */
export async function renderAllDensities(
  store: StripStore,
  spec: Omit<StripSpec, 'scale'>
): Promise<StripSet> {
  const [x1, x2, x3] = await Promise.all([
    cachedStrip(store, { ...spec, scale: 1 }),
    cachedStrip(store, { ...spec, scale: 2 }),
    cachedStrip(store, { ...spec, scale: 3 }),
  ]);
  return { 'strip.png': x1, 'strip@2x.png': x2, 'strip@3x.png': x3 };
}
