// The Settings screen's backend: every settings:* write, the settings snapshot / reset, the audio
// options and the app version the screen shows. Interface-DI (like UpdaterService / NotificationsService):
// each setting that has a live side effect hands the new value to an `on*Changed` callback owned by
// main.ts, which is where the affected service lives (the global gamepad listener, the powerSaveBlocker,
// the game window's audio, the locale, electron-updater's flags). The service itself only persists.
//
// Every write funnels through AppSettingsStore, whose own onChange pushes settings:update to the launcher —
// so no handler here answers with the new snapshot; the screen repaints from that push.
import path from 'node:path';
import fs from 'node:fs/promises';
import { ipcMain } from 'electron';
import { log } from './logger';
import {
  IPC,
  type AppSettings,
  type AudioOptions,
  type AudioVolumes,
  type AutoUpdateMode,
  type LanguageMode,
} from '../shared/types';
import { type AppSettingsStore } from './app-settings';
import { DEFAULT_SOUND_SET } from './asset-reader';

export interface SettingsServiceDeps {
  readonly settings: AppSettingsStore;
  /** The running app's version, shown on the Settings screen. */
  readonly appVersion: () => string;
  /** Whether the Steam-shortcut feature exists on this machine (linux + packaged AppImage). */
  readonly isSteamAvailable: () => boolean;
  /** Applies a persisted auto-update mode to electron-updater (a no-op where updates are unsupported). */
  readonly onAutoUpdateModeChanged: (mode: AutoUpdateMode) => void;
  /** Applies the pre-release channel flag to electron-updater (a no-op where updates are unsupported). */
  readonly onPrereleaseChanged: (on: boolean) => void;
  /** Applies the Start+Back summon-hotkey toggle to the running global gamepad listener. */
  readonly onSummonHotkeyChanged: (enabled: boolean) => void;
  /** Applies the keep-display-awake toggle (recomputes the powerSaveBlocker in main). */
  readonly onPreventScreensaverChanged: (enabled: boolean) => void;
  /**
   * Applies the Game Mode auto-launch toggle: installs or tears down the watcher service. Steam Deck
   * only; a no-op elsewhere.
   */
  readonly onSteamAutoLaunchChanged: (enabled: boolean) => Promise<void>;
  /** Applies the "always show the no-card screen" toggle (reconciles the launcher's visibility). */
  readonly onKeepOpenWithoutCardChanged: (enabled: boolean) => void;
  /** Pushes new audio volumes to the game renderer so they apply live. */
  readonly onVolumesChanged: (volumes: AudioVolumes) => void;
  /** Applies a navigation-sound-set change (re-reads + re-pushes the current sfx to the game window). */
  readonly onSoundSetChanged: (set: string) => void;
  /** Applies an "only global ambience" toggle (recomputes + re-pushes the card's music). */
  readonly onAudioScopeChanged: () => void;
  /** Applies a default-ambience change (re-reads the track + pushes it to the game window). */
  readonly onAmbientChanged: (track: string | null) => void;
  /** Applies a UI-language change (re-resolve locale, rebuild tray/titles, push to live windows). */
  readonly onLanguageChanged: (mode: LanguageMode) => void;
}

export class SettingsService {
  constructor(private readonly deps: SettingsServiceDeps) {}

