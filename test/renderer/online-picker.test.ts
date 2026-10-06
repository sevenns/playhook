import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createOnlinePicker,
  type OnlinePickerApi,
  type OnlinePickerSurface,
} from '../../src/renderer/online-picker';
import { req } from '../../src/renderer/dom';
import { createTranslator } from '../../src/shared/i18n/index';
import type { ArtworkPage, GameCandidate, MetadataResult } from '../../src/shared/types';
import { loadFixture } from './helpers/fixture';
import { fakeAudio, type FakeAudio } from './helpers/fakes';
import { installRafHarness } from './helpers/raf';

const CANDIDATE: GameCandidate = {
  key: 'steam:1',
  title: 'Dark Souls II',
  provider: 'steam',
  steamAppId: 1,
};

function page(keys: readonly string[]): MetadataResult<ArtworkPage> {
  return {
    ok: true,
    value: {
      variants: keys.map((key) => ({
        key,
        kind: 'hero' as const,
        provider: 'wallhaven' as const,
        thumbDataUrl: `data:image/png;base64,${key}`,
        width: 1920,
        height: 1080,
      })),
      hasMore: false,
    },
  };
}

/** One artwork request the test can answer whenever it likes. */
interface Asked {
  readonly kind: string;
  readonly quality: string;
  resolve(result: MetadataResult<ArtworkPage>): void;
}

let picker: OnlinePickerSurface;
let audio: FakeAudio;
let asked: Asked[];

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const side = (label: string): HTMLButtonElement => {
  const button = [...req('online-picker-side').querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) throw new Error(`no side button "${label}"`);
  return button;
};
const content = (): HTMLElement => req('online-picker-content');
const tiles = (): number => content().querySelectorAll('.metadata-tile').length;
const busy = (): boolean => content().querySelector('.music-busy') !== null;

beforeEach(async () => {
  loadFixture();
  installRafHarness();
  audio = fakeAudio();
  asked = [];
  const api: OnlinePickerApi = {
    searchGames: () => Promise.resolve({ ok: true, value: [CANDIDATE] }),
    steamCandidate: () => Promise.resolve({ ok: true, value: CANDIDATE }),
    artwork: (_key, kind, _page, filter) =>
      new Promise<MetadataResult<ArtworkPage>>((resolve) => {
        asked.push({ kind, quality: filter.quality, resolve });
      }),
    albums: () => Promise.resolve({ ok: true, value: [] }),
    tracks: () => Promise.resolve({ ok: true, value: [] }),
    preview: () => Promise.resolve({ ok: false, message: '' }),
    cancel: () => undefined,
  };
  picker = createOnlinePicker({
    audio,
    getTranslator: () => createTranslator('en'),
    api,
    editQuery: () => undefined,
    applyArtwork: () => Promise.resolve({ ok: true, message: '' }),
    applyTrack: () => Promise.resolve({ ok: true, message: '' }),
    applyTitle: () => undefined,
    onCandidate: () => undefined,
    heroCount: () => 0,
    notify: () => undefined,
    showError: () => undefined,
    showBusy: () => undefined,
    closeBusy: () => undefined,
    confirmTitle: () => undefined,
  });
  // Opened on a known appid: straight to the candidate and its Backgrounds gallery.
  picker.open({ query: 'Dark Souls II', appId: 1 });
  await flush();
  expect(asked.map((a) => a.kind)).toEqual(['hero']);
});

afterEach(() => {
  picker.close();
  vi.unstubAllGlobals();
});

describe('online picker: the gallery while a request is out', () => {
  it('shows the wait, not the previous pictures, after a filter change', async () => {
    asked[0]?.resolve(page(['w1', 'w2', 'w3']));
    await flush();
    expect(tiles()).toBe(3);

    side('2K').click();

    expect(asked.map((a) => a.quality)).toEqual(['any', 'qhd']);
    expect(tiles(), 'the old gallery must not stand in for the new one').toBe(0);
    expect(busy()).toBe(true);

    asked[1]?.resolve(page(['w9']));
    await flush();
    expect(tiles()).toBe(1);
    expect(busy()).toBe(false);
  });

  it('shows the wait while the first page of a section is out', () => {
    expect(busy()).toBe(true);
    expect(content().textContent).not.toContain('No artwork');
  });

  it("never paints one section's pictures under another section's name", async () => {
    // Backgrounds are still loading when the user moves to Cover.
    side('Cover').click();

    expect(asked.map((a) => a.kind)).toEqual(['hero', 'grid']);
    expect(busy()).toBe(true);

    // The backgrounds arrive late — they belong to a section that is no longer open.
    asked[0]?.resolve(page(['bg1', 'bg2']));
    await flush();
    expect(tiles()).toBe(0);
    expect(busy()).toBe(true);

    asked[1]?.resolve(page(['cover1']));
    await flush();
    expect(tiles()).toBe(1);
  });
});
