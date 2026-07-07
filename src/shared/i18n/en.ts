// English dictionary — the SOURCE OF TRUTH for every user-facing string in the app (main + renderers).
// Keys are flat with a dotted namespace per window/module: common.*, tray.*, menu.*, window.*,
// launcher.*, format.*, settings.*, configure.*, errors.*, drive.*, manifest.*. `ru.ts` mirrors these
// as a Partial (fill in gradually); the translator falls back to this file for any missing key.
//
// `{name}` tokens are interpolation placeholders filled at call time (see createTranslator). A literal
// brace that is NOT a placeholder (e.g. the `{dir}` token inside a manifest message) is left untouched
// because those messages are translated WITHOUT params — see translateIssueMessage.
export const en = {
  // ── Common (shared across windows) ──────────────────────────────────────────
  // The two answers used by EVERY confirmation dialog (game launcher + configure window). Any confirm,
  // present or future, must ask a yes/no question and use these — never a context-specific verb like
  // "Discard"/"Replace", which is easy to confuse with the neighbouring "Cancel".
  'common.yes': 'Yes',
  'common.no': 'No',

  // ── Tray context menu (tray.ts) ─────────────────────────────────────────────
  'tray.showLauncher': 'Show launcher',
  'tray.configureGame': 'Configure game',
  'tray.settings': 'Settings',
  'tray.quit': 'Quit',

  // ── Native context menus (window.ts / configure-window.ts) ──────────────────
  'menu.cut': 'Cut',
  'menu.copy': 'Copy',
  'menu.paste': 'Paste',
  'menu.selectAll': 'Select All',
  'menu.format': 'Format',
  'menu.reset': 'Reset',

  // ── Window titles (settings-window.ts / configure-window.ts) ────────────────
  'window.settings': 'Settings',
  'window.configureGame': 'Configure game',

  // ── Game launcher renderer (index.html + app.ts/state-view.ts/controls.ts/hero.ts) ──
  'launcher.emptyTitle': 'Insert a game card',
  'launcher.errorTitle': 'Something went wrong',
  'launcher.info.lastPlayed': 'Last Played',
  'launcher.info.playtime': 'Playtime',
  'launcher.info.launches': 'Launches',
  // Button aria-labels. Play is static now (the install action moved into the Details menu, so Play
  // never relabels); More/Hide are static too (localized via data-i18n-aria-label in the HTML).
  'launcher.aria.play': 'Play',
  'launcher.aria.more': 'More',
  'launcher.aria.hide': 'Hide',
  // Details / Power menu items (controls.ts). These are TextButtons with visible text — no aria needed.
  'launcher.menu.close': 'Close',
  'launcher.menu.install': 'Install',
  'launcher.menu.uninstall': 'Uninstall',
  // Details entry that opens the Power submenu — named "System" so it doesn't duplicate the submenu's
  // own "Shutdown" action.
  'launcher.menu.system': 'System',
  'launcher.menu.shutdown': 'Shutdown',
  'launcher.menu.reboot': 'Reboot',
  'launcher.menu.sleep': 'Sleep',
  'launcher.menu.minimize': 'Minimize Playhook',
  // Confirmation popup copy (controls.ts). The Yes/No buttons use the shared common.* keys.
  'launcher.confirm.install': 'Do you want to install game?',
  'launcher.confirm.uninstall': 'Do you want to uninstall game from your PC?',
  'launcher.confirm.steamInstall': 'Open Steam to install this game?',
  'launcher.confirm.steamUninstall': 'Open Steam to uninstall this game?',
  // Power-action confirmations — single-question form, matching the installer confirm convention.
  'launcher.confirm.shutdown': 'Shut down the PC?',
  'launcher.confirm.reboot': 'Reboot the PC?',
  'launcher.confirm.sleep': 'Put the PC to sleep?',
  'launcher.installPathNote':
    'Since not all installers support silent mode, during installation you need to specify the following path:',
  // Status labels (state-view.ts). Plain "..." (not the "…" glyph) on purpose — see state-view.ts.
  'launcher.state.installing': 'Installing...',
  'launcher.state.uninstalling': 'Uninstalling...',
  'launcher.state.syncingIn': 'Syncing saves...',
  'launcher.state.launching': 'Launching...',
  'launcher.state.running': 'Running...',
  'launcher.state.syncingOut': 'Saving progress...',
  'launcher.state.installingPaused': 'Installing paused...',
  'launcher.state.installingPausedPercent': 'Installing paused on {percent}%...',

  // ── Display formatters (format.ts) ──────────────────────────────────────────
  'format.never': 'never',
  'format.unknown': 'unknown',
  'format.lessThanMinute': 'less than a minute',

  // ── Drive candidate labels (drive-watcher.ts) ───────────────────────────────
  'drive.blank': 'blank drive',
  'drive.invalid': 'invalid game.json',

  // ── Settings window (settings.html + settings.ts) ───────────────────────────
  'settings.sectionUpdates': 'Updates',
  'settings.loading': 'Loading…',
  'settings.sectionAutoUpdate': 'Automatic updates',
  'settings.autoDownloadInstall': 'Download and install automatically',
  'settings.autoDownloadManual': 'Download automatically, install manually',
  'settings.autoOff': 'Off (check manually)',
  'settings.prerelease': 'Receive pre-release (beta) updates',
  'settings.sectionAppearance': 'Appearance',
  'settings.themeSystem': 'Match system',
  'settings.themeLight': 'Light',
  'settings.themeDark': 'Dark',
  'settings.sectionLanguage': 'Language',
  // Same wording as the Appearance "Match system" option, for consistency across the two selectors.
  'settings.languageSystem': 'Match system',
  'settings.sectionGeneral': 'General',
  'settings.summonHotkey': 'Show the launcher with a gamepad shortcut',
  'settings.summonHintPre': 'Hold',
  'settings.summonHintPost': 'on your gamepad at any time to bring the launcher to the front.',
  'settings.sectionAudio': 'Audio',
  'settings.musicVolume': 'Music volume',
  'settings.sfxVolume': 'UI sounds volume',
  'settings.sectionAdvanced': 'Advanced',
  'settings.openLogs': 'Open logs',
  'settings.openGames': 'Open games folder',
  'settings.reset': 'Reset to defaults',
  'settings.titlebarVersion': '({version}) — Settings',
  // Update-status line + primary button (settings.ts render()).
  'settings.status.idle': 'Check for updates to see if a new version is available.',
  'settings.status.upToDate': 'You’re up to date.',
  'settings.status.checking': 'Checking for updates…',
  'settings.status.available': 'Update available: {version}',
  'settings.status.downloading': 'Downloading… {percent}%',
  'settings.status.downloaded': 'Update {version} is ready to install.',
  'settings.status.unsupported': 'Updates are available only in the installed build.',
  'settings.action.check': 'Check for updates',
  'settings.action.checking': 'Checking…',
  'settings.action.updateTo': 'Update to {version}',
  'settings.action.downloading': 'Downloading…',
  'settings.action.restartInstall': 'Restart & install',
  'settings.action.retry': 'Retry',

  // ── Configure-game window (configure.html + configure.ts) ───────────────────
  'configure.card': 'Card',
  'configure.insertCard': 'Insert an SD card or flash drive.',
  'configure.startTemplate': 'Start from a template',
  'configure.tplExecutable': 'Executable file',
  'configure.tplInstaller': 'Installer',
  'configure.save': 'Save & Apply',
  'configure.titlebarVersion': '({version}) — Configure game',
  'configure.configValid': 'Config is valid.',
  'configure.idChangedWarning':
    'Warning: id changed ({from} → {to}). Playtime stats are keyed by id and will reset for the new id.',
  'configure.cardGone': 'The selected card is no longer available. Your text is kept.',
  'configure.blankDrive': 'Blank drive — pick a template to start.',
  'configure.couldNotRead': 'Could not read game.json: {message}',
  'configure.confirmSwitch': 'Discard unsaved changes and switch cards?',
  'configure.confirmReset': 'Discard unsaved changes and reset from the card?',
  'configure.confirmReplace': 'Replace current config with the template?',
  'configure.fixSyntax': 'Fix the JSON syntax errors before formatting.',
  'configure.saving': 'Saving…',
  'configure.notSaved': 'Not saved: {message}',
  'configure.applied': 'Applied. The launcher was updated.',
  'configure.deferred': 'Saved. It will load shortly, or after the active card is removed.',
  'configure.savedRejected': 'Saved, but the manifest was rejected: {message}',
  'configure.unknownReason': 'unknown reason',

  // ── User-facing errors from main (ipc.ts / game-config.ts / updater.ts) ─────
  // The wrapper is translated; the technical cause ({cause}) is inserted as-is (system messages, nested
  // exceptions and the like stay in their original form).
  'errors.finishBeforeApply': 'Finish what’s running before applying the config',
  'errors.reloadInProgress': 'a reload is already in progress',
  'errors.steamNotInstalled': 'Steam is not installed',
  'errors.steamOpenInstall': 'failed to open Steam install: {cause}',
  'errors.steamOpenDownloads': 'failed to open Steam downloads: {cause}',
  'errors.steamOpenUninstall': 'failed to open Steam uninstall: {cause}',
  'errors.launchViaSteam': 'failed to launch via Steam: {cause}',
  'errors.launchGame': 'failed to launch the game: {cause}',
  'errors.gameDidNotStart': 'the game did not start (process wait timed out)',
  'errors.startInstaller': 'failed to start the installer: {cause}',
  'errors.installIncomplete': 'installation did not complete (the game executable did not appear)',
  'errors.finishBeforeInstall': 'Finish what’s running before installing the update.',
  'errors.driveUnavailable': 'the selected drive is no longer available',
  'errors.cannotReadManifest': 'cannot read {file}: {cause}',
  'errors.cannotWriteManifest': 'failed to write {file}: {cause}',
  'errors.configInvalid': 'the config is invalid',
  'errors.powerUnsupported': 'power actions are only available on Windows',
  'errors.powerFailed': 'power command failed: {cause}',

  // ── Manifest validation (manifest.ts) ───────────────────────────────────────
  // Schema-level custom messages: stored in the schema AS THESE KEYS; translated at the issue-mapping
  // points via translateIssueMessage (a message that is a key of `en` gets translated, a structural zod
  // message passes through). JSON field names inside the text stay as latin identifiers.
  'manifest.idPattern': 'id must match [A-Za-z0-9._-]',
  'manifest.idDots': 'id must not be . or ..',
  'manifest.watchProcessesName': 'watchProcesses entries must be a bare *.exe name',
  'manifest.installRunAsAdminCustom': 'install.runAsAdmin is not allowed with type "custom"',
  'manifest.installArgsDir':
    'install.args (type "custom") must contain exactly one token with a {dir} placeholder',
  'manifest.installWithSteam': 'install is not allowed together with steam',
  'manifest.executableWithSteam': 'executable is not allowed in steam mode',
  'manifest.runAsAdminWithSteam': 'runAsAdmin is not allowed in steam mode',
  'manifest.watchProcessesRequired': 'watchProcesses is required in steam mode',
  'manifest.executableRequired': 'executable is required',
  // Pure-function messages (expandPcSavePath / resolveInstall / readManifest / validateManifestText):
  // the functions receive the translator and interpolate directly.
  'manifest.pcSavePathPrefix': 'pcSavePath must start with {prefixes}',
  'manifest.pcSavePathNotAllowed': 'pcSavePath prefix %{prefix}% is not allowed (use {prefixes})',
  'manifest.pcSavePathUnavailable': 'pcSavePath prefix %{prefix}% is not available on this system',
  'manifest.pcSavePathNoTraversal': 'pcSavePath must not contain ".."',
  'manifest.pcSavePathEscapes': 'pcSavePath escapes its base directory',
  'manifest.pathEscapes': '{label} escapes the card root: {path}',
  'manifest.installerEscapes': 'installer path escapes card root: {path}',
  'manifest.installerNotFound': 'installer not found: {path}',
  'manifest.installNeedsLocalAppData': 'install mode requires %LOCALAPPDATA% (Windows only)',
  'manifest.executableEscapesInstall': 'executable path escapes install dir: {path}',
  'manifest.executableEscapes': 'executable path escapes card root: {path}',
  'manifest.executableNotFound': 'executable not found: {path}',
  'manifest.heroEscapes': 'heroImage path escapes card root: {path}',
  'manifest.saveOnCardEscapes': 'saveOnCard path escapes card root: {path}',
  'manifest.soundEscapes': 'sound "{name}" path escapes card root: {path}',
  'manifest.backgroundMusicEscapes': 'backgroundMusic path escapes card root: {path}',
  'manifest.savePairing': 'saveOnCard and pcSavePath must be set together or both omitted',
  'manifest.invalid': 'invalid manifest',
  'manifest.invalidJson': 'invalid JSON: {cause}',
} as const;

/** Every message key — the compile-time contract `ru` and the translator index against. */
export type MessageKey = keyof typeof en;
