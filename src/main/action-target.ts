/** What a Play / Install or Uninstall pressed for one game id resolves to. */
export type ActionTarget =
  | 'launch-or-install-selected'
  | 'select-then-act'
  | 'install-only'
  | 'uninstall-only'
  | 'resume-session'
  | 'refuse';

export interface ActionTargetInput {
  readonly action: 'launch' | 'uninstall';
  /** The game the action was pressed for. */
  readonly id: string;
  /** The game AppState is about (the selection), or null. */
  readonly selectedId: string | null;
  /** A session is in flight: launching, running, syncing, or a sequence still unwinding. */
  readonly sessionBusy: boolean;
  /** The game that session is about, or null. */
  readonly sessionGameId: string | null;
  /** The target already has an activity (an install, a removal, a Steam download). */
  readonly hasActivity: boolean;
  /** The target's source is available: a local game always, a card game only with its card in. */
  readonly sourceAvailable: boolean;
  readonly reloadInFlight: boolean;
}

/**
 * Where an action for game `id` goes. With the session free it acts on the selected game as it always
 * did, selecting the target first when it is another one. With a session in flight the session's own game
 * only resumes, and any other game may be installed or removed but never launched: one game runs at a time.
 * A game that is busy, whose card is gone, or that is being reloaded is refused.
 */
export function resolveActionTarget(input: ActionTargetInput): ActionTarget {
  if (input.hasActivity || !input.sourceAvailable || input.reloadInFlight) return 'refuse';
  if (!input.sessionBusy) {
    if (input.id !== input.selectedId) return 'select-then-act';
    return input.action === 'launch' ? 'launch-or-install-selected' : 'uninstall-only';
  }
  if (input.id === input.sessionGameId)
    return input.action === 'launch' ? 'resume-session' : 'refuse';
  return input.action === 'launch' ? 'install-only' : 'uninstall-only';
}
