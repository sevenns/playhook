// The in-launcher file browser's backend: listing a directory, the roots offered beside it, an image
// thumbnail, and — the part that matters for safety — turning a picked path into what the manifest
// field stores. Split out of GameConfigService, which keeps the root guard the acceptance leans on.
//
// The native dialog used to be the CONSENT GATE: an absolute path could only reach main because the OS
// handed it over. Now the renderer names it, so acceptPickedPaths re-checks what the dialog used to
// guarantee — the path exists, is not a symlink, and its type matches the field.
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { app, ipcMain } from 'electron';
import {
  IPC,
  type ConfigPickKind,
  type ConfigPickResult,
  type DirEntry,
  type DirRoot,
  type GameConfigAcceptRequest,
  type GameConfigListDirRequest,
  type ListDirResult,
  type ManifestSource,
} from '../shared/types';
import { type Translator } from '../shared/i18n/index';
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, readImageDataUrl } from './asset-reader';
import {
  acceptsExtensions,
  checkPickedType,
  listsAsFile,
  startDirFor,
  toCardRelative,
  type PickRejection,
} from './config-paths';
import { listAllMountpoints } from './drive-watcher';
import { type PcLibraryStore } from './pc-library';
import { resolveInside } from './manifest';
import { describe } from './util';
import { log } from './logger';

/** The extensions a field accepts, with the two asset lists filled in from the AssetReader. */
function extensionsFor(kind: ConfigPickKind): readonly string[] | null {
  if (kind === 'image') return IMAGE_EXTENSIONS;
  if (kind === 'audio') return AUDIO_EXTENSIONS;
  return acceptsExtensions(kind);
}

/** The localized wording of a refusal from checkPickedType. */
function rejectionMessage(rejection: PickRejection, t: Translator): string {
  switch (rejection) {
    case 'missing':
      return t('gameConfig.pickMissing');
    case 'symlink':
      return t('gameConfig.pickSymlink');
    case 'needs-folder':
      return t('gameConfig.pickNeedsFolder');
    case 'needs-file':
      return t('gameConfig.pickNeedsFile');
    case 'wrong-type':
      return t('gameConfig.pickWrongType');
  }
}

/** The root guard the picker shares with GameConfigService: the closed set of writable roots. */
export interface WritableRootGuard {
  /** True when `root` is a current removable/non-system mountpoint or the app's own PC-library root. */
  isWritableRoot(root: string): Promise<boolean>;
  /** Which manifest dialect `root` speaks — the PC library's, or a card's. */
  sourceOf(root: string): ManifestSource;
}

export interface FilePickerDeps {
  readonly config: WritableRootGuard;
  /** The launcher's currently-active card root (DriveWatcher.getActiveRoot). */
  readonly getActiveRoot: () => string | null;
  /** The PC library: its root is a picker root, and a local game's art/music is copied into it. */
  readonly pcLibrary: Pick<PcLibraryStore, 'root' | 'importAsset'>;
  /** The current translator (read live so a language change applies to labels/errors). */
  readonly getTranslator: () => Translator;
  /**
   * Reverse-maps an absolute PC folder (from the pcSavePath browse) to a `%PREFIX%/…` manifest
   * string via the platform SavePathResolver, or null when it lives under none of the allowed bases.
   * win32 uses the env-based table; linux returns null (the user types the Windows-dictionary string).
   */
  readonly toManifestPcSavePath: (absolute: string) => string | null;
}

/** Whether one picked path may be used for `kind`; a localized reason when it may not, else null. */
export async function describePickRejection(
absolute: string,
kind: ConfigPickKind,
t: Translator,
): Promise<string | null> {
  let stat: Parameters<typeof checkPickedType>[2] = null;
  try {
    const stats = await fs.lstat(absolute);
    stat = {
      isSymbolicLink: stats.isSymbolicLink(),
      isDirectory: stats.isDirectory(),
      isFile: stats.isFile(),
    };
  } catch {
    stat = null;
  }
  const rejection = checkPickedType(absolute, kind, stat, extensionsFor(kind));
  return rejection === null ? null : rejectionMessage(rejection, t);
}

export class FilePickerService {
  constructor(private readonly deps: FilePickerDeps) {}

