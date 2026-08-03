// apps/demo/rateLimit.ts — a small, in-process, fixed-window rate limiter.
//
// POST /:code/pass and POST /:code/google-pass are unauthenticated (BUILD.md
// §8.16 — anyone with the printed QR or the short link can hit them) and
// each call is genuinely expensive: buildPass spawns `openssl` and `zip`
// and does real image work (packages/pass/src/buildPass.ts), all on a
// shared-cpu-1x/512MB Fly machine, plus real database writes. With no limit
// at all, one script hammering either route from a single IP can pin the
// CPU and exhaust memory for every other visitor. This is deliberately not
// a distributed limiter (no Redis, no new dependency) — a single Fly
// machine is the whole deployment today, and an in-process limiter that
// resets on deploy is a fine trade for that.
//
// Pure logic, no I/O — apps/demo/test/rateLimit.test.ts exercises it
// directly with an injected clock, not real wall-clock waits.

import type { IncomingHttpHeaders } from 'node:http';

export interface RateLimiterOptions {
  /** Maximum allowed calls to `check()` per key within `windowMs`. */
  limit: number;
  /** The fixed window size, in milliseconds. */
  windowMs: number;
  /** Upper bound on distinct keys tracked at once — see class doc comment below for why this exists. */
  maxKeys?: number;
}

interface WindowEntry {
  count: number;
  windowStart: number;
}

/**
 * Fixed-window counter per key. Simpler than a sliding-window/token-bucket
 * scheme, and precise enough for "10 issuances per IP per 10 minutes" — the
 * one place this over-admits relative to a sliding window is right at a
 * window boundary (up to 2x the limit across the boundary), which is an
 * acceptable trade for a defense against a script, not a precise SLA.
 *
 * Bounded so the limiter itself can never become the leak it exists to
 * prevent: expired entries are swept opportunistically on every `check()`
 * call, and the key count is hard-capped at `maxKeys` — if that cap is ever
 * hit (it shouldn't be: it would mean tens of thousands of distinct IPs
 * issuing passes inside one window), the oldest tracked key is evicted
 * rather than letting the map grow without bound.
 */
export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly windows = new Map<string, WindowEntry>();

  constructor(options: RateLimiterOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.maxKeys = options.maxKeys ?? 50_000;
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.windows) {
      if (now - entry.windowStart >= this.windowMs) this.windows.delete(key);
    }
  }

  /**
   * Records one call for `key` at `now` (defaults to `Date.now()`) and
   * reports whether it is within the limit. Every call — allowed or not —
   * counts toward the window, so a client cannot dodge the limit by
   * retrying the same blocked request.
   */
  check(key: string, now: number = Date.now()): boolean {
    this.sweep(now);
    const entry = this.windows.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      if (!entry && this.windows.size >= this.maxKeys) {
        const oldest = this.windows.keys().next();
        if (!oldest.done) this.windows.delete(oldest.value);
      }
      this.windows.set(key, { count: 1, windowStart: now });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  /** Test/diagnostic helper — not used by request handling itself. */
  size(): number {
    return this.windows.size;
  }
}

/**
 * The client IP a rate limiter should key on. Fly.io terminates TLS at its
 * edge and proxies to the app machine, so the socket's own remote address
 * is Fly's internal proxy, not the visitor — `Fly-Client-IP` is what Fly
 * sets to the real one (see Fly's own docs on request headers).
 * `X-Forwarded-For` is checked next for the same reason behind any other
 * reverse proxy (and for local/dev setups that set it by hand); its value
 * can be a comma-separated chain when multiple proxies are involved, so
 * only the first (left-most, closest-to-client) address is used. Falls
 * back to the raw socket address so this never throws when neither header
 * is present (e.g. a direct connection in local dev).
 */
export function resolveClientIp(headers: IncomingHttpHeaders, socketAddress: string | undefined): string {
  const flyIp = headers['fly-client-ip'];
  const flyIpValue = Array.isArray(flyIp) ? flyIp[0] : flyIp;
  if (flyIpValue?.trim()) return flyIpValue.trim();

  const forwarded = headers['x-forwarded-for'];
  const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (forwardedValue?.trim()) {
    const first = forwardedValue.split(',')[0]?.trim();
    if (first) return first;
  }

  return socketAddress ?? 'unknown';
}
