// Reading and validating the `game.json` manifest from the card (plan stage 3).
// The card is UNTRUSTED input (R7/P6): beyond the zod schema we validate path SEMANTICS —
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
  })
  // F3: `custom` hands argv control to the card; running THAT elevated would escalate the attack
  // surface beyond the read-only tasklist we use today. The app builds nsis/inno args itself, so
  // elevated is fine there.
  .refine((v) => !(v.type === 'custom' && v.runAsAdmin), {
    message: 'install.runAsAdmin is not allowed with type "custom"',
    path: ['runAsAdmin'],
  })
  // For `custom` the app substitutes the install dir into a single {dir} token — require exactly one,
  // so the path is always (and unambiguously) injected. nsis/inno build the dir flag themselves.
  .refine(
    (v) => v.type !== 'custom' || v.args.filter((arg) => arg.includes('{dir}')).length === 1,
    {
      message:
        'install.args (type "custom") must contain exactly one token with a {dir} placeholder',
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
      .regex(/^[A-Za-z0-9._-]+$/, 'id must match [A-Za-z0-9._-]')
      .refine((v) => v !== '.' && v !== '..', 'id must not be . or ..'),
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
          .regex(/^[A-Za-z0-9._ -]+\.exe$/i, 'watchProcesses entries must be a bare *.exe name'),
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
    sounds: z
      .object({
        play: z.string().min(1).optional(),
        navigate: z.string().min(1).optional(),
        button: z.string().min(1).optional(),
        back: z.string().min(1).optional(),
      })
      .optional(),
    backgroundMusic: z.string().min(1).optional(),
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
          message: 'install is not allowed together with steam',
        });
      }
      if (v.executable !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['executable'],
          message: 'executable is not allowed in steam mode',
        });
      }
      if (v.runAsAdmin) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['runAsAdmin'],
          message: 'runAsAdmin is not allowed in steam mode',
        });
      }
      if (v.watchProcesses === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['watchProcesses'],
          message: 'watchProcesses is required in steam mode',
        });
      }
    } else if (v.executable === undefined) {
      // Non-steam game: an executable is mandatory (its meaning depends on install mode — see readManifest).
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['executable'],
        message: 'executable is required',
      });
    }
  });

/** The sound slots resolved inside the card root (order is stable for iteration). */
const SFX_NAMES: readonly SfxName[] = ['play', 'navigate', 'button', 'back'];

export type ManifestResult =
  | { readonly ok: true; readonly manifest: ResolvedManifest }
  | { readonly ok: false; readonly message: string };

/** External path bases the manifest may resolve that are not plain env vars. */
export interface ManifestEnv {
  /**
   * The user's Documents known folder, resolved in main via app.getPath('documents').
   * This goes through the system Known Folder API — the same one the game uses — so it
   * matches the game's real save location regardless of UI language or OneDrive redirection.
   */
  readonly documents: string;
}

// Env-var prefixes allowed in pcSavePath (resolved from process.env).
const ENV_PREFIXES = ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE'] as const;

/** Resolves a card-relative path strictly inside its root. null = rejected. Exported for unit tests (C1). */
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
 * Exported for unit tests (C1).
 */
export function expandPcSavePath(input: string, env: ManifestEnv): ExpandResult {
  const match = /^%([A-Za-z]+)%[\\/]?(.*)$/.exec(input);
  if (match === null) {
    return {
      ok: false,
      message: `pcSavePath must start with ${ALLOWED_PREFIXES_HELP}`,
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
      message: `pcSavePath prefix %${prefix}% is not allowed (use ${ALLOWED_PREFIXES_HELP})`,
    };
  }
  if (base === undefined || base === '') {
    return { ok: false, message: `pcSavePath prefix %${prefix}% is not available on this system` };
  }
  const rest = match[2] ?? '';
  const segments = rest.split(/[\\/]+/).filter((s) => s.length > 0);
  if (segments.includes('..')) {
    return { ok: false, message: 'pcSavePath must not contain ".."' };
  }
  const resolved = path.resolve(base, ...segments);
  const back = path.relative(base, resolved);
  if (back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
    return { ok: false, message: 'pcSavePath escapes its base directory' };
  }
  return { ok: true, value: resolved };
}

