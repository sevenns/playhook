import { describe, expect, it } from 'vitest';
import {
  CONFIG_SYNC_TOLERANCE_MS,
  decideConfigSync,
  extractGameSlot,
  replaceGameSlot,
  slotHash,
  type GameSlot,
} from '../src/main/history-config';

const hades = { id: 'hades', title: 'Hades', executable: 'Hades.exe', description: 'roguelike' };
const celeste = { id: 'celeste', title: 'Celeste', executable: 'Celeste.exe' };

describe('extractGameSlot', () => {
  it('takes the slot out of a single-game object with every key it carries', () => {
    const result = extractGameSlot(JSON.stringify(hades), 'hades');
    expect(result).toEqual({ ok: true, slot: hades });
  });

  it('takes the right element out of an array', () => {
    const result = extractGameSlot(JSON.stringify([celeste, hades]), 'hades');
    expect(result).toEqual({ ok: true, slot: hades });
  });

  it('reports a missing id rather than guessing', () => {
    const result = extractGameSlot(JSON.stringify([celeste]), 'hades');
    expect(result).toEqual({ ok: false, reason: 'missing-id' });
  });

  it('refuses a file that holds the id twice', () => {
    const result = extractGameSlot(JSON.stringify([hades, { ...hades, title: 'Other' }]), 'hades');
    expect(result).toEqual({ ok: false, reason: 'duplicate-id' });
  });

  it('refuses broken JSON', () => {
    expect(extractGameSlot('{ not json', 'hades')).toEqual({ ok: false, reason: 'invalid-json' });
  });

  it('refuses a manifest that is neither an object nor an array of objects', () => {
    expect(extractGameSlot('42', 'hades')).toEqual({ ok: false, reason: 'not-object-or-array' });
    expect(extractGameSlot('[1, 2]', 'hades')).toEqual({ ok: false, reason: 'not-object-or-array' });
  });
});

describe('replaceGameSlot', () => {
  const edited: GameSlot = { ...hades, title: 'Hades (mine)' };

  it('keeps a single-game file a bare object', () => {
    const result = replaceGameSlot(JSON.stringify(hades), 'hades', edited);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(result.text) as unknown).toEqual(edited);
  });

  it('replaces one element of an array and leaves the neighbours untouched', () => {
    const result = replaceGameSlot(JSON.stringify([celeste, hades]), 'hades', edited);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(result.text) as unknown).toEqual([celeste, edited]);
  });

  it('keeps unknown keys of the replacement, so "Find online" text survives', () => {
    const withExtras: GameSlot = { ...hades, genres: ['action'], releaseDate: '2020-09-17' };
    const result = replaceGameSlot(JSON.stringify([hades]), 'hades', withExtras);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(result.text) as unknown).toEqual([withExtras]);
  });

  it('refuses a missing id, a duplicate id and broken JSON', () => {
    expect(replaceGameSlot(JSON.stringify([celeste]), 'hades', edited)).toEqual({
      ok: false,
      reason: 'missing-id',
    });
    expect(replaceGameSlot(JSON.stringify([hades, hades]), 'hades', edited)).toEqual({
      ok: false,
      reason: 'duplicate-id',
    });
    expect(replaceGameSlot('{ not json', 'hades', edited)).toEqual({
      ok: false,
      reason: 'invalid-json',
    });
  });
});

describe('slotHash', () => {
  it('ignores key order and formatting', () => {
    const a = extractGameSlot(JSON.stringify(hades, null, 2), 'hades');
    const b = extractGameSlot(
      JSON.stringify({ description: 'roguelike', executable: 'Hades.exe', title: 'Hades', id: 'hades' }),
      'hades',
    );
    expect(a.ok && b.ok && slotHash(a.slot) === slotHash(b.slot)).toBe(true);
  });

  it('moves when any value moves, unknown keys included', () => {
    expect(slotHash(hades)).not.toBe(slotHash({ ...hades, description: 'action' }));
    expect(slotHash(hades)).not.toBe(slotHash({ ...hades, title: 'Hades ' }));
  });

  it('keeps array order significant — hero rotation is data', () => {
    expect(slotHash({ heroImage: ['a.jpg', 'b.jpg'] })).not.toBe(
      slotHash({ heroImage: ['b.jpg', 'a.jpg'] }),
    );
  });
});

describe('decideConfigSync', () => {
  const base = { cardMtimeMs: 1_000_000, configuredAtMs: 1_000_000 };

  it('does nothing when the history holds no edits', () => {
    expect(decideConfigSync({ ...base, historyDirty: false, cardChanged: true })).toBe('none');
    expect(decideConfigSync({ ...base, historyDirty: false, cardChanged: false })).toBe('none');
  });

  it('applies the edits when the card has not moved', () => {
    expect(decideConfigSync({ ...base, historyDirty: true, cardChanged: false })).toBe('apply');
  });

  it('lets the newer side win a real conflict', () => {
    expect(
      decideConfigSync({
        historyDirty: true,
        cardChanged: true,
        cardMtimeMs: 1_000_000,
        configuredAtMs: 1_000_000 + CONFIG_SYNC_TOLERANCE_MS + 1,
      }),
    ).toBe('apply');
    expect(
      decideConfigSync({
        historyDirty: true,
        cardChanged: true,
        cardMtimeMs: 1_000_000 + CONFIG_SYNC_TOLERANCE_MS + 1,
        configuredAtMs: 1_000_000,
      }),
    ).toBe('take-card');
  });

  it('gives a tie inside the tolerance to the card', () => {
    expect(
      decideConfigSync({
        historyDirty: true,
        cardChanged: true,
        cardMtimeMs: 1_000_000,
        configuredAtMs: 1_000_000 + CONFIG_SYNC_TOLERANCE_MS,
      }),
    ).toBe('take-card');
  });

  it('gives an unreadable timestamp to the card as well', () => {
    expect(
      decideConfigSync({ historyDirty: true, cardChanged: true, cardMtimeMs: null, configuredAtMs: 1 }),
    ).toBe('take-card');
    expect(
      decideConfigSync({ historyDirty: true, cardChanged: true, cardMtimeMs: 1, configuredAtMs: null }),
    ).toBe('take-card');
  });
});
