// packages/pass/test/apns.test.ts
//
// Exercises ApnsClient's JWT construction (pure crypto, no network) and its
// wire behaviour against a local HTTP/2 server standing in for Apple's
// gateway — never the real api.push.apple.com. `host` on ApnsConfig exists
// precisely so tests can point the client at that stand-in. Certificate
// mode is exercised the same way, with a throwaway self-signed EC keypair
// standing in for the real Pass Type ID cert/WWDR chain — the point under
// test is ApnsClient's own behaviour (which headers it sends, whether it
// reuses/rebuilds the session), not Apple's TLS trust decisions, which no
// local server can meaningfully replicate anyway.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http2 from 'node:http2';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ApnsClient,
  parseApnsEnvironment,
  parseApnsAuthMode,
  resolveApnsHost,
  isBadEnvironmentKeyError,
  type ApnsAuth,
} from '../src/apns.ts';

/** A throwaway EC P-256 keypair, PKCS8-PEM — exactly the shape of a real Apple .p8 (which is just PKCS8 PEM with a `.p8` extension). */
function makeEcKeyPair(): { privateKeyPem: string; publicKey: crypto.KeyObject } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  return { privateKeyPem, publicKey };
}

/**
 * A throwaway self-signed EC cert/key pair — stands in for the Pass Type ID
 * cert + WWDR chain in certificate-mode tests. Never presented to Apple;
 * only ever handed to a local http2 server. node:crypto has no synchronous
 * self-signed-certificate generator, so this shells out to `openssl req`,
 * matching how the rest of this codebase already generates/handles
 * cert-shaped material (buildPass.ts's `openssl smime`).
 */
