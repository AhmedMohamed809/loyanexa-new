// apps/demo/appleCredentials.ts
//
// Memoizes server.ts's `resolveAppleCredentials()` — split out so
// apps/demo/test/appleCredentials.test.ts can exercise the memoization
// itself without importing server.ts (which binds a port as a side effect
// of module load) or touching real cert material.
//
// Regression fixed 2026-08-03, found in the same review as
// apps/demo/pkpassCache.ts's cache-key fix: `resolveAppleCredentials()` ran
// on *every* `handleGetLatestPass` call — including every cache *hit*,
// which never signs anything — and each call re-resolved
// packages/pass/src/credentials.ts's `resolveAppleCredentials()`, which
// rewrites three temp PEM files to disk whenever the env-content vars
// (`APPLE_SIGNER_CERT`/`_KEY`, `APPLE_WWDR_CERT`) are set (production's
// path — see credentials.ts's own file-level comment). A running server's
// Apple config cannot change mid-process (nothing here reads it more than
// once, the same way `APNS_ENV`/`APNS_AUTH` are read once at module load in
// server.ts), so re-resolving on every request only pays that filesystem
// cost, never gets any benefit from it.

import type { PassCredentials } from '../../packages/pass/src/buildPass.ts';
import type { AppleCredentialPaths } from '../../packages/pass/src/credentials.ts';

/**
 * Builds a memoized credentials resolver: the first call reads
 * `need('APPLE_TEAM_ID')` / `need('APPLE_PASS_TYPE_ID')` and calls
 * `resolvePaths()` once; every later call returns that exact same
 * `PassCredentials` object without calling either again. `need` and
 * `resolvePaths` are injected (rather than reading `process.env` /
 * `packages/pass/src/credentials.ts` directly) purely so this file stays
 * importable and testable without an `.env` or real cert material — see
 * server.ts's own call site for the real wiring.
 */
export function createAppleCredentialsResolver(
  need: (key: string) => string,
  resolvePaths: () => AppleCredentialPaths
): () => PassCredentials {
  let cached: PassCredentials | undefined;
  return (): PassCredentials => {
    if (cached) return cached;
    const { signerCertPath, signerKeyPath, wwdrPath } = resolvePaths();
    cached = {
      teamId: need('APPLE_TEAM_ID'),
      passTypeId: need('APPLE_PASS_TYPE_ID'),
      certPath: signerCertPath,
      keyPath: signerKeyPath,
      wwdrPath,
    };
    return cached;
  };
}
