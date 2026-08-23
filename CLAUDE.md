# Playhook — contributor & agent guide

Conventions for extending Playhook safely. These were distilled from an architecture audit whose goal
was: **add features without breaking existing behaviour.** Follow them for new code; they are not a
mandate to rewrite what already works.

## UI text

- **Never type a literal `...` or `…` in user-facing text** (i18n strings, HTML fallback text, anything
  rendered through the app's own font). The bundled font (M PLUS Rounded 1c) draws periods and the
  ellipsis glyph CENTERED vertically — the CJK convention, not the Latin one — so they sit above the
  baseline and read as a row of raised dots instead of trailing punctuation. `styles.css` carves those
  two code points out of the font (see the `@font-face … unicode-range: U+002E, U+2026` overrides right
  after the four real ones) so the fallback stack draws them properly wherever they DO appear — including
  text this app does not author, like a game's own title — but that is a safety net, not a licence: new
  copy should still be worded so nothing trails off, rather than leaning on the override.

## Layers (do not blur)

- **main** owns all game logic (fs, registry, process control, FFI). **renderer** is stateless UI.
- They talk **only over IPC**. The renderer never touches fs/registry; main never touches the DOM.
- Preload bridges are typed and sandboxed (`contextIsolation: true`, `sandbox: true`).
- A **pure** function BOTH sides must compute identically (no fs/electron either way) lives in
  `src/shared/` alongside `types.ts` and `i18n/` — not duplicated in each layer, and not placed under
  `src/main/`: `tsconfig.renderer.json` does not include it and esbuild builds the renderer for the
  browser, so a `node:*` import there breaks the build, not just the convention. See
  `src/shared/asset-move-names.ts` (move-to-card asset names, computed identically in main and renderer).

## Error-handling convention

Pick per situation, matching the existing patterns:

- **Untrusted external data → Result-union.** For anything parsed from the card / disk / registry,
  return a discriminated `{ ok: true, … } | { ok: false, message }` (see `manifest.ts` `ManifestResult`).
  This is the reference pattern — the caller must handle failure explicitly.
- **Storage reads (JSON on disk) → `readJsonValidated`.** Use `json-store.ts`: it validates with a zod
  schema and falls back to a default. A **missing** file is silent (normal first-run); a file that
  exists but is unreadable/invalid is **logged with `log.warn`** — never swallow corruption of user
  data silently.
- **Programmer/environment faults → throw.** Launch/FFI paths throw (`game-launcher.ts`); the caller
  (`GameController`) catches and turns it into a user-facing error + state transition.
- **Always leave a breadcrumb.** Best-effort `catch` blocks (card may be yanked, log write may fail)
  are fine, but log the cause with `log.warn`/`log.error` unless it is a known-benign absence.

## Adding a new service

Follow the **interface-DI** shape of `StatsService` / `UpdaterService` (dependencies passed via a
typed `…Deps` interface), not the bare-primitive-constructor or free-function styles that predate it.
Interface-DI is the most testable: it lets a unit test inject fakes without electron/fs. Bootstrap the
service in `main.ts`; wire IPC through `GameController`/`SettingsWindow` as appropriate.

## Adding a new IPC channel

The channel literal lives in **one** source of truth and is bridged with compile-time checks:

1. Add the channel to the `IPC` const map in `shared/types.ts` (with a doc comment on direction).
2. Add the method to the matching `RendererApi` / `SettingsApi` interface.
3. Add the literal to the preload's `CHANNELS` map (`preload.ts` for game, `settings-preload.ts` for
   settings). The `satisfies Partial<typeof IPC>` catches a wrong value or typo'd key at compile time.
4. Wire the handler in `ipc.ts` (main) and consume it in the renderer.

The `test/ipc-channels.test.ts` suite guards **completeness**: every `IPC` channel must be exposed by
exactly one preload. `satisfies Partial<>` cannot catch a *forgotten* channel — that test can.

## Two entry points: GUI and daemon

