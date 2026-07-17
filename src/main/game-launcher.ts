// Launching the game and detecting when it closes.
// Two launch paths, dispatched by manifest.raw.runAsAdmin:
//
// 1. Normal (default): `spawn` the .exe. We've settled on a direct self-contained .exe → the pid from
//    spawn is stable. We watch for exit through the injected ProcessMonitor (win32: `tasklist`;
//    linux: /proc), with debounce N=3 — the launcher stays platform-agnostic.
//
// 2. Elevated (runAsAdmin, win32 only): `spawn` cannot raise rights, so an .exe whose embedded manifest
//    requires administrator fails with EACCES (CreateProcess → ERROR_ELEVATION_REQUIRED 740). We launch it
//    via ShellExecuteExW with the "runas" verb (triggers UAC) through koffi (same FFI pattern as
//    gamepad-global.ts). Monitoring CANNOT go through `tasklist` here — see the limitation below — so we keep
//    the real process HANDLE and poll it with WaitForSingleObject, bypassing the monitor entirely.
//
// Both paths return a GameProcess, so waitForStart/waitForExit stay agnostic. Process-polling is started
// ONLY by the controller and only in launching/running.
//
// Limitation: from a non-elevated app, `tasklist` does NOT see an elevated process — that is exactly
// why the elevated path watches by HANDLE instead. For a normal direct .exe we assume the rights suffice.
import path from 'node:path';
import { spawn } from 'node:child_process';
import koffi from 'koffi';
import {
  type LaunchTarget,
  type ResolvedManifest,
  type ResolvedInstallerRun,
} from '../shared/types';
import { type ProcessMonitor, type ProcessSnapshot } from './platform/types';
import { buildInstallerArgs, buildParameters } from './launch-args';
import { delay } from './util';
import { log } from './logger';

const START_POLL_INTERVAL_MS = 1000;
const EXIT_POLL_INTERVAL_MS = 2500;
const EXIT_DEBOUNCE_READS = 3;

export class LaunchAbortedError extends Error {
  constructor() {
    super('launch wait aborted');
    this.name = 'LaunchAbortedError';
  }
}

/**
 * A launched game, abstracting the two launch backends so the wait loops don't care which was used.
 * `pid` is the real pid for the normal path, 0 for the elevated path (we monitor by HANDLE there).
 */
export interface GameProcess {
  readonly pid: number;
  isAlive(): Promise<boolean>;
  /**
   * Force-terminates the process (force-close from the More menu). Normal path: `taskkill /PID <pid> /T
   * /F` (the whole tree), guarded by an isAlive() re-check so a reused pid can't take down an unrelated
   * process. Elevated path: TerminateProcess on the kept HANDLE, done synchronously (no await before the
   * FFI call) and skipped if dispose() already closed the handle. Errors are swallowed — the caller
   * decides success by a fact-based control poll, not this call's outcome.
   */
  kill(): Promise<void>;
  /** Releases the kept HANDLE (elevated path); no-op for the normal path. */
  dispose(): void;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new LaunchAbortedError();
}

/**
 * True if any watched image name is present in the process snapshot. The matching SEMANTICS are a platform
 * detail (win32: substring over a tasklist CSV; linux: exact basename over /proc — see ProcessMonitor),
 * so callers just pass bare image names.
 */
function anyVisible(snapshot: ProcessSnapshot, watchNames: readonly string[]): boolean {
  return watchNames.some((name) => snapshot.hasImageName(name));
}

// ── Win32 FFI for elevated launch (ShellExecuteEx "runas") ───────────────────
// Mirrors the koffi pattern in gamepad-global.ts. The struct/union definitions are pure metadata
// (safe on any OS, evaluated at import time); the DLLs are loaded lazily on first elevated launch so
// dev builds on macOS don't fail on import. All prototypes use __stdcall (R: needed for ia32; harmless
// on x64) — same as XInputGetState in gamepad-global.ts.

const SEE_MASK_NOCLOSEPROCESS = 0x40; // keep info.hProcess valid after the call
const SW_SHOWNORMAL = 1;
const SW_HIDE = 0; // hide the elevated taskkill's console window (the UAC prompt is separate)
const ERROR_CANCELLED = 1223; // GetLastError after the user clicks "No" in the UAC prompt
const WAIT_TIMEOUT = 0x102; // WaitForSingleObject: object still alive (WAIT_OBJECT_0 = 0 means exited)

