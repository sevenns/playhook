// The path decisions behind picking a file for a manifest field, as pure functions: what a field ACCEPTS,
// what a picked path becomes in the manifest, and where its picker opens. Electron-free and fs-free (the
// caller does the stat and passes what it found), so the rules that used to be enforced by an OS dialog
// are unit-testable now that a renderer-driven picker enforces them instead.
//
// These are HOST paths (a card root is `E:\` on Windows and `/run/media/deck/…` on the Deck), so they are
// built with the native `path`, not `path.posix`: the posix rule in CLAUDE.md is about paths that describe
// a Linux system from either OS, which is not what a directory the user is browsing is. What DOES cross
// machines is the manifest value, and that is always emitted with forward slashes below.
import path from 'node:path';
import type { ConfigPickKind, HostPlatform } from '../shared/types';

/**
 * The running OS in the form the renderer is given it (see HostPlatform). Everything that is neither
 * Windows nor macOS answers `linux`, matching createPlatform's own fallback — so the two cannot disagree
 * about which bundle a screen is talking about.
 */
export function hostPlatform(platform: NodeJS.Platform = process.platform): HostPlatform {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return 'linux';
}

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

/**
 * Whether a path is a macOS application bundle — a DIRECTORY that the user (and the launcher) treats as
 * one executable file. Every `.app`-aware decision goes through this one predicate so the picker, the
 * directory listing and the launcher cannot drift apart.
 */
export function isAppBundle(absolute: string): boolean {
  return path.extname(absolute).toLowerCase() === '.app';
}

/**
 * Whether the in-launcher picker should present a directory as a FILE: a macOS `.app` bundle being browsed
 * for a local game's executable. Presenting it as a folder would let the user walk into `Contents/MacOS/`
 * and pick the raw binary — which works, but is not what anyone means by "the game", and is not what the
 * card-less PC library should store. Deciding it in main keeps the renderer's picker free of any OS branch.
 *
 * Scoped to `pc-executable` on purpose: for every other field a `.app` is an ordinary folder.
 */
export function listsAsFile(
  absolute: string,
  isDirectory: boolean,
  kind: ConfigPickKind | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return isDirectory && platform === 'darwin' && kind === 'pc-executable' && isAppBundle(absolute);
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
 *
 * The one platform branch: on macOS a local game is usually a `.app` BUNDLE, which the filesystem reports
 * as a directory. It is a launch target all the same (the launcher resolves the binary inside it), so it
 * is accepted for `pc-executable` there — and only there, because a card stays a Windows dictionary.
 */
export function checkPickedType(
  absolute: string,
  kind: ConfigPickKind,
  stat: PickedStat | null,
  extensions: readonly string[] | null,
  platform: NodeJS.Platform = process.platform,
): PickRejection | null {
  if (stat === null) return 'missing';
  if (stat.isSymbolicLink) return 'symlink';
  if (picksDirectory(kind)) return stat.isDirectory ? null : 'needs-folder';
  if (platform === 'darwin' && kind === 'pc-executable' && stat.isDirectory && isAppBundle(absolute)) {
    return null;
  }
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
  /** `app.getPath('downloads')` — where artwork and music for a local game almost always just landed. */
  readonly downloadsDir: string;
  /** Whether `root` is a CARD (a PC-library root is not somewhere to browse for a file). */
  readonly rootIsCard: boolean;
}

export interface StartDirRequest {
  readonly root?: string;
  readonly kind?: ConfigPickKind;
  /** The field's current value, so a filled field reopens where it points. */
  readonly current?: string;
  /** An ALREADY-RESOLVED absolute sub-directory the field is measured from (see toRelative's `base`). */
  readonly baseDir?: string;
}

/**
 * Where a field's picker opens when the screen has nowhere of its own to return to.
 *
 * The rule is "the directory this field's answer usually lives in", not "the root this manifest belongs
 * to" — the two differ for exactly the fields that caused trouble:
 *  • a SAVE path is never on the card, even for a card game: the game writes to the PC, so it starts at
 *    `%APPDATA%` (on Windows, under the system drive; on Linux, the config root) whatever the source is;
 *  • ARTWORK and MUSIC for a local game were almost certainly downloaded a minute ago, so they start in
 *    Downloads rather than at the top of the home folder.
 * A `%PREFIX%`-style value names no host directory, so it is skipped rather than resolved.
 */
export function startDirFor(request: StartDirRequest, env: StartDirEnv): string {
  const { root, current, kind, baseDir } = request;
  // A field measured from a sub-directory is browsed from there: outside it there is nothing this field
  // can even express, so starting at the card root would open on paths it cannot store.
  const from = baseDir ?? root;
  if (current !== undefined && current !== '' && !current.startsWith('%')) {
    const absolute = path.isAbsolute(current)
      ? current
      : from !== undefined
        ? path.join(from, current)
        : null;
    if (absolute !== null) return path.dirname(absolute);
  }
  if (baseDir !== undefined) return baseDir;
  if (kind === 'pc-save' || kind === 'pc-save-local') return env.appDataDir;
  if (kind === 'pc-executable') return env.homeDir;
  const isCard = root !== undefined && env.rootIsCard;
  if (!isCard && (kind === 'image' || kind === 'audio')) return env.downloadsDir;
  if (isCard && root !== undefined) return root;
  return env.homeDir;
}