  /**
   * The single point where all settings:* / app:version / volume / audio-options IPC is registered.
   * Keeping IPC registration here — and NOWHERE else — rules out a duplicate ipcMain.handle (a crash)
   * or a forgotten channel.
   */
  init(): void {
    ipcMain.handle(IPC.settingsRequest, () => this.deps.settings.read());
    // Drives whether the Steam settings are rendered at all — the renderer has no way to know the OS.
    ipcMain.handle(IPC.settingsSteamAvailable, () => this.deps.isSteamAvailable());
    ipcMain.on(IPC.settingsSetAutoUpdate, (_event, mode: AutoUpdateMode) => {
      void this.deps.settings
        .setAutoUpdate(mode)
        .then(() => this.deps.onAutoUpdateModeChanged(mode))
        .catch((cause: unknown) =>
          log.error('[settings] failed to persist auto-update mode:', cause),
        );
    });
    ipcMain.on(IPC.settingsSetPrerelease, (_event, on: boolean) => {
      void this.deps.settings
        .patch({ allowPrerelease: on })
        .then(() => this.deps.onPrereleaseChanged(on))
        .catch((cause: unknown) =>
          log.error('[settings] failed to persist prerelease flag:', cause),
        );
    });
    ipcMain.on(IPC.settingsSetSummonHotkey, (_event, on: boolean) => {
      void this.deps.settings
        .patch({ summonHotkeyEnabled: on })
        .then(() => this.deps.onSummonHotkeyChanged(on))
        .catch((cause: unknown) => log.error('[settings] failed to persist summon hotkey:', cause));
    });
    ipcMain.on(IPC.settingsSetPreventScreensaver, (_event, on: boolean) => {
      void this.deps.settings
        .patch({ preventScreensaver: on })
        .then(() => this.deps.onPreventScreensaverChanged(on))
        .catch((cause: unknown) =>
          log.error('[settings] failed to persist prevent-screensaver:', cause),
        );
    });
    ipcMain.on(IPC.settingsSetKeepOpenWithoutCard, (_event, on: boolean) => {
      void this.deps.settings
        .patch({ keepOpenWithoutCard: on })
        .then(() => this.deps.onKeepOpenWithoutCardChanged(on))
        .catch((cause: unknown) =>
          log.error('[settings] failed to persist always-show-empty-screen:', cause),
        );
    });
    // No side-effect on toggle: the install flow reads disableSilentInstall from settings at install time.
    ipcMain.on(IPC.settingsSetSteamAutoLaunch, (_event, on: boolean) => {
      this.deps.settings
        .patch({ steamAutoLaunch: on })
        .then(() => this.deps.onSteamAutoLaunchChanged(on))
        .catch((cause: unknown) => log.error('[settings] failed to set steam auto-launch:', cause));
    });

    ipcMain.on(IPC.settingsSetDisableSilentInstall, (_event, on: boolean) => {
      void this.deps.settings
        .patch({ disableSilentInstall: on })
        .catch((cause: unknown) =>
          log.error('[settings] failed to persist disable-silent-install:', cause),
        );
    });
    ipcMain.on(IPC.settingsSetMusicVolume, (_event, volume: number) => {
      void this.setVolume({ musicVolume: volume });
    });
    ipcMain.on(IPC.settingsSetSfxVolume, (_event, volume: number) => {
      void this.setVolume({ sfxVolume: volume });
    });
    ipcMain.on(IPC.settingsSetSoundSet, (_event, set: string) => {
      void this.deps.settings
        .patch({ soundSet: set })
        .then(() => this.deps.onSoundSetChanged(set))
        .catch((cause: unknown) => log.error('[settings] failed to persist sound set:', cause));
    });
    ipcMain.on(IPC.settingsSetAmbientTrack, (_event, track: string | null) => {
      void this.deps.settings
        .patch({ ambientTrack: track })
        .then(() => this.deps.onAmbientChanged(track))
        .catch((cause: unknown) => log.error('[settings] failed to persist ambient track:', cause));
    });
    ipcMain.on(IPC.settingsSetOnlyGlobalAmbient, (_event, on: boolean) => {
      void this.deps.settings
        .patch({ onlyGlobalAmbient: on })
        .then(() => this.deps.onAudioScopeChanged())
        .catch((cause: unknown) =>
          log.error('[settings] failed to persist only-global-ambient:', cause),
        );
    });
    // No side-effect on change: MetadataService reads the key from settings at request time, so the next
    // search already uses whatever was typed here.
    ipcMain.on(IPC.settingsSetSteamGridDbKey, (_event, key: string) => {
      void this.deps.settings
        .patch({ steamGridDbApiKey: key })
        .catch((cause: unknown) =>
          log.error('[settings] failed to persist the SteamGridDB key:', cause),
        );
    });
    // Language mirrors the summon-hotkey path: persist, then hand the mode to the deps callback (main
    // re-resolves the locale, rebuilds tray/titles and pushes the effective locale to every live window).
    ipcMain.on(IPC.settingsSetLanguage, (_event, mode: LanguageMode) => {
      void this.deps.settings
        .setLanguage(mode)
        .then(() => this.deps.onLanguageChanged(mode))
        .catch((cause: unknown) => log.error('[settings] failed to persist language:', cause));
    });
    ipcMain.handle(IPC.settingsReset, (): Promise<AppSettings> => this.resetSettings());
    // game-renderer startup: hand it the current volumes to seed its AudioController.
    ipcMain.handle(IPC.volumeRequest, async (): Promise<AudioVolumes> => {
      const settings = await this.deps.settings.read();
      return { music: settings.musicVolume, sfx: settings.sfxVolume };
    });
    ipcMain.handle(IPC.appVersionRequest, (): string => this.deps.appVersion());
    ipcMain.handle(IPC.audioOptionsRequest, (): Promise<AudioOptions> => this.readAudioOptions());
  }

