// apps/demo/pkpassCache.ts
//
// The `.pkpass` cache key (BUILD.md §10's "content-addressed" cache,
// server.ts's PKPASS_STORE / cachedBuildPass) — split into its own file so
// apps/demo/test/pkpassCache.test.ts can exercise it directly without
// importing server.ts, which binds a port as a side effect of module load
// (see server.ts's own file-level comment).
//
// Regression fixed 2026-08-03: a built `.pkpass`'s bytes depend on the
// owning Pass's own (serial, stamps, updatedAt) *and* on its Card's mutable
// design fields — colours, logo, stamp icon, background image, labels,
// shape, everything the card designer that shipped the same day lets a
// merchant change. The cache key originally covered only the Pass side.
// Card had no `updatedAt` column at all, and editing a card never touched
// `Pass.updatedAt` — so a design edit changed nothing the cache key could
// see, and every customer who already held a pass kept being served the
// old design until their next *stamp* happened to bump `Pass.updatedAt`.
// Before this cache existed, every fetch rebuilt from the live `Card` row
// and self-healed instantly; this was a regression introduced by caching,
// not a pre-existing issue.
//
// `Card.updatedAt` (packages/db/prisma/schema.prisma, `@updatedAt`) fixes
// this: it changes on every card write, including every aesthetic
// card-designer edit, so folding it into this key makes a design edit
// invalidate every affected pass's cache entry immediately.

/**
 * The cache key for a built `.pkpass`. Changes whenever anything the build
 * actually depends on changes: the Pass's own (serial, stamps, updatedAt),
 * or its Card's design (cardUpdatedAt) — either can change what the built
 * bytes look like, so either must be able to invalidate the cache entry.
 */
export function pkpassCacheKey(
  serial: string,
  stamps: number,
  passUpdatedAt: Date,
  cardUpdatedAt: Date
): string {
  return `${serial}:${stamps}:${passUpdatedAt.getTime()}:${cardUpdatedAt.getTime()}`;
}
