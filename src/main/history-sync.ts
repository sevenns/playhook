// Applying edits made from the HISTORY onto the card that carries the game — the step that runs at the
// very start of an insertion, before the manifests are read (see the plan, Р2/Р3/Р9).
//
// Everything here is guarded, because it writes to somebody's card:
//
//   * which side wins is decided by content, not clocks (history-config.ts `decideConfigSync`);
//   * a slot whose TITLE no longer matches the snapshot is a different game under the same id — a
//     foreign card. Its edits are dropped, not written;
//   * the assembled text is re-validated as a card manifest, and the executable/installer the applied
//     slot names must actually exist there: the editor's validation is textual and cannot know that the
//     exe was renamed on another PC, and a game that fails to resolve is fatal for the WHOLE card;
//   * the staged asset copy is idempotent — a file already on the card under the target name and with
//     the same bytes counts as copied, so an apply that broke off half-way does not litter the card with
//     `-2`, `-3` duplicates on every retry.
//
// Nothing here is fatal to the insertion: a card that refuses the write (read-only, EBUSY, yanked) keeps
// its own version, the edits stay pending, and the card loads exactly as it would have.
import path from 'node:path';
import { createHash } from 'node:crypto';
import fse from 'fs-extra';
import { MANIFEST_FILENAME } from '../shared/types';
import type { Translator } from '../shared/i18n';
import { validateManifestText } from './manifest';
import type { ManifestValidationIssue } from '../shared/types';
import { writeFileAtomicEnsuringDir } from './json-store';
import {
  decideConfigSync,
  issuesIntroducedBy,
  remapSlotAssets,
  replaceGameSlot,
  slotHash,
  slotsById,
  type GameSlot,
} from './history-config';
import type { LibraryStore } from './library-store';
import { log } from './logger';
import { describe } from './util';

/** Where a staged asset lands on the card — the same `assets/` convention the PC library writes. */
const CARD_ASSETS_DIRNAME = 'assets';

export interface HistorySyncDeps {
  readonly library: LibraryStore;
  readonly t: Translator;
}

/** What the sync did, for the caller to notify about and to hand on to the history copy. */
export interface HistorySyncResult {
  /** Titles whose edits reached the card. */
  readonly applied: readonly string[];
  /** Titles whose edits were dropped in favour of the card's own version. */
  readonly discarded: readonly string[];
  /** The card's slots as they stand AFTER the sync — the snapshot the history copy must store. */
  readonly slots: ReadonlyMap<string, GameSlot>;
  /** The manifest text as it was BEFORE the sync, when (and only when) the sync rewrote the file. */
  readonly textBefore: string | null;
}

const NOTHING: HistorySyncResult = {
  applied: [],
  discarded: [],
  slots: new Map(),
  textBefore: null,
};

/**
 * Runs the whole matrix for one card and writes the result ONCE. Returns what happened; it never throws
 * — an insertion must proceed whatever the card thinks of being written to.
 */
export async function syncHistoryConfig(
  root: string,
  deps: HistorySyncDeps,
): Promise<HistorySyncResult> {
  const manifestPath = path.join(root, MANIFEST_FILENAME);
  let text: string;
  try {
    text = await fse.readFile(manifestPath, 'utf8');
  } catch (cause) {
    log.warn(`[history-sync] cannot read the card manifest:`, describe(cause));
    return NOTHING;
  }
  const slots = slotsById(text);
  if (slots.size === 0) return { ...NOTHING, slots };

  const cardMtimeMs = await mtimeOf(manifestPath);
  const applied: string[] = [];
  const discarded: string[] = [];
  const nextSlots = new Map(slots);
  let nextText = text;
  let rewrote = false;

  for (const [id, cardSlot] of slots) {
    const entry = deps.library.entry(id);
    if (entry === null || entry.configuredAt === null) continue;
    const decision = decideConfigSync({
      historyDirty: true,
      cardChanged: slotHash(cardSlot) !== entry.cardSlotHash,
      cardMtimeMs,
      configuredAtMs: Date.parse(entry.configuredAt),
    });
    if (decision === 'none') continue;
    if (decision === 'take-card') {
      log.info(`[history-sync] id=${id}: the card's version is newer — dropping the pending edits`);
      logLoser(id, await deps.library.readEditedSlot(id));
      await deps.library.dropEdits(id);
      discarded.push(entry.title);
      continue;
    }

    const outcome = await applyOne({ id, root, cardSlot, text: nextText, deps });
    if (outcome.kind === 'skipped') continue;
    if (outcome.kind === 'refused') {
      logLoser(id, await deps.library.readEditedSlot(id));
      await deps.library.dropEdits(id);
      discarded.push(entry.title);
      continue;
    }
    nextText = outcome.text;
    nextSlots.set(id, outcome.slot);
    rewrote = true;
    applied.push(titleOf(outcome.slot) ?? entry.title);
  }

  if (!rewrote) return { ...NOTHING, applied, discarded, slots: nextSlots };

  try {
    await writeFileAtomicEnsuringDir(manifestPath, nextText);
  } catch (cause) {
    // A card that cannot be written to is not an error the user has to act on: the edits stay pending and
    // ride along to the next insertion, exactly as they would have if the card had never shown up.
    log.warn(`[history-sync] cannot write the card manifest — the edits stay pending:`, describe(cause));
    return { ...NOTHING, discarded, slots };
  }
  for (const [id, slot] of nextSlots) {
    if (slotHash(slot) === slotHash(slots.get(id) ?? {})) continue;
    await deps.library.takeCardSlot(id, slot);
    await deps.library.dropEdits(id);
  }
  return { applied, discarded, slots: nextSlots, textBefore: text };
}

