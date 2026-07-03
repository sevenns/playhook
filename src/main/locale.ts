// UI-locale service (main). Resolves the persisted LanguageMode into an effective Locale and owns the
// current translator for the main process. Mirrors the onSummonHotkeyChanged pattern: the mode is passed
// as an ARGUMENT (setMode), never read asynchronously from the store here.
//
// The system locale is read ONCE at construction and on each setMode: a full Windows display-language
// change requires a sign-out, after which the app restarts and picks up the locale afresh — so there is
// nothing to watch live.
import { app } from 'electron';
import { z } from 'zod';
import { log } from './logger';
import { createTranslator, type Locale, type Translator } from '../shared/i18n/index';
import { type LanguageMode } from '../shared/types';

/**
 * Pure resolution of a mode against an ORDERED list of BCP-47-ish candidate tags — extracted from the class
 * so it is unit-testable without electron. An explicit `en`/`ru` short-circuits; `system` scans the
 * candidates and returns the first one that starts with a supported locale (`ru`/`en`). Unmatched → `en`.
 *
 * The scan (rather than "first tag only") matters: on Windows the preferred-languages list can lead with a
 * non-UI language or be empty, so we feed it BOTH `app.getLocale()` and `getPreferredSystemLanguages()` and
 * let the first supported hit win — otherwise a Russian system whose preferred list didn't lead with `ru`
 * fell through to `en`.
 */
export function resolveLocale(mode: LanguageMode, candidates: readonly string[]): Locale {
  if (mode === 'en' || mode === 'ru') return mode;
  for (const tag of candidates) {
    const lower = tag.toLowerCase();
    if (lower.startsWith('ru')) return 'ru';
    if (lower.startsWith('en')) return 'en';
  }
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
    this.locale = this.resolve(initialMode);
    this.t = createTranslator(this.locale);
    applyZodLocale(this.locale);
  }

  // Resolves `mode` against the OS signals. `app.getLocale()` (Chromium's OS-derived UI locale) leads,
  // then the preferred-languages list — so `system` follows the actual display language even when the
  // preferred list leads with another tongue or is empty. Both are logged to make a wrong verdict debuggable.
  private resolve(mode: LanguageMode): Locale {
    const locale = app.getLocale();
    const preferred = app.getPreferredSystemLanguages();
    const resolved = resolveLocale(mode, [locale, ...preferred]);
    log.info(
      `[locale] mode="${mode}" getLocale="${locale}" preferred=${JSON.stringify(preferred)} → "${resolved}"`,
    );
    return resolved;
  }

  /** The current effective locale (what travels over IPC to the renderers). */
  current(): Locale {
    return this.locale;
  }

  /** Re-resolves the mode and rebuilds the translator + zod locale. */
  setMode(mode: LanguageMode): void {
    this.locale = this.resolve(mode);
    this.t = createTranslator(this.locale);
    applyZodLocale(this.locale);
  }
}
