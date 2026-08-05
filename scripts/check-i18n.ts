// Fails CI when the dictionaries diverge. A missing key renders as a blank
// element — silent and easy to ship (BUILD.md §13, CONTRIBUTING.md).
import { en } from '../packages/i18n/src/en.ts';
import { ar } from '../packages/i18n/src/ar.ts';

const enKeys = new Set(Object.keys(en));
const arKeys = new Set(Object.keys(ar));

const missingInAr = [...enKeys].filter((k) => !arKeys.has(k));
const missingInEn = [...arKeys].filter((k) => !enKeys.has(k));
const empty = Object.entries({ ...en, ...ar }).filter(([, v]) => !String(v).trim());

/**
 * Mojibake: UTF-8 bytes that were decoded as Latin-1 somewhere along the way.
 *
 * This is not hypothetical. Seventeen strings shipped to production on
 * 4 August 2026 reading `ØªØ§Ø±ÙØ®` where they should have read `تاريخ`,
 * because a script that inserted them ran the equivalent of
 * `text.encode().decode('unicode_escape')` over literal UTF-8. Every test
 * passed: the keys were present, non-empty, and identical in both files. The
 * only thing wrong with them was that they were unreadable, and nothing
 * checked for that.
 *
 * The signature is unmistakable — Arabic mangled this way always produces Ø
 * and Ù pairs, and an em dash becomes â. Flagging any Latin-1-range mojibake
 * marker in a message is enough, because no real message in either language
 * contains one.
 */
const MOJIBAKE = /[\u00C3\u00D8\u00D9\u00DA\u00E2]/;
const garbled = Object.entries({ ...en, ...ar }).filter(([, v]) => MOJIBAKE.test(String(v)));

let failed = false;
if (garbled.length) {
  console.error('mojibake (UTF-8 decoded as Latin-1):', garbled.map(([k, v]) => `${k} = ${v}`).join('\n  '));
  failed = true;
}
if (missingInAr.length) { console.error('missing from ar:', missingInAr.join(', ')); failed = true; }
if (missingInEn.length) { console.error('missing from en:', missingInEn.join(', ')); failed = true; }
if (empty.length) { console.error('empty messages:', empty.map(([k]) => k).join(', ')); failed = true; }

if (failed) process.exit(1);
console.log(`i18n parity OK — ${enKeys.size} keys in both dictionaries`);
