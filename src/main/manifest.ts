// Reading and validating the `game.json` manifest from the card.
// The card is UNTRUSTED input: beyond the zod schema we validate path SEMANTICS —
// executable/heroImage/saveOnCard must live inside the card root (forbidding `..`
// and absolute paths), pcSavePath — only from an allowlist of prefixes:
// the %DOCUMENTS% known folder (resolved via the system Known Folder API, so it is
// language- and OneDrive-independent), %LOCALLOW% (AppData\LocalLow, derived from %USERPROFILE% —
// common for Unity/Steam saves), plus the %APPDATA%/%LOCALAPPDATA%/%USERPROFILE% env vars.
import path from 'node:path';
import fse from 'fs-extra';
import { z } from 'zod';
import {
  MANIFEST_FILENAME,
  type GameManifest,
  type ManifestValidationIssue,
  type ConfigValidationResult,
  type ResolvedManifest,
  type SfxName,
} from '../shared/types';
import { translateIssueMessage, type Translator } from '../shared/i18n/index';
import { log } from './logger';

// Install-mode block (optional). When present, the card holds an installer and `executable` is
// resolved relative to the app-controlled install dir (see readManifest), not the card root.
const installSchema = z
  .object({
    installer: z.string().min(1),
    type: z.enum(['nsis', 'inno', 'custom']),
    // Run the installer elevated. Forbidden for `custom` (see the refine below).
    runAsAdmin: z.boolean().default(false),
    // For `custom`: the full argv with exactly one {dir} token. For nsis/inno: optional extra flags.
    args: z.array(z.string()).default([]),
    // Linux-only (Р7b): extra winetricks verbs/settings provisioned into the game's Wine prefix BEFORE the
    // installer runs, on top of the app's baseline set. Lets a card cover runtimes its installer needs
    // (e.g. a skinned Inno installer needing mfc42/gdiplus) or a setting like `vd=1920x1080`. Ignored on
    // Windows. Strictly validated (`=` allowed for `key=value` settings; shell-less execFile — defense in depth).
    winetricks: z
      .array(z.string().regex(/^[A-Za-z0-9_.=-]+$/, 'manifest.winetricksName'))
      .default([]),
  })
  // `custom` hands argv control to the card; running THAT elevated would escalate the attack
  // surface beyond the read-only tasklist we use today. The app builds nsis/inno args itself, so
  // elevated is fine there.
  // Custom messages are stored as dictionary KEYS (translated later at the issue-mapping points via
  // translateIssueMessage — see formatZodError / validateManifestText). The schema is module-private, so
  // it is never rebuilt per locale.
  .refine((v) => !(v.type === 'custom' && v.runAsAdmin), {
    message: 'manifest.installRunAsAdminCustom',
    path: ['runAsAdmin'],
  })
  // For `custom` the app substitutes the install dir into a single {dir} token — require exactly one,
  // so the path is always (and unambiguously) injected. nsis/inno build the dir flag themselves.
  .refine(
    (v) => v.type !== 'custom' || v.args.filter((arg) => arg.includes('{dir}')).length === 1,
    {
      message: 'manifest.installArgsDir',
      path: ['args'],
    },
  );

