// Registering Playhook as a non-Steam game so it gets a Steam Deck Game Mode tile — the user-facing flow
// behind the tray's "Add to Steam" / "Remove from Steam". Interface-DI (like PowerService /
// UpdaterService): the file writing lives in platform.steamShortcuts, the message boxes and the tray
// rebuild are injected, so this module stays electron-free on import.
//
// Two invariants shape the whole thing:
//  - The appid is DERIVED from the exe path, so the path must be stable across updates. It never points at
//    `$APPIMAGE` directly (that carries the version, and moves when the user re-downloads) but at a symlink
//    in ~/.local/share/playhook that we re-point on every start. See ensureStableLauncher.
//  - Only OUR record is ever touched. A shortcut the user added by hand has a random appid and possibly
//    their own artwork and playtime; we ask them to remove it rather than deleting it for them.
import path from 'node:path';
import fs from 'node:fs/promises';
import type { Platform, SteamShortcutTarget } from './platform';
import type { AppSettingsStore } from './app-settings';
import type { Translator } from '../shared/i18n/index';
import { log } from './logger';
import { describe } from './util';

/** The shortcut's name in Steam. Fixed: it feeds the appid hash, so it must never carry a version. */
export const STEAM_SHORTCUT_NAME = 'Playhook';

// POSIX-join throughout: this feature is Linux-only, so the paths must use `/` no matter which OS the
// code is compiled or tested on (see umu.ts / steam-userdata.linux.ts — a win32 `path.join` here would
// silently produce backslashes and, worse, a DIFFERENT appid, since the appid is a hash of the path).

/** The stable launcher directory — the appid depends on this path, so it must not move between releases. */
function stableDir(home: string): string {
  return path.posix.join(home, '.local', 'share', 'playhook');
}

export function stableLauncherPath(home: string): string {
  return path.posix.join(stableDir(home), 'Playhook.AppImage');
}

export function stableIconPath(home: string): string {
  return path.posix.join(stableDir(home), 'icon.png');
}

export interface SteamShortcutDeps {
  readonly platform: Platform;
  readonly settings: AppSettingsStore;
  readonly getTranslator: () => Translator;
  /** The user's home directory (app.getPath('home')). */
  readonly home: string;
  /** Path to the packaged `icon.png`, copied out of the asar so Steam can actually read it. */
  readonly sourceIconPath: string;
  /** `$APPIMAGE`, or null on a dev / non-AppImage run — then the whole feature is unavailable. */
  readonly appImagePath: string | null;
  /** Shows a message box (real: dialog.showMessageBox). */
  readonly notify: (title: string, message: string) => void;
  /** Rebuilds the tray menu so the item reflects the new state. */
  readonly onStateChanged: () => void;
}

export interface SteamShortcutService {
  /** Whether the tray item should be shown at all (linux + a packaged AppImage). */
  isAvailable(): boolean;
  /** Whether a shortcut is currently registered (drives Add vs Remove). */
  isRegistered(): boolean;
  /** Whether an operation is in flight (the item shows "Working…" and is disabled). */
  isBusy(): boolean;
  /** Re-points the stable symlink and drops a stale appid whose record vanished. Called at startup. */
  reconcile(): Promise<void>;
  add(): Promise<void>;
  remove(): Promise<void>;
}

