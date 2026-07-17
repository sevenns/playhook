// Pure (DOM-free, electron-free) bridge between the Configure form and game.json TEXT — the single source
// of truth stays the manifest text (see plan R2), so the form only ever converts to/from a string that the
// existing config:save pipeline writes verbatim. Testable in vitest.
//
// Two escape hatches keep the round-trip lossless and honest:
//  • `rest`    — UNKNOWN keys (top-level and per-block) that zod would silently strip. The form must not
//                drop them, so parse stashes them and serialize merges them back.
//  • `corrupt` — KNOWN keys whose value has the wrong TYPE (e.g. `args: "x"`). We cannot "leniently take
//                empty": validation runs on the SERIALIZED text, and a field with a default/optional would
//                make the error vanish (→ green status, silent loss on Save). Instead the raw value is kept
//                and written back verbatim until the user edits that field — so the server validator sees
//                the original error, Save stays blocked, and nothing is lost. Granularity is the top-level
//                key (a bad `sounds.play` marks the whole `sounds` block corrupt).

/** The three mutually-exclusive launch methods (mirrors the manifest superRefine). */
export type LaunchMode = 'executable' | 'installer' | 'steam';

/**
 * Derives a manifest `id` from a game's display name for the Configure form: accents stripped, lowercased,
 * every run of non-alphanumerics collapsed to a single dash, trimmed. `Clair Obscur: Expedition 33` →
 * `clair-obscur-expedition-33`. The result is always a valid id (`[A-Za-z0-9._-]`) or empty — a name with
 * no Latin/digit characters (e.g. all-Cyrillic) yields '', and the user types the id by hand (the schema
 * forbids non-latin ids anyway). Pure.
 */
export function slugifyId(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // drop the combining marks NFKD split off (e-acute -> e + accent)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // any run of non-alphanumerics → a single dash
    .replace(/^-+|-+$/g, ''); // trim leading/trailing dashes
}

/**
 * install.type enum. `copy` is NOT an installer family: it means "move the game to the PC" and is driven
 * by a checkbox inside the Executable mode, not by the installer type dropdown (which only offers the
 * three real families). See `copyToPc` / `copyInstall` on ManifestFormModel.
 */
export type InstallType = 'nsis' | 'inno' | 'custom' | 'copy';

/** The installer families the type dropdown offers — everything but `copy` (see InstallType). */
export type InstallerFamily = Exclude<InstallType, 'copy'>;

/** The `sounds` block as form state: one string per slot ('' = empty) plus this block's unknown keys. */
export interface SoundsModel {
  readonly play: string;
  readonly navigate: string;
  readonly button: string;
  readonly back: string;
  readonly rest: Readonly<Record<string, unknown>>;
}

/** The `install` block as form state (numbers/booleans typed; args as a list) plus its unknown keys. */
export interface InstallModel {
  readonly installer: string;
  readonly type: InstallType;
  readonly runAsAdmin: boolean;
  readonly args: readonly string[];
  /** Extra winetricks verbs provisioned into the prefix before the installer runs (Linux; Р7b). */
  readonly winetricks: readonly string[];
  readonly rest: Readonly<Record<string, unknown>>;
}

/** The `steam` block as form state (appid kept as numeric TEXT — the control's value is a string). */
export interface SteamModel {
  readonly appid: string;
  readonly rest: Readonly<Record<string, unknown>>;
}

/**
 * All form fields, including the sections hidden by the current launch mode (they live here until
 * serialization, so switching modes and back restores what was typed — see plan R5). Numbers are kept as
 * TEXT (`launchTimeoutSec`, `steam.appid`) because the Fluent text-input value is a string; serialization
 * parses them.
 */
