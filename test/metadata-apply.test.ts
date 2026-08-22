// The checks that stand between a downloaded file and the user's card: request validation, the target
// path it lands on, the stale files it supersedes, and what the bytes are allowed to claim to be.
import { describe, expect, it } from 'vitest';
import {
  applyRelativePath,
  stalePathsFor,
  validateApply,
  type ApplyTarget,
} from '../src/main/metadata/apply-target';
import { sniffMedia } from '../src/main/metadata/media-type';
import {
  capArtworkPerProvider,
  mergeCandidates,
  mergeDetails,
  normalizeTitle,
  orderByProvider,
  withMergedRefs,
} from '../src/main/metadata/service';
import type { ArtworkOffer } from '../src/main/metadata/provider';
import type { GameCandidate } from '../src/shared/types';

const target = (slot: ApplyTarget['slot'], gameId = 'hades'): ApplyTarget => ({
  gameId,
  slot,
  expectedKind: slot === 'music' ? 'audio' : 'image',
});

describe('metadata apply — request validation', () => {
  it('accepts the three slots the manifest has fields for', () => {
    expect(validateApply('hades', 'grid').ok).toBe(true);
    expect(validateApply('hades', 'music').ok).toBe(true);
    expect(validateApply('hades', { hero: 0 }).ok).toBe(true);
  });

  it('refuses an id that could escape the root', () => {
    for (const id of ['../evil', 'a/b', '..', '.', '', 'has space']) {
      expect(validateApply(id, 'grid'), id).toEqual({ ok: false, reason: 'bad-id' });
    }
  });

  it('refuses a hero index outside the manifest cap', () => {
    expect(validateApply('hades', { hero: 3 })).toEqual({ ok: false, reason: 'bad-slot' });
    expect(validateApply('hades', { hero: -1 })).toEqual({ ok: false, reason: 'bad-slot' });
    expect(validateApply('hades', { hero: 1.5 })).toEqual({ ok: false, reason: 'bad-slot' });
  });

  it('refuses a slot that is not one of the known shapes', () => {
    expect(validateApply('hades', 'executable')).toEqual({ ok: false, reason: 'bad-slot' });
    expect(validateApply('hades', null)).toEqual({ ok: false, reason: 'bad-slot' });
    expect(validateApply('hades', { hero: '0' })).toEqual({ ok: false, reason: 'bad-slot' });
  });

  it('expects audio for the music slot and images for the rest', () => {
    const music = validateApply('hades', 'music');
    const hero = validateApply('hades', { hero: 2 });
    expect(music.ok === true && music.target.expectedKind).toBe('audio');
    expect(hero.ok === true && hero.target.expectedKind).toBe('image');
  });
});

describe('metadata apply — target paths', () => {
  it('reuses the move-to-card asset names, so both routes produce the same file names', () => {
    expect(applyRelativePath(target('grid'), 'jpg')).toBe('assets/hades-grid.jpg');
    expect(applyRelativePath(target('music'), 'mp3')).toBe('assets/hades-music.mp3');
    expect(applyRelativePath(target({ hero: 0 }), 'png')).toBe('assets/hades-hero-1.png');
    expect(applyRelativePath(target({ hero: 2 }), 'png')).toBe('assets/hades-hero-3.png');
  });

  it('lists the same slot under every other extension as superseded', () => {
    const stale = stalePathsFor(target('grid'), 'png', ['jpg', 'png', 'webp']);
    expect(stale).toEqual(['assets/hades-grid.jpg', 'assets/hades-grid.webp']);
  });

  it('never lists the file it is about to write', () => {
    const stale = stalePathsFor(target({ hero: 1 }), 'jpg', ['jpg', 'png']);
    expect(stale).not.toContain('assets/hades-hero-2.jpg');
  });
});

