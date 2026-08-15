// Reading assets into data URLs for the renderer (split out of the GameController god-object): the
// card's hero images and background music, the bundled UI sound set and ambience, the fallback
// wallpaper. Stateless except for the bundled-wallpaper and sound-set caches. GameController owns
// delivery (setHero/setCardMusic push to the window); this class only reads bytes and encodes them.
import path from 'node:path';
import fse from 'fs-extra';
import { type HeroAssets, type ResolvedManifest, type SfxName, type SfxSet } from '../shared/types';
import { log } from './logger';
import { describe } from './util';

const IMAGE_MIME: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const AUDIO_MIME: Readonly<Record<string, string>> = {
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
};

/**
 * Supported image / audio file extensions WITHOUT the leading dot, derived from the MIME maps above so
 * there is a single source of truth. The Configure-game window's file picker builds its dialog filters
 * from these (see game-config.ts pickPath) — keeping the "what can be a hero image / a sound" answer in
 * lockstep with what this reader actually decodes.
 */
export const IMAGE_EXTENSIONS: readonly string[] = Object.keys(IMAGE_MIME).map((ext) => ext.slice(1));
export const AUDIO_EXTENSIONS: readonly string[] = Object.keys(AUDIO_MIME).map((ext) => ext.slice(1));

/**
 * Reads an image file into a base64 data URL (or undefined on any failure). A free function so both the
 * AssetReader instance (hero delivery) and the Configure window's hero-preview handler share one path.
 */
export async function readImageDataUrl(filePath: string): Promise<string | undefined> {
  try {
    const mime = IMAGE_MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    const buffer = await fse.readFile(filePath);
    return `data:${mime};base64,${buffer.toString('base64')}`;
  } catch (cause) {
    log.warn(`[image] failed to read "${filePath}":`, describe(cause));
    return undefined;
  }
}

/**
 * Reads an audio file into a base64 data URL (or undefined on any failure). A free function for the same
 * reason as readImageDataUrl: both the AssetReader instance (card audio) and the LibraryStore (the copied
 * history assets) encode with one MIME table.
 */
export async function readAudioDataUrl(filePath: string): Promise<string | undefined> {
  try {
    const mime = AUDIO_MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    const buffer = await fse.readFile(filePath);
    return `data:${mime};base64,${buffer.toString('base64')}`;
  } catch (cause) {
    log.warn('[audio] failed to read, skipping:', describe(cause));
    return undefined;
  }
}

const SFX_NAMES: readonly SfxName[] = ['play', 'navigate', 'button', 'back'];

// The sound set shipped as the default, and the fallback whenever the chosen set's folder is missing.
// Mirrors DEFAULT_SETTINGS.soundSet in app-settings.ts (kept in sync by hand — importing that module
// here, or this one there, would put an fs/logger dependency on the daemon's import graph).
export const DEFAULT_SOUND_SET = 'playhook-abyss';

// Maps a UI sound slot to its file basename inside a set folder (audio/ui/<set>/). `navigate` is the odd
// one out — its file is `move.wav` (the sets predate the SfxName vocabulary); the rest are 1:1.
const SFX_SLOT_FILE: Readonly<Record<SfxName, string>> = {
  play: 'play',
  navigate: 'move',
  button: 'button',
  back: 'back',
};

/** The file basename (no extension) for a UI sound slot inside a set folder. Pure — unit-tested. */
export function sfxFileName(name: SfxName): string {
  return SFX_SLOT_FILE[name];
}

// Absolute path to a set's folder. __dirname at runtime is dist/main; the sets live in dist/audio/ui.
function soundSetDir(set: string): string {
  return path.join(__dirname, '../audio/ui', set);
}

function defaultSfxPath(set: string, name: SfxName): string {
  return path.join(soundSetDir(set), `${SFX_SLOT_FILE[name]}.wav`);
}

// Bundled ambience folder (dist/audio/ambience). A track is a bare file name (extension included).
function ambientDir(): string {
  return path.join(__dirname, '../audio/ambience');
}

/**
 * Whether `track` is a safe ambience file name to read from the bundled folder: a bare basename (no path
 * separators / traversal) with a supported audio extension. Pure — unit-tested (anti-traversal guard).
 */
export function isValidAmbientTrack(track: string): boolean {
  if (path.basename(track) !== track) return false;
  return AUDIO_MIME[path.extname(track).toLowerCase()] !== undefined;
}

// Fallback hero background (bundled by copy-assets into dist/wallpaper.jpg). __dirname is dist/main.
// The extension is load-bearing: this file goes to the renderer as a data URI whose MIME is derived from
// it, so it must match what copy-assets.mjs actually copies (assets/playhook-wallpaper.jpg).
const WALLPAPER_PATH = path.join(__dirname, '../wallpaper.jpg');

/** Dependencies of the reader (kept electron-free: plain getters). */
export interface AssetReaderDeps {
  /** The current navigation sound set from settings (folder under audio/ui/). Read live. */
  readonly getSoundSet: () => Promise<string>;
  /** The current default ambience track from settings (file name, or null for none). Read live. */
  readonly getAmbientTrack: () => Promise<string | null>;
  /** Whether to use ONLY the global ambience, ignoring a card's own background music. Read live. */
  readonly getOnlyGlobalAmbient: () => Promise<boolean>;
}

