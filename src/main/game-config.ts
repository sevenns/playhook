// Configure-game window backend (IPC handlers + drive polling). Owns everything the window needs:
// listing removable drives (incl. blank ones), reading/validating/saving a card's game.json and the
// manifest JSON Schema. Interface-DI (like UpdaterService/StatsService): the active-root accessor and the
// no-restart reload come from GameController, the theme from AppSettingsStore.
//
// Two security stances mirror manifest.ts's paranoia about untrusted paths:
//  • the renderer's `root` is NEVER trusted — every read/save re-checks it against a fresh
//    listDriveCandidates() (removable, non-system) PLUS the app's own PC-library root, so a compromised
//    renderer can't write game.json to an arbitrary filesystem location;
//  • Save re-runs the static validation server-side (a race guard against the UI enabling it wrongly).
//
// The PC library DELIBERATELY widens the first stance, and it is worth being explicit about: the
// Configure renderer may now write `<userData>/pc-games/game.json`, whose `pc.executable` is any binary
// on the machine, with arbitrary `args` and `runAsAdmin`. Before, it could only point at a file that
// physically sat on a removable drive. The feature does not exist without that — picking an arbitrary
// .exe IS the feature — and the widening is bounded: the set of writable ROOTS is still closed (this
// one path plus the removable candidates), every write still goes through config:save with server-side
// validation, and the window loads no external content (contextIsolation + sandbox).
import path from 'node:path';
import fs from 'node:fs/promises';
import fse from 'fs-extra';
import { app, dialog, ipcMain, shell, BrowserWindow, type WebContents } from 'electron';
import {
  IPC,
  MANIFEST_FILENAME,
  type AppSettings,
  type ConfigPickKind,
  type ConfigPickRequest,
  type ConfigPickResult,
  type ConfigReadResult,
  type ConfigSaveResult,
  type ConfigValidationResult,
  type DriveCandidate,
  type ManifestSource,
} from '../shared/types';
import { type Translator } from '../shared/i18n/index';
import { type AppSettingsStore } from './app-settings';
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, readImageDataUrl } from './asset-reader';
import { listDriveCandidates } from './drive-watcher';
import { type PcLibraryStore } from './pc-library';
import { resolveInside, validateManifestText, manifestJsonSchema } from './manifest';
import { writeFileAtomic } from './save-sync';
import { describe } from './util';
import { log } from './logger';

/** OS-dialog `properties` for a pick kind: a folder picker for `directory`/`pc-save`, multi-file for images. */
function pickProperties(kind: ConfigPickKind): Electron.OpenDialogOptions['properties'] {
  if (kind === 'directory' || kind === 'pc-save') return ['openDirectory'];
  if (kind === 'image') return ['openFile', 'multiSelections'];
  return ['openFile'];
}

/** Extension filters for a file pick, from the AssetReader single source of truth (dot-less names).
 * The filter NAMES are shown by the OS as-is; kept in English like the wallpaper picker (ipc.ts). */
function pickFilters(kind: ConfigPickKind): Electron.FileFilter[] {
  switch (kind) {
    case 'image':
      return [{ name: 'Images', extensions: [...IMAGE_EXTENSIONS] }];
    case 'audio':
      return [{ name: 'Audio', extensions: [...AUDIO_EXTENSIONS] }];
    case 'executable':
    case 'installer':
      return [{ name: 'Executable', extensions: ['exe'] }];
    // A local game is whatever the user actually launches it with — a `.bat`, a `.cmd`, a shortcut, or
    // (on Linux) a native binary with no extension at all. The hard `['exe']` filter above is right for a
    // CARD (a Windows dictionary by definition) and wrong here, so this one only nudges.
    case 'pc-executable':
      return process.platform === 'win32'
        ? [
            { name: 'Programs', extensions: ['exe', 'bat', 'cmd', 'lnk'] },
            { name: 'All files', extensions: ['*'] },
          ]
        : [];
    case 'directory':
    case 'pc-save':
      return [];
  }
}

