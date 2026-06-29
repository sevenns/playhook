# microSD Game Launcher

A background Windows application (Electron + TypeScript): it lives in the tray, detects
insertion of a microSD card containing a game, shows a window with information about the
game, and when **A** is pressed on an Xbox gamepad it syncs the saves, launches the game,
waits for it to close, copies the saves back to the card, and tracks the play time.

> **Platform: Windows 10/11 (x64) only.** The app uses `tasklist` and the native
> `drivelist` module; it does not work on macOS/Linux by design.

---

## 1. Requirements

- **Windows 10/11 x64.**
- **Node.js 18+** and npm (for building from source).
- **Native module build tools** — required to rebuild `drivelist` for
  Electron:
  - Visual Studio Build Tools with the "Desktop development with C++" component
    (or `npm i -g windows-build-tools` on older systems),
  - Python 3.x in `PATH`.
- **Xbox gamepad** (optional — there is a mouse fallback).
- **microSD card + card reader** with a prepared `game.json` manifest (see §6).

---

## 2. Install and build

```powershell
# from the project root
npm install
```

`npm install` will run `electron-builder install-app-deps` on its own via `postinstall` —
this rebuilds the native `drivelist` for the Electron version in use. If that step
fails (no C++ toolchain), install the dependencies without scripts and rebuild manually:

```powershell
npm install --ignore-scripts
npm run rebuild        # electron-rebuild -f -w drivelist
```

Compile the TypeScript (main + preload + renderer) and copy the assets:

```powershell
npm run build
```

The output goes to `dist/` (`dist/main`, `dist/preload`, `dist/renderer`,
`dist/shared`).

---

## 3. Running in development mode

```powershell
npm start
```

`start` runs `build` and launches Electron. By default (manual launch) the window
is shown immediately; on autostart with the `--hidden` flag the app starts into the tray.

Type checking without emit (strict mode, as the project code style requires):

```powershell
npm run typecheck      # tsc --noEmit
```

---

## 4. Building the distributable (NSIS + portable)

```powershell
npm run dist           # build + electron-builder
```

The artifacts will appear in `release/`:

- **NSIS installer** — installs the app and reliably configures autostart.
- **portable .exe** — runs without installation; autostart is best-effort.

The configuration lives in [`electron-builder.yml`](electron-builder.yml). For `drivelist`,
`asarUnpack` is set so that the native `.node` binary is available in the packaged build.

> ⚠️ **Verify on a real packaged build** that `drivelist` was unpacked from
> asar and the card is detected (this is spike risk R3 from the plan). If not, make sure
> `node_modules/drivelist/**` is included in `asarUnpack`.

---

## 5. Autostart

The app registers itself for autostart via
`app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] })`.

- `--hidden` → starts straight into the tray with no window (the window appears when a card is inserted).
- `openAsHidden` is not used: it is macOS-only and ignored on Windows — hidden
  startup is implemented via a manual `process.argv` check.
- Guaranteed for **NSIS installation**; for **portable** it is best-effort (the path to the exe
  may change).

To disable autostart: "Settings → Apps → Startup" in Windows.

---

## 6. Preparing the card: the `game.json` manifest

Placed in the **root** of the card. One game per card. The paths
`executable`/`heroImage`/`saveOnCard` are **relative to the card root**;
`pcSavePath` is absolute and starts with one of the allowed prefixes (see below).

```jsonc
{
  "schemaVersion": 1,
  "id": "hollow-knight",                    // stable id: key of the stats/pending-flush folder on the PC
  "title": "Hollow Knight",
  "executable": "game/hollow_knight.exe",   // relative path to the .exe from the card root
  "args": [],                               // launch arguments (optional)
  "heroImage": "assets/hero.jpg",           // window background (optional)
  "saveOnCard": "saves",                    // copy folder for saves on the card (relative to the root)
  "pcSavePath": "%APPDATA%/Team Cherry/Hollow Knight", // where the game actually writes saves on the PC
  "launchTimeoutSec": 30,                   // how long to wait for the process to appear (optional, default 30)
  "sounds": {                               // per-game UI sounds (all optional, card-relative paths)
    "play": "audio/play.ogg",               // pressing "Play"
    "navigate": "audio/move.ogg",           // moving focus between controls
    "button": "audio/button.ogg",           // pressing an ordinary button (e.g. "Info")
    "back": "audio/back.ogg"                // gamepad B closing the info popup
  },
  "backgroundMusic": "audio/theme.ogg"      // looping music while the window is visible (0.5 volume, optional)
}
```

