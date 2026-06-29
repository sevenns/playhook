// Game window (stage 5). Created hidden; shown/force-focused when a card is inserted
// and after exiting a game (R5: so that "press A" via the Gamepad API works in Electron).
// When summoned over a running game (Start+Back), Windows blocks a plain focus() grab; a
// minimize→restore is treated by the OS as a legitimate activation and reliably foregrounds us.
// We deliberately do NOT hold alwaysOnTop — a persistent topmost window traps focus and prevents
// switching back to the game/Steam. A focused fullscreen window already hides the taskbar.
import path from 'node:path';
import { BrowserWindow } from 'electron';

export class GameWindow {
  private window: BrowserWindow | null = null;

  create(): BrowserWindow {
    const window = new BrowserWindow({
      // width/height act as the windowed fallback if fullscreen is ever toggled off.
      width: 960,
      height: 600,
      show: false,
      // Frameless: no native title bar / window chrome. Closing is done via the in-app
      // Exit button or gamepad B (hides to tray); full quit is in the tray menu.
      frame: false,
      // Fullscreen launcher: the window covers the whole screen (incl. taskbar) when shown.
      fullscreen: true,
      icon: path.join(__dirname, '../icon.ico'),
      backgroundColor: '#101014',
      webPreferences: {
        preload: path.join(__dirname, '../preload/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Kiosk launcher: let background music / UI sounds start without a prior user gesture
        // (Chromium otherwise blocks audible autoplay until the first interaction).
        autoplayPolicy: 'no-user-gesture-required',
      },
    });

    // Closing the window with the X doesn't quit the app — we hide it to the tray.
    window.on('close', (event) => {
      if (!this.forceClosing) {
        event.preventDefault();
        window.hide();
      }
    });

    void window.loadFile(path.join(__dirname, '../renderer/index.html'));
    this.window = window;
    return window;
  }

  private forceClosing = false;

  get browserWindow(): BrowserWindow | null {
    return this.window;
  }

  /**
   * Shows and focuses the launcher. With `forceForeground` (the Start+Back hotkey, summoning over
   * a running game) it does a minimize→restore to reliably grab the foreground — at the cost of a
   * brief blink. We never hold alwaysOnTop, so focus is never trapped: switching back to the game
   * or to Steam works normally. A focused fullscreen window already hides the taskbar.
   */
  showAndFocus(forceForeground = false): void {
    const window = this.window;
    if (window === null) return;
    if (!window.isVisible()) window.show();
    if (forceForeground) {
      window.minimize();
      window.restore();
    }
    if (!window.isFullScreen()) window.setFullScreen(true);
    window.focus();
    window.flashFrame(false);
  }

  hide(): void {
    this.window?.hide();
  }

  /** Allows the window to actually close (when quitting the app). */
  allowClose(): void {
    this.forceClosing = true;
  }
}
