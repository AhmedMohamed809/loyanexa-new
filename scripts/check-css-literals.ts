// scripts/check-css-literals.ts
//
// The CSS in this project lives inside tagged-free template literals
// (CHROME_CSS, the print sheet, the enrol page). A stray backtick anywhere in
// that CSS — including inside a comment — silently ends the literal and turns
// the rest of the stylesheet into TypeScript, which then fails to parse with
// an error pointing at a line that looks fine.
//
// This happened three times in one session, always the same way: writing
// `some-property` in a CSS comment out of ordinary prose habit. tsc does
// catch it, but it reports `',' expected` at a column in the middle of a
// stylesheet, which is a genuinely confusing way to be told "you typed a
// backtick". This says it plainly instead.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  'apps/demo/server.ts',
  'apps/demo/views/chrome.ts',
  'apps/demo/views/stampScreen.ts',
];

let failed = false;

for (const rel of FILES) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) continue;
  const lines = fs.readFileSync(full, 'utf8').split('\n');

  let inCss = false;
  lines.forEach((line, i) => {
    // Entering a CSS literal: a line that opens one and does not close it.
    if (!inCss && /=\s*`\s*$/.test(line) && /CSS|css/.test(line)) inCss = true;
    else if (inCss && /^`;?\s*$/.test(line)) inCss = false;

    // A backtick inside a /* … */ CSS comment line is always a mistake.
    const isCssComment = /^\s*(\/\*|\*|--|\s)*.*$/.test(line) && /^\s*(\/\*|\s+[A-Za-z(])/.test(line);
    if (inCss && line.includes('`') && isCssComment) {
      console.error(`${rel}:${i + 1}  backtick inside a CSS literal — it ends the template early`);
      console.error(`    ${line.trim()}`);
      failed = true;
    }
  });
}

// ---------------------------------------------------------------------------
// Balanced braces in the landing page's stylesheets.
//
// On 7 August 2026 a regex that stripped `backdrop-filter:...;` declarations
// destroyed THREE rules — .topbar-in, .kpis and .chips a:hover — because its
// pattern ended `[^;]+;` and the LAST declaration in a CSS block has no
// trailing semicolon. The match ran past the closing brace, through the next
// rule's selector, and stopped at the first semicolon it found inside it.
//
// The visible result was the landing page's navigation stacking onto three
// lines, and nothing caught it: the file still parsed, the page still served,
// every test still passed. A stylesheet with unbalanced braces is broken in a
// way only a person looking at the page can see, so count them here.
// ---------------------------------------------------------------------------
const landing = path.join(ROOT, 'apps/demo/public/index.html');
if (fs.existsSync(landing)) {
  const html = fs.readFileSync(landing, 'utf8');
  for (const block of html.matchAll(/<style>([\s\S]*?)<\/style>/g)) {
    const css = block[1] ?? '';
    const open = (css.match(/\{/g) ?? []).length;
    const close = (css.match(/\}/g) ?? []).length;
    if (open !== close) {
      console.error(`apps/demo/public/index.html  a <style> block has ${open} '{' and ${close} '}' — a rule has been truncated`);
      failed = true;
    }
  }
}

if (failed) {
  console.error('\nUse plain words in CSS comments, not backticks, and never strip a declaration with a pattern that can cross a closing brace.');
  process.exit(1);
}
console.log('css literals OK — no stray backticks, braces balanced');
