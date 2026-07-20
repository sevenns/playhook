// Linux implementation of SteamShortcuts: registering Playhook in Steam's `shortcuts.vdf` so it gets a
// Game Mode tile. This is the one place in the app that writes a file Steam owns, so the whole module is
// built around not damaging it.
//
// Safety rules (from the plan's §3.5, several of them established by experiment on a real Deck):
//  - Steam does NOT need to be closed: it does not rewrite shortcuts.vdf on exit (verified — a Steam that
//    was killed by a mode switch left an externally-modified file untouched).
//  - Read-modify-write, never a blind overwrite: foreign shortcuts are carried through verbatim.
//  - A file that exists but does not parse ABORTS the operation. Refusing beats overwriting shortcuts we
//    failed to understand.
//  - Backups go to Playhook's own userData, NOT next to the original: `userdata/<id>/config/` is Steam
//    Cloud territory and gets tidied by Steam. The last few are kept, because one rolling backup would be
//    overwritten by the second failed attempt — destroying the only good copy.
//  - The write is atomic (temp + rename), like every other store in the app.
import path from 'node:path';
import fs from 'node:fs/promises';
import fse from 'fs-extra';
import { log } from '../logger';
import { writeFileAtomic } from '../json-store';
import type {
  SteamLocator,
  SteamShortcutResult,
  SteamShortcuts,
  SteamShortcutTarget,
  SteamShortcutVoidResult,
} from './types';
import { computeAppIdU32, quoteExePath, toSignedAppId, toUnsignedAppId } from './steam-appid';
import {
  loginUsersPath,
  parseLoginUsers,
  pickSteamUser,
  pickUserdataDir,
  shortcutsVdfPath,
  userdataDir,
  type SteamUserResult,
} from './steam-userdata.linux';
import { parseShortcuts, serializeShortcuts, type ShortcutRecord } from './steam-vdf';

/** How many timestamped backups of a user's shortcuts.vdf to keep. */
const BACKUPS_KEPT = 3;

export interface LinuxSteamShortcutsDeps {
  readonly steamLocator: SteamLocator;
  /** app.getPath('userData') — the backup folder's parent (never Steam's own directory). */
  readonly userData: string;
}

/** Everything an edit needs, resolved once: where the file is and what it currently holds. */
interface LoadedShortcuts {
  readonly filePath: string;
  readonly records: readonly ShortcutRecord[];
  /** Whether the file already existed (a first-run absence is normal and must not be backed up). */
  readonly existed: boolean;
  /** Steam's own root key, preserved on rewrite. */
  readonly rootKey: string;
}

function failure(message: string): { readonly ok: false; readonly message: string } {
  return { ok: false, message };
}

/** Locates the Steam user whose userdata/ owns the shortcuts: loginusers.vdf first, the directory listing
 * as a fallback. Ambiguity is a refusal, never a guess (writing into the wrong account is unrecoverable
 * from the user's point of view). */