/**
 * Whether the editor's text is an EMPTY game list — the PC library's way of saying "the last local game
 * was deleted". Only well-formed text reaches this (Save re-validates first), so a parse failure simply
 * means "not the empty list".
 */
function isEmptyManifestList(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) && parsed.length === 0;
  } catch {
    return false;
  }
}

// Blank-drive insertion is only visible via enumeration (DriveWatcher events fire for cards WITH a
// game.json only), so we poll while the window is visible. 2s is a fine cost for a foreground window.
const DRIVE_POLL_INTERVAL_MS = 2000;

export interface GameConfigDeps {
  readonly settings: AppSettingsStore;
  /** The launcher's currently-active card root (DriveWatcher.getActiveRoot). */
  readonly getActiveRoot: () => string | null;
  /** Applies an edited game.json to the active card without a restart (GameController.reloadManifest). */
  readonly reloadManifest: (root: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  /**
   * The PC library — offered in the picker as one more "drive" (`kind: 'pc'`), so a local game is added
   * through the same editor a card's game is. See the threat-model note at the top of this file.
   */
  readonly pcLibrary: PcLibraryStore;
  /** Re-reads the PC library after a save (GameController.reloadPcLibrary) — the local reloadManifest. */
  readonly reloadPcLibrary: () => Promise<{ ok: true } | { ok: false; message: string }>;
  /** The current translator (read live so a language change applies to labels/validation/errors). */
  readonly getTranslator: () => Translator;
  /**
   * Reverse-maps an absolute PC folder (from the pcSavePath Browse dialog) to a `%PREFIX%/…` manifest
   * string via the platform SavePathResolver (Р5), or null when it lives under none of the allowed bases.
   * win32 uses the env-based table; linux returns null (the user types the Windows-dictionary string).
   */
  readonly toManifestPcSavePath: (absolute: string) => string | null;
}

export class GameConfigService {
  private window: BrowserWindow | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(private readonly deps: GameConfigDeps) {}

  /** Registers all config:* invoke handlers once (the service is a singleton). */
  init(): void {
    ipcMain.handle(IPC.configDrivesRequest, (): Promise<readonly DriveCandidate[]> => this.candidates());
    ipcMain.handle(IPC.configRead, (_event, root: string): Promise<ConfigReadResult> =>
      this.readConfig(root),
    );
    ipcMain.handle(
      IPC.configValidate,
      (
        _event,
        payload: { readonly root: string; readonly text: string },
      ): ConfigValidationResult =>
        validateManifestText(payload.text, this.deps.getTranslator(), this.sourceOf(payload.root)),
    );
    ipcMain.handle(
      IPC.configSave,
      (
        _event,
        payload: { readonly root: string; readonly text: string },
      ): Promise<ConfigSaveResult> => this.save(payload.root, payload.text),
    );
    ipcMain.handle(
      IPC.configPickPath,
      (event, payload: ConfigPickRequest): Promise<ConfigPickResult> =>
        this.pickPath(event.sender, payload.root, payload.kind),
    );
    ipcMain.handle(
      IPC.configImagePreview,
      (_event, payload: { readonly root: string; readonly path: string }): Promise<string | null> =>
        this.imagePreview(payload.root, payload.path),
    );
    // Fire-and-forget: open a whitelisted https URL (e.g. the SteamDB appid lookup) in the default browser.
    ipcMain.on(IPC.configOpenExternal, (_event, url: unknown) => {
      if (typeof url === 'string' && /^https:\/\//i.test(url)) {
        void shell.openExternal(url).catch((cause) => log.warn('[game-config] openExternal failed:', describe(cause)));
      }
    });
    ipcMain.handle(IPC.configSchemaRequest, (): unknown => manifestJsonSchema());
    ipcMain.handle(IPC.configSettingsRequest, (): Promise<AppSettings> =>
      this.deps.settings.read(),
    );
    ipcMain.handle(IPC.configIconRequest, (): Promise<string> => this.readIconDataUrl());
    ipcMain.handle(IPC.configVersionRequest, (): string => app.getVersion());
  }

