// apps/demo/test/theme.test.ts — the light/dark palette.
//
// The contrast assertions are the reason this file exists. A light theme is
// easy to ship looking almost right and being unreadable in two places, and
// the specific trap here is the brand orange: it is a fine colour to fill a
// button with and a terrible one to set text in on white. These numbers are
// measured, not asserted from memory.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { CHROME_CSS } = await import('../views/chrome.ts');
const { contrastRatio } = await import('../../../packages/image/src/contrast.ts');

/** Reads a token out of a `:root`-style block in the stylesheet. */
function token(block: string, name: string): string {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(block);
  assert.ok(m, `token --${name} is missing`);
  return m![1]!.trim();
}

const lightBlock = CHROME_CSS.split('html[data-theme="dark"]')[0]!;
const darkBlock = CHROME_CSS.slice(CHROME_CSS.indexOf('html[data-theme="dark"]'));

test('light is the default palette', () => {
  assert.equal(token(lightBlock, 'canvas'), '#F7F8FA');
  assert.equal(token(lightBlock, 'paper'), '#FFFFFF');
  assert.equal(token(lightBlock, 'ink'), '#131C2B');
});

test('body text meets WCAG AA on both themes', () => {
  for (const [name, block] of [['light', lightBlock], ['dark', darkBlock]] as const) {
    const canvas = token(block, 'canvas');
    const paper = token(block, 'paper');
    const ink = token(block, 'ink');
    const ink2 = token(block, 'ink-2');

    assert.ok(contrastRatio(ink, canvas) >= 4.5, `${name}: --ink on --canvas is only ${contrastRatio(ink, canvas).toFixed(2)}`);
    assert.ok(contrastRatio(ink, paper) >= 4.5, `${name}: --ink on --paper is only ${contrastRatio(ink, paper).toFixed(2)}`);
    assert.ok(contrastRatio(ink2, paper) >= 4.5, `${name}: --ink-2 on --paper is only ${contrastRatio(ink2, paper).toFixed(2)}`);
  }
});

test('secondary text is legible, not merely present', () => {
  // --ink-3 is used for hints, counts and captions. It is the token most
  // likely to be nudged lighter for looks and become unreadable.
  for (const [name, block] of [['light', lightBlock], ['dark', darkBlock]] as const) {
    const ratio = contrastRatio(token(block, 'ink-3'), token(block, 'canvas'));
    assert.ok(ratio >= 4.5, `${name}: --ink-3 on --canvas is only ${ratio.toFixed(2)}`);
  }
});

test('button labels are readable on the orange fill', () => {
  for (const [name, block] of [['light', lightBlock], ['dark', darkBlock]] as const) {
    const onAccent = token(block, 'on-accent');
    // --accent is only declared in the light block; dark inherits it.
    const accent = token(lightBlock, 'accent');
    const ratio = contrastRatio(onAccent, accent);
    assert.ok(ratio >= 4.5, `${name}: --on-accent on --accent is only ${ratio.toFixed(2)}`);
  }
});

test('accented TEXT never uses the raw brand orange on light', () => {
  // The whole reason --accent-light exists as a separate token. The brand
  // orange as text on white is 2.45:1 — it fails outright, and using it is
  // most of what makes a light theme look amateurish.
  const accent = token(lightBlock, 'accent');
  const paper = token(lightBlock, 'paper');
  assert.ok(
    contrastRatio(accent, paper) < 4.5,
    'if the brand orange ever passes on white, this test can go — until then it must not be used as text'
  );

  const accentText = token(lightBlock, 'accent-light');
  const ratio = contrastRatio(accentText, paper);
  assert.ok(ratio >= 4.5, `--accent-light is used as text and is only ${ratio.toFixed(2)} on --paper`);
});

test('status colours are readable on their own background', () => {
  for (const [name, block] of [['light', lightBlock], ['dark', darkBlock]] as const) {
    for (const status of ['green', 'red']) {
      const ratio = contrastRatio(token(block, status), token(block, 'paper'));
      assert.ok(ratio >= 4.5, `${name}: --${status} on --paper is only ${ratio.toFixed(2)}`);
    }
  }
});

test('every token the light theme defines has a dark counterpart, or is deliberately shared', () => {
  // A token defined only in light silently keeps its light value in dark —
  // which is how a dark theme ends up with one white panel in it.
  const shared = new Set(['accent', 'accent-hover', 'radius', 'radius-lg', 'dur-1', 'dur-2', 'dur-3', 'ease']);
  const lightTokens = [...lightBlock.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]!);
  const darkTokens = new Set([...darkBlock.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]!));

  for (const name of lightTokens) {
    if (shared.has(name)) continue;
    assert.ok(darkTokens.has(name), `--${name} has no dark value, so dark would inherit the light one`);
  }
});

test('the shadows differ between themes — a dark shadow on white is a smudge', () => {
  assert.notEqual(token(lightBlock, 'shadow-3'), token(darkBlock, 'shadow-3'));
  assert.match(token(lightBlock, 'shadow-3'), /rgba\(19,28,43/, 'light shadows are tinted with the ink colour, not pure black');
  // Guards the bug this shipped with once: :root declared the shadows twice,
  // the dark values came second, and light silently got dark shadows.
  const declarations = (lightBlock.match(/--shadow-1:/g) ?? []).length;
  assert.equal(declarations, 1, '--shadow-1 must be declared exactly once in the light block');
});