  /** Registers the picker's gameConfig:* invoke handlers once (the service is a singleton). */
  init(): void {
    ipcMain.handle(
      IPC.gameConfigImagePreview,
      (_event, payload: { readonly root: string; readonly path: string }): Promise<string | null> =>
        this.imagePreview(payload.root, payload.path),
    );
    ipcMain.handle(
      IPC.gameConfigAcceptPath,
      (_event, payload: GameConfigAcceptRequest): Promise<ConfigPickResult> =>
        this.acceptPickedPaths(payload.root, payload.kind, payload.paths, payload.base),
    );
    ipcMain.handle(
      IPC.gameConfigListDir,
      (_event, payload: GameConfigListDirRequest): Promise<ListDirResult> => this.listDir(payload),
    );
  }

  /**
   * Turns absolute path(s) into what the manifest field actually stores: card-RELATIVE with forward
   * slashes, a `%PREFIX%/…` save path, a verbatim absolute, or a library-relative asset that was copied
   * in. Shared by the native dialog and the in-launcher picker.
   *
   * The dialog used to be the consent gate for all of this: an absolute path could only arrive because
   * the OS handed it over, which is why this file could say "main never trusts the renderer's path" and
   * still copy whatever it was given. The in-launcher picker takes that gate away, so the checks are
   * stated here instead — the root must be a live candidate, the path must exist and
   * not be a symlink, and its TYPE must match the field: an `~/.ssh/id_rsa` offered as a hero image is
   * refused before anything reads or copies it.
   */
  async acceptPickedPaths(
    root: string,
    kind: ConfigPickKind,
    absolutePaths: readonly string[],
    base?: string,
  ): Promise<ConfigPickResult> {
    const t = this.deps.getTranslator();
    if (!(await this.deps.config.isWritableRoot(root))) {
      return { ok: false, message: t('errors.driveUnavailable') };
    }
    // A field measured from a sub-directory (see GameConfigAcceptRequest.base) still lives inside the
    // root, and `resolveInside` is what proves it: the renderer names the sub-path, so it gets the same
    // anti-traversal treatment every other manifest path does.
    const measureFrom = base === undefined || base === '' ? root : resolveInside(root, base);
    if (measureFrom === null) return { ok: false, message: t('gameConfig.pickOutsideCard') };
    if (absolutePaths.length === 0) return { ok: false, cancelled: true };
    const isPcLibrary = this.deps.config.sourceOf(root) === 'pc';
    // A local game's own executable and its host-side save folder only exist in the PC library.
    if ((kind === 'pc-executable' || kind === 'pc-save-local') && !isPcLibrary) {
      return { ok: false, message: t('errors.driveUnavailable') };
    }
    for (const absolute of absolutePaths) {
      const rejection = await describePickRejection(absolute, kind, t);
      if (rejection !== null) return { ok: false, message: rejection };
    }

    // pcSavePath points at a PC folder OUTSIDE the card (env-prefixed), so the absolute result is
    // converted back to a %PREFIX%/… form the validator accepts. A local game running from this machine's
    // own disk keeps the absolute path VERBATIM (`pc-save-local`). Converting it would be actively wrong
    // there: on Linux the reverse mapping only knows folders inside a Wine prefix and rejects everything
    // else, so the typical local save folder (`~/Games/Hades/Saves`) could not be picked at all — and pc
    // mode accepts an absolute path precisely because a %PREFIX% cannot express it. It is the form that
    // decides which of the two kinds applies, by launch mode: a local STEAM game keeps `pc-save`, because
    // ITS saves sit inside Steam's Proton prefix and only the %PREFIX% form maps onto compatdata (an
    // absolute path there would also be read with containerExists: true, which would let a deleted prefix
    // be mistaken for deleted saves).
    const first = absolutePaths[0];
    if (first === undefined) return { ok: false, cancelled: true };
    if (kind === 'pc-save-local' || kind === 'pc-executable') return { ok: true, paths: [first] };
    if (kind === 'pc-save') {
      const pcSavePath = this.deps.toManifestPcSavePath(first);
      if (pcSavePath === null) return { ok: false, message: t('gameConfig.pickPcSaveOutside') };
      return { ok: true, paths: [pcSavePath] };
    }
    // Art and music for a local game are picked from anywhere and COPIED into the library, so what the
    // manifest stores is a library-relative path — the same shape a card's asset has, which is what keeps
    // resolveInside and the AssetReader free of any PC-specific branch (and the art alive after the user
    // deletes the original).
    if (isPcLibrary && (kind === 'image' || kind === 'audio')) {
      const extensions = kind === 'image' ? IMAGE_EXTENSIONS : AUDIO_EXTENSIONS;
      const relatives: string[] = [];
      for (const absolute of absolutePaths) {
        try {
          relatives.push(await this.deps.pcLibrary.importAsset(absolute, kind, extensions));
        } catch (cause) {
          log.warn('[game-config] importing a local asset failed:', describe(cause));
          return { ok: false, message: t('gameConfig.pickImportFailed') };
        }
      }
      return { ok: true, paths: relatives };
    }

    const relatives: string[] = [];
    for (const absolute of absolutePaths) {
      const relative = toCardRelative(measureFrom, absolute);
      if (relative === null) {
        return {
          ok: false,
          message: t(
            kind === 'directory' ? 'gameConfig.pickChooseSubfolder' : 'gameConfig.pickOutsideCard',
          ),
        };
      }
      relatives.push(relative);
    }
    return { ok: true, paths: relatives };
  }

