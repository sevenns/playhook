// The "Find online" flow (the metadata:* channels — see main/metadata/), the half of it that touches the
// Customize screen. The surface itself is online-picker.ts: one screen with the game, the cover, the
// backgrounds and the soundtrack as sections. What lives HERE is the keyboard for a query, the downloads
// that land beside the game, and the form fields their paths go into. Nothing reaches the manifest until
// the user saves: an applied file only fills a FORM FIELD, exactly as a path chosen in the file browser
// does.
import type {
  GameCandidate,
  GameDetails,
  MetadataApplyRequest,
  MetadataApplyResult,
  MetadataApplySlot,
  MetadataResult,
} from '../shared/types.js';
import { MAX_HERO_IMAGES } from '../shared/types.js';
import type { Translator } from '../shared/i18n/index.js';
import type { ManifestFormModel } from './configure-form-model.js';
import type { GameRowId } from './game-settings-model.js';
import type { TextEntrySurface } from './nav-surface.js';
import type { ApplyOutcome, OnlinePickerSurface } from './online-picker.js';

export interface OnlineFlowDeps {
  /** The three metadata channels of GameSettingsScreenApi this flow drives. */
  readonly api: {
    applyMetadata(request: MetadataApplyRequest): Promise<MetadataApplyResult>;
    metadataDescriptions(candidateKey: string): Promise<MetadataResult<GameDetails>>;
    cancelMetadata(): void;
  };
  readonly onlinePicker: Pick<OnlinePickerSurface, 'open'>;
  readonly keyboard: Pick<TextEntrySurface, 'open'>;
  getTranslator(): Translator;
  /** Whether the screen is still open — an answer for a closed screen is retired. */
  isOpen(): boolean;
  form(): ManifestFormModel;
  /** The root a downloaded file goes beside, or null when there is none (a history game, no root yet). */
  assetRoot(): string | null;
  /** A history game has no root to download a cover into — the text half of the flow still applies. */
  isHistoryGame(): boolean;
  setField(id: GameRowId, value: string): void;
  setList(id: GameRowId, items: readonly string[]): void;
  /** Folds facts the form has no field for (description, genres…) into the manifest's `rest`. */
  mergeRest(known: Readonly<Record<string, unknown>>): void;
  /** Asks the launcher's confirm popup whether the store's spelling may replace the Title field. */
  requestTitleConfirm(title: string): void;
}

export interface OnlineFlow {
  /**
   * The entry point. Everything the sources offer lives on ONE surface (online-picker.ts): the game, its
   * cover, its backgrounds and its soundtrack, each a section of the same screen. A Steam game whose
   * appid is already filled in skips the search: that number is the very thing a search exists to find.
   */
  start(): void;
  /** Everything the flow leaves running, ended in one place: whatever main is still fetching for it. */
  stop(): void;
  /** Opens the keyboard for a new search query. */
  askQuery(initial: string, onDone: (query: string) => void): void;
  /** Asks the confirm popup about the store's title; `onYes` runs when `titleConfirmed` arrives. */
  askTitle(title: string, onYes: () => void): void;
  titleConfirmed(): void;
  /** Downloads the chosen pictures into the game and writes their paths into the form. */
  applyArtwork(
    kind: 'grid' | 'hero',
    variantKeys: readonly string[],
    mode: 'replace' | 'append',
  ): Promise<ApplyOutcome>;
  applyTrack(trackKey: string): Promise<ApplyOutcome>;
  /** The user named the game — its description, genres and dates are fetched from here. */
  onCandidate(candidate: GameCandidate): void;
}