export class AssetReader {
  // The bundled Empty-screen wallpaper as a data URL: undefined = not read yet, null = unavailable.
  private wallpaperDataUrl: string | null | undefined;

  constructor(private readonly deps: AssetReaderDeps) {}

  async readImageDataUrl(filePath: string): Promise<string | undefined> {
    return readImageDataUrl(filePath);
  }

  /**
   * The bundled Empty-screen wallpaper as a data URL (read once and cached); null if it can't be read.
   * Also used as the per-game hero fallback (see readHeroAssets).
   */
  async readWallpaperDataUrl(): Promise<string | null> {
    if (this.wallpaperDataUrl !== undefined) return this.wallpaperDataUrl;
    const fallback = await this.readImageDataUrl(WALLPAPER_PATH);
    this.wallpaperDataUrl = fallback ?? null;
    return this.wallpaperDataUrl;
  }

  /**
   * Reads all of the manifest's hero images into data URLs, dropping any that fail to read. When none
   * remain (no heroImage, or every file unreadable) it falls back to the bundled wallpaper — so the
   * result always carries at least one image (same fallback semantics as the old single-hero path).
   */
  async readHeroAssets(manifest: ResolvedManifest): Promise<HeroAssets> {
    const images: string[] = [];
    for (const heroPath of manifest.heroImagePaths ?? []) {
      const url = await this.readImageDataUrl(heroPath);
      if (url !== undefined) images.push(url);
      else log.warn('[hero-image] failed to read, skipping:', heroPath);
    }
    if (images.length === 0) {
      const wallpaper = await this.readWallpaperDataUrl();
      if (wallpaper !== null) images.push(wallpaper);
    }
    return { images };
  }

  /**
   * The manifest's background music, the card's ONLY audio contribution (UI sounds always come from the
   * bundled set — see readSfxSet). Honours "only global ambience": a suppressed card music reads as null,
   * and the renderer falls back to the ambience.
   */
  async readMusicDataUrl(manifest: ResolvedManifest): Promise<string | null> {
    if (manifest.backgroundMusicPath === undefined) return null;
    if (await this.deps.getOnlyGlobalAmbient()) return null;
    return (await this.readAudioDataUrl(manifest.backgroundMusicPath)) ?? null;
  }

  /**
   * The chosen set's UI sounds — every sound the app plays, on every screen (the card cannot supply its
   * own). A slot whose file is missing within the set simply stays silent.
   */
  async readSfxSet(): Promise<SfxSet> {
    const set = await this.effectiveSoundSet();
    // Cache keyed by the effective set: a live getSoundSet() differing from the cached key re-reads, so a
    // set change invalidates without an explicit call. Files within a set never change → same-key hits are safe.
    if (this.sfxSetCache?.set === set) return this.sfxSetCache.assets;
    const sounds: Record<string, string> = {};
    for (const name of SFX_NAMES) {
      const url = await this.readAudioDataUrl(defaultSfxPath(set, name));
      if (url !== undefined) sounds[name] = url;
    }
    const assets: SfxSet = { sounds };
    this.sfxSetCache = { set, assets };
    return assets;
  }
  private sfxSetCache: { set: string; assets: SfxSet } | undefined;

  /**
   * The chosen navigation sound set if it is present, else the bundled default. A missing set
   * is a user-facing misconfiguration, so it is logged; an individual slot missing WITHIN a set is not
   * (that slot just stays silent — sets are expected complete).
   *
   * Presence is probed by statting the set's move.wav — a FILE — not the set DIRECTORY: inside the packaged
   * asar a directory stat is unreliable (it made every non-default set silently fall back to the default),
   * whereas a file stat works through Electron's shim. Mirrors readAmbientDataUrl's file existence check.
   */
  private async effectiveSoundSet(): Promise<string> {
    const set = await this.deps.getSoundSet();
    if (set === DEFAULT_SOUND_SET) return set;
    if (await fse.pathExists(defaultSfxPath(set, 'navigate'))) return set;
    log.warn(`[audio] sound set "${set}" not found — falling back to "${DEFAULT_SOUND_SET}"`);
    return DEFAULT_SOUND_SET;
  }

  /**
   * The current default ambience as a data URL (or null when none / the track is invalid or unreadable).
   * The game's own music always wins over this — the renderer decides that; here we only decode the track.
   * Anti-traversal: only a bare, supported-extension file name from the bundled folder is read. Cached by
   * track name so repeated reads (and the game-window seed) don't re-encode a multi-MB file.
   */
  async readAmbientDataUrl(track: string | null): Promise<string | null> {
    if (track === null) return null;
    if (this.ambientCache?.track === track) return this.ambientCache.url;
    if (!isValidAmbientTrack(track)) {
      log.warn(`[audio] ignoring invalid ambience track "${track}"`);
      return null;
    }
    const filePath = path.join(ambientDir(), track);
    if (!(await fse.pathExists(filePath))) {
      log.warn(`[audio] ambience track "${track}" missing — no ambience`);
      return null;
    }
    const url = (await this.readAudioDataUrl(filePath)) ?? null;
    this.ambientCache = { track, url };
    return url;
  }
  private ambientCache: { track: string; url: string | null } | undefined;

  private async readAudioDataUrl(filePath: string): Promise<string | undefined> {
    return readAudioDataUrl(filePath);
  }
}
