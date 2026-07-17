// Linux ProcessMonitor backed by /proc (Р3). Watched-game tracking on Linux can't use `comm`
// (/proc/<pid>/comm is truncated to 15 chars, and names like `Game-Win64-Shipping.exe` are longer), so we
// read /proc/<pid>/cmdline and take the basename of argv[0]. A Proton/Wine process shows its exe path there
// (often `Z:\...\Game.exe` or `C:\...`), so we split on BOTH separators and match the bare `*.exe` name
// case-insensitively.
//
// The pure parsing/matching helpers below carry no electron/koffi/fs-at-import baggage, so they are unit-
// tested directly (test/proc.test.ts). The /proc read (scanProc) and the ProcessMonitor it powers use
// node:fs + process signals and are exercised on the device (smoke test — Р3, допущение §5.9).
import fs from 'node:fs/promises';
import type { ProcessMonitor, ProcessSnapshot } from './types';

/**
 * Splits a path on BOTH separators (`/` and `\`) and returns the last segment. Wine cmdline paths use
 * backslashes (`Z:\game\Game.exe`) while native paths use forward slashes; a bare name returns itself.
 * Trailing separators are ignored.
 */
export function pathBasename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * The process image name from a raw /proc/<pid>/cmdline (NUL-separated argv): the basename of argv[0]
 * (the executable), considering both separators. Returns null for an empty cmdline (kernel threads and
 * zombies have none).
 */
export function imageNameFromCmdline(cmdline: string): string | null {
  // argv entries are separated by NUL; a trailing NUL is common. argv[0] is the executable path.
  const argv0 = cmdline.split('\0')[0] ?? '';
  if (argv0 === '') return null;
  const base = pathBasename(argv0);
  return base === '' ? null : base;
}

/** Case-insensitive image-name equality (watched name is a bare `*.exe`; the scanned one is a basename). */
export function imageNameMatches(target: string, actual: string): boolean {
  return pathBasename(target).toLowerCase() === actual.toLowerCase();
}

/**
 * Whether a raw /proc/<pid>/environ blob (NUL-separated `KEY=VALUE`) tags the process with this Steam
 * appid. Steam stamps `SteamAppId` (and `SteamGameId`, equal for base games) on every game process, so
 * this identifies a running Steam game regardless of its binary name — the robust signal for BOTH native-
 * Linux and Proton games (whose process names differ from the manifest's Windows `*.exe`). Pure — tested.
 */
export function environHasSteamApp(environ: string, appid: number): boolean {
  const wanted = String(appid);
  for (const entry of environ.split('\0')) {
    const eq = entry.indexOf('=');
    if (eq === -1) continue;
    const key = entry.slice(0, eq);
    if ((key === 'SteamAppId' || key === 'SteamGameId') && entry.slice(eq + 1) === wanted) return true;
  }
  return false;
}

/** One scanned process: its pid and the resolved image name (null for kernel threads / unreadable cmdline). */
export interface ProcEntry {
  readonly pid: number;
  readonly imageName: string | null;
}

/**
 * Indexes scanned processes into a lower-cased image-name set + a pid set — the backing data for a
 * ProcessSnapshot. Pure (fs-free) so it is unit-tested.
 */
export function buildProcIndex(entries: readonly ProcEntry[]): {
  readonly names: ReadonlySet<string>;
  readonly pids: ReadonlySet<number>;
} {
  const names = new Set<string>();
  const pids = new Set<number>();
  for (const entry of entries) {
    pids.add(entry.pid);
    if (entry.imageName !== null) names.add(entry.imageName.toLowerCase());
  }
  return { names, pids };
}

/** Builds a ProcessSnapshot from indexed processes. A watched name matches by exact (case-insensitive)
 * basename — more precise than the win32 substring match, on purpose (Р3). Pure so it is unit-tested. */
export function snapshotFromEntries(entries: readonly ProcEntry[]): ProcessSnapshot {
  const { names, pids } = buildProcIndex(entries);
  return {
    hasImageName: (name) => names.has(pathBasename(name).toLowerCase()),
    hasPid: (pid) => pids.has(pid),
  };
}

// ── /proc read + the ProcessMonitor it powers (device-exercised) ─────────────

const KILL_SIGNALS = ['SIGTERM', 'SIGKILL'] as const;

/** One pass over /proc: numeric dirs → pids, argv[0] of each cmdline → image name. Any error → skip that
 * process (it exited between readdir and read, or we lack permission). */
