// Detecting card insertion/removal.
// The criterion for "our card" is NOT a bare diff over mountpoints (it's unreliable: the
// mountpoint lags on card readers), but the appearance of a removable/non-system volume that
// has a `game.json` in the root of one of its mountpoints. While the mountpoint is empty, scan
// simply returns null, and the polling itself acts as a retry until the volume letter appears.
import path from 'node:path';
import fse from 'fs-extra';
import { list } from 'drivelist';
import { MANIFEST_FILENAME, type DriveCandidate } from '../shared/types';
import { type Translator } from '../shared/i18n/index';

const DEFAULT_INTERVAL_MS = 1000;

// How often the optional automount sweep may run (Game Mode only — see the constructor). Deliberately
// slower than the 1s scan tick: the sweep shells out to lsblk, and an unmounted card is not a hot path.
const AUTOMOUNT_INTERVAL_MS = 3000;

// Internal bus types some machines still report as `isRemovable` (hot-swap SATA bays, second SSDs, etc.).
// The Configure picker must only offer EXTERNAL media (SD/USB), so we exclude these buses on top of the
// removable/non-system check. Removable media report USB / SD(CARD) / MMC / UNKNOWN and pass.
const INTERNAL_BUS_TYPES = new Set([
  'SATA',
  'ATA',
  'ATAPI',
  'IDE',
  'NVME',
  'SCSI',
  'SAS',
  'RAID',
  'PCIE',
  'PCI',
]);

/** True when a drive is a genuine external, removable, non-system volume (SD card / USB stick). */
function isExternalDrive(drive: {
  readonly isRemovable: boolean;
  readonly isSystem: boolean;
  readonly isVirtual: boolean | null;
  readonly busType: string;
}): boolean {
  if (drive.isRemovable !== true || drive.isSystem === true || drive.isVirtual === true)
    return false;
  return !INTERNAL_BUS_TYPES.has(drive.busType.toUpperCase());
}

/**
 * Enumerates external removable, non-system mountpoints as Configure-window candidates (for initializing
 * or editing game.json). Unlike scan() it does NOT filter by the presence of game.json — a BLANK drive must be
 * selectable to be initialized (`hasManifest` distinguishes it) — but it DOES exclude internal disks that
 * merely report `isRemovable` (see isExternalDrive). The label is built from the drive root plus the
 * manifest title (drivelist gives no volume label on Windows).
 */
export async function listDriveCandidates(
  activeRoot: string | null,
  t: Translator,
): Promise<readonly DriveCandidate[]> {
  const drives = await list();
  const candidates: DriveCandidate[] = [];
  for (const drive of drives) {
    if (!isExternalDrive(drive)) continue;
    for (const mount of drive.mountpoints) {
      if (typeof mount.path !== 'string' || mount.path.length === 0) continue;
      const root = mount.path;
      // An EMPTY card-reader slot still owns a drive letter but has no media — accessing its root fails
      // ("device not ready"), so pathExists(root) is false. Skip it: only slots with actual media (a real
      // blank drive the user can initialize, or a card with game.json) should appear in the picker.
      if (!(await fse.pathExists(root))) continue;
      const manifestPath = path.join(root, MANIFEST_FILENAME);
      const hasManifest = await fse.pathExists(manifestPath);
      const { label, signature } = await describeManifest(root, manifestPath, hasManifest, t);
      candidates.push({
        root,
        label,
        signature,
        hasManifest,
        isActive: root === activeRoot,
      });
    }
  }
  return candidates;
}

/** What one read of a candidate's game.json yields: its display label and its content signature. */
interface ManifestDescription {
  /**
   * "E:\ — Hollow Knight" (title from a single-game game.json), "E:\ — 3 games" (a multi-game card: the
   * individual titles don't fit a one-line label, so it shows the count), "E:\ — invalid game.json" (file
   * present but unparseable / no title), or "E:\ — blank drive" (no game.json). This is the primary
   * signature on Windows, where drivelist does not populate a volume label.
   */
  readonly label: string;
  /** The card's identity — see DriveCandidate.signature / gameIdsSignature. */
  readonly signature: string;
}

/**
 * Card identity: the SORTED game ids from game.json, joined. Ids are constrained to [A-Za-z0-9._-] by the
 * schema, so `|` is a safe separator. Deliberately independent of the DISPLAY label (which may be a bare
 * count like "3 games", identical across different cards) and of cosmetic edits (titles/paths), so the
 * Configure window reloads on a real media swap or a games-list change — not on every rename.
 */
function gameIdsSignature(games: readonly unknown[]): string {
  const ids = games.map((game) =>
    typeof game === 'object' && game !== null && 'id' in game && typeof game.id === 'string' ? game.id : '?',
  );
  return [...ids].sort().join('|');
}

