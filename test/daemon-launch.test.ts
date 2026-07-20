// The daemon's launch policy. Pinned here because the failure it fixes is invisible in code review and
// expensive to reproduce: the daemon starts with gamescope-session.target, i.e. BEFORE the Steam client,
// and a rungameid sent then leaves the tile on "Launching…" forever. Measured on a Deck — fired 16:05:56,
// app never came up; a second run reproduced it exactly.
import { describe, it, expect, vi } from 'vitest';
import { launchWhenSteamReady, type DaemonLaunchDeps } from '../src/main/daemon-launch';

/** A scripted environment: `steamReadyAfter` polls, and the app appears `appAfterLaunches` requests in. */
function makeDeps(script: {
  readonly steamReadyAfter: number;
  readonly appAfterLaunches: number | null;
  readonly appRunningFromStart?: boolean;
}): DaemonLaunchDeps & {
  readonly launches: () => number;
  readonly slept: () => number;
} {
  let readyPolls = 0;
  let launches = 0;
  let slept = 0;
  let appRunning = script.appRunningFromStart === true;

  return {
    isSteamReady: (): Promise<boolean> => {
      const ready = readyPolls >= script.steamReadyAfter;
      readyPolls += 1;
      return Promise.resolve(ready);
    },
    isAppRunning: (): Promise<boolean> => Promise.resolve(appRunning),
    launch: (): void => {
      launches += 1;
      if (script.appAfterLaunches !== null && launches >= script.appAfterLaunches)
        appRunning = true;
    },
    sleep: (ms: number): Promise<void> => {
      slept += ms;
      return Promise.resolve();
    },
    log: (): void => {},
    launches: () => launches,
    slept: () => slept,
  };
}

const FAST = { steamReadyPollMs: 1000, launchConfirmMs: 5000, steamReadyTimeoutMs: 60_000 };

describe('launchWhenSteamReady — waiting for Steam', () => {
  it('does not fire until the Steam client is up', async () => {
    // The whole point: firing early is what broke it on the Deck.
    const deps = makeDeps({ steamReadyAfter: 5, appAfterLaunches: 1 });
    const order: string[] = [];
    const spy: DaemonLaunchDeps = {
      ...deps,
      isSteamReady: async () => {
        const ready = await deps.isSteamReady();
        order.push(ready ? 'ready' : 'not-ready');
        return ready;
      },
      launch: () => {
        order.push('launch');
        deps.launch();
      },
    };

    expect(await launchWhenSteamReady(spy, FAST)).toBe('launched');
    expect(order.indexOf('launch')).toBeGreaterThan(order.lastIndexOf('not-ready'));
    expect(deps.launches()).toBe(1);
  });

  it('fires immediately when Steam is already up', async () => {
    const deps = makeDeps({ steamReadyAfter: 0, appAfterLaunches: 1 });
    expect(await launchWhenSteamReady(deps, FAST)).toBe('launched');
    expect(deps.slept()).toBe(FAST.launchConfirmMs); // only the confirm wait, no polling
  });

  it('gives up if Steam never appears, without ever firing', async () => {
    const deps = makeDeps({ steamReadyAfter: Number.MAX_SAFE_INTEGER, appAfterLaunches: null });
    expect(await launchWhenSteamReady(deps, FAST)).toBe('steam-unavailable');
    expect(deps.launches()).toBe(0);
  });
});

describe('launchWhenSteamReady — asking exactly once', () => {
  it('does not retry: a wedged tile ignores every further request', async () => {
    // Retrying was measured useless on a Deck — three requests, tile stuck, and only a manual cancel
    // cleared it. So one request, then report the failure honestly.
    const deps = makeDeps({ steamReadyAfter: 0, appAfterLaunches: null });
    expect(await launchWhenSteamReady(deps, FAST)).toBe('gave-up');
    expect(deps.launches()).toBe(1);
  });

  it('still honours an explicit maxAttempts (kept for the retry-able cases)', async () => {
    const deps = makeDeps({ steamReadyAfter: 0, appAfterLaunches: 2 });
    expect(await launchWhenSteamReady(deps, { ...FAST, maxAttempts: 3 })).toBe('launched');
    expect(deps.launches()).toBe(2);
  });
});

describe('launchWhenSteamReady — never launching twice', () => {
  it('does nothing when the app is already running', async () => {
    const deps = makeDeps({
      steamReadyAfter: 0,
      appAfterLaunches: null,
      appRunningFromStart: true,
    });
    expect(await launchWhenSteamReady(deps, FAST)).toBe('already-running');
    expect(deps.launches()).toBe(0);
  });

  it('stops if the user launches it by hand while we wait for Steam', async () => {
    // A retry must never produce a second instance — the confirm check is also the duplicate guard.
    let appRunning = false;
    let launches = 0;
    const deps: DaemonLaunchDeps = {
      isSteamReady: () => Promise.resolve(false),
      isAppRunning: () => {
        appRunning = true; // the user got there first, between polls
        return Promise.resolve(appRunning);
      },
      launch: () => {
        launches += 1;
      },
      sleep: () => Promise.resolve(),
      log: () => {},
    };
    expect(await launchWhenSteamReady(deps, FAST)).toBe('already-running');
    expect(launches).toBe(0);
  });

  it('stops mid-retry once the app appears', async () => {
    const deps = makeDeps({ steamReadyAfter: 0, appAfterLaunches: 1 });
    const spy = { ...deps, launch: vi.fn(deps.launch) };
    expect(await launchWhenSteamReady(spy, { ...FAST, maxAttempts: 5 })).toBe('launched');
    expect(spy.launch).toHaveBeenCalledTimes(1);
  });
});
