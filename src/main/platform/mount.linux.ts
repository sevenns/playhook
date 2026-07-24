// Automounting removable cards in SteamOS Game Mode (Р10). A SAFETY NET, not the primary path: current
// SteamOS mounts an inserted card itself (exFAT included), and this sweep only covers the case where one
// arrives WITHOUT a mountpoint — an older/other gamescope session, a filesystem the session skips, or a
// card the automounter simply didn't pick up. Such a card is enumerated as a block device with no
// mountpoint, and the drive watcher — which looks for `game.json` under a mountpoint — never sees it; the
// only workaround left to the user would be "mount it once in Desktop Mode and switch back", which kills
// the cartridge (insert/eject) model. So we find inserted-but-unmounted removable volumes and mount them
// through udisks2, keeping hot-swap working regardless of what the session does.
//
// Safety: only volumes that are removable/hotplug AND carry a real data filesystem are ever touched — the
// internal NVMe (rm=false, hotplug=false) can never match. The parsing/filtering is pure (unit-tested);
// only the two command invocations are not.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { RemovableMounter } from './types';
import { log } from '../logger';
import { describe } from '../util';

const execFileAsync = promisify(execFile);

// Both commands are local and fast; a timeout keeps a wedged udisks/polkit from stalling the drive
// watcher's tick forever (udisksctl blocks when it wants an authentication agent that isn't there).
const LSBLK_TIMEOUT_MS = 5_000;
const MOUNT_TIMEOUT_MS = 15_000;

/**
 * Filesystems we are willing to mount: real data filesystems a game card can carry. Everything else —
 * `swap`, `crypto_LUKS`/`LVM2_member`/`linux_raid_member` (container metadata), or no filesystem at all —
 * is never touched. The list is deliberately broad rather than exFAT-only: whatever the session failed
 * to mount is what we are here for, and a volume it DID mount is filtered out by the mountpoint check
 * anyway, so listing a filesystem costs nothing.
 */
const MOUNTABLE_FSTYPES = new Set([
  'exfat',
  'ntfs',
  'ntfs3',
  'vfat',
  'msdos',
  'ext2',
  'ext3',
  'ext4',
  'btrfs',
  'f2fs',
  'xfs',
]);

/** A block device as the sweep cares about it — normalized from `lsblk --json --list`. */
export interface BlockDevice {
  /** Device node, e.g. `/dev/mmcblk0p1`. */
  readonly path: string;
  /** `part` for a partition, `disk` for a whole device (a "superfloppy" card formatted without a table). */
  readonly type: string;
  /** Filesystem, or null when the device carries none (e.g. a disk holding a partition table). */
  readonly fstype: string | null;
  /** True when the device already has at least one mountpoint. */
  readonly mounted: boolean;
  /** True when the device is removable or hotplug — the only kind this sweep may mount. */
  readonly removable: boolean;
}

// `lsblk --json --list` emits a FLAT `blockdevices` array (no `children` nesting), which is exactly what
// the sweep wants. Fields are lenient: util-linux renamed the scalar `mountpoint` to the `mountpoints`
// array in 2.37, and some builds emit `rm`/`hotplug` as "0"/"1" strings rather than JSON booleans.
const lsblkDeviceSchema = z.object({
  path: z.string(),
  type: z.string(),
  fstype: z.string().nullish(),
  mountpoint: z.string().nullish(),
  mountpoints: z.array(z.string().nullable()).nullish(),
  rm: z.union([z.boolean(), z.string(), z.number()]).nullish(),
  hotplug: z.union([z.boolean(), z.string(), z.number()]).nullish(),
});

const lsblkOutputSchema = z.object({ blockdevices: z.array(lsblkDeviceSchema) });

/** Normalizes lsblk's boolean-ish field (`true` / `"1"` / `1`) to a boolean. Absent/`"0"` → false. */
function truthy(value: boolean | string | number | null | undefined): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true';
  return false;
}

/**
 * Parses `lsblk --json --list` output into the normalized device list. Pure. Lenient by design: an
 * unexpected shape (an lsblk version we don't know) yields an empty list, so the sweep does nothing
 * instead of throwing — automount is an enhancement and must never break card detection.
 */
export function parseLsblk(json: unknown): readonly BlockDevice[] {
  const parsed = lsblkOutputSchema.safeParse(json);
  if (!parsed.success) return [];
  return parsed.data.blockdevices.map((device) => {
    const points = (device.mountpoints ?? []).filter((point) => point !== null && point !== '');
    const mounted = points.length > 0 || (device.mountpoint !== null && device.mountpoint !== undefined && device.mountpoint !== '');
    return {
      path: device.path,
      type: device.type,
      fstype: device.fstype ?? null,
      mounted,
      removable: truthy(device.rm) || truthy(device.hotplug),
    };
  });
}

/**
 * Whether the sweep may mount this device: a removable/hotplug volume that carries a mountable filesystem
 * and isn't mounted yet. Pure. Accepts both `part` (the normal case) and `disk` (a card formatted without
 * a partition table) — a disk holding a partition table has no `fstype` and is rejected here.
 */
export function isMountable(device: BlockDevice): boolean {
  if (!device.removable || device.mounted) return false;
  if (device.type !== 'part' && device.type !== 'disk') return false;
  return device.fstype !== null && MOUNTABLE_FSTYPES.has(device.fstype.toLowerCase());
}

/**
 * The Game-Mode automount sweep. Each device is attempted **once per insertion**: a failure is almost
 * always permanent (polkit refuses, unclean NTFS), and retrying every tick would spam the log and the
 * journal. The attempt record is dropped once the device disappears from lsblk, so re-inserting the card
 * (or replugging the reader) retries cleanly.
 */
export function createLinuxRemovableMounter(): RemovableMounter {
  const attempted = new Set<string>();

  async function readDevices(): Promise<readonly BlockDevice[]> {
    try {
      const { stdout } = await execFileAsync(
        'lsblk',
        ['--json', '--list', '--output', 'PATH,TYPE,FSTYPE,MOUNTPOINT,RM,HOTPLUG'],
        { timeout: LSBLK_TIMEOUT_MS },
      );
      return parseLsblk(JSON.parse(stdout));
    } catch (cause) {
      log.warn('[automount] lsblk failed:', describe(cause));
      return [];
    }
  }

  return {
    async mountAll(): Promise<void> {
      const devices = await readDevices();
      // Forget devices that are gone, so a re-inserted card gets a fresh attempt.
      const present = new Set(devices.map((device) => device.path));
      for (const path of [...attempted]) {
        if (!present.has(path)) attempted.delete(path);
      }

      for (const device of devices.filter(isMountable)) {
        if (attempted.has(device.path)) continue;
        attempted.add(device.path);
        try {
          // udisks2 mounts as the session user into /run/media/<user>/<label>, which is exactly where the
          // drive watcher expects a card. The next tick's scan() then finds it like any ext4 card.
          const { stdout } = await execFileAsync('udisksctl', ['mount', '-b', device.path], {
            timeout: MOUNT_TIMEOUT_MS,
          });
          log.info(`[automount] mounted ${device.path} (${device.fstype ?? '?'}): ${stdout.trim()}`);
        } catch (cause) {
          log.warn(
            `[automount] could not mount ${device.path} (${device.fstype ?? '?'}): ${describe(cause)}`,
          );
        }
      }
    },
  };
}