const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z
      .string()
      .min(1)
      // id is used as a folder name on the PC (stats/pending-flush) — we forbid
      // separators and traversal so the card can't control paths outside its own folder.
      .regex(/^[A-Za-z0-9._-]+$/, 'manifest.idPattern')
      .refine((v) => v !== '.' && v !== '..', 'manifest.idDots'),
    title: z.string().min(1),
    // Optional: present for a normal/install-mode game, absent in Steam mode (the superRefine below
    // enforces exactly one launch method).
    executable: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    // Opt-in elevation: for .exe whose embedded manifest requires administrator (spawn would EACCES).
    runAsAdmin: z.boolean().default(false),
    // Optional game process image names for launcher/wrapper setups (see GameManifest.watchProcesses).
    // Each name is a bare `*.exe` file: no quotes, no path separators — both a hard constraint against
    // injection into the `tasklist` argv (execFile is shell-less, but we validate strictly anyway) and a
    // guard against accidental generic names. `.min(1)` rejects an empty array (defense in depth vs the
    // `?.length` branch in ipc). Names are compared case-insensitively (lower-cased) at match time.
    watchProcesses: z
      .array(
        z
          .string()
          .regex(/^[A-Za-z0-9._ -]+\.exe$/i, 'manifest.watchProcessesName'),
      )
      .min(1)
      .max(16)
      .optional(),
    // A single card-relative path, or a non-empty array of them (multi-hero rotation). Normalized to an
    // array of resolved paths in readManifest. Backwards compatible: a lone string still works.
    heroImage: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    saveOnCard: z.string().min(1).optional(),
    pcSavePath: z.string().min(1).optional(),
    launchTimeoutSec: z.number().int().positive().default(30),
    // Max seconds a force-close waits for the game's processes to vanish before reporting a failure (the
    // wait ends early once they're gone). `.default(60)` so an older/partial file stays valid.
    killTimeoutSec: z.number().int().positive().default(60),
    sounds: z
      .object({
        play: z.string().min(1).optional(),
        navigate: z.string().min(1).optional(),
        button: z.string().min(1).optional(),
        back: z.string().min(1).optional(),
      })
      .optional(),
    backgroundMusic: z.string().min(1).optional(),
    // Linux-only (Р7b): extra winetricks verbs/settings provisioned into the game's Wine prefix BEFORE the
    // game launches, on top of the app's baseline set — a runtime a game needs on a bare Proton prefix
    // (e.g. `d3dx9`) OR a winetricks SETTING like `vd=1920x1080` (virtual desktop — fixes old games that
    // crash on a fullscreen display-mode change). Ignored on Windows. Strictly validated (`=` allowed for
    // `key=value` settings; the `winetricks` argv is shell-less execFile, so this is defense-in-depth).
    winetricks: z
      .array(z.string().regex(/^[A-Za-z0-9_.=-]+$/, 'manifest.winetricksName'))
      .default([]),
    install: installSchema.optional(),
    // Steam mode: a pointer to a Steam app by appid (no game files on the card). Mutually exclusive with
    // install/executable and requires watchProcesses — enforced by the superRefine below.
    steam: z.object({ appid: z.number().int().positive() }).optional(),
  })
  // Exactly one launch method, with its invariants. Steam mode is a separate backend from install
  // mode, so we forbid the card installer/executable/elevation there and require watchProcesses
  // (steam:// returns instantly with no pid of its own — the game can only be tracked by process name).
  .superRefine((v, ctx) => {
    if (v.steam !== undefined) {
      if (v.install !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['install'],
          message: 'manifest.installWithSteam',
        });
      }
      if (v.executable !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['executable'],
          message: 'manifest.executableWithSteam',
        });
      }
      if (v.runAsAdmin) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['runAsAdmin'],
          message: 'manifest.runAsAdminWithSteam',
        });
      }
      if (v.watchProcesses === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['watchProcesses'],
          message: 'manifest.watchProcessesRequired',
        });
      }
    } else if (v.executable === undefined) {
      // Non-steam game: an executable is mandatory (its meaning depends on install mode — see readManifest).
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['executable'],
        message: 'manifest.executableRequired',
      });
    }
  });

/** The sound slots resolved inside the card root (order is stable for iteration). */
const SFX_NAMES: readonly SfxName[] = ['play', 'navigate', 'button', 'back'];

export type ManifestResult =
  | { readonly ok: true; readonly manifest: ResolvedManifest }
  | { readonly ok: false; readonly message: string };

/** Result of reading ALL games from a card (a card carries one game.json holding an object or an array). */
export type ManifestsResult =
  | { readonly ok: true; readonly manifests: ResolvedManifest[] }
  | { readonly ok: false; readonly message: string };

/**
 * Normalizes the top-level game.json value into a list of raw game entries: a lone object → [object]
 * (legacy single-game — still fully valid), a NON-EMPTY array → its items (multi-game). Anything else
 * (a primitive, null, or an empty array) is a STRUCTURAL error (fatal — the card can't be read at all).
 */
function normalizeManifestInput(
  parsed: unknown,
  t: Translator,
): { readonly ok: true; readonly items: readonly unknown[] } | { readonly ok: false; readonly message: string } {
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return { ok: false, message: t('manifest.emptyArray') };
    return { ok: true, items: parsed };
  }
  if (typeof parsed === 'object' && parsed !== null) {
    return { ok: true, items: [parsed] };
  }
  return { ok: false, message: t('manifest.notObjectOrArray') };
}

