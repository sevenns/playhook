// Starter game.json templates for the Configure-game window (blank-card initialization).
// The README examples are JSONC (with `//` comments) — a literal copy-paste would NOT parse, so these
// are the same shapes cleaned to strict, VALID JSON. Each one passes validateManifestText (guarded by a
// unit test); the user tweaks ids/paths/appids afterwards. Built via JSON.stringify so the strings are
// always well-formed and pretty-printed (2 spaces) for the editor.
import type { ConfigTemplates } from '../shared/types';

const EXECUTABLE = {
  schemaVersion: 1,
  id: 'my-game',
  title: 'My Game',
  executable: 'game/game.exe',
  args: [],
  runAsAdmin: false,
  heroImage: 'assets/hero.jpg',
  saveOnCard: 'saves',
  pcSavePath: '%APPDATA%/My Game',
  launchTimeoutSec: 30,
} as const;

const INSTALLER = {
  schemaVersion: 1,
  id: 'my-game',
  title: 'My Game',
  executable: 'MyGame/MyGame.exe',
  install: {
    installer: 'setup/setup.exe',
    type: 'nsis',
    runAsAdmin: false,
    args: [],
  },
  launchTimeoutSec: 30,
} as const;

const STEAM = {
  schemaVersion: 1,
  id: 'my-game',
  title: 'My Game',
  steam: { appid: 480 },
  watchProcesses: ['mygame.exe'],
  launchTimeoutSec: 120,
  heroImage: 'assets/hero.jpg',
} as const;

/** The three templates as pretty-printed, valid JSON strings. */
export const MANIFEST_TEMPLATES: ConfigTemplates = {
  executable: JSON.stringify(EXECUTABLE, null, 2),
  installer: JSON.stringify(INSTALLER, null, 2),
  steam: JSON.stringify(STEAM, null, 2),
};
