import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveAppleCredentials } from '../src/credentials.ts';

const ENV_KEYS = [
  'APPLE_SIGNER_CERT',
  'APPLE_SIGNER_KEY',
  'APPLE_WWDR_CERT',
  'APPLE_SIGNER_CERT_PATH',
  'APPLE_SIGNER_KEY_PATH',
  'APPLE_WWDR_CERT_PATH',
] as const;

/** Snapshot and restore the credential-related env vars around a test so tests don't leak into each other. */
function withCleanEnv(fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  for (const key of ENV_KEYS) delete process.env[key];
  try {
    fn();
  } finally {
    for (const key of ENV_KEYS) {
      const v = saved.get(key);
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    }
  }
}

/**
 * A throwaway self-signed cert/key pair — never the real certificate in
 * certs/. Good enough to prove openssl can actually parse whatever
 * resolveAppleCredentials wrote to disk.
 */
function makeSelfSignedPem(): { certPem: string; keyPem: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'loyanexa-credentials-test-'));
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '1', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-subj', '/CN=LoyaNexa Credentials Test/OU=TESTTEAM0000',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] }
  );
  return { certPem: readFileSync(certPath, 'utf8'), keyPem: readFileSync(keyPath, 'utf8'), dir };
}

test('env content wins over *_PATH when both are set, and the written files are valid PEM', () => {
  withCleanEnv(() => {
    const { certPem, keyPem, dir } = makeSelfSignedPem();
    try {
      process.env.APPLE_SIGNER_CERT = certPem;
      process.env.APPLE_SIGNER_KEY = keyPem;
      process.env.APPLE_WWDR_CERT = certPem; // stand-in WWDR — content shape is what's under test
      // Deliberately-wrong path values: if the resolver picked these, the
      // existsSync check inside the path branch would throw.
      process.env.APPLE_SIGNER_CERT_PATH = '/nonexistent/cert.pem';
      process.env.APPLE_SIGNER_KEY_PATH = '/nonexistent/key.pem';
      process.env.APPLE_WWDR_CERT_PATH = '/nonexistent/wwdr.pem';

      const resolved = resolveAppleCredentials('/tmp');

      // Not the fallback paths.
      assert.notEqual(resolved.signerCertPath, '/nonexistent/cert.pem');
      assert.notEqual(resolved.signerKeyPath, '/nonexistent/key.pem');
      assert.notEqual(resolved.wwdrPath, '/nonexistent/wwdr.pem');

      // Written with private (0600) permissions.
      const mode = statSync(resolved.signerCertPath).mode & 0o777;
      assert.equal(mode, 0o600);

      // openssl can actually load what was written — proves content + PEM
      // formatting round-tripped correctly, not just that a file exists.
      const subject = execFileSync('openssl', ['x509', '-in', resolved.signerCertPath, '-noout', '-subject'], {
        encoding: 'utf8',
      });
      assert.match(subject, /CN\s*=\s*LoyaNexa Credentials Test/);
      execFileSync('openssl', ['rsa', '-in', resolved.signerKeyPath, '-noout', '-check'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('literal backslash-n sequences in env-supplied PEM content are normalised to real newlines', () => {
  withCleanEnv(() => {
    const { certPem, keyPem, dir } = makeSelfSignedPem();
    try {
      // Simulate how PEM content commonly arrives through an env var /
      // secrets store: real newlines flattened to literal `\n` two-char
      // sequences.
      const flatten = (pem: string): string => pem.replace(/\r?\n/g, '\\n');

      process.env.APPLE_SIGNER_CERT = flatten(certPem);
      process.env.APPLE_SIGNER_KEY = flatten(keyPem);
      process.env.APPLE_WWDR_CERT = flatten(certPem);

      const resolved = resolveAppleCredentials('/tmp');

      // If normalisation didn't happen, the file on disk would still
      // contain literal backslash-n and openssl would refuse to parse it.
      const writtenCert = readFileSync(resolved.signerCertPath, 'utf8');
      assert.equal(writtenCert.includes('\\n'), false, 'written PEM should contain real newlines, not literal \\n');
      assert.ok(writtenCert.includes('\n'), 'written PEM should contain real newline bytes');

      const subject = execFileSync('openssl', ['x509', '-in', resolved.signerCertPath, '-noout', '-subject'], {
        encoding: 'utf8',
      });
      assert.match(subject, /CN\s*=\s*LoyaNexa Credentials Test/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('falls back to *_PATH values, resolved against rootDir, when no env content is set', () => {
  withCleanEnv(() => {
    const { dir } = makeSelfSignedPem();
    try {
      process.env.APPLE_SIGNER_CERT_PATH = './cert.pem';
      process.env.APPLE_SIGNER_KEY_PATH = './key.pem';
      process.env.APPLE_WWDR_CERT_PATH = './cert.pem'; // stand-in WWDR

      const resolved = resolveAppleCredentials(dir);

      assert.equal(resolved.signerCertPath, path.resolve(dir, 'cert.pem'));
      assert.equal(resolved.signerKeyPath, path.resolve(dir, 'key.pem'));
      assert.equal(resolved.wwdrPath, path.resolve(dir, 'cert.pem'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('a partial set of env-content vars is a hard error, not a silent fallback', () => {
  withCleanEnv(() => {
    process.env.APPLE_SIGNER_CERT = '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n';
    // APPLE_SIGNER_KEY / APPLE_WWDR_CERT deliberately left unset.
    assert.throws(() => resolveAppleCredentials('/tmp'), /must be set together/);
  });
});

test('missing everything is a clear error naming the missing key', () => {
  withCleanEnv(() => {
    assert.throws(() => resolveAppleCredentials('/tmp'), /APPLE_SIGNER_CERT_PATH/);
  });
});
