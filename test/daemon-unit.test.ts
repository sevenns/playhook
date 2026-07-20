// The systemd unit text. Every line here was established by experiment on a real Deck, and each one has a
// failure mode that is invisible until you are standing in Game Mode with a card in hand — so they are
// pinned rather than trusted to review.
import { describe, it, expect } from 'vitest';
import {
  buildDaemonUnit,
  daemonExecStart,
  daemonUnitPath,
  DAEMON_INSTALL_STEPS,
  DAEMON_UNIT_NAME,
} from '../src/main/daemon-unit';

const APPIMAGE = '/home/deck/.local/share/playhook/Playhook.AppImage';

describe('daemonUnitPath', () => {
  it('lands in the user unit directory (no root, untouched read-only /usr)', () => {
    expect(daemonUnitPath('/home/deck')).toBe(
      '/home/deck/.config/systemd/user/playhook-daemon.service',
    );
  });
});

describe('daemonExecStart', () => {
  it('resolves the entry point at runtime, never baking in the AppImage mount path', () => {
    const exec = daemonExecStart(APPIMAGE);
    // The mount point is /tmp/.mount_Playho<random> and the suffix changes on EVERY launch — a baked path
    // would work exactly once.
    expect(exec).not.toContain('/tmp/.mount');
    expect(exec).toContain('process.resourcesPath');
    expect(exec.startsWith(APPIMAGE)).toBe(true);
  });

  it('points at the daemon inside the asar, keeping the dist/ prefix', () => {
    // `files: dist/**` preserves the directory, so the entry is app.asar/dist/main/daemon.js —
    // NOT app.asar/main/daemon.js.
    expect(daemonExecStart(APPIMAGE)).toContain("'app.asar','dist','main','daemon.js'");
  });
});

describe('buildDaemonUnit', () => {
  const unit = buildDaemonUnit(APPIMAGE);

  it('binds to gamescope-session.target in both directions', () => {
    // PartOf stops the daemon on leaving Game Mode; WantedBy starts it on entering. Together they remove
    // any need for a mode check inside the daemon — which could not work anyway, since a unit's
    // environment carries neither SteamOS nor SteamGamepadUI.
    expect(unit).toContain('PartOf=gamescope-session.target');
    expect(unit).toContain('WantedBy=gamescope-session.target');
    expect(unit).not.toContain('default.target');
  });

  it('sets ELECTRON_RUN_AS_NODE (without it Electron dies with no $DISPLAY under systemd)', () => {
    expect(unit).toContain('Environment=ELECTRON_RUN_AS_NODE=1');
  });

  it('restarts on failure but gives up on a crash loop', () => {
    expect(unit).toContain('Restart=on-failure');
    expect(unit).not.toContain('Restart=always');
    expect(unit).toContain('StartLimitBurst=3');
  });

  it('puts the StartLimit keys in [Unit], where systemd actually reads them', () => {
    // They moved from [Service] to [Unit] in systemd 229. In the wrong section systemd does not fail —
    // it logs "Unknown key … in section [Service], ignoring" and applies NO rate limit, which on a Deck
    // let a crash-looping daemon reach restart #24 instead of stopping at 3. Only a section-aware
    // assertion catches that, hence this test rather than a plain `toContain`.
    const sectionOf = (key: string): string | null => {
      let current: string | null = null;
      for (const line of unit.split('\n')) {
        const header = /^\[(\w+)\]$/.exec(line.trim());
        if (header !== null) current = header[1] ?? null;
        else if (line.startsWith(`${key}=`)) return current;
      }
      return null;
    };
    expect(sectionOf('StartLimitIntervalSec')).toBe('Unit');
    expect(sectionOf('StartLimitBurst')).toBe('Unit');
    // The keys that genuinely belong to [Service] must stay there.
    expect(sectionOf('Restart')).toBe('Service');
    expect(sectionOf('RestartSec')).toBe('Service');
    expect(sectionOf('ExecStart')).toBe('Service');
    expect(sectionOf('Environment')).toBe('Service');
  });

  it('is a valid unit shape and ends with a newline', () => {
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('[Install]');
    expect(unit.endsWith('\n')).toBe(true);
  });

  it('is byte-stable for the same input (so the installer can skip an unchanged write)', () => {
    expect(buildDaemonUnit(APPIMAGE)).toBe(unit);
  });

  it('follows the AppImage path when it changes', () => {
    const moved = buildDaemonUnit('/opt/other/Playhook.AppImage');
    expect(moved).toContain('ExecStart=/opt/other/Playhook.AppImage');
    expect(moved).not.toBe(unit);
  });
});

describe('install steps', () => {
  it('never starts the unit — only Game Mode may do that', () => {
    // The install runs in DESKTOP Mode (the tray is the only entry point), where the daemon must not be
    // running: Playhook is already there via XDG autostart. `enable --now` did exactly that and launched
    // Playhook on the desktop — observed on a Deck. `enable` alone is enough, because entering Game Mode
    // starts gamescope-session.target, which pulls the unit in via WantedBy.
    const flat = DAEMON_INSTALL_STEPS.map((step) => step.join(' '));
    expect(flat).not.toContain(`enable --now ${DAEMON_UNIT_NAME}`);
    expect(flat.some((step) => step.includes('--now'))).toBe(false);
    expect(flat).toContain(`enable ${DAEMON_UNIT_NAME}`);
  });

  it('stops any daemon left running, after enabling', () => {
    const flat = DAEMON_INSTALL_STEPS.map((step) => step.join(' '));
    expect(flat).toContain(`stop ${DAEMON_UNIT_NAME}`);
    expect(flat.indexOf(`stop ${DAEMON_UNIT_NAME}`)).toBeGreaterThan(
      flat.indexOf(`enable ${DAEMON_UNIT_NAME}`),
    );
  });

  it('reloads systemd before touching the unit', () => {
    expect(DAEMON_INSTALL_STEPS[0]).toEqual(['daemon-reload']);
  });
});

describe('unit name', () => {
  it('matches what the systemctl calls use', () => {
    expect(DAEMON_UNIT_NAME).toBe('playhook-daemon.service');
    expect(daemonUnitPath('/home/deck').endsWith(DAEMON_UNIT_NAME)).toBe(true);
  });
});