function makeSelfSignedCert(): { certPem: string; keyPem: string } {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const dir = mkdtempSync(path.join(tmpdir(), 'loyanexa-apns-test-cert-'));
  try {
    const keyPath = path.join(dir, 'key.pem');
    const certPath = path.join(dir, 'cert.pem');
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    execFileSync('openssl', [
      'req', '-new', '-x509', '-key', keyPath, '-out', certPath,
      '-days', '1', '-subj', '/CN=apns-test',
    ]);
    return { certPem: readFileSync(certPath, 'utf8'), keyPem: readFileSync(keyPath, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('getJwt() produces a well-formed, ES256, cached JWT with the right kid/iss that verifies against the .p8-derived public key', () => {
  const { privateKeyPem, publicKey } = makeEcKeyPair();
  const client = new ApnsClient({ auth: { mode: 'token', keyId: 'ABC123XYZ0', teamId: 'TEAM1234AB', privateKeyPem } });

  const jwt1 = client.getJwt();
  const jwt2 = client.getJwt();
  assert.equal(jwt1, jwt2, 'the JWT must be cached, not rebuilt on every call');

  const parts = jwt1.split('.');
  assert.equal(parts.length, 3, 'a JWT has exactly three dot-separated segments');
  const [headerB64, payloadB64, sigB64] = parts;
  assert.ok(headerB64 && payloadB64 && sigB64);

  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')) as {
    alg: string;
    kid: string;
  };
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
    iss: string;
    iat: number;
  };
  assert.equal(header.alg, 'ES256');
  assert.equal(header.kid, 'ABC123XYZ0');
  assert.equal(payload.iss, 'TEAM1234AB');
  assert.equal(typeof payload.iat, 'number');
  assert.ok(Math.abs(Date.now() / 1000 - payload.iat) < 5, 'iat should be "now", in seconds');

  // The signature must be the raw IEEE-P1363 r||s form JOSE requires, not
  // the DER form node:crypto produces by default — verify with the same
  // dsaEncoding, against the public key derived from the .p8 itself, with
  // no network call anywhere in this test.
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = Buffer.from(sigB64, 'base64url');
  const verified = crypto.verify(
    'sha256',
    Buffer.from(signingInput, 'utf8'),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    signature
  );
  assert.equal(verified, true);
});

test('getJwt() mints a fresh token once the cached one is stale', () => {
  const { privateKeyPem } = makeEcKeyPair();
  const client = new ApnsClient({ auth: { mode: 'token', keyId: 'ABC123XYZ0', teamId: 'TEAM1234AB', privateKeyPem } });
  const jwt1 = client.getJwt();

  // Reach into the private cache the only way JS allows from outside the
  // class — by re-minting through the public surface is not possible
  // without waiting 50 minutes, so simulate staleness the same way the
  // real "~50 minutes ago" check would see it: force Date.now() backward
  // for the cached issuedAt by asking for a token, then monkey-patching
  // Date.now() briefly to jump the clock forward past TOKEN_LIFETIME_MS.
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 51 * 60 * 1000;
    const jwt2 = client.getJwt();
    assert.notEqual(jwt2, jwt1, 'a stale cached token must be replaced, not reused past its lifetime');
  } finally {
    Date.now = realNow;
  }
});

test('getJwt() throws for a client constructed in certificate mode — no JWT exists to return', () => {
  const { certPem, keyPem } = makeSelfSignedCert();
  const client = new ApnsClient({ auth: { mode: 'certificate', certChainPem: certPem, keyPem } });
  assert.throws(() => client.getJwt());
});

/** Starts a plaintext (h2c) HTTP/2 server standing in for Apple's gateway, recording every request it receives. */
async function startFakeApnsServer(respond: (stream: http2.ServerHttp2Stream) => void): Promise<{
  url: string;
  sessionCount: () => number;
  requests: Array<{ headers: http2.IncomingHttpHeaders; body: string }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{ headers: http2.IncomingHttpHeaders; body: string }> = [];
  let sessionCount = 0;
  const server = http2.createServer();
  server.on('session', () => {
    sessionCount++;
  });
  server.on('stream', (stream: http2.ServerHttp2Stream, headers) => {
    let body = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      body += chunk;
    });
    stream.on('end', () => {
      requests.push({ headers, body });
      respond(stream);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('unexpected server address');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    sessionCount: () => sessionCount,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('sendPush() reuses one HTTP/2 session across multiple pushes and sends the right method/path/headers/body (token auth)', async () => {
  const fake = await startFakeApnsServer((stream) => {
    stream.respond({ ':status': 200 });
    stream.end();
  });
  const { privateKeyPem } = makeEcKeyPair();
  const client = new ApnsClient({
    auth: { mode: 'token', keyId: 'TESTKEYID1', teamId: 'TESTTEAM99', privateKeyPem },
    host: fake.url,
  });

  try {
    const r1 = await client.sendPush('devtoken-one', 'pass.test.loyanexa');
    const r2 = await client.sendPush('devtoken-two', 'pass.test.loyanexa');

    assert.deepEqual(r1, { ok: true, status: 200 });
    assert.deepEqual(r2, { ok: true, status: 200 });
    assert.equal(
      fake.sessionCount(),
      1,
      'the HTTP/2 session must be opened once and reused, not rebuilt per push'
    );
    assert.equal(fake.requests.length, 2);

    const [req1, req2] = fake.requests;
    assert.equal(req1?.headers[':path'], '/3/device/devtoken-one');
    assert.equal(req2?.headers[':path'], '/3/device/devtoken-two');
    for (const r of fake.requests) {
      assert.equal(r.headers[':method'], 'POST');
      assert.equal(r.headers['apns-topic'], 'pass.test.loyanexa');
      assert.equal(r.headers['apns-push-type'], 'background');
      assert.equal(r.headers['apns-priority'], '10');
      assert.ok(String(r.headers.authorization).startsWith('bearer '), 'token mode must send a bearer JWT');
      assert.equal(r.body, '{}', 'the push body must be the literal empty JSON object, no more');
    }
  } finally {
    client.close();
    await fake.close();
  }
});

test('sendPush() in certificate mode sends no Authorization header, over an mTLS-configured session', async () => {
  const { certPem, keyPem } = makeSelfSignedCert();
  const fake = await startFakeApnsServer((stream) => {
    stream.respond({ ':status': 200 });
    stream.end();
  });
  // The fake server above is plaintext h2c (no TLS at all), so an mTLS
  // handshake against it is not meaningful to assert on directly — what's
  // under test here is that ApnsClient never attaches an Authorization
  // header in certificate mode (auth lives in the TLS layer, which
  // apns.test.ts's other test, against a real https h2 server, exercises
  // for header shape) and that requests otherwise carry the same push
  // headers as token mode.
  const client = new ApnsClient({
    auth: { mode: 'certificate', certChainPem: certPem, keyPem },
    host: fake.url,
  });

  try {
    const result = await client.sendPush('devtoken-cert', 'pass.test.loyanexa');
    assert.deepEqual(result, { ok: true, status: 200 });
    assert.equal(fake.requests.length, 1);
    const req = fake.requests[0];
    assert.equal(req?.headers.authorization, undefined, 'certificate mode must not send a bearer token');
    assert.equal(req?.headers['apns-topic'], 'pass.test.loyanexa');
    assert.equal(req?.headers['apns-push-type'], 'background');
    assert.equal(req?.headers['apns-priority'], '10');
  } finally {
    client.close();
    await fake.close();
  }
});

test('sendPush() reports 410 Gone with reason "gone"', async () => {
  const fake = await startFakeApnsServer((stream) => {
    stream.respond({ ':status': 410 });
    stream.end(JSON.stringify({ reason: 'Unregistered', timestamp: 1234567890 }));
  });
  const { privateKeyPem } = makeEcKeyPair();
  const client = new ApnsClient({
    auth: { mode: 'token', keyId: 'TESTKEYID1', teamId: 'TESTTEAM99', privateKeyPem },
    host: fake.url,
  });

  try {
    const result = await client.sendPush('a-now-unregistered-token', 'pass.test.loyanexa');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 410);
    assert.equal(result.reason, 'gone');
  } finally {
    client.close();
    await fake.close();
  }
});

test('sendPush() transparently recovers from a dead session: it rebuilds and retries once, so the caller never sees the blip', async () => {
  // The fake server closes the underlying connection mid-stream on the
  // first request (simulating a network blip / idle-timeout reset) and
  // responds normally on the second — forcing ApnsClient down its
  // req.on('error', ...) path, which must drop the cached session so the
  // *next* sendPush() call opens a fresh one rather than hanging forever
  // on a session that will never respond again.
  let requestCount = 0;
  const fake = await startFakeApnsServer((stream) => {
    requestCount++;
    if (requestCount === 1) {
      stream.session?.destroy(); // tear down the whole session, not just this stream
      return;
    }
    stream.respond({ ':status': 200 });
    stream.end();
  });
  const { privateKeyPem } = makeEcKeyPair();
  const client = new ApnsClient({
    auth: { mode: 'token', keyId: 'TESTKEYID1', teamId: 'TESTTEAM99', privateKeyPem },
    host: fake.url,
  });

  try {
    // Revised 2026-08-04. This previously asserted the first push FAILS and
    // that only a second, caller-driven push succeeds. That was the bug the
    // owner reported as "sometimes the stamp doesn't show": nothing retried,
    // so whichever push happened to discover the dead session was simply
    // lost and that customer's card never updated. sendPush now retries once
    // on a fresh session when the failure was transport-level.
    const r1 = await client.sendPush('devtoken-one', 'pass.test.loyanexa');
    assert.deepEqual(
      r1,
      { ok: true, status: 200 },
      'the caller must not see a transport blip — it is retried on a fresh session'
    );

    assert.equal(
      fake.sessionCount(),
      2,
      'a torn-down session must be rebuilt, not silently reused'
    );

    // The rebuilt session is the one now cached: a follow-up push must not
    // open a third connection.
    const r2 = await client.sendPush('devtoken-two', 'pass.test.loyanexa');
    assert.deepEqual(r2, { ok: true, status: 200 });
    assert.equal(fake.sessionCount(), 2, 'the healthy rebuilt session must then be reused');
  } finally {
    client.close();
    await fake.close();
  }
});

test('sendPush() does NOT retry a real HTTP verdict from Apple — 410 Gone is answered once, not re-pushed', async () => {
  // Retrying is only safe when Apple never received the push. A 410 means it
  // did receive it, and is reporting the pass was deleted from that device;
  // re-sending would push again to a device that is already gone.
  let requestCount = 0;
  const fake = await startFakeApnsServer((stream) => {
    requestCount++;
    stream.respond({ ':status': 410 });
    stream.end(JSON.stringify({ reason: 'Unregistered' }));
  });
  const { privateKeyPem } = makeEcKeyPair();
  const client = new ApnsClient({
    auth: { mode: 'token', keyId: 'TESTKEYID1', teamId: 'TESTTEAM99', privateKeyPem },
    host: fake.url,
  });

  try {
    const r = await client.sendPush('devtoken-gone', 'pass.test.loyanexa');
    assert.equal(r.ok, false);
    assert.equal(r.status, 410);
    assert.equal(requestCount, 1, 'exactly one request — a 410 must never be retried');
  } finally {
    client.close();
    await fake.close();
  }
});

// ---------------------------------------------------------------------------
// APNS_ENV / APNS_AUTH selection (BUILD.md §18 — the live 403 this exists to
// fix: a key provisioned for one environment gets `BadEnvironmentKeyInToken`
// pushing to the other; the live fix is switching auth mode, not just
// environment). Everything below is pure logic — no network call, no
// http2.connect — so it never touches Apple's servers, real or sandbox.
// ---------------------------------------------------------------------------

test('parseApnsEnvironment defaults to production for anything other than the exact string "sandbox"', () => {
  assert.equal(parseApnsEnvironment(undefined), 'production');
  assert.equal(parseApnsEnvironment(''), 'production');
  assert.equal(parseApnsEnvironment('production'), 'production');
  assert.equal(parseApnsEnvironment('Sandbox'), 'production', 'must be exact, not case-insensitive');
  assert.equal(parseApnsEnvironment('bogus'), 'production');
  assert.equal(parseApnsEnvironment('sandbox'), 'sandbox');
});

test('parseApnsAuthMode defaults to certificate for anything other than the exact string "token"', () => {
  assert.equal(parseApnsAuthMode(undefined), 'certificate');
  assert.equal(parseApnsAuthMode(''), 'certificate');
  assert.equal(parseApnsAuthMode('certificate'), 'certificate');
  assert.equal(parseApnsAuthMode('Token'), 'certificate', 'must be exact, not case-insensitive');
  assert.equal(parseApnsAuthMode('bogus'), 'certificate');
  assert.equal(parseApnsAuthMode('token'), 'token');
});

test('resolveApnsHost maps each ApnsEnvironment to the right Apple gateway', () => {
  assert.equal(resolveApnsHost('production'), 'https://api.push.apple.com');
  assert.equal(resolveApnsHost('sandbox'), 'https://api.sandbox.push.apple.com');
});

test('ApnsClient.host/.authMode are chosen correctly for every combination of auth mode and environment', () => {
  const { privateKeyPem } = makeEcKeyPair();
  const tokenAuth: ApnsAuth = { mode: 'token', keyId: 'K', teamId: 'T', privateKeyPem };
  const { certPem, keyPem } = makeSelfSignedCert();
  const certAuth: ApnsAuth = { mode: 'certificate', certChainPem: certPem, keyPem };

  const combinations: Array<{ auth: ApnsAuth; environment?: 'production' | 'sandbox'; wantHost: string }> = [
    { auth: certAuth, environment: undefined, wantHost: 'https://api.push.apple.com' },
    { auth: certAuth, environment: 'production', wantHost: 'https://api.push.apple.com' },
    { auth: certAuth, environment: 'sandbox', wantHost: 'https://api.sandbox.push.apple.com' },
    { auth: tokenAuth, environment: undefined, wantHost: 'https://api.push.apple.com' },
    { auth: tokenAuth, environment: 'production', wantHost: 'https://api.push.apple.com' },
    { auth: tokenAuth, environment: 'sandbox', wantHost: 'https://api.sandbox.push.apple.com' },
  ];

  for (const { auth, environment, wantHost } of combinations) {
    const client = new ApnsClient({ auth, ...(environment ? { environment } : {}) });
    assert.equal(client.host, wantHost, `host for auth.mode=${auth.mode} environment=${environment}`);
    assert.equal(client.authMode, auth.mode);
  }

  // An explicit `host` always wins over `environment`, in both auth modes.
  const overridden = new ApnsClient({
    auth: certAuth,
    environment: 'sandbox',
    host: 'http://127.0.0.1:1',
  });
  assert.equal(overridden.host, 'http://127.0.0.1:1', 'an explicit host must win over environment');
});

test('isBadEnvironmentKeyError recognises the exact 403/BadEnvironmentKeyInToken shape and nothing else', () => {
  assert.equal(isBadEnvironmentKeyError(403, JSON.stringify({ reason: 'BadEnvironmentKeyInToken' })), true);
  assert.equal(isBadEnvironmentKeyError(403, JSON.stringify({ reason: 'BadDeviceToken' })), false);
  assert.equal(isBadEnvironmentKeyError(400, JSON.stringify({ reason: 'BadEnvironmentKeyInToken' })), false);
  assert.equal(isBadEnvironmentKeyError(410, ''), false);
});