  // The window shows the app icon in its custom title bar. CSP there is `img-src data:`, so we hand the
  // icon over as a data URL rather than a file path (mirrors UpdaterService.readIconDataUrl). Read once.
  private iconDataUrl: string | null = null;
  private async readIconDataUrl(): Promise<string> {
    if (this.iconDataUrl !== null) return this.iconDataUrl;
    try {
      const buffer = await fs.readFile(path.join(__dirname, '../icon.png'));
      this.iconDataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
    } catch (cause) {
      log.error('[game-config] failed to read app icon:', cause);
      this.iconDataUrl = ''; // empty → the renderer just hides the <img>
    }
    return this.iconDataUrl;
  }

  /** Attaches the window and starts the visible-only drive poll (called on window show). */
  attachWindow(window: BrowserWindow): void {
    this.window = window;
    this.startPolling();
  }

  /** Detaches the window and stops the poll (called on window hide/close). */
  detachWindow(): void {
    this.window = null;
    this.stopPolling();
  }

  // ── Drive + PC-library candidates ──────────────────────────────────────────

  /**
   * Everything the picker may edit: the removable candidates, plus the PC library as one more entry.
   * It is always listed and always "active" — it is this machine, it cannot be unplugged — and its
   * `hasManifest: false` (no local game yet) lands the renderer in the SAME blank-drive branch a fresh
   * card takes, so adding the first local game needs no new UI state at all.
   */
  private async candidates(): Promise<readonly DriveCandidate[]> {
    const t = this.deps.getTranslator();
    const drives = await listDriveCandidates(this.deps.getActiveRoot(), t);
    const hasManifest = await this.deps.pcLibrary.hasManifest();
    const pc: DriveCandidate = {
      root: this.deps.pcLibrary.root,
      kind: 'pc',
      label: t('configure.thisPc'),
      // The signature identifies the MEDIA a root currently holds, so that a swapped card is detected.
      // The PC library is never swapped, so a constant is exactly right here.
      signature: 'pc',
      hasManifest,
      isActive: true,
    };
    return [...drives, pc];
  }

  /** Which manifest dialect `root` speaks — the PC library's, or a card's (see ManifestSource). */
  private sourceOf(root: string): ManifestSource {
    return root === this.deps.pcLibrary.root ? 'pc' : 'card';
  }

  // ── Reading / saving game.json ─────────────────────────────────────────────

  private async readConfig(root: string): Promise<ConfigReadResult> {
    const t = this.deps.getTranslator();
    if (!(await this.isAllowedRoot(root))) {
      return { ok: false, message: t('errors.driveUnavailable') };
    }
    try {
      const text = await fse.readFile(path.join(root, MANIFEST_FILENAME), 'utf8');
      return { ok: true, text };
    } catch (cause) {
      return {
        ok: false,
        message: t('errors.cannotReadManifest', { file: MANIFEST_FILENAME, cause: describe(cause) }),
      };
    }
  }

  private async save(root: string, text: string): Promise<ConfigSaveResult> {
    const t = this.deps.getTranslator();
    // 1. main never trusts the renderer's path — it must be a live removable candidate (or the PC library).
    if (!(await this.isAllowedRoot(root))) {
      return { saved: false, message: t('errors.driveUnavailable') };
    }
    const source = this.sourceOf(root);
    // 2. re-validate server-side (guards against a UI race that enabled Save with a stale verdict).
    const validation = validateManifestText(text, t, source);
    if (!validation.ok) {
      const first = validation.issues[0];
      return {
        saved: false,
        message: first !== undefined ? `${first.path}: ${first.message}` : t('errors.configInvalid'),
      };
    }
    if (source === 'pc') return this.savePcLibrary(text, t);
    // 3. atomic write — reuse the card-hardened writer (temp→move, EBUSY/EPERM retry, drive-root nuance).
    // Write the user's text verbatim so their formatting is preserved (no reserialize).
    try {
      await writeFileAtomic(path.join(root, MANIFEST_FILENAME), text);
    } catch (cause) {
      return {
        saved: false,
        message: t('errors.cannotWriteManifest', { file: MANIFEST_FILENAME, cause: describe(cause) }),
      };
    }
    // 4. apply. Active card → reload in place; any other (blank/second) card → DriveWatcher handles it
    // (≤1s if no active card; otherwise scan() stabilization keeps the active one and this loads on removal).
    if (root === this.deps.getActiveRoot()) {
      const applied = await this.deps.reloadManifest(root);
      return applied.ok
        ? { saved: true, applied: 'applied' }
        : { saved: true, applied: 'failed', message: applied.message };
    }
    return { saved: true, applied: 'deferred' };
  }

