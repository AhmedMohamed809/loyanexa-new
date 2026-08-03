// apps/demo/appleCredentials.ts — memoizing server.ts's
// resolveAppleCredentials() so it materialises the signer/WWDR PEM files
// once per process, not once per `.pkpass` request (2026-08-03 review
// fix). `resolvePaths` below stands in for
// packages/pass/src/credentials.ts's real resolveAppleCredentials(), which
// is what actually writes the PEM files to disk in production — this test
// only needs to prove the memoization wrapper calls it (and `need`) once,
// not what it writes.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAppleCredentialsResolver } from '../appleCredentials.ts';

test('the resolver materialises credentials once, even across many repeated calls', () => {
  let needCalls = 0;
  let resolvePathsCalls = 0;
  const need = (key: string): string => {
    needCalls++;
    return `value-for-${key}`;
  };
  const resolvePaths = () => {
    resolvePathsCalls++;
    return { signerCertPath: '/tmp/cert.pem', signerKeyPath: '/tmp/key.pem', wwdrPath: '/tmp/wwdr.pem' };
  };

  const resolve = createAppleCredentialsResolver(need, resolvePaths);

  const first = resolve();
  const second = resolve();
  const third = resolve();

  assert.equal(
    resolvePathsCalls,
    1,
    'resolvePaths (which materialises the PEM files to disk in production) must run once per process, not once per call'
  );
  assert.equal(needCalls, 2, 'the two env lookups must also happen once, not on every call');
  assert.equal(second, first, 'repeated calls must return the exact same object, not merely an equal one');
  assert.equal(third, first);
  assert.deepEqual(first, {
    teamId: 'value-for-APPLE_TEAM_ID',
    passTypeId: 'value-for-APPLE_PASS_TYPE_ID',
    certPath: '/tmp/cert.pem',
    keyPath: '/tmp/key.pem',
    wwdrPath: '/tmp/wwdr.pem',
  });
});

test('a fresh resolver (a new process, in effect) is independent of an earlier one', () => {
  let calls = 0;
  const resolvePaths = () => {
    calls++;
    return { signerCertPath: `/tmp/cert-${calls}.pem`, signerKeyPath: '/tmp/key.pem', wwdrPath: '/tmp/wwdr.pem' };
  };
  const need = (key: string) => key;

  const resolverOne = createAppleCredentialsResolver(need, resolvePaths);
  const resolverTwo = createAppleCredentialsResolver(need, resolvePaths);

  const one = resolverOne();
  const two = resolverTwo();

  assert.equal(calls, 2, 'two independently-constructed resolvers must each resolve their own paths once');
  assert.notEqual(one.certPath, two.certPath);
});
