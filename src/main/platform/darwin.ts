// macOS implementations of the platform services. What macOS supports is a deliberate subset: NATIVE mac
// games (a bare binary or a `.app` bundle) and Steam mode. Windows games (no Wine/CrossOver) and install
// mode are out of scope and refuse with their own message rather than failing obscurely.
//
// Per-service notes:
//   ProcessMonitor → `ps` (process-monitor.darwin.ts; Д1 — no readable env of foreign processes, so a Steam
//                    game is matched by the watched image names, as on win32)
//   SteamLocator   → `~/Library/Application Support/Steam` (steam-locator.darwin.ts; Д8)
//   GameLauncher   → direct spawn / `.app` bundle resolution (game-launcher.darwin.ts; Д2)
//   SavePathResolver → the Windows dictionary mapped onto the mac profile (save-path.darwin.ts; Д3)
//   PowerBackend   → `pmset sleepnow` + System Events via osascript (Д4)
//   SteamShortcuts → unsupported (Game Mode is a Steam Deck thing)
//   RemovableMounter → no-op: macOS automounts removable volumes into /Volumes (Д9)
//   resolveInstallDir → null: install mode is unsupported, so no card can resolve one
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  Platform,
  PlatformDeps,
  PowerBackend,
  RemovableMounter,
  SteamShortcuts,
} from './types';
import { createDarwinProcessMonitor } from './process-monitor.darwin';
import { createDarwinSteamLocator } from './steam-locator.darwin';
import { createDarwinGameLauncher } from './game-launcher.darwin';
import { createDarwinSavePathResolver } from './save-path.darwin';
import { describe } from '../util';
import type { Translator } from '../../shared/i18n/index';

const execFileAsync = promisify(execFile);

// ── PowerBackend (`pmset` + System Events) ───────────────────────────────────
// Sleep goes through `pmset sleepnow`, which needs no root — it changes no settings, it only suspends.
// Shutdown/restart have no such command (`shutdown` itself does require root), so they ask System Events
// via osascript, the same route the Apple menu takes.
//
// Д4: sending Apple Events from a PACKAGED app requires `NSAppleEventsUsageDescription` in Info.plist
// (electron-builder `mac.extendInfo`) AND the user's consent in the TCC prompt. In dev the responsible
// process is the terminal, which already has that consent — so this path can only be finally verified on a
// packaged build. A refusal comes back as osascript error -1743, reported here in words the user can act on.

/** osascript's error for "not authorized to send Apple events" (the TCC prompt was declined). */
const NOT_AUTHORIZED_ERROR = '-1743';

/** Whether an osascript failure is the TCC refusal rather than a genuine command failure. */
function isAppleEventsRefusal(cause: unknown): boolean {
  const message = describe(cause);
  return message.includes(NOT_AUTHORIZED_ERROR) || message.includes('Not authorized to send Apple events');
}

function createPowerBackend(getTranslator: () => Translator): PowerBackend {
  return {
    supported: true,
    async run(action): Promise<void> {
      const verb = action === 'shutdown' ? 'shut down' : 'restart';
      try {
        await execFileAsync('osascript', ['-e', `tell application "System Events" to ${verb}`]);
      } catch (cause) {
        if (isAppleEventsRefusal(cause)) {
          throw new Error(getTranslator()('errors.macPowerNotPermitted'));
        }
        throw cause;
      }
    },
    async suspend(): Promise<void> {
      await execFileAsync('pmset', ['sleepnow']);
    },
  };
}

// ── SteamShortcuts (unsupported) ─────────────────────────────────────────────
// Registering Playhook as a non-Steam game exists for the Steam Deck's Game Mode; macOS has no such mode.
// `supported: false` hides the tray item entirely, so these refusals are never surfaced — they exist so the
// interface stays total (identical in intent to the win32 stub).

function createSteamShortcuts(): SteamShortcuts {
  const unsupported = { ok: false, message: 'Steam shortcuts are not supported on macOS' } as const;
  return {
    supported: false,
    addShortcut: () => Promise.resolve(unsupported),
    removeShortcut: () => Promise.resolve(unsupported),
    hasShortcut: () => Promise.resolve(false),
    findForeignShortcuts: () => Promise.resolve([]),
    writeArtwork: () => Promise.resolve(),
    removeArtwork: () => Promise.resolve(),
  };
}

// ── RemovableMounter (no-op) ─────────────────────────────────────────────────
// Д9: macOS mounts removable media itself (an exFAT card appears under /Volumes, executable), so there is
// nothing to sweep — same situation as Windows.

function createRemovableMounter(): RemovableMounter {
  return { mountAll: () => Promise.resolve() };
}

/** Assembles the macOS platform bundle. The launcher shares the `ps` monitor (liveness + force-kill). */
export function createDarwinPlatform(deps: PlatformDeps): Platform {
  const processMonitor = createDarwinProcessMonitor();
  return {
    processMonitor,
    steamLocator: createDarwinSteamLocator(),
    steamShortcuts: createSteamShortcuts(),
    gameLauncher: createDarwinGameLauncher({
      monitor: processMonitor,
      getTranslator: deps.getTranslator,
    }),
    savePathResolver: createDarwinSavePathResolver({
      home: os.homedir(),
      documents: deps.getDocuments(),
    }),
    powerBackend: createPowerBackend(deps.getTranslator),
    removableMounter: createRemovableMounter(),
    // Install mode is out of scope on macOS (see the header): null makes readManifests reject an
    // install-mode card with the existing "install mode is unavailable" message instead of half-resolving it.
    resolveInstallDir: () => null,
  };
}