describe('metadata apply — sniffing the downloaded bytes', () => {
  const bytesOf = (...values: number[]): Uint8Array => new Uint8Array(values);
  const ascii = (text: string, pad = 0): Uint8Array =>
    new Uint8Array([...new Array<number>(pad).fill(0), ...[...text].map((c) => c.charCodeAt(0))]);

  it('recognizes the image formats the reader can decode', () => {
    expect(sniffMedia(bytesOf(0xff, 0xd8, 0xff, 0xe0))).toEqual({
      kind: 'image',
      extension: 'jpg',
    });
    expect(sniffMedia(bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toEqual({
      kind: 'image',
      extension: 'png',
    });
    expect(sniffMedia(ascii('GIF89a'))).toEqual({ kind: 'image', extension: 'gif' });
    expect(sniffMedia(ascii('RIFF____WEBPVP8 '))).toEqual({ kind: 'image', extension: 'webp' });
  });

  it('tells a WAV from a WebP, which share the RIFF container', () => {
    expect(sniffMedia(ascii('RIFF____WAVEfmt '))).toEqual({ kind: 'audio', extension: 'wav' });
  });

  it('recognizes both a tagged and an untagged mp3', () => {
    expect(sniffMedia(ascii('ID3'))).toEqual({ kind: 'audio', extension: 'mp3' });
    expect(sniffMedia(bytesOf(0xff, 0xfb, 0x90, 0x00))).toEqual({
      kind: 'audio',
      extension: 'mp3',
    });
  });

  it('recognizes ogg, flac and m4a', () => {
    expect(sniffMedia(ascii('OggS'))).toEqual({ kind: 'audio', extension: 'ogg' });
    expect(sniffMedia(ascii('fLaC'))).toEqual({ kind: 'audio', extension: 'flac' });
    expect(sniffMedia(ascii('ftyp', 4))).toEqual({ kind: 'audio', extension: 'm4a' });
  });

  it('refuses anything it does not recognize — an HTML error page above all', () => {
    expect(sniffMedia(ascii('<!DOCTYPE html>'))).toBeNull();
    expect(sniffMedia(bytesOf(0x00, 0x01, 0x02, 0x03))).toBeNull();
    expect(sniffMedia(new Uint8Array())).toBeNull();
  });

  it('does not mistake a reserved MPEG header for an mp3', () => {
    expect(sniffMedia(bytesOf(0xff, 0xe9, 0x00, 0x00))).toBeNull();
  });
});

describe('metadata artwork — how much one gallery may hold', () => {
  const offer = (provider: ArtworkOffer['provider'], index: number): ArtworkOffer => ({
    key: `${provider}:${index}`,
    kind: 'grid',
    provider,
    thumbUrl: `https://cdn.test/${provider}-${index}-thumb.jpg`,
    fullUrl: `https://cdn.test/${provider}-${index}.jpg`,
  });

  it('keeps every offer when the sources are modest', () => {
    const offers = [offer('steam', 1), offer('steamgriddb', 1), offer('steamgriddb', 2)];
    expect(capArtworkPerProvider(offers, 24)).toHaveLength(3);
  });

  it('caps a talkative source at the limit', () => {
    const offers = Array.from({ length: 60 }, (_, index) => offer('steamgriddb', index));
    expect(capArtworkPerProvider(offers, 24)).toHaveLength(24);
  });

  it('counts per source, so a long list cannot crowd out the other source', () => {
    const offers = [
      ...Array.from({ length: 60 }, (_, index) => offer('steamgriddb', index)),
      offer('steam', 1),
    ];
    const capped = capArtworkPerProvider(offers, 24);
    expect(capped.filter((o) => o.provider === 'steam')).toHaveLength(1);
    expect(capped).toHaveLength(25);
  });

  it('keeps the order the sources answered in', () => {
    const offers = [offer('steamgriddb', 1), offer('steamgriddb', 2), offer('steamgriddb', 3)];
    expect(capArtworkPerProvider(offers, 2).map((o) => o.key)).toEqual([
      'steamgriddb:1',
      'steamgriddb:2',
    ]);
  });
});

describe('metadata search — merging the sources', () => {
  const steam = (id: number, title: string): GameCandidate => ({
    key: `steam:${id}`,
    title,
    provider: 'steam',
    steamAppId: id,
  });
  const sgdb = (id: number, title: string): GameCandidate => ({
    key: `sgdb:${id}`,
    title,
    provider: 'steamgriddb',
  });
  const gog = (id: string, title: string): GameCandidate => ({
    key: `gog:${id}`,
    title,
    provider: 'gog',
    gogId: id,
  });

  it('keeps one entry per Steam appid', () => {
    const merged = mergeCandidates([steam(220, 'Half-Life 2'), steam(220, 'Half-Life 2 (dup)')]);
    expect(merged).toEqual([steam(220, 'Half-Life 2')]);
  });

  it('leads with the source that can also reach the descriptions and the CDN cover', () => {
    const merged = mergeCandidates([gog('1207', 'Hollow Knight'), steam(367520, 'Hollow Knight')]);
    expect(merged.map((c) => c.key)).toEqual(['steam:367520']);
  });

  it('collapses the same game from two sources into one candidate carrying both references', () => {
    const merged = mergeCandidates([
      gog('1207658691', 'The Witcher 3: Wild Hunt'),
      steam(292030, 'The Witcher 3: Wild Hunt'),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      provider: 'steam',
      steamAppId: 292030,
      gogId: '1207658691',
    });
  });

  it('merges across the punctuation and trademark marks publishers spell differently', () => {
    const merged = mergeCandidates([
      steam(292030, 'The Witcher® 3: Wild Hunt'),
      gog('1207658691', 'The Witcher 3 - Wild Hunt'),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.gogId).toBe('1207658691');
  });

  it('keeps two different games apart rather than guessing', () => {
    const merged = mergeCandidates([
      steam(220, 'Half-Life 2'),
      gog('x', 'Half-Life 2: Episode One'),
    ]);
    expect(merged).toHaveLength(2);
  });

  it('keeps distinct games from the same source', () => {
    const merged = mergeCandidates([steam(220, 'HL2'), steam(380, 'HL2: Episode One')]);
    expect(merged).toHaveLength(2);
  });

  it('does not fold two entries of ONE source into each other, however alike their titles', () => {
    const merged = mergeCandidates([sgdb(7, 'Hollow Knight'), sgdb(8, 'Hollow Knight™')]);
    expect(merged).toHaveLength(2);
  });

  it('drops a repeated key even without an appid', () => {
    expect(mergeCandidates([sgdb(7, 'HK'), sgdb(7, 'HK')])).toHaveLength(1);
  });

  it('normalizes a title only as far as two sources can be expected to agree', () => {
    expect(normalizeTitle('The Witcher® 3: Wild Hunt')).toBe('the witcher 3 wild hunt');
    expect(normalizeTitle('  S.T.A.L.K.E.R.  ')).toBe('s t a l k e r');
    expect(normalizeTitle('Мор')).toBe('мор');
  });
});

describe('metadata search — the appid shortcut still reaches the other sources', () => {
  // Naming a game by its Steam appid skips the search, and the search is where sources are merged — so
  // the shortcut has to collect the other references itself, or such a game would be offered Steam's
  // backgrounds and nothing else however many GOG and RAWG hold.
  const steamCandidate: GameCandidate = {
    key: 'steam:1145360',
    title: 'Hades',
    provider: 'steam',
    steamAppId: 1145360,
  };

  it("gains the other sources' references while keeping its own key", () => {
    const enriched = withMergedRefs(steamCandidate, [
      { key: 'gog:1', title: 'Hades', provider: 'gog', gogId: '1' },
    ]);
    expect(enriched).toEqual({ ...steamCandidate, gogId: '1' });
  });

  it("ignores the other sources' near misses", () => {
    const enriched = withMergedRefs(steamCandidate, [
      { key: 'gog:2', title: 'Hades II', provider: 'gog', gogId: '2' },
    ]);
    expect(enriched).toEqual(steamCandidate);
  });

  it('is unchanged when no other source answered at all', () => {
    expect(withMergedRefs(steamCandidate, [])).toBe(steamCandidate);
  });
});

describe('metadata details — merging what the sources know', () => {
  it('takes the first answer that states a field, per FIELD', () => {
    const merged = mergeDetails([
      { description: { en: 'From Steam.' }, genres: ['Action'] },
      { genres: ['Adventure'], releaseDate: '2017-02-24', platforms: ['windows', 'linux'] },
    ]);
    expect(merged).toEqual({
      description: { en: 'From Steam.' },
      genres: ['Action'],
      releaseDate: '2017-02-24',
      platforms: ['windows', 'linux'],
    });
  });

  it('lets a later source fill what the first knew nothing about', () => {
    const merged = mergeDetails([{}, { genres: ['Metroidvania'], releaseDate: '2017' }]);
    expect(merged).toEqual({ genres: ['Metroidvania'], releaseDate: '2017' });
  });

  it('never stores an empty list as an answer', () => {
    const merged = mergeDetails([{ genres: [], platforms: [] }, { genres: ['RPG'] }]);
    expect(merged).toEqual({ genres: ['RPG'] });
  });

  it('answers with nothing when no source knew anything', () => {
    expect(mergeDetails([{}, {}])).toEqual({});
  });
});

describe('metadata artwork — the order sources appear in', () => {
  const offerOf = (provider: ArtworkOffer['provider']): ArtworkOffer => ({
    key: `${provider}:1`,
    kind: 'hero',
    provider,
    thumbUrl: 'https://cdn.test/t.jpg',
    fullUrl: 'https://cdn.test/f.jpg',
  });

  it('lists both wallpaper sources first, then Steam, then GOG — a stable order between visits', () => {
    const ordered = orderByProvider([
      offerOf('gog'),
      offerOf('steam'),
      offerOf('wallpapercave'),
      offerOf('wallhaven'),
    ]);
    expect(ordered.map((offer) => offer.provider)).toEqual([
      'wallhaven',
      'wallpapercave',
      'steam',
      'gog',
    ]);
  });

  it('keeps the relative order inside one source', () => {
    const first = { ...offerOf('gog'), key: 'gog:1' };
    const second = { ...offerOf('gog'), key: 'gog:2' };
    expect(orderByProvider([first, second]).map((o) => o.key)).toEqual(['gog:1', 'gog:2']);
  });
});
