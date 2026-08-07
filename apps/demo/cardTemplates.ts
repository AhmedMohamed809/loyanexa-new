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

export type TemplateCategory =
  | 'fashion'
  | 'grocery'
  | 'fitness'
  | 'education'
  | 'automotive'
  | 'pets'
  | 'services';

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
    id: 'tailor',
    code: 'TMP-TAIL01',
    category: 'fashion',
    labelEn: 'Tailor',
    labelAr: 'الخياط',
    rewardEn: 'A free alteration',
    rewardAr: 'تعديل مجاني',
    stampsGoal: 6,
    bgColor: '#2A2320',
    stampActive: '#D9B382',
    stampInactive: '#5C524C',
    builtinIcon: 'needle',
    keywordsEn: 'tailor alterations sewing clothes',
    keywordsAr: 'خياط تعديل خياطة ملابس',
    photo: 'tailor',
  },
  {
    id: 'shoerepair',
    code: 'TMP-COBB02',
    category: 'fashion',
    labelEn: 'Shoe repair',
    labelAr: 'إصلاح الأحذية',
    rewardEn: 'A free polish',
    rewardAr: 'تلميع مجاني',
    stampsGoal: 5,
    bgColor: '#3A2A22',
    stampActive: '#E0B080',
    stampInactive: '#6B5A50',
    builtinIcon: 'shoe',
    keywordsEn: 'cobbler repair polish leather',
    keywordsAr: 'إصلاح أحذية تلميع جلد',
    photo: 'shoerepair',
  },
  {
    id: 'shoestore',
    code: 'TMP-SHOE03',
    category: 'fashion',
    labelEn: 'Shoe shop',
    labelAr: 'متجر الأحذية',
    rewardEn: 'A free pair of socks',
    rewardAr: 'جوارب مجانية',
    stampsGoal: 10,
    bgColor: '#5A5A5A',
    stampActive: '#F26D6D',
    stampInactive: '#8A8A8A',
    builtinIcon: 'shoe',
    keywordsEn: 'shoes trainers sneakers footwear',
    keywordsAr: 'أحذية رياضية جزم',
    photo: 'shoestore',
  },
  {
    id: 'clothing',
    code: 'TMP-CLTH04',
    category: 'fashion',
    labelEn: 'Clothes shop',
    labelAr: 'متجر الملابس',
    rewardEn: '15% off your next purchase',
    rewardAr: 'خصم ١٥٪ على مشترياتك القادمة',
    stampsGoal: 6,
    bgColor: '#1A1A1A',
    stampActive: '#E85D5D',
    stampInactive: '#5A5A5A',
    builtinIcon: 'hanger',
    keywordsEn: 'fashion clothing boutique style',
    keywordsAr: 'أزياء ملابس بوتيك',
    photo: 'clothing',
  },
  {
    id: 'giftshop',
    code: 'TMP-GIFT05',
    category: 'fashion',
    labelEn: 'Gift shop',
    labelAr: 'محل الهدايا',
    rewardEn: 'A free gift wrap',
    rewardAr: 'تغليف هدية مجاني',
    stampsGoal: 8,
    bgColor: '#2B1520',
    stampActive: '#F49AC2',
    stampInactive: '#6B4A5A',
    builtinIcon: 'gift',
    keywordsEn: 'gift present wrapping cards',
    keywordsAr: 'هدايا تغليف بطاقات',
    photo: 'giftshop',
  },
  {
    id: 'phoneacc',
    code: 'TMP-PHON06',
    category: 'fashion',
    labelEn: 'Phone accessories',
    labelAr: 'اكسسوارات الجوال',
    rewardEn: 'A free screen protector',
    rewardAr: 'واقي شاشة مجاني',
    stampsGoal: 6,
    bgColor: '#14202B',
    stampActive: '#5FD3E8',
    stampInactive: '#3E525E',
    builtinIcon: 'phone',
    keywordsEn: 'phone case charger accessories',
    keywordsAr: 'جوال حافظة شاحن اكسسوارات',
    photo: 'phoneacc',
  },
  {
    id: 'supermarket',
    code: 'TMP-MART07',
    category: 'grocery',
    labelEn: 'Supermarket',
    labelAr: 'السوبرماركت',
    rewardEn: 'A free basket of essentials',
    rewardAr: 'سلة أساسيات مجانية',
    stampsGoal: 10,
    bgColor: '#EFEAE0',
    stampActive: '#3F8F5F',
    stampInactive: '#B9B1A4',
    builtinIcon: 'basket',
    keywordsEn: 'grocery market supermarket food',
    keywordsAr: 'بقالة سوبرماركت تسوق',
    photo: 'supermarket',
  },
  {
    id: 'fishmonger',
    code: 'TMP-FISH08',
    category: 'grocery',
    labelEn: 'Fishmonger',
    labelAr: 'بائع السمك',
    rewardEn: 'A free fillet',
    rewardAr: 'قطعة سمك مجانية',
    stampsGoal: 6,
    bgColor: '#41576B',
    stampActive: '#8FC7E8',
    stampInactive: '#66798C',
    builtinIcon: 'fish',
    keywordsEn: 'fish seafood fresh market',
    keywordsAr: 'سمك مأكولات بحرية طازج',
    photo: 'fishmonger',
  },
  {
    id: 'butcher',
    code: 'TMP-MEAT09',
    category: 'grocery',
    labelEn: 'Butcher',
    labelAr: 'الجزار',
    rewardEn: 'A free cut',
    rewardAr: 'قطعة لحم مجانية',
    stampsGoal: 8,
    bgColor: '#2B1614',
    stampActive: '#E0A060',
    stampInactive: '#5E4640',
    builtinIcon: 'cleaver',
    keywordsEn: 'butcher meat steak grill',
    keywordsAr: 'جزار لحوم ستيك مشويات',
    photo: 'butcher',
  },
  {
    id: 'gymclub',
    code: 'TMP-GYM010',
    category: 'fitness',
    labelEn: 'Gym',
    labelAr: 'النادي الرياضي',
    rewardEn: 'A free session',
    rewardAr: 'حصة مجانية',
    stampsGoal: 10,
    bgColor: '#1A1A1A',
    stampActive: '#E8B54A',
    stampInactive: '#525252',
    builtinIcon: 'dumbbell',
    keywordsEn: 'gym fitness weights training',
    keywordsAr: 'نادي رياضي لياقة أوزان',
    photo: 'gymclub',
  },
  {
    id: 'fitstudio',
    code: 'TMP-STUD11',
    category: 'fitness',
    labelEn: 'Fitness studio',
    labelAr: 'استوديو اللياقة',
    rewardEn: 'A free class',
    rewardAr: 'حصة مجانية',
    stampsGoal: 8,
    bgColor: '#211B2E',
    stampActive: '#B79CFF',
    stampInactive: '#4E4663',
    builtinIcon: 'kettlebell',
    keywordsEn: 'studio class yoga pilates',
    keywordsAr: 'استوديو حصة يوغا بيلاتس',
    photo: 'fitstudio',
  },
  {
    id: 'crossfit',
    code: 'TMP-XFIT12',
    category: 'fitness',
    labelEn: 'CrossFit',
    labelAr: 'كروس فت',
    rewardEn: 'A free drop-in',
    rewardAr: 'حصة تجريبية مجانية',
    stampsGoal: 8,
    bgColor: '#A8AAB4',
    stampActive: '#2B2B2B',
    stampInactive: '#7C7E88',
    builtinIcon: 'glove',
    keywordsEn: 'crossfit wod strength conditioning',
    keywordsAr: 'كروس فت قوة تحمل',
    photo: 'crossfit',
  },
  {
    id: 'personaltrain',
    code: 'TMP-PERS13',
    category: 'fitness',
    labelEn: 'Personal training',
    labelAr: 'التدريب الشخصي',
    rewardEn: 'A free PT session',
    rewardAr: 'جلسة تدريب مجانية',
    stampsGoal: 6,
    bgColor: '#A8AAB4',
    stampActive: '#E8632B',
    stampInactive: '#7C7E88',
    builtinIcon: 'dumbbell',
    keywordsEn: 'personal trainer coaching one-to-one',
    keywordsAr: 'مدرب شخصي تدريب',
    photo: 'personaltrain',
  },
  {
    id: 'martialarts',
    code: 'TMP-MART14',
    category: 'fitness',
    labelEn: 'Martial arts',
    labelAr: 'الفنون القتالية',
    rewardEn: 'A free grading',
    rewardAr: 'اختبار حزام مجاني',
    stampsGoal: 10,
    bgColor: '#1A1A1A',
    stampActive: '#E8503C',
    stampInactive: '#525252',
    builtinIcon: 'gi',
    keywordsEn: 'martial arts karate judo bjj',
    keywordsAr: 'فنون قتالية كاراتيه جودو',
    photo: 'martialarts',
  },
  {
    id: 'dental',
    code: 'TMP-DENT15',
    category: 'education',
    labelEn: 'Dental clinic',
    labelAr: 'عيادة الأسنان',
    rewardEn: 'A free check-up',
    rewardAr: 'فحص مجاني',
    stampsGoal: 5,
    bgColor: '#E8E8E8',
    stampActive: '#2E5F8A',
    stampInactive: '#B0B0B0',
    builtinIcon: 'tooth',
    keywordsEn: 'dentist dental clinic hygiene',
    keywordsAr: 'أسنان عيادة تنظيف',
    photo: 'dental',
  },
  {
    id: 'nursery',
    code: 'TMP-NURS16',
    category: 'education',
    labelEn: 'Nursery',
    labelAr: 'الحضانة',
    rewardEn: 'A free session',
    rewardAr: 'حصة مجانية',
    stampsGoal: 8,
    bgColor: '#33475E',
    stampActive: '#F49AC2',
    stampInactive: '#5B6B7E',
    builtinIcon: 'baby',
    keywordsEn: 'nursery kids childcare play',
    keywordsAr: 'حضانة أطفال رعاية لعب',
    photo: 'nursery',
  },
  {
    id: 'musicschool',
    code: 'TMP-MUSC17',
    category: 'education',
    labelEn: 'Arts and music school',
    labelAr: 'مدرسة الفنون والموسيقى',
    rewardEn: 'A free lesson',
    rewardAr: 'درس مجاني',
    stampsGoal: 6,
    bgColor: '#E4DCCB',
    stampActive: '#8A6A3A',
    stampInactive: '#B5AC9B',
    builtinIcon: 'musicNote',
    keywordsEn: 'music arts lessons school',
    keywordsAr: 'موسيقى فنون دروس مدرسة',
    photo: 'musicschool',
  },
  {
    id: 'tyres',
    code: 'TMP-TYRE18',
    category: 'automotive',
    labelEn: 'Tyres and oil',
    labelAr: 'الإطارات والزيوت',
    rewardEn: 'A free oil change',
    rewardAr: 'تغيير زيت مجاني',
    stampsGoal: 5,
    bgColor: '#161E33',
    stampActive: '#E8503C',
    stampInactive: '#454E66',
    builtinIcon: 'tyre',
    keywordsEn: 'tyres oil garage service',
    keywordsAr: 'إطارات زيوت ورشة صيانة',
    photo: 'tyres',
  },
  {
    id: 'carpolish',
    code: 'TMP-POLI19',
    category: 'automotive',
    labelEn: 'Car detailing',
    labelAr: 'تلميع السيارات',
    rewardEn: 'A free interior clean',
    rewardAr: 'تنظيف داخلي مجاني',
    stampsGoal: 6,
    bgColor: '#1A1F1A',
    stampActive: '#E8E04A',
    stampInactive: '#4E534E',
    builtinIcon: 'car',
    keywordsEn: 'detailing polish wash valet',
    keywordsAr: 'تلميع غسيل تنظيف',
    photo: 'carpolish',
  },
  {
    id: 'vet',
    code: 'TMP-VETC20',
    category: 'pets',
    labelEn: 'Vet clinic',
    labelAr: 'العيادة البيطرية',
    rewardEn: 'A free check-up',
    rewardAr: 'فحص مجاني',
    stampsGoal: 5,
    bgColor: '#1F3D30',
    stampActive: '#7FD1A3',
    stampInactive: '#4A6357',
    builtinIcon: 'paw',
    keywordsEn: 'vet veterinary clinic pets animals',
    keywordsAr: 'بيطري عيادة حيوانات',
    photo: 'vet',
  },
  {
    id: 'petgroom',
    code: 'TMP-GROO21',
    category: 'pets',
    labelEn: 'Pet grooming',
    labelAr: 'العناية بالحيوانات',
    rewardEn: 'A free nail trim',
    rewardAr: 'تقليم أظافر مجاني',
    stampsGoal: 6,
    bgColor: '#332B6B',
    stampActive: '#A8B6FF',
    stampInactive: '#5C5590',
    builtinIcon: 'bottle',
    keywordsEn: 'grooming wash pets dog cat',
    keywordsAr: 'عناية استحمام كلاب قطط',
    photo: 'petgroom',
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
  const order: TemplateCategory[] = ['fashion', 'grocery', 'fitness', 'education', 'automotive', 'pets', 'services'];
  return order
    .map((category) => ({ category, templates: templates.filter((t) => t.category === category) }))
    .filter((group) => group.templates.length > 0);
}
