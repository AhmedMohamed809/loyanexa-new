import { en } from './en.ts';
import { ar } from './ar.ts';

export type Lang = 'ar' | 'en';
export type MessageKey = keyof typeof en;

export { en, ar };

const DICTIONARIES: Record<Lang, Record<MessageKey, string>> = { en, ar };
const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';

/** Translate, interpolating `{name}` placeholders. */
export function t(
  lang: Lang,
  key: MessageKey,
  vars?: Record<string, string | number>
): string {
  const template = DICTIONARIES[lang][key];
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = vars?.[name];
    if (value === undefined) throw new Error(`missing variable: ${name} for message ${key}`);
    return String(value);
  });
}

/** Arabic-Indic numerals under `ar`, Western digits otherwise (BUILD.md §13). */
export function arabicDigits(value: string | number, lang: Lang): string {
  const s = String(value);
  if (lang !== 'ar') return s;
  return s.replace(/\d/g, (d) => ARABIC_INDIC[Number(d)]!);
}
