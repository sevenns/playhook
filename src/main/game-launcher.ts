// Launching the game and detecting when it closes (stage 6, A2/R4).
// Two launch paths, dispatched by manifest.raw.runAsAdmin:
//
// 1. Normal (default): `spawn` the .exe. We've settled on a direct self-contained .exe → the pid from
//    spawn is stable. We watch for exit via the built-in `tasklist /FI "PID eq <pid>"` (no ps-list
//    dependency and no ESM conflict), with debounce N=3.
//
// 2. Elevated (runAsAdmin): `spawn` cannot raise rights, so an .exe whose embedded manifest requires
//    administrator fails with EACCES (CreateProcess → ERROR_ELEVATION_REQUIRED 740). We launch it via
//    ShellExecuteExW with the "runas" verb (triggers UAC) through koffi (same FFI pattern as
//    gamepad-global.ts). Monitoring CANNOT go through `tasklist` here — limitation R4 below — so we keep
//    the real process HANDLE and poll it with WaitForSingleObject, bypassing tasklist entirely.
//
// Both paths return a GameProcess, so waitForStart/waitForExit stay agnostic. Process-polling is started
// ONLY by the controller and only in launching/running.
//
// Limitation (R4): from a non-elevated app, `tasklist` does NOT see an elevated process — that is exactly
// why the elevated path watches by HANDLE instead. For a normal direct .exe we assume the rights suffice.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import koffi from 'koffi';
import { type ResolvedManifest } from '../shared/types';

const execFileAsync = promisify(execFile);

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
  /** Releases the kept HANDLE (elevated path); no-op for the normal path. */
  dispose(): void;
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new LaunchAbortedError();
}

/**
 * Single unfiltered `tasklist /NH /FO CSV` snapshot, lower-cased. One process spawn per poll iteration
 * (vs N for per-name filters) and an atomic view of all visible processes. Watched-image presence is a
 * substring check against this stdout — no CSV column parsing, exactly like `isProcessAlive` does for a
 * pid. Any error → empty string (everything reads as absent), matching the "error = dead" convention.
 */
async function snapshotProcesses(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('tasklist', ['/NH', '/FO', 'CSV'], { windowsHide: true });
    return stdout.toLowerCase();
  } catch {
    return '';
  }
}

/** True if any watched image name (already lower-cased) is present in the snapshot. */
function anyVisible(snapshot: string, watchNames: readonly string[]): boolean {
  return watchNames.some((name) => snapshot.includes(name));
}

/** Checks whether the process with the given pid is alive, via `tasklist`. Any error → treated as dead. */
async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'tasklist',
      ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'],
      { windowsHide: true },
    );
    // The CSV line contains the pid in quotes: "image","<pid>",... Absence → "INFO: No tasks".
    return stdout.includes(`"${pid}"`);
  } catch {
    return false;
  }
}

// ── Win32 FFI for elevated launch (ShellExecuteEx "runas") ───────────────────
// Mirrors the koffi pattern in gamepad-global.ts. The struct/union definitions are pure metadata
// (safe on any OS, evaluated at import time); the DLLs are loaded lazily on first elevated launch so
// dev builds on macOS don't fail on import. All prototypes use __stdcall (R: needed for ia32; harmless
// on x64) — same as XInputGetState in gamepad-global.ts.

const SEE_MASK_NOCLOSEPROCESS = 0x40; // keep info.hProcess valid after the call
const SW_SHOWNORMAL = 1;
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

interface ShellLib {
  readonly ShellExecuteExW: ShellExecuteExWFn;
}
interface KernelLib {
  readonly WaitForSingleObject: WaitForSingleObjectFn;
  readonly CloseHandle: CloseHandleFn;
  readonly GetLastError: GetLastErrorFn;
}

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
  kernelLib = { WaitForSingleObject, CloseHandle, GetLastError };
  return kernelLib;
}

/**
 * Quotes a single argument for ShellExecuteEx's raw lpParameters command line, following the
 * CommandLineToArgvW rules (backslashes are literal except before a quote). spawn did this for us;
 * the elevated path passes one raw string, so we must quote args containing whitespace or quotes.
 */
