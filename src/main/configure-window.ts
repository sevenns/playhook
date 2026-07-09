// Configure-game window — a PLAIN desktop window (framed, resizable, not fullscreen/kiosk), opened from
// the tray. A near-exact sibling of SettingsWindow: hidden native title bar + Window Controls Overlay,
// its own preload (configure-preload → window.configureApi), lazy singleton create, X hides to the tray,
// allowClose() lets it really close on app quit / update install. It hosts the game.json editor on
// Fluent UI + CodeMirror, so it's a bit larger than the settings window (JSON needs the room).
//
// It's wired to GameConfigService: attachWindow() on show (so the drive poll runs only while visible and
// the renderer's first getDrives()/push both land), detachWindow() on hide/close (stop pushing/polling
// into a hidden/destroyed window). The WCO recolor channel is OWN (config:titlebar-overlay), not the
// settings one — setTitleBarOverlay must target THIS window's instance.
import path from 'node:path';
import { BrowserWindow, Menu, ipcMain, nativeTheme } from 'electron';
import { APP_NAME, IPC } from '../shared/types';
import { type Translator } from '../shared/i18n/index';
import { type GameConfigService } from './game-config';
import { installHideOnClose, type HideOnCloseGuard } from './window-hide-guard';

const TITLE_BAR_HEIGHT = 48;

// Native caption-button colors for the WCO — must match the custom title bar background in configure.css
// (Fluent colorNeutralBackground1) so the strip looks seamless; `symbolColor` is the glyph color.
const OVERLAY = {
  dark: { color: '#292929', symbolColor: '#ffffff' },
  light: { color: '#ffffff', symbolColor: '#000000' },
} as const;

export class ConfigureWindow {
  private window: BrowserWindow | null = null;
  private closeGuard: HideOnCloseGuard | null = null;
  // Whether the renderer's active tab is the raw JSON editor. Format only makes sense there, so the
  // context menu shows it only when true (the renderer pushes this on every tab switch).
  private jsonEditorActive = false;

  constructor(
    private readonly gameConfig: GameConfigService,
    private readonly getTranslator: () => Translator,
  ) {
    // The renderer computes the effective theme and asks us to recolor the native caption buttons.
    // Registered once here (singleton); guarded on a live window. Its own channel — see the file header.
    ipcMain.on(IPC.configTitleBarOverlay, (_event, dark: boolean) => this.applyOverlay(dark));
    ipcMain.on(IPC.configEditorActive, (_event, active: boolean) => {
      this.jsonEditorActive = active === true;
    });
  }

  /** The native window title (taskbar). Re-applied on a language change (the renderer also sets
   * document.title, otherwise the HTML <title> would override this in the taskbar). */
  private title(): string {
    return `${APP_NAME} — ${this.getTranslator()('window.configureGame')}`;
  }

  /** Re-titles a live window after a language change. */
  refreshTitle(): void {
    const window = this.window;
    if (window !== null && !window.isDestroyed()) window.setTitle(this.title());
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
      this.gameConfig.attachWindow(this.window);
      return;
    }
    this.create();
  }

  private create(): void {
    const window = new BrowserWindow({
      // JSON editing needs more room than the settings form; 640×720 default, with a min that keeps the
      // editor + issues panel usable.
      width: 640,
      height: 720,
      minWidth: 560,
      minHeight: 600,
      show: false,
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        ...(nativeTheme.shouldUseDarkColors ? OVERLAY.dark : OVERLAY.light),
        height: TITLE_BAR_HEIGHT,
      },
      resizable: true,
      fullscreen: false,
      title: this.title(),
      icon: path.join(__dirname, '../icon.ico'),
      // Pre-paint background matched to the OS theme (the renderer applies the real Fluent theme on load)
      // to avoid a dark/light flash before load.
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1f1f' : '#ffffff',
      webPreferences: {
        preload: path.join(__dirname, '../preload/configure-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    // Right-click editing menu for the JSON editor — a sandboxed renderer has no context menu of its own,
    // so main provides one. Clipboard items use native roles (enabled per the focused control's
    // editFlags); Format / Reset are renderer actions, dispatched back over an IPC command channel.
    window.webContents.on('context-menu', (_event, params) => {
      // Clipboard items keep their native ROLE (behaviour) but get an explicit translated LABEL — without
      // it Electron shows its English defaults on Windows. Menu is rebuilt per right-click, so a language
      // change is picked up on its own.
      const t = this.getTranslator();
      const template: Electron.MenuItemConstructorOptions[] = [
        { role: 'cut', label: t('menu.cut'), enabled: params.editFlags.canCut },
        { role: 'copy', label: t('menu.copy'), enabled: params.editFlags.canCopy },
        { role: 'paste', label: t('menu.paste'), enabled: params.editFlags.canPaste },
        { role: 'selectAll', label: t('menu.selectAll'), enabled: params.editFlags.canSelectAll },
      ];
      // Format applies only to the raw JSON editor → offer it only when that tab is active. Reset now lives
      // as a visible button next to Save & Apply (both modes), so it's no longer in this menu.
      if (this.jsonEditorActive) {
        template.push(
          { type: 'separator' },
          { label: t('menu.format'), click: () => window.webContents.send(IPC.configEditorCommand, 'format') },
        );
      }
      Menu.buildFromTemplate(template).popup({ window });
    });

    // X hides to the tray instead of quitting (like GameWindow/SettingsWindow); detach the poll on close.
    this.closeGuard = installHideOnClose(window, () => this.gameConfig.detachWindow());

    // Belt-and-suspenders: also detach when merely hidden, and (re)attach the poll when shown.
    window.on('hide', () => this.gameConfig.detachWindow());
    window.on('show', () => this.gameConfig.attachWindow(window));

    this.window = window;
    // Attach BEFORE loadFile so the renderer can subscribe and request the snapshot as soon as it starts.
    this.gameConfig.attachWindow(window);

    void window.loadFile(path.join(__dirname, '../renderer/configure.html'));

    window.once('ready-to-show', () => {
      window.show();
      window.focus();
    });
  }

  get browserWindow(): BrowserWindow | null {
    return this.window;
  }

  /** Allows the window to actually close (app quit / update install). */
  allowClose(): void {
    this.closeGuard?.allowClose();
  }
}
