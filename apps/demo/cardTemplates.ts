// apps/demo/cardTemplates.ts — BUILD.md §8.4's template gallery.
//
// A merchant opening "new card" to a blank form has to invent a stamp
// count, a reward, and three colours before they have seen the product work
// once. These presets let a café pick "Café" and be looking at a finished
// card in one click — still fully editable afterwards, since every value
// lands in the ordinary create form rather than being written straight to
// the database.
//
// **These strings are ours, not the merchant's.** docs/CLAUDE.md's "never
// translate merchant-authored text" rule is about card names and rewards a
// merchant typed; the seed text below is LoyaNexa's own copy, so it ships in
// both languages and is picked by the *card's* language — a template applied
// to an Arabic card must not seed English reward text onto a customer's
// pass. The moment the merchant edits it, it becomes theirs and is never
// touched again.

import type { BuiltinIconId } from '../../packages/image/src/index.ts';

export type TemplateCategory = 'food' | 'beauty' | 'fitness' | 'services';

export interface CardTemplate {
  id: string;
  /** The importable code from BUILD.md §8.4 ("import by code TMP-A1B2C3"). */
  code: string;
  category: TemplateCategory;
  /** Display name of the template itself — not the card name the merchant will choose. */
  labelEn: string;
  labelAr: string;
  /** Seed reward text, per card language. */
  rewardEn: string;
  rewardAr: string;
  stampsGoal: number;
  bgColor: string;
  stampActive: string;
  stampInactive: string;
  builtinIcon: BuiltinIconId;
  /** Extra search terms, so "coffee" finds the Café template. */
  keywordsEn: string;
  keywordsAr: string;
}

/**
 * Ordered by how often the trade actually shows up in the target market, so
 * the first row of the gallery is the common case rather than an alphabet.
 *
 * Colours are chosen as *pairs* that survive the strip renderer: a mid-to-
 * dark background with a light, saturated stamp colour. The designer warns
 * about low contrast, and a template shipping a combination that trips its
 * own warning would be an odd first impression.
 */