/** Reads a candidate's game.json ONCE and derives both its display label and its content signature. */
async function describeManifest(
  root: string,
  manifestPath: string,
  hasManifest: boolean,
  t: Translator,
): Promise<ManifestDescription> {
  // The `root — …` shape and the card title (untrusted) stay literal; only the descriptive suffix is
  // translated. The picker re-pushes every 2s while visible, so a language change is picked up on its own.
  if (!hasManifest) return { label: `${root} — ${t('drive.blank')}`, signature: '' };
  const invalid: ManifestDescription = { label: `${root} — ${t('drive.invalid')}`, signature: 'invalid' };
  try {
    const parsed: unknown = await fse.readJson(manifestPath);
    // game.json holds a single game object (legacy) OR a non-empty array of them (multi-game card) — the
    // same top-level union readManifests accepts.
    const games: readonly unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    const first = games[0];
    if (typeof first !== 'object' || first === null) return invalid;
    const signature = gameIdsSignature(games);
    // Several games → the count alone ("3 games"); naming just the first would misrepresent the card.
    if (games.length > 1) return { label: `${root} — ${t.tp('drive.games', games.length)}`, signature };
    if ('title' in first) {
      const title = first.title;
      if (typeof title === 'string' && title.length > 0) return { label: `${root} — ${title}`, signature };
    }
    return invalid;
  } catch {
    return invalid;
  }
}

export class DriveWatcher {
  private timer: NodeJS.Timeout | null = null;
  private activeRoot: string | null = null;
  private scanning = false;
  private lastAutomountAt = 0;

  private insertHandler: ((root: string) => void) | null = null;
  private removeHandler: ((root: string) => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;

  /**
   * @param automount Optional sweep that mounts an inserted-but-unmounted removable card before scanning
   *   (Р10). Wired ONLY in a SteamOS Game Mode session, as a SAFETY NET: the session normally mounts the
   *   card itself, but a card that arrives without a mountpoint has no path for scan() to look under and
   *   would stay invisible. null everywhere else (Windows and the KDE desktop session mount on their
   *   own). Must never throw.
   */
  constructor(
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
    private readonly automount: (() => Promise<void>) | null = null,
  ) {}

  onInsert(handler: (root: string) => void): void {
    this.insertHandler = handler;
  }

  onRemove(handler: (root: string) => void): void {
    this.removeHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** The current root of the active card, or null. */
  getActiveRoot(): string | null {
    return this.activeRoot;
  }

  private async tick(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      await this.automountIfDue();
      const found = await this.scan();
      if (found !== null && found !== this.activeRoot) {
        // Card swap without an intermediate empty tick: remove the old one first.
        if (this.activeRoot !== null) {
          const previous = this.activeRoot;
          this.activeRoot = null;
          this.removeHandler?.(previous);
        }
        this.activeRoot = found;
        this.insertHandler?.(found);
      } else if (found === null && this.activeRoot !== null) {
        const previous = this.activeRoot;
        this.activeRoot = null;
        this.removeHandler?.(previous);
      }
    } catch (cause) {
      this.errorHandler?.(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Runs the automount sweep when one is wired, throttled and only while NO card is active: with a card
   * already mounted there is nothing to mount (the launcher works one card at a time), so this stays quiet
   * during play and only wakes up on the empty screen — exactly when a card may be waiting unmounted.
   */
  private async automountIfDue(): Promise<void> {
    if (this.automount === null || this.activeRoot !== null) return;
    const now = Date.now();
    if (now - this.lastAutomountAt < AUTOMOUNT_INTERVAL_MS) return;
    this.lastAutomountAt = now;
    await this.automount();
  }

  /**
   * Returns the root of a removable/non-system volume with a `game.json`. When SEVERAL such cards are
   * present, the currently-active one is preferred (stabilization): without it, drivelist's enumeration
   * order decides — a nondeterministic swap on every tick. Preferring the live active root removes that
   * swap and turns "a new card loads after the current one is removed" from luck into a guarantee. When
   * no active card is present (or it's gone), the first card in enumeration order is returned, as before.
   */
  private async scan(): Promise<string | null> {
    const drives = await list();
    let firstFound: string | null = null;
    for (const drive of drives) {
      if (drive.isRemovable !== true || drive.isSystem === true) continue;
      // A disk may have several partitions/mountpoints — we iterate over all of them.
      for (const mount of drive.mountpoints) {
        if (typeof mount.path !== 'string' || mount.path.length === 0) continue;
        const manifestPath = path.join(mount.path, MANIFEST_FILENAME);
        if (await fse.pathExists(manifestPath)) {
          if (mount.path === this.activeRoot) return mount.path; // keep the active card
          firstFound ??= mount.path;
        }
      }
    }
    return firstFound;
  }
}
