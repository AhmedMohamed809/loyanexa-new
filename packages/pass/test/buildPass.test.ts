import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  buildPass,
  buildPassJson,
  PASS_MEMBERS,
  type PassCredentials,
  type PassContent,
  type PassImages,
} from '../src/buildPass.ts';

/**
 * A throwaway self-signed cert/key pair, good for exercising the signing
 * step end to end without touching (or needing) the real Apple credentials
 * in certs/. Not chained to any real root — these tests check that the
 * archive is well-formed and the manifest/signature are internally
 * consistent, not that the signer chains to Apple (that is what
 * scripts/make-demo-pass.ts proves against the real cert).
 */
function makeSelfSignedCert(): { certPath: string; keyPath: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'loyanexa-pass-test-cert-'));
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '1', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-subj', '/CN=LoyaNexa Test Signer/OU=TESTTEAM1234',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] }
  );
  return { certPath, keyPath, dir };
}

function tinyImages(): PassImages {
  // Content here only needs to be *some* bytes for manifest hashing and
  // archive-membership purposes — buildPass never inspects image contents.
  const a = Buffer.from('loyanexa-test-icon');
  const b = Buffer.from('loyanexa-test-strip');
  return {
    'icon.png': a,
    'icon@2x.png': a,
    'strip.png': b,
    'strip@2x.png': b,
    'strip@3x.png': b,
  };
}

test('a built pass has all eight members at the archive root, matching manifest digests, and the serial in the barcode', () => {
  const { certPath, keyPath, dir: certDir } = makeSelfSignedCert();
  const outDir = mkdtempSync(path.join(tmpdir(), 'loyanexa-pass-test-out-'));
  try {
    const credentials: PassCredentials = {
      teamId: 'TESTTEAM1234',
      passTypeId: 'pass.test.loyanexa',
      certPath,
      keyPath,
      wwdrPath: certPath, // stand-in "WWDR" cert — real role tested by make-demo-pass.ts
    };
    const serial = 'TESTSERIAL01234567';
    const content: PassContent = {
      serialNumber: serial,
      organizationName: 'Test Cafe',
      description: 'LoyaNexa loyalty card',
      backgroundColor: '#203757',
      foregroundColor: '#FFFFFF',
      secondaryFields: [{ key: 'reward', label: 'REWARD', value: 'Free coffee' }],
      backFields: [{ key: 'terms', label: 'Terms', value: '1 stamp per visit.' }],
      barcodeMessage: serial,
    };

    const archive = buildPass(credentials, content, tinyImages());
    const archivePath = path.join(outDir, 'test.pkpass');
    writeFileSync(archivePath, archive);

    // 1. Exactly the eight expected members, all at the archive root.
    const names = execFileSync('unzip', ['-Z1', archivePath], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual([...names].sort(), [...PASS_MEMBERS].sort());
    assert.equal(
      names.some((n) => n.includes('/')),
      false,
      'no archive member should carry a directory prefix'
    );

    // 2. Every manifest.json digest matches the actual file in the archive.
    execFileSync('unzip', ['-q', archivePath, '-d', outDir]);
    const manifest = JSON.parse(readFileSync(path.join(outDir, 'manifest.json'), 'utf8')) as Record<
      string,
      string
    >;
    assert.equal(Object.keys(manifest).length, 6, 'manifest covers pass.json + 5 images');
    for (const [name, digest] of Object.entries(manifest)) {
      const actual = createHash('sha1').update(readFileSync(path.join(outDir, name))).digest('hex');
      assert.equal(actual, digest, `${name} digest mismatch`);
    }

    // 3. pass.json carries the real serial in the barcode, and nothing else.
    const passJson = JSON.parse(readFileSync(path.join(outDir, 'pass.json'), 'utf8')) as {
      serialNumber: string;
      barcodes: Array<{ message: string }>;
      webServiceURL?: string;
      authenticationToken?: string;
    };
    assert.equal(passJson.serialNumber, serial);
    assert.equal(passJson.barcodes[0]?.message, serial);
    assert.equal(passJson.webServiceURL, undefined, 'no webServiceURL — there is no HTTPS endpoint');
    assert.equal(passJson.authenticationToken, undefined);

    // 4. The signature is cryptographically valid over manifest.json (not
    //    chained to a real root here — that is scripts/make-demo-pass.ts's job).
    const sig = execFileSync(
      'openssl',
      [
        'smime', '-verify', '-binary', '-inform', 'DER', '-noverify',
        '-in', path.join(outDir, 'signature'),
        '-content', path.join(outDir, 'manifest.json'),
      ],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    assert.ok(sig !== undefined);

    // 5. The signature carries the CMS signed attributes (contentType,
    //    messageDigest, ...). This is the check `openssl smime -verify`
    //    above CANNOT make: -verify happily accepts a signature that was
    //    produced with `-noattr` and is missing every signed attribute —
    //    it only checks the raw signature bytes are cryptographically
    //    valid, not that PassKit's required attribute set is present.
    //    A pass signed without signed attributes verifies fine right here
    //    and is then rejected by iOS with the generic, useless "Sorry,
    //    your Pass cannot be installed to Passbook at this time." — with
    //    no indication that the signed attributes are the problem. Assert
    //    on the actual ASN.1 structure so this regresses loudly instead of
    //    silently costing someone an evening again.
    const signatureAsn1 = execFileSync(
      'openssl',
      ['asn1parse', '-inform', 'DER', '-in', path.join(outDir, 'signature')],
      { encoding: 'utf8' }
    );
    for (const requiredAttribute of ['contentType', 'messageDigest']) {
      assert.ok(
        signatureAsn1.includes(requiredAttribute),
        `signature is missing the CMS signed attribute "${requiredAttribute}" ` +
          '(openssl asn1parse output did not mention it). A signature without ' +
          'signed attributes is rejected by iOS Wallet with a generic, ' +
          'unhelpful "cannot be installed" error and no other diagnostic — ' +
          'this almost always means `-noattr` crept back into the ' +
          '`openssl smime -sign` call in buildPass.ts. Do not remove this ' +
          'assertion in favor of just `smime -verify`: -verify accepts both ' +
          'the broken (-noattr) and fixed signature, which is exactly how ' +
          'this bug reached iOS undetected in the first place.'
      );
    }
  } finally {
    rmSync(certDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('buildPassJson omits webServiceURL/authenticationToken and defaults labelColor to foregroundColor', () => {
  const credentials: PassCredentials = {
    teamId: 'TESTTEAM1234',
    passTypeId: 'pass.test.loyanexa',
    certPath: '/dev/null',
    keyPath: '/dev/null',
    wwdrPath: '/dev/null',
  };
  const content: PassContent = {
    serialNumber: 'SERIAL',
    organizationName: 'Test Cafe',
    description: 'LoyaNexa loyalty card',
    backgroundColor: '#203757',
    foregroundColor: '#F96400',
    barcodeMessage: 'SERIAL',
  };
  const json = buildPassJson(credentials, content);
  assert.equal(json.backgroundColor, 'rgb(32,55,87)');
  assert.equal(json.foregroundColor, 'rgb(249,100,0)');
  assert.equal(json.labelColor, 'rgb(249,100,0)');
  assert.equal('webServiceURL' in json, false);
  assert.equal('authenticationToken' in json, false);
});

test('PASS_MEMBERS is the fixed eight-member archive layout', () => {
  assert.deepEqual(PASS_MEMBERS, [
    'pass.json',
    'manifest.json',
    'signature',
    'icon.png',
    'icon@2x.png',
    'strip.png',
    'strip@2x.png',
    'strip@3x.png',
  ]);
});