/** External path bases the manifest may resolve that are not plain env vars. */
export interface ManifestEnv {
  /**
   * The user's Documents known folder, resolved in main via app.getPath('documents').
   * This goes through the system Known Folder API — the same one the game uses — so it
   * matches the game's real save location regardless of UI language or OneDrive redirection.
   */
  readonly documents: string;
  /** Translator for user-facing validation messages (the wrapper is translated, identifiers stay latin). */
  readonly t: Translator;
}

// Env-var prefixes allowed in pcSavePath (resolved from process.env).
const ENV_PREFIXES = ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE'] as const;

/** Resolves a card-relative path strictly inside its root. null = rejected. Exported for unit tests. */
export function resolveInside(root: string, relative: string): string | null {
  if (path.isAbsolute(relative)) return null;
  const resolved = path.resolve(root, relative);
  const back = path.relative(root, resolved);
  if (back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
    return null;
  }
  return resolved;
}

type ExpandResult =
  { readonly ok: true; readonly value: string } | { readonly ok: false; readonly message: string };

// Human-readable list of accepted prefixes (kept in sync with the resolution below) for error messages.
const ALLOWED_PREFIXES_HELP = '%DOCUMENTS%, %APPDATA%, %LOCALAPPDATA%, %LOCALLOW% or %USERPROFILE%';

/**
 * Expands pcSavePath only from the allowed prefixes (%DOCUMENTS%/%LOCALLOW% + env vars), without traversal.
 * Exported for unit tests.
 */
export function expandPcSavePath(input: string, env: ManifestEnv): ExpandResult {
  const { t } = env;
  const match = /^%([A-Za-z]+)%[\\/]?(.*)$/.exec(input);
  if (match === null) {
    return {
      ok: false,
      message: t('manifest.pcSavePathPrefix', { prefixes: ALLOWED_PREFIXES_HELP }),
    };
  }
  const prefix = (match[1] ?? '').toUpperCase();
  let base: string | undefined;
  if (prefix === 'DOCUMENTS') {
    base = env.documents;
  } else if (prefix === 'LOCALLOW') {
    // AppData\LocalLow has no env var (it's the FOLDERID_LocalAppDataLow known folder) — derive it from
    // %USERPROFILE%. Very common for Unity/Steam games (Valheim, Cities: Skylines, …) whose saves live
    // there. Without this, the only way to reach LocalLow was %USERPROFILE%\AppData\LocalLow\… — and
    // %APPDATA% (which is AppData\Roaming) does NOT cover it.
    const home = process.env['USERPROFILE'];
    base = home !== undefined && home !== '' ? path.join(home, 'AppData', 'LocalLow') : undefined;
  } else if ((ENV_PREFIXES as readonly string[]).includes(prefix)) {
    base = process.env[prefix];
  } else {
    return {
      ok: false,
      message: t('manifest.pcSavePathNotAllowed', { prefix, prefixes: ALLOWED_PREFIXES_HELP }),
    };
  }
  if (base === undefined || base === '') {
    return { ok: false, message: t('manifest.pcSavePathUnavailable', { prefix }) };
  }
  const rest = match[2] ?? '';
  const segments = rest.split(/[\\/]+/).filter((s) => s.length > 0);
  if (segments.includes('..')) {
    return { ok: false, message: t('manifest.pcSavePathNoTraversal') };
  }
  const resolved = path.resolve(base, ...segments);
  const back = path.relative(base, resolved);
  if (back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
    return { ok: false, message: t('manifest.pcSavePathEscapes') };
  }
  return { ok: true, value: resolved };
}

/**
 * Reverse of expandPcSavePath: turns an ABSOLUTE folder (from the Configure form's folder dialog) back
 * into a `%PREFIX%/…` pcSavePath, or null when it lives under none of the allowed bases (so it cannot be
 * expressed and the caller rejects it). Bases are tried most-specific-first (longest base wins) so a path
 * under %APPDATA% is not mislabelled with the broader %USERPROFILE%. Exported for unit tests.
 */
