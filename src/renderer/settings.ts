// Settings-window renderer (Fluent UI Web Components v3, dark theme). No gamepad / hero / audio — this
// is the plain "system settings" UI: app version + update management.
//
// Fluent import channel (fallback): web-components.min.js turned out to export
// NOTHING (a pure side-effect bundle), so we can't take setTheme from it. Instead we use the single
// `.`-index resolution graph — pointed `*/define.js` side-effect imports register just the elements we
// use, and setTheme comes from the same `@fluentui/web-components` index. One FAST copy, smaller bundle.
import '@fluentui/web-components/text/define.js';
import '@fluentui/web-components/button/define.js';
import '@fluentui/web-components/field/define.js';
import '@fluentui/web-components/dropdown/define.js';
import '@fluentui/web-components/listbox/define.js';
import '@fluentui/web-components/option/define.js';
import '@fluentui/web-components/switch/define.js';
import '@fluentui/web-components/slider/define.js';
import '@fluentui/web-components/progress-bar/define.js';
import { setTheme } from '@fluentui/web-components';
import { webDarkTheme, webLightTheme } from '@fluentui/tokens';
import type { AppSettings, AutoUpdateMode, LanguageMode, ThemeMode, UpdateStatus } from '../shared/types';
import { createTranslator, type Locale, type Translator } from '../shared/i18n/index.js';
import { localizeDocument } from './i18n-dom.js';

// Translator, refreshed on a language push. The HTML ships English fallback so there's no blank flash
// before the invoke-seed lands.
let translator: Translator = createTranslator('en');

// ── Theme ────────────────────────────────────────────────────────────────────
// setTheme publishes the theme tokens as global CSS custom properties (see settings.css). `system`
// follows the OS preference via matchMedia and re-applies on OS changes; `light`/`dark` are fixed.
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
let systemListener: (() => void) | null = null;

function isDark(mode: ThemeMode): boolean {
  return mode === 'dark' || (mode === 'system' && darkQuery.matches);
}

function paint(dark: boolean): void {
  setTheme(dark ? webDarkTheme : webLightTheme);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  // Keep the native caption buttons (min/max/close) in sync with the effective theme.
  window.settingsApi.setTitleBarDark(dark);
}

function applyTheme(mode: ThemeMode): void {
  paint(isDark(mode));
  // Only keep an OS-change subscription alive in `system` mode.
  if (systemListener !== null) {
    darkQuery.removeEventListener('change', systemListener);
    systemListener = null;
  }
  if (mode === 'system') {
    systemListener = () => paint(darkQuery.matches);
    darkQuery.addEventListener('change', systemListener);
  }
}

// Apply a best-guess theme immediately (before settings load) to avoid a flash of unstyled tokens.
applyTheme('system');

