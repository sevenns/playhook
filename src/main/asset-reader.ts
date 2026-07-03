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

export class AssetReader {
  // Bundled fallback wallpaper as a data URL: undefined = not read yet, null = unavailable.
  private wallpaperDataUrl: string | null | undefined;

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

  /** Bundled fallback wallpaper as a data URL (read once and cached). null if it can't be read. */
  async readWallpaperDataUrl(): Promise<string | null> {
    if (this.wallpaperDataUrl !== undefined) return this.wallpaperDataUrl;
    const url = await this.readImageDataUrl(WALLPAPER_PATH);
    this.wallpaperDataUrl = url ?? null;
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
