// Russian plural mirror. INTENTIONALLY EMPTY for now — the user fills it in. Russian has one/few/many/
// other forms; `tp` selects the right one via Intl.PluralRules('ru-RU') and falls back to `other`, then
// to the English forms, for any form left unfilled (see createTranslator).
import type { PluralKey, PluralForms } from './en-plural';

export const ruPlural: Partial<Record<PluralKey, PluralForms>> = {
  // to be filled manually, e.g. 'format.minutes': { one: '{n} минута', few: '{n} минуты', many: '{n} минут', other: '{n} минуты' }
};
