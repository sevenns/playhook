// Static-text localization for the renderers. HTML carries the English text as a `data-i18n` fallback
// (so there is no blank flash before the invoke-seed lands); localizeDocument overwrites it with the
// translated value. `data-i18n-aria-label` does the same for the aria-label attribute. Called after the
// language seed and on every language push. No innerHTML — only textContent / setAttribute.
import type { MessageKey, Translator } from '../shared/i18n/index.js';

export function localizeDocument(t: Translator): void {
  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = el.dataset['i18n'];
    if (key !== undefined) el.textContent = t(key as MessageKey);
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n-aria-label]')) {
    const key = el.dataset['i18nAriaLabel'];
    if (key !== undefined) el.setAttribute('aria-label', t(key as MessageKey));
  }
}
