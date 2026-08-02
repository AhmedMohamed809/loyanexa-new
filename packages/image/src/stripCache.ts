import { createHash } from 'node:crypto';
import { renderStrip, type StripSpec } from './strip.ts';

/**
 * A strip depends only on its visual inputs — never on which customer holds
 * the pass. Images contribute their content hash, so a render never has to
 * hash a megabyte of pixels (BUILD.md §10).
 */
export function stripCacheKey(spec: StripSpec): string {
  // Written out field by field so the order is fixed regardless of how the
  // caller built the object, and so adding a field to StripSpec without
  // updating this function is a visible omission rather than a silent one.
  const identity = [
    spec.goal,
    spec.filled,
    spec.shape,
    spec.bgColor.toLowerCase(),
    spec.bgOpacity,
    spec.activeColor.toLowerCase(),
    spec.inactiveColor.toLowerCase(),
    spec.logo?.hash ?? null,
    spec.cover?.hash ?? null,
    spec.scale,
  ];
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export interface StripStore {
  get(key: string): Promise<Buffer | undefined>;
  set(key: string, value: Buffer): Promise<void>;
}

/** Bounded LRU. The production implementation is Redis (sub-project 3). */
export class MemoryStore implements StripStore {
  readonly #map = new Map<string, Buffer>();
  readonly #max: number;

  constructor(maxEntries = 256) {
    if (maxEntries < 1) throw new RangeError('maxEntries must be at least 1');
    this.#max = maxEntries;
  }

  get size(): number {
    return this.#map.size;
  }

  async get(key: string): Promise<Buffer | undefined> {
    const hit = this.#map.get(key);
    if (hit === undefined) return undefined;
    this.#map.delete(key); // reinsert so Map iteration order tracks recency
    this.#map.set(key, hit);
    return hit;
  }

  async set(key: string, value: Buffer): Promise<void> {
    if (this.#map.has(key)) this.#map.delete(key);
    this.#map.set(key, value);
    while (this.#map.size > this.#max) {
      const oldest = this.#map.keys().next();
      if (oldest.done) break;
      this.#map.delete(oldest.value);
    }
  }
}

export async function cachedStrip(store: StripStore, spec: StripSpec): Promise<Buffer> {
  const key = stripCacheKey(spec);
  const hit = await store.get(key);
  if (hit) return hit;
  const png = renderStrip(spec);
  await store.set(key, png);
  return png;
}
