// What the artwork gallery may show: which sources, and how large a picture has to be.
//
// Shared because both sides need the same answer. The renderer builds the sidebar out of these groups
// and thresholds; main asks only the chosen sources and drops what falls below the floor before a single
// thumbnail is downloaded. A filter is therefore a saving, not a hiding: a Wallpaper Cave tile IS its
// full-size file, so a picture that would be filtered out costs megabytes to show and then hide.
//
// The thresholds are the three names people actually use for a screen, not a computed scale: a wallpaper
// site states pixels, and "at least 4K" is a question with an exact answer.
import { type ArtworkKind, type MetadataProviderId } from './types';

/** The named size floors. `any` is the absence of a floor, not a small one. */
export type ArtworkQuality = 'any' | 'fullhd' | 'qhd' | 'uhd';

export interface SizeFloor {
  readonly width: number;
  readonly height: number;
}

export const QUALITY_FLOOR: Readonly<Record<ArtworkQuality, SizeFloor>> = {
  any: { width: 0, height: 0 },
  fullhd: { width: 1920, height: 1080 },
  qhd: { width: 2560, height: 1440 },
  uhd: { width: 3840, height: 2160 },
};

/** How a threshold is written on its button. Proper names of screen sizes, so they are not translated. */
export const QUALITY_LABEL: Readonly<Record<ArtworkQuality, string | null>> = {
  any: null,
  fullhd: 'Full HD',
  qhd: '2K',
  uhd: '4K',
};

export const QUALITY_ORDER: readonly ArtworkQuality[] = ['any', 'fullhd', 'qhd', 'uhd'];

/**
 * One button of the source filter. A group can hold more than one source: the two stores answer with the
 * same kind of picture (a frame out of the game), so telling them apart would be a distinction without a
 * difference for someone choosing a background.
 */
export interface ArtworkSourceGroup {
  readonly key: string;
  /** A proper name, shown as it stands. Null means "every source", which the UI translates. */
  readonly label: string | null;
  /** Empty for "every source" — main reads that as "ask them all". */
  readonly providers: readonly MetadataProviderId[];
}

/**
 * The source buttons for a gallery. They differ by kind because the sources do: covers come from Steam
 * and SteamGridDB, backgrounds from the two wallpaper sites and the two stores.
 */
export function sourceGroupsFor(kind: ArtworkKind): readonly ArtworkSourceGroup[] {
  if (kind === 'grid') {
    return [
      { key: 'all', label: null, providers: [] },
      { key: 'steam', label: 'Steam', providers: ['steam'] },
      { key: 'steamgriddb', label: 'SteamGridDB', providers: ['steamgriddb'] },
    ];
  }
  return [
    { key: 'all', label: null, providers: [] },
    { key: 'wallhaven', label: 'Wallhaven', providers: ['wallhaven'] },
    { key: 'wallpapercave', label: 'Wallpaper Cave', providers: ['wallpapercave'] },
    { key: 'stores', label: 'Steam / GOG', providers: ['steam', 'gog'] },
  ];
}

/**
 * Whether a picture clears the floor. A picture whose size nobody states is refused by every floor but
 * `any`: the filter answers "at least this large", and "unknown" is not an answer to it. Steam's own
 * backdrop is the honest example — measured 1438x810 for Half-Life 2, below Full HD despite the game.
 */
export function meetsQuality(
  size: { readonly width?: number; readonly height?: number },
  quality: ArtworkQuality,
): boolean {
  const floor = QUALITY_FLOOR[quality];
  if (floor.width === 0) return true;
  if (size.width === undefined || size.height === undefined) return false;
  return size.width >= floor.width && size.height >= floor.height;
}

/** Whether a source takes part at all. An empty list is "every source", not "none". */
export function includesSource(
  sources: readonly MetadataProviderId[],
  id: MetadataProviderId,
): boolean {
  return sources.length === 0 || sources.includes(id);
}