// koffi.handle() was removed in 3.0 → an opaque pointer. HANDLEs come back as BigInt (0n = NULL).
const HANDLE = koffi.pointer('HANDLE', koffi.opaque());

// Declare EVERY field in order — koffi computes size/offsets from the declared members, so a shortened
// struct would misplace cbSize and the hProcess offset (padding after nShow on x64). The union member is
// declared inline via koffi.union (supported in koffi 3.x).
koffi.union('SHELLEXEC_U', { hIcon: HANDLE, hMonitor: HANDLE });
koffi.struct('SHELLEXECUTEINFOW', {
  cbSize: 'uint32',
  fMask: 'uint32',
  hwnd: HANDLE,
  lpVerb: 'str16',
  lpFile: 'str16',
  lpParameters: 'str16',
  lpDirectory: 'str16',
  nShow: 'int',
  hInstApp: HANDLE,
  lpIDList: 'void *',
  lpClass: 'str16',
  hkeyClass: HANDLE,
  dwHotKey: 'uint32',
  DUMMYUNIONNAME: 'SHELLEXEC_U',
  hProcess: HANDLE,
});

/** JS shape marshalled into SHELLEXECUTEINFOW. Unused HANDLE/pointer fields are passed as null. */
interface ShellExecuteInfo {
  cbSize: number;
  fMask: number;
  hwnd: bigint | null;
  lpVerb: string;
  lpFile: string;
  lpParameters: string | null;
  lpDirectory: string;
  nShow: number;
  hInstApp: bigint | null;
  lpIDList: bigint | null;
  lpClass: string | null;
  hkeyClass: bigint | null;
  dwHotKey: number;
  DUMMYUNIONNAME: { readonly hIcon: bigint | null };
  hProcess: bigint; // read back after the call (0n = no process created)
}

type ShellExecuteExWFn = (info: ShellExecuteInfo) => number;
type WaitForSingleObjectFn = (handle: bigint, milliseconds: number) => number;
type CloseHandleFn = (handle: bigint) => number;
type GetLastErrorFn = () => number;
type TerminateProcessFn = (handle: bigint, exitCode: number) => number;

interface ShellLib {
  readonly ShellExecuteExW: ShellExecuteExWFn;
}
interface KernelLib {
  readonly WaitForSingleObject: WaitForSingleObjectFn;
  readonly CloseHandle: CloseHandleFn;
  readonly GetLastError: GetLastErrorFn;
  readonly TerminateProcess: TerminateProcessFn;
}

// Exit code handed to TerminateProcess for a force-closed game (arbitrary non-zero — the game is being
// killed, not exiting cleanly).
const KILL_EXIT_CODE = 1;

let shellLib: ShellLib | null = null;
let kernelLib: KernelLib | null = null;

function loadShell(): ShellLib {
  if (shellLib !== null) return shellLib;
  const lib = koffi.load('shell32.dll');
  // _Inout_ for a struct carrying cbSize (koffi requires _Inout_, not _Out_, for these — doc/output.md).
  const ShellExecuteExW = lib.func(
    'int __stdcall ShellExecuteExW(_Inout_ SHELLEXECUTEINFOW *pExecInfo)',
  ) as unknown as ShellExecuteExWFn;
  shellLib = { ShellExecuteExW };
  return shellLib;
}

function loadKernel(): KernelLib {
  if (kernelLib !== null) return kernelLib;
  const lib = koffi.load('kernel32.dll');
  const WaitForSingleObject = lib.func(
    'uint32 __stdcall WaitForSingleObject(HANDLE hHandle, uint32 dwMilliseconds)',
  ) as unknown as WaitForSingleObjectFn;
  const CloseHandle = lib.func(
    'int __stdcall CloseHandle(HANDLE hObject)',
  ) as unknown as CloseHandleFn;
  const GetLastError = lib.func('uint32 __stdcall GetLastError()') as unknown as GetLastErrorFn;
  const TerminateProcess = lib.func(
    'int __stdcall TerminateProcess(HANDLE hProcess, uint32 uExitCode)',
  ) as unknown as TerminateProcessFn;
  kernelLib = { WaitForSingleObject, CloseHandle, GetLastError, TerminateProcess };
  return kernelLib;
}

