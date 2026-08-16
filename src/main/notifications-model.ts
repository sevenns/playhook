// The notification inbox's rules — pure functions over an immutable list, plus the one decision that
// says whether an arriving notification may make noise. No fs and no electron (NotificationsStore owns
// the bytes, NotificationsService owns the wiring), so all of it is unit-testable — the same split
// library-index.ts makes for the carousel's history.
//
// This is an INBOX, not a journal: pressing a notification removes it (the spec's requirement), so the
// list only ever holds what the user has not dealt with yet. That is also why the cap below can be this
// small — "what did I install last week" is the play history's question, not this list's.
import { type AppNotification } from '../shared/types';

/** How many notifications the inbox keeps. Beyond this the OLDEST are dropped. */
export const MAX_NOTIFICATIONS = 30;

/**
 * Appends one notification and evicts from the front once the list is over the cap. `items` is kept in
 * ASCENDING `at` order (the newest at the end), which is the order the popup lists them in.
 */
export function addNotification(
  items: readonly AppNotification[],
  next: AppNotification,
): readonly AppNotification[] {
  const appended = [...items, next];
  return appended.length <= MAX_NOTIFICATIONS
    ? appended
    : appended.slice(appended.length - MAX_NOTIFICATIONS);
}

/** Drops one notification by id (the user pressed it, or it was acted on). Unknown id → unchanged. */
export function dismissNotification(
  items: readonly AppNotification[],
  id: string,
): readonly AppNotification[] {
  return items.filter((item) => item.id !== id);
}

/**
 * Marks notifications read: WITHOUT `ids` everything (the popup was opened — the user has seen the
 * list), WITH `ids` only those (the toasts the renderer confirms it actually got on screen). Unknown
 * ids are ignored, and an already-read entry keeps its identity so callers can skip a pointless write.
 */
export function markRead(
  items: readonly AppNotification[],
  ids?: readonly string[],
): readonly AppNotification[] {
  const target = ids === undefined ? null : new Set(ids);
  return items.map((item) => {
    if (item.read) return item;
    if (target !== null && !target.has(item.id)) return item;
    return { ...item, read: true };
  });
}

export function unreadCount(items: readonly AppNotification[]): number {
  return items.reduce((count, item) => (item.read ? count : count + 1), 0);
}

/** Everything that decides whether a notification may make noise right now. */
export interface PresenceInput {
  /** The renderer saw input less than 5s ago AND the UI is revealed (it reports false while booting). */
  readonly uiActive: boolean;
  readonly windowVisible: boolean;
  readonly windowFocused: boolean;
  readonly gameRunning: boolean;
}

/**
 * How a notification reaches the user:
 *  • `live` — they are at the launcher: a toast plus the sound, and seeing it IS reading it;
 *  • `deferred` — they stepped away (idle, or the window is hidden/behind): the notification is filed
 *    unread and its toast waits for them to come back (returning does not mark it read — only the popup
 *    does). This covers the ordinary "pressed Install, walked off for a minute, came back" case;
 *  • `muted` — a game is running: the launcher is behind it, so it stays quiet and settles up with a
 *    single "N unread" plate once the game exits.
 */
export type Delivery = 'live' | 'deferred' | 'muted';

export function deliveryFor(presence: PresenceInput): Delivery {
  if (presence.gameRunning) return 'muted';
  if (presence.uiActive && presence.windowVisible && presence.windowFocused) return 'live';
  return 'deferred';
}
