// The controller's seams: what it needs from each collaborator, as interfaces rather than the classes
// (a unit test stands in a fake per seam — see test/game-controller.test.ts), plus the process waits and
// the koffi-bound helpers it drives. Type-only, next to the controller that consumes them.
import {
  type ConfigSaveResult,
  type GameCollisionAnswer,
} from '../shared/types';
import { type Translator } from '../shared/i18n/index';
import { type StateManager } from './state';
import { type GameWindow } from './window';
import { type PcStore } from './pc-store';
import { type StatsService } from './stats';
import { type LibraryStore } from './library-store';
import { type PcLibraryStore } from './pc-library';
import { type HistorySyncLibrary } from './history-sync';
import { type DriveWatcher } from './drive-watcher';
import {
  type waitForExit,
  type waitForStart,
  type waitForWatchedExit,
  type waitForWatchedStart,
  type waitForSteamStart,
  type waitForSteamExit,
  type killImagesElevated,
} from './game-launcher';
import { type Platform } from './platform';
import { type AppSettingsStore } from './app-settings';
import { type NotificationsService } from './notifications';
import { type focusGameWindow } from './window-finder';

/**
 * What the collision answer needs from the Customize backend (GameConfigService). Attached after
 * construction — the service is built from this controller, so it cannot also be one of its deps.
 */
export interface CollisionResolver {
  /** The card's content signature right now, or null when it cannot be read. */
  signatureFor(root: string): Promise<string | null>;
  /** Puts a local game's name and artwork onto the card that carries the same id. */
  mergeCollision(answer: GameCollisionAnswer): Promise<ConfigSaveResult>;
  /** Drops a local game from the PC library (the draft whose look has just moved onto the card). */
  removeLocalGame(id: string): Promise<ConfigSaveResult>;
}

/**
 * The process waits and the win32-only FFI helpers the sequences drive. Injected rather than imported:
 * the waits poll on second-long cadences (a real exit wait is three misses 2.5 s apart), and
 * `killImagesElevated` / `focusGameWindow` bind koffi — so a test of the controller hands in fast fakes
 * and never touches the native side.
 */
export interface ProcessControl {
  readonly waitForStart: typeof waitForStart;
  readonly waitForExit: typeof waitForExit;
  readonly waitForWatchedStart: typeof waitForWatchedStart;
  readonly waitForWatchedExit: typeof waitForWatchedExit;
  readonly waitForSteamStart: typeof waitForSteamStart;
  readonly waitForSteamExit: typeof waitForSteamExit;
  readonly killImagesElevated: typeof killImagesElevated;
  readonly focusGameWindow: typeof focusGameWindow;
}

// The slices of each collaborator the controller actually calls. Interfaces rather than the classes so a
// unit test can stand in a fake per seam (see test/game-controller.test.ts) — the classes themselves reach
// for electron and the disk.
export type ControllerState = Pick<StateManager, 'get' | 'set' | 'subscribe'>;
export type ControllerWindow = Pick<GameWindow, 'send' | 'showAndFocus' | 'hide' | 'isShown'>;
export type ControllerStore = Pick<
  PcStore,
  'getPending' | 'clearPending' | 'readSyncState' | 'writeSyncState' | 'enqueuePcToSd' | 'hasCardSyncState'
>;
export type ControllerStats = Pick<
  StatsService,
  'read' | 'readCardStatsMap' | 'reconcileWithCard' | 'copyToCard' | 'recordPlay'
>;
export type ControllerLibrary = HistorySyncLibrary &
  Pick<
    LibraryStore,
    | 'entry'
    | 'entriesForCarousel'
    | 'saveFromCard'
    | 'noteLaunch'
    | 'forget'
    | 'readBrowseAssets'
    | 'readGridThumb'
    | 'clearCollisionAnswers'
    | 'markCollisionResolved'
  >;
export type ControllerPcLibrary = Pick<PcLibraryStore, 'read' | 'gcOrphans'>;
export type ControllerWatcher = Pick<DriveWatcher, 'onInsert' | 'onRemove' | 'onError' | 'stop'>;
export type ControllerSettings = Pick<AppSettingsStore, 'read'>;
export type ControllerNotifications = Pick<NotificationsService, 'notify'>;

export interface ControllerDeps {
  readonly state: ControllerState;
  readonly window: ControllerWindow;
  readonly store: ControllerStore;
  readonly stats: ControllerStats;
  /** The play history behind the carousel: copied art/audio of every game inserted on this device. */
  readonly library: ControllerLibrary;
  /** The local games added from this PC's own disk — a second, always-present manifest source. */
  readonly pcLibrary: ControllerPcLibrary;
  readonly watcher: ControllerWatcher;
  /** App-wide settings store — read/patched by the custom-wallpaper handlers (they own AssetReader). */
  readonly settings: ControllerSettings;
  /**
   * The notification inbox. Fed from the SUCCESS paths of the install/uninstall sequences only — never
   * from a state transition: `failSequence` ends in `enterReady` too, and a Steam install never enters
   * `installing` at all, so "it finished" cannot be read off the state machine.
   */
  readonly notifications: ControllerNotifications;
  /** Platform services (process monitor, Steam locator, launcher, save-path resolver, power) for the OS. */
  readonly platform: Platform;
  /** The process waits + the koffi-bound helpers (see ProcessControl). */
  readonly processControl: ProcessControl;
  /**
   * Whether this is a SteamOS Game Mode (gamescope) session. In Game Mode there is no tray, so every path
   * that would hide the window to the tray instead keeps the empty/error screen up. Always false on
   * Windows/desktop, so their behaviour is unchanged.
   */
  readonly isGamescope: boolean;
  /** The current translator (read live so a language change applies to freshly-generated messages). */
  readonly getTranslator: () => Translator;
}
