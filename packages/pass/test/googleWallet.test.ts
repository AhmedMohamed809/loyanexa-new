// packages/pass/test/googleWallet.test.ts
//
// Exercises GoogleWalletClient.saveLink()'s JWT construction (pure crypto,
// no network) — the counterpart to apns.test.ts's getJwt() test. The
// network-touching methods (ensureLoyaltyClass, updateLoyaltyObject,
// #getAccessToken) are deliberately not covered here: there is no
// standalone Google gateway to stand in for the way apns.test.ts's fake
// HTTP/2 server stands in for Apple, and this suite must never depend on
// real service-account credentials or reach walletobjects.googleapis.com.
// They were exercised manually against the real issuer instead — see the
// task report.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { GoogleWalletClient } from '../src/googleWallet.ts';

/** A throwaway RSA keypair, PKCS8-PEM — exactly the shape of a real service account's `private_key`. */
function makeRsaKeyPair(): { privateKeyPem: string; publicKey: crypto.KeyObject } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  return { privateKeyPem, publicKey };
}

function decodeJwt(jwt: string): { header: unknown; payload: unknown; signingInput: string; signature: Buffer } {
  const parts = jwt.split('.');
  assert.equal(parts.length, 3, 'a JWT has exactly three dot-separated segments');
  const [headerB64, payloadB64, sigB64] = parts;
  assert.ok(headerB64 && payloadB64 && sigB64);
  return {
    header: JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')),
    signingInput: `${headerB64}.${payloadB64}`,
    signature: Buffer.from(sigB64, 'base64url'),
  };
}

test('saveLink() returns a pay.google.com URL whose JWT decodes to the expected structure', () => {
  const { privateKeyPem, publicKey } = makeRsaKeyPair();
  const client = new GoogleWalletClient({
    issuerId: '3388000000012345678',
    serviceAccountEmail: 'loyanexa-wallet@loyanexa-wallet-test.iam.gserviceaccount.com',
    privateKeyPem,
    publicBaseUrl: 'https://loyanexa-demo.fly.dev',
  });

  const link = client.saveLink(
    { serial: 'SERIAL0001', stamps: 3, custName: 'Ahmed' },
    { id: 'card_cuid_abc', stampsGoal: 8 }
  );

  assert.ok(link.startsWith('https://pay.google.com/gp/v/save/'), 'must be a pay.google.com save link');
  const jwt = link.slice('https://pay.google.com/gp/v/save/'.length);

  const { header, payload, signingInput, signature } = decodeJwt(jwt);

  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });

  const verified = crypto.verify('RSA-SHA256', Buffer.from(signingInput, 'utf8'), publicKey, signature);
  assert.equal(verified, true, 'the signature must verify against the service account public key');

  const claims = payload as {
    iss: string;
    aud: string;
    typ: string;
    iat: number;
    origins: string[];
    payload: { loyaltyObjects: unknown[] };
  };
  assert.equal(claims.iss, 'loyanexa-wallet@loyanexa-wallet-test.iam.gserviceaccount.com');
  assert.equal(claims.aud, 'google');
  assert.equal(claims.typ, 'savetowallet');
  assert.equal(typeof claims.iat, 'number');
  assert.ok(Math.abs(Date.now() / 1000 - claims.iat) < 5, 'iat should be "now", in seconds');
  assert.deepEqual(claims.origins, ['https://loyanexa-demo.fly.dev']);
  assert.equal(claims.payload.loyaltyObjects.length, 1);

  const object = claims.payload.loyaltyObjects[0] as {
    id: string;
    classId: string;
    state: string;
    accountId: string;
    accountName: string;
    loyaltyPoints: { balance: { string: string } };
    barcode: { type: string; value: string };
  };
  assert.equal(object.id, '3388000000012345678.pass_SERIAL0001');
  assert.equal(object.classId, '3388000000012345678.card_card_cuid_abc');
  assert.equal(object.state, 'ACTIVE');
  assert.equal(object.accountId, 'SERIAL0001');
  assert.equal(object.accountName, 'Ahmed');
  assert.deepEqual(object.loyaltyPoints, { balance: { string: '3 / 8' } });
  assert.deepEqual(object.barcode, { type: 'QR_CODE', value: 'SERIAL0001' });
});

test('saveLink() falls back accountName to "Member" when no customer name was given', () => {
  const { privateKeyPem } = makeRsaKeyPair();
  const client = new GoogleWalletClient({
    issuerId: '1',
    serviceAccountEmail: 'sa@example.iam.gserviceaccount.com',
    privateKeyPem,
    publicBaseUrl: 'https://example.test',
  });

  const link = client.saveLink({ serial: 'SERIAL0002', stamps: 0 }, { id: 'card2', stampsGoal: 8 });
  const jwt = link.slice('https://pay.google.com/gp/v/save/'.length);
  const { payload } = decodeJwt(jwt);
  const claims = payload as { payload: { loyaltyObjects: Array<{ accountName: string }> } };
  assert.equal(claims.payload.loyaltyObjects[0]?.accountName, 'Member');
});