export function absoluteToPcSavePath(absolute: string, env: ManifestEnv): string | null {
  const home = process.env['USERPROFILE'];
  const candidates: Array<{ readonly prefix: string; readonly base: string | undefined }> = [
    { prefix: 'DOCUMENTS', base: env.documents },
    { prefix: 'LOCALLOW', base: home !== undefined && home !== '' ? path.join(home, 'AppData', 'LocalLow') : undefined },
    { prefix: 'APPDATA', base: process.env['APPDATA'] },
    { prefix: 'LOCALAPPDATA', base: process.env['LOCALAPPDATA'] },
    { prefix: 'USERPROFILE', base: home },
  ];
  const bases = candidates
    .filter((c): c is { prefix: string; base: string } => c.base !== undefined && c.base !== '')
    .sort((a, b) => b.base.length - a.base.length);
  for (const { prefix, base } of bases) {
    const rel = path.relative(base, absolute);
    if (rel === '') return `%${prefix}%`;
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return `%${prefix}%/${rel.split(path.sep).join('/')}`;
    }
  }
  return null;
}

function formatZodError(error: z.ZodError, t: Translator): string {
  const first = error.issues[0];
  if (first === undefined) return t('manifest.invalid');
  const joined = first.path.join('.');
  const where = joined.length > 0 ? joined : '(root)';
  // A schema refine stores a MessageKey; a structural zod message is already localized via z.config.
  return `${where}: ${translateIssueMessage(first.message, t)}`;
}

type InstallResolveResult =
  | {
      readonly ok: true;
      readonly install: NonNullable<ResolvedManifest['install']>;
      /** `<installDir>/<executable>` — the effective launch target (may not exist yet). */
      readonly executablePath: string;
    }
  | { readonly ok: false; readonly message: string };

/**
 * The app-controlled install directory in BOTH views (Р7). On win32 they are identical
 * (`%LOCALAPPDATA%\playhook\games\<id>`); on linux they diverge:
 * - `hostDir` — the real filesystem path inside the game's Wine prefix
 *   (`<pfx>/drive_c/playhook/games/<id>`): every fs op and the resolved `executable` live under it;
 * - `installerDir` — the SAME location as the installer sees it under Wine (`C:\playhook\games\<id>`),
 *   fed to the silent dir-arg (`/DIR=` / `/D=`).
 */
export interface InstallDir {
  readonly hostDir: string;
  readonly installerDir: string;
}

/**
 * Platform install-dir resolution, injected into readManifests (Р7): maps a game `id` to both views of
 * its app-controlled install dir, or null when install mode is unsupported on this platform/config
 * (win32 with `%LOCALAPPDATA%` unset). `id` is already validated as a safe single path segment.
 */
export type InstallDirResolver = (id: string) => InstallDir | null;

/**
 * Resolves the install-mode block: verifies the installer exists on the card, derives the
 * app-controlled install dir via the platform `resolveInstallDir` (win32 `%LOCALAPPDATA%\…`; linux the
 * game's Wine prefix — Р7), and resolves `executable` RELATIVE to its HOST view (traversal forbidden,
 * existence NOT checked — its absence is exactly the "not installed" state).
 */
async function resolveInstall(
  root: string,
  id: string,
  executable: string,
  install: NonNullable<GameManifest['install']>,
  t: Translator,
  resolveInstallDir: InstallDirResolver,
): Promise<InstallResolveResult> {
  const installerPath = resolveInside(root, install.installer);
  if (installerPath === null) {
    return { ok: false, message: t('manifest.installerEscapes', { path: install.installer }) };
  }
  if (!(await fse.pathExists(installerPath))) {
    return { ok: false, message: t('manifest.installerNotFound', { path: install.installer }) };
  }

  // The install dir is platform-specific (Р7): win32 derives `%LOCALAPPDATA%\playhook\games\<id>`;
  // linux places it inside the game's Wine prefix. null → install mode is unsupported here (e.g.
  // `%LOCALAPPDATA%` absent) and the card is rejected, exactly as the pre-port Windows-only check did.
  const dirs = resolveInstallDir(id);
  if (dirs === null) {
    return { ok: false, message: t('manifest.installNeedsLocalAppData') };
  }

  // `executable` resolves relative to the HOST-view install dir — traversal forbidden, but existence is
  // NOT checked here (it appears only after a successful install).
  const executablePath = resolveInside(dirs.hostDir, executable);
  if (executablePath === null) {
    return { ok: false, message: t('manifest.executableEscapesInstall', { path: executable }) };
  }

  return {
    ok: true,
    executablePath,
    install: {
      installerPath,
      type: install.type,
      runAsAdmin: install.runAsAdmin,
      args: install.args,
      winetricks: install.winetricks,
      dir: dirs.hostDir,
      installerDir: dirs.installerDir,
    },
  };
}

