import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrastRatio, effectiveBackgroundHex } from '../src/contrast.ts';

test('black on white is the maximum ratio, 21:1', () => {
  assert.ok(Math.abs(contrastRatio('#000000', '#FFFFFF') - 21) < 0.01);
});

test('a colour against itself is the minimum ratio, 1:1', () => {
  assert.equal(contrastRatio('#F96400', '#F96400'), 1);
});

test('order of the two colours does not matter', () => {
  assert.equal(contrastRatio('#203757', '#F96400'), contrastRatio('#F96400', '#203757'));
});

test('the app defaults (navy background, orange/grey stamps) clear the 3:1 warning threshold', () => {
  assert.ok(contrastRatio('#F96400', '#203757') >= 3, 'active vs background');
  assert.ok(contrastRatio('#8794A5', '#203757') >= 3, 'inactive vs background');
});

test('a deliberately low-contrast pair (pale stamp on a pale background) falls under 3:1', () => {
  assert.ok(contrastRatio('#F5F0E8', '#FAFAF7') < 3);
});

test('effectiveBackgroundHex is the background colour itself at full opacity', () => {
  assert.equal(effectiveBackgroundHex('#203757', 1), '#203757');
});

test('effectiveBackgroundHex blends toward white as opacity drops', () => {
  assert.equal(effectiveBackgroundHex('#000000', 0), '#ffffff');
  assert.equal(effectiveBackgroundHex('#000000', 0.5), '#808080');
});
