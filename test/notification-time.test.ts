// The notification list's own text: what a notification says (assembled from the kind, never stored)
// and when it arrived (today = the time alone, the day before = "yesterday", older = a date).
import { describe, expect, it } from 'vitest';
import { createTranslator } from '../src/shared/i18n/index';
import { formatNotification, formatNotificationTime } from '../src/renderer/format';
import type { AppNotification } from '../src/shared/types';

const en = createTranslator('en');
const ru = createTranslator('ru');

/** Local time, so the "same calendar day" rule is exercised in the zone the launcher actually runs in. */
function at(year: number, month: number, day: number, hour: number, minute: number): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

describe('formatNotification — the text is built, not stored', () => {
  it('names the game for an install and an uninstall', () => {
    const installed: AppNotification = {
      id: 'a',
      at: 0,
      read: false,
      kind: 'game-installed',
      gameId: 'hades',
      gameTitle: 'Hades',
    };
    expect(formatNotification(installed, en)).toContain('Hades');
    expect(formatNotification({ ...installed, kind: 'game-uninstalled' }, en)).toContain('Hades');
    // The two must not read the same — "installed" and "removed" is the whole information.
    expect(formatNotification(installed, en)).not.toBe(
      formatNotification({ ...installed, kind: 'game-uninstalled' }, en),
    );
  });

  it('carries the version of a ready update', () => {
    const update: AppNotification = { id: 'b', at: 0, read: false, kind: 'update-ready', version: '0.9.1' };
    expect(formatNotification(update, en)).toContain('0.9.1');
  });

  it('follows the current language', () => {
    const update: AppNotification = { id: 'b', at: 0, read: false, kind: 'update-ready', version: '0.9.1' };
    expect(formatNotification(update, ru)).not.toBe(formatNotification(update, en));
  });
});

describe('formatNotificationTime', () => {
  const now = at(2026, 8, 16, 9, 5);

  it('shows the time alone for the same calendar day', () => {
    expect(formatNotificationTime(at(2026, 8, 16, 14, 32), now, en, 'en')).toBe('14:32');
  });

  it('counts calendar days, not 24-hour windows: last night is still yesterday', () => {
    // 23:50 the previous evening is barely 9 hours ago, yet it belongs to yesterday.
    expect(formatNotificationTime(at(2026, 8, 15, 23, 50), now, en, 'en')).toBe('yesterday, 23:50');
  });

  it('names yesterday in the current language', () => {
    expect(formatNotificationTime(at(2026, 8, 15, 23, 50), now, ru, 'ru')).toContain('вчера');
  });

  it('falls back to a plain date for anything older', () => {
    const older = formatNotificationTime(at(2026, 8, 10, 14, 32), now, en, 'en');
    expect(older).not.toContain('yesterday');
    expect(older).toContain('2026');
  });

  it('treats a moment earlier the same morning as today, not as a future date', () => {
    expect(formatNotificationTime(at(2026, 8, 16, 0, 1), now, en, 'en')).toBe('00:01');
  });
});
