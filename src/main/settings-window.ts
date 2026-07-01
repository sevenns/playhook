// Settings window — a PLAIN desktop window (framed, fixed size, not fullscreen / not kiosk), opened
// from the tray. Unlike GameWindow it carries NO game design: it hosts the "system settings" UI
// (app version + update management) on Fluent UI Web Components, with its own preload
// (settings-preload → window.settingsApi). Created lazily on first open; a repeat open just focuses
// the existing instance. Closing (X) hides it to the tray (like GameWindow), and allowClose() lets it
// really close on app quit / update install.
//
// The window is wired to UpdaterService: attachWindow() right after create() (so the renderer's first
// requestUpdateStatus() and any early push both land), detachWindow() on hide/close (so the updater
// never pushes into a hidden/destroyed window).
import path from 'node:path';
import { BrowserWindow, ipcMain, nativeTheme } from 'electron';
import { APP_NAME, IPC } from '../shared/types';
import { type UpdaterService } from './updater';

const TITLE_BAR_HEIGHT = 48;

// Native caption-button (min/max/close) colors for the Window Controls Overlay. `color` must match the
// custom title bar's background in settings.css (Fluent colorNeutralBackground1) so the strip looks
// seamless; `symbolColor` is the glyph color.
const OVERLAY = {
  dark: { color: '#292929', symbolColor: '#ffffff' },
  light: { color: '#ffffff', symbolColor: '#000000' },
} as const;

export class SettingsWindow {
  private window: BrowserWindow | null = null;

  constructor(private readonly updater: UpdaterService) {
    // The renderer computes the effective (system-resolved) theme and asks us to recolor the native
    // caption buttons to match. Registered once here (SettingsWindow is a singleton); guarded on a live
    // window. Not part of UpdaterService's settings IPC — this is pure window chrome.
    ipcMain.on(IPC.titleBarOverlayUpdate, (_event, dark: boolean) => this.applyOverlay(dark));
  }

  private applyOverlay(dark: boolean): void {
    const window = this.window;
    if (window === null || window.isDestroyed()) return;
    window.setTitleBarOverlay(dark ? OVERLAY.dark : OVERLAY.light);
  }

  /** Opens the window, creating it lazily on first call; otherwise shows + focuses the existing one. */
  openOrFocus(): void {
    if (this.window !== null && !this.window.isDestroyed()) {
      if (!this.window.isVisible()) this.window.show();
      this.window.focus();
      // Re-attach: the window may have been detached on a previous hide/close.
      this.updater.attachWindow(this.window);
      return;
    }
    this.create();
  }

  private create(): void {
    const window = new BrowserWindow({
      // The default 520×600 is also the MINIMUM — the window is resizable, but can't shrink below the
      // point where the settings layout gets cramped.
      width: 520,
      height: 600,
      minWidth: 520,
      minHeight: 600,
      show: false,
      // A plain desktop window — no game kiosk/fullscreen. autoHideMenuBar is not needed: main.ts
      // already does Menu.setApplicationMenu(null) globally (N6).
      // Windows-11-Settings-style chrome: the native title bar is hidden and the app draws its own
      // (icon + "Playhook (version)" on the left, see settings.html), while the native min/max/close
      // buttons are kept via the Window Controls Overlay — recolored to the theme (initial guess from
      // the OS; the renderer refines it once the effective theme is known).
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        ...(nativeTheme.shouldUseDarkColors ? OVERLAY.dark : OVERLAY.light),
        height: TITLE_BAR_HEIGHT,
      },
      resizable: true,
      fullscreen: false,
      title: `${APP_NAME} — Settings`,
      icon: path.join(__dirname, '../icon.ico'),
      // Pre-paint background matched to the OS theme (the renderer applies the real Fluent theme on
      // load) — avoids a dark flash on a light system and vice-versa. `system` is the default theme.
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1f1f' : '#ffffff',
      webPreferences: {
        preload: path.join(__dirname, '../preload/settings-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    // Closing the window with the X doesn't quit the app — hide it to the tray (like GameWindow).
    window.on('close', (event) => {
      if (!this.forceClosing) {
        event.preventDefault();
        window.hide();
      }
      // Whether it's a real close or a hide, stop the updater from pushing into this window.
      this.updater.detachWindow();
    });

    // Belt-and-suspenders: also detach when the window is merely hidden.
    window.on('hide', () => this.updater.detachWindow());
    window.on('show', () => this.updater.attachWindow(window));

    this.window = window;
    // Attach BEFORE loadFile so the renderer can subscribe and request the snapshot as soon as it
    // starts, and any early push has a live window to reach (I3).
    this.updater.attachWindow(window);

    void window.loadFile(path.join(__dirname, '../renderer/settings.html'));

    // Show only once the content is ready, to avoid a white flash of the framed window.
    window.once('ready-to-show', () => {
      window.show();
      window.focus();
    });
  }

  private forceClosing = false;

  get browserWindow(): BrowserWindow | null {
    return this.window;
  }

  /** Allows the window to actually close (app quit / update install). */
  allowClose(): void {
    this.forceClosing = true;
  }
}
