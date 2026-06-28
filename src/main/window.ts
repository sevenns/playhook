// Game window (stage 5). Created hidden; shown/force-focused when a card is inserted
// and after exiting a game (R5: so that "press A" via the Gamepad API works in Electron).
// We briefly raise alwaysOnTop to grab focus, then drop it.
import path from 'node:path';
import { BrowserWindow } from 'electron';

const ALWAYS_ON_TOP_PULSE_MS = 600;

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
      backgroundColor: '#101014',
      webPreferences: {
        preload: path.join(__dirname, '../preload/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
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

  /** Shows the window and forces focus (an alwaysOnTop pulse) so the gamepad is read. */
  showAndFocus(): void {
    const window = this.window;
    if (window === null) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.setAlwaysOnTop(true);
    window.focus();
    setTimeout(() => {
      if (!window.isDestroyed()) window.setAlwaysOnTop(false);
    }, ALWAYS_ON_TOP_PULSE_MS);
  }

  hide(): void {
    this.window?.hide();
  }

  /** Allows the window to actually close (when quitting the app). */
  allowClose(): void {
    this.forceClosing = true;
  }
}