export function createOnlineFlow(deps: OnlineFlowDeps): OnlineFlow {
  const t = (): Translator => deps.getTranslator();
  /** What a "yes" to the title question runs — the surface's own callback, held until the popup answers. */
  let pendingTitleReplace: (() => void) | null = null;
  /** Retires answers belonging to a flow the user has already left (a new search, a closed screen). */
  let metadataToken = 0;

  /** Whether an answer from main still belongs to the flow that asked for it. */
  function metadataCurrent(token: number): boolean {
    return deps.isOpen() && token === metadataToken;
  }

  /** Where an applied file goes, and under which id it is named. */
  function metadataTarget(): { readonly root: string; readonly gameId: string } | null {
    const root = deps.assetRoot();
    if (root === null) return null;
    const id = deps.form().id.trim();
    return id === '' ? null : { root, gameId: id };
  }

  /**
   * Downloads the chosen variants and writes the resulting manifest paths into the form.
   *
   * The slot INDEX matters as much as the order: it names the file on disk
   * (`assets/<id>-hero-<n>.<ext>`), so appending has to start after the backgrounds already there —
   * writing from zero would overwrite the very files it is adding to.
   */
  async function applyArtwork(
    kind: 'grid' | 'hero',
    variantKeys: readonly string[],
    mode: 'replace' | 'append',
  ): Promise<ApplyOutcome> {
    const target = metadataTarget();
    if (target === null) return { ok: false, message: t()('metadata.needsId') };
    const existing = mode === 'append' ? deps.form().heroImage : [];
    const room = kind === 'grid' ? variantKeys.length : MAX_HERO_IMAGES - existing.length;
    const accepted = variantKeys.slice(0, Math.max(0, room));
    const token = metadataToken;
    const paths: string[] = [];
    for (const [index, variantKey] of accepted.entries()) {
      const slot: MetadataApplySlot = kind === 'grid' ? 'grid' : { hero: existing.length + index };
      const result = await deps.api.applyMetadata({ ...target, variantKey, slot });
      if (!metadataCurrent(token)) return { ok: false, message: '' };
      if (!result.ok) return { ok: false, message: result.message };
      paths.push(result.path);
    }
    if (kind === 'grid') {
      deps.setField('gridImage', paths[0] ?? '');
    } else {
      deps.setList('heroImage', [...existing, ...paths]);
    }
    // A pick that did not fit says so: silently dropping the third of three chosen backgrounds would
    // read as the download having failed.
    const dropped = variantKeys.length - accepted.length;
    return {
      ok: true,
      message:
        dropped > 0
          ? t()('metadata.appliedPartly', { count: String(dropped) })
          : t()('metadata.applied'),
    };
  }

  /**
   * Fills the manifest's non-picture facts in the background: the description, and the genres, release
   * date and platforms a future library view will sort by. main deliberately never writes them itself —
   * the manifest TEXT belongs to the form while the screen is open, so a write from the other side
   * would be overwritten by the next Save (see configure-form-model.ts).
   */
  async function fetchMetadataDescriptions(candidate: GameCandidate): Promise<void> {
    const token = metadataToken;
    const result = await deps.api.metadataDescriptions(candidate.key);
    if (!metadataCurrent(token) || !result.ok) return;
    const { description, genres, releaseDate, platforms } = result.value;
    const known = {
      ...(description === undefined ? {} : { description }),
      ...(genres === undefined ? {} : { genres }),
      ...(releaseDate === undefined ? {} : { releaseDate }),
      ...(platforms === undefined ? {} : { platforms }),
    };
    if (Object.keys(known).length === 0) return;
    deps.mergeRest(known);
  }

  return {
    start: () => {
      metadataToken += 1;
      const form = deps.form();
      const appId = Number(form.steam.appid.trim());
      const steamApp = form.launchMode === 'steam' && Number.isSafeInteger(appId) && appId > 0;
      deps.onlinePicker.open({
        query: form.title.trim(),
        ...(steamApp ? { appId } : {}),
        ...(deps.isHistoryGame() ? { textOnly: true } : {}),
      });
    },
    stop: () => {
      metadataToken += 1;
      deps.api.cancelMetadata();
    },
    askQuery: (initial, onDone) => {
      deps.keyboard.open({
        value: initial,
        mode: 'text',
        title: t()('metadata.searchTitle'),
        onDone: (value) => {
          metadataToken += 1;
          onDone(value);
        },
      });
    },
    askTitle: (title, onYes) => {
      pendingTitleReplace = onYes;
      deps.requestTitleConfirm(title);
    },
    titleConfirmed: () => {
      const run = pendingTitleReplace;
      pendingTitleReplace = null;
      run?.();
    },
    applyArtwork,
    applyTrack: async (trackKey) => {
      const target = metadataTarget();
      if (target === null) return { ok: false, message: t()('metadata.needsId') };
      const token = metadataToken;
      const result = await deps.api.applyMetadata({
        ...target,
        variantKey: trackKey,
        slot: 'music',
      });
      if (!metadataCurrent(token)) return { ok: false, message: '' };
      if (!result.ok) return { ok: false, message: result.message };
      deps.setField('backgroundMusic', result.path);
      return { ok: true, message: t()('metadata.applied') };
    },
    onCandidate: (candidate) => {
      // An empty form takes the name at once, without the question "Take the name" asks: there is
      // nothing to replace. It is also what makes the rest of the screen usable — the id follows the
      // title (see withField), and the id is what every downloaded file is NAMED by, so a game added
      // through this flow could otherwise pick a background and be told it has no id to write it under.
      if (deps.form().title.trim() === '') deps.setField('title', candidate.title);
      // Only a Steam entry can be asked for facts: the others carry no appid, and the appid is what the
      // descriptions, genres and dates are addressed by.
      if (candidate.steamAppId !== undefined) void fetchMetadataDescriptions(candidate);
    },
  };
}
