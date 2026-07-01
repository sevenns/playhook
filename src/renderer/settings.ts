// Settings-window renderer (Fluent UI Web Components v3, dark theme). No gamepad / hero / audio — this
// is the plain "system settings" UI: app version + update management.
//
// Fluent import channel (I-F1 fallback per plan §6.6): web-components.min.js turned out to export
// NOTHING (a pure side-effect bundle), so we can't take setTheme from it. Instead we use the single
// `.`-index resolution graph — pointed `*/define.js` side-effect imports register just the elements we
// use, and setTheme comes from the same `@fluentui/web-components` index. One FAST copy, smaller bundle.
import '@fluentui/web-components/text/define.js';
import '@fluentui/web-components/button/define.js';
import '@fluentui/web-components/radio/define.js';
import '@fluentui/web-components/radio-group/define.js';
import '@fluentui/web-components/progress-bar/define.js';
import { setTheme } from '@fluentui/web-components';
import { webDarkTheme } from '@fluentui/tokens';
import type { AutoUpdateMode, UpdateStatus } from '../shared/types';

setTheme(webDarkTheme);

function req<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} not found`);
  return el as T;
}

const versionEl = req('app-version');
const statusEl = req('update-status');
const progressEl = req('update-progress');
const actionBtn = req('update-action');
const radioGroup = req('auto-update');

// Fluent custom elements reflect `disabled` / `value` as attributes/properties not present on the
// HTMLElement type; narrow casts (never `any`) keep this typed without pulling the element classes in.
function setDisabled(el: HTMLElement, disabled: boolean): void {
  if (disabled) el.setAttribute('disabled', '');
  else el.removeAttribute('disabled');
}

function readGroupValue(el: HTMLElement): AutoUpdateMode | null {
  const raw = (el as HTMLElement & { value?: unknown }).value;
  return raw === 'download' || raw === 'download-install' || raw === 'off' ? raw : null;
}

function setGroupValue(el: HTMLElement, mode: AutoUpdateMode): void {
  (el as HTMLElement & { value?: string }).value = mode;
}

// The context-dependent primary button action for the current status (null = the button is disabled
// or hidden). A single click listener dispatches to it, so render() only swaps label + handler.
let currentAction: (() => void) | null = null;

function showAction(label: string, handler: (() => void) | null, disabled = false): void {
  actionBtn.hidden = false;
  actionBtn.textContent = label;
  setDisabled(actionBtn, disabled || handler === null);
  currentAction = handler;
}

function hideAction(): void {
  actionBtn.hidden = true;
  currentAction = null;
}

function render(status: UpdateStatus): void {
  progressEl.hidden = true;
  switch (status.kind) {
    case 'idle':
      statusEl.textContent = 'Check for updates to see if a new version is available.';
      showAction('Check for updates', () => window.settingsApi.checkForUpdates());
      break;
    case 'not-available':
      statusEl.textContent = 'You’re up to date.';
      showAction('Check for updates', () => window.settingsApi.checkForUpdates());
      break;
    case 'checking':
      statusEl.textContent = 'Checking for updates…';
      showAction('Checking…', null, true);
      break;
    case 'available':
      statusEl.textContent = `Update available: ${status.version}`;
      showAction(`Update to ${status.version}`, () => window.settingsApi.downloadUpdate());
      break;
    case 'downloading':
      statusEl.textContent = `Downloading… ${status.percent}%`;
      progressEl.hidden = false;
      progressEl.setAttribute('value', String(status.percent));
      showAction('Downloading…', null, true);
      break;
    case 'downloaded':
      statusEl.textContent = `Update ${status.version} is ready to install.`;
      showAction('Restart & install', () => window.settingsApi.installUpdate());
      break;
    case 'error':
      statusEl.textContent = status.message;
      showAction('Retry', () => window.settingsApi.checkForUpdates());
      break;
    case 'unsupported':
      statusEl.textContent = 'Updates are available only in the installed build.';
      hideAction();
      break;
  }
}

actionBtn.addEventListener('click', () => {
  currentAction?.();
});

radioGroup.addEventListener('change', () => {
  const value = readGroupValue(radioGroup);
  if (value !== null) window.settingsApi.setAutoUpdate(value);
});

async function init(): Promise<void> {
  // I3: subscribe BEFORE requesting the initial snapshot, so a push arriving in between isn't lost.
  window.settingsApi.onUpdateStatus(render);
  const [version, settings, status] = await Promise.all([
    window.settingsApi.getAppVersion(),
    window.settingsApi.getSettings(),
    window.settingsApi.requestUpdateStatus(),
  ]);
  versionEl.textContent = version;
  setGroupValue(radioGroup, settings.autoUpdate);
  render(status);
}

void init();
