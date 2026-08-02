import { test } from 'node:test';
import assert from 'node:assert/strict';
import { en } from '../src/en.ts';
import { ar } from '../src/ar.ts';
import { t, arabicDigits } from '../src/index.ts';

test('both dictionaries hold exactly the same keys', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ar).sort());
});

test('no message is empty — a blank renders as an invisible element', () => {
  for (const [k, v] of Object.entries({ ...en, ...ar })) {
    assert.ok(v.trim().length > 0, `empty message for ${k}`);
  }
});

test('t returns the message for the requested language', () => {
  assert.equal(t('en', 'stampTooSoon'), en.stampTooSoon);
  assert.equal(t('ar', 'stampTooSoon'), ar.stampTooSoon);
});

test('t interpolates named variables', () => {
  assert.equal(t('en', 'stampsRemaining', { count: '4' }), '4 stamps remaining');
});

test('an unreplaced placeholder is loud, not silent', () => {
  assert.throws(() => t('en', 'stampsRemaining'), /missing variable: count/);
});

test('Arabic-Indic numerals under ar only', () => {
  assert.equal(arabicDigits(2026, 'ar'), '٢٠٢٦');
  assert.equal(arabicDigits(2026, 'en'), '2026');
  assert.equal(arabicDigits('3/8', 'ar'), '٣/٨');
});
