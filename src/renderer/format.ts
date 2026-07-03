// Pure display formatters for the game info panel (split out of app.ts). The translator and
// locale are passed in (kept pure): plural units go through `tp`, dates through toLocaleString.
import type { Locale, Translator } from '../shared/i18n/index.js';

export function formatPlaytime(totalSeconds: number, t: Translator): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${t.tp('format.hours', hours)} ${t.tp('format.minutes', minutes)}`;
  if (minutes > 0) return t.tp('format.minutes', minutes);
  return t('format.lessThanMinute');
}

export function formatDate(iso: string | null, t: Translator, locale: Locale): string {
  if (iso === null) return t('format.never');
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return t('format.unknown');
  return date.toLocaleString(locale === 'ru' ? 'ru-RU' : 'en-GB');
}
