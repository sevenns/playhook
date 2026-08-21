// The notification service: the inbox's owner in main. Every source of events (an update landing, an
// install or an uninstall finishing) hands it a NotificationInput; it decides whether the launcher may
// make noise about it right now (see notifications-model.ts), files it, and pushes both the new list and
// — when there is one to show — the toast to the renderer.
//
// It registers its OWN IPC (like UpdaterService and GameConfigService do), rather than being wired
// through ControllerDeps: the project's rule is "one channel, exactly one registrar", not "every channel
// in the controller".
import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import { IPC, type AppNotification, type NotificationInput } from '../shared/types';
import { log } from './logger';
import {
  addNotification,
  deliveryFor,
  dismissNotification,
  markRead,
  unreadCount,
  type PresenceInput,
} from './notifications-model';
import { type NotificationsStore } from './notifications-store';

/**
 * How many toasts are worth playing back one after another when the user returns. Beyond this the queue
 * would hold the screen for ten seconds of plates nobody reads — a single "N unread" says the same thing.
 */
const MAX_REPLAYED_TOASTS = 2;

export interface NotificationsDeps {
  readonly store: NotificationsStore;
  /** Everything that decides whether the launcher may make noise right now (main owns the pieces). */
  presence(): PresenceInput;
  /** Sends to the launcher window; a no-op while there is no window (or it is destroyed). */
  push(channel: string, payload: unknown): void;
}

export class NotificationsService {
  // The inbox, in memory and authoritative: the renderer renders from what is pushed here, and the file
  // is this list written down. Loaded once in init().
  private items: readonly AppNotification[] = [];
  private lastNotifiedUpdateVersion: string | null = null;
  /** Whether this run already told the user their settings cannot be saved — see notifySettingsWriteFailed. */
  private settingsWriteFailureReported = false;
  // Toasts that arrived while the user was away, waiting for them to come back. Held by ID rather than
  // by value: an entry the user cleared in the meantime must not resurface as a plate.
  private deferredIds: readonly string[] = [];
  // A post-game "N unread" summary that could not be shown yet (the window was still hidden when the
  // game exited). It rides the same queue, and wins over the individual plates.
  private summaryPending = false;

  constructor(private readonly deps: NotificationsDeps) {}

  /** Registers the IPC and loads the inbox off disk. Called once at bootstrap. */
  async init(): Promise<void> {
    this.registerIpc();
    const file = await this.deps.store.read();
    this.items = file.items;
    this.lastNotifiedUpdateVersion = file.lastNotifiedUpdateVersion;
  }

  /** The current inbox (oldest first) — the invoke seed and the payload of every push. */
  snapshot(): readonly AppNotification[] {
    return this.items;
  }

  /**
   * Files one notification and delivers it per the presence rule: a plate now (`live`), a plate held
   * until the user is back (`deferred`), or silence while a game runs (`muted` — the summary after the
   * game covers it). Fire-and-forget: the sources are success paths of long sequences, and none of them
   * has anything to do with a failed disk write.
   */
  notify(input: NotificationInput): void {
    const item: AppNotification = { id: randomUUID(), at: Date.now(), read: false, ...input };
    const delivery = deliveryFor(this.deps.presence());
    this.items = addNotification(this.items, item);
    this.persist();
    this.pushList();
    log.info(`[notifications] ${item.kind} → ${delivery}`);
    if (delivery === 'live') {
      // The plate is shown, and that is ALL it does: a notification stays unread until the popup is
      // opened. A toast is up for a few seconds and the user may be looking at the game they just
      // installed rather than at the corner — treating it as read left the More item with no dot at
      // exactly the moment there was something new to tell them about.
      this.deps.push(IPC.notificationsToast, { kind: 'item', item });
      return;
    }
    if (delivery === 'deferred') this.deferredIds = [...this.deferredIds, item.id];
  }

  /**
   * "An update is downloaded and will apply on the next restart." Deduplicated by version through the
   * PERSISTED marker: the periodic check runs every 6 hours and keeps reporting the same downloaded
   * version, so an in-memory guard would produce a fresh notification after every "Clear all".
   */
  notifyUpdateReady(version: string): void {
    if (this.lastNotifiedUpdateVersion === version) return;
    this.lastNotifiedUpdateVersion = version;
    this.notify({ kind: 'update-ready', version });
  }

