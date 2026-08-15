// English dictionary — the SOURCE OF TRUTH for every user-facing string in the app (main + renderers).
// Keys are flat with a dotted namespace per window/module: common.*, tray.*, menu.*, window.*,
// launcher.*, format.*, settings.*, gameConfig.*, gameSettings.*, errors.*, drive.*, manifest.*.
// `ru.ts` mirrors these
// as a Partial (fill in gradually); the translator falls back to this file for any missing key.
//
// `{name}` tokens are interpolation placeholders filled at call time (see createTranslator). A literal
// brace that is NOT a placeholder (e.g. the `{dir}` token inside a manifest message) is left untouched
// because those messages are translated WITHOUT params — see translateIssueMessage.
export const en = {
  // ── Common (shared across windows) ──────────────────────────────────────────
  // The two answers used by EVERY confirmation dialog. Any confirm,
  // present or future, must ask a yes/no question and use these — never a context-specific verb like
  // "Discard"/"Replace", which is easy to confuse with the neighbouring "Cancel".
  'common.yes': 'Yes',
  'common.no': 'No',

  // ── Tray context menu (tray.ts) ─────────────────────────────────────────────
  'tray.showLauncher': 'Show launcher',
  'tray.quit': 'Quit',
  // Steam Deck only: registering Playhook as a non-Steam game so it gets a Game Mode tile. The item is
  // hidden entirely on Windows and on any run that isn't a packaged AppImage.
  'tray.steamAdd': 'Add to Steam',
  'tray.steamRemove': 'Remove from Steam',
  'tray.steamBusy': 'Working…',

  // ── Steam shortcut (steam-shortcut.ts, shown as message boxes) ─────────────
  'steam.addedTitle': 'Added to Steam',
  'steam.added':
    'Playhook has been added to Steam. The tile appears the next time you enter Game Mode.',
  'steam.removedTitle': 'Removed from Steam',
  'steam.removed': 'Playhook has been removed from Steam.',
  'steam.failedTitle': 'Steam shortcut',
  'steam.failed': 'Could not update the Steam shortcut: {cause}',
  'steam.foreign':
    'Steam already has a shortcut pointing at Playhook ({names}). Remove it in Steam first, then try again — it was added by hand, so Playhook will not delete it for you.',

  // ── Native context menus (window.ts) ───────────────────────────────────────
  'menu.cut': 'Cut',
  'menu.copy': 'Copy',
  'menu.paste': 'Paste',
  'menu.selectAll': 'Select All',

  // ── Window titles ──────────────────────────────────────────────────────────
  'window.settings': 'Settings',

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
  'launcher.menu.quit': 'Close Playhook',
  // Force-close the running game (Details menu item, visible only while a game is running).
  'launcher.menu.forceClose': 'Force close',
  'launcher.menu.home': 'Home',
  'launcher.menu.forget': 'Remove from history',
  'launcher.menu.settings': 'Settings',
  // Confirmation popup copy (controls.ts). The Yes/No buttons use the shared common.* keys.
  'launcher.confirm.install': 'Do you want to install game?',
  'launcher.confirm.uninstall': 'Do you want to uninstall game from your PC?',
  'launcher.confirm.uninstallPrefix': 'Clear the Proton prefix?',
  'launcher.confirm.uninstallPrefixNote':
    'The game stays on the card - only the prefix is removed (saves inside it too).',
  'launcher.confirm.steamInstall': 'Open Steam to install this game?',
  'launcher.confirm.steamUninstall': 'Open Steam to uninstall this game?',
  // Force-close confirmation — warns that unsaved in-game progress may be lost (the game is killed, so it
  // may not get to write its save before syncing-out runs).
  'launcher.confirm.kill': 'Force close the game? Unsaved progress may be lost.',
  'launcher.confirm.forget':
    'Remove "{title}" from the history? Its saves and playtime are kept — insert the card again and the game comes back.',
  // Power-action confirmations — single-question form, matching the installer confirm convention.
  'launcher.confirm.shutdown': 'Shut down the PC?',
  'launcher.confirm.reboot': 'Reboot the PC?',
  'launcher.confirm.sleep': 'Put the PC to sleep?',
  'launcher.installPathNote':
    'Since not all installers support silent mode, during installation you need to specify the following path:',
  // The copy variant of the note: no installer runs, so neither the silent-mode caveat nor the
  // destination path applies — say what actually happens instead.
  'launcher.copyNote':
    'The game will be copied to this PC and will run from there. It is not deleted from the card.',
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
  // A local (PC) game whose executable is no longer on disk — the card stays, only Play is disabled.
  'launcher.state.gameFilesMissing': 'Game files not found',
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
  // The PC library's counterpart of "blank drive": there is no library file yet, only this machine.
  'drive.noGames': 'no games yet',
  'drive.invalid': 'invalid game.json',

  // ── Settings window (settings.html + settings.ts) ───────────────────────────
  'settings.sectionUpdates': 'Updates',
  'settings.loading': 'Loading...',
  'settings.sectionAutoUpdate': 'Automatic updates',
  'settings.autoDownloadInstall': 'Download and install automatically',
  'settings.autoDownloadManual': 'Download automatically, install manually',
  'settings.autoOff': 'Off (check manually)',
  'settings.prerelease': 'Receive pre-release (beta) updates',
  'settings.sectionLanguage': 'Language',
  // The row inside that section — named apart from the section title so the screen doesn't say
  // "Language / Language" twice in a row.
  'settings.language': 'Interface language',
  // Same wording as the Appearance "Match system" option, for consistency across the two selectors.
  'settings.languageSystem': 'Match system',
  'settings.sectionGeneral': 'General',
  'settings.summonHotkey': 'Show the launcher with a gamepad shortcut',
  // The launcher screen states the chord in one line (the settings window splits it around a <b>).
  'settings.summonHint': 'Hold Menu + View on your gamepad to bring the launcher to the front.',
  'settings.preventScreensaver': 'Keep the screen awake while the launcher is open',
  'settings.alwaysShowEmpty': 'Always show the no-card screen',
  'settings.disableSilentInstall': 'Disable silent installer mode (show the installer wizard)',
  // Steam Deck only — the row is hidden entirely elsewhere (see settings.ts / isSteamAvailable).
  'settings.steamAutoLaunch': 'Open Playhook in Steam when a card is inserted (Game Mode only)',
  'settings.steamAutoLaunchHint':
    'Off frees about 120 MB of RAM: the background watcher stops running. The Steam tile stays — launch it from the library.',
  'settings.sectionAudio': 'Audio',
  'settings.soundSet': 'Navigation sounds',
  'settings.soundSetVolume': 'Navigation sounds volume',
  'settings.ambientTrack': 'Background ambience',
  'settings.ambientNone': 'No ambience',
  'settings.onlyGlobalAmbient': 'Only global ambience',
  'settings.onlyGlobalAmbientHint':
    "When on, only the global ambience plays — a game's own background music is ignored.",
  'settings.ambientVolume': 'Ambience volume',
  'settings.openLogs': 'Open logs',
  'settings.openGames': 'Open games folder',
  'settings.reset': 'Reset to defaults',
  'settings.confirmReset': 'Reset all settings to defaults?',
  // Update-status line + primary button (settings.ts render()).
  'settings.status.idle': 'Check for updates to see if a new version is available.',
  'settings.status.upToDate': 'You’re up to date.',
  'settings.status.checking': 'Checking for updates...',
  'settings.status.available': 'Update available: {version}',
  'settings.status.downloading': 'Downloading... {percent}%',
  'settings.status.downloaded': 'Update {version} is ready to install.',
  'settings.status.unsupported': 'Updates are available only in the installed build.',
  'settings.action.check': 'Check for updates',
  'settings.action.checking': 'Checking...',
  'settings.action.updateTo': 'Update to {version}',
  'settings.action.downloading': 'Downloading...',
  'settings.action.restartInstall': 'Restart & install',
  'settings.action.retry': 'Retry',

  // ── Customize screen: the launcher's own per-game editor (gameConfig:* channels) ──
  // The picker rejections main produces, in the launcher's namespace. They repeat the `configure.pick*`
  // wording above on purpose: those belong to the window being dismantled and die with it, these belong
  // to the screen replacing it. Everything the SCREEN itself says is below, in gameSettings.*.
  'gameConfig.thisPc': 'This PC',
  'gameConfig.homeFolder': 'Home folder',
  'gameConfig.pickOutsideCard': 'The selected file is outside the card. Choose a file on the card.',
  'gameConfig.pickChooseSubfolder': 'Choose a subfolder of the card, not the card root.',
  'gameConfig.pickPcSaveOutside':
    'That folder is not under a known save location (%DOCUMENTS%, %APPDATA%, %LOCALAPPDATA%, %LOCALLOW% or %USERPROFILE%). Pick a folder inside one of those.',
  'gameConfig.pickImportFailed': 'Could not copy the selected file into the local library.',
  'gameConfig.pickMissing': 'That file is no longer there.',
  'gameConfig.pickSymlink': 'That is a shortcut to somewhere else — pick the file itself.',
  'gameConfig.pickNeedsFolder': 'Pick a folder for this field.',
  'gameConfig.pickNeedsFile': 'Pick a file for this field.',
  'gameConfig.pickWrongType': 'That file type does not fit this field.',
  'gameConfig.listFailed': 'This folder could not be opened.',

  // ── Customize screen: what the SCREEN itself says (game-settings-*.ts) ──────
  'launcher.menu.customize': 'Customize',

  // ── On-screen keyboard + file browser (osk.ts / file-picker.ts) ────────────
  'osk.shift': 'Shift',
  'osk.backspace': 'Delete',
  'osk.space': 'Space',
  'osk.done': 'Done',
  'osk.cancel': 'Cancel',
  'osk.legend': 'X - delete, Y - shift, LB/RB - layout, B - cancel',
  'picker.title': 'Choose',
  'picker.up': '.. up one level',
  'picker.useThisFolder': 'Use this folder',
  'picker.empty': 'Nothing here.',
  'picker.legend': 'A - open or choose, B - up one level, left/right - switch column',
  'picker.legendMulti': 'X - tick, A - choose, B - up one level, left/right - switch column',

  'gameSettings.screenTitle': 'Customize',
  'gameSettings.loading': 'Reading the manifest...',
  'gameSettings.sectionBasics': 'Basics',
  'gameSettings.sectionLaunch': 'Launch',
  'gameSettings.sectionImages': 'Artwork',
  'gameSettings.sectionSaves': 'Saves',
  'gameSettings.sectionAudio': 'Audio',
  'gameSettings.sectionAdvanced': 'Advanced',
  'gameSettings.notSet': 'not set',
  'gameSettings.listEmpty': 'empty',
  'gameSettings.title': 'Title',
  'gameSettings.id': 'Id',
  'gameSettings.idHint': 'Latin letters, digits, dot, dash and underscore.',
  'gameSettings.idChangedWarning':
    'Changing the id detaches this game from its playtime, its save backups and its history entry on this PC.',
  'gameSettings.schemaVersion': 'Manifest version',
  'gameSettings.source': 'Comes from',
  'gameSettings.launchMode': 'Launch type',
  'gameSettings.modeExecutable': 'Run from the card',
  'gameSettings.modeInstaller': 'Install from the card',
  'gameSettings.modeSteam': 'Steam',
  'gameSettings.modePc': 'Installed on this PC',
  'gameSettings.mixedLaunchModes':
    'This manifest describes more than one launch type. Only the selected one is kept; saving removes the others.',
  'gameSettings.executable': 'Executable',
  'gameSettings.executableHint': 'Relative to the card root.',
  'gameSettings.pcExecutable': 'Executable on this PC',
  'gameSettings.args': 'Launch arguments',
  'gameSettings.runAsAdmin': 'Run as administrator',
  'gameSettings.runAsAdminHint': 'For games whose executable requires elevation.',
  'gameSettings.copyToPc': 'Move game to PC',
  'gameSettings.copyToPcHint': 'The game is copied to this PC and runs from there; the card keeps its copy.',
  'gameSettings.copyDirectory': 'Game folder on the card',
  'gameSettings.copyDirectoryHint': 'The folder that is copied — the game’s own root, not the card root.',
  'gameSettings.installer': 'Installer',
  'gameSettings.installType': 'Installer type',
  'gameSettings.installNsis': 'NSIS',
  'gameSettings.installInno': 'Inno Setup',
  'gameSettings.installCustom': 'Custom (run by hand)',
  'gameSettings.installRunAsAdmin': 'Run the installer as administrator',
  'gameSettings.installCustomHint': 'A custom installer is run by you, so elevation is not ours to request.',
  'gameSettings.installArgs': 'Installer arguments',
  'gameSettings.installWinetricks': 'Winetricks for the installer',
  'gameSettings.steamAppid': 'Steam appid',
  'gameSettings.steamAppidHint': 'The number in the game’s Steam store URL.',
  'gameSettings.watchProcesses': 'Watched processes',
  'gameSettings.watchProcessesHint':
    'Process names to follow instead of the launched one (launchers, wrappers).',
  'gameSettings.heroImage': 'Backgrounds',
  'gameSettings.heroImageHint': 'Up to three; the launcher rotates through them.',
  'gameSettings.gridImage': 'Card artwork',
  'gameSettings.gridImageAuto': 'cropped from the first background',
  'gameSettings.saveOnCard': 'Save folder on the card',
  'gameSettings.saveOnCardHint': 'Where progress is copied back when you finish playing.',
  'gameSettings.pcSavePath': 'Save folder on the PC',
  'gameSettings.pcSavePathHint': 'Where the game itself keeps its progress.',
  'gameSettings.backgroundMusic': 'Background music',
  'gameSettings.musicNone': 'no music',
  'gameSettings.launchTimeout': 'Launch timeout',
  'gameSettings.killTimeout': 'Force-close timeout',
  'gameSettings.defaultSeconds30': '30 s (default)',
  'gameSettings.defaultSeconds60': '60 s (default)',
  'gameSettings.winetricks': 'Winetricks',
  'gameSettings.winetricksHint': 'Extra verbs provisioned into the prefix before the game runs (Linux).',
  'gameSettings.umuGameId': 'umu GAMEID',
  'gameSettings.umuGameIdAuto': 'automatic',
  'gameSettings.umuGameIdHint': 'Applies that game’s protonfix instead of the generic one (Linux).',
  'gameSettings.save': 'Save & Apply',
  'gameSettings.reset': 'Discard changes',
  'gameSettings.delete': 'Delete game',
  'gameSettings.browse': 'Browse...',
  'gameSettings.clear': 'Clear',
  'gameSettings.listAdd': 'Add...',
  'gameSettings.listReplace': 'Replace...',
  'gameSettings.listMoveUp': 'Move up',
  'gameSettings.listMoveDown': 'Move down',
  'gameSettings.listRemove': 'Remove',
  'gameSettings.saving': 'Saving...',
  'gameSettings.savedApplied': 'Saved and applied.',
  'gameSettings.savedDeferred': 'Saved. It applies when this card becomes the active one.',
  'gameSettings.savedNotApplied': 'Saved. It applies once you are done playing.',
  'gameSettings.slotUnreadable': 'This game cannot be shown as a form: {message}',
  'gameSettings.slotNotFound': 'The manifest no longer describes a game with the id "{id}".',
  'gameSettings.otherGameUnnamed': 'unnamed',
  'gameSettings.otherGameIssue': 'Problem in game {number} ({game}): {field} - {message}',
  'gameSettings.confirmReset': 'Discard the changes and re-read the manifest?',
  'gameSettings.confirmDiscard': 'Leave without saving? The changes are lost.',
  'gameSettings.confirmDelete': 'Delete "{title}" from the manifest?',
  'gameSettings.confirmDeleteNote':
    'The game files stay where they are. Unsaved changes on this screen are discarded.',
  'gameSettings.confirmDeleteSavesNote':
    'The game files stay where they are, and so do its save backups. Unsaved changes on this screen are discarded.',

  // ── User-facing errors from main (ipc.ts / game-config.ts / updater.ts) ─────
  // The wrapper is translated; the technical cause ({cause}) is inserted as-is (system messages, nested
  // exceptions and the like stay in their original form).
  'errors.finishBeforeApply': 'Finish what’s running before applying the config',
  'errors.reloadInProgress': 'a reload is already in progress',
  'errors.steamNotInstalled': 'Steam is not installed',
  'errors.steamBusyOther': 'Another game is being downloaded or removed in Steam. Wait for it to finish.',
  'errors.steamOpenInstall': 'failed to open Steam install: {cause}',
  'errors.steamOpenDownloads': 'failed to open Steam downloads: {cause}',
  'errors.steamOpenUninstall': 'failed to open Steam uninstall: {cause}',
  'errors.launchViaSteam': 'failed to launch via Steam: {cause}',
  'errors.launchGame': 'failed to launch the game: {cause}',
  'errors.gameDidNotStart': 'the game did not start (process wait timed out)',
  'errors.startInstaller': 'failed to start the installer: {cause}',
  'errors.installIncomplete': 'installation did not complete (the game executable did not appear)',
  'errors.copyGameFailed': 'failed to copy the game to the PC: {cause}',
  'errors.copyExeNotFound':
    'the game was copied, but the executable is not there: {path} — check that the game directory points at the game’s own root',
  'errors.copyExeNotFoundCase':
    'the game was copied, but the executable is not there: {path} — found "{found}" instead (fix the case on this filesystem)',
  'errors.killFailed': 'could not force-close the game (some processes are still running)',
  'errors.finishBeforeInstall': 'Finish what’s running before installing the update.',
  'errors.driveUnavailable': 'the selected drive is no longer available',
  'errors.gameNotFound': 'this game is not available right now',
  'errors.mediaChanged':
    'the card in this slot is not the one this game was read from — reopen the screen',
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
  'manifest.winetricksName':
    'winetricks entries must be verb names or key=value settings (letters, digits, _.=-)',
  'manifest.umuGameIdName': 'umuGameId must be a Steam appid or a UMU_ID (letters, digits, _-)',
  'manifest.installRunAsAdminCustom': 'install.runAsAdmin is not allowed with type "custom"',
  'manifest.copyArgs': 'install.args is not allowed with type "copy" (no installer is run)',
  'manifest.copyRunAsAdmin':
    'install.runAsAdmin is not allowed with type "copy" (no installer is run)',
  'manifest.installArgsDir':
    'install.args (type "custom") must contain exactly one token with a {dir} placeholder',
  'manifest.installWithSteam': 'install is not allowed together with steam',
  'manifest.executableWithSteam': 'executable is not allowed in steam mode',
  'manifest.runAsAdminWithSteam': 'runAsAdmin is not allowed in steam mode',
  'manifest.watchProcessesRequired': 'watchProcesses is required in steam mode',
  'manifest.executableRequired': 'executable is required',
  // PC mode (a game on this machine's own disk — see PcManifest).
  'manifest.pcWithSteam': 'pc is not allowed together with steam',
  'manifest.pcWithInstall': 'pc is not allowed together with install',
  'manifest.pcWithExecutable': 'executable is not allowed in pc mode (use pc.executable)',
  'manifest.pcWithSaveOnCard': 'saveOnCard is not allowed for a local game (Playhook keeps the backup)',
  'manifest.pcOnCard': 'the pc block is only allowed for local games, not on a card',
  'manifest.pcOrSteamRequired': 'a local game requires either the pc block or the steam block',
  'manifest.pcExecutableAbsolute': 'pc.executable must be an absolute path: {path}',
  // Pure-function messages (expandPcSavePath / resolveInstall / readManifest / validateManifestText):
  // the functions receive the translator and interpolate directly.
  'manifest.pcSavePathPrefix': 'pcSavePath must start with {prefixes}',
  'manifest.pcSavePathPrefixOrAbsolute':
    'pcSavePath must be an absolute path or start with {prefixes}',
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
  'manifest.executableNotFoundCase':
    'executable not found: {path} — found "{found}" instead (fix the case on this filesystem)',
  'manifest.heroEscapes': 'heroImage path escapes card root: {path}',
  'manifest.heroTooMany': 'at most {max} heroImage entries are allowed ({count} given)',
  'manifest.gridEscapes': 'gridImage path escapes card root: {path}',
  'manifest.saveOnCardEscapes': 'saveOnCard path escapes card root: {path}',
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
