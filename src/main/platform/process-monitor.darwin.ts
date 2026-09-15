// macOS ProcessMonitor backed by `ps`. There is no /proc on darwin and no way to read another
// process's environment without privileges, so a Steam game is identified the way win32 identifies it —
// by the watched image names — rather than by the `SteamAppId` tag the linux monitor keys on.
//
// The snapshot comes from `ps -axwwo pid=,comm=`: `-ww` disables the column truncation that would cut long
// bundle paths, and `comm` is the executable's full path, so the basename is a reliable image name.
//
// Name matching normalizes the `.exe` suffix away on BOTH sides: a card written for Windows/Deck
// stores `valheim.exe`, while the native mac process is `valheim`. A mac-only record may store the bare
// name; both spellings therefore match the same process.
//
// The pure parsing/matching helpers carry no fs/electron baggage and are unit-tested
// (test/process-monitor-darwin.test.ts); the `ps` calls and signals are exercised on a real mac.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProcessMonitor, ProcessSnapshot } from './types';
import { pathBasename } from './proc';
import { delay } from '../util';

const execFileAsync = promisify(execFile);

/** How long a SIGTERM is given to work before the tree is SIGKILLed (force-close is already the last resort). */
const KILL_GRACE_MS = 2000;

/** One process seen by `ps`: its pid and the basename of its executable (null when the line carried none). */
export interface DarwinProcEntry {
  readonly pid: number;
  readonly imageName: string | null;
}

/** One parent link from `ps -axo pid=,ppid=`. */
export interface DarwinProcParent {
  readonly pid: number;
  readonly ppid: number;
}

/**
 * A comparable image name: the basename (both separators, so a Windows-dictionary `dir\game.exe` also
 * reduces), lower-cased, with a trailing `.exe` dropped. Dropping the suffix is what lets a card written
 * for Windows match the native mac binary of the same game. Pure.
 */
export function normalizeImageName(name: string): string {
  return pathBasename(name).toLowerCase().replace(/\.exe$/, '');
}

/**
 * Parses `ps -axwwo pid=,comm=` output into entries. A line is `<spaces><pid> <command path>`; the command
 * may contain spaces (`/Applications/My Game.app/Contents/MacOS/My Game`), so only the FIRST field is
 * split off. Unparseable and empty lines are skipped. Pure.
 */
export function parsePsCommand(stdout: string): readonly DarwinProcEntry[] {
  const entries: DarwinProcEntry[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const pid = Number.parseInt(match[1] ?? '', 10);
    if (!Number.isFinite(pid)) continue;
    const command = (match[2] ?? '').trim();
    entries.push({ pid, imageName: command === '' ? null : pathBasename(command) });
  }
  return entries;
}

/** Parses `ps -axo pid=,ppid=` output into parent links. Unparseable lines are skipped. Pure. */
export function parsePsParents(stdout: string): readonly DarwinProcParent[] {
  const links: DarwinProcParent[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match === null) continue;
    const pid = Number.parseInt(match[1] ?? '', 10);
    const ppid = Number.parseInt(match[2] ?? '', 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    links.push({ pid, ppid });
  }
  return links;
}

/** Builds a ProcessSnapshot over parsed `ps` entries: exact normalized-basename match, like linux. Pure. */
export function snapshotFromEntries(entries: readonly DarwinProcEntry[]): ProcessSnapshot {
  const names = new Set<string>();
  const pids = new Set<number>();
  for (const entry of entries) {
    pids.add(entry.pid);
    if (entry.imageName !== null) names.add(normalizeImageName(entry.imageName));
  }
  return {
    hasImageName: (name) => names.has(normalizeImageName(name)),
    hasPid: (pid) => pids.has(pid),
  };
}

/**
 * The pid plus every descendant of it, walking the parent links breadth-first. `ps` gives no tree, so the
 * whole "kill the tree" idea has to be rebuilt from the flat pid/ppid list. A cycle (impossible in a real
 * process table, cheap to guard) cannot loop this: a pid is expanded at most once. Pure.
 */