`src/main/main.ts` is the Electron app. `src/main/daemon.ts` is the Game Mode card watcher, started by
systemd **under `ELECTRON_RUN_AS_NODE=1`** — the same binary running as plain Node, with no Chromium
(Electron cannot start under systemd in Game Mode: there is no display in a unit's environment).

The consequence that bites: **in that mode the `electron` module does not exist.** It is a devDependency
and the runtime only injects it for a normal Electron start, so any `import … from 'electron'` anywhere on
the daemon's import graph throws `MODULE_NOT_FOUND` before our first line runs — a crash loop that is
invisible locally (tsc and ESLint pass, the GUI works, vitest aliases `electron` to a stub). It has
happened once already, via `logger.ts` and `steam.ts`.

- Modules the daemon reaches must be electron-free. When one needs electron, split that part into a
  GUI-only module — `steam-uri.ts` was carved out of `steam.ts` for exactly this.
- Anything needing a path the GUI gets from `app.getPath()` takes it as a parameter instead
  (`setLogBaseDir()`, `AppSettingsStore(baseDir)`).
- `test/daemon-imports.test.ts` walks the graph and fails on a forbidden import (it also excludes
  koffi-bound win32 modules, which is why the daemon calls `createLinuxPlatform()` directly rather than
  `createPlatform()`). Type-only imports are fine — they are erased.

## Platform layer (OS-specific code)

Playhook runs on **three** OSes: Windows, the Steam Deck / Linux (Windows games via Proton/umu-launcher)
and macOS. macOS is a deliberately narrower port — NATIVE mac games (a bare binary or a `.app` bundle) plus
Steam mode; a Windows `*.exe` does not run there (no Wine/CrossOver), install mode is unsupported, and the
build does not self-update. **All OS-specific behaviour lives behind the `Platform` bundle in
`src/main/platform/`**, not scattered `process.platform` checks. When you add code that differs per OS:

- Add the capability to an interface in `platform/types.ts` (the bundle is `ProcessMonitor`,
  `SteamLocator`, `SteamShortcuts`, `GameProcessLauncher`, `SavePathResolver`, `PowerBackend`,
  `RemovableMounter`, `resolveInstallDir`).
- Implement it in **all three** of `platform/win32.ts`, `platform/linux.ts` and `platform/darwin.ts`
  (linux Proton helpers live in `platform/*.linux.ts` / `umu.ts`; the macOS ones in `platform/*.darwin.ts`).
  `createPlatform(process.platform)` selects the bundle once at bootstrap in an explicit three-way branch
  (win32 / darwin / everything-else = linux); the rest of the code is platform-agnostic and receives it via
  DI (`ControllerDeps.platform`).
- **Never change the behaviour of an OS you are not porting.** Adding the Linux side must leave win32 1:1;
  adding macOS must leave BOTH win32 and linux 1:1 (the port's guiding invariant, and the one most easily
  broken by accident — a visibility rule phrased as "only on Linux" silently takes a section away from
  Windows too; phrase it as "not on the OS being added"). Keep the OS-neutral fs/parse code (manifest,
  save-sync, `.acf`/VDF, drive-watcher) shared — don't fork it.
- Card format is a **Windows dictionary** on every OS (`%APPDATA%`, `*.exe`, `install.type`), interpreted
  per platform: on Linux relative to the game's Wine prefix; on macOS translated into the mac profile
  (`%APPDATA%`/`%LOCALAPPDATA%`/`%LOCALLOW%` → `~/Library/Application Support`, `%USERPROFILE%` → `~`,
  `%DOCUMENTS%` → `~/Documents`) while a card whose `executable` is a `*.exe` simply refuses to launch
  there. A `game.json` must work unchanged wherever it CAN work — Linux-only manifest fields (`winetricks`,
  `umuGameId`) are ignored elsewhere, never rejected. `watchProcesses` names may omit the `.exe` suffix
  (a native mac process has none); keep the `*.exe` spelling on a card meant to travel — the macOS matcher
  normalizes the suffix away, so one spelling matches on all three.
- Extract the pure bits (path/env/argv construction, `/proc` and `ps` parsing, prefix mapping) into
  electron-free helpers and unit-test them (see `umu.ts`, `proc.ts`, `save-path.linux.ts`,
  `process-monitor.darwin.ts`, `save-path.darwin.ts`).
- **Build Linux AND macOS paths with `path.posix`, never bare `path.join`.** `path.join` follows the OS the
  code RUNS on, and CI runs the test suite on Windows too — so a Linux path built with `path.join` comes
  out as `\home\deck\...` there and fails a test that (correctly) expects `/home/deck/...`. This has broken
  the Windows job repeatedly. The rule applies verbatim to macOS: `path.join('~/Library/Application
  Support', …)` in a darwin module yields `\Library\…` on the Windows runner. In any `*.linux.ts` or
  `*.darwin.ts` module — and in any OS-specific feature elsewhere — use `path.posix.join` /
  `path.posix.dirname` / `path.posix.basename`. Reference: `umu.ts` `prefixDir`, `steam-userdata.linux.ts`,
  `steam-locator.darwin.ts`. The win32 side keeps plain `path.join` (there it is right).
  Beware the silent variant: when a value is *derived* from a path (the Steam shortcut appid is a CRC32 of
  it), a wrong separator does not fail loudly — it produces a wrong value.
  Quick check before pushing:
  `grep -rn "path\.\(join\|dirname\|basename\|resolve\)(" src/main/platform/*.{linux,darwin}.ts`

## Tests

- Runner: **vitest** (`npm test`). Tests live in `test/`, run in plain Node with **no electron**
  (`test/stubs/electron.ts` is aliased for the `electron` import — see `vitest.config.ts`).
- Testable = **pure / electron-free** modules. Modules that evaluate koffi FFI at import
  (`game-launcher.ts`) are not importable in Node — extract pure logic into a util (as `launch-args.ts`
  was) and test that.
- Prefer covering the risky, data-touching functions: manifest validation/anti-traversal, stats merge,
  save-sync retry, argument quoting.
- **DOM tests of the renderer's screen controllers live in `test/renderer/**`** and run under
  **happy-dom** instead of plain Node (`environmentMatchGlobs` in `vitest.config.ts` — scoped by glob, so
  every other suite keeps its Node environment and its POSIX path literals). A controller is testable
  there because it is a factory taking a narrow `…Deps` seam: the fixture is the REAL
  `src/renderer/index.html` (loaded by `test/renderer/helpers/fixture.ts`, so every id `req()` asks for
  has to exist), the deps are faked (`helpers/fakes.ts`: audio, the screen APIs, the keyboard / file
  picker / online picker surfaces), and the translator is the real `createTranslator('en')`. Input is the
  `NavSurface` primitives called directly — no gamepad polling; the hover/veil branches are reachable
  through `hoverOver()` (they all sit behind the `mouse-asleep` class the fixture starts with).
  Four rules that bite:
  - **The screens that fetch their own data open ASYNCHRONOUSLY** — `filePicker.open()` awaits `listDir`,
    `gameSettings.open(id)` awaits the manifest read, so assert after `await flushAsync()`. `SettingsScreen`
    is the exception: its `open()` is synchronous and the snapshot arrives through `applySettings()`.
  - **rAF must be the harness in `helpers/raf.ts`, with a frame-BOUNDED `flush(n)`** — the marquees
    reschedule themselves forever while element widths are zero, which they always are without layout.
  - **Load the fixture per test** (`beforeEach`), and create the controller after it: no controller removes
    its listeners, so a fixture shared across a file collects one live instance per test on the same nodes.
  - **`app.ts` stays out** — it touches `window.api` at module scope.
  Covered so far: `screen-sidebar`, `osk`, `file-picker`, `settings-screen`, `game-settings-screen`. Still
  uncovered and next in line for the same base: `controls.ts`, `online-picker.ts`, `library-screen.ts`,
  `carousel.ts`. Anything needing real layout (`scrollHeight`, canvas) is still a manual check on the Deck.
  Upgrade note: `environmentMatchGlobs` is deprecated in vitest 3 and GONE in vitest 4 — an upgrade must
  move `test/renderer/**` to `test.projects` (or a per-file `@vitest-environment` docblock) or the suites
  will quietly run in Node again and fail on `document is not defined`.
- **The suite runs on Windows, Linux AND macOS in CI, so a green local run proves nothing about path
  handling.**
  A test that asserts a Linux path against a literal (`expect(...).toBe('/home/deck/...')`) is correct and
  should stay — it is the *source* that must use `path.posix` (see the platform-layer rule above). Never
  "fix" such a failure by rewriting the expectation with `path.join`: that makes the test assert whatever
  the code does and stops testing anything at all.

## Tooling (all run in CI before build)

- `npm run typecheck` — strict `tsc`, no `any`, no non-null `!`. Covers `test/` as well as `src/`.
- `npm run lint` — ESLint with type-aware rules (`no-floating-promises`, `no-misused-promises`,
  `strict-boolean-expressions`), over `src` and `test`. Tests switch off `require-await` and
  `unbound-method` (both only ever fire on test doubles) and allow a `_`-prefixed unused parameter.
- `npm test` — vitest.
- `npm run format` / `format:check` — Prettier (available for new code; the existing hand-aligned
  files are intentionally not mass-reformatted).