export interface ManifestFormModel {
  readonly launchMode: LaunchMode;
  readonly id: string;
  readonly title: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly runAsAdmin: boolean;
  readonly watchProcesses: readonly string[];
  readonly heroImage: readonly string[];
  readonly saveOnCard: string;
  readonly pcSavePath: string;
  readonly launchTimeoutSec: string;
  readonly killTimeoutSec: string;
  readonly sounds: SoundsModel;
  readonly backgroundMusic: string;
  /** Extra winetricks verbs provisioned into the prefix before the GAME launches (Linux; Р7b). */
  readonly winetricks: readonly string[];
  /** umu GAMEID for launch — a Steam appid or custom UMU_ID (Linux; Р7i). '' = default `umu-default`. */
  readonly umuGameId: string;
  /** The `install` block for INSTALLER mode (types nsis/inno/custom). Never holds `copy`. */
  readonly install: InstallModel;
  /**
   * "Move game to PC" — a checkbox inside Executable mode. On: the manifest emits `install` with
   * `type: 'copy'`, where `copyInstall.installer` is the game DIRECTORY on the card to copy.
   */
  readonly copyToPc: boolean;
  /**
   * The `install` block for the copy checkbox — a SECOND, independent slot rather than a flat field, for
   * two reasons: the block's unknown keys (`rest`) must survive the round-trip like every other block's,
   * and keeping it apart from `install` means toggling Installer ↔ Executable+checkbox never mixes the
   * two modes' input (in particular `type: 'copy'` can never surface in the installer type dropdown).
   * `type` is always `copy`.
   */
  readonly copyInstall: InstallModel;
  readonly steam: SteamModel;
}

export type ParseFormResult =
  | {
      readonly ok: true;
      readonly model: ManifestFormModel;
      /** Unknown top-level keys, preserved across the round-trip. */
      readonly rest: Readonly<Record<string, unknown>>;
      /** Known top-level keys with an invalid value type, kept raw and written back verbatim. */
      readonly corrupt: Readonly<Record<string, unknown>>;
      /** The source carried blocks for more than one launch mode (steam + install/executable) — the form
       * activates one and a banner warns that saving drops the others (plan R5). */
      readonly mixed: boolean;
    }
  | { readonly ok: false; readonly message: string };

/** The known top-level manifest keys the form owns. Exported so a unit test can guard it against
 * `manifestJsonSchema()` properties — a new schema field must be added here (else it silently lands in
 * `rest`). Order here is NOT the serialization order (see formModelToText). */
export const KNOWN_MANIFEST_KEYS: readonly string[] = [
  'schemaVersion',
  'id',
  'title',
  'executable',
  'args',
  'runAsAdmin',
  'watchProcesses',
  'heroImage',
  'saveOnCard',
  'pcSavePath',
  'launchTimeoutSec',
  'killTimeoutSec',
  'sounds',
  'backgroundMusic',
  'winetricks',
  'umuGameId',
  'install',
  'steam',
];

const KNOWN_KEY_SET = new Set(KNOWN_MANIFEST_KEYS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function emptySounds(): SoundsModel {
  return { play: '', navigate: '', button: '', back: '', rest: {} };
}

function emptyInstall(): InstallModel {
  return { installer: '', type: 'nsis', runAsAdmin: false, args: [], winetricks: [], rest: {} };
}

/** The copy slot's pristine state: same block, pinned to `copy` (its type is never user-editable). */
function emptyCopyInstall(): InstallModel {
  return { installer: '', type: 'copy', runAsAdmin: false, args: [], winetricks: [], rest: {} };
}

function emptySteam(): SteamModel {
  return { appid: '', rest: {} };
}

/** A pristine, all-empty form model (executable mode) — used for a blank drive and the empty baseline of
 * the template-replace confirm (plan R8). */
export function emptyFormModel(): ManifestFormModel {
  return {
    launchMode: 'executable',
    id: '',
    title: '',
    executable: '',
    args: [],
    runAsAdmin: false,
    watchProcesses: [],
    heroImage: [],
    saveOnCard: '',
    pcSavePath: '',
    launchTimeoutSec: '',
    killTimeoutSec: '',
    sounds: emptySounds(),
    backgroundMusic: '',
    winetricks: [],
    umuGameId: '',
    install: emptyInstall(),
    copyToPc: false,
    copyInstall: emptyCopyInstall(),
    steam: emptySteam(),
  };
}

/** Parses a `sounds` object; null = a known slot had the wrong type (→ the whole block is corrupt). */
function parseSounds(source: Record<string, unknown>): SoundsModel | null {
  const slots: { play: string; navigate: string; button: string; back: string } = {
    play: '',
    navigate: '',
    button: '',
    back: '',
  };
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === 'play' || key === 'navigate' || key === 'button' || key === 'back') {
      if (typeof value !== 'string') return null;
      slots[key] = value;
    } else {
      rest[key] = value;
    }
  }
  return { ...slots, rest };
}

