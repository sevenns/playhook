// Game window (stage 5). Created hidden; shown/force-focused when a card is inserted
// and after exiting a game (R5: so that "press A" via the Gamepad API works in Electron).
// When summoned over a running game, Windows blocks the foreground grab and would otherwise
// leave the taskbar/Start visible and flash our taskbar icon — so we raise the window to the top
// of the z-order and cancel the flash. Topmost is bound to focus (focus/blur handlers below):
// on top only while active, released when the user switches away (e.g. to Steam).
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

    // Stay topmost ONLY while focused/active. Otherwise switching away (e.g. double-tap Xbox →
    // Steam) would be blocked: Steam gets focus but our permanently-topmost window covers it.
    window.on('focus', () => {
      if (!window.isDestroyed()) window.setAlwaysOnTop(true);
    });
    window.on('blur', () => {
      if (!window.isDestroyed()) window.setAlwaysOnTop(false);
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
   * Brings the launcher to the foreground (even over a running game) and focuses it so the
   * gamepad is read. Stays topmost while visible so the Windows taskbar/Start doesn't show
   * through; the attention flash (raised when Windows deflects the foreground grab) is cancelled.
   */
  showAndFocus(): void {
    const window = this.window;
    if (window === null) return;
    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    if (!window.isFullScreen()) window.setFullScreen(true);
    window.setAlwaysOnTop(true);
    window.moveTop();
    window.focus();
    window.flashFrame(false);
  }

  hide(): void {
    const window = this.window;
    if (window === null) return;
    window.setAlwaysOnTop(false);
    window.hide();
  }

  /** Allows the window to actually close (when quitting the app). */
  allowClose(): void {
    this.forceClosing = true;
  }
}
