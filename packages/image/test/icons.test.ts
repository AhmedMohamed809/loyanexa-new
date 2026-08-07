import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Surface, parseHexColor } from '../src/raster/surface.ts';
import { drawBuiltinIcon, renderIconSwatch, BUILTIN_ICON_IDS, isBuiltinIconId } from '../src/raster/icons.ts';
import { renderStrip, type StripSpec } from '../src/strip.ts';
import { decodePNG } from '../src/png/decode.ts';

test('BUILTIN_ICON_IDS lists exactly the twenty-seven documented icons', () => {
  // Ten general marks plus fifteen trade marks. The trade marks were added on
  // 6 August 2026: the original ten cover a cafe and a gym and then run out,
  // and a butcher stamping a star reads as a card assembled from whatever was
  // to hand.
  assert.deepEqual(
    [...BUILTIN_ICON_IDS].sort(),
    [
      'baby', 'basket', 'bottle', 'car', 'check', 'cleaver', 'coffee', 'croissant',
      'cutlery', 'dumbbell', 'fish', 'flower', 'gi', 'gift', 'glove', 'hanger', 'heart',
      'kettlebell', 'musicNote', 'needle', 'paw', 'phone', 'scissors', 'shoe', 'star',
      'tooth', 'tyre',
    ]
  );
});

test('every template names a real icon, and almost none fall back on a generic one', async () => {
  // The mapping is the point of the trade marks: a butcher template that
  // still stamps a star has gained nothing from them existing.
  const { CARD_TEMPLATES } = await import('../../../apps/demo/cardTemplates.ts');
  // 'gift' is generic in general and exactly right for a gift shop, so it is
  // the one permitted use.
  const generic = new Set(['star', 'heart', 'check']);

  for (const tpl of CARD_TEMPLATES) {
    assert.ok(isBuiltinIconId(tpl.builtinIcon), `${tpl.id} names a missing icon: ${tpl.builtinIcon}`);
    assert.ok(
      !generic.has(tpl.builtinIcon),
      `${tpl.id} still stamps a generic mark (${tpl.builtinIcon}) — a trade mark exists for it`
    );
  }
});

test('isBuiltinIconId accepts every real id and rejects nonsense/undefined/null', () => {
  for (const id of BUILTIN_ICON_IDS) assert.equal(isBuiltinIconId(id), true, id);
  assert.equal(isBuiltinIconId('teapot'), false);
  assert.equal(isBuiltinIconId(''), false);
  assert.equal(isBuiltinIconId(undefined), false);
  assert.equal(isBuiltinIconId(null), false);
});

test('every built-in icon renders without throwing at every stamp radius a real strip ever uses', () => {
  // r ranges from ~11px (goal 20, scale 1) to ~98px (goal 3, scale 3) — see
  // packages/image/src/layout.ts's slotPositions(). Sweep a representative
  // spread of radii rather than recomputing slotPositions here, so this
  // test does not silently drift out of sync with the layout formula.
  const radii = [3, 8, 11, 20, 37, 56, 80, 98, 140];
  const color = parseHexColor('#F96400');
  for (const id of BUILTIN_ICON_IDS) {
    for (const r of radii) {
      const size = Math.ceil(r * 2 + 8);
      const surface = new Surface(size, size);
      assert.doesNotThrow(() => drawBuiltinIcon(surface, size / 2, size / 2, r, color, id), `${id} at r=${r}`);
    }
  }
});

test('every built-in icon renders without throwing inside a real strip, for goal 3 and goal 20, at every density', () => {
  const base: Omit<StripSpec, 'builtinIcon'> = {
    goal: 3,
    filled: 1,
    shape: 'circle',
    bgColor: '#203757',
    bgOpacity: 1,
    activeColor: '#F96400',
    inactiveColor: '#8794A5',
    stampSource: 'builtin',
    scale: 1,
  };
  for (const id of BUILTIN_ICON_IDS) {
    for (const goal of [3, 20] as const) {
      for (const scale of [1, 2, 3] as const) {
        const filled = Math.max(1, Math.floor(goal / 2));
        assert.doesNotThrow(
          () => renderStrip({ ...base, goal, filled, scale, builtinIcon: id }),
          `${id} goal=${goal} scale=${scale}`
        );
      }
    }
  }
});

test('renderIconSwatch produces a decodable, fully-transparent-cornered PNG at the requested size', () => {
  for (const id of BUILTIN_ICON_IDS) {
    const png = renderIconSwatch(id, 64, parseHexColor('#F96400'));
    const img = decodePNG(png);
    assert.equal(img.width, 64, id);
    assert.equal(img.height, 64, id);
    // The very corner of a 64x64 canvas is outside every icon's footprint
    // (icons are drawn within ~0.42*size of the centre) — it must stay
    // transparent, proving this is a real alpha-masked glyph, not an
    // opaque square.
    assert.equal(img.rgba[3], 0, `${id}'s corner pixel must be transparent`);
  }
});

test('two different built-in icons produce visibly different pixels at the same size and colour', () => {
  const color = parseHexColor('#F96400');
  const coffee = renderIconSwatch('coffee', 48, color);
  const star = renderIconSwatch('star', 48, color);
  assert.notDeepEqual(coffee, star);
});
