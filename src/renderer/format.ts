// Pure display formatters for the game info panel and the notification list (split out of app.ts). The
// translator and locale are passed in (kept pure): plural units go through `tp`, dates through
// toLocaleString.
import type { AppNotification } from '../shared/types';
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
  return date.toLocaleString(intlLocale(locale));
}

function intlLocale(locale: Locale): string {
  return locale === 'ru' ? 'ru-RU' : 'en-GB';
}

/**
 * What one notification SAYS. Built here rather than stored with the notification, because the UI
 * language changes live and a stored string would be frozen at the language of the moment it was
 * written. The switch is exhaustive over the union, so a new kind fails the typecheck rather than
 * rendering as nothing.
 */
export function formatNotification(item: AppNotification, t: Translator): string {
  switch (item.kind) {
    case 'update-ready':
      return t('notifications.updateReady', { version: item.version });
    case 'game-installed':
      return t('notifications.gameInstalled', { title: item.gameTitle });
    case 'game-uninstalled':
      return t('notifications.gameUninstalled', { title: item.gameTitle });
  }
}

/**
 * WHEN a notification arrived, as the list shows it: the time alone for today, a named "yesterday" for
 * the day before, and a plain date for anything older. `now` is a parameter rather than Date.now() so
 * the rule is testable — and "today" means the same CALENDAR day, not "less than 24 hours ago", which
 * is what a reader means by it.
 *
 * formatDate above is no substitute: it takes an ISO string (this carries epoch ms) and always prints
 * the full date and time, which is far too much beside a one-line notification.
 */
export function formatNotificationTime(
  at: number,
  now: number,
  t: Translator,
  locale: Locale,
): string {
  const loc = intlLocale(locale);
  const date = new Date(at);
  const time = date.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
  const days = calendarDaysBetween(date, new Date(now));
  if (days === 0) return time;
  if (days === 1) return t('notifications.yesterday', { time });
  return date.toLocaleDateString(loc);
}

/** Whole calendar days from `then` to `now`, in LOCAL time (both are normalized to local midnight). */
function calendarDaysBetween(then: Date, now: Date): number {
  const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000);
}
