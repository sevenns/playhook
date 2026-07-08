// Reading card assets (hero images, UI sounds, background music, fallback wallpaper) into data URLs
// for the renderer (split out of the GameController god-object). Stateless except for the
// bundled-wallpaper cache. GameController owns delivery (setHero/setAudio push to the window); this
// class only reads bytes off disk and encodes them.
import path from 'node:path';
import fse from 'fs-extra';
import { type AudioAssets, type HeroAssets, type ResolvedManifest, type SfxName } from '../shared/types';
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

const SFX_NAMES: readonly SfxName[] = ['play', 'navigate', 'button', 'back'];

// Bundled default UI sounds (in dist/audio, copied by copy-assets). Used per slot when a game.json
// doesn't provide its own sound, so every game has interface sounds out of the box.
const DEFAULT_SFX_FILES: Readonly<Record<SfxName, string>> = {
  play: 'default-play.wav',
  navigate: 'default-move.wav',
  button: 'default-button.wav',
  back: 'default-back.wav',
};

function defaultSfxPath(name: SfxName): string {
  // __dirname at runtime is dist/main; the bundled sounds live in dist/audio.
  return path.join(__dirname, '../audio', DEFAULT_SFX_FILES[name]);
}

// Fallback hero background (bundled by copy-assets into dist/wallpaper.png). __dirname is dist/main.
const WALLPAPER_PATH = path.join(__dirname, '../wallpaper.png');

// Custom Empty-screen wallpaper: hard file-size cap (a bigger file is refused rather than downscaled —
// see plan F2.2). 8 MB as base64 is ~11 MB of string in the renderer, which is tolerable for a one-off.
const MAX_WALLPAPER_BYTES = 8 * 1024 * 1024;
// The custom wallpaper is stored in userData under this base name plus the source extension (kept so the
// data-URI MIME resolves correctly for jpg/png/webp/gif).
const CUSTOM_WALLPAPER_BASE = 'wallpaper-custom';

/** Dependencies for the custom Empty-screen wallpaper (kept electron-free: plain string + getter). */
export interface AssetReaderDeps {
  /** app.getPath('userData') — where the copied custom wallpaper file lives. */
  readonly userData: string;
  /** The current custom wallpaper file name from settings (null = bundled default). Read live. */
  readonly getCustomWallpaperName: () => Promise<string | null>;
}

/**
 * Result of copying a picked file in as the custom wallpaper. On failure the `reason` is a code the
 * caller (GameController) maps to a localized message — AssetReader stays translator-free.
 */
export type SetWallpaperResult =
  | { readonly ok: true; readonly dataUrl: string; readonly fileName: string }
  | { readonly ok: false; readonly reason: 'too-large' | 'not-image' | 'io' };

/** Sniffs the first bytes for a supported image signature (png / jpeg / gif / webp). */
function isSupportedImage(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true;
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;
  // GIF: "GIF8"
  if (buffer.subarray(0, 4).toString('latin1') === 'GIF8') return true;
  // WEBP: "RIFF"????"WEBP"
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') {
    return true;
  }
  return false;
}

export class AssetReader {
  // The EFFECTIVE Empty-screen wallpaper (custom if set & present, else bundled) as a data URL:
  // undefined = not read yet, null = unavailable. Invalidated on any custom-wallpaper change.
  private wallpaperDataUrl: string | null | undefined;

  constructor(private readonly deps: AssetReaderDeps) {}