function formatZodError(error: z.ZodError): string {
  const first = error.issues[0];
  if (first === undefined) return 'invalid manifest';
  const joined = first.path.join('.');
  const where = joined.length > 0 ? joined : '(root)';
  return `${where}: ${first.message}`;
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
 * Resolves the install-mode block: verifies the installer exists on the card, derives the
 * app-controlled install dir `%LOCALAPPDATA%\playhook\games\<id>` (Windows-only — install mode is
 * impossible without it, like runAsAdmin off-Windows), and resolves `executable` RELATIVE to that
 * dir (traversal forbidden, existence NOT checked — its absence is exactly the "not installed" state).
 */
async function resolveInstall(
  root: string,
  id: string,
  executable: string,
  install: NonNullable<GameManifest['install']>,
): Promise<InstallResolveResult> {
  const installerPath = resolveInside(root, install.installer);
  if (installerPath === null) {
    return { ok: false, message: `installer path escapes card root: ${install.installer}` };
  }
  if (!(await fse.pathExists(installerPath))) {
    return { ok: false, message: `installer not found: ${install.installer}` };
  }

  // The install root is derived straight from the env var — the same mechanism pcSavePath uses —
  // so nothing is added to ManifestEnv. %LOCALAPPDATA% is per-user, per-machine, non-roaming and
  // needs no admin rights. Absent (non-Windows / unusual setups) → install mode is rejected.
  const localAppData = process.env['LOCALAPPDATA'];
  if (localAppData === undefined || localAppData === '') {
    return { ok: false, message: 'install mode requires %LOCALAPPDATA% (Windows only)' };
  }
  // `id` is already constrained to [A-Za-z0-9._-] (no separators / not . or ..) → a safe folder name.
  const dir = path.join(localAppData, 'playhook', 'games', id);

  // `executable` resolves relative to the install dir — traversal forbidden, but existence is NOT
  // checked here (it appears only after a successful install).
  const executablePath = resolveInside(dir, executable);
  if (executablePath === null) {
    return { ok: false, message: `executable path escapes install dir: ${executable}` };
  }

  return {
    ok: true,
    executablePath,
    install: {
      installerPath,
      type: install.type,
      runAsAdmin: install.runAsAdmin,
      args: install.args,
      dir,
    },
  };
}

/**
 * Reads and fully validates the manifest at the card root.
 * `env` carries known-folder bases resolved in main (e.g. Documents) for pcSavePath.
 * Also checks that the executable exists (an edge case from the plan).
 */
export async function readManifest(root: string, env: ManifestEnv): Promise<ManifestResult> {
  const manifestPath = path.join(root, MANIFEST_FILENAME);

  let parsedJson: unknown;
  try {
    parsedJson = await fse.readJson(manifestPath);
  } catch (cause) {
    return { ok: false, message: `cannot read ${MANIFEST_FILENAME}: ${describe(cause)}` };
  }

  const parsed = manifestSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return { ok: false, message: formatZodError(parsed.error) };
  }
  const raw: GameManifest = parsed.data;

  // E5 (critical branch): the meaning of `executable` depends on the mode. Keep the three paths
  // explicit so the normal flow is provably untouched (G2).
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
      return { ok: false, message: 'executable is required' };
    }
    const resolved = resolveInside(root, raw.executable);
    if (resolved === null) {
      return { ok: false, message: `executable path escapes card root: ${raw.executable}` };
    }
    if (!(await fse.pathExists(resolved))) {
      return { ok: false, message: `executable not found: ${raw.executable}` };
    }
    executablePath = resolved;
    cwd = path.dirname(executablePath);
  } else {
    if (raw.executable === undefined) {
      return { ok: false, message: 'executable is required' };
    }
    const resolvedInstall = await resolveInstall(root, raw.id, raw.executable, raw.install);
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
        return { ok: false, message: `heroImage path escapes card root: ${rel}` };
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
      return { ok: false, message: `saveOnCard path escapes card root: ${raw.saveOnCard}` };
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
        return { ok: false, message: `sound "${name}" path escapes card root: ${rel}` };
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
        message: `backgroundMusic path escapes card root: ${raw.backgroundMusic}`,
      };
    }
    backgroundMusicPath = resolved;
  }

  // Sync only makes sense if BOTH sides are set (section 3): the copy on the card and
  // the write location on the PC. If only one is set, the card was prepared incorrectly.
  if ((pcSavePath === undefined) !== (saveOnCardPath === undefined)) {
    return {
      ok: false,
      message: 'saveOnCard and pcSavePath must be set together or both omitted',
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
function validatePcSavePathStatic(input: string): string | null {
  const match = /^%([A-Za-z]+)%[\\/]?(.*)$/.exec(input);
  if (match === null) return `pcSavePath must start with ${ALLOWED_PREFIXES_HELP}`;
  const prefix = (match[1] ?? '').toUpperCase();
  if (!(PCSAVE_PREFIXES as readonly string[]).includes(prefix)) {
    return `pcSavePath prefix %${prefix}% is not allowed (use ${ALLOWED_PREFIXES_HELP})`;
  }
  const rest = match[2] ?? '';
  const segments = rest.split(/[\\/]+/).filter((s) => s.length > 0);
  if (segments.includes('..')) return 'pcSavePath must not contain ".."';
  return null;
}

/** Adds a traversal issue for a card-relative path if it escapes the root. */
function pushIfEscapes(
  issues: ManifestValidationIssue[],
  fieldPath: string,
  relative: string,
  label = 'path',
): void {
  if (resolveInside(VALIDATION_ROOT, relative) === null) {
    issues.push({ path: fieldPath, message: `${label} escapes the card root: ${relative}` });
  }
}

/**
 * Static, filesystem-free validation of manifest TEXT (Configure-game window). Two-phase by design:
 * a schema failure short-circuits (zod's superRefine issues only appear after the base schema passes),
 * so the caller may see structural errors first and semantic ones on a later pass. The schema stays
 * module-private — only this pure function is exported, so there is a single source of truth.
 */
export function validateManifestText(text: string): ConfigValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (cause) {
    return { ok: false, issues: [{ path: '(root)', message: `invalid JSON: ${describe(cause)}` }] };
  }

  const result = manifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((issue): ManifestValidationIssue => {
      const joined = issue.path.join('.');
      return { path: joined.length > 0 ? joined : '(root)', message: issue.message };
    });
    return { ok: false, issues };
  }

  const raw = result.data;
  const issues: ManifestValidationIssue[] = [];

  if (raw.executable !== undefined)
    pushIfEscapes(issues, 'executable', raw.executable, 'executable');
  if (raw.install !== undefined) {
    pushIfEscapes(issues, 'install.installer', raw.install.installer, 'installer');
  }
  if (raw.heroImage !== undefined) {
    const heroes = typeof raw.heroImage === 'string' ? [raw.heroImage] : raw.heroImage;
    for (const [index, rel] of heroes.entries()) {
      const field = typeof raw.heroImage === 'string' ? 'heroImage' : `heroImage.${index}`;
      pushIfEscapes(issues, field, rel, 'heroImage');
    }
  }
  if (raw.saveOnCard !== undefined)
    pushIfEscapes(issues, 'saveOnCard', raw.saveOnCard, 'saveOnCard');
  if (raw.backgroundMusic !== undefined) {
    pushIfEscapes(issues, 'backgroundMusic', raw.backgroundMusic, 'backgroundMusic');
  }
  if (raw.sounds !== undefined) {
    for (const name of SFX_NAMES) {
      const rel = raw.sounds[name];
      if (rel !== undefined) pushIfEscapes(issues, `sounds.${name}`, rel, `sound "${name}"`);
    }
  }
  if (raw.pcSavePath !== undefined) {
    const message = validatePcSavePathStatic(raw.pcSavePath);
    if (message !== null) issues.push({ path: 'pcSavePath', message });
  }
  // Sync needs BOTH sides (mirrors readManifest): a lone side means the card was prepared incorrectly.
  if ((raw.pcSavePath === undefined) !== (raw.saveOnCard === undefined)) {
    issues.push({
      path: raw.pcSavePath === undefined ? 'pcSavePath' : 'saveOnCard',
      message: 'saveOnCard and pcSavePath must be set together or both omitted',
    });
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}

/**
 * The manifest's JSON Schema, handed to the Configure editor for field-name completion and hover docs.
 * `superRefine`/`refine` rules (mode exclusivity, traversal, pcSavePath prefixes) are unrepresentable in
 * JSON Schema and are silently dropped here — the authoritative verdict stays with validateManifestText.
 * `unrepresentable: 'any'` keeps the conversion from throwing on anything else it can't express.
 *
 * `io: 'input'` is critical: the editor validates what the USER TYPES (before defaults), so fields with a
 * `.default()` (args, runAsAdmin, launchTimeoutSec) must NOT be `required`. Without it the editor's linter
 * flagged "args is missing" while validateManifestText (which zod-parses and fills the defaults) reported
 * the very same text as valid — the two verdicts disagreed.
 */
export function manifestJsonSchema(): unknown {
  return z.toJSONSchema(manifestSchema, { unrepresentable: 'any', io: 'input' });
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