export function createSteamShortcutService(deps: SteamShortcutDeps): SteamShortcutService {
  // `null` = not registered. Mirrors settings.steamAppIdU32; kept in memory so the tray builder stays
  // synchronous. main is single-threaded, so a plain flag is enough here — no mutex needed.
  let appIdU32: number | null = null;
  let busy = false;

  const t = (): Translator => deps.getTranslator();
  const available = deps.platform.steamShortcuts.supported && deps.appImagePath !== null;

  function fail(cause: unknown): void {
    const message = typeof cause === 'string' ? cause : describe(cause);
    log.warn('[steam-shortcut] operation failed:', message);
    deps.notify(t()('steam.failedTitle'), t()('steam.failed', { cause: message }));
  }

  /**
   * Points ~/.local/share/playhook/Playhook.AppImage at the current $APPIMAGE and extracts icon.png next
   * to it. Both are re-done on every start: electron-updater replaces the AppImage in place, but a user
   * who re-downloads it by hand lands somewhere else — and the symlink is the only reason the appid (and
   * with it the tile's artwork and playtime) survives that.
   */
  async function ensureStableLauncher(appImage: string): Promise<string> {
    const target = stableLauncherPath(deps.home);
    await fs.mkdir(stableDir(deps.home), { recursive: true });
    const current = await fs.readlink(target).catch(() => null);
    if (current !== appImage) {
      // rm first: symlink() refuses an existing path, and the old one may be a stale symlink or a file.
      await fs.rm(target, { force: true });
      await fs.symlink(appImage, target);
      log.info(`[steam-shortcut] launcher symlink → "${appImage}"`);
    }
    await fs.copyFile(deps.sourceIconPath, stableIconPath(deps.home)).catch((cause: unknown) => {
      // Best-effort: a tile without an icon still launches. Never silent, though.
      log.warn('[steam-shortcut] could not extract the tile icon:', describe(cause));
    });
    return target;
  }

  async function persistAppId(next: number | null): Promise<void> {
    appIdU32 = next;
    await deps.settings.patch({ steamAppIdU32: next });
    deps.onStateChanged();
  }

  return {
    isAvailable: () => available,
    isRegistered: () => appIdU32 !== null,
    isBusy: () => busy,

    async reconcile(): Promise<void> {
      const stored = (await deps.settings.read()).steamAppIdU32;
      appIdU32 = stored;
      if (!available || deps.appImagePath === null) return;
      try {
        await ensureStableLauncher(deps.appImagePath);
      } catch (cause) {
        log.warn('[steam-shortcut] could not refresh the launcher symlink:', describe(cause));
      }
      if (stored === null) return;
      // Self-healing: Steam rewrites shortcuts.vdf from its own memory when the user adds or removes a
      // non-Steam game through the UI, which can drop a record we wrote while it was running. A stored
      // appid with no record behind it means the tile is gone — forget it, so the tray offers "Add" again.
      if (!(await deps.platform.steamShortcuts.hasShortcut(stored))) {
        log.info('[steam-shortcut] stored shortcut is gone from shortcuts.vdf — forgetting it');
        await persistAppId(null);
      }
      deps.onStateChanged();
    },

    async add(): Promise<void> {
      if (busy || !available || deps.appImagePath === null) return;
      busy = true;
      deps.onStateChanged();
      try {
        const exePath = await ensureStableLauncher(deps.appImagePath);
        // A tile the user added by hand would become a confusing second entry — and deleting theirs is
        // not ours to do (it may carry their artwork and playtime). Ask, and stop.
        const foreign = await deps.platform.steamShortcuts.findForeignShortcuts([
          exePath,
          deps.appImagePath,
          path.posix.basename(deps.appImagePath),
        ]);
        if (foreign.length > 0) {
          deps.notify(
            t()('steam.failedTitle'),
            t()('steam.foreign', { names: foreign.join(', ') }),
          );
          return;
        }

        const target: SteamShortcutTarget = {
          exePath,
          appName: STEAM_SHORTCUT_NAME,
          startDir: path.posix.dirname(exePath),
          iconPath: stableIconPath(deps.home),
        };
        const result = await deps.platform.steamShortcuts.addShortcut(target);
        if (!result.ok) {
          fail(result.message);
          return;
        }
        await persistAppId(result.appIdU32);
        log.info(`[steam-shortcut] registered appid ${result.appIdU32}`);
        deps.notify(t()('steam.addedTitle'), t()('steam.added'));
      } catch (cause) {
        fail(cause);
      } finally {
        busy = false;
        deps.onStateChanged();
      }
    },

    async remove(): Promise<void> {
      if (busy || !available) return;
      const current = appIdU32;
      if (current === null) return;
      busy = true;
      deps.onStateChanged();
      try {
        const result = await deps.platform.steamShortcuts.removeShortcut(current);
        if (!result.ok) {
          fail(result.message);
          return;
        }
        await persistAppId(null);
        log.info(`[steam-shortcut] removed appid ${current}`);
        deps.notify(t()('steam.removedTitle'), t()('steam.removed'));
      } catch (cause) {
        fail(cause);
      } finally {
        busy = false;
        deps.onStateChanged();
      }
    },
  };
}
