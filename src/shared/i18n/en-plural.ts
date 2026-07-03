// Plural groups (English) for count-dependent strings. Selected at runtime by Intl.PluralRules (built
// into both Chromium renderers and Node/main — no library). `{n}` is filled automatically by `tp` with
// the count; extra `{name}` tokens may be interpolated too. English only needs one/other; the Russian
// mirror (ru-plural.ts) can add one/few/many. The current English values are the "…h …m" abbreviations —
// just dictionary values, so Russian may use full forms ("1 минута / 2 минуты / 5 минут").
export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { readonly other: string };

export const enPlural = {
  'format.hours': { one: '{n}h', other: '{n}h' },
  'format.minutes': { one: '{n}m', other: '{n}m' },
} as const satisfies Record<string, PluralForms>;

/** Every plural key — the compile-time contract the Russian plural mirror indexes against. */
export type PluralKey = keyof typeof enPlural;