async function scanProc(): Promise<readonly ProcEntry[]> {
  let dirents: readonly string[];
  try {
    dirents = await fs.readdir('/proc');
  } catch {
    return [];
  }
  const results = await Promise.all(
    dirents.map(async (name): Promise<ProcEntry | null> => {
      if (!/^\d+$/.test(name)) return null;
      const pid = Number.parseInt(name, 10);
      let cmdline = '';
      try {
        cmdline = await fs.readFile(`/proc/${name}/cmdline`, 'utf8');
      } catch {
        // Process gone or unreadable — still record the pid (it exists), with no image name.
      }
      return { pid, imageName: cmdline === '' ? null : imageNameFromCmdline(cmdline) };
    }),
  );
  return results.filter((entry): entry is ProcEntry => entry !== null);
}

/** Sends SIGTERM then SIGKILL to each pid (force-close: the game is being killed). Errors are swallowed —
 * an already-gone pid (ESRCH) or a not-permitted one is not our problem here (the caller poll-verifies). */
function signalPids(pids: Iterable<number>): void {
  for (const signal of KILL_SIGNALS) {
    for (const pid of pids) {
      try {
        process.kill(pid, signal);
      } catch {
        // already dead (ESRCH) / not permitted (EPERM) → nothing to do.
      }
    }
  }
}

/** Pids of every process tagged with this Steam appid (via /proc/<pid>/environ). Any read error → skip. */
async function steamAppPids(appid: number): Promise<readonly number[]> {
  let dirents: readonly string[];
  try {
    dirents = await fs.readdir('/proc');
  } catch {
    return [];
  }
  const matches = await Promise.all(
    dirents.map(async (name): Promise<number | null> => {
      if (!/^\d+$/.test(name)) return null;
      let environ = '';
      try {
        // environ is readable only for our own (same-user) processes — enough on Deck (games run as deck).
        environ = await fs.readFile(`/proc/${name}/environ`, 'utf8');
      } catch {
        return null;
      }
      return environHasSteamApp(environ, appid) ? Number.parseInt(name, 10) : null;
    }),
  );
  return matches.filter((pid): pid is number => pid !== null);
}

/** The linux /proc-backed ProcessMonitor. */
export function createLinuxProcessMonitor(): ProcessMonitor {
  const monitor: ProcessMonitor = {
    async snapshot(): Promise<ProcessSnapshot> {
      return snapshotFromEntries(await scanProc());
    },
    isPidAlive(pid): Promise<boolean> {
      try {
        // Signal 0 doesn't send anything — it just probes existence/permission. ESRCH → dead; EPERM →
        // alive but owned by another user (unlikely on Deck, but counts as alive).
        process.kill(pid, 0);
        return Promise.resolve(true);
      } catch (cause) {
        return Promise.resolve((cause as NodeJS.ErrnoException).code === 'EPERM');
      }
    },
    killTree(pid): Promise<void> {
      // Best-effort group kill (Р3): a child spawned with detached:true is its own process-group leader, so
      // `-pid` hits the group. wineserver does setsid and escapes the group, so the by-name sweep
      // (killByName) is the real mechanism; this is the cheap first step. Also signal the pid directly.
      for (const signal of KILL_SIGNALS) {
        try {
          process.kill(-pid, signal);
        } catch {
          // no such group / not permitted.
        }
        try {
          process.kill(pid, signal);
        } catch {
          // already dead / not permitted.
        }
      }
      return Promise.resolve();
    },
    async killByName(names): Promise<void> {
      const wanted = new Set(names.map((name) => pathBasename(name).toLowerCase()));
      if (wanted.size === 0) return;
      const entries = await scanProc();
      const pids = entries
        .filter((entry) => entry.imageName !== null && wanted.has(entry.imageName.toLowerCase()))
        .map((entry) => entry.pid);
      signalPids(pids);
    },
    // Primary signal: any process tagged with this Steam appid (native OR Proton). Fallback: the Windows-
    // style watch names, for odd setups where environ is unreadable.
    async isSteamGameRunning(appid, watchNames): Promise<boolean> {
      if ((await steamAppPids(appid)).length > 0) return true;
      if (watchNames.length === 0) return false;
      const snap = snapshotFromEntries(await scanProc());
      return watchNames.some((name) => snap.hasImageName(name));
    },
    async killSteamGame(appid, watchNames): Promise<void> {
      signalPids(await steamAppPids(appid));
      // Fallback sweep by the Windows watch names (Proton `.exe`) — harmless if none match.
      if (watchNames.length > 0) await monitor.killByName(watchNames);
    },
  };
  return monitor;
}
