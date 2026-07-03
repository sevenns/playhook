// UI-locale service (main). Resolves the persisted LanguageMode into an effective Locale and owns the
// current translator for the main process. Mirrors the onSummonHotkeyChanged pattern: the mode is passed
// as an ARGUMENT (setMode), never read asynchronously from the store here.
//
// The system locale is read ONCE at construction and on each setMode: a full Windows display-language
// change requires a sign-out, after which the app restarts and picks up the locale afresh — so there is
// nothing to watch live.
import { app } from 'electron';
import { z } from 'zod';
import { createTranslator, type Locale, type Translator } from '../shared/i18n/index';
import { type LanguageMode } from '../shared/types';

/**
 * Pure resolution of a mode against the system languages — extracted from the class so it is unit-testable
 * without electron. `system` → the first system language starting with `ru` maps to `'ru'`, else `'en'`.
 */
export function resolveLocale(mode: LanguageMode, systemLanguages: readonly string[]): Locale {
  if (mode === 'en' || mode === 'ru') return mode;
  const first = systemLanguages[0];
  if (first !== undefined && first.toLowerCase().startsWith('ru')) return 'ru';
  return 'en';
}

// zod 4 ships built-in message locales; switch them globally so structural manifest errors (Configure
// window / error popup) come out in the active language. The config is process-global (it also affects the
// internal settings.json / stats.json schemas, harmlessly — their errors are not user-facing).
function applyZodLocale(locale: Locale): void {
  z.config(locale === 'ru' ? z.locales.ru() : z.locales.en());
}

export class LocaleService {
  private locale: Locale;
  /** The translator for the current locale — reassigned on every setMode (read live by consumers). */
  t: Translator;

  constructor(initialMode: LanguageMode) {
    this.locale = resolveLocale(initialMode, app.getPreferredSystemLanguages());
    this.t = createTranslator(this.locale);
    applyZodLocale(this.locale);
  }

  /** The current effective locale (what travels over IPC to the renderers). */
  current(): Locale {
    return this.locale;
  }

  /** Re-resolves the mode and rebuilds the translator + zod locale. */
  setMode(mode: LanguageMode): void {
    this.locale = resolveLocale(mode, app.getPreferredSystemLanguages());
    this.t = createTranslator(this.locale);
    applyZodLocale(this.locale);
  }
}
