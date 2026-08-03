// apps/demo/test/passContent.test.ts — pass.json field placement (BUILD.md
// §9.1). Pure data shaping, no HTTP, no database, no signing — this only
// checks the shape buildPassContentFor() produces; packages/pass/test's own
// suite (plus scripts/make-demo-pass.ts, run by hand against the real Apple
// certs) checks that a pass built from a shape like this one signs and
// verifies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Card, Pass } from '@prisma/client';
import { buildPassContentFor, buildTermsText } from '../passContent.ts';

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 'card1',
    merchantId: 'merchant1',
    slot: 1,
    linkCode: 10001,
    linkAlias: null,
    shortCode: 'CARD0001',
    name: 'Shami Bakery',
    logoUrl: null,
    logoHash: null,
    iconUrl: null,
    iconHash: null,
    iconFit: 'contain',
    coverUrl: null,
    coverHash: null,
    stampsGoal: 8,
    starterStamps: 0,
    stampShape: 'circle',
    stampSource: 'plain',
    builtinIcon: 'star',
    bgColor: '#203757',
    fgColor: '#FFFFFF',
    stampActive: '#F96400',
    stampInactive: '#8794A5',
    labelStamps: '',
    labelRewards: '',
    lang: 'ar',
    expiryType: 'unlimited',
    expiryDays: null,
    expiryDate: null,
    rewardText: 'Free coffee',
    formFields: ['name', 'phone'],
    locations: [],
    active: true,
    createdAt: new Date(),
    ...overrides,
  } as Card;
}

function makePass(overrides: Partial<Pass> = {}): Pass {
  return {
    id: 'pass1',
    serial: 'SERIAL0000000001',
    shortCode: 'PASS0001',
    cardId: 'card1',
    merchantId: 'merchant1',
    authToken: 'tok',
    custName: '',
    custEmail: '',
    custPhone: '',
    custBirthday: null,
    stamps: 3,
    totalStamps: 3,
    rewards: 0,
    message: '',
    platform: '',
    lastStampAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Pass;
}

test('primaryFields is empty, matching BUILD.md §9.1', () => {
  const content = buildPassContentFor(makeCard(), makePass());
  assert.deepEqual(content.primaryFields, []);
});

test('headerFields carries the stamp count as "N of GOAL"', () => {
  const content = buildPassContentFor(makeCard({ stampsGoal: 8 }), makePass({ stamps: 3 }));
  assert.equal(content.headerFields?.length, 1);
  assert.equal(content.headerFields?.[0]?.key, 'stamps');
  assert.equal(content.headerFields?.[0]?.value, '3 of 8');
});

test('secondaryFields carries the reward and stamps-remaining, in that order', () => {
  const content = buildPassContentFor(makeCard({ stampsGoal: 8, rewardText: 'Free coffee' }), makePass({ stamps: 3 }));
  assert.equal(content.secondaryFields?.length, 2);
  assert.equal(content.secondaryFields?.[0]?.key, 'reward');
  assert.equal(content.secondaryFields?.[0]?.value, 'Free coffee');
  assert.equal(content.secondaryFields?.[1]?.key, 'stampsRemaining');
  assert.ok(content.secondaryFields?.[1]?.value.startsWith('5 stamps'), 'stampsRemaining should read 8 - 3 = 5');
});

test('the invisible change marker is still appended to stampsRemaining, and changeMessage is set for the live-update banner', () => {
  const content = buildPassContentFor(makeCard(), makePass({ stamps: 3 }));
  const field = content.secondaryFields?.[1];
  assert.ok(field?.value.startsWith('5 stamps'), 'visible text must still read "5 stamps"');
  assert.ok(field && field.value.length > '5 stamps'.length, 'invisible marker characters must be appended');
  assert.equal(field?.changeMessage, '%@');
});

test('webServiceURL/authenticationToken are included together only when publicBaseUrl is given', () => {
  const withUrl = buildPassContentFor(makeCard(), makePass({ authToken: 'abc' }), { publicBaseUrl: 'https://example.fly.dev' });
  assert.equal(withUrl.webServiceURL, 'https://example.fly.dev/apple');
  assert.equal(withUrl.authenticationToken, 'abc');

  const withoutUrl = buildPassContentFor(makeCard(), makePass());
  assert.equal(withoutUrl.webServiceURL, undefined);
  assert.equal(withoutUrl.authenticationToken, undefined);
});

test('buildTermsText describes the card\'s own expiry rule', () => {
  assert.match(buildTermsText(makeCard({ expiryType: 'unlimited' })), /expiry: unlimited/);
  assert.match(buildTermsText(makeCard({ expiryType: 'duration', expiryDays: 30 })), /expiry: 30 days/);
});
