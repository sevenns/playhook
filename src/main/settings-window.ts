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
import { BrowserWindow, nativeTheme } from 'electron';
import { APP_NAME } from '../shared/types';
import { type UpdaterService } from './updater';

export class SettingsWindow {
  private window: BrowserWindow | null = null;

  constructor(private readonly updater: UpdaterService) {}

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
      frame: true,
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
