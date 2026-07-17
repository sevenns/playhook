# Playhook — contributor & agent guide

Conventions for extending Playhook safely. These were distilled from an architecture audit whose goal
was: **add features without breaking existing behaviour.** Follow them for new code; they are not a
mandate to rewrite what already works.

## Layers (do not blur)

- **main** owns all game logic (fs, registry, process control, FFI). **renderer** is stateless UI.
- They talk **only over IPC**. The renderer never touches fs/registry; main never touches the DOM.
- Preload bridges are typed and sandboxed (`contextIsolation: true`, `sandbox: true`).

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

## Platform layer (OS-specific code)

Playhook runs on Windows and on the Steam Deck / Linux (Windows games via Proton/umu-launcher). **All
OS-specific behaviour lives behind the `Platform` bundle in `src/main/platform/`**, not scattered
`process.platform` checks. When you add code that differs per OS:

- Add the capability to an interface in `platform/types.ts` (the bundle is `ProcessMonitor`,
  `SteamLocator`, `GameProcessLauncher`, `SavePathResolver`, `PowerBackend`, `resolveInstallDir`).
- Implement it in **both** `platform/win32.ts` and `platform/linux.ts` (linux Proton helpers live in
  `platform/*.linux.ts` / `umu.ts`). `createPlatform(process.platform)` selects the bundle once at
  bootstrap; the rest of the code is platform-agnostic and receives it via DI (`ControllerDeps.platform`).
- **Never change Windows behaviour** when adding the Linux side — the win32 implementation must stay 1:1
  (the port's guiding invariant). Keep the OS-neutral fs/parse code (manifest, save-sync, `.acf`/VDF,
  drive-watcher) shared — don't fork it.
- Card format is a **Windows dictionary** on both OSes (`%APPDATA%`, `*.exe`, `install.type`); on Linux it
  is interpreted relative to the game's Wine prefix. A `game.json` must work unchanged on both platforms —
  Linux-only manifest fields (`winetricks`, `umuGameId`) are ignored on Windows, never rejected.
- Extract the pure bits (path/env/argv construction, `/proc` parsing, prefix mapping) into electron-free
  helpers and unit-test them (see `umu.ts`, `proc.ts`, `save-path.linux.ts`).

## Tests

- Runner: **vitest** (`npm test`). Tests live in `test/`, run in plain Node with **no electron**
  (`test/stubs/electron.ts` is aliased for the `electron` import — see `vitest.config.ts`).
- Testable = **pure / electron-free** modules. Modules that evaluate koffi FFI at import
  (`game-launcher.ts`) are not importable in Node — extract pure logic into a util (as `launch-args.ts`
  was) and test that.
- Prefer covering the risky, data-touching functions: manifest validation/anti-traversal, stats merge,
  save-sync retry, argument quoting.

## Tooling (all run in CI before build)

- `npm run typecheck` — strict `tsc`, no `any`, no non-null `!`.
- `npm run lint` — ESLint with type-aware rules (`no-floating-promises`, `no-misused-promises`,
  `strict-boolean-expressions`).
- `npm test` — vitest.
- `npm run format` / `format:check` — Prettier (available for new code; the existing hand-aligned
  files are intentionally not mass-reformatted).