/** Parses an `install` object; null = a known field had the wrong type/enum (→ the block is corrupt). */
function parseInstall(source: Record<string, unknown>): InstallModel | null {
  let installer = '';
  let type: InstallType = 'nsis';
  let runAsAdmin = false;
  let args: readonly string[] = [];
  let winetricks: readonly string[] = [];
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    switch (key) {
      case 'installer':
        if (typeof value !== 'string') return null;
        installer = value;
        break;
      case 'type':
        if (value !== 'nsis' && value !== 'inno' && value !== 'custom' && value !== 'copy') return null;
        type = value;
        break;
      case 'runAsAdmin':
        if (typeof value !== 'boolean') return null;
        runAsAdmin = value;
        break;
      case 'args':
        if (!isStringArray(value)) return null;
        args = value;
        break;
      case 'winetricks':
        if (!isStringArray(value)) return null;
        winetricks = value;
        break;
      default:
        rest[key] = value;
    }
  }
  return { installer, type, runAsAdmin, args, winetricks, rest };
}

/** Parses a `steam` object; null = appid had the wrong type (→ the block is corrupt). */
function parseSteam(source: Record<string, unknown>): SteamModel | null {
  let appid = '';
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === 'appid') {
      if (typeof value !== 'number') return null;
      appid = String(value);
    } else {
      rest[key] = value;
    }
  }
  return { appid, rest };
}

/**
 * Parses manifest TEXT into a form model. ok:false only for a syntax error or a non-object top-level (the
 * form cannot represent those — the caller keeps the JSON tab, plan R4). A syntactically valid but
 * schema-invalid manifest still parses: wrong-typed known fields go to `corrupt` and are written back
 * verbatim so the server validator still reports them.
 */
export function textToFormModel(text: string): ParseFormResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
  }
  return valueToFormResult(parsed);
}

/**
 * Parses an already-JSON-parsed VALUE (one game object) into a form model. Split out of textToFormModel
 * so the multi-game wrapper (textToGames) can reuse it per array element without re-parsing JSON.
 */