/**
 * Puts the card's own text back after the sync rewrote it and the card then failed to read. The edits are
 * deliberately NOT dropped: they are still the user's, and the next insertion may fare better.
 */
export async function rollbackHistorySync(root: string, textBefore: string): Promise<boolean> {
  try {
    await writeFileAtomicEnsuringDir(path.join(root, MANIFEST_FILENAME), textBefore);
    log.warn('[history-sync] the rewritten manifest did not read back — restored the card\'s own text');
    return true;
  } catch (cause) {
    log.error('[history-sync] could not restore the card manifest:', describe(cause));
    return false;
  }
}

type ApplyOutcome =
  | { readonly kind: 'applied'; readonly text: string; readonly slot: GameSlot }
  /** Nothing was written and the edits stay pending — the card refused, not the user. */
  | { readonly kind: 'skipped' }
  /** The edits may never reach this card: it carries a different game under the same id, or they break it. */
  | { readonly kind: 'refused' };

interface ApplyInput {
  readonly id: string;
  readonly root: string;
  readonly cardSlot: GameSlot;
  readonly text: string;
  readonly deps: HistorySyncDeps;
}

/** The guarded half: title guard → staged copy → post-validation → the new text. Writes no manifest. */
async function applyOne(input: ApplyInput): Promise<ApplyOutcome> {
  const { id, root, cardSlot, text, deps } = input;
  const edited = await deps.library.readEditedSlot(id);
  if (edited === null) {
    log.warn(`[history-sync] id=${id} is flagged as configured but has no stored edits`);
    return { kind: 'refused' };
  }
  // Against the PRISTINE snapshot, never against the edits: a rename made from the history would
  // otherwise trip its own guard and could never be applied.
  const pristine = await deps.library.readCardSlot(id);
  const pristineTitle = pristine === null ? undefined : titleOf(pristine);
  if (pristineTitle !== undefined && titleOf(cardSlot) !== pristineTitle) {
    log.warn(
      `[history-sync] id=${id}: the card holds "${titleOf(cardSlot) ?? '?'}" where the history has "${pristineTitle}" — a different game under the same id, refusing to write`,
    );
    return { kind: 'refused' };
  }

  const staged = await copyStaged(id, root, deps);
  if (staged === null) return { kind: 'skipped' };
  const slot = remapSlotAssets(edited, staged);

  const replaced = replaceGameSlot(text, id, slot);
  if (!replaced.ok) {
    log.warn(`[history-sync] id=${id}: cannot place the slot back (${replaced.reason})`);
    return { kind: 'skipped' };
  }
  const introduced = issuesIntroducedBy(issuesOf(replaced.text, deps), issuesOf(text, deps));
  const first = introduced[0];
  if (first !== undefined) {
    log.warn(
      `[history-sync] id=${id}: the edit would break the card manifest — ${first.path}: ${first.message}`,
    );
    return { kind: 'refused' };
  }
  const missing = await missingSlotFile(slot, root);
  if (missing !== null) {
    log.warn(`[history-sync] id=${id}: "${missing}" does not exist on the card — refusing to apply`);
    return { kind: 'refused' };
  }
  return { kind: 'applied', text: replaced.text, slot };
}

