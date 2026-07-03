// Shared "X hides to tray instead of quitting" window behavior. GameWindow and
// SettingsWindow both had an identical forceClosing flag + on('close')→preventDefault/hide + allowClose
// pair; this centralizes it. `onClose` runs on every close attempt regardless of the guard (e.g. the
// settings window detaches its updater there).
import { type BrowserWindow } from 'electron';

export interface HideOnCloseGuard {
  /** Lets the window actually close on the next X/close (app quit / update install). */
  allowClose(): void;
}

export function installHideOnClose(window: BrowserWindow, onClose?: () => void): HideOnCloseGuard {
  let forceClosing = false;
  window.on('close', (event) => {
    if (!forceClosing) {
      event.preventDefault();
      window.hide();
    }
    onClose?.();
  });
  return {
    allowClose: (): void => {
      forceClosing = true;
    },
  };
}
