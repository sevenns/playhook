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
  // never relabels); More is static too (localized via data-i18n-aria-label in the HTML).
  'launcher.aria.play': 'Play',
  // Set at render time on the Play button while a game is running (the launcher was summoned over it).
  'launcher.aria.returnToGame': 'Return to game',
  'launcher.aria.more': 'More',
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
  // Force-close the running game (Details menu item, visible only while a game is running).
  'launcher.menu.forceClose': 'Force close',
  // Opens the "Select game" list (Details menu item, visible only for a multi-game card on the ready screen).
  'launcher.menu.selectGame': 'Select game',
  // Confirmation popup copy (controls.ts). The Yes/No buttons use the shared common.* keys.
  'launcher.confirm.install': 'Do you want to install game?',
  'launcher.confirm.uninstall': 'Do you want to uninstall game from your PC?',
  'launcher.confirm.steamInstall': 'Open Steam to install this game?',
  'launcher.confirm.steamUninstall': 'Open Steam to uninstall this game?',
  // Force-close confirmation — warns that unsaved in-game progress may be lost (the game is killed, so it
  // may not get to write its save before syncing-out runs).
  'launcher.confirm.kill': 'Force close the game? Unsaved progress may be lost.',
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
  // Rotating "Configuring Proton" status (Linux prefix provisioning). #1 is always shown first.
  'launcher.protonConfig1': 'Configuring Proton...',
  'launcher.protonConfig2': 'Applying Linux gaming tricks...',
  'launcher.protonConfig3': "Searching for hope that it'll launch...",
  'launcher.protonConfig4': 'Convincing Wine this is Windows...',
  'launcher.protonConfig5': 'Downloading half of Windows into the prefix...',
  'launcher.protonConfig6': 'It worked on my prefix, I swear...',
  'launcher.protonConfig7': 'Negotiating with DXVK...',
  'launcher.protonConfig8': "Convincing the game it's on Windows...",
  'launcher.protonConfig9': 'Installing half of Microsoft, just in case...',
  'launcher.protonConfig10': 'Praying to the compatibility gods...',
  'launcher.protonConfig11': 'Hunting for the one verb that fixes it all...',
  'launcher.protonConfig12': 'Sacrificing a prefix to Proton...',
  // Funny suffixes appended to "Installing..." after a minute of a long silent install.
  'launcher.installChatter1': 'Any second now, hacking the Pentagon...',
  'launcher.installChatter2': 'Just finishing my tea, then I start...',
  'launcher.installChatter3': 'Counting the bytes by hand...',
  'launcher.installChatter4': 'Negotiating with the antivirus...',
  'launcher.installChatter5': 'Scrounging the couch for gigabytes...',
  'launcher.installChatter6': 'Digging the disc out of the attic...',
  'launcher.installChatter7': 'Defragging your patience...',
  'launcher.installChatter8': "Almost done, pirate's honour...",
  'launcher.installChatter9': 'Begging the progress bar to stop lying...',
  'launcher.installChatter10': 'Warming up the SSD for the big moment...',
  'launcher.state.running': 'Running...',
  'launcher.state.killing': 'Force closing...',
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
  'settings.preventScreensaver': 'Keep the screen awake while the launcher is open',
  'settings.alwaysShowEmpty': 'Always show the no-card screen',
  'settings.disableSilentInstall': 'Disable silent installer mode (show the installer wizard)',
  'settings.wallpaperLabel': 'Empty screen background',
  'settings.wallpaperChoose': 'Choose image…',
  'settings.wallpaperReset': 'Reset',
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
  // Multi-game picker (a card can carry several games).
  'configure.game': 'Game',
  'configure.addGame': 'Add game',
  'configure.removeGame': 'Remove current',
  'configure.confirmRemoveGame': 'Remove the current game from this card?',
  // Dropdown option label: "1 / 3 · Hollow Knight".
  'configure.gameOption': '{index} / {count} · {title}',
  // An issue on another game (not the one being edited) shown in the panel: "Game 3 (Celeste): …".
  'configure.otherGameIssue': 'Game {index} ({title}): {message}',
  'configure.untitledGame': 'untitled',
  'configure.save': 'Save & Apply',
  'configure.titlebarVersion': '({version}) — Configure game',
  'configure.configValid': 'Config is valid.',
  'configure.idChangedWarning':
    'Warning: id changed ({from} → {to}). Playtime stats are keyed by id and will reset for the new id.',
  'configure.cardGone': 'The selected card is no longer available. Your text is kept.',
  'configure.blankDrive': 'Blank drive — fill in the game and save.',
  'configure.couldNotRead': 'Could not read game.json: {message}',
  'configure.confirmSwitch': 'Discard unsaved changes and switch cards?',
  'configure.confirmReset': 'Discard unsaved changes and reset from the card?',
  'configure.fixSyntax': 'Fix the JSON syntax errors before formatting.',
  'configure.saving': 'Saving…',
  'configure.notSaved': 'Not saved: {message}',
  'configure.applied': 'Applied. The launcher was updated.',
  'configure.deferred': 'Saved. It will load shortly, or after the active card is removed.',
  'configure.savedRejected': 'Saved, but the manifest was rejected: {message}',
  'configure.unknownReason': 'unknown reason',

  // ── Configure-game window: interactive form (configure-form-view.ts) ─────────
  // The JSON tab label (the section tabs reuse the section headings below); "JSON" is a filename/format.
  'configure.tabJson': 'JSON',
  // A visible Reset button next to Save (re-reads game.json from the card, discarding edits).
  'configure.reset': 'Reset',
  // Section headings.
  'configure.sectionBasics': 'Basics',
  'configure.sectionLaunch': 'Launch',
  'configure.sectionHero': 'Hero images',
  'configure.sectionSaves': 'Saves',
  'configure.sectionAudio': 'Audio',
  'configure.sectionAdvanced': 'Advanced',
  // Field labels.
  'configure.fieldId': 'Game id',
  'configure.fieldTitle': 'Title',
  'configure.schemaVersion': 'Schema version: 1',
  'configure.launchType': 'Launch type',
  'configure.launchExecutable': 'Executable',
  'configure.launchInstaller': 'Installer',
  'configure.fieldExecutable': 'Executable path',
  'configure.fieldArgs': 'Arguments',
  'configure.fieldRunAsAdmin': 'Run as administrator',
  'configure.fieldInstaller': 'Installer path',
  'configure.fieldInstallType': 'Installer type',
  'configure.fieldInstallArgs': 'Installer arguments',
  'configure.installArgsDirHint':
    'For a custom installer exactly one argument must contain the {dir} placeholder.',
  'configure.fieldWinetricks': 'Game winetricks (Linux)',
  'configure.winetricksHint':
    'Extra winetricks verbs/settings (e.g. d3dx9, or vd=1920x1080 for a virtual desktop) applied to the Wine prefix before the game launches, on top of the built-in set. Linux/Proton only; ignored on Windows.',
  'configure.fieldInstallWinetricks': 'Installer winetricks (Linux)',
  'configure.installWinetricksHint':
    'Extra winetricks verbs provisioned before the installer runs, on top of the built-in set. Linux/Proton only; ignored on Windows.',
  'configure.fieldUmuGameId': 'umu GAMEID (Linux)',
  'configure.umuGameIdHint':
    'A Steam appid or a custom UMU_ID — umu applies that game’s protonfix instead of the generic default. Leave empty for umu-default. Linux/Proton only.',
  'configure.fieldAppid': 'Steam appid',
  'configure.fieldWatchProcesses': 'Watched processes',
  'configure.watchProcessesHint': '1–16 process image names ending in .exe.',
  'configure.fieldSaveOnCard': 'Save folder on the card',
  'configure.fieldPcSavePath': 'PC save path',
  'configure.pcSavePathPlaceholder': '%APPDATA%/My Game',
  'configure.fieldSoundPlay': 'Play sound',
  'configure.fieldSoundNavigate': 'Navigate sound',
  'configure.fieldSoundButton': 'Button sound',
  'configure.fieldSoundBack': 'Back sound',
  'configure.fieldBackgroundMusic': 'Background music',
  'configure.fieldLaunchTimeout': 'Launch timeout (seconds)',
  'configure.fieldKillTimeout': 'Force-close timeout (seconds)',
  // Audio Default/Custom selector (Default → the field is omitted from game.json).
  'configure.audioDefault': 'Default',
  'configure.audioCustom': 'Custom',
  'configure.soundBuiltinHint': 'The built-in sound will be used.',
  'configure.musicNoneHint': 'No background music.',
  // Steam appid helper link (opens SteamDB in the default browser).
  'configure.appidHelp': 'Find the appid on SteamDB',
  // Dynamic-list + picker buttons.
  'configure.browse': 'Browse…',
  'configure.add': 'Add',
  'configure.addFile': 'Add…',
  'configure.replace': 'Replace…',
  'configure.remove': 'Remove',
  'configure.dragReorder': 'Drag to reorder',
  // Banners / hints.
  'configure.corruptField': 'This field contains an invalid value; editing it replaces the value.',
  'configure.fixSyntaxSwitch': 'Fix the JSON syntax errors before switching to the form.',
  'configure.mixedLaunchModes':
    'This manifest defines more than one launch type. Only “{mode}” stays active; saving removes the other blocks.',
  // Picker rejections (main → renderer).
  'configure.pickOutsideCard': 'The selected file is outside the card. Choose a file on the card.',
  'configure.pickChooseSubfolder': 'Choose a subfolder of the card, not the card root.',
  'configure.pickPcSaveOutside':
    'That folder is not under a known save location (%DOCUMENTS%, %APPDATA%, %LOCALAPPDATA%, %LOCALLOW% or %USERPROFILE%). Pick a folder inside one of those.',

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
  'errors.killFailed': 'could not force-close the game (some processes are still running)',
  'errors.finishBeforeInstall': 'Finish what’s running before installing the update.',
  'errors.driveUnavailable': 'the selected drive is no longer available',
  'errors.cannotReadManifest': 'cannot read {file}: {cause}',
  'errors.cannotWriteManifest': 'failed to write {file}: {cause}',
  'errors.configInvalid': 'the config is invalid',
  'errors.powerUnsupported': 'power actions are only available on Windows',
  'errors.powerFailed': 'power command failed: {cause}',
  'errors.wallpaperTooLarge': 'The image is too large (over 8 MB). Choose a smaller file.',
  'errors.wallpaperNotImage': 'That file is not a supported image (PNG, JPEG, WebP or GIF).',
  'errors.wallpaperFailed': 'Failed to set the background image.',

  // ── Manifest validation (manifest.ts) ───────────────────────────────────────
  // Schema-level custom messages: stored in the schema AS THESE KEYS; translated at the issue-mapping
  // points via translateIssueMessage (a message that is a key of `en` gets translated, a structural zod
  // message passes through). JSON field names inside the text stay as latin identifiers.
  'manifest.idPattern': 'id must match [A-Za-z0-9._-]',
  'manifest.idDots': 'id must not be . or ..',
  'manifest.watchProcessesName': 'watchProcesses entries must be a bare *.exe name',
  'manifest.winetricksName': 'winetricks entries must be verb names or key=value settings (letters, digits, _.=-)',
  'manifest.umuGameIdName': 'umuGameId must be a Steam appid or a UMU_ID (letters, digits, _-)',
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
  'manifest.executableNotFoundCase': 'executable not found: {path} — found "{found}" instead (fix the case on this filesystem)',
  'manifest.heroEscapes': 'heroImage path escapes card root: {path}',
  'manifest.saveOnCardEscapes': 'saveOnCard path escapes card root: {path}',
  'manifest.soundEscapes': 'sound "{name}" path escapes card root: {path}',
  'manifest.backgroundMusicEscapes': 'backgroundMusic path escapes card root: {path}',
  'manifest.savePairing': 'saveOnCard and pcSavePath must be set together or both omitted',
  'manifest.invalid': 'invalid manifest',
  'manifest.invalidJson': 'invalid JSON: {cause}',
  // Multi-game (array) manifest checks.
  'manifest.heroRequired': 'heroImage is required (at least one image)',
  'manifest.emptyArray': 'the games array must not be empty',
  'manifest.notObjectOrArray': 'game.json must be a game object or a non-empty array of games',
  'manifest.duplicateId': 'duplicate game id "{id}"',
} as const;

/** Every message key — the compile-time contract `ru` and the translator index against. */
export type MessageKey = keyof typeof en;
