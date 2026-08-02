import type { en } from './en.ts';

/**
 * Typed against the English keys, so omitting one fails `tsc` rather than
 * rendering as a blank element (BUILD.md §13).
 */
export const ar: Record<keyof typeof en, string> = {
  stampTooSoon: 'تم ختم هذه البطاقة اليوم بالفعل. حاول مرة أخرى غدًا.',
  stampsRemaining: 'متبقٍ {count} ختم',
  rewardEarned: 'تم الحصول على المكافأة',
  cardNotFound: 'تعذر العثور على هذه البطاقة.',
  cardExpired: 'انتهت صلاحية هذه البطاقة.',
  serverError: 'حدث خطأ ما. يرجى المحاولة مرة أخرى.',
  stampSuccess: 'تم الختم — {stamps}/{goal}',
  passNotFound: 'تعذر العثور على بطاقة بهذا الرمز.',
  stampInputRequired: 'أدخل الرقم التسلسلي أو الرمز المختصر.',
};
