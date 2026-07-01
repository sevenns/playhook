// Tray icon and context menu (stage 1): "Show" / "Quit".
// A background app lives in the tray; closing the window doesn't quit the program.
import path from 'node:path';
import { Tray, Menu, nativeImage } from 'electron';
import { APP_NAME } from '../shared/types';

export interface TrayCallbacks {
  readonly onShow: () => void;
  readonly onOpenSettings: () => void;
  readonly onQuit: () => void;
}

export function createTray(callbacks: TrayCallbacks): Tray {
  // Dedicated tray icon (simpler than the main app icon so it stays legible at tray size),
  // copied into dist by copy-assets. Falls back to an empty image if missing.
  const iconPath = path.join(__dirname, '../icon-tray.ico');
  const image = nativeImage.createFromPath(iconPath);
  const tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);

  const menu = Menu.buildFromTemplate([
    { label: 'Show launcher', click: () => callbacks.onShow() },
    { label: 'Settings', click: () => callbacks.onOpenSettings() },
    { type: 'separator' },
    { label: 'Quit', click: () => callbacks.onQuit() },
  ]);

  tray.setToolTip(APP_NAME);
  tray.setContextMenu(menu);
  tray.on('click', () => callbacks.onShow());

  return tray;
}
