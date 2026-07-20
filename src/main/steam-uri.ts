// Opening `steam://` URIs. Split out of steam.ts so that module can stay electron-free: it is reached
// from `save-path.linux.ts`, which the Game Mode daemon loads under ELECTRON_RUN_AS_NODE — a context
// where importing `electron` fails outright. Only the GUI (ipc.ts) opens URIs, so only this file needs
// electron, and nothing on the daemon's import path touches it.
import { shell } from 'electron';

/**
 * Opens a `steam://` URI (rungameid/install) via Electron's shell.openExternal. NOTE: openExternal does
 * NOT reliably reject when `steam://` is unregistered (Steam not installed) — callers must gate on
 * getSteamPath() !== null BEFORE calling this. Here we only guarantee that any sync/async failure
 * propagates as a rejected promise so the caller can surface it.
 */
export async function openSteamUri(uri: string): Promise<void> {
  await shell.openExternal(uri);
}
