// Tray icon and context menu (stage 1): "Show" / "Quit".
// A background app lives in the tray; closing the window doesn't quit the program.
import path from 'node:path';
import { Tray, Menu, nativeImage } from 'electron';
import { APP_NAME } from '../shared/types';
import { type Translator } from '../shared/i18n/index';

export interface TrayCallbacks {
  readonly onShow: () => void;
  readonly onOpenConfigureGame: () => void;
  readonly onOpenSettings: () => void;
  readonly onQuit: () => void;
}

/** Builds the tray context menu for the current translator (re-called on a language change). */
export function buildTrayMenu(t: Translator, callbacks: TrayCallbacks): Menu {
  return Menu.buildFromTemplate([
    { label: t('tray.showLauncher'), click: () => callbacks.onShow() },
    { label: t('tray.configureGame'), click: () => callbacks.onOpenConfigureGame() },
    { label: t('tray.settings'), click: () => callbacks.onOpenSettings() },
    { type: 'separator' },
    { label: t('tray.quit'), click: () => callbacks.onQuit() },
  ]);
}

export function createTray(t: Translator, callbacks: TrayCallbacks): Tray {
  // Dedicated tray icon (simpler than the main app icon so it stays legible at tray size),
  // copied into dist by copy-assets. Falls back to an empty image if missing.
  const iconPath = path.join(__dirname, '../icon-tray.ico');
  const image = nativeImage.createFromPath(iconPath);
  const tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);

  // Tooltip is the product name — not translated.
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(buildTrayMenu(t, callbacks));
  tray.on('click', () => callbacks.onShow());

  return tray;
}
