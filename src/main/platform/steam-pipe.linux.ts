// Detecting that the Steam client is up, via the FIFO it listens on: `~/.steam/steam.pipe`.
//
// Opening a FIFO for writing with O_NONBLOCK fails with ENXIO while no reader holds the other end — which
// is exactly how the `steam` script decides whether it can talk to the client ("Steam is not running: No
// such device or address" is that errno printed verbatim).
//
// IMPORTANT — what this does NOT tell you. Measured on a Deck across a Desktop → Game Mode switch:
//
//     20:01:09 READY        ← the OLD client, still alive in the desktop session
//     20:01:10 NOT-READY 6  ← switch: five seconds with no Steam at all
//     20:01:15 READY        ← the NEW client opened the pipe
//     20:01:16 launch fired → tile stuck on "Launching…" forever
//
// So READY means "a client process exists and listens", NOT "it can start a game" — those are ~seconds
// apart, and a request sent in between is accepted and then silently never completed, blocking every later
// request until the user cancels by hand. Callers must therefore treat the READY transition as a starting
// gun and still wait before firing (see daemon-launch.ts settleMs). Checking the process list instead is
// strictly worse: `steamwebhelper` was up 2s into the session, even earlier than the pipe.
import fs from 'node:fs/promises';
import path from 'node:path';

export function steamPipePath(home: string): string {
  return path.posix.join(home, '.steam', 'steam.pipe');
}

/**
 * Whether a Steam client currently holds the pipe open for reading. The write end is opened non-blocking
 * and closed immediately — nothing is written, so a running client cannot be disturbed.
 */
export async function isSteamPipeReady(home: string): Promise<boolean> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(steamPipePath(home), fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    return true;
  } catch {
    // ENXIO (no reader) and ENOENT (never created) both mean "not up"; anything else we also cannot use.
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