export const CARD_TEMPLATES: readonly CardTemplate[] = [
  {
    id: 'cafe',
    code: 'TMP-CAFE01',
    category: 'food',
    labelEn: 'Café',
    labelAr: 'مقهى',
    rewardEn: 'A free coffee',
    rewardAr: 'قهوة مجانية',
    stampsGoal: 8,
    bgColor: '#2B1B12',
    stampActive: '#E8A85C',
    stampInactive: '#6B554A',
    builtinIcon: 'coffee',
    keywordsEn: 'coffee espresso latte drinks',
    keywordsAr: 'قهوة اسبريسو مشروبات',
  },
  {
    id: 'bakery',
    code: 'TMP-BAKE02',
    category: 'food',
    labelEn: 'Bakery',
    labelAr: 'مخبز',
    rewardEn: 'A free pastry',
    rewardAr: 'معجنات مجانية',
    stampsGoal: 6,
    bgColor: '#1E1E1E',
    stampActive: '#F2D9A6',
    stampInactive: '#5A5248',
    builtinIcon: 'croissant',
    keywordsEn: 'bread cake dessert pastry',
    keywordsAr: 'خبز كيك حلويات معجنات',
  },
  {
    id: 'restaurant',
    code: 'TMP-REST03',
    category: 'food',
    labelEn: 'Restaurant',
    labelAr: 'مطعم',
    rewardEn: 'A free dessert',
    rewardAr: 'حلوى مجانية',
    stampsGoal: 10,
    bgColor: '#14261F',
    stampActive: '#7FD1A3',
    stampInactive: '#4A5C53',
    builtinIcon: 'star',
    keywordsEn: 'food dining meal lunch dinner',
    keywordsAr: 'طعام مطاعم غداء عشاء',
  },
  {
    id: 'barber',
    code: 'TMP-BARB04',
    category: 'beauty',
    labelEn: 'Barber',
    labelAr: 'حلاق',
    rewardEn: 'A free haircut',
    rewardAr: 'قصة شعر مجانية',
    stampsGoal: 6,
    bgColor: '#101826',
    stampActive: '#6EA8FF',
    stampInactive: '#44506B',
    builtinIcon: 'scissors',
    keywordsEn: 'haircut shave grooming men',
    keywordsAr: 'حلاقة قص شعر رجال',
  },
  {
    id: 'salon',
    code: 'TMP-SALN05',
    category: 'beauty',
    labelEn: 'Beauty salon',
    labelAr: 'صالون تجميل',
    rewardEn: '20% off your next visit',
    rewardAr: 'خصم ٢٠٪ على زيارتك القادمة',
    stampsGoal: 5,
    bgColor: '#2A1426',
    stampActive: '#F49AC2',
    stampInactive: '#6B4A61',
    builtinIcon: 'flower',
    keywordsEn: 'nails hair spa beauty',
    keywordsAr: 'أظافر شعر سبا تجميل',
  },
  {
    id: 'gym',
    code: 'TMP-GYM006',
    category: 'fitness',
    labelEn: 'Gym',
    labelAr: 'نادي رياضي',
    rewardEn: 'A free session',
    rewardAr: 'حصة تدريب مجانية',
    stampsGoal: 10,
    bgColor: '#111827',
    stampActive: '#F28C38',
    stampInactive: '#4B5563',
    builtinIcon: 'dumbbell',
    keywordsEn: 'fitness training workout sport',
    keywordsAr: 'لياقة تمرين رياضة',
  },
  {
    id: 'carwash',
    code: 'TMP-WASH07',
    category: 'services',
    labelEn: 'Car wash',
    labelAr: 'غسيل سيارات',
    rewardEn: 'A free wash',
    rewardAr: 'غسلة مجانية',
    stampsGoal: 5,
    bgColor: '#0F2027',
    stampActive: '#5FD3E8',
    stampInactive: '#3E5A63',
    builtinIcon: 'car',
    keywordsEn: 'car auto vehicle valet cleaning',
    keywordsAr: 'سيارات غسيل تنظيف',
  },
  {
    id: 'retail',
    code: 'TMP-SHOP08',
    category: 'services',
    labelEn: 'Shop',
    labelAr: 'متجر',
    rewardEn: 'A free gift',
    rewardAr: 'هدية مجانية',
    stampsGoal: 8,
    bgColor: '#1B1533',
    stampActive: '#B79CFF',
    stampInactive: '#4F4770',
    builtinIcon: 'gift',
    keywordsEn: 'store retail boutique shopping',
    keywordsAr: 'متجر تسوق بوتيك',
  },
];

/** The template with this id, or undefined. */
export function findTemplate(id: string): CardTemplate | undefined {
  return CARD_TEMPLATES.find((tpl) => tpl.id === id);
}

/**
 * The template with this import code, case- and whitespace-insensitively.
 *
 * Forgiving on purpose: the code is printed in a gallery and typed by hand,
 * so `tmp-cafe01`, ` TMP-CAFE01 ` and `TMP-CAFE01` must all work. A missing
 * dash is not accepted, because that would start matching codes the user
 * did not type.
 */
export function findTemplateByCode(rawCode: string): CardTemplate | undefined {
  const code = rawCode.trim().toUpperCase();
  if (!code) return undefined;
  return CARD_TEMPLATES.find((tpl) => tpl.code === code);
}

/**
 * Templates matching a free-text query across name and keywords, in both
 * languages at once — a merchant running an Arabic dashboard may still
 * think of their trade in English, and vice versa. An empty query returns
 * everything.
 */
export function searchTemplates(query: string): readonly CardTemplate[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return CARD_TEMPLATES;
  return CARD_TEMPLATES.filter((tpl) =>
    [tpl.labelEn, tpl.labelAr, tpl.keywordsEn, tpl.keywordsAr, tpl.code]
      .join(' ')
      .toLocaleLowerCase()
      .includes(q)
  );
}

/** Templates grouped by category, preserving CARD_TEMPLATES' own order within each group. */
export function groupByCategory(
  templates: readonly CardTemplate[]
): Array<{ category: TemplateCategory; templates: CardTemplate[] }> {
  const order: TemplateCategory[] = ['food', 'beauty', 'fitness', 'services'];
  return order
    .map((category) => ({ category, templates: templates.filter((t) => t.category === category) }))
    .filter((group) => group.templates.length > 0);
}
