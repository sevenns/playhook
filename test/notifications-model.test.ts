// The notification inbox's pure rules: ordering + eviction, dismissal, the two shapes of markRead, the
// unread count, and the delivery truth table (which is what decides whether the launcher makes a sound).
import { describe, expect, it } from 'vitest';
import {
  MAX_NOTIFICATIONS,
  addNotification,
  deliveryFor,
  dismissNotification,
  markRead,
  unreadCount,
  type PresenceInput,
} from '../src/main/notifications-model';
import type { AppNotification } from '../src/shared/types';

function installed(id: string, at: number, read = false): AppNotification {
  return { id, at, read, kind: 'game-installed', gameId: `game-${id}`, gameTitle: `Game ${id}` };
}

describe('addNotification — append + eviction', () => {
  it('appends to the END (newest last — the order the popup lists them in)', () => {
    const items = addNotification(addNotification([], installed('a', 1)), installed('b', 2));
    expect(items.map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('does not mutate the list it was given', () => {
    const before: readonly AppNotification[] = [installed('a', 1)];
    addNotification(before, installed('b', 2));
    expect(before).toHaveLength(1);
  });

  it('drops the OLDEST once the cap is exceeded', () => {
    let items: readonly AppNotification[] = [];
    for (let i = 0; i < MAX_NOTIFICATIONS + 3; i += 1) items = addNotification(items, installed(`n${i}`, i));
    expect(items).toHaveLength(MAX_NOTIFICATIONS);
    expect(items[0]?.id).toBe('n3');
    expect(items[items.length - 1]?.id).toBe(`n${MAX_NOTIFICATIONS + 2}`);
  });
});

describe('dismissNotification', () => {
  it('removes exactly the pressed one', () => {
    const items = [installed('a', 1), installed('b', 2), installed('c', 3)];
    expect(dismissNotification(items, 'b').map((n) => n.id)).toEqual(['a', 'c']);
  });

  it('leaves the list alone for an id it does not know', () => {
    const items = [installed('a', 1)];
    expect(dismissNotification(items, 'zzz').map((n) => n.id)).toEqual(['a']);
  });
});

describe('markRead', () => {
  it('marks the whole inbox — what opening the popup means', () => {
    const items = [installed('a', 1), installed('b', 2)];
    expect(markRead(items).every((n) => n.read)).toBe(true);
  });

  it('keeps an already-read entry as the SAME object (so a caller can skip a pointless write)', () => {
    const read = installed('a', 1, true);
    const items = [read, installed('b', 2)];
    const next = markRead(items);
    expect(next[0]).toBe(read);
    expect(next[1]).not.toBe(items[1]);
  });

  it('does not mutate the list it was given', () => {
    const items = [installed('a', 1)];
    markRead(items);
    expect(items[0]?.read).toBe(false);
  });
});

describe('unreadCount', () => {
  it('counts only the unread ones', () => {
    expect(unreadCount([installed('a', 1), installed('b', 2, true), installed('c', 3)])).toBe(2);
  });

  it('is 0 for an empty inbox', () => {
    expect(unreadCount([])).toBe(0);
  });
});

describe('deliveryFor — when the launcher may make noise', () => {
  const present: PresenceInput = {
    windowVisible: true,
    windowFocused: true,
    gameRunning: false,
  };

  it('is live whenever the launcher is in front — no idle timer in the way', () => {
    expect(deliveryFor(present)).toBe('live');
  });

  it('is muted while a game runs — whatever the window says', () => {
    expect(deliveryFor({ ...present, gameRunning: true })).toBe('muted');
    expect(deliveryFor({ ...present, gameRunning: true, windowVisible: false })).toBe('muted');
    expect(deliveryFor({ ...present, gameRunning: true, windowFocused: false })).toBe('muted');
  });

  it('is deferred when the window is hidden or behind something — a plate nobody would see', () => {
    expect(deliveryFor({ ...present, windowVisible: false })).toBe('deferred');
    expect(deliveryFor({ ...present, windowFocused: false })).toBe('deferred');
  });
});
