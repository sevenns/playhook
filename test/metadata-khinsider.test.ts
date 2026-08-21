// Khinsider is scraped, not queried — so its parsers are the part that will break first, and the part
// that is tested hardest. Fixtures only: no test reaches the site.
import { describe, expect, it, vi } from 'vitest';
import { HttpClient, type FetchResponse } from '../src/main/metadata/http';
import {
  KhinsiderProvider,
  albumUrl,
  parseAlbums,
  parseAudioUrl,
  parseSize,
  parseTrackKey,
  parseTracks,
  searchUrl,
  trackKey,
} from '../src/main/metadata/khinsider';

const SEARCH_PAGE = `
<table class="albumList">
  <tr>
    <td><a href="/game-soundtracks/album/hades-original-soundtrack"><img src="x.jpg"></a></td>
    <td><a href="/game-soundtracks/album/hades-original-soundtrack">Hades &amp; Friends OST</a></td>
  </tr>
  <tr>
    <td><a href="/game-soundtracks/album/hades-ii">Hades II</a></td>
  </tr>
</table>
`;

const ALBUM_PAGE = `
<table id="songlist">
  <tr>
    <td class="playlistDownloadSong"><a href="/game-soundtracks/album/hades-original-soundtrack/01%20-%20Good%20Riddance.mp3">Good Riddance</a></td>
    <td align="right">3:12</td>
    <td align="right">4.44 MB</td>
  </tr>
  <tr>
    <td class="playlistDownloadSong"><a href="/game-soundtracks/album/hades-original-soundtrack/02%20-%20No%20Escape.mp3"></a></td>
    <td align="right">2:05</td>
    <td align="right">763 KB</td>
  </tr>
</table>
`;

const TRACK_PAGE = `
<p><a style="color: #ef9f00;" href="https://vgmsite.com/soundtracks/hades/01%20-%20Good%20Riddance.mp3">Click here to download</a></p>
<audio id="audio" src="https://vgmsite.com/soundtracks/hades/01%20-%20Good%20Riddance.mp3"></audio>
`;

function textResponse(text: string, status = 200): FetchResponse {
  const chunks = [new TextEncoder().encode(text)];
  let index = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          if (index >= chunks.length) return { done: true };
          const value = chunks[index]!;
          index += 1;
          return { done: false, value };
        },
        cancel: async () => undefined,
      }),
    },
  };
}

function providerOf(routes: (url: string) => FetchResponse): KhinsiderProvider {
  const fetch = vi.fn(async (url: string) => routes(url));
  return new KhinsiderProvider({ http: new HttpClient({ fetch, userAgent: 'Playhook/test' }) });
}