export function descendantPids(root: number, links: readonly DarwinProcParent[]): readonly number[] {
  const childrenOf = new Map<number, number[]>();
  for (const link of links) {
    const siblings = childrenOf.get(link.ppid);
    if (siblings === undefined) childrenOf.set(link.ppid, [link.pid]);
    else siblings.push(link.pid);
  }
  const collected = new Set<number>([root]);
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift() ?? 0;
    for (const child of childrenOf.get(current) ?? []) {
      if (collected.has(child)) continue;
      collected.add(child);
      queue.push(child);
    }
  }
  return [...collected];
}

/** One `ps` pass over the process table. Any error → no entries (everything reads as absent — "error = dead"). */
async function scanProcesses(): Promise<readonly DarwinProcEntry[]> {
  try {
    const { stdout } = await execFileAsync('ps', ['-axwwo', 'pid=,comm=']);
    return parsePsCommand(stdout);
  } catch {
    return [];
  }
}

/** One `ps` pass over the pid→ppid links (only needed by killTree). Any error → no links. */
async function scanParents(): Promise<readonly DarwinProcParent[]> {
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=']);
    return parsePsParents(stdout);
  } catch {
    return [];
  }
}

/** Sends one signal to each pid, swallowing "already gone" (ESRCH) and "not permitted" (EPERM). */
function signalPids(pids: Iterable<number>, signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // already dead (ESRCH) / not permitted (EPERM) → nothing to do.
    }
  }
}

/**
 * Which of these pids are still there, a grace period after SIGTERM. Blindly following up with SIGKILL
 * would aim it at whatever the OS has since given the number to.
 */
function stillAlive(pids: readonly number[]): readonly number[] {
  return pids.filter((candidate) => {
    try {
      process.kill(candidate, 0);
      return true;
    } catch (cause) {
      // EPERM means it exists and belongs to another user; ESRCH means it is gone.
      return (cause as NodeJS.ErrnoException).code === 'EPERM';
    }
  });
}

/** The macOS `ps`-backed ProcessMonitor. */
export function createDarwinProcessMonitor(): ProcessMonitor {
  const monitor: ProcessMonitor = {
    async snapshot(): Promise<ProcessSnapshot> {
      return snapshotFromEntries(await scanProcesses());
    },
    isPidAlive(pid): Promise<boolean> {
      try {
        // Signal 0 only probes existence/permission. ESRCH → dead; EPERM → alive but another user's.
        process.kill(pid, 0);
        return Promise.resolve(true);
      } catch (cause) {
        return Promise.resolve((cause as NodeJS.ErrnoException).code === 'EPERM');
      }
    },
    async killTree(pid): Promise<void> {
      const pids = descendantPids(pid, await scanParents());
      signalPids(pids, 'SIGTERM');
      await delay(KILL_GRACE_MS);
      signalPids(stillAlive(pids), 'SIGKILL');
    },
    async killByName(names): Promise<void> {
      const wanted = new Set(names.map(normalizeImageName));
      if (wanted.size === 0) return;
      const entries = await scanProcesses();
      const pids = entries
        .filter((entry) => entry.imageName !== null && wanted.has(normalizeImageName(entry.imageName)))
        .map((entry) => entry.pid);
      if (pids.length === 0) return;
      signalPids(pids, 'SIGTERM');
      await delay(KILL_GRACE_MS);
      // The same re-check killTree does, and for the same reason: the list was built a grace period ago,
      // and a pid whose process honoured SIGTERM may by now belong to something else entirely.
      signalPids(stillAlive(pids), 'SIGKILL');
    },
    // A mac process carries no readable Steam tag, so the watched image names ARE the running signal —
    // the same rule win32 uses. The appid is unused here.
    async isSteamGameRunning(_appid, watchNames): Promise<boolean> {
      if (watchNames.length === 0) return false;
      const snap = await monitor.snapshot();
      return watchNames.some((name) => snap.hasImageName(name));
    },
    killSteamGame(_appid, watchNames): Promise<void> {
      return monitor.killByName(watchNames);
    },
    // No elevated launch on macOS (runAsAdmin is a no-op there), so there is nothing to kill elevated.
    killImagesElevated: () => undefined,
  };
  return monitor;
}
