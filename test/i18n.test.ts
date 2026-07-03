import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranslator, translateIssueMessage } from '../src/shared/i18n/index';
import { en } from '../src/shared/i18n/en';
import { resolveLocale } from '../src/main/locale';

describe('createTranslator — fallback + interpolation', () => {
  it('falls back to the English value when the Russian key is unfilled', () => {
    const ru = createTranslator('ru');
    // ru.ts is intentionally empty → every key falls back to en.
    expect(ru('tray.quit')).toBe(en['tray.quit']);
    expect(ru('launcher.emptyTitle')).toBe(en['launcher.emptyTitle']);
  });

  it('interpolates {name} placeholders', () => {
    const t = createTranslator('en');
    expect(t('settings.status.available', { version: '1.2.3' })).toBe('Update available: 1.2.3');
    expect(t('launcher.state.installingPausedPercent', { percent: 42 })).toBe(
      'Installing paused on 42%...',
    );
  });

  it('leaves an unmatched brace untouched (no params)', () => {
    const t = createTranslator('en');
    // The manifest {dir} token is literal text, not a param — must survive an unparameterized call.
    expect(t('manifest.installArgsDir')).toContain('{dir}');
  });
});

describe('en dictionary integrity', () => {
  it('has no empty values', () => {
    for (const [key, value] of Object.entries(en)) {
      expect(value.length, `en[${key}] must be non-empty`).toBeGreaterThan(0);
    }
  });
});

describe('plural (tp) via Intl.PluralRules', () => {
  it('interpolates {n} automatically', () => {
    const t = createTranslator('en');
    expect(t.tp('format.minutes', 5)).toBe('5m');
    expect(t.tp('format.hours', 2)).toBe('2h');
  });

  it('falls back through the form chain when a Russian form is unfilled', () => {
    // ru-plural.ts is empty → tp falls back to the English `other` form, never renders empty.
    const ru = createTranslator('ru');
    expect(ru.tp('format.minutes', 3)).toBe('3m');
    expect(ru.tp('format.minutes', 1)).toBe('1m');
  });

  it('the ICU build distinguishes the Russian one/few/many categories', () => {
    // The crux of the plural risk (P1): a minimal ICU could collapse these. When the user fills
    // ru-plural.ts, tp selects the form for exactly this rule.
    const rules = new Intl.PluralRules('ru-RU');
    expect(rules.select(1)).toBe('one');
    expect(rules.select(2)).toBe('few');
    expect(rules.select(5)).toBe('many');
  });
});

describe('resolveLocale', () => {
  it('returns the explicit mode as-is', () => {
    expect(resolveLocale('en', ['ru-RU'])).toBe('en');
    expect(resolveLocale('ru', ['en-US'])).toBe('ru');
  });

  it('resolves system → ru when the first system language starts with ru (case-insensitive)', () => {
    expect(resolveLocale('system', ['ru-RU', 'en-US'])).toBe('ru');
    expect(resolveLocale('system', ['RU'])).toBe('ru');
  });

  it('resolves system → en for a non-ru or empty system language', () => {
    expect(resolveLocale('system', ['en-GB'])).toBe('en');
    expect(resolveLocale('system', ['de-DE'])).toBe('en');
    expect(resolveLocale('system', [])).toBe('en');
  });
});

describe('translateIssueMessage', () => {
  const t = createTranslator('en');

  it('translates a message that is a dictionary key', () => {
    expect(translateIssueMessage('manifest.executableRequired', t)).toBe('executable is required');
  });

  it('passes a non-key (structural zod) message through unchanged', () => {
    const structural = 'Invalid input: expected string, received number';
    expect(translateIssueMessage(structural, t)).toBe(structural);
  });
});

// ── HTML fallback ↔ dictionary scan (review I8) ──────────────────────────────
// Every [data-i18n] element in the HTML must (a) point at a real `en` key and (b) carry an English
// fallback text equal to that key's value — otherwise the two silently diverge. [data-i18n-aria-label]
// keys are only checked for existence (the fallback lives in the aria-label attribute).
describe('HTML data-i18n ↔ en dictionary', () => {
  const HTML_FILES = ['index.html', 'settings.html', 'configure.html'].map((f) =>
    path.resolve(__dirname, '../src/renderer', f),
  );

  /** Collapse whitespace runs and decode the entities we use, so indentation/wrapping don't cause false
   * mismatches. */
  function normalize(text: string): string {
    return text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const isKey = (key: string): key is keyof typeof en => key in en;

  it('every data-i18n key exists in en and its HTML fallback equals the dictionary value', () => {
    for (const file of HTML_FILES) {
      const source = fs.readFileSync(file, 'utf8');
      const name = path.basename(file);
      // data-i18n="key" ...> text < (text is pure — data-i18n is only placed on leaf text elements).
      for (const m of source.matchAll(/data-i18n="([^"]+)"[^>]*>([\s\S]*?)</g)) {
        const key = m[1]!;
        expect(isKey(key), `${name}: data-i18n="${key}" is not an en key`).toBe(true);
        if (isKey(key)) {
          expect(normalize(m[2]!), `${name}: fallback for "${key}" must equal en value`).toBe(
            normalize(en[key]),
          );
        }
      }
    }
  });

  it('every data-i18n-aria-label key exists in en', () => {
    for (const file of HTML_FILES) {
      const source = fs.readFileSync(file, 'utf8');
      const name = path.basename(file);
      for (const m of source.matchAll(/data-i18n-aria-label="([^"]+)"/g)) {
        const key = m[1]!;
        expect(isKey(key), `${name}: data-i18n-aria-label="${key}" is not an en key`).toBe(true);
      }
    }
  });
});
