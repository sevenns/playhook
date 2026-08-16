// The notification inbox on disk — notifications.json in %APPDATA%/<app>/. Built to AppSettingsStore's
// shape: a zod schema whose every field carries a `.default(…)` (so an older or half-written file
// migrates instead of resetting the lot), a safe read through readJsonValidated, an atomic write, and a
// promise queue that serializes read-modify-writes — two installs finishing at once would otherwise both
// read the same list and the second would clobber the first.
//
// Electron-free on purpose (baseDir is injected rather than taken from app.getPath): it is what makes
// this testable, and it keeps the module off the daemon's forbidden-import radar.
import path from 'node:path';
import fse from 'fs-extra';
import { z } from 'zod';
import { type AppNotification } from '../shared/types';
import { readJsonValidated, writeJsonAtomic } from './json-store';

const notificationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('update-ready'),
    id: z.string(),
    at: z.number(),
    read: z.boolean(),
    version: z.string(),
  }),
  z.object({
    kind: z.literal('game-installed'),
    id: z.string(),
    at: z.number(),
    read: z.boolean(),
    gameId: z.string(),
    gameTitle: z.string(),
  }),
  z.object({
    kind: z.literal('game-uninstalled'),
    id: z.string(),
    at: z.number(),
    read: z.boolean(),
    gameId: z.string(),
    gameTitle: z.string(),
  }),
]);

const inboxSchema = z.object({
  schemaVersion: z.literal(1),
  // `.readonly()` so the parsed shape matches NotificationsFile, whose list is immutable like every
  // other snapshot passed around here (the model returns new arrays, it never edits one in place).
  items: z.array(notificationSchema).readonly().default([]),
  /**
   * The last app version a "ready to install" notification was written for. PERSISTED, not in-memory:
   * the update check runs every 6 hours, so a session that outlives one check would notify about the
   * same downloaded version again after the user cleared the inbox.
   */
  lastNotifiedUpdateVersion: z.string().nullable().default(null),
});

/** The whole file: the inbox plus the update-dedup marker. */
export interface NotificationsFile {
  readonly schemaVersion: 1;
  readonly items: readonly AppNotification[];
  readonly lastNotifiedUpdateVersion: string | null;
}

export const EMPTY_NOTIFICATIONS: NotificationsFile = {
  schemaVersion: 1,
  items: [],
  lastNotifiedUpdateVersion: null,
};

export class NotificationsStore {
  private readonly filePath: string;
  // Serializes every WRITE, exactly as AppSettingsStore does: notifications are produced by
  // fire-and-forget callers (an install finishing, an update landing) that never await each other.
  private tail: Promise<void> = Promise.resolve();

  /** @param baseDir where notifications.json lives (the GUI passes app.getPath('userData')). */
  constructor(private readonly baseDir: string) {
    this.filePath = path.join(baseDir, 'notifications.json');
  }

  /**
   * Runs `op` after the current write chain drains, then chains the next writer behind it. The caller
   * gets `op`'s real result; the chain TAIL swallows rejections so one failed write can't poison the
   * queue (the same arrangement AppSettingsStore documents).
   */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const result = this.tail.then(op);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Reads the inbox; an empty one when the file is missing, unreadable or invalid (warned by the store). */
  read(): Promise<NotificationsFile> {
    return readJsonValidated(this.filePath, inboxSchema, EMPTY_NOTIFICATIONS);
  }

  /** The actual atomic write — called ONLY from inside a queued op, so it never enqueues (deadlock). */
  private async persist(next: NotificationsFile): Promise<void> {
    await fse.ensureDir(this.baseDir);
    await writeJsonAtomic(this.filePath, next);
  }

  /**
   * Read-modify-write as ONE queued op: `change` receives the file as it is on disk right now and
   * returns what it should become. Concurrent callers therefore chain instead of racing, and each sees
   * the previous one's result.
   */
  update(change: (current: NotificationsFile) => NotificationsFile): Promise<NotificationsFile> {
    return this.enqueue(async () => {
      // The read is DIRECT (not enqueue): it already runs inside a queued op, and enqueuing it here
      // would wait on the very op it runs inside.
      const current = await this.read();
      const next = change(current);
      await this.persist(next);
      return next;
    });
  }

  /**
   * Resolves once every queued write has settled — awaited before quitAndInstall, so an inbox write is
   * not torn in half by the process exit. Never rejects (the tail already swallows rejections).
   */
  flush(): Promise<void> {
    return this.tail;
  }
}