async function resolveSteamUser(steamRoot: string): Promise<SteamUserResult> {
  try {
    const content = await fs.readFile(loginUsersPath(steamRoot), 'utf8');
    const picked = pickSteamUser(parseLoginUsers(content));
    if (picked.ok) return picked;
    log.warn(`[steam-shortcut] loginusers.vdf did not identify an account: ${picked.message}`);
  } catch (cause) {
    // A missing loginusers.vdf is normal on a Steam that never signed in; anything else is worth a note.
    log.warn(
      '[steam-shortcut] could not read loginusers.vdf, falling back to the userdata listing:',
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  try {
    const entries = await fs.readdir(userdataDir(steamRoot));
    return pickUserdataDir(entries);
  } catch {
    return failure('Steam userdata directory not found');
  }
}

/** Reads and parses the current shortcuts.vdf. A missing file is an empty list; an unparsable one fails. */
async function loadShortcuts(
  deps: LinuxSteamShortcutsDeps,
): Promise<SteamShortcutResult<LoadedShortcuts>> {
  const steamRoot = await deps.steamLocator.locateSteam();
  if (steamRoot === null) return failure('Steam installation not found');

  const user = await resolveSteamUser(steamRoot);
  if (!user.ok) return failure(user.message);

  const filePath = shortcutsVdfPath(steamRoot, user.steamId3);
  let raw: Buffer;
  try {
    raw = await fs.readFile(filePath);
  } catch {
    // No file yet — the normal state of a Steam that has never had a non-Steam game.
    return { ok: true, filePath, records: [], existed: false, rootKey: 'shortcuts' };
  }
  const parsed = parseShortcuts(raw);
  if (!parsed.ok) {
    log.error(`[steam-shortcut] refusing to rewrite unparsable "${filePath}": ${parsed.message}`);
    return failure(`shortcuts.vdf could not be read (${parsed.message})`);
  }
  return { ok: true, filePath, records: parsed.records, existed: true, rootKey: parsed.rootKey };
}

/** Copies the current file into Playhook's userData before we touch it, keeping the last few. */
async function backup(deps: LinuxSteamShortcutsDeps, filePath: string): Promise<void> {
  const dir = path.join(deps.userData, 'steam-backup');
  try {
    await fse.ensureDir(dir);
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
    await fs.copyFile(filePath, path.join(dir, `shortcuts-${stamp}.vdf`));
    const kept = (await fs.readdir(dir))
      .filter((name) => name.startsWith('shortcuts-') && name.endsWith('.vdf'))
      .sort()
      .reverse()
      .slice(BACKUPS_KEPT);
    for (const stale of kept) await fs.rm(path.join(dir, stale), { force: true });
  } catch (cause) {
    // Best-effort, but never silent: losing the backup is not a reason to abort, losing it QUIETLY is.
    log.warn(
      '[steam-shortcut] backup failed:',
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}

/** The appid field of a record, normalised to the unsigned form we compare and store everywhere else. */
function recordAppId(record: ShortcutRecord): number | null {
  const raw = record['appid'];
  return typeof raw === 'number' ? toUnsignedAppId(raw) : null;
}

function recordString(record: ShortcutRecord, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

/** Steam stores `Exe` quoted; strip them to compare against a real path. */
function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') && value.length >= 2
    ? value.slice(1, -1)
    : value;
}

/** Builds the record Steam expects. `AllowOverlay` is the field that buys the overlay and QAM — the whole
 * point of having a tile at all. */
function buildRecord(target: SteamShortcutTarget, appIdU32: number): ShortcutRecord {
  return {
    appid: toSignedAppId(appIdU32),
    AppName: target.appName,
    Exe: quoteExePath(target.exePath),
    StartDir: quoteExePath(target.startDir),
    icon: target.iconPath,
    ShortcutPath: '',
    LaunchOptions: '',
    IsHidden: 0,
    AllowDesktopConfig: 1,
    AllowOverlay: 1,
    OpenVR: 0,
    Devkit: 0,
    DevkitGameID: '',
    LastPlayTime: 0,
    tags: {},
  };
}

/** Writes the record list back, after backing up whatever is there now. */
async function persist(
  deps: LinuxSteamShortcutsDeps,
  loaded: LoadedShortcuts,
  records: readonly ShortcutRecord[],
): Promise<SteamShortcutVoidResult> {
  try {
    if (loaded.existed) await backup(deps, loaded.filePath);
    await fse.ensureDir(path.dirname(loaded.filePath));
    await writeFileAtomic(loaded.filePath, serializeShortcuts(records, loaded.rootKey));
    return { ok: true };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    log.error(`[steam-shortcut] failed to write "${loaded.filePath}":`, message);
    return failure(message);
  }
}

export function createLinuxSteamShortcuts(deps: LinuxSteamShortcutsDeps): SteamShortcuts {
  return {
    supported: true,

    async addShortcut(target): Promise<SteamShortcutResult<{ readonly appIdU32: number }>> {
      const loaded = await loadShortcuts(deps);
      if (!loaded.ok) return failure(loaded.message);

      const appIdU32 = computeAppIdU32(target.exePath, target.appName);
      const record = buildRecord(target, appIdU32);
      const index = loaded.records.findIndex((entry) => recordAppId(entry) === appIdU32);
      // Update in place when ours is already there (a re-add after the user deleted settings, say), so a
      // second click can never append a duplicate tile.
      const records =
        index === -1
          ? [...loaded.records, record]
          : loaded.records.map((entry, i) => (i === index ? record : entry));

      const written = await persist(deps, loaded, records);
      return written.ok ? { ok: true, appIdU32 } : failure(written.message);
    },

    async removeShortcut(appIdU32): Promise<SteamShortcutVoidResult> {
      const loaded = await loadShortcuts(deps);
      if (!loaded.ok) return failure(loaded.message);

      const records = loaded.records.filter((entry) => recordAppId(entry) !== appIdU32);
      // Already gone (the user deleted the tile in Steam) — nothing to write, and not an error.
      if (records.length === loaded.records.length) return { ok: true };
      return persist(deps, loaded, records);
    },

    async hasShortcut(appIdU32): Promise<boolean> {
      const loaded = await loadShortcuts(deps);
      if (!loaded.ok) return false;
      return loaded.records.some((entry) => recordAppId(entry) === appIdU32);
    },

    async findForeignShortcuts(exeHints): Promise<readonly string[]> {
      const loaded = await loadShortcuts(deps);
      if (!loaded.ok) return [];
      return loaded.records
        .filter((entry) => {
          const exe = unquote(recordString(entry, 'Exe'));
          if (exe === '') return false;
          const matches = exeHints.some((hint) => exe === hint || path.basename(exe) === hint);
          if (!matches) return false;
          // Ours is the one whose appid matches the CRC32 of its own (exe, name) — an entry Steam added
          // through its UI got a random appid instead, which is exactly how we tell them apart.
          return recordAppId(entry) !== computeAppIdU32(exe, recordString(entry, 'AppName'));
        })
        .map((entry) => recordString(entry, 'AppName'));
    },
  };
}
