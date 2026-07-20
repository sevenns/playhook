// Game Mode card watcher — a separate entry point from main.ts, run by systemd under
// ELECTRON_RUN_AS_NODE (see daemon-unit.ts for why). It has no window, no tray, and deliberately does NOT
// take the single-instance lock: the real Playhook, launched by Steam, must be able to start alongside it.
// Being a physically separate entry point is what guarantees that — there is no path from here into
// bootstrap().
//
// What it does: watch for a Playhook card and, when one appears, ask Steam to launch our own non-Steam
// shortcut. That is all. Everything else about the app stays in main.ts.
//
// It reuses the WHOLE DriveWatcher rather than a narrow "removable media appeared" detector, which is the
// single most important design point here: DriveWatcher.scan() requires a `game.json`, so an ordinary USB
// stick will never yank the user out of a running game and into Playhook. A narrow detector would.
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { log, setLogBaseDir } from './logger';
import { AppSettingsStore } from './app-settings';
import { DriveWatcher } from './drive-watcher';
// The LINUX bundle directly, not createPlatform(): the factory imports the win32 bundle too, which pulls
// the koffi FFI bindings (registry, power-native, foreground) into the daemon's import graph for no
// reason. The daemon only ever runs on a Steam Deck.
import { createLinuxPlatform } from './platform/linux';
import { toRunGameId } from './platform/steam-appid';

/** Electron's `app.getPath('userData')` on Linux, reproduced without Electron: `$XDG_CONFIG_HOME/playhook`. */
function userDataDir(home: string): string {
  const xdg = process.env['XDG_CONFIG_HOME'];
  const base = xdg !== undefined && xdg !== '' ? xdg : path.posix.join(home, '.config');
  return path.posix.join(base, 'playhook');
}

/** Launches our shortcut through Steam. Detached: the daemon must not own the app's lifetime. */
function launchViaSteam(appIdU32: number): void {
  const uri = `steam://rungameid/${toRunGameId(appIdU32).toString()}`;
  log.info(`[daemon] card detected — launching ${uri}`);
  try {
    const child = spawn('steam', [uri], { detached: true, stdio: 'ignore' });
    child.on('error', (cause) => log.error('[daemon] failed to spawn steam:', cause.message));
    child.unref();
  } catch (cause) {
    log.error(
      '[daemon] failed to spawn steam:',
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}

export function startDaemon(): void {
  const home = os.homedir();
  const userData = userDataDir(home);
  // Must precede every log call: there is no Electron `app` here to resolve the path from.
  setLogBaseDir(userData);
  log.info('[daemon] starting');

  const platform = createLinuxPlatform({
    getDocuments: () => path.posix.join(home, 'Documents'),
    userData,
    // Unused by the daemon (it launches nothing through Proton), but PlatformDeps requires it. Resolved
    // the same way main.ts does so the value is at least correct rather than a lie.
    umuRunPath: path.join(process.resourcesPath, 'umu', 'umu-run'),
  });
  const settings = new AppSettingsStore(userData);

  // The automount sweep is wired unconditionally: this daemon only ever runs inside Game Mode (systemd
  // starts it with gamescope-session.target), and that is exactly the session where gamescope automounts
  // ext4 but not exFAT/NTFS. In Desktop Mode KDE does the mounting and this process is not running.
  const watcher = new DriveWatcher(undefined, () => platform.removableMounter.mountAll());

  watcher.onInsert((root) => {
    void (async (): Promise<void> => {
      try {
        // Re-read on every insert instead of caching at startup: a daemon started BEFORE the user pressed
        // "Add to Steam" would otherwise stay stuck on `null` until the next login. One cheap read per
        // card insertion is nothing.
        const { steamAppIdU32 } = await settings.read();
        if (steamAppIdU32 === null) {
          log.info(`[daemon] card at "${root}" ignored — no Steam shortcut registered`);
          return;
        }
        // Steam stamps SteamAppId on every process it launches, including non-Steam shortcuts — verified
        // on a Deck. Note this must stay a FULL /proc sweep (steamAppPids): not every process in our own
        // tree carries the tag, and some are unreadable (setuid sandbox), so checking a single "main" pid
        // would give the wrong answer.
        if (await platform.processMonitor.isSteamGameRunning(steamAppIdU32, [])) {
          log.info('[daemon] card detected but Playhook is already running — nothing to do');
          return;
        }
        launchViaSteam(steamAppIdU32);
      } catch (cause) {
        log.error(
          '[daemon] insert handling failed:',
          cause instanceof Error ? cause.message : String(cause),
        );
      }
    })();
  });

  watcher.onError((error) => log.warn('[daemon] watcher error:', error.message));
  watcher.start();
  log.info('[daemon] watching for cards');
}

// Executed for its side effect: the unit's ExecStart `require()`s this file directly.
startDaemon();
