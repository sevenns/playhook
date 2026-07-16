// Pure parsing/filtering for the Game-Mode automount sweep (Р10). The safety contract lives here: only a
// removable, unmounted volume with a real data filesystem may ever be mounted — the internal drive must
// never match, whatever lsblk reports.
import { describe, expect, it } from 'vitest';
import { parseLsblk, isMountable, type BlockDevice } from '../src/main/platform/mount.linux';

/** A Deck-shaped lsblk --json --list payload: internal NVMe + an unmounted exFAT SD card. */
const deckOutput = {
  blockdevices: [
    { path: '/dev/nvme0n1', type: 'disk', fstype: null, mountpoint: null, rm: false, hotplug: false },
    { path: '/dev/nvme0n1p1', type: 'part', fstype: 'vfat', mountpoint: '/boot', rm: false, hotplug: false },
    { path: '/dev/nvme0n1p2', type: 'part', fstype: 'ext4', mountpoint: '/', rm: false, hotplug: false },
    { path: '/dev/mmcblk0', type: 'disk', fstype: null, mountpoint: null, rm: true, hotplug: true },
    { path: '/dev/mmcblk0p1', type: 'part', fstype: 'exfat', mountpoint: null, rm: true, hotplug: true },
  ],
};

function device(overrides: Partial<BlockDevice> = {}): BlockDevice {
  return { path: '/dev/sda1', type: 'part', fstype: 'exfat', mounted: false, removable: true, ...overrides };
}

describe('parseLsblk', () => {
  it('normalizes a Deck lsblk payload', () => {
    const devices = parseLsblk(deckOutput);
    expect(devices).toHaveLength(5);
    expect(devices[4]).toEqual({
      path: '/dev/mmcblk0p1',
      type: 'part',
      fstype: 'exfat',
      mounted: false,
      removable: true,
    });
  });

  it('treats the newer `mountpoints` array as mounted', () => {
    const [dev] = parseLsblk({
      blockdevices: [{ path: '/dev/sda1', type: 'part', fstype: 'exfat', mountpoints: ['/run/media/deck/GAMES'], rm: true }],
    });
    expect(dev?.mounted).toBe(true);
  });

  it('treats a `mountpoints: [null]` array (util-linux 2.37+) as unmounted', () => {
    const [dev] = parseLsblk({
      blockdevices: [{ path: '/dev/sda1', type: 'part', fstype: 'exfat', mountpoints: [null], rm: true }],
    });
    expect(dev?.mounted).toBe(false);
  });

  it('accepts boolean-ish rm/hotplug ("1"/1/true) across lsblk builds', () => {
    const devices = parseLsblk({
      blockdevices: [
        { path: '/dev/a1', type: 'part', fstype: 'exfat', mountpoint: null, rm: '1' },
        { path: '/dev/b1', type: 'part', fstype: 'exfat', mountpoint: null, hotplug: 1 },
        { path: '/dev/c1', type: 'part', fstype: 'exfat', mountpoint: null, rm: '0', hotplug: false },
      ],
    });
    expect(devices.map((d) => d.removable)).toEqual([true, true, false]);
  });

  it('returns an empty list for an unexpected shape instead of throwing', () => {
    // Automount is an enhancement: an lsblk version we don't understand must degrade to "do nothing".
    expect(parseLsblk({ nope: true })).toEqual([]);
    expect(parseLsblk(null)).toEqual([]);
    expect(parseLsblk('garbage')).toEqual([]);
  });
});

describe('isMountable — safety contract', () => {
  it('accepts an unmounted removable exFAT partition (the Game Mode gap)', () => {
    expect(isMountable(device())).toBe(true);
  });

  it('accepts a removable disk formatted without a partition table (superfloppy)', () => {
    expect(isMountable(device({ type: 'disk', path: '/dev/sdb' }))).toBe(true);
  });

  it('NEVER touches a non-removable device (the internal drive)', () => {
    expect(isMountable(device({ removable: false }))).toBe(false);
    // Even an unmounted internal data partition stays untouched.
    expect(isMountable(device({ removable: false, fstype: 'ext4' }))).toBe(false);
  });

  it('skips an already-mounted volume (idempotent sweep)', () => {
    expect(isMountable(device({ mounted: true }))).toBe(false);
  });

  it('skips a device with no filesystem (a disk holding a partition table)', () => {
    expect(isMountable(device({ type: 'disk', fstype: null }))).toBe(false);
  });

  it('skips container/metadata filesystems', () => {
    for (const fstype of ['swap', 'crypto_LUKS', 'LVM2_member', 'linux_raid_member', 'squashfs']) {
      expect(isMountable(device({ fstype }))).toBe(false);
    }
  });

  it('accepts the data filesystems a game card can carry', () => {
    for (const fstype of ['exfat', 'ntfs', 'vfat', 'ext4', 'btrfs']) {
      expect(isMountable(device({ fstype }))).toBe(true);
    }
  });

  it('matches the filesystem case-insensitively (lsblk may report NTFS)', () => {
    expect(isMountable(device({ fstype: 'NTFS' }))).toBe(true);
  });

  it('picks exactly the SD card out of a full Deck payload', () => {
    const targets = parseLsblk(deckOutput).filter(isMountable).map((d) => d.path);
    expect(targets).toEqual(['/dev/mmcblk0p1']);
  });
});