/**
 * Reads and fully validates ALL games on the card. `game.json` may hold a single object (legacy
 * single-game — behaves exactly as before) or a non-empty array of game objects (multi-game). Reads the
 * file once, normalizes to a list, and resolves each entry.
 *
 * Failure policy (see the plan): a STRUCTURAL problem (unreadable file, top-level not an object/array,
 * empty array) is fatal. A single game that fails to resolve (e.g. a normal-mode executable missing on
 * disk) is SKIPPED with a breadcrumb so one broken entry doesn't kill a multi-game card; if NONE resolve,
 * the card is fatal with the first skip reason (so a single-game card keeps its precise message — BC).
 * Duplicate ids are fatal (ids key PC storage — a collision would corrupt stats/saves).
 */
export async function readManifests(
  root: string,
  env: ManifestEnv,
  resolveInstallDir: InstallDirResolver,
): Promise<ManifestsResult> {
  const { t } = env;
  const manifestPath = path.join(root, MANIFEST_FILENAME);

  let parsedJson: unknown;
  try {
    parsedJson = await fse.readJson(manifestPath);
  } catch (cause) {
    return {
      ok: false,
      message: t('errors.cannotReadManifest', { file: MANIFEST_FILENAME, cause: describe(cause) }),
    };
  }

  const normalized = normalizeManifestInput(parsedJson, t);
  if (!normalized.ok) return { ok: false, message: normalized.message };

  const manifests: ResolvedManifest[] = [];
  let firstError: string | null = null;
  for (const [index, item] of normalized.items.entries()) {
    const resolved = await resolveOne(item, root, env, resolveInstallDir);
    if (!resolved.ok) {
      if (firstError === null) firstError = resolved.message;
      log.warn(`[manifest] skipping game #${index}: ${resolved.message}`);
      continue;
    }
    manifests.push(resolved.manifest);
  }
  if (manifests.length === 0) {
    // No game resolved → fatal, like a missing manifest. Keep the first (usually only) reason so a
    // single-game card surfaces its precise error ("executable not found: …") exactly as before.
    return { ok: false, message: firstError ?? t('manifest.invalid') };
  }
  const seen = new Set<string>();
  for (const manifest of manifests) {
    if (seen.has(manifest.raw.id)) {
      return { ok: false, message: t('manifest.duplicateId', { id: manifest.raw.id }) };
    }
    seen.add(manifest.raw.id);
  }
  return { ok: true, manifests };
}

/**
 * Resolves and validates ONE already-read game entry (raw JSON value) against the schema + path
 * semantics, exactly as the single-game reader did. `env` carries known-folder bases resolved in main
 * (e.g. Documents) for pcSavePath. Also checks that the executable exists (an edge case).
 */
