// Tray icon and context menu: "Show" / "Quit".
// Settings are NOT here: the launcher's own Settings screen (More → Settings) is the single entrance,
// so Game Mode — which has no tray at all — reaches them the same way the desktop does.
// A background app lives in the tray; closing the window doesn't quit the program.
import path from 'node:path';
import { Tray, Menu, nativeImage, type NativeImage } from 'electron';
import { APP_NAME } from '../shared/types';
import { type Translator } from '../shared/i18n/index';

export interface TrayCallbacks {
  readonly onShow: () => void;
  /** Opens the log folder in the OS file manager (moved here from the settings window). */
  readonly onOpenLogs: () => void;
  /** Opens the app-controlled games install folder (moved here from the settings window). */
  readonly onOpenGamesFolder: () => void;
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
    { label: t('settings.openLogs'), click: () => callbacks.onOpenLogs() },
    { label: t('settings.openGames'), click: () => callbacks.onOpenGamesFolder() },
    { type: 'separator' },
    { label: t('tray.quit'), click: () => callbacks.onQuit() },
  ]);
}

/** The macOS menu bar is 22pt tall; a tray image is expected at that size, with a 2x representation. */
const MENU_BAR_ICON_PT = 22;

/**
 * The menu-bar-sized version of the app icon for macOS. The shipped `icon.png` is 256×256 — handing that
 * to `Tray` gives a soft, oversized item, because macOS scales whatever it is given down to the bar height.
 * A 2x representation is attached alongside so a Retina display gets the sharp variant.
 *
 * Deliberately NOT a template image: `setTemplateImage(true)` renders only the alpha channel, which would
 * turn the coloured logo into a black silhouette. If the colour ever reads badly against a dark menu bar,
 * the fix is a dedicated monochrome `iconTemplate.png` asset, not flattening this one.
 */
function menuBarImage(source: NativeImage): NativeImage {
  const image = source.resize({ width: MENU_BAR_ICON_PT, height: MENU_BAR_ICON_PT, quality: 'best' });
  const retina = source.resize({
    width: MENU_BAR_ICON_PT * 2,
    height: MENU_BAR_ICON_PT * 2,
    quality: 'best',
  });
  image.addRepresentation({ scaleFactor: 2, dataURL: retina.toDataURL() });
  return image;
}

export function createTray(t: Translator, callbacks: TrayCallbacks, steam: TraySteamState): Tray {
  // The app icon doubles as the tray icon (the separate icon-tray.* files are gone), copied into dist by
  // copy-assets. Windows uses the .ico; Linux (Desktop Mode/KDE) and macOS need a PNG — a .ico yields an
  // empty image via nativeImage there. Falls back to an empty image if the file is missing.
  const iconFile = process.platform === 'win32' ? '../icon.ico' : '../icon.png';
  const iconPath = path.join(__dirname, iconFile);
  const loaded = nativeImage.createFromPath(iconPath);
  const image =
    !loaded.isEmpty() && process.platform === 'darwin' ? menuBarImage(loaded) : loaded;
  const tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);

  // Tooltip is the product name — not translated.
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(buildTrayMenu(t, callbacks, steam));
  tray.on('click', () => callbacks.onShow());

  return tray;
}
