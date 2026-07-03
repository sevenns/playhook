// Game window (stage 5). Created hidden; shown/force-focused when a card is inserted
// and after exiting a game (R5: so that "press A" via the Gamepad API works in Electron).
// When summoned over a running game (Start+Back), Windows blocks a plain focus() grab; a
// minimize→restore is treated by the OS as a legitimate activation and reliably foregrounds us.
// We deliberately do NOT hold alwaysOnTop — a persistent topmost window traps focus and prevents
// switching back to the game/Steam. A focused fullscreen window already hides the taskbar.
import path from 'node:path';
import { BrowserWindow, Menu, clipboard } from 'electron';
import { type Translator } from '../shared/i18n/index';
import { installHideOnClose, type HideOnCloseGuard } from './window-hide-guard';
import { forceForegroundWindow } from './foreground';

export class GameWindow {
  private window: BrowserWindow | null = null;
  private closeGuard: HideOnCloseGuard | null = null;

  // The current translator is read live so the "Copy" menu (built per right-click) follows the language.
  constructor(private readonly getTranslator: () => Translator) {}

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

    // Right-click on selected text → a minimal "Copy" menu. The UI is non-selectable except the
    // install path in the confirmation popup, so this only ever appears there (selectionText empty
    // elsewhere). Electron shows no context menu by default, so we build this one ourselves.
    window.webContents.on('context-menu', (_event, params) => {
      if (params.selectionText.trim().length === 0) return;
      const menu = Menu.buildFromTemplate([
        {
          label: this.getTranslator()('menu.copy'),
          enabled: params.editFlags.canCopy,
          click: () => {
            clipboard.writeText(params.selectionText);
            // Drop the lingering highlight right after copying (it would otherwise stay selected
            // until the user clicks the text).
            void window.webContents.executeJavaScript('window.getSelection()?.removeAllRanges();');
          },
        },
      ]);
      menu.popup({ window });
    });

    // Closing the window with the X doesn't quit the app — we hide it to the tray (N1).
    this.closeGuard = installHideOnClose(window);

    void window.loadFile(path.join(__dirname, '../renderer/index.html'));
    this.window = window;
    return window;
  }

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
    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    if (!window.isFullScreen()) window.setFullScreen(true);
    window.focus();
    if (forceForeground) {
      // The summon came from the gamepad global hook, which Windows doesn't treat as user input to our
      // window — so the foreground LOCK denies the focus() above real activation: the launcher shows and
      // is even keyboard-focused, but the previous app stays the ACTIVE window (its taskbar shows). The
      // native call lifts the lock (AttachThreadInput) and makes us the true foreground window — taskbar
      // hides, activation is genuine. No-op off Windows; best-effort (a plain tray "Show launcher" is a
      // real click and already gets foreground rights, so it doesn't need this).
      forceForegroundWindow(window.getNativeWindowHandle());
    }
    window.flashFrame(false);
  }

  hide(): void {
    this.window?.hide();
  }

  /** Allows the window to actually close (when quitting the app). */
  allowClose(): void {
    this.closeGuard?.allowClose();
  }
}