async function resolveOne(
  rawParsed: unknown,
  root: string,
  env: ManifestEnv,
  resolveInstallDir: InstallDirResolver,
): Promise<ManifestResult> {
  const { t } = env;
  const parsed = manifestSchema.safeParse(rawParsed);
  if (!parsed.success) {
    return { ok: false, message: formatZodError(parsed.error, t) };
  }
  const raw: GameManifest = parsed.data;

  // Critical branch: the meaning of `executable` depends on the mode. Keep the three paths
  // explicit so the normal flow is provably untouched.
  let executablePath: string;
  let cwd: string;
  let installResolved: ResolvedManifest['install'];
  let steamResolved: ResolvedManifest['steam'];
  if (raw.steam !== undefined) {
    // Steam mode: there is no card executable to resolve. executablePath/cwd are placeholders ('')
    // that are NEVER read — every consumer branches on `steam` first (see ResolvedManifest). The
    // card-relative assets (heroImage/sounds/music/saveOnCard) are resolved below as usual.
    executablePath = '';
    cwd = '';
    steamResolved = { appid: raw.steam.appid };
  } else if (raw.install === undefined) {
    // Normal game: `executable` is card-relative and MUST exist on the card (unchanged behaviour).
    // The schema guarantees `executable` is present here (non-steam ⇒ required); guard defensively.
    if (raw.executable === undefined) {
      return { ok: false, message: t('manifest.executableRequired') };
    }
    const resolved = resolveInside(root, raw.executable);
    if (resolved === null) {
      return { ok: false, message: t('manifest.executableEscapes', { path: raw.executable }) };
    }
    if (!(await fse.pathExists(resolved))) {
      return { ok: false, message: t('manifest.executableNotFound', { path: raw.executable }) };
    }
    executablePath = resolved;
    cwd = path.dirname(executablePath);
  } else {
    if (raw.executable === undefined) {
      return { ok: false, message: t('manifest.executableRequired') };
    }
    const resolvedInstall = await resolveInstall(
      root,
      raw.id,
      raw.executable,
      raw.install,
      t,
      resolveInstallDir,
    );
    if (!resolvedInstall.ok) {
      return { ok: false, message: resolvedInstall.message };
    }
    installResolved = resolvedInstall.install;
    executablePath = resolvedInstall.executablePath;
    cwd = path.dirname(executablePath);
  }

  let heroImagePaths: string[] | undefined;
  if (raw.heroImage !== undefined) {
    // Normalize the string|string[] union into an array, then resolve each entry inside the card root.
    const rawHeroImages = typeof raw.heroImage === 'string' ? [raw.heroImage] : raw.heroImage;
    const resolvedHeroImages: string[] = [];
    for (const rel of rawHeroImages) {
      const resolved = resolveInside(root, rel);
      if (resolved === null) {
        return { ok: false, message: t('manifest.heroEscapes', { path: rel }) };
      }
      resolvedHeroImages.push(resolved);
    }
    // The schema guarantees a non-empty array, but guard so an empty result stays undefined (as before).
    if (resolvedHeroImages.length > 0) heroImagePaths = resolvedHeroImages;
  }

  let saveOnCardPath: string | undefined;
  if (raw.saveOnCard !== undefined) {
    const resolved = resolveInside(root, raw.saveOnCard);
    if (resolved === null) {
      return { ok: false, message: t('manifest.saveOnCardEscapes', { path: raw.saveOnCard }) };
    }
    saveOnCardPath = resolved;
  }

  let pcSavePath: string | undefined;
  if (raw.pcSavePath !== undefined) {
    const expanded = expandPcSavePath(raw.pcSavePath, env);
    if (!expanded.ok) {
      return { ok: false, message: expanded.message };
    }
    pcSavePath = expanded.value;
  }

  let soundPaths: Record<string, string> | undefined;
  if (raw.sounds !== undefined) {
    const resolvedSounds: Record<string, string> = {};
    for (const name of SFX_NAMES) {
      const rel = raw.sounds[name];
      if (rel === undefined) continue;
      const resolved = resolveInside(root, rel);
      if (resolved === null) {
        return { ok: false, message: t('manifest.soundEscapes', { name, path: rel }) };
      }
      resolvedSounds[name] = resolved;
    }
    if (Object.keys(resolvedSounds).length > 0) soundPaths = resolvedSounds;
  }

  let backgroundMusicPath: string | undefined;
  if (raw.backgroundMusic !== undefined) {
    const resolved = resolveInside(root, raw.backgroundMusic);
    if (resolved === null) {
      return {
        ok: false,
        message: t('manifest.backgroundMusicEscapes', { path: raw.backgroundMusic }),
      };
    }
    backgroundMusicPath = resolved;
  }

  // Sync only makes sense if BOTH sides are set: the copy on the card and
  // the write location on the PC. If only one is set, the card was prepared incorrectly.
  if ((pcSavePath === undefined) !== (saveOnCardPath === undefined)) {
    return {
      ok: false,
      message: t('manifest.savePairing'),
    };
  }

  const manifest: ResolvedManifest = {
    raw,
    root,
    executablePath,
    cwd,
    ...(heroImagePaths !== undefined ? { heroImagePaths } : {}),
    ...(saveOnCardPath !== undefined ? { saveOnCardPath } : {}),
    ...(pcSavePath !== undefined ? { pcSavePath } : {}),
    ...(soundPaths !== undefined ? { soundPaths } : {}),
    ...(backgroundMusicPath !== undefined ? { backgroundMusicPath } : {}),
    ...(installResolved !== undefined ? { install: installResolved } : {}),
    ...(steamResolved !== undefined ? { steam: steamResolved } : {}),
  };
  return { ok: true, manifest };
}