  // Resets settings to defaults and re-applies every side effect (auto-update mode, prerelease flag,
  // summon-hotkey toggle, renderer volumes). The Settings screen repaints from the settings:update push
  // the write itself emits (AppSettingsStore.onChange), not from this return value — which is kept
  // because settings:reset is an invoke.
  private async resetSettings(): Promise<AppSettings> {
    const next = await this.deps.settings.reset();
    this.deps.onPrereleaseChanged(next.allowPrerelease);
    this.deps.onAutoUpdateModeChanged(next.autoUpdate);
    this.deps.onSummonHotkeyChanged(next.summonHotkeyEnabled);
    this.deps.onPreventScreensaverChanged(next.preventScreensaver);
    this.deps.onKeepOpenWithoutCardChanged(next.keepOpenWithoutCard);
    // A reset turns auto-launch back on — the watcher unit has to come back with it, or the setting
    // would say "on" while nothing is actually watching.
    await this.deps.onSteamAutoLaunchChanged(next.steamAutoLaunch);
    this.deps.onVolumesChanged({ music: next.musicVolume, sfx: next.sfxVolume });
    this.deps.onSoundSetChanged(next.soundSet);
    this.deps.onAmbientChanged(next.ambientTrack);
    this.deps.onLanguageChanged(next.language);
    return next;
  }

  // Persists a volume change and pushes the full volume pair to the game renderer so it applies live.
  private async setVolume(
    partial: { musicVolume?: number } | { sfxVolume?: number },
  ): Promise<void> {
    try {
      const next = await this.deps.settings.patch(partial);
      this.deps.onVolumesChanged({ music: next.musicVolume, sfx: next.sfxVolume });
    } catch (cause) {
      log.error('[settings] failed to persist volume:', cause);
    }
  }

  // The bundled sound sets + ambience tracks, read once from dist/audio/index.json (generated at build
  // time by copy-assets — the runtime never does a readdir over the asar). A read/parse failure falls back
  // to a minimal, always-valid set so the settings dropdowns still populate.
  private audioOptions: AudioOptions | null = null;
  private async readAudioOptions(): Promise<AudioOptions> {
    if (this.audioOptions !== null) return this.audioOptions;
    try {
      const text = await fs.readFile(path.join(__dirname, '../audio/index.json'), 'utf8');
      const parsed = JSON.parse(text) as { soundSets?: unknown; ambientTracks?: unknown };
      const asStringArray = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
      const soundSets = asStringArray(parsed.soundSets);
      this.audioOptions = {
        soundSets: soundSets.length > 0 ? soundSets : [DEFAULT_SOUND_SET],
        ambientTracks: asStringArray(parsed.ambientTracks),
      };
    } catch (cause) {
      log.warn('[settings] failed to read audio index — using defaults:', cause);
      this.audioOptions = { soundSets: [DEFAULT_SOUND_SET], ambientTracks: [] };
    }
    return this.audioOptions;
  }
}