function valueToFormResult(parsed: unknown): ParseFormResult {
  if (!isRecord(parsed)) {
    return { ok: false, message: 'game.json must be a JSON object' };
  }
  const source = parsed;
  const rest: Record<string, unknown> = {};
  const corrupt: Record<string, unknown> = {};

  // Unknown top-level keys → rest (verbatim).
  for (const [key, value] of Object.entries(source)) {
    if (!KNOWN_KEY_SET.has(key)) rest[key] = value;
  }

  // A known key present with the wrong type → corrupt (raw). `has` tracks presence for launch-mode logic.
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(source, key);

  // schemaVersion is fixed at 1 and re-emitted from the model; only a PRESENT wrong value is corrupt.
  if (has('schemaVersion') && source['schemaVersion'] !== 1) corrupt['schemaVersion'] = source['schemaVersion'];

  const readString = (key: string): string => {
    if (!has(key)) return '';
    const value = source[key];
    if (typeof value === 'string') return value;
    corrupt[key] = value;
    return '';
  };

  const id = readString('id');
  const title = readString('title');
  const executable = readString('executable');
  const saveOnCard = readString('saveOnCard');
  const pcSavePath = readString('pcSavePath');
  const backgroundMusic = readString('backgroundMusic');
  const umuGameId = readString('umuGameId');

  let runAsAdmin = false;
  if (has('runAsAdmin')) {
    if (typeof source['runAsAdmin'] === 'boolean') runAsAdmin = source['runAsAdmin'];
    else corrupt['runAsAdmin'] = source['runAsAdmin'];
  }

  let args: readonly string[] = [];
  if (has('args')) {
    if (isStringArray(source['args'])) args = source['args'];
    else corrupt['args'] = source['args'];
  }

  let watchProcesses: readonly string[] = [];
  if (has('watchProcesses')) {
    if (isStringArray(source['watchProcesses'])) watchProcesses = source['watchProcesses'];
    else corrupt['watchProcesses'] = source['watchProcesses'];
  }

  let winetricks: readonly string[] = [];
  if (has('winetricks')) {
    if (isStringArray(source['winetricks'])) winetricks = source['winetricks'];
    else corrupt['winetricks'] = source['winetricks'];
  }

  let heroImage: readonly string[] = [];
  if (has('heroImage')) {
    const value = source['heroImage'];
    if (typeof value === 'string') heroImage = [value];
    else if (isStringArray(value)) heroImage = value;
    else corrupt['heroImage'] = value;
  }

  let launchTimeoutSec = '';
  if (has('launchTimeoutSec')) {
    if (typeof source['launchTimeoutSec'] === 'number') launchTimeoutSec = String(source['launchTimeoutSec']);
    else corrupt['launchTimeoutSec'] = source['launchTimeoutSec'];
  }

  let killTimeoutSec = '';
  if (has('killTimeoutSec')) {
    if (typeof source['killTimeoutSec'] === 'number') killTimeoutSec = String(source['killTimeoutSec']);
    else corrupt['killTimeoutSec'] = source['killTimeoutSec'];
  }

  let sounds = emptySounds();
  if (has('sounds')) {
    const value = source['sounds'];
    const parsedSounds = isRecord(value) ? parseSounds(value) : null;
    if (parsedSounds !== null) sounds = parsedSounds;
    else corrupt['sounds'] = value;
  }

  // One `install` block in the file feeds one of TWO slots, picked by its type: `copy` belongs to the
  // Executable mode's checkbox, everything else to Installer mode. A corrupt block feeds neither and
  // falls through to `corrupt` — it still selects Installer mode below (presence decides), as before.
  let install = emptyInstall();
  let copyInstall = emptyCopyInstall();
  let copyToPc = false;
  if (has('install')) {
    const value = source['install'];
    const parsedInstall = isRecord(value) ? parseInstall(value) : null;
    if (parsedInstall === null) corrupt['install'] = value;
    else if (parsedInstall.type === 'copy') {
      copyInstall = parsedInstall;
      copyToPc = true;
    } else install = parsedInstall;
  }

  let steam = emptySteam();
  if (has('steam')) {
    const value = source['steam'];
    const parsedSteam = isRecord(value) ? parseSteam(value) : null;
    if (parsedSteam !== null) steam = parsedSteam;
    else corrupt['steam'] = value;
  }

  // Launch mode: steam > install > executable (plan R5). Presence (not validity) decides — a corrupt
  // block still selects its mode, and its raw value is re-emitted from `corrupt` so the error shows.
  // `install` with `type: 'copy'` is the exception: it is Executable mode with the checkbox on, so it
  // must NOT be shown as an Installer (the user never chose that mode).
  const launchMode: LaunchMode = has('steam')
    ? 'steam'
    : has('install') && !copyToPc
      ? 'installer'
      : 'executable';
  const mixed = has('steam') && (has('install') || has('executable'));

  const model: ManifestFormModel = {
    launchMode,
    id,
    title,
    executable,
    args,
    runAsAdmin,
    watchProcesses,
    heroImage,
    saveOnCard,
    pcSavePath,
    launchTimeoutSec,
    killTimeoutSec,
    sounds,
    backgroundMusic,
    winetricks,
    umuGameId,
    install,
    copyToPc,
    copyInstall,
    steam,
  };
  return { ok: true, model, rest, corrupt, mixed };
}

