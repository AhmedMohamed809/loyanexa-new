// Fails CI when the dictionaries diverge. A missing key renders as a blank
// element — silent and easy to ship (BUILD.md §13, CONTRIBUTING.md).
import { en } from '../packages/i18n/src/en.ts';
import { ar } from '../packages/i18n/src/ar.ts';

const enKeys = new Set(Object.keys(en));
const arKeys = new Set(Object.keys(ar));

const missingInAr = [...enKeys].filter((k) => !arKeys.has(k));
const missingInEn = [...arKeys].filter((k) => !enKeys.has(k));
const empty = Object.entries({ ...en, ...ar }).filter(([, v]) => !String(v).trim());

let failed = false;
if (missingInAr.length) { console.error('missing from ar:', missingInAr.join(', ')); failed = true; }
if (missingInEn.length) { console.error('missing from en:', missingInEn.join(', ')); failed = true; }
if (empty.length) { console.error('empty messages:', empty.map(([k]) => k).join(', ')); failed = true; }

if (failed) process.exit(1);
console.log(`i18n parity OK — ${enKeys.size} keys in both dictionaries`);
