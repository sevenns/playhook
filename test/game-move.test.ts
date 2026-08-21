// The electron-free half of "Move to card…": deterministic asset names, the fromText/toTextBeforeMove
// removal logic both rollback paths lean on, the id-collision check, and which card-relative path must
// already exist before a move commits.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  countGamesWithId,
  expectedGameFilePath,
  findGameInText,
  planAssetCopies,
  removeGameFromManifestText,
  type AssetCopyPlan,
} from '../src/main/game-move';
import {
  movedGridAssetPath,
  movedHeroAssetPath,
  movedMusicAssetPath,
} from '../src/shared/asset-move-names';

const game = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  id,
  title: id,
  ...extra,
});

describe('asset-move-names — deterministic destination names', () => {
  it('names hero images by 1-based index and keeps the source extension', () => {
    expect(movedHeroAssetPath('hades', 0, 'assets/h1.jpg')).toBe('assets/hades-hero-1.jpg');
    expect(movedHeroAssetPath('hades', 1, 'assets/h2.PNG')).toBe('assets/hades-hero-2.PNG');
  });

  it('names the grid and music assets', () => {
    expect(movedGridAssetPath('hades', 'assets/grid.jpg')).toBe('assets/hades-grid.jpg');
    expect(movedMusicAssetPath('hades', 'assets/theme.ogg')).toBe('assets/hades-music.ogg');
  });

  it('ignores the source directory — only the extension survives, even from outside assets/', () => {
    expect(movedHeroAssetPath('hades', 0, 'C:\\Users\\me\\Pictures\\cover.webp')).toBe(
      'assets/hades-hero-1.webp',
    );
  });

  it('produces no extension when the source has none', () => {
    expect(movedGridAssetPath('hades', 'assets/grid')).toBe('assets/hades-grid');
  });
});

describe('removeGameFromManifestText', () => {
  it('drops the last game to an empty-array marker (deletes the library file / a blank pre-move card)', () => {
    expect(removeGameFromManifestText('hades', JSON.stringify(game('hades')))).toBe('[]\n');
  });

  it('collapses two-to-one back into a single object (legacy shape)', () => {
    const text = JSON.stringify([game('hades'), game('bastion')]);
    const result = removeGameFromManifestText('hades', text);
    expect(result).not.toBeNull();
    expect(JSON.parse(result ?? '')).toEqual(game('bastion'));
    expect(Array.isArray(JSON.parse(result ?? ''))).toBe(false);
  });

  it('keeps an array when more than one game is left', () => {
    const text = JSON.stringify([game('hades'), game('bastion'), game('pyre')]);
    const result = removeGameFromManifestText('hades', text);
    expect(JSON.parse(result ?? '')).toEqual([game('bastion'), game('pyre')]);
  });

  // A silent no-op, NOT an error — which is exactly why every caller must assert the game is there first
  // (GameConfigService.moveToCard does it with countGamesWithId): without that check a move addressed by a
  // wrong id would write the library back unchanged and still report success.
  it('leaves the text untouched (games unaffected) when the id is not present', () => {
    const text = JSON.stringify(game('bastion'));
    expect(JSON.parse(removeGameFromManifestText('hades', text) ?? '')).toEqual(game('bastion'));
  });

  it('removes only the named game when another one carries a similar id', () => {
    const text = JSON.stringify([game('hades'), game('hades-2'), game('hades_ii')]);
    expect(JSON.parse(removeGameFromManifestText('hades', text) ?? '')).toEqual([
      game('hades-2'),
      game('hades_ii'),
    ]);
  });

  it('returns null on unparsable text', () => {
    expect(removeGameFromManifestText('hades', '{ not json')).toBeNull();
  });
});

describe('findGameInText', () => {
  it('finds a game inside a single-object manifest', () => {
    expect(findGameInText('hades', JSON.stringify(game('hades', { executable: 'g.exe' })))).toEqual(
      game('hades', { executable: 'g.exe' }),
    );
  });

  it('finds a game inside a multi-game array', () => {
    const text = JSON.stringify([game('hades'), game('bastion', { executable: 'b.exe' })]);
    expect(findGameInText('bastion', text)).toEqual(game('bastion', { executable: 'b.exe' }));
  });

  it('returns null when the id is absent or the text is unparsable', () => {
    expect(findGameInText('missing', JSON.stringify(game('hades')))).toBeNull();
    expect(findGameInText('hades', '{ not json')).toBeNull();
  });
});

describe('expectedGameFilePath', () => {
  it('names the executable for an executable-mode game', () => {
    expect(expectedGameFilePath(game('hades', { executable: 'Hades/Hades.exe' }))).toBe(
      'Hades/Hades.exe',
    );
  });

  it('requires nothing for a steam-mode game', () => {
    expect(expectedGameFilePath(game('hades', { steam: { appid: 1145360 } }))).toBeNull();
  });

  it('returns null when the shape is unrecognized (defensive)', () => {
    expect(expectedGameFilePath(game('hades'))).toBeNull();
  });
});

describe('countGamesWithId', () => {
  it('counts our own inserted slot as one, not zero', () => {
    expect(countGamesWithId('hades', JSON.stringify(game('hades')))).toBe(1);
  });

  it('counts two when the target card already carried a game with the same id', () => {
    const text = JSON.stringify([game('hades'), game('hades')]);
    expect(countGamesWithId('hades', text)).toBe(2);
  });

  it('counts zero when the id names nothing', () => {
    expect(countGamesWithId('missing', JSON.stringify(game('hades')))).toBe(0);
  });
});

describe('planAssetCopies', () => {
  const targetRoot = path.join(path.resolve(path.sep), 'Cards', 'E');

  it('plans a copy per hero image, in order, plus grid and music', () => {
    const manifest = {
      heroImagePaths: [
        path.join(path.resolve(path.sep), 'pc-games', 'assets', 'h1.jpg'),
        path.join(path.resolve(path.sep), 'pc-games', 'assets', 'h2.jpg'),
      ],
      gridImagePath: path.join(path.resolve(path.sep), 'pc-games', 'assets', 'grid.png'),
      backgroundMusicPath: path.join(path.resolve(path.sep), 'pc-games', 'assets', 'theme.ogg'),
    };
    const plans = planAssetCopies(manifest, 'hades', targetRoot);
    const byTo = (plan: AssetCopyPlan): string => plan.to;
    expect(plans.map(byTo)).toEqual([
      path.join(targetRoot, 'assets', 'hades-hero-1.jpg'),
      path.join(targetRoot, 'assets', 'hades-hero-2.jpg'),
      path.join(targetRoot, 'assets', 'hades-grid.png'),
      path.join(targetRoot, 'assets', 'hades-music.ogg'),
    ]);
    expect(plans[0]?.from).toBe(manifest.heroImagePaths[0]);
  });

  it('plans nothing for a game with no art or music', () => {
    expect(planAssetCopies({}, 'hades', targetRoot)).toEqual([]);
  });
});