/**
 * Force-kills the given image names ELEVATED: ShellExecuteExW("runas") runs
 * `taskkill /F /T /IM <name> …` — ONE UAC prompt for the whole set. Needed for a runAsAdmin game whose
 * high-integrity processes a non-elevated taskkill can't touch (ACCESS_DENIED) and whose ShellExecuteEx
 * HANDLE lacks PROCESS_TERMINATE. Synchronous like launchElevated (koffi .async can't read GetLastError);
 * the UAC dialog blocks the main thread briefly, which is fine while a game is running (input is ignored).
 * We do NOT wait for taskkill to finish — it runs on after we release our handle; the caller's control
 * poll decides success by fact. Best-effort: a declined UAC (GetLastError 1223) or any failure is logged
 * and swallowed. No-op off Windows / with no names.
 */
export function killImagesElevated(imageNames: readonly string[]): void {
  if (process.platform !== 'win32' || imageNames.length === 0) return;
  const shell = loadShell();
  const kernel = loadKernel();
  const args = ['/F', '/T'];
  for (const name of imageNames) args.push('/IM', name);
  const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
  const system32 = path.join(systemRoot, 'System32');
  const info: ShellExecuteInfo = {
    cbSize: koffi.sizeof('SHELLEXECUTEINFOW'),
    fMask: SEE_MASK_NOCLOSEPROCESS,
    hwnd: null,
    lpVerb: 'runas',
    lpFile: path.join(system32, 'taskkill.exe'),
    lpParameters: buildParameters(args),
    lpDirectory: system32,
    nShow: SW_HIDE,
    hInstApp: null,
    lpIDList: null,
    lpClass: null,
    hkeyClass: null,
    dwHotKey: 0,
    DUMMYUNIONNAME: { hIcon: null },
    hProcess: 0n,
  };
  try {
    const ok = shell.ShellExecuteExW(info);
    if (ok === 0) {
      // 1223 = ERROR_CANCELLED (user clicked "No" on UAC) — the caller's poll then reports killFailed.
      log.warn(`[kill] elevated taskkill failed to start (GetLastError=${kernel.GetLastError()})`);
      return;
    }
    // Release our reference — taskkill keeps running to completion; we don't block on it.
    if (info.hProcess !== 0n) kernel.CloseHandle(info.hProcess);
  } catch (cause) {
    log.warn('[kill] elevated taskkill threw:', cause instanceof Error ? cause.message : String(cause));
  }
}

/**
 * How the OS command line is formed — a game and a (pre-quoted, silent) installer differ:
 * - `verbatim`: the args are FINAL tokens, passed through without Node/CommandLineToArgvW quoting
 *   (the installer family's quoting is already baked into them by buildInstallerArgs).
 * - `hide`: hide the spawned process's console window (silent install — there is no window).
 */
interface LaunchMode {
  readonly verbatim: boolean;
  readonly hide: boolean;
}

const GAME_MODE: LaunchMode = { verbatim: false, hide: false };
const INSTALLER_MODE: LaunchMode = { verbatim: true, hide: true };
// Interactive installer (user disabled silent mode): same verbatim arg passthrough, but the wizard window
// is shown (not hidden) so the user can click through it — incl. steps a silent install would skip.
const INSTALLER_INTERACTIVE_MODE: LaunchMode = { verbatim: true, hide: false };
// Uninstaller: hidden (silent), but verbatim:FALSE — unlike the installer, the uninstaller target's
// file/args are LOGICAL tokens (a found .exe path possibly with spaces/Cyrillic, or registry-parsed
// argv), so Node/CommandLineToArgvW quoting must re-quote them correctly.
const UNINSTALLER_MODE: LaunchMode = { verbatim: false, hide: true };

/**
 * Normal launch: spawn the file and watch by pid via the injected ProcessMonitor (win32: tasklist; linux:
 * /proc). Behaviour for games is 1:1 with the pre-port code on Windows.
 */
