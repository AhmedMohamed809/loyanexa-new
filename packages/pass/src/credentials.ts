// packages/pass/src/credentials.ts
//
// Resolves the three PEM files buildPass.ts hands to `openssl` — the Apple
// signer certificate, its private key, and the WWDR intermediate — to
// filesystem paths. openssl only ever takes files, so both supported
// sources end up as paths on disk; the only question is where those paths
// come from.
//
//   1. Environment content (preferred): APPLE_SIGNER_CERT / APPLE_SIGNER_KEY
//      / APPLE_WWDR_CERT hold the PEM text itself. This is how Fly.io (or
//      any container platform) supplies certs: `fly secrets set` injects
//      them as env vars, because certs/ is gitignored and must never be
//      baked into an image layer. We write the contents to files under a
//      private temp directory (mode 0600) and hand back those paths.
//
//   2. File paths (fallback): APPLE_SIGNER_CERT_PATH / APPLE_SIGNER_KEY_PATH
//      / APPLE_WWDR_CERT_PATH point at files already on disk, as set by
//      .env locally. This keeps local development working exactly as it
//      did before this module existed.
//
// The environment-content source wins whenever all three are present, so
// production never depends on files existing in the container.
//
// Exactly one implementation: apps/demo/server.ts and
// scripts/make-demo-pass.ts both call resolveAppleCredentials() instead of
// each re-implementing "read .env, resolve paths, check existence".
//
// resolveApnsKeyPem() below solves the identical problem for the APNs
// signing key (certs/AuthKey_*.p8): prefer PEM content from the env
// (APNS_KEY — a Fly secret), fall back to a file path (APNS_KEY_PATH — how
// local `.env` points at the real .p8). Apple's .p8 *is* a PKCS8 PEM file
// in every way that matters here; it just carries a `.p8` extension by
// convention, so the same normalisePem() trap and fix apply unchanged.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface AppleCredentialPaths {
  signerCertPath: string;
  signerKeyPath: string;
  wwdrPath: string;
}

const ENV_CONTENT_KEYS = ['APPLE_SIGNER_CERT', 'APPLE_SIGNER_KEY', 'APPLE_WWDR_CERT'] as const;

/**
 * PEM content passed through an environment variable — a `fly secrets set`,
 * a CI secret store, a shell export — very often arrives with literal
 * two-character `\n` sequences (backslash, then "n") in place of real
 * newline bytes, because whatever flattened the multi-line PEM into a
 * single env-var value escaped its newlines instead of preserving them.
 * openssl's PEM parser requires real line breaks between the
 * `-----BEGIN/END-----` markers and the base64 body, so an un-normalised
 * value fails to parse — frequently with no clearer error than "unable to
 * load certificate". This is a well-known trap with env-supplied PEM data;
 * normalise defensively rather than rediscover it in production.
 */
function normalisePem(raw: string): string {
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

let credentialsTempDir: string | undefined;
let cleanupRegistered: boolean = false;

function ensureCleanupRegistered(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.on('exit', () => {
    if (!credentialsTempDir) return;
    try {
      rmSync(credentialsTempDir, { recursive: true, force: true });
    } catch {
      // Best-effort: the OS reclaims tmpdir eventually either way.
    }
  });
}

function getCredentialsTempDir(): string {
  if (!credentialsTempDir) {
    credentialsTempDir = mkdtempSync(path.join(tmpdir(), 'loyanexa-apple-creds-'));
    ensureCleanupRegistered();
  }
  return credentialsTempDir;
}

/** Writes normalised PEM content to a private (mode 0600) file and returns its path. */
function writeSecretPem(dir: string, filename: string, content: string): string {
  const filePath = path.join(dir, filename);
  writeFileSync(filePath, normalisePem(content), { mode: 0o600 });
  return filePath;
}

/**
 * Resolves the signer cert, signer key and WWDR intermediate to file paths,
 * preferring PEM content from the environment over the `*_PATH` fallback.
 *
 * `rootDir` is where relative `*_PATH` values are resolved against (matches
 * the existing local-dev behaviour of resolving `.env`-relative paths
 * against the repository root, not the process's current working
 * directory).
 */
export function resolveAppleCredentials(rootDir: string = process.cwd()): AppleCredentialPaths {
  const certContent = process.env.APPLE_SIGNER_CERT;
  const keyContent = process.env.APPLE_SIGNER_KEY;
  const wwdrContent = process.env.APPLE_WWDR_CERT;

  const setCount = [certContent, keyContent, wwdrContent].filter((v) => !!v).length;

  if (setCount === ENV_CONTENT_KEYS.length) {
    const dir = getCredentialsTempDir();
    return {
      // The `!` is safe: setCount === 3 means all three are truthy strings.
      signerCertPath: writeSecretPem(dir, 'signerCert.pem', certContent!),
      signerKeyPath: writeSecretPem(dir, 'signerKey.pem', keyContent!),
      wwdrPath: writeSecretPem(dir, 'wwdr.pem', wwdrContent!),
    };
  }
  if (setCount > 0) {
    throw new Error(
      `${ENV_CONTENT_KEYS.join(' / ')} must be set together (or not at all) — got ${setCount} of ${ENV_CONTENT_KEYS.length}.`
    );
  }

  const need = (key: string): string => {
    const v = process.env[key];
    if (!v) throw new Error(`.env is missing ${key}`);
    return v;
  };
  const signerCertPath = path.resolve(rootDir, need('APPLE_SIGNER_CERT_PATH'));
  const signerKeyPath = path.resolve(rootDir, need('APPLE_SIGNER_KEY_PATH'));
  const wwdrPath = path.resolve(rootDir, need('APPLE_WWDR_CERT_PATH'));
  for (const p of [signerCertPath, signerKeyPath, wwdrPath]) {
    if (!existsSync(p)) throw new Error(`missing cert file: ${p}`);
  }
  return { signerCertPath, signerKeyPath, wwdrPath };
}

/**
 * Resolves the APNs signing key (the `.p8` behind push notifications) to
 * its PEM content, preferring the `APNS_KEY` env var (production, a Fly
 * secret) over the `APNS_KEY_PATH` file fallback (local dev, matching
 * `.env`'s existing convention). Unlike the Apple Wallet signer
 * cert/key/WWDR trio above, `openssl` never touches this value — it's
 * handed straight to `node:crypto.createPrivateKey`, which reads PEM
 * content directly — so there is no need to materialise it as a file on
 * disk; the content (normalised) is all callers need.
 */
export function resolveApnsKeyPem(rootDir: string = process.cwd()): string {
  const content = process.env.APNS_KEY;
  if (content) return normalisePem(content);

  const rawPath = process.env.APNS_KEY_PATH;
  if (!rawPath) {
    throw new Error('.env is missing APNS_KEY_PATH (or set APNS_KEY with the .p8 file contents)');
  }
  const resolved = path.resolve(rootDir, rawPath);
  if (!existsSync(resolved)) throw new Error(`missing APNs key file: ${resolved}`);
  return normalisePem(readFileSync(resolved, 'utf8'));
}