export function launchModeOf(model: ManifestFormModel): LaunchMode {
  return model.launchMode;
}

/** Drops empty/whitespace-only entries from a dynamic list before serialization (plan edge cases). */
function nonEmpty(list: readonly string[]): string[] {
  return list.filter((item) => item.trim() !== '');
}

/** A numeric text field → a JSON value: undefined when blank (→ omitted), a number when parseable, else
 * the raw trimmed string so the validator reports "expected number" instead of silently dropping it. */
function numericValue(text: string): number | string | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : trimmed;
}

const DEFAULT_LAUNCH_TIMEOUT = 30;
const DEFAULT_KILL_TIMEOUT = 60;

/** A timeout field → value or undefined (omit when blank OR equal to its schema default). */
function timeoutValue(text: string, defaultValue: number): number | string | undefined {
  const value = numericValue(text);
  if (value === undefined) return undefined;
  if (typeof value === 'number' && value === defaultValue) return undefined;
  return value;
}

function buildInstall(install: InstallModel): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (install.installer !== '') out.installer = install.installer;
  out.type = install.type;
  if (install.runAsAdmin) out.runAsAdmin = true;
  const args = nonEmpty(install.args);
  if (args.length > 0) out.args = args;
  const winetricks = nonEmpty(install.winetricks);
  if (winetricks.length > 0) out.winetricks = winetricks;
  for (const [key, value] of Object.entries(install.rest)) out[key] = value;
  return out;
}

function buildSteam(steam: SteamModel): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const appid = numericValue(steam.appid);
  if (appid !== undefined) out.appid = appid;
  for (const [key, value] of Object.entries(steam.rest)) out[key] = value;
  return out;
}

function buildSounds(sounds: SoundsModel): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (sounds.play !== '') out.play = sounds.play;
  if (sounds.navigate !== '') out.navigate = sounds.navigate;
  if (sounds.button !== '') out.button = sounds.button;
  if (sounds.back !== '') out.back = sounds.back;
  for (const [key, value] of Object.entries(sounds.rest)) out[key] = value;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Serializes a form model back to manifest TEXT (2-space indent, trailing newline). Only the ACTIVE launch
 * mode's fields are written (writing hidden modes would trip the superRefine exclusivity). Fields equal to
 * their schema default (args [], runAsAdmin false, launchTimeoutSec 30, killTimeoutSec 60) are omitted so the manifest stays
 * minimal. `corrupt` (raw known keys) and `rest` (unknown keys) are overlaid last, verbatim — corrupt wins
 * over the model value (an unedited broken field) and preserves the original validation error.
 */
export function formModelToText(
  model: ManifestFormModel,
  rest: Readonly<Record<string, unknown>>,
  corrupt: Readonly<Record<string, unknown>>,
): string {
  return `${JSON.stringify(buildManifestObject(model, rest, corrupt), null, 2)}\n`;
}

/**
 * Builds ONE game's manifest object (not yet stringified) from a form model. Split out of formModelToText
 * so the multi-game wrapper (gamesToText) can assemble an array of them. See formModelToText's doc for the
 * per-field omission rules and the corrupt/rest overlay semantics.
 */
