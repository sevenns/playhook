// Platform factory: selects the win32, darwin or linux service bundle by process.platform. The three are
// real ports, not degradations — linux (SteamOS) runs Windows games through Proton, darwin runs NATIVE mac
// games and Steam mode (see platform/darwin.ts for what macOS deliberately does not do). Anything that is
// neither Windows nor macOS gets the linux bundle.
//
// This is the ONE place that branches on the OS at bootstrap; every consumer takes an injected service and
// stays platform-agnostic (see CLAUDE.md — the platform layer is the convention for OS-specific code).
import type { Platform, PlatformDeps } from './types';
import { createWin32Platform } from './win32';
import { createLinuxPlatform } from './linux';
import { createDarwinPlatform } from './darwin';

export type {
  Platform,
  PlatformDeps,
  ProcessMonitor,
  ProcessSnapshot,
  SteamLocator,
  SteamShortcuts,
  SteamShortcutTarget,
  SteamArtworkSources,
  SteamShortcutResult,
  GameProcessLauncher,
  SavePathResolver,
  PcSaveLocation,
  PowerBackend,
  RemovableMounter,
} from './types';

/** Builds the platform service bundle for the running OS. Bootstrapped once in main. */
export function createPlatform(platform: NodeJS.Platform, deps: PlatformDeps): Platform {
  if (platform === 'win32') return createWin32Platform(deps);
  if (platform === 'darwin') return createDarwinPlatform(deps);
  return createLinuxPlatform(deps);
}
