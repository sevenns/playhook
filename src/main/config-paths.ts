// The path decisions behind picking a file for a manifest field, as pure functions: what a field ACCEPTS,
// what a picked path becomes in the manifest, and where its picker opens. Electron-free and fs-free (the
// caller does the stat and passes what it found), so the rules that used to be enforced by an OS dialog
// are unit-testable now that a renderer-driven picker enforces them instead — see the plan, Р5.1/Р5.2.
//
// These are HOST paths (a card root is `E:\` on Windows and `/run/media/deck/…` on the Deck), so they are
// built with the native `path`, not `path.posix`: the posix rule in CLAUDE.md is about paths that describe
// a Linux system from either OS, which is not what a directory the user is browsing is. What DOES cross
// machines is the manifest value, and that is always emitted with forward slashes below.
import path from 'node:path';
import type { ConfigPickKind } from '../shared/types';

/**
 * What a picked path must BE for the field it was picked for. `null` = any extension (a local game is
 * launched by whatever the user launches it with — a `.bat`, a shortcut, a native binary with no
 * extension at all). The `.exe` requirement on CARD fields is not a platform check: a card is a Windows
 * dictionary on both OSes, and this mirrors the filter the native dialog always applied.
 */
export function acceptsExtensions(
  kind: ConfigPickKind,
  platform: NodeJS.Platform = process.platform,
): readonly string[] | null {
  switch (kind) {
    case 'executable':
    case 'installer':
      return ['exe'];
    case 'pc-executable':
      return platform === 'win32' ? ['exe', 'bat', 'cmd', 'lnk'] : null;
    case 'image':
    case 'audio':
    case 'directory':
    case 'pc-save':
    case 'pc-save-local':
      return null;
  }
}

/** Whether this kind names a FOLDER (the rest name a file). */
export function picksDirectory(kind: ConfigPickKind): boolean {
  return kind === 'directory' || kind === 'pc-save' || kind === 'pc-save-local';
}

/** Why a picked path was refused. The caller maps it to a localized message. */
export type PickRejection = 'missing' | 'symlink' | 'needs-folder' | 'needs-file' | 'wrong-type';

/** What the caller's `lstat` found; null when there was nothing there at all. */
export interface PickedStat {
  readonly isSymbolicLink: boolean;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
}

/**
 * Whether one picked path may be used for `kind`. A symlink is refused rather than followed: it names one
 * thing and reads as another, which is the whole difficulty of trusting a path that did not come from a
 * dialog. `extensions` is passed in so this module needs no asset-reader import.
 */
export function checkPickedType(
  absolute: string,
  kind: ConfigPickKind,
  stat: PickedStat | null,
  extensions: readonly string[] | null,
): PickRejection | null {
  if (stat === null) return 'missing';
  if (stat.isSymbolicLink) return 'symlink';
  if (picksDirectory(kind)) return stat.isDirectory ? null : 'needs-folder';
  if (!stat.isFile) return 'needs-file';
  if (extensions === null) return null;
  const extension = path.extname(absolute).replace(/^\./, '').toLowerCase();
  return extensions.includes(extension) ? null : 'wrong-type';
}

/**
 * What a card-relative manifest field stores for an absolute path, with forward slashes — or null when the
 * path escapes the root (a `..`-leading or absolute relative) or IS the root (an empty relative, which the
 * manifest's `min(1)` would reject anyway). We never emit an escaping or empty manifest path.
 */
export function toCardRelative(root: string, absolute: string): string | null {
  const relative = path.relative(root, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

/** The machine-specific folders the starting point may be drawn from. */
export interface StartDirEnv {
  readonly homeDir: string;
  /** `app.getPath('appData')` — where a Windows-dictionary save path most often lives. */
  readonly appDataDir: string;
  /** Whether `root` is a CARD (a PC-library root is not somewhere to browse for a file). */
  readonly rootIsCard: boolean;
}

export interface StartDirRequest {
  readonly root?: string;
  readonly kind?: ConfigPickKind;
  /** The field's current value, so a filled field reopens where it points. */
  readonly current?: string;
}

/**
 * Where a field's picker opens when the screen has nowhere of its own to return to: the directory the
 * current value points at, else the card root for a card field, the home folder for a local executable,
 * and `%APPDATA%` for a save path. A `%PREFIX%`-style value names no host directory, so it is skipped.
 */
export function startDirFor(request: StartDirRequest, env: StartDirEnv): string {
  const { root, current, kind } = request;
  if (current !== undefined && current !== '' && !current.startsWith('%')) {
    const absolute = path.isAbsolute(current)
      ? current
      : root !== undefined
        ? path.join(root, current)
        : null;
    if (absolute !== null) return path.dirname(absolute);
  }
  if (kind === 'pc-save' || kind === 'pc-save-local') return env.appDataDir;
  if (kind === 'pc-executable') return env.homeDir;
  if (root !== undefined && env.rootIsCard) return root;
  return env.homeDir;
}