/**
 * Copies everything staged for this game into `<root>/assets/`, returning how the slot's paths must be
 * rewritten (usually not at all). Null when a copy failed — the caller then leaves the edits pending.
 *
 * Idempotent by content: a file already there under the target name and with the same bytes is treated
 * as copied by a previous, interrupted apply; a DIFFERENT file under that name earns a `-2` suffix.
 */
async function copyStaged(
  id: string,
  root: string,
  deps: HistorySyncDeps,
): Promise<ReadonlyMap<string, string> | null> {
  const names = await deps.library.stagedFiles(id);
  if (names.length === 0) return new Map();
  const targetDir = path.join(root, CARD_ASSETS_DIRNAME);
  const remap = new Map<string, string>();
  try {
    await fse.ensureDir(targetDir);
    for (const name of names) {
      const source = deps.library.stagedFilePath(id, name);
      const finalName = await freeTargetName(targetDir, name, source);
      await fse.copy(source, path.join(targetDir, finalName), { overwrite: true });
      if (finalName !== name) {
        remap.set(`${CARD_ASSETS_DIRNAME}/${name}`, `${CARD_ASSETS_DIRNAME}/${finalName}`);
      }
    }
  } catch (cause) {
    log.warn(`[history-sync] id=${id}: copying the staged assets failed:`, describe(cause));
    return null;
  }
  return remap;
}

/** `name` itself when it is free or already holds these very bytes, otherwise `name-2`, `name-3`… */
async function freeTargetName(dir: string, name: string, source: string): Promise<string> {
  const extension = path.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  for (let suffix = 1; ; suffix += 1) {
    const candidate = suffix === 1 ? name : `${stem}-${suffix}${extension}`;
    const target = path.join(dir, candidate);
    if (!(await fse.pathExists(target))) return candidate;
    if (await sameBytes(source, target)) return candidate;
  }
}

async function sameBytes(a: string, b: string): Promise<boolean> {
  try {
    const [statA, statB] = [await fse.stat(a), await fse.stat(b)];
    if (statA.size !== statB.size) return false;
    return (await sha256(a)) === (await sha256(b));
  } catch (cause) {
    log.warn(`[history-sync] cannot compare "${a}" with "${b}":`, describe(cause));
    return false;
  }
}

async function sha256(filePath: string): Promise<string> {
  return createHash('sha256')
    .update(await fse.readFile(filePath))
    .digest('hex');
}

/**
 * The first file the slot names that is NOT on the card, or null when they all are. Assets are checked
 * as well as the executable: a slot pointing at artwork that never made it over would load, but with a
 * blank screen where the user's cover should be.
 */
async function missingSlotFile(slot: GameSlot, root: string): Promise<string | null> {
  const install = slot['install'];
  const installer =
    typeof install === 'object' && install !== null
      ? (install as Record<string, unknown>)['installer']
      : undefined;
  const candidates = [slot['executable'], installer, slot['gridImage'], slot['backgroundMusic']]
    .concat(Array.isArray(slot['heroImage']) ? slot['heroImage'] : [slot['heroImage']])
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  for (const relative of candidates) {
    if (path.isAbsolute(relative)) continue; // a PC-dialect path never belongs to a card slot anyway
    if (!(await fse.pathExists(path.join(root, relative)))) return relative;
  }
  return null;
}

/** What the editor's validation says about a manifest text ([] when it is happy with it). */
function issuesOf(text: string, deps: HistorySyncDeps): readonly ManifestValidationIssue[] {
  const result = validateManifestText(text, deps.t, 'card');
  return result.ok ? [] : result.issues;
}

/** The losing side of a conflict, in the log — the project's "always leave a breadcrumb" rule. */
function logLoser(id: string, slot: GameSlot | null): void {
  if (slot === null) return;
  log.info(`[history-sync] id=${id}: dropped edits were ${JSON.stringify(slot)}`);
}

function titleOf(slot: GameSlot): string | undefined {
  const title = slot['title'];
  return typeof title === 'string' ? title : undefined;
}

async function mtimeOf(filePath: string): Promise<number | null> {
  try {
    return (await fse.stat(filePath)).mtimeMs;
  } catch {
    return null;
  }
}