  async readImageDataUrl(filePath: string): Promise<string | undefined> {
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
   * The effective Empty-screen wallpaper as a data URL (read once and cached): the user's custom image
   * when set and still present on disk, otherwise the bundled default. null if nothing can be read. Also
   * used as the per-game hero fallback, so a custom wallpaper flows into both (see readHeroAssets).
   */
  async readWallpaperDataUrl(): Promise<string | null> {
    if (this.wallpaperDataUrl !== undefined) return this.wallpaperDataUrl;
    const customName = await this.deps.getCustomWallpaperName();
    if (customName !== null) {
      const customPath = path.join(this.deps.userData, customName);
      if (await fse.pathExists(customPath)) {
        const url = await this.readImageDataUrl(customPath);
        if (url !== undefined) {
          this.wallpaperDataUrl = url;
          return url;
        }
      }
      // The setting points at a missing/unreadable file → fall back to the bundled default (no crash).
      log.warn(`[wallpaper] custom wallpaper "${customName}" missing/unreadable — using the bundled default`);
    }
    const fallback = await this.readImageDataUrl(WALLPAPER_PATH);
    this.wallpaperDataUrl = fallback ?? null;
    return this.wallpaperDataUrl;
  }

  /**
   * Copies a picked image in as the custom Empty-screen wallpaper: refuses a file over the size cap or
   * one that doesn't sniff as a supported image, writes it into userData (raw bytes — no re-encode),
   * removes any previous custom file, and invalidates the cache. Returns the new data URL + file name.
   */
  async setCustomWallpaper(sourcePath: string): Promise<SetWallpaperResult> {
    try {
      const stat = await fse.stat(sourcePath);
      if (stat.size > MAX_WALLPAPER_BYTES) return { ok: false, reason: 'too-large' };
      const buffer = await fse.readFile(sourcePath);
      if (!isSupportedImage(buffer)) return { ok: false, reason: 'not-image' };
      const ext = path.extname(sourcePath).toLowerCase();
      const mime = IMAGE_MIME[ext];
      if (mime === undefined) return { ok: false, reason: 'not-image' };
      const fileName = `${CUSTOM_WALLPAPER_BASE}${ext}`;
      // Drop any previous custom file first (a different extension would otherwise leak on disk), then
      // write the new one — independent of the settings value, which the caller patches afterwards.
      await this.removeCustomFiles(fileName);
      await fse.ensureDir(this.deps.userData);
      await fse.writeFile(path.join(this.deps.userData, fileName), buffer);
      this.wallpaperDataUrl = undefined; // invalidate: the next read reflects the new custom image
      return { ok: true, dataUrl: `data:${mime};base64,${buffer.toString('base64')}`, fileName };
    } catch (cause) {
      log.warn('[wallpaper] failed to set custom wallpaper:', describe(cause));
      return { ok: false, reason: 'io' };
    }
  }

  /**
   * Removes the custom wallpaper file(s) and invalidates the cache, so the Empty screen falls back to
   * the bundled default. Deletion is by the fixed base name (NOT the settings value), so it works even
   * from the general Reset — which writes customWallpaper=null BEFORE this runs. Returns the default data
   * URL (empty string when the bundle can't be read).
   */
  async clearCustomWallpaper(): Promise<{ dataUrl: string }> {
    await this.removeCustomFiles();
    this.wallpaperDataUrl = undefined;
    const fallback = await this.readImageDataUrl(WALLPAPER_PATH);
    this.wallpaperDataUrl = fallback ?? null;
    return { dataUrl: fallback ?? '' };
  }

  /** Best-effort removal of every `wallpaper-custom.<ext>` in userData, optionally keeping one. */
  private async removeCustomFiles(keep?: string): Promise<void> {
    await Promise.all(
      Object.keys(IMAGE_MIME)
        .map((ext) => `${CUSTOM_WALLPAPER_BASE}${ext}`)
        .filter((name) => name !== keep)
        .map((name) => fse.remove(path.join(this.deps.userData, name)).catch(() => undefined)),
    );
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

  /** Reads the manifest's sounds + music into data URLs. Returns null when nothing is configured. */
  async readAudioAssets(manifest: ResolvedManifest): Promise<AudioAssets | null> {
    const sounds: Record<string, string> = {};
    for (const name of SFX_NAMES) {
      // Per slot: the game's own sound if set, otherwise the bundled default.
      const filePath = manifest.soundPaths?.[name] ?? defaultSfxPath(name);
      const url = await this.readAudioDataUrl(filePath);
      if (url !== undefined) sounds[name] = url;
    }
    const music =
      manifest.backgroundMusicPath !== undefined
        ? await this.readAudioDataUrl(manifest.backgroundMusicPath)
        : undefined;

    if (Object.keys(sounds).length === 0 && music === undefined) return null;
    return { sounds, ...(music !== undefined ? { music } : {}) };
  }

  private async readAudioDataUrl(filePath: string): Promise<string | undefined> {
    try {
      const mime = AUDIO_MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
      const buffer = await fse.readFile(filePath);
      return `data:${mime};base64,${buffer.toString('base64')}`;
    } catch (cause) {
      log.warn('[audio] failed to read, skipping:', describe(cause));
      return undefined;
    }
  }
}