  /**
   * Saves the PC library's game.json and re-reads it into the running launcher. Unlike a card there is no
   * "deferred" outcome: the library is always the app's own directory, so an edit either applies now or
   * reports why it could not.
   *
   * An EMPTY list is not written as a file — it removes game.json entirely. That is how deleting the last
   * local game is spelled (the renderer sends `[]`), and it keeps the "no manifest ⇒ blank form" state the
   * picker relies on from being shadowed by a technically-present but empty file.
   */
  private async savePcLibrary(text: string, t: Translator): Promise<ConfigSaveResult> {
    const emptied = isEmptyManifestList(text);
    try {
      if (emptied) await this.deps.pcLibrary.removeManifest();
      else await writeFileAtomic(path.join(this.deps.pcLibrary.root, MANIFEST_FILENAME), text);
    } catch (cause) {
      return {
        saved: false,
        message: t('errors.cannotWriteManifest', { file: MANIFEST_FILENAME, cause: describe(cause) }),
      };
    }
    const applied = await this.deps.reloadPcLibrary();
    return applied.ok
      ? { saved: true, applied: 'applied' }
      : { saved: true, applied: 'failed', message: applied.message };
  }

  // ── File/folder picker for the Configure form (paths card-relative) ─────────

  /**
   * Picks file(s)/a folder from the card via the native dialog (parented to the Configure window) and
   * returns card-RELATIVE paths with forward slashes. Mirrors pickWallpaper's shape (ipc.ts) but adds the
   * two manifest guarantees: the `root` is re-checked against the live candidates (never trusted), and
   * every picked path is verified to stay INSIDE the root (path.relative without `..`/absolute) — a file
   * chosen elsewhere is rejected rather than turned into a `..`-escape. For a `directory` pick the card
   * root itself yields an empty relative, which the manifest's `min(1)` would reject, so it is refused too.
   */
  private async pickPath(
    sender: WebContents,
    root: string,
    kind: ConfigPickKind,
  ): Promise<ConfigPickResult> {
    const t = this.deps.getTranslator();
    if (!(await this.isAllowedRoot(root))) {
      return { ok: false, message: t('errors.driveUnavailable') };
    }
    const parent = BrowserWindow.fromWebContents(sender);
    const isPcLibrary = this.sourceOf(root) === 'pc';
    // pcSavePath points at a PC folder OUTSIDE the card (env-prefixed), so it has its own dialog: no card
    // root restriction, and the absolute result is converted back to a %PREFIX%/… form the validator accepts.
    if (kind === 'pc-save') {
      const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] };
      const picked =
        parent !== null ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      const chosen = picked.filePaths[0];
      if (picked.canceled || chosen === undefined) return { ok: false, cancelled: true };
      // A local game keeps the absolute path VERBATIM. Converting it would be actively wrong here: on
      // Linux the reverse mapping only knows folders inside a Wine prefix and rejects everything else, so
      // the typical local save folder (`~/Games/Hades/Saves`) could not be picked at all — and pc mode
      // accepts an absolute path precisely because a %PREFIX% cannot express it.
      if (isPcLibrary) return { ok: true, paths: [chosen] };
      const pcSavePath = this.deps.toManifestPcSavePath(chosen);
      if (pcSavePath === null) return { ok: false, message: t('configure.pickPcSaveOutside') };
      return { ok: true, paths: [pcSavePath] };
    }
    // A local game's executable lives wherever the user installed it — an absolute path is the point.
    if (kind === 'pc-executable') {
      if (!isPcLibrary) return { ok: false, message: t('errors.driveUnavailable') };
      const options: Electron.OpenDialogOptions = { properties: ['openFile'] };
      const filters = pickFilters(kind);
      const picked =
        parent !== null
          ? await dialog.showOpenDialog(parent, { ...options, ...(filters.length > 0 ? { filters } : {}) })
          : await dialog.showOpenDialog({ ...options, ...(filters.length > 0 ? { filters } : {}) });
      const chosen = picked.filePaths[0];
      if (picked.canceled || chosen === undefined) return { ok: false, cancelled: true };
      return { ok: true, paths: [chosen] };
    }
    // Art and music for a local game are picked from anywhere and COPIED into the library, so what the
    // manifest stores is a library-relative path — the same shape a card's asset has, which is what keeps
    // resolveInside and the AssetReader free of any PC-specific branch (and the art alive after the user
    // deletes the original).
    if (isPcLibrary && (kind === 'image' || kind === 'audio')) {
      const filters = pickFilters(kind);
      const options: Electron.OpenDialogOptions = {
        properties: pickProperties(kind),
        ...(filters.length > 0 ? { filters } : {}),
      };
      const picked =
        parent !== null ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      if (picked.canceled || picked.filePaths.length === 0) return { ok: false, cancelled: true };
      const relatives: string[] = [];
      for (const absolute of picked.filePaths) {
        try {
          relatives.push(await this.deps.pcLibrary.importAsset(absolute));
        } catch (cause) {
          log.warn('[game-config] importing a local asset failed:', describe(cause));
          return { ok: false, message: t('configure.pickImportFailed') };
        }
      }
      return { ok: true, paths: relatives };
    }
    const filters = pickFilters(kind);
    const options: Electron.OpenDialogOptions = {
      defaultPath: root,
      properties: pickProperties(kind),
      ...(filters.length > 0 ? { filters } : {}),
    };
    const result =
      parent !== null ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return { ok: false, cancelled: true };

