// Reading and validating the `game.json` manifest from the card (plan stage 3).
// The card is UNTRUSTED input (R7/P6): beyond the zod schema we validate path SEMANTICS —
// executable/heroImage/saveOnCard must live inside the card root (forbidding `..`
// and absolute paths), pcSavePath — only from an allowlist of prefixes:
// the %DOCUMENTS% known folder (resolved via the system Known Folder API, so it is
// language- and OneDrive-independent) plus the %APPDATA%/%LOCALAPPDATA%/%USERPROFILE% env vars.
import path from 'node:path';
import fse from 'fs-extra';
import { z } from 'zod';
import {
  MANIFEST_FILENAME,
  type GameManifest,
  type ResolvedManifest,
  type SfxName,
} from '../shared/types';

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z
    .string()
    .min(1)
    // id is used as a folder name on the PC (stats/pending-flush) — we forbid
    // separators and traversal so the card can't control paths outside its own folder.
    .regex(/^[A-Za-z0-9._-]+$/, 'id must match [A-Za-z0-9._-]')
    .refine((v) => v !== '.' && v !== '..', 'id must not be . or ..'),
  title: z.string().min(1),
  executable: z.string().min(1),
  args: z.array(z.string()).default([]),
  // Opt-in elevation: for .exe whose embedded manifest requires administrator (spawn would EACCES).
  runAsAdmin: z.boolean().default(false),
  // Optional game process image names for launcher/wrapper setups (see GameManifest.watchProcesses).
  // Each name is a bare `*.exe` file: no quotes, no path separators — both a hard constraint against
  // injection into the `tasklist` argv (execFile is shell-less, but we validate strictly anyway) and a
  // guard against accidental generic names. `.min(1)` rejects an empty array (defense in depth vs the
  // `?.length` branch in ipc). Names are compared case-insensitively (lower-cased) at match time.
  watchProcesses: z
    .array(z.string().regex(/^[A-Za-z0-9._ -]+\.exe$/i, 'watchProcesses entries must be a bare *.exe name'))
    .min(1)
    .max(16)
    .optional(),
  heroImage: z.string().min(1).optional(),
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

/** Resolves a card-relative path strictly inside its root. null = rejected. */
function resolveInside(root: string, relative: string): string | null {
  if (path.isAbsolute(relative)) return null;
  const resolved = path.resolve(root, relative);
  const back = path.relative(root, resolved);
  if (back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
    return null;
  }
  return resolved;
}

type ExpandResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly message: string };

/** Expands pcSavePath only from the allowed prefixes (%DOCUMENTS% + env vars), without traversal. */
function expandPcSavePath(input: string, env: ManifestEnv): ExpandResult {
  const match = /^%([A-Za-z]+)%[\\/]?(.*)$/.exec(input);
  if (match === null) {
    return {
      ok: false,
      message: 'pcSavePath must start with %DOCUMENTS%, %APPDATA%, %LOCALAPPDATA% or %USERPROFILE%',
    };
  }
  const prefix = (match[1] ?? '').toUpperCase();
  let base: string | undefined;
  if (prefix === 'DOCUMENTS') {
    base = env.documents;
  } else if ((ENV_PREFIXES as readonly string[]).includes(prefix)) {
    base = process.env[prefix];
  } else {
    return {
      ok: false,
      message: `pcSavePath prefix %${prefix}% is not allowed (use %DOCUMENTS%, %APPDATA%, %LOCALAPPDATA% or %USERPROFILE%)`,
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
  const where = first.path.join('.') || '(root)';
  return `${where}: ${first.message}`;
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

  const executablePath = resolveInside(root, raw.executable);
  if (executablePath === null) {
    return { ok: false, message: `executable path escapes card root: ${raw.executable}` };
  }
  if (!(await fse.pathExists(executablePath))) {
    return { ok: false, message: `executable not found: ${raw.executable}` };
  }

  let heroImagePath: string | undefined;
  if (raw.heroImage !== undefined) {
    const resolved = resolveInside(root, raw.heroImage);
    if (resolved === null) {
      return { ok: false, message: `heroImage path escapes card root: ${raw.heroImage}` };
    }
    heroImagePath = resolved;
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
      return { ok: false, message: `backgroundMusic path escapes card root: ${raw.backgroundMusic}` };
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
    cwd: path.dirname(executablePath),
    ...(heroImagePath !== undefined ? { heroImagePath } : {}),
    ...(saveOnCardPath !== undefined ? { saveOnCardPath } : {}),
    ...(pcSavePath !== undefined ? { pcSavePath } : {}),
    ...(soundPaths !== undefined ? { soundPaths } : {}),
    ...(backgroundMusicPath !== undefined ? { backgroundMusicPath } : {}),
  };
  return { ok: true, manifest };
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
