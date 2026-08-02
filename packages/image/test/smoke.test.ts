import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PACKAGE_NAME } from '../src/index.ts';

test('package exposes its name', () => {
  assert.equal(PACKAGE_NAME, '@loyanexa/image');
});
