// Asking Steam to launch our tile, reliably. Pure orchestration with injected effects, so the retry
// policy is unit-tested (test/daemon-launch.test.ts) instead of being discovered on a Deck.
//
// Why this exists: the daemon is started by systemd together with gamescope-session.target, i.e. at the
// very beginning of a Game Mode session — while the Steam client itself is still coming up. Firing
// `steam://rungameid/…` at that moment does not fail loudly; Steam accepts the request and the tile sits
// on "Launching…" indefinitely. Measured on a Deck: the daemon fired at 16:05:56 and the app only started
// at 16:09:39, after the user cancelled and pressed Play by hand. The daemon's pid was LOWER than the
// Steam client's — we were talking to a process that did not exist yet.
//
// How long Steam needs before it can accept a request is NOT known — the logs only show that it could not
// at t+3s. That is precisely why there is no fixed delay here: any number would be a guess.
//
// So: wait until Steam looks up, then launch, then VERIFY the app appeared and retry if it did not. Note
// which of those two carries the weight — the readiness probe is a heuristic (is `steamwebhelper` running?
// nobody documents what "ready" means), while the verify-and-retry loop is what actually makes this
// correct: even if the probe lies and we fire too early, the next attempt catches it.

/** How long to wait for the Steam client to appear before giving up entirely. */
const STEAM_READY_TIMEOUT_MS = 3 * 60 * 1000;
/** Poll interval while waiting for Steam. */
const STEAM_READY_POLL_MS = 2000;
/**
 * How long to wait AFTER the client turns up before sending anything — the client accepts commands
 * seconds before it can act on them, and a request sent in that window wedges the tile permanently.
 * 30s is a judgement call, not a measurement: the honest signal does not exist (see steam-pipe.linux.ts),
 * and the cost of overshooting is a few seconds of waiting, while undershooting costs the whole feature.
 */
const STEAM_SETTLE_MS = 30_000;
/** How long to give Steam to actually start the app before declaring the attempt failed. */
const LAUNCH_CONFIRM_MS = 20_000;
/**
 * How many times to ask. ONE, deliberately: retrying was tried and measured useless — once the tile is
 * wedged on "Launching…", Steam ignores every further request (the user's own included) until it is
 * cancelled by hand. A second request cannot help and only hides the failure.
 */
const MAX_ATTEMPTS = 1;

export interface DaemonLaunchDeps {
  /** Whether OUR app is already running (full /proc sweep by SteamAppId). */
  readonly isAppRunning: () => Promise<boolean>;
  /** Whether the Steam client is up and able to accept a launch request. */
  readonly isSteamReady: () => Promise<boolean>;
  /** Fires `steam steam://rungameid/…` (fire-and-forget — Steam gives us no completion signal). */
  readonly launch: () => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (message: string) => void;
}

export interface DaemonLaunchOptions {
  readonly steamReadyTimeoutMs?: number;
  readonly steamReadyPollMs?: number;
  /** Pause between "the client is up" and the request. 0 when the session has long been running. */
  readonly settleMs?: number;
  readonly launchConfirmMs?: number;
  readonly maxAttempts?: number;
}

export type DaemonLaunchOutcome =
  /** The app came up (or was already up) — nothing more to do. */
  | 'launched'
  | 'already-running'
  /** Steam never appeared within the timeout. */
  | 'steam-unavailable'
  /** Steam was up, we asked the agreed number of times, the app never appeared. */
  | 'gave-up';

/**
 * Waits for Steam, then asks it to launch our tile, confirming the result and retrying.
 *
 * The confirmation step doubles as the guard against launching twice: if the user got there first (or an
 * earlier request finally went through), `isAppRunning` reports it and we stop — so a retry can never
 * produce a second instance.
 */
export async function launchWhenSteamReady(
  deps: DaemonLaunchDeps,
  options: DaemonLaunchOptions = {},
): Promise<DaemonLaunchOutcome> {
  const readyTimeout = options.steamReadyTimeoutMs ?? STEAM_READY_TIMEOUT_MS;
  const readyPoll = options.steamReadyPollMs ?? STEAM_READY_POLL_MS;
  const confirmDelay = options.launchConfirmMs ?? LAUNCH_CONFIRM_MS;
  const attempts = options.maxAttempts ?? MAX_ATTEMPTS;

  // 1. Wait for the Steam client. Bail out early if the app turns up on its own meanwhile — the user may
  // simply have launched it from the tile while we waited.
  let waited = 0;
  while (!(await deps.isSteamReady())) {
    if (await deps.isAppRunning()) return 'already-running';
    if (waited >= readyTimeout) {
      deps.log(`Steam did not come up within ${Math.round(readyTimeout / 1000)}s — giving up`);
      return 'steam-unavailable';
    }
    await deps.sleep(readyPoll);
    waited += readyPoll;
  }
  if (waited > 0) deps.log(`waited ${Math.round(waited / 1000)}s for the Steam client`);

  // The client is up but not necessarily able to act yet. Sit out the settle window, bailing out if the
  // app appears meanwhile (the user pressing the tile themselves).
  const settle = options.settleMs ?? STEAM_SETTLE_MS;
  if (settle > 0) {
    deps.log(`letting Steam settle for ${Math.round(settle / 1000)}s before asking`);
    await deps.sleep(settle);
    if (await deps.isAppRunning()) return 'already-running';
  }

  // 2. Ask, confirm, repeat. Steam reports nothing back, so the only honest signal is the app appearing.
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (await deps.isAppRunning()) return attempt === 1 ? 'already-running' : 'launched';
    deps.log(`launch request ${attempt}/${attempts}`);
    deps.launch();
    await deps.sleep(confirmDelay);
    if (await deps.isAppRunning()) return 'launched';
    deps.log(`no app after ${Math.round(confirmDelay / 1000)}s`);
  }
  return 'gave-up';
}