  /**
   * "Your settings could not be saved." Deduplicated for the RUN, in memory: whatever makes the file
   * unwritable (a read-only attribute, an ACL from an install under another account) does not heal
   * itself, so every later toggle fails the same way — and one dragged volume slider alone is dozens of
   * writes. In-memory rather than persisted, unlike the update marker: the next launch may well be able
   * to write again, and then there is nothing to say.
   */
  notifySettingsWriteFailed(): void {
    if (this.settingsWriteFailureReported) return;
    this.settingsWriteFailureReported = true;
    this.notify({ kind: 'settings-write-failed' });
  }

  /**
   * The launcher is in front of the user again (it was shown, or it regained focus). That is what
   * releases the toasts which arrived while it was away. Watching them go past does not mark them read
   * — no plate ever does — so the dot beside the More item stays until the popup is opened.
   */
  onLauncherFronted(): void {
    this.releaseDeferred();
  }

  /**
   * A game just ended. Report what piled up while it ran as ONE plate — but only if the launcher is
   * actually in front of the user by now; on the desktop the window can still be hidden at this moment,
   * and a plate nobody sees is a notification lost.
   */
  announceUnreadAfterGame(): void {
    if (unreadCount(this.items) === 0) return;
    if (deliveryFor(this.deps.presence()) !== 'live') {
      this.summaryPending = true;
      return;
    }
    this.pushSummary();
  }

  /** The popup was opened: the whole inbox has been seen. The only gesture that clears an unread. */
  markRead(): void {
    const next = markRead(this.items);
    // markRead returns the SAME object for an entry it did not touch, so an all-identical result means
    // nothing actually changed — no write, no push.
    if (next.every((item, at) => item === this.items[at])) return;
    this.items = next;
    this.persist();
    this.pushList();
  }

  /** The user pressed a notification — pressing one is what removes it (this is an inbox, not a log). */
  dismiss(id: string): void {
    const next = dismissNotification(this.items, id);
    if (next.length === this.items.length) return;
    this.items = next;
    this.persist();
    this.pushList();
  }

  clearAll(): void {
    if (this.items.length === 0) return;
    this.items = [];
    this.deferredIds = [];
    this.summaryPending = false;
    this.persist();
    this.pushList();
  }

  /** Drains in-flight writes — awaited before quitAndInstall, beside the settings store's own flush. */
  flush(): Promise<void> {
    return this.deps.store.flush();
  }

  // ── IPC ──────────────────────────────────────────────────────────────────

  private registerIpc(): void {
    ipcMain.handle(IPC.notificationsRequest, (): readonly AppNotification[] => this.items);
    ipcMain.on(IPC.notificationsDismiss, (_event, id: unknown) => {
      if (typeof id === 'string') this.dismiss(id);
    });
    ipcMain.on(IPC.notificationsClear, () => this.clearAll());
    ipcMain.on(IPC.notificationsMarkRead, () => this.markRead());
  }

  // ── Delivery plumbing ────────────────────────────────────────────────────

  private pushList(): void {
    this.deps.push(IPC.notificationsUpdate, this.items);
  }

  private pushSummary(): void {
    const count = unreadCount(this.items);
    if (count === 0) return;
    this.deps.push(IPC.notificationsToast, { kind: 'unread-summary', count });
  }

  /**
   * Plays back what arrived while the user was away. A handful of plates is a fair summary of "these
   * three things happened"; more than that — or anything a finished game left behind — collapses into
   * the single "N unread" plate instead.
   */
  private releaseDeferred(): void {
    const pending = this.deferredIds
      .map((id) => this.items.find((item) => item.id === id))
      .filter((item): item is AppNotification => item !== undefined);
    const summary = this.summaryPending;
    if (pending.length === 0 && !summary) return;
    this.deferredIds = [];
    this.summaryPending = false;
    if (summary || pending.length > MAX_REPLAYED_TOASTS) {
      this.pushSummary();
      return;
    }
    for (const item of pending) {
      this.deps.push(IPC.notificationsToast, { kind: 'item', item });
    }
  }

  // Writes the in-memory inbox down. Fire-and-forget behind the store's queue: a failed write costs the
  // user a notification across a restart, never the notification they are looking at right now.
  private persist(): void {
    void this.deps.store
      .update((current) => ({
        ...current,
        items: this.items,
        lastNotifiedUpdateVersion: this.lastNotifiedUpdateVersion,
      }))
      .catch((cause: unknown) => log.warn('[notifications] failed to persist the inbox:', cause));
  }
}
