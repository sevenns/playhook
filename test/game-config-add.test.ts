// The electron-free half of adding a game: what a root read reports, and which games a write added. The
// second one decides whether the user is TOLD about a game written to a card the launcher cannot show —
// getting it wrong means either silence or a notification about a game nobody added.
import { describe, expect, it } from 'vitest';
import { addedGamesOf, rootReadResult } from '../src/main/game-config-add';

const base = { root: 'E:\\', source: 'card', signature: 'a|b', windows: true } as const;

const game = (id: string, title?: string): string =>
  JSON.stringify({ schemaVersion: 1, id, title: title ?? id, executable: 'g.exe' });

describe('rootReadResult', () => {
  it('reports a root with no game.json as one, rather than as a read failure', () => {
    const result = rootReadResult(base, null);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.hasManifest).toBe(false);
    expect(result.text).toBe('');
    expect(result.root).toBe('E:\\');
    expect(result.windows).toBe(true);
  });

  it('hands the manifest text over as it was read', () => {
    const result = rootReadResult(base, game('hades'));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.hasManifest).toBe(true);
    expect(result.text).toBe(game('hades'));
  });
});

describe('addedGamesOf', () => {
  it('names the game a write added to a file that already had one', () => {
    expect(addedGamesOf('hades', `[${game('hades')},${game('bastion', 'Bastion')}]`)).toEqual([
      { id: 'bastion', title: 'Bastion' },
    ]);
  });

  it('names the first game of a root that had none', () => {
    expect(addedGamesOf('', game('hades', 'Hades'))).toEqual([{ id: 'hades', title: 'Hades' }]);
  });

  it('says nothing when a write only renamed what was already there', () => {
    expect(addedGamesOf('hades', game('hades', 'Hades II'))).toEqual([]);
  });

  it('falls back to the id when the game carries no title', () => {
    expect(addedGamesOf('', JSON.stringify({ id: 'hades' }))).toEqual([
      { id: 'hades', title: 'hades' },
    ]);
  });

  // The previous file could not be read, so its ids are unknown — calling every game in the new one
  // "added" would announce games the user never touched.
  it('stays silent when the file before the write was unreadable', () => {
    expect(addedGamesOf('invalid', `[${game('a')},${game('b')}]`)).toEqual([]);
  });

  it('stays silent on text it cannot parse', () => {
    expect(addedGamesOf('', '{ not json')).toEqual([]);
  });
});
