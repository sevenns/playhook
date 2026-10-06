import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetadataService } from '../src/main/metadata/service';
import { ipcMain } from './stubs/electron';
import {
  IPC,
  type ArtworkPage,
  type GameCandidate,
  type MetadataResult,
} from '../src/shared/types';
import { createTranslator } from '../src/shared/i18n/index';
import { log } from '../src/main/logger';
import type { MetadataProvider } from '../src/main/metadata/provider';

type Handler<A, R> = (event: unknown, arg: A) => Promise<R>;

const CANDIDATE: GameCandidate = {
  key: 'steam:1',
  title: 'Tunic',
  provider: 'steam',
  steamAppId: 1,
};

function serviceWith(providers: readonly MetadataProvider[]): {
  search: Handler<string, MetadataResult<readonly GameCandidate[]>>;
  artwork: Handler<unknown, MetadataResult<ArtworkPage>>;
} {
  const service = new MetadataService({
    http: {} as never,
    providers,
    cacheDir: '/tmp/unused',
    pcLibrary: {} as never,
    isAllowedRoot: () => Promise.resolve(true),
    getTranslator: () => createTranslator('en'),
  });
  service.init();
  return {
    search: ipcMain.handlers.get(IPC.metadataSearch) as never,
    artwork: ipcMain.handlers.get(IPC.metadataArtwork) as never,
  };
}

const steam: MetadataProvider = {
  id: 'steam',
  search: () => Promise.resolve({ ok: true, value: [CANDIDATE] }),
  artwork: () => Promise.resolve({ ok: true, value: { offers: [], hasMore: false } }),
};

const refusing: MetadataProvider = {
  id: 'steamgriddb',
  search: () => Promise.resolve({ ok: false, message: 'metadata.steamGridDbKeyRejected' }),
  artwork: () => Promise.resolve({ ok: false, message: 'https://sgdb/grids: HTTP 401' }),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('metadata service: a refusing source', () => {
  it('leaves a breadcrumb even when another source covers for it', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const { search } = serviceWith([steam, refusing]);

    const result = await search(undefined, 'Tunic');

    expect(result.ok === true && result.value.map((c) => c.title)).toEqual(['Tunic']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      '[metadata] steamgriddb: SteamGridDB rejected',
    );
  });

  it('answers with the translated refusal when it is the only source asked', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const { search, artwork } = serviceWith([steam, refusing]);
    await search(undefined, 'Tunic');

    const result = await artwork(undefined, {
      candidateKey: CANDIDATE.key,
      kind: 'grid',
      page: 0,
      filter: { sources: ['steamgriddb'], quality: 'any' },
    });

    expect(result).toEqual({ ok: false, message: 'https://sgdb/grids: HTTP 401' });
  });
});