describe('khinsider parsing', () => {
  describe('albums', () => {
    it('lists each album once, decoding its title', () => {
      expect(parseAlbums(SEARCH_PAGE)).toEqual([
        { key: 'hades-original-soundtrack', title: 'Hades & Friends OST' },
        { key: 'hades-ii', title: 'Hades II' },
      ]);
    });

    it('skips a link whose text is an image rather than a title', () => {
      const albums = parseAlbums('<a href="/game-soundtracks/album/x"><img src="y.jpg"></a>');
      expect(albums).toEqual([]);
    });

    it('answers with nothing at all for a page it does not recognize', () => {
      expect(parseAlbums('<html><body>Nothing here</body></html>')).toEqual([]);
    });
  });

  describe('tracks', () => {
    const tracks = parseTracks(ALBUM_PAGE, 'hades-original-soundtrack');

    it('reads the track name and builds its page url', () => {
      expect(tracks[0]).toEqual({
        key: trackKey('hades-original-soundtrack', '01%20-%20Good%20Riddance.mp3'),
        title: 'Good Riddance',
        sizeBytes: 4655677,
        pageUrl:
          'https://downloads.khinsider.com/game-soundtracks/album/hades-original-soundtrack/01%20-%20Good%20Riddance.mp3',
      });
    });

    it('falls back to the file name when the link carries no text', () => {
      expect(tracks[1]?.title).toBe('02 - No Escape.mp3');
    });

    it('reads the size stated on the row', () => {
      expect(tracks[1]?.sizeBytes).toBe(781312);
    });

    it('ignores links belonging to another album', () => {
      const mixed = `${ALBUM_PAGE}<a href="/game-soundtracks/album/other-album/01.mp3">Other</a>`;
      expect(parseTracks(mixed, 'hades-original-soundtrack')).toHaveLength(2);
    });

    it('yields nothing for a page whose markup moved on', () => {
      expect(parseTracks('<div>Album unavailable</div>', 'hades-original-soundtrack')).toEqual([]);
    });
  });

  describe('sizes', () => {
    it('reads KB, MB and GB', () => {
      expect(parseSize('4.44 MB')).toBe(4655677);
      expect(parseSize('763 KB')).toBe(781312);
      expect(parseSize('1.5 GB')).toBe(1610612736);
    });

    it('answers undefined when there is no figure to read', () => {
      expect(parseSize('3:12')).toBeUndefined();
      expect(parseSize('')).toBeUndefined();
    });
  });

  describe('the audio url', () => {
    it('takes the direct link off a track page', () => {
      expect(parseAudioUrl(TRACK_PAGE)).toBe(
        'https://vgmsite.com/soundtracks/hades/01%20-%20Good%20Riddance.mp3',
      );
    });

    it('finds nothing on a page that carries no audio file', () => {
      expect(parseAudioUrl('<p>Track not found</p>')).toBeUndefined();
      expect(parseAudioUrl('<a href="https://example.test/page.html">x</a>')).toBeUndefined();
    });
  });

  describe('track keys', () => {
    it('round-trips an album and file through a key', () => {
      expect(parseTrackKey(trackKey('album', 'file.mp3'))).toEqual({
        album: 'album',
        file: 'file.mp3',
      });
    });

    it("does not claim another provider's key", () => {
      expect(parseTrackKey('sgdb:art:81')).toBeUndefined();
    });
  });

  describe('urls', () => {
    it('escapes the search term and names the album path', () => {
      expect(searchUrl('Hades II')).toBe(
        'https://downloads.khinsider.com/search?search=Hades%20II',
      );
      expect(albumUrl('hades-ii')).toBe(
        'https://downloads.khinsider.com/game-soundtracks/album/hades-ii',
      );
    });
  });
});

describe('khinsider provider', () => {
  it('searches, lists and resolves in the three hops the site forces', async () => {
    const provider = providerOf((url) => {
      if (url.includes('/search')) return textResponse(SEARCH_PAGE);
      if (url.endsWith('.mp3')) return textResponse(TRACK_PAGE);
      return textResponse(ALBUM_PAGE);
    });
    const albums = await provider.musicSearch('hades');
    expect(albums.ok === true && albums.value[0]?.key).toBe('hades-original-soundtrack');
    const tracks = await provider.musicTracks('hades-original-soundtrack');
    expect(tracks.ok === true && tracks.value).toHaveLength(2);
    const first = tracks.ok === true ? tracks.value[0] : undefined;
    const audio = first === undefined ? null : await provider.musicTrackUrl(first);
    expect(audio?.ok === true && audio.value).toContain('vgmsite.com');
  });

  it('reports a track page with no audio link as a failure, not as silence', async () => {
    const provider = providerOf(() => textResponse('<p>gone</p>'));
    const result = await provider.musicTrackUrl({
      key: trackKey('a', 'b.mp3'),
      title: 'b',
      pageUrl: 'https://downloads.khinsider.com/game-soundtracks/album/a/b.mp3',
    });
    expect(result.ok).toBe(false);
  });

  it('passes an HTTP failure through instead of pretending the album is empty', async () => {
    const provider = providerOf(() => textResponse('', 503));
    const result = await provider.musicTracks('hades-ii');
    expect(result.ok).toBe(false);
  });
});