function quoteArg(arg: string): string {
  if (arg.length > 0 && !/[\s"]/.test(arg)) return arg;
  let result = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      // Escape the run of backslashes (each doubled) plus the quote itself.
      result += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    result += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  // Trailing backslashes precede the closing quote → double them so they stay literal.
  result += '\\'.repeat(backslashes * 2) + '"';
  return result;
}

function buildParameters(args: readonly string[]): string {
  return args.map(quoteArg).join(' ');
}

/** Normal launch: spawn the .exe and watch by pid via tasklist. Behaviour is 1:1 with the old code. */
async function launchNormal(manifest: ResolvedManifest): Promise<GameProcess> {
  return new Promise<GameProcess>((resolve, reject) => {
    const child = spawn(manifest.executablePath, [...manifest.raw.args], {
      cwd: manifest.cwd,
      detached: false,
      stdio: 'ignore',
      windowsHide: false,
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
        isAlive: () => isProcessAlive(pid),
        dispose: () => {},
      });
    });
  });
}

/**
 * Elevated launch: ShellExecuteExW with verb "runas" (UAC). Synchronous on purpose (R4 above): koffi's
 * .async() is callback-style and GetLastError isn't readable from a worker thread; the UAC dialog is a
 * few seconds and gamepad input is ignored outside `ready`, so the brief block is acceptable.
 */
function launchElevated(manifest: ResolvedManifest): GameProcess {
  if (process.platform !== 'win32') {
    throw new Error('elevated launch (runAsAdmin) is Windows-only');
  }
  const shell = loadShell();
  const kernel = loadKernel();

  const args = manifest.raw.args;
  const info: ShellExecuteInfo = {
    cbSize: koffi.sizeof('SHELLEXECUTEINFOW'),
    fMask: SEE_MASK_NOCLOSEPROCESS,
    hwnd: null,
    lpVerb: 'runas',
    lpFile: manifest.executablePath,
    lpParameters: args.length > 0 ? buildParameters(args) : null,
    lpDirectory: manifest.cwd,
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
  return {
    pid: 0, // elevated marker; we monitor by HANDLE (GetProcessId is not bound).
    isAlive: () => Promise.resolve(kernel.WaitForSingleObject(handle, 0) === WAIT_TIMEOUT),
    dispose: () => {
      kernel.CloseHandle(handle);
    },
  };
}

/** Launches the .exe (elevated or normal per the manifest) and returns a GameProcess. Throws on failure. */
export async function launchGame(manifest: ResolvedManifest): Promise<GameProcess> {
  if (manifest.raw.runAsAdmin) {
    return launchElevated(manifest);
  }
  return launchNormal(manifest);
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

/** HANDOFF phase: wait for a watched game process to appear after the launcher was spawned. */
export async function waitForWatchedStart(
  launcherPid: number,
  watchNames: readonly string[],
  graceSec: number,
  signal?: AbortSignal,
): Promise<{ readonly started: boolean }> {
  const lowered = watchNames.map((name) => name.toLowerCase());
  const startedAt = Date.now();
  // Deadline for "the launcher never even appeared" (tasklist lag right after spawn — see below).
  const initialDeadline = startedAt + graceSec * 1000;
  // Grace deadline once the launcher was alive and then died without the game showing up; null until then.
  let graceDeadline: number | null = null;
  let launcherSeenAlive = false;

  for (;;) {
    throwIfAborted(signal);
    const snapshot = await snapshotProcesses();
    const gameVisible = anyVisible(snapshot, lowered);
    if (gameVisible) return { started: true };

    const launcherAlive = snapshot.includes(`"${launcherPid}"`);
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
  signal?: AbortSignal,
): Promise<void> {
  const lowered = watchNames.map((name) => name.toLowerCase());
  let missedReads = 0;
  for (;;) {
    throwIfAborted(signal);
    const snapshot = await snapshotProcesses();
    if (anyVisible(snapshot, lowered)) {
      missedReads = 0;
    } else {
      missedReads += 1;
      if (missedReads >= EXIT_DEBOUNCE_READS) return;
    }
    await delay(EXIT_POLL_INTERVAL_MS);
  }
}
