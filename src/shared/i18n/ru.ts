// Russian dictionary. INTENTIONALLY EMPTY for now — the user fills it in gradually. The `Partial` type
// gives a compile-time guarantee that every key here is a real MessageKey (a typo fails tsc), while
// leaving any key absent, so the translator falls back to the English value (see createTranslator).
import type { MessageKey } from './en';

export const ru: Partial<Record<MessageKey, string>> = {
  // to be filled manually
};
