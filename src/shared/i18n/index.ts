// Typed translator for the two supported locales. No library (i18next etc.) — for 2 locales and ~180
// strings a typed module is enough. Pure functions, no state: createTranslator(locale) returns a
// callable `t(key, params)` with an attached `t.tp(key, n, params)` for plural forms.
import { en, type MessageKey } from './en';
import { ru } from './ru';
import { enPlural, type PluralKey, type PluralForms } from './en-plural';
import { ruPlural } from './ru-plural';

export type { MessageKey } from './en';
export type { PluralKey } from './en-plural';

/** The supported UI locales. The architecture is extensible: add a dictionary + a literal here. */
export type Locale = 'en' | 'ru';

// Parameters are deliberately not typed per key: the cost of a wrong placeholder name is low and the
// tests cover the actual call sites, so the extra type machinery isn't worth it.
/** Interpolation params for a message. */
export type TranslateParams = Readonly<Record<string, string | number>>;

/** A callable translator: `t(key, params)` for a plain message, `t.tp(key, n, params)` for a plural. */
export interface Translator {
  (key: MessageKey, params?: TranslateParams): string;
  tp(key: PluralKey, n: number, params?: TranslateParams): string;
}

/** Replaces `{name}` tokens with their param value; leaves an unmatched brace untouched. */
function interpolate(template: string, params?: TranslateParams): string {
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (whole: string, name: string): string => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

export function createTranslator(locale: Locale): Translator {
  const rules = new Intl.PluralRules(locale === 'ru' ? 'ru-RU' : 'en');

  const t = ((key: MessageKey, params?: TranslateParams): string => {
    // `noUncheckedIndexedAccess`: ru[key] is `string | undefined` (Partial) → fall back to en[key].
    const template = (locale === 'ru' ? ru[key] : undefined) ?? en[key];
    return interpolate(template, params);
  }) as Translator;

  t.tp = (key: PluralKey, n: number, params?: TranslateParams): string => {
    const rule = rules.select(n);
    const enForms: PluralForms = enPlural[key];
    const ruForms = locale === 'ru' ? ruPlural[key] : undefined;
    // Prefer the localized form for the selected rule, then the localized `other`, then the English
    // form, then the English `other` — so an unfilled Russian form never renders empty.
    const template = ruForms?.[rule] ?? ruForms?.other ?? enForms[rule] ?? enForms.other;
    return interpolate(template, { n, ...params });
  };

  return t;
}

/**
 * Translates a validation-issue message that MAY be a dictionary key. Manifest schema refines store a
 * MessageKey in their `message`; this maps it to the localized text. A structural zod message (not a key
 * of `en`) passes through unchanged — it is already localized globally via z.config(z.locales.*).
 */
export function translateIssueMessage(message: string, t: Translator): string {
  return message in en ? t(message as MessageKey) : message;
}