async function launchNormal(
  target: LaunchTarget,
  mode: LaunchMode,
  monitor: ProcessMonitor,
): Promise<GameProcess> {
  return new Promise<GameProcess>((resolve, reject) => {
    const child = spawn(target.file, [...target.args], {
      cwd: target.cwd,
      detached: false,
      stdio: 'ignore',
      windowsHide: mode.hide,
      // For the installer the args are pre-quoted final tokens (e.g. NSIS `/D=` unquoted, Inno
      // `/DIR="..."` with inner quotes): verbatim stops Node from re-quoting and joins them as-is.
      windowsVerbatimArguments: mode.verbatim,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      if (typeof child.pid !== 'number') {
        reject(new Error('process started without a pid'));
        return;
      }
      // From here we watch by pid via tasklist; we don't let the direct child reference keep
      // error handlers "dangling" — we remove the error listener.
      const pid = child.pid;
      child.removeListener('error', reject);
      child.unref();
      resolve({
        pid,
        isAlive: () => monitor.isPidAlive(pid),
        kill: async () => {
          // Reused-pid guard: `running` can outlive the real process by ~7.5s (the exit debounce), so a
          // blind kill-tree could take down an unrelated process that inherited this pid. Only kill while
          // the pid is still alive — accepting the tiny residual TOCTOU as best-effort.
          if (await monitor.isPidAlive(pid)) await monitor.killTree(pid);
        },
        dispose: () => {},
      });
    });
  });
}

/**
 * Elevated launch: ShellExecuteExW with verb "runas" (UAC). Synchronous on purpose (see the limitation above): koffi's
 * .async() is callback-style and GetLastError isn't readable from a worker thread; the UAC dialog is a
 * few seconds and gamepad input is ignored outside `ready`, so the brief block is acceptable.
 */
function launchElevated(target: LaunchTarget, mode: LaunchMode): GameProcess {
  if (process.platform !== 'win32') {
    throw new Error('elevated launch (runAsAdmin) is Windows-only');
  }
  const shell = loadShell();
  const kernel = loadKernel();

  const args = target.args;
  // Game args are logical → CommandLineToArgvW-quoted; installer args are final tokens (already
  // quoted per the installer family) → joined raw, so we don't double-quote `/DIR="..."` etc.
  const parameters = mode.verbatim ? args.join(' ') : buildParameters(args);
  const info: ShellExecuteInfo = {
    cbSize: koffi.sizeof('SHELLEXECUTEINFOW'),
    fMask: SEE_MASK_NOCLOSEPROCESS,
    hwnd: null,
    lpVerb: 'runas',
    lpFile: target.file,
    lpParameters: args.length > 0 ? parameters : null,
    lpDirectory: target.cwd,
    nShow: SW_SHOWNORMAL,
    hInstApp: null,
    lpIDList: null,
    lpClass: null,
    hkeyClass: null,
    dwHotKey: 0,
    DUMMYUNIONNAME: { hIcon: null },
    hProcess: 0n,
  };

  const ok = shell.ShellExecuteExW(info);
  if (ok === 0) {
    const code = kernel.GetLastError();
    if (code === ERROR_CANCELLED) {
      throw new Error('launch cancelled by user (UAC)');
    }
    throw new Error(`elevated launch failed (ShellExecuteExW, GetLastError=${code})`);
  }
  const handle = info.hProcess;
  if (handle === 0n) {
    // The verb succeeded but no process was created (e.g. an OpenWith dialog) → fail fast, don't wait
    // for the start timeout.
    throw new Error('elevated launch did not create a process');
  }
  // Guards the HANDLE lifetime: dispose() sets it and closes the handle; kill() no-ops once set so we
  // never TerminateProcess a closed (potentially reused) handle. Both run synchronously on the single JS
  // thread, so a kill() can't interleave with a dispose() between reading the flag and the FFI call.
  let disposed = false;
  return {
    pid: 0, // elevated marker; we monitor by HANDLE (GetProcessId is not bound).
    isAlive: () =>
      Promise.resolve(!disposed && kernel.WaitForSingleObject(handle, 0) === WAIT_TIMEOUT),
    kill: () => {
      // Synchronous up to the FFI call — no await between reading `disposed` and TerminateProcess.
      if (!disposed) {
        const ok = kernel.TerminateProcess(handle, KILL_EXIT_CODE);
        if (ok === 0) {
          // Undocumented whether SEE_MASK_NOCLOSEPROCESS grants PROCESS_TERMINATE (see K-Д1) — leave a
          // breadcrumb; the controller's control poll turns a still-alive game into errors.killFailed.
          log.warn(`[kill] TerminateProcess failed (GetLastError=${kernel.GetLastError()})`);
        }
      }
      return Promise.resolve();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      kernel.CloseHandle(handle);
    },
  };
}