function req<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} not found`);
  return el as T;
}

const titlebarIcon = req<HTMLImageElement>('titlebar-icon');
const titlebarVersion = req('titlebar-version');
const statusEl = req('update-status');
const progressEl = req('update-progress');
const actionBtn = req('update-action');
const autoUpdateGroup = req('auto-update');
const themeGroup = req('theme');
const languageGroup = req('language');
const prereleaseSwitch = req('prerelease');
const summonSwitch = req('summon-hotkey');
const musicSlider = req('music-volume');
const musicValue = req('music-volume-value');
const sfxSlider = req('sfx-volume');
const sfxValue = req('sfx-volume-value');
const openLogsBtn = req('open-logs');
const openGamesBtn = req('open-games');
const resetBtn = req('reset-defaults');

// Fluent custom elements reflect `disabled` / `value` as attributes/properties not present on the
// HTMLElement type; narrow casts (never `any`) keep this typed without pulling the element classes in.
function setDisabled(el: HTMLElement, disabled: boolean): void {
  if (disabled) el.setAttribute('disabled', '');
  else el.removeAttribute('disabled');
}

function readAutoUpdateValue(el: HTMLElement): AutoUpdateMode | null {
  const raw = (el as HTMLElement & { value?: unknown }).value;
  return raw === 'download' || raw === 'download-install' || raw === 'off' ? raw : null;
}

function readThemeValue(el: HTMLElement): ThemeMode | null {
  const raw = (el as HTMLElement & { value?: unknown }).value;
  return raw === 'system' || raw === 'light' || raw === 'dark' ? raw : null;
}

function readLanguageValue(el: HTMLElement): LanguageMode | null {
  const raw = (el as HTMLElement & { value?: unknown }).value;
  return raw === 'system' || raw === 'en' || raw === 'ru' ? raw : null;
}

// fluent-dropdown exposes a settable `value` (the selected option's value): setting it re-runs the
// component's selectOption, which also refreshes the collapsed control text. Kept as a narrow cast so we
// don't pull the element class in.
function setDropdownValue(el: HTMLElement, value: string): void {
  (el as HTMLElement & { value?: string | null }).value = value;
}

// Re-asserts the dropdown's current value so the collapsed control text re-renders from the (possibly
// just re-localized) selected option. selectOption reads option.text at selection time, so without this a
// language change would leave the old-language label showing in the closed control.
function refreshDropdownDisplay(el: HTMLElement): void {
  const dd = el as HTMLElement & { value?: string | null };
  const current = dd.value;
  if (typeof current === 'string') dd.value = current;
}

// fluent-switch exposes a `checked` property; fluent-slider a numeric `valueAsNumber` / string `value`.
// Narrow casts (never `any`) keep these typed without importing the element classes.
function readChecked(el: HTMLElement): boolean {
  return (el as HTMLElement & { checked?: boolean }).checked === true;
}

function setChecked(el: HTMLElement, checked: boolean): void {
  (el as HTMLElement & { checked?: boolean }).checked = checked;
}

function readSliderPercent(el: HTMLElement): number {
  const value = (el as HTMLElement & { valueAsNumber?: number }).valueAsNumber;
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
}

function setSliderPercent(el: HTMLElement, percent: number): void {
  (el as HTMLElement & { value?: string }).value = String(percent);
}

// The default "move" UI sound, loaded as a data URL (settings CSP allows media-src data:). Played as a
// volume preview when a slider is released. Null until it loads (or if it failed to load).
let moveSound: HTMLAudioElement | null = null;
void window.settingsApi.getMoveSound().then((url) => {
  if (url !== '') moveSound = new Audio(url);
});

// Plays the move sound at the slider's current level — the "how loud is this" preview.
function previewVolume(slider: HTMLElement): void {
  if (moveSound === null) return;
  // Clone so overlapping releases don't cut each other off (as the game renderer does for SFX).
  const node = moveSound.cloneNode() as HTMLAudioElement;
  node.volume = readSliderPercent(slider) / 100;
  void node.play().catch(() => undefined);
}

// Wires a volume slider: updates the live "N%" label on every input, persists the 0..1 volume on change
// (drag-commit), and plays a preview at the released level on pointer-up. The preview keys off pointerup
// (not change, which fires continuously during a drag) so it sounds once when the mouse is released; the
// one-shot window listener catches releases even when the pointer leaves the slider.
function wireVolumeSlider(
  slider: HTMLElement,
  valueEl: HTMLElement,
  persist: (volume: number) => void,
): void {
  const showValue = (): void => {
    valueEl.textContent = `${readSliderPercent(slider)}%`;
  };
  slider.addEventListener('input', showValue);
  slider.addEventListener('change', () => {
    showValue();
    persist(readSliderPercent(slider) / 100);
  });
  slider.addEventListener('pointerdown', () => {
    window.addEventListener('pointerup', () => previewVolume(slider), { once: true });
  });
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

// Last rendered status, cached so a language push can re-render the Updates block in the new language
// (render is otherwise only called on a status change). null before the first snapshot.
let lastStatus: UpdateStatus | null = null;

function render(status: UpdateStatus): void {
  lastStatus = status;
  const t = translator;
  progressEl.hidden = true;
  switch (status.kind) {
    case 'idle':
      statusEl.textContent = t('settings.status.idle');
      showAction(t('settings.action.check'), () => window.settingsApi.checkForUpdates());
      break;
    case 'not-available':
      statusEl.textContent = t('settings.status.upToDate');
      showAction(t('settings.action.check'), () => window.settingsApi.checkForUpdates());
      break;
    case 'checking':
      statusEl.textContent = t('settings.status.checking');
      showAction(t('settings.action.checking'), null, true);
      break;
    case 'available':
      statusEl.textContent = t('settings.status.available', { version: status.version });
      showAction(t('settings.action.updateTo', { version: status.version }), () =>
        window.settingsApi.downloadUpdate(),
      );
      break;
    case 'downloading':
      statusEl.textContent = t('settings.status.downloading', { percent: status.percent });
      progressEl.hidden = false;
      progressEl.setAttribute('value', String(status.percent));
      showAction(t('settings.action.downloading'), null, true);
      break;
    case 'downloaded':
      statusEl.textContent = t('settings.status.downloaded', { version: status.version });
      showAction(t('settings.action.restartInstall'), () => window.settingsApi.installUpdate());
      break;
    case 'error':
      // The message is already localized in main (or a passthrough technical cause) — render as-is.
      statusEl.textContent = status.message;
      showAction(t('settings.action.retry'), () => window.settingsApi.checkForUpdates());
      break;
    case 'unsupported':
      statusEl.textContent = t('settings.status.unsupported');
      hideAction();
      break;
  }
}

actionBtn.addEventListener('click', () => {
  currentAction?.();
});

function applyAutoUpdate(): void {
  const value = readAutoUpdateValue(autoUpdateGroup);
  if (value !== null) window.settingsApi.setAutoUpdate(value);
}
autoUpdateGroup.addEventListener('change', applyAutoUpdate);

function applyThemeChoice(): void {
  const value = readThemeValue(themeGroup);
  if (value !== null) {
    applyTheme(value); // apply live for instant feedback
    window.settingsApi.setTheme(value); // and persist
  }
}
themeGroup.addEventListener('change', applyThemeChoice);

// Language is applied via a single push path: the change sends the mode, and the effective locale comes
// back through settingsLanguageUpdate (for `system` the renderer can't resolve it locally). No local
// application here — the push arrives within milliseconds.
function applyLanguageChoice(): void {
  const value = readLanguageValue(languageGroup);
  if (value !== null) window.settingsApi.setLanguage(value);
}
languageGroup.addEventListener('change', applyLanguageChoice);

prereleaseSwitch.addEventListener('change', () => {
  window.settingsApi.setPrerelease(readChecked(prereleaseSwitch));
});

summonSwitch.addEventListener('change', () => {
  window.settingsApi.setSummonHotkey(readChecked(summonSwitch));
});

wireVolumeSlider(musicSlider, musicValue, (v) => window.settingsApi.setMusicVolume(v));
wireVolumeSlider(sfxSlider, sfxValue, (v) => window.settingsApi.setSfxVolume(v));

openLogsBtn.addEventListener('click', () => window.settingsApi.openLogs());
openGamesBtn.addEventListener('click', () => window.settingsApi.openGamesFolder());
resetBtn.addEventListener('click', () => {
  void window.settingsApi.reset().then(applySettings);
});

// Reflects the full settings state onto every control (used on startup and after "Reset to defaults").
function applySettings(settings: AppSettings): void {
  setDropdownValue(autoUpdateGroup, settings.autoUpdate);
  setDropdownValue(themeGroup, settings.theme);
  setDropdownValue(languageGroup, settings.language);
  setChecked(prereleaseSwitch, settings.allowPrerelease);
  setChecked(summonSwitch, settings.summonHotkeyEnabled);
  const musicPercent = Math.round(settings.musicVolume * 100);
  const sfxPercent = Math.round(settings.sfxVolume * 100);
  setSliderPercent(musicSlider, musicPercent);
  setSliderPercent(sfxSlider, sfxPercent);
  musicValue.textContent = `${musicPercent}%`;
  sfxValue.textContent = `${sfxPercent}%`;
  applyTheme(settings.theme);
}

// The app version, cached so a language change can re-render the "(version) — Settings" suffix.
let appVersion = '';
function renderTitlebarVersion(): void {
  titlebarVersion.textContent = translator('settings.titlebarVersion', { version: appVersion });
}

// A language push: rebuild the translator, re-localize the static DOM, re-title the window (so the HTML
// <title> doesn't override the taskbar caption), and re-render the state-driven bits (Updates block from
// the cached status, the title-bar suffix).
function applyLocale(locale: Locale): void {
  translator = createTranslator(locale);
  document.documentElement.lang = locale;
  // Match main's native window title so the HTML <title> doesn't override the taskbar caption.
  // "Playhook" is the product name — not translated.
  document.title = `Playhook — ${translator('window.settings')}`;
  localizeDocument(translator);
  // The dropdowns' collapsed control text is a snapshot of the selected option's text — re-assert each
  // value so it re-renders with the freshly-localized labels (auto-update / theme / language "System").
  refreshDropdownDisplay(autoUpdateGroup);
  refreshDropdownDisplay(themeGroup);
  refreshDropdownDisplay(languageGroup);
  renderTitlebarVersion();
  if (lastStatus !== null) render(lastStatus);
}

async function init(): Promise<void> {
  // Subscribe BEFORE requesting the initial snapshot, so a push arriving in between isn't lost.
  window.settingsApi.onUpdateStatus(render);
  window.settingsApi.onLanguageUpdate(applyLocale);
  const [version, icon, settings, status, locale] = await Promise.all([
    window.settingsApi.getAppVersion(),
    window.settingsApi.getAppIcon(),
    window.settingsApi.getSettings(),
    window.settingsApi.requestUpdateStatus(),
    window.settingsApi.getLanguage(),
  ]);
  appVersion = version;
  // Title bar: [icon] Playhook (version). Hide the <img> if the icon couldn't be read (empty string).
  if (icon !== '') titlebarIcon.src = icon;
  else titlebarIcon.hidden = true;
  applySettings(settings);
  render(status);
  // Seed the locale last so it localizes the freshly-populated DOM and title-bar suffix in one pass.
  applyLocale(locale);
}

void init();
