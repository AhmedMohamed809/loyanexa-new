// packages/pass/test/apns.test.ts
//
// Exercises ApnsClient's JWT construction (pure crypto, no network) and its
// wire behaviour against a local HTTP/2 server standing in for Apple's
// gateway — never the real api.push.apple.com. `host` on ApnsConfig exists
// precisely so tests can point the client at that stand-in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http2 from 'node:http2';

import {
  ApnsClient,
  parseApnsEnvironment,
  resolveApnsHost,
  isBadEnvironmentKeyError,
} from '../src/apns.ts';

/** A throwaway EC P-256 keypair, PKCS8-PEM — exactly the shape of a real Apple .p8 (which is just PKCS8 PEM with a `.p8` extension). */
function makeEcKeyPair(): { privateKeyPem: string; publicKey: crypto.KeyObject } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  return { privateKeyPem, publicKey };
}

test('getJwt() produces a well-formed, ES256, cached JWT with the right kid/iss that verifies against the .p8-derived public key', () => {
  const { privateKeyPem, publicKey } = makeEcKeyPair();
  const client = new ApnsClient({ keyId: 'ABC123XYZ0', teamId: 'TEAM1234AB', privateKeyPem });

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
  const client = new ApnsClient({ keyId: 'ABC123XYZ0', teamId: 'TEAM1234AB', privateKeyPem });
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

test('sendPush() reuses one HTTP/2 session across multiple pushes and sends the right method/path/headers/body', async () => {
  const fake = await startFakeApnsServer((stream) => {
    stream.respond({ ':status': 200 });
    stream.end();
  });
  const { privateKeyPem } = makeEcKeyPair();
  const client = new ApnsClient({
    keyId: 'TESTKEYID1',
    teamId: 'TESTTEAM99',
    privateKeyPem,
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
      assert.ok(String(r.headers.authorization).startsWith('bearer '));
      assert.equal(r.body, '{}', 'the push body must be the literal empty JSON object, no more');
    }
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
    keyId: 'TESTKEYID1',
    teamId: 'TESTTEAM99',
    privateKeyPem,
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

// ---------------------------------------------------------------------------
// APNS_ENV / gateway selection (BUILD.md §18 — the live 403 this exists to
// fix: a key provisioned for one environment gets `BadEnvironmentKeyInToken`
// pushing to the other). Everything below is pure logic — no network call,
// no http2.connect — so it never touches Apple's servers, real or sandbox.
// ---------------------------------------------------------------------------

test('parseApnsEnvironment defaults to production for anything other than the exact string "sandbox"', () => {
  assert.equal(parseApnsEnvironment(undefined), 'production');
  assert.equal(parseApnsEnvironment(''), 'production');
  assert.equal(parseApnsEnvironment('production'), 'production');
  assert.equal(parseApnsEnvironment('Sandbox'), 'production', 'must be exact, not case-insensitive');
  assert.equal(parseApnsEnvironment('bogus'), 'production');
  assert.equal(parseApnsEnvironment('sandbox'), 'sandbox');
});

test('resolveApnsHost maps each ApnsEnvironment to the right Apple gateway', () => {
  assert.equal(resolveApnsHost('production'), 'https://api.push.apple.com');
  assert.equal(resolveApnsHost('sandbox'), 'https://api.sandbox.push.apple.com');
});

test('ApnsClient.host picks the gateway from `environment`, defaults to production, and `host` overrides both', () => {
  const { privateKeyPem } = makeEcKeyPair();

  const defaulted = new ApnsClient({ keyId: 'K', teamId: 'T', privateKeyPem });
  assert.equal(defaulted.host, 'https://api.push.apple.com');

  const explicitProd = new ApnsClient({ keyId: 'K', teamId: 'T', privateKeyPem, environment: 'production' });
  assert.equal(explicitProd.host, 'https://api.push.apple.com');

  const sandbox = new ApnsClient({ keyId: 'K', teamId: 'T', privateKeyPem, environment: 'sandbox' });
  assert.equal(sandbox.host, 'https://api.sandbox.push.apple.com');

  const overridden = new ApnsClient({
    keyId: 'K',
    teamId: 'T',
    privateKeyPem,
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