  // ── Directory listing for the in-launcher file picker ──────────────────────

  /**
   * One directory's contents, plus the starting points offered beside it. READ-ONLY and deliberately
   * unrestricted: where to browse is the user's business (the most common install path of all,
   * `C:\Program Files (x86)\Steam\steamapps\common\…`, is a system directory by any definition). What is
   * guarded is the ACCEPTANCE of a path, not the looking — see acceptPickedPaths.
   */
  private async listDir(request: GameConfigListDirRequest): Promise<ListDirResult> {
    const t = this.deps.getTranslator();
    const roots = await this.pickerRoots();
    // A field measured from a sub-directory browses from there; an unresolvable one falls back to the
    // root rather than failing — this is where the picker OPENS, not what it will accept.
    const baseDir =
      request.root !== undefined && request.base !== undefined && request.base !== ''
        ? resolveInside(request.root, request.base)
        : null;
    const target =
      request.path ??
      startDirFor(
        { ...request, ...(baseDir !== null ? { baseDir } : {}) },
        {
          homeDir: os.homedir(),
          appDataDir: app.getPath('appData'),
          downloadsDir: app.getPath('downloads'),
          rootIsCard: request.root !== undefined && this.deps.config.sourceOf(request.root) === 'card',
        },
      );
    let names: readonly string[];
    try {
      names = await fs.readdir(target);
    } catch (cause) {
      log.warn(`[game-config] cannot list "${target}":`, describe(cause));
      return { ok: false, message: t('gameConfig.listFailed'), roots };
    }
    const entries: DirEntry[] = [];
    for (const name of names) {
      if (name.startsWith('.')) continue; // dotfiles are noise in a picker for games and artwork
      try {
        // stat, not lstat: a symlinked folder is a folder to browse. Accepting what is INSIDE it is a
        // separate decision, made by acceptPickedPaths, which refuses symlinks on its own.
        const full = path.join(target, name);
        const stats = await fs.stat(full);
        // A macOS `.app` bundle is a directory the user means as one file — see listsAsFile.
        const isDir = stats.isDirectory() && !listsAsFile(full, true, request.kind);
        entries.push({ name, kind: isDir ? 'dir' : 'file' });
      } catch {
        continue; // a dangling link or an unreadable entry — simply not offered
      }
    }
    entries.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1,
    );
    const parent = path.dirname(target);
    return {
      ok: true,
      path: target,
      parent: parent === target ? null : parent,
      entries,
      roots,
    };
  }

  /** The left column: the card, this machine's library, the home folder and every mounted volume. */
  private async pickerRoots(): Promise<readonly DirRoot[]> {
    const t = this.deps.getTranslator();
    const roots: DirRoot[] = [];
    const card = this.deps.getActiveRoot();
    if (card !== null) roots.push({ path: card, label: card, kind: 'card' });
    roots.push({ path: this.deps.pcLibrary.root, label: t('gameConfig.thisPc'), kind: 'pc' });
    roots.push({ path: os.homedir(), label: t('gameConfig.homeFolder'), kind: 'home' });
    try {
      for (const mount of await listAllMountpoints()) {
        if (roots.some((entry) => entry.path === mount)) continue;
        roots.push({ path: mount, label: mount, kind: 'drive' });
      }
    } catch (cause) {
      log.warn('[game-config] enumerating volumes for the picker failed:', describe(cause));
    }
    return roots;
  }

  /**
   * Reads a card-relative image into a data URL for the hero preview. Reuses the manifest's anti-traversal
   * (`resolveInside`) and the untrusted-root check, so the preview can only read files INSIDE the card.
   * Returns null on any rejection/failure (the renderer just shows no thumbnail).
   */
  private async imagePreview(root: string, relative: string): Promise<string | null> {
    if (!(await this.deps.config.isWritableRoot(root))) return null;
    const resolved = resolveInside(root, relative);
    if (resolved === null) return null;
    const url = await readImageDataUrl(resolved);
    return url ?? null;
  }
}
