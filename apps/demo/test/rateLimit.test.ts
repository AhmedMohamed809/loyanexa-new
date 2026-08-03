// apps/demo/test/rateLimit.test.ts — the in-process limiter guarding
// POST /:code/pass and POST /:code/google-pass (see apps/demo/rateLimit.ts's
// own doc comment for why these routes need one: unauthenticated and
// expensive). Pure logic with an injected clock — no real wall-clock waits,
// no HTTP, no database.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, resolveClientIp } from '../rateLimit.ts';

test('the first `limit` calls for a key are allowed, the next is rejected', () => {
  const limiter = new RateLimiter({ limit: 10, windowMs: 10 * 60 * 1000 });
  const now = 1_000_000;
  for (let i = 0; i < 10; i++) {
    assert.equal(limiter.check('1.2.3.4', now), true, `call ${i + 1} should be allowed`);
  }
  assert.equal(limiter.check('1.2.3.4', now), false, 'the 11th call within the window must be rejected');
});

test('a rejected call still counts toward the window (no retry-to-bypass)', () => {
  const limiter = new RateLimiter({ limit: 1, windowMs: 1000 });
  const now = 0;
  assert.equal(limiter.check('k', now), true);
  assert.equal(limiter.check('k', now + 1), false);
  assert.equal(limiter.check('k', now + 2), false);
});

test('different keys (IPs) are tracked independently', () => {
  const limiter = new RateLimiter({ limit: 1, windowMs: 1000 });
  assert.equal(limiter.check('a', 0), true);
  assert.equal(limiter.check('b', 0), true);
  assert.equal(limiter.check('a', 1), false);
  assert.equal(limiter.check('b', 1), false);
});

test('the limit resets once the window has fully elapsed', () => {
  const limiter = new RateLimiter({ limit: 2, windowMs: 1000 });
  assert.equal(limiter.check('k', 0), true);
  assert.equal(limiter.check('k', 100), true);
  assert.equal(limiter.check('k', 200), false); // still inside the window
  assert.equal(limiter.check('k', 1000), true); // window has elapsed — fresh window starts
  assert.equal(limiter.check('k', 1001), true);
  assert.equal(limiter.check('k', 1002), false);
});

test('bounded: expired entries are swept and the tracked-key count never exceeds maxKeys', () => {
  const limiter = new RateLimiter({ limit: 5, windowMs: 1000, maxKeys: 3 });
  limiter.check('a', 0);
  limiter.check('b', 0);
  limiter.check('c', 0);
  assert.equal(limiter.size(), 3);
  // A 4th distinct key at the cap evicts the oldest tracked entry rather than growing unbounded.
  limiter.check('d', 1);
  assert.ok(limiter.size() <= 3, `expected size to stay at or under maxKeys, got ${limiter.size()}`);
});

test('resolveClientIp prefers Fly-Client-IP, then X-Forwarded-For (first hop), then the socket address', () => {
  assert.equal(resolveClientIp({ 'fly-client-ip': '9.9.9.9', 'x-forwarded-for': '1.1.1.1' }, '2.2.2.2'), '9.9.9.9');
  assert.equal(resolveClientIp({ 'x-forwarded-for': '1.1.1.1, 3.3.3.3' }, '2.2.2.2'), '1.1.1.1');
  assert.equal(resolveClientIp({}, '2.2.2.2'), '2.2.2.2');
  assert.equal(resolveClientIp({}, undefined), 'unknown');
});