/** Dispatches a LaunchTarget to the elevated (UAC, win32-only) or normal backend per `target.runAsAdmin`.
 * The elevated backend monitors by HANDLE (koffi), so it ignores the ProcessMonitor. */
async function launch(
  target: LaunchTarget,
  mode: LaunchMode,
  monitor: ProcessMonitor,
): Promise<GameProcess> {
  if (target.runAsAdmin) {
    return launchElevated(target, mode);
  }
  return launchNormal(target, mode, monitor);
}

/** Launches the game .exe (elevated or normal per the manifest) and returns a GameProcess. Throws on failure. */
export async function launchGame(
  manifest: ResolvedManifest,
  monitor: ProcessMonitor,
): Promise<GameProcess> {
  const target: LaunchTarget = {
    file: manifest.executablePath,
    args: manifest.raw.args,
    cwd: manifest.cwd,
    runAsAdmin: manifest.raw.runAsAdmin,
  };
  return launch(target, GAME_MODE, monitor);
}

/**
 * Launches the installer, feeding it the app-controlled install directory through the family's dir-key.
 * `silent` (from settings) picks unattended vs a visible wizard (see buildInstallerArgs / the launch mode).
 * cwd is the installer's own folder on the card (the install dir may not exist yet — it was just
 * pre-cleaned, and the installer creates it). Returns a GameProcess; throws on failure.
 */
export async function launchInstaller(
  install: ResolvedInstallerRun,
  silent: boolean,
  monitor: ProcessMonitor,
): Promise<GameProcess> {
  const target: LaunchTarget = {
    file: install.installerPath,
    // win32: installer-view dir == host dir; quoteDir:true bakes Inno's quotes for verbatim passthrough.
    args: buildInstallerArgs(install.type, install.installerDir, install.args, true, silent),
    cwd: path.dirname(install.installerPath),
    runAsAdmin: install.runAsAdmin,
  };
  return launch(target, silent ? INSTALLER_MODE : INSTALLER_INTERACTIVE_MODE, monitor);
}

/**
 * Launches a game's own uninstaller silently. The target is resolved by the controller
 * (resolveUninstaller): either an .exe found in the install dir with self-built silent flags, or a
 * command parsed from the registry. UNINSTALLER_MODE uses verbatim:false so the logical file/args are
 * re-quoted correctly (paths with spaces / Cyrillic). Returns a GameProcess; throws on failure.
 */
export async function launchUninstaller(
  target: LaunchTarget,
  monitor: ProcessMonitor,
): Promise<GameProcess> {
  return launch(target, UNINSTALLER_MODE, monitor);
}

/**
 * Waits for a live process to appear within `launchTimeoutSec`.
 * true — process is visible; false — timeout (false start / UAC).
 */
export async function waitForStart(
  proc: GameProcess,
  launchTimeoutSec: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + launchTimeoutSec * 1000;
  for (;;) {
    throwIfAborted(signal);
    if (await proc.isAlive()) return true;
    if (Date.now() >= deadline) return false;
    await delay(START_POLL_INTERVAL_MS);
  }
}

/**
 * Waits for the game to close: resolves after N=3 consecutive "process not found" reads (debounce).
 */
export async function waitForExit(proc: GameProcess, signal?: AbortSignal): Promise<void> {
  let missedReads = 0;
  for (;;) {
    throwIfAborted(signal);
    const alive = await proc.isAlive();
    if (alive) {
      missedReads = 0;
    } else {
      missedReads += 1;
      if (missedReads >= EXIT_DEBOUNCE_READS) return;
    }
    await delay(EXIT_POLL_INTERVAL_MS);
  }
}

// ── Watched-process path (launcher/wrapper games, manifest.watchProcesses) ───
// The launcher is spawned as usual; the GAME runs in a separate process named by watchProcesses. Each
// poll reads ONE snapshot and derives two signals: gameVisible (any watched image present) and
// launcherAlive (the spawned launcher's pid present). We track the game by presence and use the
// launcher's liveness only to avoid a false timeout while the user sits in the launcher menu/config.

/**
 * HANDOFF phase: wait for a watched game process to appear after launch.
 * `launcherPid` is the spawned launcher's pid (normal/install path), or `null` in Steam mode — there is
 * no launcher process we own (steam:// returns instantly). When null we skip the launcher-liveness logic
 * entirely and rely ONLY on `initialDeadline = graceSec`: a sentinel pid (e.g. "0") would falsely match
 * "System Idle Process" in tasklist and wait forever.
 */