### Example card layout

```
E:\
├─ game.json
├─ game\
│  └─ hollow_knight.exe
├─ assets\
│  └─ hero.jpg
└─ saves\            ← portable canonical copy of the saves
```

### Rules and security (the card is untrusted input)

- After resolution, `executable`/`heroImage`/`saveOnCard` **must lie inside the card
  root** — `..` and absolute paths are forbidden (otherwise the game won't launch and an error is shown).
- `pcSavePath` — only from an allowlist of prefixes, with no traversal (`..`). Otherwise rejected:
  - `%DOCUMENTS%` — the user's Documents folder, resolved via the system **Known Folder API**
    (`app.getPath('documents')`). **Language- and OneDrive-independent**: it returns the same
    physical path the game itself uses, so `%DOCUMENTS%/My Games/...` works on any machine
    without caring whether the folder is named `Documents`, `Документы`, or sits under OneDrive.
    Prefer this for games that save under Documents (most Bethesda titles, e.g. Fallout/Skyrim).
  - `%APPDATA%`, `%LOCALAPPDATA%`, `%USERPROFILE%` — resolved from the corresponding
    environment variables (good for games that save under AppData).
- `id` — only `[A-Za-z0-9._-]` (used as a folder name on the PC).
- `saveOnCard` and `pcSavePath` are set **together** or **both omitted**. If both are
  omitted, the game writes its saves next to its exe on the card and syncing is fully disabled.
- `sounds.*` and `backgroundMusic` — card-relative like `heroImage`, **must lie inside the card root**.
  Any missing sound slot is simply silent; `backgroundMusic` loops at 0.5 volume and pauses while a
  game is running or the window is hidden. Use a web-playable codec (ogg / mp3 / wav / m4a / opus).

### Where the app stores data on the PC

`%APPDATA%\microsd-game-launcher\`:

- `stats\<id>.json` — the **source of truth** for statistics (hours/date/launch count).
- `pending-flush\<id>\` — a deferred PC→SD sync with a snapshot of the saves, if the card was removed
  during play; it is applied on the next insertion of this card (matched by `id`).

---

## 7. How to use

1. Launch the app (or let it start with the system) — it sits in the tray.
2. Insert a card with a `game.json` — a window appears with the background, the title, the date of the last
   launch, and the hours played.
3. Press **A** on the gamepad (the window is force-focused) **or** click "Launch".
4. The app syncs the saves card→PC, launches the game, and hides the window.
5. Close the game — the app counts the time, updates the statistics, syncs the
   saves PC→card, and shows the "Launch" window again.

Tray: **Show** — bring back the window, **Quit** — close the app completely.

---

## 8. Known limitations

- **UAC/elevation (R4):** from a non-elevated app, `tasklist` cannot see an
  elevated process — a game that requires administrator rights will produce a false "didn't
  launch" timeout. Designed for a direct, self-contained `.exe` without UAC.
- **Launchers/wrappers (A2):** exit detection relies on the pid from `spawn`. A wrapper game
  (Steam/launcher) that immediately terminates its own process will produce a false "exit" — out of
  scope.
- **Removing the card during play** is handled gracefully (statistics on the PC,
  PC→SD is deferred to `pending-flush`), but **the game itself will most likely crash** —
  the exe is on the card. The UI warns "do not remove the card during play".
- **FAT/exFAT:** syncing goes "by direction", `mtime` is not used for decisions.

---

## 9. Project structure

```
src/
  main/        # all work with the FS/processes/disks (Electron main)
  preload/     # typed contextBridge bridge
  renderer/    # UI + gamepad reading (no Node)
  shared/      # shared contract of types/IPC channels
```

npm scripts: `typecheck`, `build`, `start`, `rebuild`, `dist`.
