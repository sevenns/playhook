<div align="center">
  <img src="icon.png" width="128" height="128" alt="Playhook icon">
  <h1>Playhook</h1>
  <p><strong>Bring console vibes to your PC.</strong></p>
  <p>
    <a href="#building-from-source-for-developers"><img src="https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-0078D6?logo=windows&logoColor=white" alt="Platform"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License: MIT"></a>
    <a href="https://github.com/sevenns/playhook/actions/workflows/build-windows.yml"><img src="https://github.com/sevenns/playhook/actions/workflows/build-windows.yml/badge.svg" alt="Build Windows"></a>
  </p>
</div>

Playhook is a background Windows app that turns a removable drive into a console-style game
cartridge. It lives in the tray, detects when you insert a card carrying a game (a `game.json`
manifest), and pops up a game card. Press **A** on an Xbox gamepad (or click **Play**) and it
syncs your saves onto the PC, launches the game, tracks the playtime, then copies the saves
back to the card when you quit — so your progress travels with the card across machines.

The card can carry the game itself, an **installer** for heavy games
([Install mode](#install-mode-heavy-games-on-slow-media)), or just a **pointer to a Steam app** by
`appid` that Playhook installs, launches and uninstalls through your local Steam client
([Steam mode](#steam-mode-launch-and-install-steam-games)).

> **Windows-only by design.** The app uses `tasklist` and the native `drivelist` module; it
> does not work on macOS/Linux.

> **Security note.** The card is untrusted input — every path in the manifest is validated
> against directory traversal and an allowlist before anything is read or written. See
> [Preparing a card](#preparing-a-card-gamejson) for the exact rules.

<!-- TODO: add a screenshot / GIF of the game card window here once UI assets exist. -->

---

## Download (for users)

Grab the latest installer from the [**Releases**](https://github.com/sevenns/playhook/releases/latest)
page. Two builds are published:

- **NSIS installer** (`.exe`, recommended) — installs the app, configures autostart reliably,
  and **updates itself** automatically.
- **portable** (`.exe`) — runs without installation; no auto-update, autostart is best-effort.

A couple of things to expect on first run:

- **SmartScreen warning.** The builds are not code-signed, so Windows SmartScreen will warn you
  the first time. This is expected — choose *More info → Run anyway*.
- **Visual C++ Redistributable.** If the app fails to start on a clean Windows install, install
  the latest [Visual C++ Redistributable (x64)](https://aka.ms/vs/17/release/vc_redist.x64.exe).
  (`.NET` is **not** required.)

### Quick start

1. **Install** (or unzip the portable build) and run it — it sits quietly in the tray.
2. **Insert a card** that has a `game.json` in its root (see below).
3. A **game card window** appears with the title, last-played date, and hours played.
4. Press **A** on the gamepad (or click **Play**) — saves sync and the game launches.
5. **Close the game** — Playhook counts the time, updates stats, and syncs saves back to the card.

---

## How it works

1. Playhook starts hidden in the tray. With no game card inserted, there is no window.
2. Insert a card with a valid `game.json` and a window appears showing the background art, the
   title, the last launch date, and the hours played (state `ready`). If the manifest has no
   `heroImage`, a bundled wallpaper is used as the background.
3. Press **A** on the gamepad (the window is force-focused) **or** click **Play**.
4. Saves are synced card → PC and the game launches; it takes the foreground over the launcher.
5. When the game closes, Playhook counts the play time, updates the statistics, and syncs the
   saves PC → card. The game card window returns.

If a launch fails, the window stays on the normal game screen and the reason is shown in a small
**error popup** on the right (close it with **B** / a click, then retry). Press the **Info** (ⓘ)
button to see playtime stats in the same kind of popup.

The empty screen (summoned with no card) reuses the same layout over the wallpaper: "Insert a game
card" and a **Hide** (✕) button on the right to send the window back to the tray.

When the launcher is hidden you can **hold Start + Back** on the gamepad to re-summon it. This
hotkey is intentionally ignored **while a game is running** — pulling the launcher over a running
game only causes focus trouble.

Tray menu: **Show** (bring back the window), **Open logs** (open the log folder), **Quit**
(close the app completely).

---

## Preparing a card: `game.json`

Place a `game.json` in the **root** of the card. One game per card. The paths
`executable` / `heroImage` / `saveOnCard` are **relative to the card root**; `pcSavePath` is
absolute and must start with one of the allowed prefixes (see below).

```jsonc
{
  "schemaVersion": 1,
  "id": "hollow-knight",                    // stable id: key of the stats/pending-flush folder on the PC
  "title": "Hollow Knight",
  "executable": "game/hollow_knight.exe",   // relative path to the .exe from the card root
  "args": [],                               // launch arguments (optional)
  "runAsAdmin": false,                      // launch elevated via UAC for .exe requiring admin (optional, default false)
  "heroImage": "assets/hero.jpg",           // window background: one path, or an array of paths that cross-fade every minute (optional; falls back to a bundled wallpaper)
  "saveOnCard": "saves",                    // copy folder for saves on the card (relative to the root)
  "pcSavePath": "%APPDATA%/Team Cherry/Hollow Knight", // where the game actually writes saves on the PC
  "launchTimeoutSec": 30,                   // how long to wait for the process to appear (optional, default 30)
  "watchProcesses": ["Game-Win64-Shipping.exe"], // for launcher/wrapper games: track THESE process names, not the spawned launcher (optional)
  "sounds": {                               // per-game UI sounds (all optional; omitted slots use a bundled default)
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

- After resolution, `executable` / `heroImage` / `saveOnCard` **must lie inside the card
  root** — `..` and absolute paths are forbidden (otherwise the game won't launch and an error
  is shown). The `executable` must also **exist on the card**, or launch is rejected.
- `pcSavePath` — only from an allowlist of prefixes, with no traversal (`..`). Otherwise rejected:
  - `%DOCUMENTS%` — the user's Documents folder, resolved via the system **Known Folder API**
    (`app.getPath('documents')`). **Language- and OneDrive-independent**: it returns the same
    physical path the game itself uses, so `%DOCUMENTS%/My Games/...` works on any machine
    without caring whether the folder is named `Documents`, `Документы`, or sits under OneDrive.
    Prefer this for games that save under Documents (most Bethesda titles, e.g. Fallout/Skyrim).
  - `%APPDATA%`, `%LOCALAPPDATA%`, `%USERPROFILE%` — resolved from the corresponding
    environment variables (good for games that save under AppData).
  - `%LOCALLOW%` — the `AppData\LocalLow` folder, derived from `%USERPROFILE%` (it has no environment
    variable of its own). Common for **Unity / Steam** games (e.g. Valheim → `%LOCALLOW%/IronGate/Valheim`).
    Note: `%APPDATA%` is `AppData\Roaming` and is **not** a parent of `LocalLow` — use `%LOCALLOW%` for
    LocalLow saves.
- `id` — only `[A-Za-z0-9._-]` (used as a folder name on the PC).
- `runAsAdmin` — set `true` **only** for an `.exe` whose embedded manifest requires administrator
  (a plain launch fails with `EACCES` / `ERROR_ELEVATION_REQUIRED`). Playhook then launches it
  elevated via a UAC prompt (`ShellExecuteEx` `runas`) and monitors it by process HANDLE instead of
  `tasklist` (a non-elevated app can't see an elevated process). Opt-in on purpose — Playhook never
  silently escalates an untrusted card's exe. Windows-only: `true` on other platforms is an error.
- `watchProcesses` — for **launcher / wrapper** games, where `executable` spawns a launcher that
  starts the game in a **separate process** and then exits (so watching the spawned pid would wrongly
  report "closed" the instant the launcher quits). List the **game's own** process image names here:
  Playhook still spawns `executable`, but tracks the session by the **presence** of these names in
  `tasklist`. Playtime starts when a watched process appears and ends when all of them are gone. When
  omitted, behaviour is unchanged (the spawned pid is tracked directly — the default for a
  self-contained `.exe`). Each entry is a bare `*.exe` name (no quotes, no path separators), matched
  case-insensitively; 1–16 names. **Caveats:**
  - **anticheat / elevation** — Steam / EAC / BattlEye often launch the game **elevated or as a
    service**, which a non-elevated `tasklist` can't see (R4) → Playhook reports "didn't start" and
    quietly returns without recording a session. This is a **common** case for launcher games, not a
    rare edge.
  - **generic names** — don't use names like `game.exe` or a shared `UnityPlayer`-style binary: they
    can match an unrelated process. Use the game's specific shipping name.
  - **already-running instance** — don't open the game manually before pressing Play: presence
    matching would latch onto that pre-existing process.
- `saveOnCard` and `pcSavePath` are set **together** or **both omitted**. If both are omitted,
  the game writes its saves next to its exe on the card and syncing is fully disabled.
- `sounds.*` and `backgroundMusic` — card-relative like `heroImage`, **must lie inside the card
  root**. Any omitted sound slot falls back to a **bundled default** sound, so every game has UI
  sounds out of the box; `backgroundMusic` is off unless set, loops at 0.5 volume and pauses
  while a game is running or the window is hidden. Use a common web-playable audio format
  (mp3, ogg/oga, opus, wav, m4a, aac, flac, webm).

### Install mode (heavy games on slow media)

Some games are too heavy to run from a micro SD / external drive (performance tanks), but the
**installer** fits there fine. Add an optional `install` block and the card carries a `setup.exe`
instead of the game itself:

```jsonc
{
  "schemaVersion": 1,
  "id": "heavy-game",
  "title": "Heavy Game",
  "executable": "HeavyGame/HeavyGame.exe", // RELATIVE TO THE INSTALL DIR (not the card) in install mode
  "install": {
    "installer": "setup/HeavyGameSetup.exe", // path to the installer, relative to the card root
    "type": "nsis",                          // nsis | inno | custom
    "runAsAdmin": false,                     // run the installer elevated (optional, default false)
    "args": []                               // type "custom": full argv with exactly one {dir} token
  },
  "launchTimeoutSec": 30
}
```

How it works:

- While the game isn't installed, the **"Play" button becomes "Install"**. Pressing it asks for
  confirmation (the popup also shows the destination path, handy if the installer isn't fully silent),
  then runs the installer **silently** and shows an **"Installing..."** indicator. When the executable
  appears the button turns back into **"Play"**, and from then on the game launches **from the install
  location on the PC**.
- The **install location is controlled by the app**, not the card: `%LOCALAPPDATA%\playhook\games\<id>`
  (per-user, non-roaming, no admin needed). In install mode `executable` is resolved **relative to
  that directory**.
- The installer runs **silently** because that's the only way the app keeps control of the install
  path — a visible wizard would let the user change the destination. The path is fed through each
  family's silent dir-key:
  - **`nsis`** → `/S /D=<dir>` (the `/D=` is unquoted and last, per NSIS rules);
  - **`inno`** → `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR="<dir>"` — **GOG offline installers
    are Inno Setup**, so GOG games use `"type": "inno"`;
  - **`custom`** → your own `args`, with the install dir substituted into the single `{dir}` token.
    You own the flags and quoting; the installer **must** support a silent + target-dir mode.
- The installer **must** honour the supplied directory. If it ignores it (or fails), the game's
  executable won't appear at the expected path → Playhook reports an error and stays on "Install".
- **`type: "custom"` with `runAsAdmin: true` is rejected**: `custom` lets the card control the
  argv, and running that elevated would escalate the attack surface. For `nsis`/`inno` the app builds
  the args itself, so elevated is allowed there.
- **MSI is out of scope** for now (its install-directory property name isn't standardized, so the
  path can't be controlled reliably).
- Once installed, an **"Uninstall"** button appears next to **"Info"** (only for an installed
  install-mode game). Pressing it asks for confirmation, then removes the game: Playhook finds the
  game's **own uninstaller** inside the install folder (Inno's `unins000.exe`, NSIS's `Uninstall.exe`)
  and runs it **silently** — so it cleans up the registry (Add/Remove Programs) and Start-Menu
  shortcuts — and then deletes `%LOCALAPPDATA%\playhook\games\<id>`. The button turns back into
  **"Install"**.

#### How to tell your installer's type

Getting `type` right matters: NSIS and Inno take **different, mutually exclusive** silent flags, and
they quote the target path differently (NSIS `/D=` is unquoted and last; Inno `/DIR="..."` is quoted),
so the wrong type breaks paths with spaces (e.g. `%LOCALAPPDATA%` for a user named `John Doe`).

- **GOG games** → always **`inno`**. GOG offline installers (`setup_<game>_*.exe`) are built with
  Inno Setup.
- **File properties** (right-click → Properties → Details): Inno often shows
  `This installation was built with Inno Setup` in Comments; NSIS shows `Nullsoft Install System` (or
  leaves the version fields blank).
- **Open it with 7-Zip**: NSIS archives contain a `[NSIS].nsi` / NSIS script entries; Inno archives
  show Inno's structure (`{app}`, embedded payload). A detector like **Detect It Easy (DiE)** names the
  installer family outright.
- **`setup.exe /?`**: Inno pops up a dialog listing `/SILENT`, `/VERYSILENT`, `/DIR=`, etc. — which
  also confirms it supports the silent + target-dir mode Playhook needs.

The most reliable check is to **dry-run the exact flags** Playhook will use and confirm the game lands
in the target folder with no wizard window:

```powershell
# Inno (and GOG):
.\setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR="C:\test\inno-check"

# NSIS:
.\setup.exe /S /D=C:\test\nsis-check
```

Installed silently into the folder → that's your type. A wizard appeared, or it installed elsewhere →
it's the other type (or neither — use `custom`).

To reinstall or update, use the **Uninstall** button (or, as a fallback, delete
`%LOCALAPPDATA%\playhook\games\<id>` manually) and press Install again. Saves still sync to/from the
card exactly as for a normal game (the `install` block is orthogonal to `saveOnCard`/`pcSavePath`).

Cleaning up the **registry and Start-Menu shortcuts is best-effort** — it's done by the game's own
uninstaller, which Playhook finds in the install folder for typical NSIS/Inno games (with a registry
lookup as a fallback for a nonstandard NSIS uninstaller name). For `type: "custom"`, or when the
uninstaller can't be found, only the install folder is removed and a registry/shortcut tail may remain.
Uninstalling targets the PC, so it's unaffected by the card being removed mid-operation.

### Steam mode (launch and install Steam games)

Instead of carrying the game files, a card can be just a **pointer to a Steam app** by its numeric
`appid`. Add a `steam` block and Playhook launches, installs and uninstalls the game **through your
local Steam client** (via `steam://` URIs) — the card only needs the manifest, the cover art, and
(optionally) the saves.

```jsonc
{
  "schemaVersion": 1,
  "id": "valheim",
  "title": "Valheim",
  "steam": { "appid": 892970 },              // the Steam application id (store URL / steamdb.info)
  "watchProcesses": ["valheim.exe"],         // REQUIRED in steam mode (see below)
  "launchTimeoutSec": 120,                    // raise it — Steam cold-start / updates take time
  "heroImage": "assets/hero.jpg",            // optional, card-relative as usual
  "saveOnCard": "saves",                     // optional save sync, exactly like a normal game
  "pcSavePath": "%LOCALLOW%/IronGate/Valheim"
}
```

There are **no game files on the card** — `executable` / `install` are not used (and are rejected if
present). `heroImage`, `sounds`, `backgroundMusic`, and `saveOnCard` / `pcSavePath` work exactly as
for a normal game.

**Rules (enforced by the schema):**

- `steam.appid` — a positive integer. For a base game `rungameid == appid` (read it off the store URL
  or steamdb.info). DLC / non-base launch ids are out of scope.
- `watchProcesses` is **required**. `steam://rungameid` returns instantly and the game has no pid of
  its own, so the only way to track start/exit is by the game's process name(s) — same field and rules
  as for launcher games.
- `executable`, `install` and `runAsAdmin` are **forbidden** in steam mode (the launch method is
  exactly one: Steam).
- Raise `launchTimeoutSec` (e.g. `120`): a Steam cold start, shader pre-cache, or an auto-update before
  launch can easily exceed the default 30s window (see [Known limitations](#known-limitations)).

**How it works:**

- **"Installed" is Steam's own truth**, read from the app manifest (`appmanifest_<appid>.acf`) across
  every Steam library (`libraryfolders.vdf`); the Steam path comes from the registry. The game counts
  as installed only when Steam marks it *fully installed* (a game that's still downloading reads as
  "not installed").
- **Not installed → the "Play" button is "Install".** Pressing it confirms ("Open Steam to install this
  game?") and opens `steam://install/<appid>` — Steam shows its own install dialog. Playhook does **not**
  block on a wizard: it stays on the screen, shows a non-blocking **"Installing…"** indicator, and a
  background poll (~5s) flips the button to **"Play"** once Steam reports the game fully installed. The
  window stays usable meanwhile — a Steam download can run for hours.
- **Pause:** if you pause the download in Steam, the indicator becomes **"Installing paused on N%…"**
  (the percent is only available while paused — see limitations). While a download is in progress the
  **Play button (showing the loader) opens Steam's Downloads page** so you can pause/resume there —
  Steam exposes no way to pause/resume a download programmatically.
- **Launch:** when installed, pressing Play opens `steam://rungameid/<appid>`; the session is tracked by
  `watchProcesses` (start → running → exit), with saves synced and stats recorded like a normal game.
- **Uninstall:** an installed Steam game shows an **"Uninstall"** button → confirm → `steam://uninstall/<appid>`
  (Steam's own removal UI). The background poll flips the button back to **"Install"** once the game is
  gone (an uninstall you trigger directly in Steam is picked up too).
- **Saves** sync to/from the card exactly as for a normal game. Steam / Unity games often store saves
  under `AppData\LocalLow` — use the `%LOCALLOW%` prefix (e.g. Valheim → `%LOCALLOW%/IronGate/Valheim`).

If Steam isn't installed on the PC, Install/Play report **"Steam is not installed"** instead of opening
a URI. Steam's install and uninstall dialogs **cannot be made silent** — there is no `steam://` flag to
suppress them (just one confirmation; the rest of the flow is automatic).

### Statistics: one card, many PCs

Statistics (hours / last played / launch count) are **unified across machines** with the card as
the carrier:

- `stats.json` in the **card root** is the **traveling canonical** record. It moves with the card.
- `%APPDATA%\playhook\stats\<id>.json` on each PC is a **working mirror**.

On every insertion the two are **reconciled** (field-wise: `max` of the cumulative totals, the
later `lastPlayedAt`) and the merged result is written back to both. Because the card is
physically a single device used sequentially, this never loses progress and never double-counts.
A fresh card with no `stats.json` simply adopts the local PC value (and starts carrying it from
then on).

Other PC state under `%APPDATA%\playhook\`:

- `pending-flush\<id>\` — a deferred PC → SD sync with a snapshot of the saves, if the card was
  removed during play; it is applied on the next insertion of this card (matched by `id`).

---

## Building from source (for developers)

### Requirements

- **Windows 10/11 x64.**
- **Node.js 18+** and npm.
- **Native module build tools** — required to rebuild `drivelist` for Electron:
  - Visual Studio Build Tools with the "Desktop development with C++" component,
  - Python 3.x in `PATH`.

  (`koffi` ships prebuilt, so the C++ toolchain is needed only for `drivelist`.)
- **Xbox gamepad** (optional — there is a mouse fallback).
- A removable storage device (USB drive, SD card, etc.) with a prepared `game.json` manifest.

### Install, build, run

```powershell
# from the project root
npm install
```

`npm install` runs `electron-builder install-app-deps` on its own via `postinstall` — this
rebuilds the native `drivelist` for the Electron version in use. If that step fails (no C++
toolchain), install without scripts and rebuild manually:

```powershell
npm install --ignore-scripts
npm run rebuild        # electron-rebuild -f -w drivelist
```

Compile the TypeScript (main + preload + renderer) and copy assets, then run in dev mode:

```powershell
npm run build          # output goes to dist/ (main, preload, renderer, shared)
npm start              # builds and launches Electron (always starts hidden in the tray)
npm run typecheck      # tsc --noEmit (strict)
```

### Building the distributable

```powershell
npm run dist           # build + electron-builder → release/ (NSIS + portable)
```

The configuration lives in [`electron-builder.yml`](electron-builder.yml). For `drivelist`,
`asarUnpack` is set so the native `.node` binary is available in the packaged build.

> ⚠️ Verify on a real packaged build that `drivelist` was unpacked from asar and the card is
> detected. If not, make sure `node_modules/drivelist/**` is included in `asarUnpack`.

---

## Releasing & auto-update

Installed apps update themselves via **electron-updater + GitHub Releases** (public repo, so the
client needs no token). Only the **NSIS** build self-updates — the portable `.exe` does not.

Release flow:

1. Bump `version` in [`package.json`](package.json) (e.g. `0.1.1` → `0.1.2`).
2. Commit, then push a matching tag: `git tag v0.1.2 && git push origin v0.1.2`.
3. The [Build Windows](.github/workflows/build-windows.yml) workflow builds and uploads the
   installer + `latest.yml` to a **draft** GitHub Release `v0.1.2`.
4. **Publish the draft release** on GitHub to make it live (and visible on the Releases page).
5. Each running app checks on startup and every 6h, downloads the update silently, and installs
   it on the **next quit** (it never interrupts a running game). See `[updater]` lines in the log.

Notes:

- The tag must be `v{version}` and the version must be higher than the installed one.
- The publish target (`owner` / `repo`) is set in [`electron-builder.yml`](electron-builder.yml) —
  update it if the GitHub repo is renamed.
- No code signing: the very first install shows a Windows SmartScreen warning, but updates still
  apply (unlike macOS, Windows auto-update works unsigned).

### Autostart

The app registers itself for autostart via `app.setLoginItemSettings({ openAtLogin: true })`.

- It always starts hidden in the tray (no flag needed): the window appears only when a valid game
  card is detected.
- Guaranteed for the **NSIS installation**; for **portable** it is best-effort (the path to the
  exe may change).
- To disable: *Settings → Apps → Startup* in Windows.

---

## Logs

The main process writes a timestamped log to `%APPDATA%\playhook\logs\main.log` (open it via the
tray **Open logs** item). It records card insertions, manifest validation, the stats
reconcile / card-copy result, and launch/exit — useful when a save or stats copy to the card
silently fails.

---

## Known limitations

- **UAC / elevation:** from a non-elevated app, `tasklist` cannot see an elevated process — a
  game that requires administrator rights will produce a false "didn't launch" timeout. Designed
  for a direct, self-contained `.exe` without UAC.
- **Launchers / wrappers:** by default exit detection relies on the pid from `spawn`, so a wrapper
  game (Steam / launcher) that immediately terminates its own process would produce a false "exit".
  This is now **supported** via [`watchProcesses`](#rules-and-security-the-card-is-untrusted-input):
  list the game's own process image names and Playhook tracks those instead of the launcher pid.
  Caveat: if the launcher runs the game **elevated or as a service** (common with Steam / EAC /
  BattlEye), a non-elevated `tasklist` can't see it — the session won't be tracked.
- **Removing the card during play** is handled gracefully (statistics on the PC, PC → SD deferred
  to `pending-flush`), but **the game itself will most likely crash** — the exe is on the card.
  The UI warns "do not remove the card during play".
- **FAT/exFAT:** syncing goes "by direction"; `mtime` is not used for decisions.
- **Install mode** (the `install` block, see [Install mode](#install-mode-heavy-games-on-slow-media)):
  - The installer **must support silent install + a target-directory flag**. If it doesn't, use
    `type: "custom"` with the right flags, or it can't be driven (R-SILENT).
  - If the installer **ignores the supplied directory** and installs elsewhere, the executable won't
    appear at the expected path → reported as "not installed". Inherent to running a real `setup.exe`;
    doesn't happen with well-behaved NSIS/Inno installers (R-IGNOREDIR).
  - If an installer creates the executable **early** and then crashes, a presence check can't tell it
    apart from success. Mitigated by pre-cleaning the install dir and a post-exit grace poll, but a
    residual risk remains for arbitrary installers (R-PARTIAL).
  - **MSI installers are not supported** (the install-directory property name isn't standardized).
  - **Reinstall/update is manual:** delete `%LOCALAPPDATA%\playhook\games\<id>` and press Install again.
  - Progress is a plain "Installing..." indicator (no percentages — unavailable for an arbitrary
    silent `setup.exe`).
- **Steam mode** (the `steam` block, see [Steam mode](#steam-mode-launch-and-install-steam-games)):
  - **Steam must be installed** on the PC, otherwise Install/Play report "Steam is not installed".
  - **Install/uninstall aren't silent** — Steam always shows its own dialog (one confirmation); there is
    no `steam://` flag to suppress it. After that the flow is automatic.
  - **No live download percent.** Steam exposes no real-time progress in any file Playhook can read (the
    `.acf` byte counters freeze mid-download; the on-disk download folder is preallocated). The percent is
    shown only **while the download is paused** ("Installing paused on N%…").
  - **Can't pause/resume programmatically** — the Play button just opens Steam's Downloads page so you can
    do it in Steam itself.
  - **Cold start / pre-launch update** can exceed `launchTimeoutSec` → the game process never appears in
    the window and Playhook quietly returns without recording a session. Raise `launchTimeoutSec` for
    Steam games.

---

## Project structure

```
src/
  main/        # all work with the FS/processes/disks (Electron main)
  preload/     # typed contextBridge bridge
  renderer/    # UI + gamepad reading (no Node)
  shared/      # shared contract of types/IPC channels
```

npm scripts: `typecheck`, `build`, `start`, `rebuild`, `dist`.

---

## Contributing

PRs welcome. The codebase is **strict TypeScript** (no `any`, explicit return types,
functional style). Please run `npm run typecheck` before opening a PR.

---

## FAQ

- **Is the SmartScreen warning normal?** Yes. The builds aren't code-signed, so Windows warns on
  first run. Choose *More info → Run anyway*. Auto-update still works without signing.
- **Why Windows-only?** Process detection uses `tasklist` and device detection uses the native
  `drivelist` module — both Windows-specific.
- **Does it work without a gamepad?** Yes. Every gamepad action has a mouse fallback (click
  **Play**, etc.).
- **Can I use it with Steam games?** **Yes** — via [Steam mode](#steam-mode-launch-and-install-steam-games):
  a `game.json` with a `steam` block launches, installs and uninstalls the game through your local Steam
  client (the card is just a pointer by `appid`). For a **non-Steam** wrapper/launcher `.exe`, point it at
  the exe and use [`watchProcesses`](#rules-and-security-the-card-is-untrusted-input) so exit detection
  works.

---

## License

MIT — see [LICENSE](LICENSE).
