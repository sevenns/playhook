// Platform factory: selects the win32 or linux service bundle by process.platform. Everything that is not
// Windows (linux/SteamOS, and macOS dev builds) gets the linux bundle — which in the foundation stage is
// the pre-port graceful degradation and is filled in with real Proton logic stage by stage.
//
// This is the ONE place that branches on the OS at bootstrap; every consumer takes an injected service and
// stays platform-agnostic (see CLAUDE.md — the platform layer is now the convention for OS-specific code).
import type { Platform, PlatformDeps } from './types';
import { createWin32Platform } from './win32';
import { createLinuxPlatform } from './linux';

export type {
  Platform,
  PlatformDeps,
  ProcessMonitor,
  ProcessSnapshot,
  SteamLocator,
  GameProcessLauncher,
  SavePathResolver,
  PowerBackend,
} from './types';

/** Builds the platform service bundle for the running OS. Bootstrapped once in main. */
export function createPlatform(platform: NodeJS.Platform, deps: PlatformDeps): Platform {
  return platform === 'win32' ? createWin32Platform(deps) : createLinuxPlatform();
}
