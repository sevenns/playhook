// The PC library — games that already live on THIS machine's disk, kept in `<userData>/pc-games/`.
//
// The directory is laid out exactly like a card, and that is the whole design: `game.json` in the root,
// `assets/` for the copied art and music, `saves/<id>/` standing in for the card's save copy. Everything
// downstream (manifest reading, anti-traversal, AssetReader, the history carousel, save-sync) therefore
// treats it as a card that is always inserted, with no parallel pipeline to keep in step. The one
// difference is the manifest source: a local game names its executable by ABSOLUTE path (see
// ManifestSource / the `pc` block in manifest.ts).
//
// Electron-free by construction (`baseDir` is injected like AppSettingsStore's) — so it stays importable
// from the daemon's graph and from unit tests, per CLAUDE.md.
import path from 'node:path';
import fse from 'fs-extra';
import { MANIFEST_FILENAME, PC_LIBRARY_DIRNAME, type ResolvedManifest } from '../shared/types';
import {
  readManifests,
  type InstallDirResolver,
  type ManifestEnv,
} from './manifest';
import { log } from './logger';
import { describe } from './util';

export interface PcLibraryDeps {
  /** The app data directory (`app.getPath('userData')` in main). The library lives under it. */
  readonly baseDir: string;
}

/** What one read of the library yields. */
export interface PcLibraryRead {
  readonly manifests: readonly ResolvedManifest[];
  /**
   * False when `game.json` exists but could not be read as a manifest at all. The library still reports
   * itself empty (the launcher must start), but that emptiness is a symptom, not the truth — so the
   * caller must NOT act on it destructively (see gcOrphans, which would otherwise wipe every asset of a
   * library whose manifest merely lost a closing brace).
   */
  readonly intact: boolean;
}

/** Characters an imported asset's file name may keep. Everything else collapses into `-`. */
const SAFE_ASSET_NAME = /[^A-Za-z0-9._-]+/g;

export class PcLibraryStore {
  /** The library root — a card root in every respect but its manifest source. */
  readonly root: string;
  private readonly assetsDir: string;

  constructor(deps: PcLibraryDeps) {
    this.root = path.join(deps.baseDir, PC_LIBRARY_DIRNAME);
    this.assetsDir = path.join(this.root, 'assets');
  }

  /** Creates the library skeleton. `game.json` is NOT created: its absence means "no local games yet". */
  async init(): Promise<void> {
    await fse.ensureDir(this.root);
    await fse.ensureDir(this.assetsDir);
  }

  /**
   * Reads every local game. A structurally broken `game.json` (unparsable, or a top-level that is neither
   * an object nor an array) is warned about and yields an EMPTY library rather than an error: unlike a
   * card, this file is app state on the startup path — letting it fail would take the launcher's whole
   * library, including the history, down with it. The user still sees the real reason when they open
   * Configure, whose validation reports it against the text.
   */
  async read(env: ManifestEnv, resolveInstallDir: InstallDirResolver): Promise<PcLibraryRead> {
    const result = await readManifests(this.root, env, resolveInstallDir, { source: 'pc' });
    if (!result.ok) {
      log.warn(`[pc-library] ${MANIFEST_FILENAME} is unreadable, treating the library as empty: ${result.message}`);
      return { manifests: [], intact: false };
    }
    return { manifests: result.manifests, intact: true };
  }

  /** Whether a `game.json` exists at all — the Configure picker shows a blank form when it does not. */
  async hasManifest(): Promise<boolean> {
    return fse.pathExists(this.manifestPath());
  }

  /** Removes `game.json` — how "the last local game was deleted" is spelled (an empty library). */
  async removeManifest(): Promise<void> {
    await fse.remove(this.manifestPath());
  }

  /**
   * Copies a picked image/audio file INTO the library and returns its root-relative path (forward
   * slashes, ready for game.json). Copying rather than referencing is what keeps a local game's artwork
   * alive after the user moves or deletes the original — and it keeps every asset path relative, so
   * `resolveInside` and the AssetReader need no PC-specific branch at all.
   *
   * The name is sanitized (it comes from the user's filesystem) and de-duplicated with a `-2`, `-3`…
   * suffix, so importing two different `hero.jpg` files never overwrites the first game's background.
   */
  async importAsset(absolutePath: string): Promise<string> {
    await fse.ensureDir(this.assetsDir);
    const name = await this.uniqueAssetName(path.basename(absolutePath));
    await fse.copy(absolutePath, path.join(this.assetsDir, name), { overwrite: false, errorOnExist: true });
    return `assets/${name}`;
  }

  /** This game's save backup directory — the local stand-in for `saveOnCard` (see manifest.ts). */
  savesDir(id: string): string {
    return path.join(this.root, 'saves', id);
  }

  /**
   * Deletes assets no manifest references any more (art of a game the user removed). `saves/` is NEVER
   * touched: a game deleted from the library — or from the disk — must keep its progress, which is the
   * whole point of backing it up here.
   */
  async gcOrphans(referenced: readonly string[]): Promise<void> {
    const keep = new Set(referenced.map((relative) => path.basename(relative.replaceAll('\\', '/'))));
    let names: readonly string[];
    try {
      names = await fse.readdir(this.assetsDir);
    } catch (cause) {
      if (!isNotFound(cause)) log.warn('[pc-library] cannot list assets for cleanup:', describe(cause));
      return;
    }
    for (const name of names) {
      if (keep.has(name)) continue;
      try {
        await fse.remove(path.join(this.assetsDir, name));
      } catch (cause) {
        log.warn(`[pc-library] failed to remove the orphaned asset "${name}":`, describe(cause));
      }
    }
  }

  private manifestPath(): string {
    return path.join(this.root, MANIFEST_FILENAME);
  }

  /** A sanitized, collision-free file name inside `assets/`. */
  private async uniqueAssetName(original: string): Promise<string> {
    const sanitized = original.replace(SAFE_ASSET_NAME, '-').replace(/^[-.]+/, '');
    const base = sanitized.length > 0 ? sanitized : 'asset';
    const extension = path.extname(base);
    const stem = base.slice(0, base.length - extension.length);
    let candidate = base;
    for (let suffix = 2; await fse.pathExists(path.join(this.assetsDir, candidate)); suffix += 1) {
      candidate = `${stem}-${suffix}${extension}`;
    }
    return candidate;
  }
}

/** True for an "it isn't there" fs error — an empty library is a normal state, not a failure. */
function isNotFound(cause: unknown): boolean {
  return (
    typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === 'ENOENT'
  );
}
