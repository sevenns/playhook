// Configure-game window backend (IPC handlers + drive polling). Owns everything the window needs:
// listing removable drives (incl. blank ones), reading/validating/saving a card's game.json, the
// starter templates and the manifest JSON Schema. Interface-DI (like UpdaterService/StatsService): the
// active-root accessor and the no-restart reload come from GameController, the theme from AppSettingsStore.
//
// Two security stances mirror manifest.ts's paranoia about untrusted paths:
//  • the renderer's `root` is NEVER trusted — every read/save re-checks it against a fresh
//    listDriveCandidates() (removable, non-system), so a compromised renderer can't write game.json to
//    an arbitrary filesystem location;
//  • Save re-runs the static validation server-side (a race guard against the UI enabling it wrongly).
import path from 'node:path';
import fs from 'node:fs/promises';
import fse from 'fs-extra';
import { app, ipcMain, type BrowserWindow } from 'electron';
import {
  IPC,
  MANIFEST_FILENAME,
  type AppSettings,
  type ConfigReadResult,
  type ConfigSaveResult,
  type ConfigValidationResult,
  type ConfigTemplates,
  type DriveCandidate,
} from '../shared/types';
import { type Translator } from '../shared/i18n/index';
import { type AppSettingsStore } from './app-settings';
import { listDriveCandidates } from './drive-watcher';
import { validateManifestText, manifestJsonSchema } from './manifest';
import { MANIFEST_TEMPLATES } from './manifest-templates';
import { writeFileAtomic } from './save-sync';
import { describe } from './util';
import { log } from './logger';

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
    ipcMain.handle(IPC.configTemplatesRequest, (): ConfigTemplates => MANIFEST_TEMPLATES);
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
