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
 * Marks the whole inbox read — what opening the popup means. An already-read entry keeps its identity,
 * so a caller can tell "nothing changed" from the result and skip a pointless write and push.
 */
export function markRead(items: readonly AppNotification[]): readonly AppNotification[] {
  return items.map((item) => (item.read ? item : { ...item, read: true }));
}

export function unreadCount(items: readonly AppNotification[]): number {
  return items.reduce((count, item) => (item.read ? count : count + 1), 0);
}

/**
 * Everything that decides whether a notification may make noise right now. All three facts are main's
 * own: whether the user has TOUCHED anything recently is deliberately not among them — a launcher
 * sitting in front of someone who has not pressed a button for a minute is still a launcher they are
 * looking at, and treating that as absence held back notifications they would have seen.
 */
export interface PresenceInput {
  /** The launcher window is on screen (not hidden to the tray, not minimized). */
  readonly windowVisible: boolean;
  /** …and it is the foreground window (not sitting behind whatever the user is actually using). */
  readonly windowFocused: boolean;
  readonly gameRunning: boolean;
}

/**
 * How a notification reaches the user:
 *  • `live` — the launcher is in front of them: a toast plus the sound, and seeing it IS reading it;
 *  • `deferred` — the window is hidden or behind something: the notification is filed unread and its
 *    toast waits until the launcher comes back to the front (coming back does not mark it read — only
 *    opening the popup does). This is the case a plate would otherwise be shown to nobody and marked
 *    read for it;
 *  • `muted` — a game is running: the launcher is behind it, so it stays quiet and settles up with a
 *    single "N unread" plate once the game exits.
 */
export type Delivery = 'live' | 'deferred' | 'muted';

export function deliveryFor(presence: PresenceInput): Delivery {
  if (presence.gameRunning) return 'muted';
  return presence.windowVisible && presence.windowFocused ? 'live' : 'deferred';
}
