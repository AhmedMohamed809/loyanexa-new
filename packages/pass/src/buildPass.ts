// packages/pass/src/buildPass.ts
//
// The one place that stages, hashes, signs and zips a .pkpass archive.
// Extracted from scripts/make-demo-pass.ts (the original, still-working
// reference for the manual steps) so the demo server and the standalone
// script call exactly the same code instead of two copies drifting apart.
//
// No new npm dependencies: signs via the system `openssl`, zips via the
// system `zip` binary, hashes via node:crypto.

import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface PkPassField {
  key: string;
  label: string;
  value: string;
}

/** Where to find the Apple credentials used to sign the bundle. Paths, never inline PEM/DER bytes. */
export interface PassCredentials {
  teamId: string;
  passTypeId: string;
  certPath: string;
  keyPath: string;
  wwdrPath: string;
}

/**
 * Everything about one specific pass's content. Deliberately no
 * `webServiceURL` / `authenticationToken` fields exist here — BUILD.md
 * §9.3 is explicit that `webServiceURL` must be HTTPS and Apple fails
 * silently over http. There is no HTTPS endpoint in this project yet, and a
 * pass that omits both fields is valid and installs cleanly; it just
 * doesn't live-update. A placeholder value would be worse: it would look
 * configured while silently never working.
 */
export interface PassContent {
  serialNumber: string;
  organizationName: string;
  description: string;
  logoText?: string;
  /** Hex, e.g. "#203757". Converted to the `rgb(r,g,b)` PassKit wants. */
  backgroundColor: string;
  /** Hex. Defaults `labelColor` when `labelColor` is omitted. */
  foregroundColor: string;
  /** Hex. Defaults to `foregroundColor` when omitted. */
  labelColor?: string;
  headerFields?: PkPassField[];
  primaryFields?: PkPassField[];
  secondaryFields?: PkPassField[];
  backFields?: PkPassField[];
  /** The QR payload — normally the pass's own serial number. */
  barcodeMessage: string;
}

/** The five image members every storeCard pass needs. */
export interface PassImages {
  'icon.png': Buffer;
  'icon@2x.png': Buffer;
  'strip.png': Buffer;
  'strip@2x.png': Buffer;
  'strip@3x.png': Buffer;
}

export interface PkPassJson {
  formatVersion: number;
  passTypeIdentifier: string;
  teamIdentifier: string;
  organizationName: string;
  description: string;
  logoText?: string;
  serialNumber: string;
  backgroundColor: string;
  foregroundColor: string;
  labelColor: string;
  storeCard: {
    headerFields: PkPassField[];
    primaryFields: PkPassField[];
    secondaryFields: PkPassField[];
    backFields: PkPassField[];
  };
  barcodes: Array<{
    format: string;
    message: string;
    messageEncoding: string;
    altText: string;
  }>;
}

/**
 * Every member of a .pkpass archive, in the exact order they get zipped —
 * callers and tests both read this instead of repeating the list.
 */
export const PASS_MEMBERS = [
  'pass.json',
  'manifest.json',
  'signature',
  'icon.png',
  'icon@2x.png',
  'strip.png',
  'strip@2x.png',
  'strip@3x.png',
] as const;

function hexToRgbString(hex: string): string {
  const raw = hex.startsWith('#') ? hex.slice(1) : hex;
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`invalid hex colour: ${hex}`);
  }
  const r = Number.parseInt(full.slice(0, 2), 16);
  const g = Number.parseInt(full.slice(2, 4), 16);
  const b = Number.parseInt(full.slice(4, 6), 16);
  return `rgb(${r},${g},${b})`;
}

/** Build the pass.json object for a storeCard pass. Pure — no I/O. */
export function buildPassJson(credentials: PassCredentials, content: PassContent): PkPassJson {
  return {
    formatVersion: 1,
    passTypeIdentifier: credentials.passTypeId,
    teamIdentifier: credentials.teamId,
    organizationName: content.organizationName,
    description: content.description,
    ...(content.logoText !== undefined ? { logoText: content.logoText } : {}),
    serialNumber: content.serialNumber,
    backgroundColor: hexToRgbString(content.backgroundColor),
    foregroundColor: hexToRgbString(content.foregroundColor),
    labelColor: hexToRgbString(content.labelColor ?? content.foregroundColor),
    storeCard: {
      headerFields: content.headerFields ?? [],
      primaryFields: content.primaryFields ?? [],
      secondaryFields: content.secondaryFields ?? [],
      backFields: content.backFields ?? [],
    },
    barcodes: [
      {
        format: 'PKBarcodeFormatQR',
        message: content.barcodeMessage,
        messageEncoding: 'iso-8859-1',
        altText: 'scan here',
      },
    ],
  };
}

/**
 * Stage, hash, sign and zip a .pkpass archive, returning the archive bytes.
 *
 * Mirrors the steps proven in scripts/make-demo-pass.ts: `manifest.json` is
 * a SHA-1 digest per member (PassKit requires SHA-1 here — not a security
 * choice), `signature` is a detached CMS/PKCS#7 signature over
 * manifest.json produced by `openssl smime`, and the archive is zipped with
 * every member at the root (the `zip` invocation runs with the staging
 * directory as cwd, so no member carries a directory prefix).
 */
export function buildPass(
  credentials: PassCredentials,
  content: PassContent,
  images: PassImages
): Buffer {
  for (const p of [credentials.certPath, credentials.keyPath, credentials.wwdrPath]) {
    if (!existsSync(p)) throw new Error(`missing cert file: ${p}`);
  }

  const passJson = buildPassJson(credentials, content);
  const files: Record<string, Buffer> = {
    'pass.json': Buffer.from(JSON.stringify(passJson), 'utf8'),
    'icon.png': images['icon.png'],
    'icon@2x.png': images['icon@2x.png'],
    'strip.png': images['strip.png'],
    'strip@2x.png': images['strip@2x.png'],
    'strip@3x.png': images['strip@3x.png'],
  };

  const staging = mkdtempSync(path.join(tmpdir(), 'loyanexa-pkpass-'));
  try {
    for (const [name, buf] of Object.entries(files)) {
      writeFileSync(path.join(staging, name), buf);
    }

    const manifest: Record<string, string> = {};
    for (const [name, buf] of Object.entries(files)) {
      manifest[name] = createHash('sha1').update(buf).digest('hex');
    }
    writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest));

    execFileSync('openssl', [
      'smime', '-binary', '-sign',
      '-certfile', credentials.wwdrPath,
      '-signer', credentials.certPath,
      '-inkey', credentials.keyPath,
      '-in', path.join(staging, 'manifest.json'),
      '-outform', 'DER',
      '-out', path.join(staging, 'signature'),
      '-noattr',
    ]);

    const archivePath = path.join(staging, 'archive.pkpass');
    execFileSync('zip', ['-X', archivePath, ...PASS_MEMBERS], { cwd: staging });

    return readFileSync(archivePath);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
