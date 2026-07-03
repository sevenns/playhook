// The single source of truth for the flow: the current AppState (discriminated union).
// Driven in main, replicated to the renderer via subscription (the controller sends it to the window).
import { type AppState } from '../shared/types';

type Listener = (state: AppState) => void;

export class StateManager {
  private current: AppState = { kind: 'idle' };
  private readonly listeners = new Set<Listener>();

  get(): AppState {
    return this.current;
  }

  set(next: AppState): void {
    this.current = next;
    for (const listener of this.listeners) listener(next);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
