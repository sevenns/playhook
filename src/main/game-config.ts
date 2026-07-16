// Configure-game window backend (IPC handlers + drive polling). Owns everything the window needs:
// listing removable drives (incl. blank ones), reading/validating/saving a card's game.json and the
// manifest JSON Schema. Interface-DI (like UpdaterService/StatsService): the active-root accessor and the
// no-restart reload come from GameController, the theme from AppSettingsStore.
//
// Two security stances mirror manifest.ts's paranoia about untrusted paths:
//  • the renderer's `root` is NEVER trusted — every read/save re-checks it against a fresh
//    listDriveCandidates() (removable, non-system), so a compromised renderer can't write game.json to
//    an arbitrary filesystem location;
//  • Save re-runs the static validation server-side (a race guard against the UI enabling it wrongly).
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
} from '../shared/types';
import { type Translator } from '../shared/i18n/index';
import { type AppSettingsStore } from './app-settings';
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, readImageDataUrl } from './asset-reader';
import { listDriveCandidates } from './drive-watcher';
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
    case 'directory':
    case 'pc-save':
      return [];
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
  /** The current translator (read live so a language change applies to labels/validation/errors). */
  readonly getTranslator: () => Translator;
  /**
   * Reverse-maps an absolute PC folder (from the pcSavePath Browse dialog) to a `%PREFIX%/…` manifest
   * string via the platform SavePathResolver (Р5), or null when it lives under none of the allowed bases.
   * win32 uses the env-based table; linux returns null (the user types the Windows-dictionary string).
   */
  readonly toManifestPcSavePath: (absolute: string) => string | null;
  /**
   * Where the pcSavePath Browse dialog should open for this game (platform SavePathResolver): on Linux the
   * game's Wine prefix, on Windows null (the dialog keeps its own default). null → no defaultPath.
   */
  readonly pcSaveBrowseDir: (gameId: string) => Promise<string | null>;
}

/**
 * The `id` charset the manifest schema enforces — a safe single path segment. The gameId that arrives with
 * a pick request is RAW EDITOR TEXT (the user may be mid-typing anything), and it is about to be joined
 * into a filesystem path, so it is re-validated here at the IPC boundary rather than trusted.
 */
const SAFE_GAME_ID = /^[A-Za-z0-9._-]+$/;

function isSafeGameId(gameId: string | undefined): gameId is string {
  return (
    gameId !== undefined && gameId !== '.' && gameId !== '..' && SAFE_GAME_ID.test(gameId)
  );
}

export class GameConfigService {
  private window: BrowserWindow | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(private readonly deps: GameConfigDeps) {}

  /** Registers all config:* invoke handlers once (the service is a singleton). */
  init(): void {
    ipcMain.handle(IPC.configDrivesRequest, (): Promise<readonly DriveCandidate[]> =>
      listDriveCandidates(this.deps.getActiveRoot(), this.deps.getTranslator()),
    );
    ipcMain.handle(IPC.configRead, (_event, root: string): Promise<ConfigReadResult> =>
      this.readConfig(root),
    );
    ipcMain.handle(IPC.configValidate, (_event, text: string): ConfigValidationResult =>
      validateManifestText(text, this.deps.getTranslator()),
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
        this.pickPath(event.sender, payload.root, payload.kind, payload.gameId),
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
    // 1. main never trusts the renderer's path — it must be a live removable candidate.
    if (!(await this.isAllowedRoot(root))) {
      return { saved: false, message: t('errors.driveUnavailable') };
    }
    // 2. re-validate server-side (guards against a UI race that enabled Save with a stale verdict).
    const validation = validateManifestText(text, t);
    if (!validation.ok) {
      const first = validation.issues[0];
      return {
        saved: false,
        message: first !== undefined ? `${first.path}: ${first.message}` : t('errors.configInvalid'),
      };
    }
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
    gameId?: string,
  ): Promise<ConfigPickResult> {
    const t = this.deps.getTranslator();
    if (!(await this.isAllowedRoot(root))) {
      return { ok: false, message: t('errors.driveUnavailable') };
    }
    const parent = BrowserWindow.fromWebContents(sender);
    // pcSavePath points at a PC folder OUTSIDE the card (env-prefixed), so it has its own dialog: no card
    // root restriction, and the absolute result is converted back to a %PREFIX%/… form the validator accepts.
    if (kind === 'pc-save') {
      // Open in the game's own Wine prefix when we can (Linux): its saves live nowhere else, and the
      // prefix sits under a dot-directory the user would otherwise have to unhide and walk by hand. A
      // malformed/half-typed id simply yields no defaultPath — never a path built from unvalidated text.
      const defaultPath = isSafeGameId(gameId) ? await this.deps.pcSaveBrowseDir(gameId) : null;
      // Logged because a wrong-looking dialog has two very different causes: no defaultPath resolved (id
      // missing / prefix absent) vs the OS ignoring it (a pre-v4 XDG portal drops it — the launcher passes
      // --xdg-portal-required-version=4 to avoid that). The log tells the two apart at a glance.
      log.info(`[game-config] pc-save picker: id="${gameId ?? ''}" defaultPath=${defaultPath ?? '(none)'}`);
      const options: Electron.OpenDialogOptions = {
        properties: ['openDirectory'],
        ...(defaultPath !== null ? { defaultPath } : {}),
      };
      const picked =
        parent !== null ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      const chosen = picked.filePaths[0];
      if (picked.canceled || chosen === undefined) return { ok: false, cancelled: true };
      const pcSavePath = this.deps.toManifestPcSavePath(chosen);
      if (pcSavePath === null) return { ok: false, message: t('configure.pickPcSaveOutside') };
      return { ok: true, paths: [pcSavePath] };
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

  /** True when `root` is a current removable/non-system mountpoint (anti-arbitrary-write check). */
  private async isAllowedRoot(root: string): Promise<boolean> {
    const candidates = await listDriveCandidates(this.deps.getActiveRoot(), this.deps.getTranslator());
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
      const drives = await listDriveCandidates(this.deps.getActiveRoot(), this.deps.getTranslator());
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
