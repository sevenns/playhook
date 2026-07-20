// Tray icon and context menu: "Show" / "Quit".
// A background app lives in the tray; closing the window doesn't quit the program.
import path from 'node:path';
import { Tray, Menu, nativeImage } from 'electron';
import { APP_NAME } from '../shared/types';
import { type Translator } from '../shared/i18n/index';

export interface TrayCallbacks {
  readonly onShow: () => void;
  readonly onOpenConfigureGame: () => void;
  readonly onOpenSettings: () => void;
  /** Add-to-Steam / Remove-from-Steam, per the current `registered` state (Steam Deck only). */
  readonly onToggleSteamShortcut: () => void;
  readonly onQuit: () => void;
}

/**
 * State of the "Add to Steam" item. `visible` is false on Windows and on any run that isn't a packaged
 * AppImage — there the item does not exist at all, rather than existing greyed out.
 */
export interface TraySteamState {
  readonly visible: boolean;
  readonly registered: boolean;
  /** An operation is in flight: the item reads "Working…" and is disabled, so a second click is impossible. */
  readonly busy: boolean;
}

/**
 * Builds the tray context menu for the current translator and Steam state. Pure — that is the only reason
 * it is testable (test/tray.test.ts), so keep it that way: every input arrives as an argument.
 */
export function buildTrayMenu(t: Translator, callbacks: TrayCallbacks, steam: TraySteamState): Menu {
  const steamLabel = steam.busy
    ? t('tray.steamBusy')
    : steam.registered
      ? t('tray.steamRemove')
      : t('tray.steamAdd');
  return Menu.buildFromTemplate([
    { label: t('tray.showLauncher'), click: () => callbacks.onShow() },
    ...(steam.visible
      ? [
          {
            label: steamLabel,
            enabled: !steam.busy,
            click: (): void => callbacks.onToggleSteamShortcut(),
          },
        ]
      : []),
    { label: t('tray.configureGame'), click: () => callbacks.onOpenConfigureGame() },
    { label: t('tray.settings'), click: () => callbacks.onOpenSettings() },
    { type: 'separator' },
    { label: t('tray.quit'), click: () => callbacks.onQuit() },
  ]);
}

export function createTray(t: Translator, callbacks: TrayCallbacks, steam: TraySteamState): Tray {
  // Dedicated tray icon (simpler than the main app icon so it stays legible at tray size), copied into
  // dist by copy-assets. Windows uses the .ico; Linux (Desktop Mode/KDE) needs a PNG — a .ico yields an
  // empty image via nativeImage there (Р8). Falls back to an empty image if the file is missing.
  const iconFile = process.platform === 'win32' ? '../icon-tray.ico' : '../icon-tray.png';
  const iconPath = path.join(__dirname, iconFile);
  const image = nativeImage.createFromPath(iconPath);
  const tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);

  // Tooltip is the product name — not translated.
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(buildTrayMenu(t, callbacks, steam));
  tray.on('click', () => callbacks.onShow());

  return tray;
}