// ── Static (fs-free) validation for the Configure-game editor ────────────────
// The Configure window edits raw game.json text and must give a verdict WITHOUT touching the disk:
// syntax + zod schema + the semantic checks that don't need a filesystem (anti-traversal on every
// card-relative path, the pcSavePath prefix allowlist, and the saveOnCard↔pcSavePath pairing). The
// FS-dependent checks (executable/installer/hero must EXIST) stay in readManifest — a blank card with
// an installer template is statically valid even though its files aren't there yet ("card in the making").

// A stable, absolute base for the anti-traversal check. Its value is irrelevant to the verdict:
// resolveInside rejects `..`-escapes and absolute paths regardless of the base (see resolveInside).
const VALIDATION_ROOT = path.resolve('__playhook_validation_root__');

// pcSavePath prefixes accepted by expandPcSavePath. Kept in sync with that function's resolution.
const PCSAVE_PREFIXES = ['DOCUMENTS', 'LOCALLOW', ...ENV_PREFIXES] as const;

/**
 * Validates the pcSavePath PREFIX and traversal WITHOUT resolving it against the real system (env-var
 * availability is a runtime/FS concern → left to readManifest's expandPcSavePath). Returns an error
 * message or null when statically fine.
 */
function validatePcSavePathStatic(input: string, t: Translator): string | null {
  const match = /^%([A-Za-z]+)%[\\/]?(.*)$/.exec(input);
  if (match === null) return t('manifest.pcSavePathPrefix', { prefixes: ALLOWED_PREFIXES_HELP });
  const prefix = (match[1] ?? '').toUpperCase();
  if (!(PCSAVE_PREFIXES as readonly string[]).includes(prefix)) {
    return t('manifest.pcSavePathNotAllowed', { prefix, prefixes: ALLOWED_PREFIXES_HELP });
  }
  const rest = match[2] ?? '';
  const segments = rest.split(/[\\/]+/).filter((s) => s.length > 0);
  if (segments.includes('..')) return t('manifest.pcSavePathNoTraversal');
  return null;
}

/** Adds a traversal issue for a card-relative path if it escapes the root. `label` is a field identifier
 * (kept latin — a JSON field name, not translatable text); the wrapper message is translated. */
function pushIfEscapes(
  issues: ManifestValidationIssue[],
  fieldPath: string,
  relative: string,
  t: Translator,
  label = 'path',
): void {
  if (resolveInside(VALIDATION_ROOT, relative) === null) {
    issues.push({ path: fieldPath, message: t('manifest.pathEscapes', { label, path: relative }) });
  }
}

/**
 * Semantic (fs-free) checks for ONE already-schema-parsed game, appended to `issues`. `prefix` is ''
 * for a single-object manifest (field paths stay bare, e.g. `heroImage` — so the one-game form maps them
 * exactly) and `games.<i>.` for an array element (so the multi-game form can attribute/strip them).
 *
 * Beyond the traversal / pcSave / pairing checks that mirror readManifest, this enforces the multi-game
 * POLICY that every game must carry ≥1 heroImage. That is intentionally editor-only (it gates Save) and
 * NOT in the runtime readManifests path, which stays lenient (a hero-less legacy card still loads via the
 * wallpaper fallback) — see the plan, decision 3.
 */
function pushGameSemanticIssues(
  issues: ManifestValidationIssue[],
  raw: GameManifest,
  t: Translator,
  prefix: string,
): void {
  const field = (name: string): string => `${prefix}${name}`;
  if (raw.executable !== undefined)
    pushIfEscapes(issues, field('executable'), raw.executable, t, 'executable');
  if (raw.install !== undefined) {
    pushIfEscapes(issues, field('install.installer'), raw.install.installer, t, 'installer');
  }
  if (raw.heroImage !== undefined) {
    const heroes = typeof raw.heroImage === 'string' ? [raw.heroImage] : raw.heroImage;
    for (const [index, rel] of heroes.entries()) {
      const name = typeof raw.heroImage === 'string' ? 'heroImage' : `heroImage.${index}`;
      pushIfEscapes(issues, field(name), rel, t, 'heroImage');
    }
  } else {
    // Multi-game policy: a hero image is required for every game (editor-only gate — see above).
    issues.push({ path: field('heroImage'), message: t('manifest.heroRequired') });
  }
  if (raw.saveOnCard !== undefined)
    pushIfEscapes(issues, field('saveOnCard'), raw.saveOnCard, t, 'saveOnCard');
  if (raw.backgroundMusic !== undefined) {
    pushIfEscapes(issues, field('backgroundMusic'), raw.backgroundMusic, t, 'backgroundMusic');
  }
  if (raw.sounds !== undefined) {
    for (const name of SFX_NAMES) {
      const rel = raw.sounds[name];
      if (rel !== undefined) pushIfEscapes(issues, field(`sounds.${name}`), rel, t, `sound "${name}"`);
    }
  }
  if (raw.pcSavePath !== undefined) {
    const message = validatePcSavePathStatic(raw.pcSavePath, t);
    if (message !== null) issues.push({ path: field('pcSavePath'), message });
  }
  // Sync needs BOTH sides (mirrors readManifest): a lone side means the card was prepared incorrectly.
  if ((raw.pcSavePath === undefined) !== (raw.saveOnCard === undefined)) {
    issues.push({
      path: field(raw.pcSavePath === undefined ? 'pcSavePath' : 'saveOnCard'),
      message: t('manifest.savePairing'),
    });
  }
}

