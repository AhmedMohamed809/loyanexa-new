#!/usr/bin/env node
// scripts/make-demo-pass.ts
//
// Demo harness: builds a real, signed .pkpass carrying a stamp strip
// rendered by @loyanexa/image, and prints proof that it is valid before
// declaring success. This is a demo harness, not production code — the
// real pass engine is sub-project 2's job. See:
//   .superpowers/sdd/2026-08-02-foundation-strip-pipeline/pkpass-demo-brief.md
//
// No new npm dependencies: zips via the system `zip`/`unzip`, signs via the
// system `openssl`, hashes via node:crypto, renders via @loyanexa/image.

import { readFileSync, writeFileSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecFileException } from 'node:child_process';

import {
  renderAllDensities,
  MemoryStore,
  Surface,
  parseHexColor,
  fillDisc,
  encodePNG,
} from '../packages/image/src/index.ts';
import {
  buildPass,
  PASS_MEMBERS,
  type PassCredentials,
  type PassContent,
  type PassImages,
  type PkPassJson,
} from '../packages/pass/src/buildPass.ts';
import { resolveAppleCredentials } from '../packages/pass/src/credentials.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// 0. Load .env into process.env (shell env always wins, same convention as
//    apps/demo/server.ts) and resolve the Apple credentials via
//    @loyanexa/pass's credentials.ts — the one implementation shared with
//    the demo server, which prefers PEM content from
//    APPLE_SIGNER_CERT/_KEY/APPLE_WWDR_CERT (how Fly.io secrets arrive) and
//    falls back to the APPLE_*_PATH files this script has always used.
//    Never inline, copy or commit the cert material itself.
// ---------------------------------------------------------------------------
function loadEnvIntoProcess(file: string): void {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvIntoProcess(path.join(ROOT, '.env'));

const need = (key: string): string => {
  const v = process.env[key];
  if (!v) throw new Error(`.env is missing ${key}`);
  return v;
};

const TEAM_ID = need('APPLE_TEAM_ID');
const PASS_TYPE_ID = need('APPLE_PASS_TYPE_ID');
const { signerCertPath: CERT_PATH, signerKeyPath: KEY_PATH, wwdrPath: WWDR_PATH } = resolveAppleCredentials(ROOT);

console.log('== LoyaNexa demo .pkpass builder ==');
console.log(`Pass Type ID : ${PASS_TYPE_ID}`);
console.log(`Team ID      : ${TEAM_ID}`);

// ---------------------------------------------------------------------------
// 1. Render the stamp strip at all three densities via @loyanexa/image.
//    This is the point of the exercise: the pass carries an image this
//    project actually generated, not a stub.
// ---------------------------------------------------------------------------
const GOAL = 8;
const FILLED = 3;
const NAVY = '#203757';
const ACCENT = '#F96400';
const INACTIVE = '#8794A5';

const stripSet = await renderAllDensities(new MemoryStore(), {
  goal: GOAL,
  filled: FILLED,
  shape: 'circle',
  bgColor: NAVY,
  bgOpacity: 1,
  activeColor: ACCENT,
  inactiveColor: INACTIVE,
});
console.log(
  `Rendered strip.png (${stripSet['strip.png'].length}B), ` +
    `strip@2x.png (${stripSet['strip@2x.png'].length}B), ` +
    `strip@3x.png (${stripSet['strip@3x.png'].length}B)`
);

// ---------------------------------------------------------------------------
// 2. icon.png (29x29) / icon@2x.png (58x58) — navy square, orange disc.
//    Apple rejects a pass with no icon, and the wordmark is unreadable at
//    29px, so a simple on-brand mark generated from Surface + fillDisc is
//    the right call here.
// ---------------------------------------------------------------------------
function makeIcon(size: number): Buffer {
  const surface = new Surface(size, size);
  surface.fill(parseHexColor(NAVY, 1));
  fillDisc(surface, size / 2, size / 2, size * 0.36, parseHexColor(ACCENT, 1));
  return encodePNG(surface.toRGBA(), size, size);
}
const icon1x = makeIcon(29);
const icon2x = makeIcon(58);
console.log(`Generated icon.png (${icon1x.length}B), icon@2x.png (${icon2x.length}B)`);

// ---------------------------------------------------------------------------
// 3. pass.json — storeCard, per docs/BUILD.md §9.1 and §8.6.
//
//    Deliberately NO webServiceURL / authenticationToken: §9.3 is explicit
//    that webServiceURL must be HTTPS and Apple fails silently otherwise.
//    There is no HTTPS endpoint yet. A pass that omits both fields is valid
//    and installs cleanly; it just won't live-update (see closing note).
// ---------------------------------------------------------------------------
const serialNumber = randomBytes(14).toString('base64url').slice(0, 18); // §17: 18 random base64url chars

const terms = [
  '1 stamp per visit.',
  `Collect ${GOAL} stamps to get a reward.`,
  'Card, stamps and reward expiry: unlimited.',
  'Stamps and rewards cannot be exchanged, returned or bought for cash.',
  'Cards cannot be transferred or combined with other cards.',
  'The company reserves the right to amend these terms.',
].join(' ');

const credentials: PassCredentials = {
  teamId: TEAM_ID,
  passTypeId: PASS_TYPE_ID,
  certPath: CERT_PATH,
  keyPath: KEY_PATH,
  wwdrPath: WWDR_PATH,
};

const content: PassContent = {
  serialNumber,
  organizationName: 'LoyaNexa Demo Cafe',
  description: 'LoyaNexa loyalty card',
  logoText: 'LoyaNexa',
  backgroundColor: NAVY, // #203757 brand navy
  foregroundColor: '#FFFFFF',
  labelColor: '#C4CEDB', // rgb(196,206,219)
  headerFields: [{ key: 'stamps', label: 'STAMPS', value: `${FILLED} of ${GOAL}` }],
  secondaryFields: [{ key: 'reward', label: 'REWARD', value: 'Free coffee' }],
  backFields: [{ key: 'terms', label: 'Terms', value: terms }],
  barcodeMessage: serialNumber,
};

const images: PassImages = {
  'icon.png': icon1x,
  'icon@2x.png': icon2x,
  'strip.png': stripSet['strip.png'],
  'strip@2x.png': stripSet['strip@2x.png'],
  'strip@3x.png': stripSet['strip@3x.png'],
};

// ---------------------------------------------------------------------------
// 4-6. Stage the bundle, hash it into manifest.json (SHA-1 — PassKit
//      requires it here, not a security choice), sign, and zip with the
//      files at the archive root — all via @loyanexa/pass's buildPass, the
//      one implementation this script and the demo server both call.
// ---------------------------------------------------------------------------
// Verified once by downloading the certificate and hashing it (fingerprint
// cross-checked against Apple's published Root CA SHA-256, B0:B1:73:0E:CB:
// C7:FF:45:...). Pinning this means a tampered download gets caught by the
// hash check below instead of being handed straight to -CAfile and quietly
// treated as trustworthy.
const APPLE_ROOT_CA_SHA256 = 'b0b1730ecbc7ff4505142c49f1295e6eda6bcaed7e2c68c5be91b5a11001f024';

const tmpDirs: string[] = [];
function mkTmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

async function buildAndVerify(): Promise<0 | 1> {
  const pkpass = buildPass(credentials, content, images);
  const pkpassTmp = path.join(tmpdir(), 'LoyaNexa-demo.pkpass');
  writeFileSync(pkpassTmp, pkpass);
  console.log(`Built and signed bundle -> ${pkpassTmp}`);

  // -------------------------------------------------------------------------
  // 7. Verify before declaring success. Everything below re-reads the actual
  //    archive on disk, not the in-memory buffers, so it catches zip/staging
  //    bugs, not just logic bugs.
  // -------------------------------------------------------------------------
  console.log('\n== Verification ==');
  const results: Array<[string, boolean, string]> = [];

  // 7a. unzip -l listing + "no enclosing directory" check.
  const listing = execFileSync('unzip', ['-l', pkpassTmp], { encoding: 'utf8' });
  console.log(listing);
  const names = execFileSync('unzip', ['-Z1', pkpassTmp], { encoding: 'utf8' }).trim().split('\n');
  const expectedMembers = [...PASS_MEMBERS];
  const missing = expectedMembers.filter((m) => !names.includes(m));
  const hasDirPrefix = names.some((n) => n.includes('/'));
  const listingOk = missing.length === 0 && !hasDirPrefix && names.length === expectedMembers.length;
  results.push(['1. unzip -l shows all 8 members at the archive root', listingOk,
    listingOk ? `members: ${names.join(', ')}` : `missing=${missing.join(',') || 'none'} hasDirPrefix=${hasDirPrefix} names=${names.join(',')}`]);

  // 7b. Extract and re-hash every manifest entry against the actual archive contents.
  const verifyDir = mkTmpDir('loyanexa-verify-');
  execFileSync('unzip', ['-q', pkpassTmp, '-d', verifyDir]);
  const extractedManifest = JSON.parse(
    readFileSync(path.join(verifyDir, 'manifest.json'), 'utf8')
  ) as Record<string, string>;
  let manifestOk = true;
  const manifestDetails: string[] = [];
  for (const [name, digest] of Object.entries(extractedManifest)) {
    const actual = createHash('sha1').update(readFileSync(path.join(verifyDir, name))).digest('hex');
    const ok = actual === digest;
    if (!ok) manifestOk = false;
    manifestDetails.push(`${name}: manifest=${digest} archive=${actual} ${ok ? 'OK' : 'MISMATCH'}`);
  }
  results.push(['2. every manifest.json digest matches the file in the archive', manifestOk, manifestDetails.join('\n   ')]);

  // 7c. Download Apple Root CA, check it against the pinned digest, then
  //     verify the detached signature against it. A tampered/substituted
  //     download would otherwise be handed straight to -CAfile and used to
  //     "verify" a signature it has no business trusting.
  const rootCaDerUrl = 'https://www.apple.com/appleca/AppleIncRootCertificate.cer';
  const rootCaDer = Buffer.from(await (await fetch(rootCaDerUrl)).arrayBuffer());
  const rootCaDigest = createHash('sha256').update(rootCaDer).digest('hex');
  if (rootCaDigest !== APPLE_ROOT_CA_SHA256) {
    throw new Error(
      `Apple Root CA download does not match the pinned SHA-256.\n` +
        `  expected: ${APPLE_ROOT_CA_SHA256}\n` +
        `  got:      ${rootCaDigest}\n` +
        `Refusing to use it for signature verification.`
    );
  }
  const rootCaDerPath = path.join(verifyDir, 'AppleRootCA.cer');
  const rootCaPemPath = path.join(verifyDir, 'AppleRootCA.pem');
  writeFileSync(rootCaDerPath, rootCaDer);
  execFileSync('openssl', ['x509', '-inform', 'DER', '-in', rootCaDerPath, '-out', rootCaPemPath]);

  let sigOk = false;
  let sigOutput = '';
  try {
    sigOutput = execFileSync(
      'openssl',
      [
        'smime', '-verify', '-binary', '-inform', 'DER',
        '-in', path.join(verifyDir, 'signature'),
        '-content', path.join(verifyDir, 'manifest.json'),
        '-CAfile', rootCaPemPath,
        '-purpose', 'any',
      ],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    sigOk = true;
  } catch (e) {
    if (e instanceof Error) {
      const { stdout, stderr } = e as ExecFileException;
      sigOutput = String(stdout || '') + String(stderr || '');
    } else {
      sigOutput = String(e);
    }
  }
  results.push(['3. signature verifies against Apple Root CA (-purpose any)', sigOk, sigOutput.trim() || '(openssl printed nothing on success)']);

  // 7d. Cross-check pass.json identifiers against the certificate's own subject.
  const subject = execFileSync('openssl', ['x509', '-in', CERT_PATH, '-noout', '-subject'], { encoding: 'utf8' });
  const certPassTypeId = subject.match(/UID\s*=\s*([^,\n]+)/)?.[1]?.trim();
  const certTeamId = subject.match(/OU\s*=\s*([^,\n]+)/)?.[1]?.trim();
  const extractedPass = JSON.parse(
    readFileSync(path.join(verifyDir, 'pass.json'), 'utf8')
  ) as Pick<PkPassJson, 'passTypeIdentifier' | 'teamIdentifier'>;
  const idsOk = extractedPass.passTypeIdentifier === certPassTypeId && extractedPass.teamIdentifier === certTeamId;
  results.push([
    '4. pass.json passTypeIdentifier/teamIdentifier match the cert UID/OU',
    idsOk,
    `cert subject: ${subject.trim()}\n   pass.json: passTypeIdentifier=${extractedPass.passTypeIdentifier} teamIdentifier=${extractedPass.teamIdentifier}\n   cert:      UID=${certPassTypeId} OU=${certTeamId}`,
  ]);

  for (const [label, ok, detail] of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}`);
    if (detail) console.log(`   ${detail}`);
  }

  const allOk = results.every(([, ok]) => ok);
  if (!allOk) {
    console.error('\nBLOCKED: one or more verifications failed. Not copying anything to Downloads.');
    return 1;
  }

  // ---------------------------------------------------------------------------
  // 8. Ship it to ~/Downloads so it is trivially AirDroppable.
  // ---------------------------------------------------------------------------
  const dest = path.join(homedir(), 'Downloads', 'LoyaNexa-demo.pkpass');
  copyFileSync(pkpassTmp, dest);
  const size = readFileSync(dest).length;

  console.log(`\n== Done ==`);
  console.log(`Wrote ${dest} (${size} bytes)`);
  console.log(`
Get it onto the iPhone:
  1. AirDrop ${dest} to the iPhone (or attach it to yourself in Messages/Mail).
  2. Tap the file on the iPhone — it opens in Wallet automatically.
  3. Tap "Add".

Known limitation: this pass has no webServiceURL, so it will NOT receive
live stamp updates over APNs — it installs and displays but stays static.
Wiring that up needs a public HTTPS endpoint and is sub-project 6's job.
This demo proves signing, rendering and installation, not the update loop.
`);
  return 0;
}

let exitCode = 1;
try {
  exitCode = await buildAndVerify();
} finally {
  // Clean up every mkdtempSync directory regardless of outcome — staging
  // and verifyDir otherwise accumulate under the OS tmpdir on every run,
  // including every failed one.
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
}
process.exit(exitCode);