function buildManifestObject(
  model: ManifestFormModel,
  rest: Readonly<Record<string, unknown>>,
  corrupt: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  out.schemaVersion = 1;
  if (model.id !== '') out.id = model.id;
  if (model.title !== '') out.title = model.title;

  if (model.launchMode === 'steam') {
    out.steam = buildSteam(model.steam);
  } else {
    if (model.executable !== '') out.executable = model.executable;
    const args = nonEmpty(model.args);
    if (args.length > 0) out.args = args;
    if (model.runAsAdmin) out.runAsAdmin = true;
    // Both modes emit an `install` block, from their own slot: Installer mode the real installer, the
    // Executable checkbox a `type: 'copy'` one (its `installer` being the game directory to copy).
    if (model.launchMode === 'installer') out.install = buildInstall(model.install);
    else if (model.copyToPc) out.install = buildInstall(model.copyInstall);
    // Game-launch prefix provisioning (Linux; Р7b) — applies to our own prefix (executable/installer
    // modes), not steam (which runs in Steam's compatdata).
    const winetricks = nonEmpty(model.winetricks);
    if (winetricks.length > 0) out.winetricks = winetricks;
    // umu GAMEID for the launch (Linux; Р7i) — same scope: our own umu-run, not steam://.
    if (model.umuGameId !== '') out.umuGameId = model.umuGameId;
  }

  const watch = nonEmpty(model.watchProcesses);
  if (watch.length > 0) out.watchProcesses = watch;

  const hero = nonEmpty(model.heroImage);
  if (hero.length === 1) out.heroImage = hero[0];
  else if (hero.length > 1) out.heroImage = hero;

  if (model.saveOnCard !== '') out.saveOnCard = model.saveOnCard;
  if (model.pcSavePath !== '') out.pcSavePath = model.pcSavePath;

  const sounds = buildSounds(model.sounds);
  if (sounds !== undefined) out.sounds = sounds;
  if (model.backgroundMusic !== '') out.backgroundMusic = model.backgroundMusic;

  const timeout = timeoutValue(model.launchTimeoutSec, DEFAULT_LAUNCH_TIMEOUT);
  if (timeout !== undefined) out.launchTimeoutSec = timeout;

  const killTimeout = timeoutValue(model.killTimeoutSec, DEFAULT_KILL_TIMEOUT);
  if (killTimeout !== undefined) out.killTimeoutSec = killTimeout;

  // Overlay raw corrupt values (a broken known key wins over the model until the user edits it) then the
  // unknown top-level keys — both verbatim, so the round-trip is lossless and errors stay visible.
  for (const [key, value] of Object.entries(corrupt)) out[key] = value;
  for (const [key, value] of Object.entries(rest)) out[key] = value;

  return out;
}

// ── Multi-game wrapper (a card can carry several games) ────────────────────────
// game.json is a single game object (legacy) OR a non-empty array of them. The form edits ONE game at a
// time; these two pure functions wrap/unwrap the array so the form's per-game model is reused verbatim.

/** One game's serializable form state (model + preserved unknown/corrupt keys). */
export interface GameFormState {
  readonly model: ManifestFormModel;
  readonly rest: Readonly<Record<string, unknown>>;
  readonly corrupt: Readonly<Record<string, unknown>>;
}

export type ParseGamesResult =
  | {
      readonly ok: true;
      /** One parse result per game (each may individually be ok:false — a non-object element). */
      readonly games: readonly ParseFormResult[];
      /** Whether the source was an array (>1 games serialize back as an array; see gamesToText). */
      readonly isArray: boolean;
    }
  | { readonly ok: false; readonly message: string };

/**
 * Parses manifest TEXT into a LIST of per-game parse results. A single object → a one-element list
 * (isArray:false); a non-empty array → one result per element (isArray:true). ok:false only for a syntax
 * error or a top-level that is neither an object nor a non-empty array (the caller keeps the JSON tab).
 */
export function textToGames(text: string): ParseGamesResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return { ok: false, message: 'the games array must not be empty' };
    return { ok: true, isArray: true, games: parsed.map(valueToFormResult) };
  }
  if (isRecord(parsed)) {
    return { ok: true, isArray: false, games: [valueToFormResult(parsed)] };
  }
  return { ok: false, message: 'game.json must be a game object or a non-empty array of games' };
}

/**
 * Serializes a LIST of game form states back to manifest TEXT: exactly one game → a single object (legacy
 * shape, maximal backwards compatibility), more than one → an array (see the plan, decision 2). An empty
 * list is not expected (a card always has ≥1 game); it falls back to a single empty object for safety.
 */
export function gamesToText(games: readonly GameFormState[]): string {
  const objects = games.map((g) => buildManifestObject(g.model, g.rest, g.corrupt));
  const value: unknown = objects.length === 1 ? objects[0] : objects;
  return `${JSON.stringify(value, null, 2)}\n`;
}
