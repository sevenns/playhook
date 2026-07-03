// Russian plural mirror. Russian has one/few/many/other; `tp` picks the form via Intl.PluralRules('ru-RU')
// (1 → one, 2–4 → few, 5–20 / 0 → many, fractions → other) and interpolates {n}. Full word forms are used
// here (the English source keeps compact "{n}h"/"{n}m" abbreviations) — so playtime reads "2 часа 15 минут".
import type { PluralKey, PluralForms } from './en-plural';

export const ruPlural: Partial<Record<PluralKey, PluralForms>> = {
  'format.hours': { one: '{n} час', few: '{n} часа', many: '{n} часов', other: '{n} часа' },
  'format.minutes': { one: '{n} минута', few: '{n} минуты', many: '{n} минут', other: '{n} минуты' },
};