export async function waitForWatchedStart(
  launcherPid: number | null,
  watchNames: readonly string[],
  graceSec: number,
  monitor: ProcessMonitor,
  signal?: AbortSignal,
): Promise<{ readonly started: boolean }> {
  const startedAt = Date.now();
  // Deadline for "the launcher never even appeared" (tasklist lag right after spawn — see below).
  const initialDeadline = startedAt + graceSec * 1000;
  // Grace deadline once the launcher was alive and then died without the game showing up; null until then.
  let graceDeadline: number | null = null;
  let launcherSeenAlive = false;

  for (;;) {
    throwIfAborted(signal);
    const snapshot = await monitor.snapshot();
    const gameVisible = anyVisible(snapshot, watchNames);
    if (gameVisible) return { started: true };

    if (launcherPid === null) {
      // Steam mode: no launcher of our own — the only signal is the watched game appearing within the
      // window. If it doesn't, conclude "not started" (Steam may be cold-starting / auto-updating).
      if (Date.now() >= initialDeadline) return { started: false };
      await delay(START_POLL_INTERVAL_MS);
      continue;
    }

    const launcherAlive = snapshot.hasPid(launcherPid);
    if (launcherAlive) {
      // The user may sit in the launcher (Steam sync, config, resolution picker) indefinitely — no timeout.
      launcherSeenAlive = true;
    } else if (launcherSeenAlive) {
      // The launcher was alive and is now gone, but the game never appeared → start a grace deadline.
      graceDeadline ??= Date.now() + graceSec * 1000;
      if (Date.now() >= graceDeadline) return { started: false };
    } else if (Date.now() >= initialDeadline) {
      // Never seen alive: this is tasklist lag right after spawn — NOT a death. We keep polling within the
      // initial window; only once it elapses do we conclude the launcher never showed up.
      return { started: false };
    }
    await delay(START_POLL_INTERVAL_MS);
  }
}

/** RUNNING phase: resolves after N=3 consecutive reads with no watched process present (debounce). */
export async function waitForWatchedExit(
  watchNames: readonly string[],
  monitor: ProcessMonitor,
  signal?: AbortSignal,
): Promise<void> {
  let missedReads = 0;
  for (;;) {
    throwIfAborted(signal);
    const snapshot = await monitor.snapshot();
    if (anyVisible(snapshot, watchNames)) {
      missedReads = 0;
    } else {
      missedReads += 1;
      if (missedReads >= EXIT_DEBOUNCE_READS) return;
    }
    await delay(EXIT_POLL_INTERVAL_MS);
  }
}

// ── Steam-mode waits ─────────────────────────────────────────────────────────
// Steam mode has no launcher pid of ours (steam://rungameid returns instantly), so "is the game up?" is
// asked of the ProcessMonitor by appid: on win32 that maps to the watch image names (Windows Steam runs
// the `.exe`), on linux to the SteamAppId in /proc environ (robust for native AND Proton games). Mirrors
// waitForWatchedStart(launcherPid=null) / waitForWatchedExit, only the "visible" signal differs.

/** HANDOFF: wait for the Steam game (by appid) to appear within `graceSec`. */
export async function waitForSteamStart(
  appid: number,
  watchNames: readonly string[],
  graceSec: number,
  monitor: ProcessMonitor,
  signal?: AbortSignal,
): Promise<{ readonly started: boolean }> {
  const deadline = Date.now() + graceSec * 1000;
  for (;;) {
    throwIfAborted(signal);
    if (await monitor.isSteamGameRunning(appid, watchNames)) return { started: true };
    if (Date.now() >= deadline) return { started: false };
    await delay(START_POLL_INTERVAL_MS);
  }
}

/** RUNNING: resolve after N=3 consecutive reads with the Steam game (by appid) absent (debounce). */
export async function waitForSteamExit(
  appid: number,
  watchNames: readonly string[],
  monitor: ProcessMonitor,
  signal?: AbortSignal,
): Promise<void> {
  let missedReads = 0;
  for (;;) {
    throwIfAborted(signal);
    if (await monitor.isSteamGameRunning(appid, watchNames)) {
      missedReads = 0;
    } else {
      missedReads += 1;
      if (missedReads >= EXIT_DEBOUNCE_READS) return;
    }
    await delay(EXIT_POLL_INTERVAL_MS);
  }
}
