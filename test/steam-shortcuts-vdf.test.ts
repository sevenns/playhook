// Binary VDF round-trip + the shortcuts.vdf editing rules. This file guards USER DATA: a bug here costs
// someone every non-Steam shortcut they have, so the "don't lose foreign records", "don't duplicate ours"
// and "refuse a file we can't parse" cases are all pinned.
import { describe, it, expect } from 'vitest';
import {
  parseBinaryVdf,
  parseShortcuts,
  serializeBinaryVdf,
  serializeShortcuts,
  type ShortcutRecord,
} from '../src/main/platform/steam-vdf';
import { toSignedAppId, toUnsignedAppId } from '../src/main/platform/steam-appid';

function record(appIdU32: number, name: string, exe: string): ShortcutRecord {
  return {
    appid: toSignedAppId(appIdU32),
    AppName: name,
    Exe: `"${exe}"`,
    StartDir: '"/opt"',
    LaunchOptions: '',
    IsHidden: 0,
    AllowOverlay: 1,
    tags: {},
  };
}

/** The idempotency rule from the plan: compare BOTH sides in one representation. */
function findIndexByAppId(records: readonly ShortcutRecord[], appIdU32: number): number {
  return records.findIndex((entry) => {
    const raw = entry['appid'];
    return typeof raw === 'number' && toUnsignedAppId(raw) === appIdU32;
  });
}

function upsert(
  records: readonly ShortcutRecord[],
  appIdU32: number,
  next: ShortcutRecord,
): readonly ShortcutRecord[] {
  const index = findIndexByAppId(records, appIdU32);
  if (index === -1) return [...records, next];
  return records.map((entry, i) => (i === index ? next : entry));
}

describe('binary VDF round-trip', () => {
  it('serializes and parses back an equivalent tree', () => {
    const root = {
      shortcuts: {
        '0': record(2789208654, 'Playhook', '/opt/Playhook.AppImage'),
        '1': record(3407509860, 'Other', '/usr/bin/konsole'),
      },
    };
    const buf = serializeBinaryVdf(root);
    const parsed = parseBinaryVdf(buf);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual(root);
    // Byte-stable: re-serializing what we parsed produces the identical file.
    expect(serializeBinaryVdf(parsed.value).equals(buf)).toBe(true);
  });

  it('keeps a negative appid negative across the trip', () => {
    const buf = serializeShortcuts([record(2789208654, 'Playhook', '/opt/Playhook.AppImage')]);
    const parsed = parseShortcuts(buf);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const appid = parsed.records[0]?.['appid'];
    expect(appid).toBe(toSignedAppId(2789208654));
    expect(appid).toBeLessThan(0);
    expect(toUnsignedAppId(appid as number)).toBe(2789208654);
  });

  it('ends the file with the two terminators Steam writes', () => {
    const buf = serializeShortcuts([record(2789208654, 'Playhook', '/opt/Playhook.AppImage')]);
    expect(buf[buf.length - 1]).toBe(0x08); // end of root map
    expect(buf[buf.length - 2]).toBe(0x08); // end of the shortcuts container
    expect(buf[0]).toBe(0x00); // root map type byte
    expect(buf.toString('utf8', 1, 10)).toBe('shortcuts');
  });
});

describe('parse failures', () => {
  it('refuses a truncated file rather than yielding a partial tree', () => {
    const buf = serializeShortcuts([record(2789208654, 'Playhook', '/opt/Playhook.AppImage')]);
    const parsed = parseShortcuts(buf.subarray(0, buf.length - 6));
    expect(parsed.ok).toBe(false);
  });

  it('refuses an unsupported value type', () => {
    // 0x00 "shortcuts" NUL, 0x07 "x" NUL (uint64 — not written by Steam here), …
    const buf = Buffer.concat([
      Buffer.from([0x00]),
      Buffer.from('shortcuts\0', 'utf8'),
      Buffer.from([0x07]),
      Buffer.from('x\0', 'utf8'),
      Buffer.alloc(8),
      Buffer.from([0x08, 0x08]),
    ]);
    const parsed = parseShortcuts(buf);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('unsupported value type');
  });

  it('refuses garbage', () => {
    expect(parseShortcuts(Buffer.from('this is not a vdf file at all', 'utf8')).ok).toBe(false);
  });
});

describe('editing an existing file', () => {
  const foreignA = record(1111111111, 'Emulator', '/usr/bin/emu');
  const foreignB = record(2222222222, 'Browser', '/usr/bin/firefox');
  const ours = record(2789208654, 'Playhook', '/opt/Playhook.AppImage');

  it('adding to an existing file keeps foreign shortcuts', () => {
    const existing = serializeShortcuts([foreignA, foreignB]);
    const parsed = parseShortcuts(existing);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const next = upsert(parsed.records, 2789208654, ours);
    const reparsed = parseShortcuts(serializeShortcuts(next));
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.records).toHaveLength(3);
    expect(reparsed.records.map((entry) => entry['AppName'])).toEqual([
      'Emulator',
      'Browser',
      'Playhook',
    ]);
  });

  it('adding twice does not create a duplicate (signed/unsigned comparison)', () => {
    let records: readonly ShortcutRecord[] = [foreignA];
    records = upsert(records, 2789208654, ours);
    records = upsert(records, 2789208654, ours);
    expect(records).toHaveLength(2);
    expect(findIndexByAppId(records, 2789208654)).toBe(1);
  });

  it('removal renumbers the positional keys with no hole left behind', () => {
    const buf = serializeShortcuts([foreignA, ours, foreignB]);
    const parsed = parseShortcuts(buf);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const kept = parsed.records.filter(
      (_, i) => i !== findIndexByAppId(parsed.records, 2789208654),
    );
    const rewritten = serializeShortcuts(kept);
    const root = parseBinaryVdf(rewritten);
    expect(root.ok).toBe(true);
    if (!root.ok) return;
    expect(Object.keys(root.value['shortcuts'] as Record<string, unknown>)).toEqual(['0', '1']);
    expect(
      findIndexByAppId(
        parseShortcuts(rewritten).ok
          ? (parseShortcuts(rewritten) as { records: readonly ShortcutRecord[] }).records
          : [],
        2789208654,
      ),
    ).toBe(-1);
  });

  it('removal by appid leaves a foreign record with the same Exe untouched', () => {
    // A shortcut the user added by hand through Steam's UI gets a RANDOM appid, so it must survive our
    // removal even though it points at the same binary (see the plan, §7.13).
    const userAdded = record(1234567890, 'Playhook', '/opt/Playhook.AppImage');
    const records = [userAdded, ours];
    const kept = records.filter((_, i) => i !== findIndexByAppId(records, 2789208654));
    expect(kept).toHaveLength(1);
    expect(kept[0]?.['appid']).toBe(toSignedAppId(1234567890));
  });
});
