// The abort signal of every launch / install / uninstall sequence, as a throwable. Lives on its own,
// away from game-launcher.ts, so the controller and its tests can name it without pulling the koffi
// FFI that module binds at import.

/** Thrown by the process waits (and the sequences' own abort checks) when their AbortSignal fires. */
export class LaunchAbortedError extends Error {
  constructor() {
    super('launch wait aborted');
    this.name = 'LaunchAbortedError';
  }
}