    const relatives: string[] = [];
    for (const absolute of result.filePaths) {
      const relative = path.relative(root, absolute);
      // Outside the card (a `..`-leading or absolute relative) — or the root itself for a folder pick
      // (empty relative) — is rejected: we never emit an escaping or empty manifest path.
      if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
        return {
          ok: false,
          message: t(kind === 'directory' ? 'configure.pickChooseSubfolder' : 'configure.pickOutsideCard'),
        };
      }
      relatives.push(relative.split(path.sep).join('/'));
    }
    return { ok: true, paths: relatives };
  }

  /**
   * Reads a card-relative image into a data URL for the hero preview. Reuses the manifest's anti-traversal
   * (`resolveInside`) and the untrusted-root check, so the preview can only read files INSIDE the card.
   * Returns null on any rejection/failure (the renderer just shows no thumbnail).
   */
  private async imagePreview(root: string, relative: string): Promise<string | null> {
    if (!(await this.isAllowedRoot(root))) return null;
    const resolved = resolveInside(root, relative);
    if (resolved === null) return null;
    const url = await readImageDataUrl(resolved);
    return url ?? null;
  }

  /**
   * True when `root` is a current removable/non-system mountpoint, or the app's own PC-library root
   * (anti-arbitrary-write check — the closed set of roots this service will ever write to).
   */
  private async isAllowedRoot(root: string): Promise<boolean> {
    const candidates = await this.candidates();
    return candidates.some((candidate) => candidate.root === root);
  }

  // ── Drive polling (only while the window is visible) ───────────────────────

  private startPolling(): void {
    if (this.pollTimer !== null) return;
    void this.pushDrives(); // an immediate snapshot so the picker doesn't wait a full interval
    this.pollTimer = setInterval(() => void this.pushDrives(), DRIVE_POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pushDrives(): Promise<void> {
    if (this.polling) return; // skip overlapping ticks (drivelist can be slow on some readers)
    this.polling = true;
    try {
      const drives = await this.candidates();
      const window = this.window;
      if (window !== null && !window.isDestroyed()) {
        window.webContents.send(IPC.configDrivesUpdate, drives);
      }
    } catch (cause) {
      log.warn('[game-config] drive poll failed:', describe(cause));
    } finally {
      this.polling = false;
    }
  }
}
