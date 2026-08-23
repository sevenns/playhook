// The gallery's two filters: which sources take part, and how large a picture has to be.
import { describe, expect, it } from 'vitest';
import {
  QUALITY_FLOOR,
  includesSource,
  meetsQuality,
  sourceGroupsFor,
} from '../src/shared/artwork-filter';
import { sameFilter, toFilter } from '../src/main/metadata/service';
import { searchUrl } from '../src/main/metadata/wallhaven';

describe('source groups', () => {
  it('offers the two stores as one choice for backgrounds — their pictures are the same kind', () => {
    const stores = sourceGroupsFor('hero').find((group) => group.key === 'stores');
    expect(stores?.providers).toEqual(['steam', 'gog']);
  });

  it('offers the cover sources for covers, and no wallpaper site among them', () => {
    expect(sourceGroupsFor('grid').map((group) => group.key)).toEqual([
      'all',
      'steam',
      'steamgriddb',
    ]);
  });

  it('starts each list with "every source", which names no provider at all', () => {
    for (const kind of ['hero', 'grid'] as const) {
      expect(sourceGroupsFor(kind)[0]).toMatchObject({ key: 'all', label: null, providers: [] });
    }
  });

  it('reads an empty list as every source rather than none', () => {
    expect(includesSource([], 'wallhaven')).toBe(true);
    expect(includesSource(['wallhaven'], 'wallhaven')).toBe(true);
    expect(includesSource(['wallhaven'], 'steam')).toBe(false);
  });
});

describe('size floor', () => {
  it('lets everything through when no floor is set', () => {
    expect(meetsQuality({}, 'any')).toBe(true);
    expect(meetsQuality({ width: 640, height: 480 }, 'any')).toBe(true);
  });

  it('measures against the named screen sizes', () => {
    expect(meetsQuality({ width: 1920, height: 1080 }, 'fullhd')).toBe(true);
    expect(meetsQuality({ width: 1600, height: 900 }, 'fullhd')).toBe(false);
    expect(meetsQuality({ width: 2560, height: 1440 }, 'qhd')).toBe(true);
    expect(meetsQuality({ width: 1920, height: 1080 }, 'qhd')).toBe(false);
    expect(meetsQuality({ width: 3840, height: 2160 }, 'uhd')).toBe(true);
  });

  // Steam states no size for a screenshot, and its own backdrop measured 1438x810 for Half-Life 2 — so
  // "unknown" cannot be treated as "large enough" without lying to a filter that asks for at least 4K.
  it('refuses a picture whose size nobody states, once a floor is set', () => {
    expect(meetsQuality({}, 'fullhd')).toBe(false);
    expect(meetsQuality({ width: 1920 }, 'fullhd')).toBe(false);
  });
});

describe('a filter as it arrives over IPC', () => {
  it('reads anything unrecognized as no filter at all', () => {
    expect(toFilter(undefined)).toEqual({ sources: [], quality: 'any' });
  });

  it('keeps what the sidebar sent', () => {
    expect(toFilter({ sources: ['wallhaven'], quality: 'uhd' })).toEqual({
      sources: ['wallhaven'],
      quality: 'uhd',
    });
  });

  it('tells two galleries apart, so changing a filter starts one over', () => {
    const base = { sources: ['wallhaven'] as const, quality: 'any' } as const;
    expect(sameFilter(base, { sources: ['wallhaven'], quality: 'any' })).toBe(true);
    expect(sameFilter(base, { sources: ['wallhaven'], quality: 'qhd' })).toBe(false);
    expect(sameFilter(base, { sources: ['wallpapercave'], quality: 'any' })).toBe(false);
    expect(sameFilter(base, { sources: [], quality: 'any' })).toBe(false);
  });
});

describe('the floor reaches the source that can search by it', () => {
  it('asks wallhaven for the size the sidebar set', () => {
    const url = new URL(searchUrl('Hades', 0, QUALITY_FLOOR.uhd));
    expect(url.searchParams.get('atleast')).toBe('3840x2160');
  });

  // Its own floor is 1080p and stays there: below it the endpoint would start offering wallpapers too
  // small for the screen this launcher paints them on.
  it('never lowers its own floor', () => {
    const url = new URL(searchUrl('Hades', 0, QUALITY_FLOOR.any));
    expect(url.searchParams.get('atleast')).toBe('1920x1080');
  });
});
