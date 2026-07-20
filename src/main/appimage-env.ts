// Cleaning the AppImage's fingerprints out of the environment before spawning a SYSTEM program.
//
// An AppImage's AppRun rewrites the environment to point inside its own mount (`/tmp/.mount_Playho<rnd>`)
// so the bundled Electron finds its libraries. Every child process inherits that — and a system binary
// launched with those values loads the wrong libraries and misbehaves.
//
// This is not theoretical. The Game Mode daemon spawned `steam steam://rungameid/…` and Steam answered:
//
//     steam-runtime-steam-remote: Steam is not running: No such device or address
//
// …while Steam was plainly running. The tile then sat on "Launching…" forever. `steam` is a shell script
// that execs helpers from the Steam runtime; with our `LD_LIBRARY_PATH` it could not talk to the client.
//
// AppRun does NOT save the originals (verified on a Deck — no `*_ORIG`, no `APPIMAGE_ORIGINAL_*` in the
// daemon's /proc/<pid>/environ), so there is nothing to restore: the only correct move is to drop the
// entries that point inside the mount and keep the rest of the session's environment intact — HOME,
// XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS especially, since that is how `steam` finds the client.

/** Variables AppRun invents; a system child has no business seeing them. */
const APPIMAGE_OWN_VARS = ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD'] as const;

/**
 * Variables that must not leak into ANY child, independent of the AppImage. `ELECTRON_RUN_AS_NODE` is set
 * on the daemon's own unit; inherited by a child that happens to be Electron-based, it would silently turn
 * that app into a bare Node process.
 */
const NON_INHERITABLE_VARS = ['ELECTRON_RUN_AS_NODE'] as const;

/** Path-list variables, cleaned entry by entry rather than dropped whole. */
const PATH_LIST_VARS = ['PATH', 'XDG_DATA_DIRS', 'XDG_CONFIG_DIRS', 'LD_LIBRARY_PATH'] as const;

function isInside(value: string, appDir: string): boolean {
  return value === appDir || value.startsWith(`${appDir}/`);
}

/**
 * Returns a copy of `env` safe to hand to a system program.
 *
 * Outside an AppImage (`APPDIR` unset) only the non-inheritable variables are removed, so a dev run and a
 * Windows build behave exactly as before.
 */
export function systemEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = { ...env };
  for (const name of NON_INHERITABLE_VARS) delete cleaned[name];

  const appDir = env['APPDIR'];
  if (appDir === undefined || appDir === '') return cleaned;

  for (const name of APPIMAGE_OWN_VARS) delete cleaned[name];

  for (const [name, value] of Object.entries(cleaned)) {
    if (value === undefined) continue;
    if ((PATH_LIST_VARS as readonly string[]).includes(name)) {
      // Keep the system entries, drop the ones pointing into the mount. An empty result means the whole
      // variable was the AppImage's doing (LD_LIBRARY_PATH is typically exactly that) → remove it, since
      // an empty PATH-list is not the same as an absent one.
      const kept = value.split(':').filter((entry) => entry !== '' && !isInside(entry, appDir));
      if (kept.length === 0) delete cleaned[name];
      else cleaned[name] = kept.join(':');
      continue;
    }
    // A single path into the mount (GSETTINGS_SCHEMA_DIR, QT_PLUGIN_PATH, …): nothing to salvage.
    if (isInside(value, appDir)) delete cleaned[name];
  }

  return cleaned;
}
