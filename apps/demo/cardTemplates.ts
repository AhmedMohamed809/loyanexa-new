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
  /**
   * Filename stem in apps/demo/assets/templates/, resolved to a stored image
   * hash by templateAssets.ts. Undefined means "no photography" — the card
   * still works, it just shows the flat colour, which is what every template
   * did before the photographs existed.
   */
  photo?: string;
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
    keywordsAr: 'قهوة اسبريسو مشروبات لاتيه',
    photo: 'cafe-1',
  },
  {
    id: 'cafe-beans',
    code: 'TMP-CAFE02',
    category: 'food',
    labelEn: 'Coffee roaster',
    labelAr: 'محمصة قهوة',
    rewardEn: 'A free bag of beans',
    rewardAr: 'كيس بن مجاني',
    stampsGoal: 6,
    bgColor: '#241A14',
    stampActive: '#C98B4B',
    stampInactive: '#5E4C40',
    builtinIcon: 'coffee',
    keywordsEn: 'beans roastery espresso speciality',
    keywordsAr: 'بن محمصة اسبريسو مختصة',
    photo: 'cafe-2',
  },
  {
    id: 'cafe-cold',
    code: 'TMP-CAFE03',
    category: 'food',
    labelEn: 'Juice and cold drinks',
    labelAr: 'عصائر ومشروبات باردة',
    rewardEn: 'A free cold drink',
    rewardAr: 'مشروب بارد مجاني',
    stampsGoal: 7,
    bgColor: '#12242B',
    stampActive: '#5FD3E8',
    stampInactive: '#3B565E',
    builtinIcon: 'coffee',
    keywordsEn: 'juice smoothie iced cold',
    keywordsAr: 'عصير سموذي مثلج بارد',
    photo: 'cafe-3',
  },
  {
    id: 'bakery',
    code: 'TMP-BAKE01',
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
    photo: 'bakery-3',
  },
  {
    id: 'bakery-bread',
    code: 'TMP-BAKE02',
    category: 'food',
    labelEn: 'Artisan bread',
    labelAr: 'مخبز حرفي',
    rewardEn: 'A free loaf',
    rewardAr: 'رغيف مجاني',
    stampsGoal: 8,
    bgColor: '#2A1F16',
    stampActive: '#D8A657',
    stampInactive: '#615349',
    builtinIcon: 'croissant',
    keywordsEn: 'sourdough loaf bakery artisan',
    keywordsAr: 'خبز عجين مخبز حرفي',
    photo: 'bakery-1',
  },
  {
    id: 'bakery-cakes',
    code: 'TMP-BAKE03',
    category: 'food',
    labelEn: 'Cake shop',
    labelAr: 'محل كيك',
    rewardEn: 'A free slice of cake',
    rewardAr: 'قطعة كيك مجانية',
    stampsGoal: 5,
    bgColor: '#2B1B2A',
    stampActive: '#F49AC2',
    stampInactive: '#6B4A68',
    builtinIcon: 'gift',
    keywordsEn: 'cake cupcake celebration sweets',
    keywordsAr: 'كيك كب كيك حلويات مناسبات',
    photo: 'bakery-2',
  },
  {
    id: 'restaurant',
    code: 'TMP-REST01',
    category: 'food',
    labelEn: 'Restaurant',
    labelAr: 'مطعم',
    rewardEn: 'A free dessert',
    rewardAr: 'حلوى مجانية',
    stampsGoal: 10,
    bgColor: '#14261F',
    stampActive: '#7FD1A3',
    stampInactive: '#4A5C53',
    builtinIcon: 'cutlery',
    keywordsEn: 'food dining meal lunch dinner',
    keywordsAr: 'طعام مطاعم غداء عشاء',
    photo: 'restaurant-1',
  },
  {
    id: 'restaurant-fine',
    code: 'TMP-REST02',
    category: 'food',
    labelEn: 'Fine dining',
    labelAr: 'مطعم فاخر',
    rewardEn: 'A free starter',
    rewardAr: 'مقبّلات مجانية',
    stampsGoal: 8,
    bgColor: '#1C1A2E',
    stampActive: '#C0A9F0',
    stampInactive: '#4E4869',
    builtinIcon: 'cutlery',
    keywordsEn: 'fine dining chef tasting',
    keywordsAr: 'مطعم فاخر شيف تذوق',
    photo: 'restaurant-2',
  },
  {
    id: 'restaurant-casual',
    code: 'TMP-REST03',
    category: 'food',
    labelEn: 'Casual eatery',
    labelAr: 'مطعم سريع',
    rewardEn: 'A free side dish',
    rewardAr: 'طبق جانبي مجاني',
    stampsGoal: 9,
    bgColor: '#2B2118',
    stampActive: '#E8A85C',
    stampInactive: '#63564A',
    builtinIcon: 'cutlery',
    keywordsEn: 'casual grill burger takeaway',
    keywordsAr: 'مطعم سريع مشويات برجر',
    photo: 'restaurant-3',
  },
  {
    id: 'barber',
    code: 'TMP-BARB01',
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
    photo: 'barber-2',
  },
  {
    id: 'barber-shave',
    code: 'TMP-BARB02',
    category: 'beauty',
    labelEn: 'Barber and shave',
    labelAr: 'حلاقة وذقن',
    rewardEn: 'A free hot shave',
    rewardAr: 'حلاقة ذقن مجانية',
    stampsGoal: 5,
    bgColor: '#1A1614',
    stampActive: '#D9B382',
    stampInactive: '#544B44',
    builtinIcon: 'scissors',
    keywordsEn: 'shave beard razor grooming',
    keywordsAr: 'حلاقة ذقن شفرة عناية',
    photo: 'barber-1',
  },
  {
    id: 'barber-kids',
    code: 'TMP-BARB03',
    category: 'beauty',
    labelEn: 'Kids’ cuts',
    labelAr: 'قصات الأطفال',
    rewardEn: 'A free kids’ cut',
    rewardAr: 'قصة أطفال مجانية',
    stampsGoal: 6,
    bgColor: '#15202B',
    stampActive: '#6FD3B8',
    stampInactive: '#3F5561',
    builtinIcon: 'scissors',
    keywordsEn: 'kids children family haircut',
    keywordsAr: 'أطفال عائلة قص شعر',
    photo: 'barber-3',
  },
  {
    id: 'salon',
    code: 'TMP-SALN01',
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
    photo: 'salon-3',
  },
  {
    id: 'salon-hair',
    code: 'TMP-SALN02',
    category: 'beauty',
    labelEn: 'Hair studio',
    labelAr: 'استوديو شعر',
    rewardEn: 'A free blow-dry',
    rewardAr: 'تصفيف شعر مجاني',
    stampsGoal: 6,
    bgColor: '#1F1A24',
    stampActive: '#E0B0FF',
    stampInactive: '#544A5E',
    builtinIcon: 'flower',
    keywordsEn: 'hair colour styling blow-dry',
    keywordsAr: 'شعر صبغة تصفيف',
    photo: 'salon-2',
  },
  {
    id: 'salon-spa',
    code: 'TMP-SALN03',
    category: 'beauty',
    labelEn: 'Spa',
    labelAr: 'سبا',
    rewardEn: 'A free treatment',
    rewardAr: 'جلسة مجانية',
    stampsGoal: 5,
    bgColor: '#12211F',
    stampActive: '#8FD9C4',
    stampInactive: '#3E534E',
    builtinIcon: 'bottle',
    keywordsEn: 'spa massage facial treatment',
    keywordsAr: 'سبا تدليك بشرة جلسة',
    photo: 'salon-1',
  },
  {
    id: 'gym',
    code: 'TMP-GYM01',
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
    photo: 'gym-1',
  },
  {
    id: 'gym-classes',
    code: 'TMP-GYM02',
    category: 'fitness',
    labelEn: 'Fitness classes',
    labelAr: 'حصص لياقة',
    rewardEn: 'A free class',
    rewardAr: 'حصة مجانية',
    stampsGoal: 8,
    bgColor: '#1B2430',
    stampActive: '#7FD1A3',
    stampInactive: '#48545F',
    builtinIcon: 'kettlebell',
    keywordsEn: 'class yoga pilates group',
    keywordsAr: 'حصة يوغا بيلاتس جماعية',
    photo: 'gym-2',
  },
  {
    id: 'gym-personal',
    code: 'TMP-GYM03',
    category: 'fitness',
    labelEn: 'Personal training',
    labelAr: 'تدريب شخصي',
    rewardEn: 'A free PT session',
    rewardAr: 'جلسة تدريب شخصي مجانية',
    stampsGoal: 6,
    bgColor: '#1A1A1A',
    stampActive: '#F2C14E',
    stampInactive: '#525252',
    builtinIcon: 'kettlebell',
    keywordsEn: 'personal trainer coaching strength',
    keywordsAr: 'مدرب شخصي قوة تدريب',
    photo: 'gym-3',
  },
  {
    id: 'carwash',
    code: 'TMP-WASH01',
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
    photo: 'carwash-1',
  },
  {
    id: 'carwash-detail',
    code: 'TMP-WASH02',
    category: 'services',
    labelEn: 'Car detailing',
    labelAr: 'تلميع سيارات',
    rewardEn: 'A free interior clean',
    rewardAr: 'تنظيف داخلي مجاني',
    stampsGoal: 6,
    bgColor: '#141A21',
    stampActive: '#9AD0F5',
    stampInactive: '#454F59',
    builtinIcon: 'car',
    keywordsEn: 'detailing polish interior valet',
    keywordsAr: 'تلميع تنظيف داخلي',
    photo: 'carwash-3',
  },
  {
    id: 'carwash-express',
    code: 'TMP-WASH03',
    category: 'services',
    labelEn: 'Express wash',
    labelAr: 'غسيل سريع',
    rewardEn: 'A free express wash',
    rewardAr: 'غسلة سريعة مجانية',
    stampsGoal: 8,
    bgColor: '#16232B',
    stampActive: '#6FE3C4',
    stampInactive: '#3C5159',
    builtinIcon: 'car',
    keywordsEn: 'express quick drive-through wash',
    keywordsAr: 'سريع غسيل مرور',
    photo: 'carwash-2',
  },
  {
    id: 'retail',
    code: 'TMP-SHOP01',
    category: 'services',
    labelEn: 'Shop',
    labelAr: 'متجر',
    rewardEn: 'A free gift',
    rewardAr: 'هدية مجانية',
    stampsGoal: 8,
    bgColor: '#1B1533',
    stampActive: '#B79CFF',
    stampInactive: '#4F4770',
    builtinIcon: 'basket',
    keywordsEn: 'store retail boutique shopping',
    keywordsAr: 'متجر تسوق بوتيك',
    photo: 'shop-1',
  },
  {
    id: 'retail-fashion',
    code: 'TMP-SHOP02',
    category: 'services',
    labelEn: 'Fashion boutique',
    labelAr: 'بوتيك أزياء',
    rewardEn: '15% off your next purchase',
    rewardAr: 'خصم ١٥٪ على مشترياتك القادمة',
    stampsGoal: 6,
    bgColor: '#241B2E',
    stampActive: '#E8A8D8',
    stampInactive: '#584C63',
    builtinIcon: 'hanger',
    keywordsEn: 'fashion clothing boutique style',
    keywordsAr: 'أزياء ملابس بوتيك',
    photo: 'shop-2',
  },
  {
    id: 'retail-shoes',
    code: 'TMP-SHOP03',
    category: 'services',
    labelEn: 'Shoe shop',
    labelAr: 'متجر أحذية',
    rewardEn: 'A free pair of socks',
    rewardAr: 'جوارب مجانية',
    stampsGoal: 10,
    bgColor: '#1D2430',
    stampActive: '#D6C39B',
    stampInactive: '#4A525E',
    builtinIcon: 'shoe',
    keywordsEn: 'shoes footwear trainers store',
    keywordsAr: 'أحذية جزم متجر',
    photo: 'shop-3',
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
