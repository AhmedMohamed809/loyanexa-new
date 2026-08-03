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
  /**
   * The lock-screen banner text template shown when this field's `value`
   * changes, with `%@` replaced by the new value (BUILD.md §9.3). Omit for
   * fields that shouldn't announce themselves (e.g. static labels).
   */
  changeMessage?: string;
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
 * Everything about one specific pass's content.
 *
 * `webServiceURL` / `authenticationToken` are optional and must be supplied
 * together or not at all — BUILD.md §9.3 is explicit that `webServiceURL`
 * must be HTTPS and Apple fails *silently* over http (no error, updates
 * just never arrive), and a pass carrying one field without the other is
 * invalid. `buildPassJson` enforces the pairing at runtime. Omitting both
 * is always valid: the pass installs cleanly and simply doesn't live-update
 * — the right fallback when there is no public HTTPS origin configured
 * (e.g. local dev), and far better than a placeholder that looks configured
 * while silently never working.
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
  /**
   * The Apple PassKit web-service origin, e.g. `https://loyanexa-new.fly.dev/apple`
   * — Apple appends `/v1/...` itself. Must be HTTPS (see interface doc) and
   * must be set together with `authenticationToken`, never alone.
   */
  webServiceURL?: string;
  /** This pass's own per-pass auth token — must accompany `webServiceURL`. */
  authenticationToken?: string;
}

/**
 * The five image members every storeCard pass needs, plus the two optional
 * `logo.png`/`logo@2x.png` members that put the merchant's own logo in the
 * pass header (BUILD.md §8.9) rather than only inside the strip artwork.
 * Optional because not every card has a logo uploaded — a pass without one
 * still needs to build (Apple's own placeholder header is used instead).
 */
export interface PassImages {
  'icon.png': Buffer;
  'icon@2x.png': Buffer;
  'strip.png': Buffer;
  'strip@2x.png': Buffer;
  'strip@3x.png': Buffer;
  'logo.png'?: Buffer;
  'logo@2x.png'?: Buffer;
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
  webServiceURL?: string;
  authenticationToken?: string;
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

/**
 * Zero-width Unicode characters used only by {@link invisibleChangeMarker}.
 * Every character below renders as nothing — no glyph, no width — in every
 * font Wallet uses, so appending them to a field's value never changes
 * what the customer sees.
 */
const ZERO_WIDTH_SPACE = '​'; // binary digit 0
const ZERO_WIDTH_NON_JOINER = '‌'; // binary digit 1

/**
 * BUILD.md §9.3 / §18 item 5: iOS diffs a pass field's *text* to decide
 * whether to show the lock-screen banner for it — re-sending byte-identical
 * text shows nothing. The fields callers put real data in (stamp counts,
 * etc.) normally change on their own, but nothing guarantees that on every
 * rebuild: two stamps can land in a way that leaves a count reading the
 * same as an earlier snapshot (e.g. after a reward resets it), or a pass
 * can be rebuilt with no underlying change at all. Appending this marker
 * to a field's value guarantees the text differs every single time,
 * without changing anything the customer sees: it is built entirely from
 * zero-width Unicode characters (invisible in Wallet's rendering) encoding
 * the current millisecond timestamp in binary. Do not delete this thinking
 * it's dead code or noise — it is the fix for the single most common
 * "I pushed but no banner appeared" bug.
 */
export function invisibleChangeMarker(): string {
  return Date.now()
    .toString(2)
    .split('')
    .map((bit) => (bit === '1' ? ZERO_WIDTH_NON_JOINER : ZERO_WIDTH_SPACE))
    .join('');
}

/** Build the pass.json object for a storeCard pass. Pure — no I/O. */
export function buildPassJson(credentials: PassCredentials, content: PassContent): PkPassJson {
  const hasWebServiceURL = content.webServiceURL !== undefined;
  const hasAuthToken = content.authenticationToken !== undefined;
  if (hasWebServiceURL !== hasAuthToken) {
    throw new Error(
      'PassContent.webServiceURL and .authenticationToken must be supplied together or not ' +
        'at all — a pass carrying one without the other is invalid.'
    );
  }
  if (hasWebServiceURL && !content.webServiceURL!.startsWith('https://')) {
    // BUILD.md §9.3: Apple refuses http silently — no error, updates just
    // never arrive. Fail loudly here instead of shipping a pass that looks
    // configured and quietly never updates.
    throw new Error(`webServiceURL must be HTTPS, got: ${content.webServiceURL}`);
  }

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
    ...(hasWebServiceURL
      ? { webServiceURL: content.webServiceURL, authenticationToken: content.authenticationToken }
      : {}),
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
  // logo.png/logo@2x.png are optional (PassImages' own doc comment) — only
  // added to the archive, the manifest and the member list when supplied,
  // so a card with no logo uploaded still produces the same fixed
  // PASS_MEMBERS layout the existing tests pin.
  const optionalMembers: Array<'logo.png' | 'logo@2x.png'> = [];
  for (const name of ['logo.png', 'logo@2x.png'] as const) {
    const buf = images[name];
    if (buf) {
      files[name] = buf;
      optionalMembers.push(name);
    }
  }

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

    // Do NOT add `-noattr` here. It strips the CMS signed attributes
    // (contentType, messageDigest, signingTime) that Apple's PassKit
    // verifier requires. `openssl smime -verify` accepts the signature
    // either way, so that command cannot catch a regression here — a pass
    // signed with `-noattr` verifies locally and is then rejected by iOS
    // with the generic "Sorry, your Pass cannot be installed to Passbook
    // at this time.", with no other diagnostic. See
    // packages/pass/test/buildPass.test.ts, which asserts on the ASN.1
    // structure of `signature` instead of just verifying it.
    execFileSync('openssl', [
      'smime', '-binary', '-sign',
      '-certfile', credentials.wwdrPath,
      '-signer', credentials.certPath,
      '-inkey', credentials.keyPath,
      '-in', path.join(staging, 'manifest.json'),
      '-outform', 'DER',
      '-out', path.join(staging, 'signature'),
    ]);

    const archivePath = path.join(staging, 'archive.pkpass');
    execFileSync('zip', ['-X', archivePath, ...PASS_MEMBERS, ...optionalMembers], { cwd: staging });

    return readFileSync(archivePath);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
