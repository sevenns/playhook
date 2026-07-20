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
import type { Readable } from 'node:stream';
import { log, setLogBaseDir } from './logger';
import { AppSettingsStore } from './app-settings';
import { DriveWatcher } from './drive-watcher';
// The LINUX bundle directly, not createPlatform(): the factory imports the win32 bundle too, which pulls
// the koffi FFI bindings (registry, power-native, foreground) into the daemon's import graph for no
// reason. The daemon only ever runs on a Steam Deck.
import { createLinuxPlatform } from './platform/linux';
import { toRunGameId } from './platform/steam-appid';
import { launchWhenSteamReady } from './daemon-launch';
import { systemEnv } from './appimage-env';
import { isSteamPipeReady } from './platform/steam-pipe.linux';

/** Electron's `app.getPath('userData')` on Linux, reproduced without Electron: `$XDG_CONFIG_HOME/playhook`. */
function userDataDir(home: string): string {
  const xdg = process.env['XDG_CONFIG_HOME'];
  const base = xdg !== undefined && xdg !== '' ? xdg : path.posix.join(home, '.config');
  return path.posix.join(base, 'playhook');
}

/**
 * Fires the launch request. Detached: the daemon must not own the app's lifetime.
 *
 * `systemEnv()` is essential, not hygiene: with the AppImage's own LD_LIBRARY_PATH inherited, the `steam`
 * script reported "Steam is not running" while Steam was running, and the tile hung on "Launching…".
 *
 * The output is piped into the log rather than discarded. It was `stdio: 'ignore'` at first, and that made
 * the failure invisible for three rounds of testing — Steam prints the real reason, we just weren't
 * listening.
 */
function spawnSteamUri(appIdU32: number): void {
  const uri = `steam://rungameid/${toRunGameId(appIdU32).toString()}`;
  try {
    const child = spawn('steam', [uri], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: systemEnv(),
    });
    const relay = (stream: Readable | null, level: 'info' | 'error'): void => {
      stream?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8').trim();
        if (text !== '') log[level](`[daemon] steam: ${text}`);
      });
    };
    relay(child.stdout, 'info');
    relay(child.stderr, 'error');
    child.on('exit', (code) => {
      if (code !== 0) log.warn(`[daemon] steam exited with code ${String(code)}`);
    });
    child.on('error', (cause) => log.error('[daemon] failed to spawn steam:', cause.message));
    child.unref();
  } catch (cause) {
    log.error(
      '[daemon] failed to spawn steam:',
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * A card reported within this long of the daemon starting was ALREADY in the slot when the Game Mode
 * session began — nobody can physically insert one in the first seconds of a session.
 *
 * Such a card is deliberately ignored. Auto-launching there would drag the user into Playhook every single
 * time they enter Game Mode with a card left in the slot, even when they came to play something else —
 * and "take the card out then" is not an answer. The feature exists for the deliberate act of INSERTING a
 * card, which is an unambiguous "I want to play this".
 *
 * It also removes the only situation that could race the Steam client coming up: a card inserted into a
 * live session meets a Steam that has long been able to launch.
 */
const COLD_START_WINDOW_MS = 10_000;

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
  // Guards against overlapping launch attempts while one is being confirmed (the confirm window is
  // tens of seconds, and DriveWatcher keeps scanning throughout).
  let launching = false;
  // When this daemon started. See COLD_START_WINDOW_MS — a card found in the first moments was already
  // in the slot, not inserted by anyone.
  const startedAt = Date.now();

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
        // Belt-and-braces mode check. The unit is bound to gamescope-session.target, so systemd should
        // never have us running outside Game Mode — but an install left over from an older version (or a
        // manual `systemctl --user start`) could, and then we would drag the user out of their desktop
        // into Playhook. Checked HERE rather than at startup on purpose: at startup the daemon may race
        // gamescope coming up and wrongly conclude "not Game Mode", whereas by the time a card is
        // inserted the session is long since up.
        // The env pair isGamescopeSession() uses is not available to a systemd unit (its environment has
        // neither SteamOS nor SteamGamepadUI, nor even DISPLAY), so this goes by the running process —
        // gamescope's argv[0] is `gamescope`, verified on a Deck.
        const processes = await platform.processMonitor.snapshot();
        if (!processes.hasImageName('gamescope')) {
          log.info(`[daemon] card at "${root}" ignored — not a Game Mode session`);
          return;
        }

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

        // The card was already in the slot when the session started → not an insertion, no intent, no
        // launch. See COLD_START_WINDOW_MS.
        if (Date.now() - startedAt < COLD_START_WINDOW_MS) {
          log.info(
            `[daemon] card at "${root}" was already inserted at session start — not launching`,
          );
          return;
        }

        // Serialized: a second card event while a launch is being confirmed must not fire its own
        // request. The confirm step re-checks "already running", so nothing is lost by waiting.
        if (launching) {
          log.info('[daemon] card detected while a launch is already in progress — ignoring');
          return;
        }

        launching = true;
        try {
          log.info(`[daemon] card at "${root}" — requesting launch`);
          const outcome = await launchWhenSteamReady({
            isAppRunning: () => platform.processMonitor.isSteamGameRunning(steamAppIdU32, []),
            // The client's own FIFO, not a process name: see steam-pipe.linux.ts. By this point Steam has
            // been up for a while anyway — this only guards against the absurd cases.
            isSteamReady: () => isSteamPipeReady(home),
            launch: () => spawnSteamUri(steamAppIdU32),
            sleep,
            log: (message) => log.info(`[daemon] ${message}`),
          });
          log.info(`[daemon] launch outcome: ${outcome}`);
        } finally {
          launching = false;
        }
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