/**
 * Static, filesystem-free validation of manifest TEXT (Configure-game window). Accepts a single game
 * object (legacy — bare field paths) OR a non-empty array of games (each element validated, paths
 * prefixed with `games.<i>.`). Two-phase by design per game: a schema failure short-circuits that game's
 * semantic checks (zod's superRefine issues only appear after the base schema passes). The schema stays
 * module-private — only this pure function is exported, so there is a single source of truth.
 */
export function validateManifestText(text: string, t: Translator): ConfigValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (cause) {
    return {
      ok: false,
      issues: [{ path: '(root)', message: t('manifest.invalidJson', { cause: describe(cause) }) }],
    };
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return { ok: false, issues: [{ path: '(root)', message: t('manifest.emptyArray') }] };
    }
  } else if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, issues: [{ path: '(root)', message: t('manifest.notObjectOrArray') }] };
  }
  const isArray = Array.isArray(parsed);
  const items: readonly unknown[] = isArray ? (parsed as readonly unknown[]) : [parsed];

  const issues: ManifestValidationIssue[] = [];
  const idIndex = new Map<string, number>();
  items.forEach((item, i) => {
    const prefix = isArray ? `games.${i}.` : '';
    const rootPath = isArray ? `games.${i}` : '(root)';
    const result = manifestSchema.safeParse(item);
    if (!result.success) {
      for (const issue of result.error.issues) {
        const joined = issue.path.join('.');
        // A refine stores a MessageKey; a structural zod message is already localized via z.config.
        issues.push({
          path: joined.length > 0 ? `${prefix}${joined}` : rootPath,
          message: translateIssueMessage(issue.message, t),
        });
      }
      return; // can't run semantic checks without parsed data
    }
    const raw = result.data;
    pushGameSemanticIssues(issues, raw, t, prefix);
    // Duplicate id across games (array only; a single object is trivially unique). ids key PC storage.
    if (isArray) {
      if (idIndex.has(raw.id)) {
        issues.push({ path: `games.${i}.id`, message: t('manifest.duplicateId', { id: raw.id }) });
      } else {
        idIndex.set(raw.id, i);
      }
    }
  });

  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}

/**
 * The manifest's JSON Schema, handed to the Configure editor for field-name completion and hover docs.
 * `superRefine`/`refine` rules (mode exclusivity, traversal, pcSavePath prefixes) are unrepresentable in
 * JSON Schema and are silently dropped here — the authoritative verdict stays with validateManifestText.
 * `unrepresentable: 'any'` keeps the conversion from throwing on anything else it can't express.
 *
 * `io: 'input'` is critical: the editor validates what the USER TYPES (before defaults), so fields with a
 * `.default()` (args, runAsAdmin, launchTimeoutSec, killTimeoutSec) must NOT be `required`. Without it the editor's linter
 * flagged "args is missing" while validateManifestText (which zod-parses and fills the defaults) reported
 * the very same text as valid — the two verdicts disagreed.
 *
 * Wrapped in `oneOf` so the editor accepts BOTH a single game object (legacy) and a non-empty array of
 * games (multi-game), matching what validateManifestText / readManifests accept.
 */
export function manifestJsonSchema(): unknown {
  const objectSchema = z.toJSONSchema(manifestSchema, { unrepresentable: 'any', io: 'input' });
  return { oneOf: [objectSchema, { type: 'array', items: objectSchema, minItems: 1 }] };
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
