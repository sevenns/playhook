import type { QuitAction, QuitConfirmReply } from '../shared/quit';
import { delay } from './util';
import { log } from './logger';

const DEFAULT_QUIT_CONFIRM_ACK_MS = 2000;

const DEFAULT_QUIT_GRACE_MS = 3000;

/** What the gate needs from the app: the job count, the launcher window, and a native fallback. */
export interface QuitGateDeps {
  /** How many background installs / uninstalls are queued or running. */
  activeJobs(): number;
  showAndFocus(): void;
  /** Asks the launcher window to show its own quit question for `action`. */
  askInWindow(action: QuitAction): void;
  /** The emergency question when the window never confirms it is asking; true means "go ahead". */
  askNatively(action: QuitAction, jobs: number): Promise<boolean>;
  /** How long the window has to confirm it is asking before the native fallback. */
  readonly ackTimeoutMs?: number;
}

interface PendingQuit {
  readonly action: QuitAction;
  readonly run: () => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** A positive integer number of milliseconds from `env[name]`, otherwise `fallback`. */
function envMs(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const parsed = Number.parseInt(env[name] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** PLAYHOOK_QUIT_CONFIRM_ACK_MS, two seconds by default. */
export function quitConfirmAckMs(env: NodeJS.ProcessEnv = process.env): number {
  return envMs(env, 'PLAYHOOK_QUIT_CONFIRM_ACK_MS', DEFAULT_QUIT_CONFIRM_ACK_MS);
}

/** PLAYHOOK_QUIT_GRACE_MS, three seconds by default. */
export function quitGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  return envMs(env, 'PLAYHOOK_QUIT_GRACE_MS', DEFAULT_QUIT_GRACE_MS);
}

/** Waits for `work`, but never longer than `ms`: the exit must not hang on a cleanup that does. */
export async function withGrace(work: Promise<unknown>, ms: number): Promise<void> {
  await Promise.race([work.then(() => undefined), delay(ms)]);
}

/**
 * The single gate every managed way out goes through (Quit from the launcher or the tray, Shutdown,
 * Reboot). With installs or uninstalls running, an unconfirmed request does not leave: the launcher window
 * asks first, and when it never confirms it is asking (destroyed, hung, reloading), a native dialog does.
 */
export class QuitGate {
  private pending: PendingQuit | null = null;
  private readonly ackTimeoutMs: number;

  constructor(private readonly deps: QuitGateDeps) {
    this.ackTimeoutMs = deps.ackTimeoutMs ?? quitConfirmAckMs();
  }

  /** Runs `run` now when confirmed or nothing is running; otherwise asks first. True when it ran. */
  request(action: QuitAction, confirmed: boolean, run: () => void): boolean {
    if (confirmed || this.deps.activeJobs() === 0) {
      this.settle();
      run();
      return true;
    }
    this.ask(action, run);
    return false;
  }

  /** The window's answer to the question: shown (or queued), or closed without a Yes. */
  reply(reply: QuitConfirmReply): void {
    const pending = this.pending;
    if (pending === null) return;
    if (reply === 'dismissed') {
      this.settle();
      return;
    }
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.timer = null;
  }

  private ask(action: QuitAction, run: () => void): void {
    if (this.pending !== null) return;
    log.info(`[quit] ${action} waits for a confirmation: ${this.deps.activeJobs()} job(s) running`);
    this.deps.showAndFocus();
    this.deps.askInWindow(action);
    const pending: PendingQuit = { action, run, timer: null };
    pending.timer = setTimeout(() => void this.askNatively(pending), this.ackTimeoutMs);
    this.pending = pending;
  }

  private async askNatively(pending: PendingQuit): Promise<void> {
    pending.timer = null;
    log.warn('[quit] the launcher window did not confirm the question - asking natively');
    const go = await this.deps.askNatively(pending.action, this.deps.activeJobs());
    if (this.pending !== pending) return;
    this.pending = null;
    if (go) pending.run();
  }

  private settle(): void {
    const timer = this.pending?.timer ?? null;
    if (timer !== null) clearTimeout(timer);
    this.pending = null;
  }
}
